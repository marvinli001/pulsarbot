import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { nowIso } from "@pulsarbot/core";

const execFile = promisify(execFileCallback);

export interface CompanionAssignment {
  id: string;
  sessionId: string;
  taskId?: string | null;
  taskTitle?: string | null;
  templateKind: string;
  triggerType: string;
  inputSnapshot: Record<string, unknown>;
  executionPlan: Record<string, unknown>;
  status: string;
}

export interface CompanionExecutorScopes {
  allowedHosts: string[];
  allowedPaths: string[];
  allowedCommands: string[];
  fsRequiresApproval: boolean;
  shellRequiresApproval: boolean;
}

export interface CompanionExecutionArtifact {
  id: string;
  label: string;
  kind: "text" | "json" | "url" | "screenshot" | "file";
  content: unknown;
}

export interface CompanionExecutionResult {
  taskRunId: string;
  status: "completed" | "failed" | "aborted";
  outputSummary: string;
  artifacts: CompanionExecutionArtifact[];
  logs: CompanionExecutionLogEntry[];
  error?: string;
}

export interface CompanionExecutionLogEntry {
  taskRunId: string | null;
  scope: "assignment" | "heartbeat";
  level: "debug" | "info" | "warn" | "error";
  event: string;
  message: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isHostAllowed(rawUrl: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) {
    return false;
  }
  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  return allowedHosts.some((pattern) => {
    const normalized = pattern.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (normalized.startsWith("*.")) {
      const suffix = normalized.slice(1);
      return hostname.endsWith(suffix);
    }
    return hostname === normalized;
  });
}

function ensureAllowedHost(rawUrl: string, allowedHosts: string[]) {
  if (!isHostAllowed(rawUrl, allowedHosts)) {
    throw new Error(`Host is not allowed for URL: ${rawUrl}`);
  }
}

function ensureAllowedPath(rawPath: string, allowedPaths: string[]) {
  const resolved = path.resolve(rawPath);
  const matched = allowedPaths.some((base) => {
    const normalizedBase = path.resolve(base);
    return resolved === normalizedBase || resolved.startsWith(`${normalizedBase}${path.sep}`);
  });
  if (!matched) {
    throw new Error(`Path is not allowed: ${resolved}`);
  }
  return resolved;
}

function toLogDetail(value: Record<string, unknown> = {}) {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function createExecutionLogger(taskRunId: string) {
  const logs: CompanionExecutionLogEntry[] = [];
  const emit = (
    level: CompanionExecutionLogEntry["level"],
    event: string,
    message: string,
    detail: Record<string, unknown> = {},
  ) => {
    logs.push({
      taskRunId,
      scope: "assignment",
      level,
      event,
      message,
      detail: toLogDetail(detail),
      occurredAt: nowIso(),
    });
  };
  return {
    logs,
    emit,
  };
}

async function runHttpAction(
  assignment: CompanionAssignment,
  scopes: CompanionExecutorScopes,
  emit: ReturnType<typeof createExecutionLogger>["emit"],
): Promise<CompanionExecutionResult> {
  const request = asRecord(assignment.executionPlan.request);
  const url = asString(request?.url);
  if (!url) {
    throw new Error("HTTP execution plan is missing request.url");
  }
  ensureAllowedHost(url, scopes.allowedHosts);
  const method = asString(request?.method) ?? "GET";
  emit("info", "http_request_started", `HTTP ${method} ${url}`, {
    method,
    url,
  });
  const headers = asRecord(request?.headers) ?? {};
  const body = request?.body;
  const init: RequestInit = {
    method,
    headers: Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, String(value)]),
    ),
    signal: AbortSignal.timeout(
      Number(assignment.executionPlan.timeoutMs ?? 15_000),
    ),
  };
  if (body !== undefined && body !== null) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const parsed = contentType.includes("application/json")
    ? (() => {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      })()
    : text;
  emit(response.ok ? "info" : "warn", "http_request_completed", `HTTP ${method} ${url} -> ${response.status}`, {
    method,
    url,
    status: response.status,
    contentType,
  });

  return {
    taskRunId: assignment.id,
    status: response.ok ? "completed" : "failed",
    outputSummary: `${method} ${url} -> ${response.status}`,
    logs: [],
    ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    artifacts: [
      {
        id: `${assignment.id}:http:response`,
        label: "HTTP Response",
        kind: typeof parsed === "string" ? "text" : "json",
        content: typeof parsed === "string"
          ? parsed.slice(0, 20_000)
          : parsed,
      },
    ],
  };
}

