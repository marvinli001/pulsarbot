import {
  asRecord,
  asString,
  isHostAllowed,
  nowIso,
  parseOrigin,
  type CompletedRunPayload,
  type ExecutorLogEntry,
  type ExtensionAssignment,
} from "./common.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function focusAttachedWindow(windowId: number, tabId?: number | null) {
  await chrome.windows.update(windowId, {
    focused: true,
  });
  if (typeof tabId === "number") {
    await chrome.tabs.update(tabId, {
      active: true,
    });
  }
  await sleep(120);
}

async function waitForTabComplete(tabId: number, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.status === "complete") {
      return tab;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for tab ${tabId} to finish loading`);
}

async function injectContentScript(tabId: number) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-script.js"],
  });
}

async function waitForContentScript(tabId: number, timeoutMs = 10_000) {
  const startedAt = Date.now();
  let injectionAttempted = false;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "ping" });
      if (response?.ok) {
        return;
      }
      if (!injectionAttempted) {
        injectionAttempted = true;
        try {
          await injectContentScript(tabId);
        } catch {
          // Declarative or dynamic injection may still be racing.
        }
      }
    } catch {
      if (!injectionAttempted) {
        injectionAttempted = true;
        try {
          await injectContentScript(tabId);
        } catch {
          // Declarative or dynamic injection may still be racing.
        }
      }
    }
    await sleep(150);
  }
  throw new Error(`Content script is not ready for tab ${tabId}`);
}

async function sendToContentScript<T>(tabId: number, message: Record<string, unknown>): Promise<T> {
  await waitForTabComplete(tabId);
  await waitForContentScript(tabId);
  const response = await chrome.tabs.sendMessage(tabId, message);
  if (!response?.ok) {
    throw new Error(typeof response?.error === "string" ? response.error : "Content script request failed");
  }
  return response.result as T;
}

async function getAttachedTab(windowId: number, tabId?: number | null) {
  if (typeof tabId === "number") {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.windowId === windowId && typeof tab.id === "number") {
      return tab;
    }
  }
  const tabs = await chrome.tabs.query({
    active: true,
    windowId,
  });
  const tab = tabs[0];
  if (!tab || typeof tab.id !== "number") {
    throw new Error("Attached browser window does not have a usable tab");
  }
  return tab;
}

export async function executeBrowserAssignment(args: {
  assignment: ExtensionAssignment;
  windowId: number;
  tabId?: number | null;
  allowedHosts: string[];
}): Promise<CompletedRunPayload & {
  artifacts: NonNullable<CompletedRunPayload["artifacts"]>;
  logs: NonNullable<CompletedRunPayload["logs"]>;
  activeTab: {
    tabId: number;
    url: string | null;
    origin: string | null;
    title: string | null;
  };
  lastSnapshotAt: string | null;
}> {
  const logs: ExecutorLogEntry[] = [];
  const emit = (
    level: ExecutorLogEntry["level"],
    event: string,
    message: string,
    detail: Record<string, unknown> = {},
  ) => {
    logs.push({
      taskRunId: args.assignment.id,
      scope: "assignment",
      level,
      event,
      message,
      detail: JSON.parse(JSON.stringify(detail)) as Record<string, unknown>,
      occurredAt: nowIso(),
    });
  };

  await focusAttachedWindow(args.windowId, args.tabId ?? null);
  let activeTab = await getAttachedTab(args.windowId, args.tabId);
  await focusAttachedWindow(args.windowId, activeTab.id);
  const startUrl = asString(activeTab.url);
  if (!startUrl) {
    throw new Error("Attached tab does not expose a readable URL");
  }
  if (!isHostAllowed(startUrl, args.allowedHosts)) {
    throw new Error(`Attached tab URL is outside the allowed hosts: ${startUrl}`);
  }

  emit("info", "browser_session_started", `Browser workflow started at ${startUrl}`, {
    startUrl,
    windowId: args.windowId,
    tabId: activeTab.id,
  });

  const extracted: Array<{ label: string; text: string }> = [];
  const steps = Array.isArray(args.assignment.executionPlan.steps)
    ? args.assignment.executionPlan.steps
    : [];

  for (const rawStep of steps) {
    const step = asRecord(rawStep);
    if (!step) {
      continue;
    }
    const type = asString(step.type);
    if (!type) {
      continue;
    }
    emit("debug", "browser_step_started", `Browser step ${type} started`, {
      type,
      selector: asString(step.selector),
      url: asString(step.url),
    });

    if (type === "goto") {
      const targetUrl = asString(step.url);
      if (!targetUrl) {
        throw new Error("Browser goto step is missing url");
      }
      if (!isHostAllowed(targetUrl, args.allowedHosts)) {
        throw new Error(`Target URL is outside the allowed hosts: ${targetUrl}`);
      }
      await chrome.tabs.update(activeTab.id!, { url: targetUrl });
      activeTab = await waitForTabComplete(activeTab.id!);
      emit("info", "browser_step_completed", `Browser navigated to ${targetUrl}`, {
        type,
        url: targetUrl,
      });
      continue;
    }

    if (type === "wait") {
      const ms = Number(step.ms ?? 500);
      await sleep(ms);
      emit("debug", "browser_step_completed", `Waited ${ms}ms`, {
        type,
        ms,
      });
      continue;
    }

    if (type === "click") {
      const selector = asString(step.selector);
      if (!selector) {
        throw new Error("Browser click step is missing selector");
      }
      await sendToContentScript(activeTab.id!, {
        type: "click",
        selector,
      });
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
      await sendToContentScript(activeTab.id!, {
        type: "type",
        selector,
        text: String(step.text ?? ""),
        clear: step.clear !== false,
      });
      emit("info", "browser_step_completed", `Typed into ${selector}`, {
        type,
        selector,
        textLength: String(step.text ?? "").length,
      });
      continue;
    }

    if (type === "wait_for_selector") {
      const selector = asString(step.selector);
      if (!selector) {
        throw new Error("Browser wait_for_selector step is missing selector");
      }
      await sendToContentScript(activeTab.id!, {
        type: "wait_for_selector",
        selector,
        timeoutMs: Number(step.timeoutMs ?? 10_000),
      });
      emit("info", "browser_step_completed", `Selector became ready: ${selector}`, {
        type,
        selector,
      });
      continue;
    }

    if (type === "press") {
      const key = asString(step.key);
      if (!key) {
        throw new Error("Browser press step is missing key");
      }
      await sendToContentScript(activeTab.id!, {
        type: "press",
        selector: asString(step.selector),
        key,
      });
      emit("info", "browser_step_completed", `Pressed ${key}`, {
        type,
        key,
        selector: asString(step.selector),
      });
      continue;
    }

    if (type === "extract_text") {
      const selector = asString(step.selector);
      if (!selector) {
        throw new Error("Browser extract_text step is missing selector");
      }
      const text = await sendToContentScript<string>(activeTab.id!, {
        type: "extract_text",
        selector,
      });
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

  activeTab = await getAttachedTab(args.windowId, activeTab.id);
  await focusAttachedWindow(args.windowId, activeTab.id);
  const finalUrl = asString(activeTab.url);
  if (!finalUrl) {
    throw new Error("Attached tab does not expose a readable final URL");
  }
  if (!isHostAllowed(finalUrl, args.allowedHosts)) {
    throw new Error(`Final URL is outside the allowed hosts: ${finalUrl}`);
  }
  const finalOrigin = parseOrigin(finalUrl);
  const domSnapshot = await sendToContentScript<Record<string, unknown>>(activeTab.id!, {
    type: "snapshot_dom",
  });
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(args.windowId, {
    format: "png",
  });
  const screenshotBase64 = typeof screenshotDataUrl === "string" && screenshotDataUrl.includes(",")
    ? screenshotDataUrl.slice(screenshotDataUrl.indexOf(",") + 1)
    : "";
  const lastSnapshotAt = nowIso();
  emit("info", "browser_screenshot_captured", "Captured browser screenshot", {
    tabId: activeTab.id,
    byteLength: screenshotBase64.length,
  });

  const artifacts: NonNullable<CompletedRunPayload["artifacts"]> = [
    {
      id: `${args.assignment.id}:browser:dom-snapshot`,
      label: "DOM Snapshot",
      kind: "json",
      content: domSnapshot,
    },
    {
      id: `${args.assignment.id}:browser:screenshot`,
      label: "Screenshot",
      kind: "screenshot",
      content: {
        mimeType: "image/png",
        base64: screenshotBase64,
      },
    },
    {
      id: `${args.assignment.id}:browser:url`,
      label: "Final URL",
      kind: "url",
      content: finalUrl,
    },
  ];
  if (extracted.length > 0) {
    artifacts.push({
      id: `${args.assignment.id}:browser:extract`,
      label: "Extracted Text",
      kind: "json",
      content: extracted,
    });
  }

  return {
    taskRunId: args.assignment.id,
    status: "completed",
    outputSummary: activeTab.title
      ? `Browser workflow completed on "${activeTab.title}"`
      : `Browser workflow completed on ${finalUrl}`,
    artifacts,
    logs,
    activeTab: {
      tabId: activeTab.id!,
      url: finalUrl,
      origin: finalOrigin,
      title: asString(activeTab.title) ?? null,
    },
    lastSnapshotAt,
  };
}
