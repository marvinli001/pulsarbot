import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeAssignment } from "../apps/companion/src/runtime.js";

const cleanupDirs: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createHttpServer(handler: (url: string) => { status?: number; body: string; contentType?: string }) {
  const server = createServer((request, response) => {
    const result = handler(request.url ?? "/");
    response.statusCode = result.status ?? 200;
    response.setHeader("content-type", result.contentType ?? "text/plain");
    response.end(result.body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("companion runtime", () => {
  it("executes HTTP assignments", async () => {
    const baseUrl = await createHttpServer(() => ({
      body: JSON.stringify({ ok: true, message: "hello" }),
      contentType: "application/json",
    }));

    const result = await executeAssignment({
      assignment: {
        id: "taskrun-http",
        sessionId: "task-session:http",
        templateKind: "web_watch_report",
        triggerType: "manual",
        inputSnapshot: {},
        executionPlan: {
          capability: "http",
          request: {
            url: `${baseUrl}/status`,
            method: "GET",
          },
        },
        status: "running",
      },
      scopes: {
        allowedHosts: ["127.0.0.1"],
        allowedPaths: [],
        allowedCommands: [],
        fsRequiresApproval: true,
        shellRequiresApproval: true,
      },
    });

    expect(result.status).toBe("completed");
    expect(result.outputSummary).toContain("200");
    expect(result.artifacts[0]?.content).toMatchObject({ ok: true, message: "hello" });
    expect(result.logs.some((entry) => entry.event === "http_request_started")).toBe(true);
    expect(result.logs.some((entry) => entry.event === "http_request_completed")).toBe(true);
  });

  it("executes filesystem and shell assignments", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pulsarbot-companion-"));
    cleanupDirs.push(dir);
    const filePath = path.join(dir, "note.txt");
    await writeFile(filePath, "hello companion", "utf8");

    const fsResult = await executeAssignment({
      assignment: {
        id: "taskrun-fs",
        sessionId: "task-session:fs",
        templateKind: "document_digest_memory",
        triggerType: "manual",
        inputSnapshot: {},
        executionPlan: {
          capability: "fs",
          operation: "read",
          path: filePath,
        },
        status: "running",
      },
      scopes: {
        allowedHosts: [],
        allowedPaths: [dir],
        allowedCommands: [process.execPath],
        fsRequiresApproval: true,
        shellRequiresApproval: true,
      },
    });
    expect(fsResult.status).toBe("completed");
    expect(String(fsResult.artifacts[0]?.content)).toContain("hello companion");
    expect(fsResult.logs.some((entry) => entry.event === "fs_operation_completed")).toBe(true);

    const shellResult = await executeAssignment({
      assignment: {
        id: "taskrun-shell",
        sessionId: "task-session:shell",
        templateKind: "telegram_followup",
        triggerType: "manual",
        inputSnapshot: {},
        executionPlan: {
          capability: "shell",
          command: process.execPath,
          args: ["-e", "console.log('shell-ok')"],
          cwd: dir,
        },
        status: "running",
      },
      scopes: {
        allowedHosts: [],
        allowedPaths: [dir],
        allowedCommands: [process.execPath],
        fsRequiresApproval: true,
        shellRequiresApproval: true,
      },
    });
    expect(shellResult.status).toBe("completed");
    expect(String(shellResult.artifacts[0]?.content)).toContain("shell-ok");
    expect(shellResult.logs.some((entry) => entry.event === "shell_command_completed")).toBe(true);
  });

  it("executes browser assignments with extract and screenshot artifacts", async () => {
    const baseUrl = await createHttpServer((url) => ({
      body: `
        <html>
          <head><title>Companion Browser Test</title></head>
          <body>
            <h1 id="title">Hello Browser</h1>
            <button id="go" onclick="document.querySelector('#title').textContent='Clicked'">Go</button>
          </body>
        </html>
      `,
      contentType: "text/html",
    }));

    const result = await executeAssignment({
      assignment: {
        id: "taskrun-browser",
        sessionId: "task-session:browser",
        templateKind: "browser_workflow",
        triggerType: "manual",
        inputSnapshot: {},
        executionPlan: {
          capability: "browser",
          startUrl: `${baseUrl}/page`,
          steps: [
            {
              type: "click",
              selector: "#go",
            },
            {
              type: "extract_text",
              selector: "#title",
              label: "headline",
            },
          ],
          captureScreenshot: true,
        },
        status: "running",
      },
      scopes: {
        allowedHosts: ["127.0.0.1"],
        allowedPaths: [],
        allowedCommands: [],
        fsRequiresApproval: true,
        shellRequiresApproval: true,
      },
    });

    expect(result.status).toBe("completed");
    expect(result.outputSummary).toContain("Companion Browser Test");
    expect(result.artifacts.some((artifact) => artifact.kind === "screenshot")).toBe(true);
    expect(result.artifacts.some((artifact) =>
      artifact.label === "Extracted Text" &&
      JSON.stringify(artifact.content).includes("Clicked")
    )).toBe(true);
    expect(result.logs.some((entry) => entry.event === "browser_screenshot_captured")).toBe(true);
  });
});