async function runBrowserAction(
  assignment: CompanionAssignment,
  scopes: CompanionExecutorScopes,
  emit: ReturnType<typeof createExecutionLogger>["emit"],
): Promise<CompanionExecutionResult> {
  const startUrl = asString(assignment.executionPlan.startUrl);
  if (!startUrl) {
    throw new Error("Browser execution plan is missing startUrl");
  }
  ensureAllowedHost(startUrl, scopes.allowedHosts);
  emit("info", "browser_session_started", `Browser workflow started at ${startUrl}`, {
    startUrl,
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: Number(assignment.executionPlan.timeoutMs ?? 20_000),
    });

    const extracted: Array<{ label: string; text: string }> = [];
    const steps = Array.isArray(assignment.executionPlan.steps)
      ? assignment.executionPlan.steps
      : [];
    for (const rawStep of steps) {
      const step = asRecord(rawStep);
      if (!step) {
        continue;
      }
      const type = asString(step?.type);
      if (!type) {
        continue;
      }
      emit("debug", "browser_step_started", `Browser step ${type} started`, {
        type,
        selector: asString(step.selector),
        url: asString(step.url),
      });
      if (type === "goto") {
        const url = asString(step.url);
        if (!url) {
          throw new Error("Browser goto step is missing url");
        }
        ensureAllowedHost(url, scopes.allowedHosts);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        emit("info", "browser_step_completed", `Browser navigated to ${url}`, {
          type,
          url,
        });
        continue;
      }
      if (type === "click") {
        const selector = asString(step.selector);
        if (!selector) {
          throw new Error("Browser click step is missing selector");
        }
        await page.locator(selector).click();
        emit("info", "browser_step_completed", `Clicked ${selector}`, {
          type,
          selector,
        });
        continue;
      }
      if (type === "type") {
        const selector = asString(step.selector);
        if (!selector) {
          throw new Error("Browser type step is missing selector");
        }
        const locator = page.locator(selector);
        if (step.clear !== false) {
          await locator.fill("");
        }
        await locator.fill(String(step.text ?? ""));
        emit("info", "browser_step_completed", `Typed into ${selector}`, {
          type,
          selector,
          textLength: String(step.text ?? "").length,
        });
        continue;
      }
      if (type === "wait") {
        await page.waitForTimeout(Number(step.ms ?? 500));
        emit("debug", "browser_step_completed", `Waited ${String(step.ms ?? 500)}ms`, {
          type,
          ms: Number(step.ms ?? 500),
        });
        continue;
      }
      if (type === "wait_for_selector") {
        const selector = asString(step.selector);
        if (!selector) {
          throw new Error("Browser wait_for_selector step is missing selector");
        }
        await page.locator(selector).waitFor({
          timeout: Number(step.timeoutMs ?? 10_000),
        });
        emit("info", "browser_step_completed", `Selector became ready: ${selector}`, {
          type,
          selector,
          timeoutMs: Number(step.timeoutMs ?? 10_000),
        });
        continue;
      }
      if (type === "press") {
        const key = asString(step.key);
        if (!key) {
          throw new Error("Browser press step is missing key");
        }
        const selector = asString(step.selector);
        if (selector) {
          await page.locator(selector).press(key);
        } else {
          await page.keyboard.press(key);
        }
        emit("info", "browser_step_completed", `Pressed ${key}`, {
          type,
          key,
          selector,
        });
        continue;
      }
      if (type === "extract_text") {
        const selector = asString(step.selector);
        if (!selector) {
          throw new Error("Browser extract_text step is missing selector");
        }
        const text = await page.locator(selector).innerText();
        extracted.push({
          label: asString(step.label) ?? selector,
          text,
        });
        emit("info", "browser_step_completed", `Extracted text from ${selector}`, {
          type,
          selector,
          textLength: text.length,
        });
      }
    }

    const artifacts: CompanionExecutionArtifact[] = [];
    if (assignment.executionPlan.captureScreenshot !== false) {
      const png = await page.screenshot({ type: "png", fullPage: true });
      emit("info", "browser_screenshot_captured", "Captured browser screenshot", {
        byteLength: png.byteLength,
      });
      artifacts.push({
        id: `${assignment.id}:browser:screenshot`,
        label: "Screenshot",
        kind: "screenshot",
        content: {
          mimeType: "image/png",
          base64: png.toString("base64"),
        },
      });
    }
    const title = await page.title();
    const pageUrl = page.url();
    if (extracted.length > 0) {
      artifacts.push({
        id: `${assignment.id}:browser:extract`,
        label: "Extracted Text",
        kind: "json",
        content: extracted,
      });
    }
    artifacts.push({
      id: `${assignment.id}:browser:url`,
      label: "Final URL",
      kind: "url",
      content: pageUrl,
    });

    return {
      taskRunId: assignment.id,
      status: "completed",
      outputSummary: title
        ? `Browser workflow completed on "${title}"`
        : `Browser workflow completed on ${pageUrl}`,
      logs: [],
      artifacts,
    };
  } finally {
    await browser.close();
  }
}

async function runFsAction(
  assignment: CompanionAssignment,
  scopes: CompanionExecutorScopes,
  emit: ReturnType<typeof createExecutionLogger>["emit"],
): Promise<CompanionExecutionResult> {
  const operation = asString(assignment.executionPlan.operation) ?? "read";
  const rawPath = asString(assignment.executionPlan.path);
  if (!rawPath) {
    throw new Error("Filesystem execution plan is missing path");
  }
  const resolvedPath = ensureAllowedPath(rawPath, scopes.allowedPaths);
  emit("info", "fs_operation_started", `Filesystem ${operation} ${resolvedPath}`, {
    operation,
    path: resolvedPath,
  });

  if (operation === "read") {
    const content = await readFile(resolvedPath, "utf8");
    emit("info", "fs_operation_completed", `Read ${resolvedPath}`, {
      operation,
      path: resolvedPath,
      size: content.length,
    });
    return {
      taskRunId: assignment.id,
      status: "completed",
      outputSummary: `Read ${resolvedPath}`,
      logs: [],
      artifacts: [
        {
          id: `${assignment.id}:fs:read`,
          label: path.basename(resolvedPath),
          kind: "text",
          content: content.slice(0, 20_000),
        },
      ],
    };
  }

  if (operation === "list") {
    const entries = await readdir(resolvedPath);
    emit("info", "fs_operation_completed", `Listed ${resolvedPath}`, {
      operation,
      path: resolvedPath,
      entryCount: entries.length,
    });
    return {
      taskRunId: assignment.id,
      status: "completed",
      outputSummary: `Listed ${resolvedPath}`,
      logs: [],
      artifacts: [
        {
          id: `${assignment.id}:fs:list`,
          label: "Directory Listing",
          kind: "json",
          content: entries,
        },
      ],
    };
  }

  const content = String(assignment.executionPlan.content ?? "");
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  if (operation === "write") {
    await writeFile(resolvedPath, content, "utf8");
  } else if (operation === "append") {
    const existing = await readFile(resolvedPath, "utf8").catch(() => "");
    await writeFile(resolvedPath, `${existing}${content}`, "utf8");
  } else {
    throw new Error(`Unsupported filesystem operation: ${operation}`);
  }
  emit("info", "fs_operation_completed", `${operation} ${resolvedPath}`, {
    operation,
    path: resolvedPath,
    size: content.length,
  });

  return {
    taskRunId: assignment.id,
    status: "completed",
    outputSummary: `${operation} ${resolvedPath}`,
    logs: [],
    artifacts: [
      {
        id: `${assignment.id}:fs:write`,
        label: path.basename(resolvedPath),
        kind: "file",
        content: {
          path: resolvedPath,
          operation,
        },
      },
    ],
  };
}

async function runShellAction(
  assignment: CompanionAssignment,
  scopes: CompanionExecutorScopes,
  emit: ReturnType<typeof createExecutionLogger>["emit"],
): Promise<CompanionExecutionResult> {
  const command = asString(assignment.executionPlan.command);
  if (!command) {
    throw new Error("Shell execution plan is missing command");
  }
  if (!scopes.allowedCommands.includes(command)) {
    throw new Error(`Command is not allowed: ${command}`);
  }
  const args = Array.isArray(assignment.executionPlan.args)
    ? assignment.executionPlan.args.map((item) => String(item))
    : [];
  const cwd = asString(assignment.executionPlan.cwd);
  const resolvedCwd = cwd
    ? ensureAllowedPath(cwd, scopes.allowedPaths)
    : undefined;
  emit("info", "shell_command_started", `Shell command started: ${command}`, {
    command,
    args,
    cwd: resolvedCwd ?? null,
  });
  const result = await execFile(command, args, {
    cwd: resolvedCwd,
    timeout: Number(assignment.executionPlan.timeoutMs ?? 15_000),
  });
  emit("info", "shell_command_completed", `Shell command completed: ${command}`, {
    command,
    args,
    cwd: resolvedCwd ?? null,
    stdoutLength: result.stdout.length,
    stderrLength: result.stderr.length,
  });
  return {
    taskRunId: assignment.id,
    status: "completed",
    outputSummary: `${command} ${args.join(" ").trim()}`.trim(),
    logs: [],
    artifacts: [
      {
        id: `${assignment.id}:shell:stdout`,
        label: "stdout",
        kind: "text",
        content: result.stdout.slice(0, 20_000),
      },
      {
        id: `${assignment.id}:shell:stderr`,
        label: "stderr",
        kind: "text",
        content: result.stderr.slice(0, 20_000),
      },
    ],
  };
}

export async function executeAssignment(args: {
  assignment: CompanionAssignment;
  scopes: CompanionExecutorScopes;
}): Promise<CompanionExecutionResult> {
  const { logs, emit } = createExecutionLogger(args.assignment.id);
  const capability = asString(args.assignment.executionPlan.capability);
  if (!capability) {
    emit("info", "executor_action_skipped", "No executor action was required for this task.");
    return {
      taskRunId: args.assignment.id,
      status: "completed",
      outputSummary: "No executor action was required for this task.",
      logs,
      artifacts: [],
    };
  }
  emit("info", "executor_action_started", `Executor capability ${capability} started`, {
    capability,
    templateKind: args.assignment.templateKind,
  });
  try {
    let result: CompanionExecutionResult;
    if (capability === "http") {
      result = await runHttpAction(args.assignment, args.scopes, emit);
    } else if (capability === "browser") {
      result = await runBrowserAction(args.assignment, args.scopes, emit);
    } else if (capability === "fs") {
      result = await runFsAction(args.assignment, args.scopes, emit);
    } else if (capability === "shell") {
      result = await runShellAction(args.assignment, args.scopes, emit);
    } else {
      throw new Error(`Unsupported executor capability: ${capability}`);
    }
    emit("info", "executor_action_completed", `Executor capability ${capability} completed`, {
      capability,
      status: result.status,
    });
    return {
      ...result,
      logs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit("error", "executor_action_failed", `Executor capability ${capability} failed`, {
      capability,
      error: message,
    });
    return {
      taskRunId: args.assignment.id,
      status: "failed",
      outputSummary: `Execution failed for ${args.assignment.id}`,
      error: message,
      logs,
      artifacts: [],
    };
  }
}
