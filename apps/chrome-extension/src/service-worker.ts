import { executeBrowserAssignment } from "./browser-runtime.js";
import {
  HEARTBEAT_ALARM_NAME,
  asString,
  normalizeServerUrl,
  nowIso,
  parseOrigin,
  patchExecutorState,
  readExecutorState,
  sendRuntimeMessage,
  toErrorMessage,
  type BrowserStatePayload,
  type CompletedRunPayload,
  type ExecutorLogEntry,
  type ExtensionAssignment,
  type ExtensionExecutorState,
} from "./common.js";

const queuedCompletedRuns: CompletedRunPayload[] = [];
const queuedExecutorLogs: ExecutorLogEntry[] = [];

function queueLog(
  level: ExecutorLogEntry["level"],
  event: string,
  message: string,
  detail: Record<string, unknown> = {},
  taskRunId: string | null = null,
) {
  queuedExecutorLogs.push({
    taskRunId,
    scope: taskRunId ? "assignment" : "heartbeat",
    level,
    event,
    message,
    detail: JSON.parse(JSON.stringify(detail)) as Record<string, unknown>,
    occurredAt: nowIso(),
  });
  if (queuedExecutorLogs.length > 500) {
    queuedExecutorLogs.splice(0, queuedExecutorLogs.length - 500);
  }
}

function browserMetadata() {
  const userAgent = navigator.userAgent;
  const versionMatch = /Chrome\/([0-9.]+)/.exec(userAgent);
  return {
    extensionInstanceId: chrome.runtime.id,
    browserName: "chrome",
    browserVersion: versionMatch?.[1] ?? null,
    manifestVersion: 3,
  };
}

async function refreshRuntimeMetadata() {
  const metadata = browserMetadata();
  return patchExecutorState({
    extensionInstanceId: chrome.runtime.id,
    browserName: metadata.browserName,
    browserVersion: metadata.browserVersion,
  });
}

async function ensureAlarm() {
  await chrome.alarms.clear(HEARTBEAT_ALARM_NAME);
  await chrome.alarms.create(HEARTBEAT_ALARM_NAME, {
    periodInMinutes: 0.5,
  });
}

async function postJson<T>(url: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(typeof parsed === "string" ? parsed : JSON.stringify(parsed));
  }
  return parsed as T;
}

async function collectBrowserState(state: ExtensionExecutorState): Promise<BrowserStatePayload> {
  let activeTabState = {
    tabId: state.attachedTabId,
    url: state.attachedUrl,
    origin: state.attachedOrigin,
    title: state.attachedTitle,
  };
  if (
    state.attachState === "attached"
    && typeof state.attachedWindowId === "number"
  ) {
    const attachedTab = typeof state.attachedTabId === "number"
      ? await chrome.tabs.get(state.attachedTabId).catch(() => null)
      : null;
    const activeTab = attachedTab?.windowId === state.attachedWindowId
      ? attachedTab
      : (await chrome.tabs.query({
          active: true,
          windowId: state.attachedWindowId,
        }))[0];
    activeTabState = {
      tabId: typeof activeTab?.id === "number" ? activeTab.id : null,
      url: asString(activeTab?.url) ?? null,
      origin: parseOrigin(asString(activeTab?.url) ?? null),
      title: asString(activeTab?.title) ?? null,
    };
  }
  return {
    attachState: state.attachState,
    mode: "single_window",
    windowId: state.attachedWindowId,
    activeTab: activeTabState,
    attachedAt: state.attachedAt,
    lastSnapshotAt: state.lastSnapshotAt,
    extensionInstanceId: chrome.runtime.id,
    profileLabel: state.profileLabel,
  };
}

async function applyExecutorStateFromServer(
  state: ExtensionExecutorState,
  executor: Record<string, unknown> | null | undefined,
) {
  if (!executor) {
    return state;
  }
  const browserAttachment = (executor.browserAttachment ?? {}) as Record<string, unknown>;
  return patchExecutorState({
    status: String(executor.status ?? state.status ?? "offline"),
    attachState: String(browserAttachment.state ?? state.attachState) === "attached" ? "attached" : "detached",
    attachedWindowId: typeof browserAttachment.windowId === "number" ? browserAttachment.windowId : null,
    attachedTabId: typeof browserAttachment.tabId === "number" ? browserAttachment.tabId : null,
    attachedUrl: asString(browserAttachment.url) ?? null,
    attachedOrigin: asString(browserAttachment.origin) ?? null,
    attachedTitle: asString(browserAttachment.title) ?? null,
    attachedAt: asString(browserAttachment.attachedAt) ?? null,
    detachedAt: asString(browserAttachment.detachedAt) ?? null,
    lastSnapshotAt: asString(browserAttachment.lastSnapshotAt) ?? null,
    extensionInstanceId: asString(browserAttachment.extensionInstanceId) ?? state.extensionInstanceId,
    browserName: asString(browserAttachment.browserName) ?? state.browserName,
    browserVersion: asString(browserAttachment.browserVersion) ?? state.browserVersion,
    profileLabel: asString(browserAttachment.profileLabel) ?? state.profileLabel,
    allowedHosts: Array.isArray((executor.scopes as Record<string, unknown> | undefined)?.allowedHosts)
      ? ((executor.scopes as Record<string, unknown>).allowedHosts as unknown[]).map((item) => String(item))
      : state.allowedHosts,
  });
}

async function processAssignments(
  state: ExtensionExecutorState,
  assignments: ExtensionAssignment[],
) {
  for (const assignment of assignments) {
    try {
      if (state.attachState !== "attached" || typeof state.attachedWindowId !== "number") {
        throw new Error("Chrome extension executor is not attached to a browser window");
      }
      const result = await executeBrowserAssignment({
        assignment,
        windowId: state.attachedWindowId,
        tabId: state.attachedTabId,
        allowedHosts: state.allowedHosts,
      });
      queuedCompletedRuns.push({
        taskRunId: result.taskRunId,
        status: result.status,
        outputSummary: result.outputSummary,
        artifacts: result.artifacts,
        logs: result.logs,
      });
      await patchExecutorState({
        attachedTabId: result.activeTab.tabId,
        attachedUrl: result.activeTab.url,
        attachedOrigin: result.activeTab.origin,
        attachedTitle: result.activeTab.title,
        lastSnapshotAt: result.lastSnapshotAt,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      queuedCompletedRuns.push({
        taskRunId: assignment.id,
        status: "failed",
        outputSummary: `Execution failed for ${assignment.id}`,
        error: message,
        logs: [
          {
            taskRunId: assignment.id,
            scope: "assignment",
            level: "error",
            event: "browser_assignment_failed",
            message,
            detail: {
              taskId: assignment.taskId ?? null,
              templateKind: assignment.templateKind,
            },
            occurredAt: nowIso(),
          },
        ],
      });
    }
  }
}

async function heartbeatCycle() {
  let state = await readExecutorState();
  if (!state.serverUrl || !state.executorId || (!state.executorToken && !state.pairingCode)) {
    return state;
  }

  for (let round = 0; round < 2; round += 1) {
    const sentCompletedRuns = queuedCompletedRuns.slice();
    const sentExecutorLogs = queuedExecutorLogs.slice();
    const response = await postJson<{
      ok: boolean;
      paired?: boolean;
      executorToken?: string | null;
      executor?: Record<string, unknown> | null;
      assignments?: ExtensionAssignment[];
    }>(`${state.serverUrl}/api/executors/${encodeURIComponent(state.executorId)}/heartbeat`, {
      ...(state.executorToken
        ? { executorToken: state.executorToken }
        : { pairingCode: state.pairingCode }),
      version: chrome.runtime.getManifest().version,
      platform: "chrome-extension",
      capabilities: ["browser"],
      metadata: {
        ...browserMetadata(),
        profileLabel: state.profileLabel,
      },
      browserState: await collectBrowserState(state),
      completedRuns: sentCompletedRuns,
      executorLogs: sentExecutorLogs,
    });

    queuedCompletedRuns.splice(0, sentCompletedRuns.length);
    queuedExecutorLogs.splice(0, sentExecutorLogs.length);

    if (response.executorToken) {
      state = await patchExecutorState({
        executorToken: response.executorToken,
        pairingCode: null,
      });
      queueLog("info", "executor_paired", "Chrome extension executor paired successfully", {
        executorId: state.executorId,
      });
    }

    state = await applyExecutorStateFromServer(state, response.executor);
    state = await patchExecutorState({
      lastHeartbeatAt: nowIso(),
      lastError: null,
      extensionInstanceId: chrome.runtime.id,
      browserName: browserMetadata().browserName,
      browserVersion: browserMetadata().browserVersion,
    });

    const assignments = Array.isArray(response.assignments) ? response.assignments : [];
    if (assignments.length === 0) {
      break;
    }
    queueLog("info", "assignments_received", "Received browser assignments", {
      assignmentCount: assignments.length,
    });
    await processAssignments(state, assignments);
    state = await readExecutorState();
  }

  return state;
}

async function saveConfig(payload: Record<string, unknown>) {
  return patchExecutorState({
    serverUrl: normalizeServerUrl(String(payload.serverUrl ?? "")),
    executorId: String(payload.executorId ?? "").trim(),
    pairingCode: asString(payload.pairingCode) ?? null,
    profileLabel: asString(payload.profileLabel) ?? null,
    extensionInstanceId: chrome.runtime.id,
    browserName: browserMetadata().browserName,
    browserVersion: browserMetadata().browserVersion,
  });
}

async function attachCurrentWindow(payload: Record<string, unknown> = {}) {
  const state = await readExecutorState();
  if (!state.serverUrl || !state.executorId || !state.executorToken) {
    throw new Error("Executor must be paired before attaching a browser window");
  }
  const targetUrl = asString(payload.targetUrl);
  const normalWindows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ["normal", "popup"],
  });
  const matchedTabEntry = targetUrl
    ? normalWindows
        .flatMap((window: any) =>
          (window.tabs ?? []).map((tab: any) => ({
            window,
            tab,
          }))
        )
        .find(({ tab }: { tab: any }) => tab.url === targetUrl)
    : null;
  const targetWindow = matchedTabEntry?.window ?? await chrome.windows.getLastFocused({
    populate: true,
    windowTypes: ["normal", "popup"],
  });
  if (matchedTabEntry?.tab?.id && matchedTabEntry.window.id) {
    await chrome.windows.update(matchedTabEntry.window.id, {
      focused: true,
    });
    await chrome.tabs.update(matchedTabEntry.tab.id, {
      active: true,
    });
  }
  const activeTab = matchedTabEntry?.tab
    ?? (targetWindow?.tabs ?? []).find((tab: { active?: boolean }) => tab.active)
    ?? null;
  if (!activeTab || typeof activeTab.id !== "number") {
    throw new Error("Could not find an active tab in the last focused browser window");
  }
  const url = asString(activeTab.url);
  const origin = url ? parseOrigin(url) : null;
  if (!url || !origin) {
    throw new Error("The active tab does not expose a readable URL");
  }
  const response = await postJson<{
    ok: boolean;
    executor: Record<string, unknown>;
  }>(`${state.serverUrl}/api/executors/${encodeURIComponent(state.executorId)}/attach`, {
    executorToken: state.executorToken,
    windowId: typeof targetWindow.id === "number" ? targetWindow.id : null,
    tabId: activeTab.id,
    url,
    origin,
    title: asString(activeTab.title) ?? null,
    profileLabel: state.profileLabel,
    ...browserMetadata(),
  });
  queueLog("info", "browser_window_attached", "Attached browser window for Chrome executor", {
    windowId: targetWindow.id ?? null,
    tabId: activeTab.id,
    origin,
  });
  return applyExecutorStateFromServer(state, response.executor);
}

async function detachExecutor() {
  const state = await readExecutorState();
  if (!state.serverUrl || !state.executorId || !state.executorToken) {
    throw new Error("Executor must be paired before detaching a browser window");
  }
  const response = await postJson<{
    ok: boolean;
    executor: Record<string, unknown>;
  }>(`${state.serverUrl}/api/executors/${encodeURIComponent(state.executorId)}/detach`, {
    executorToken: state.executorToken,
  });
  queueLog("info", "browser_window_detached", "Detached browser window for Chrome executor", {
    executorId: state.executorId,
  });
  return applyExecutorStateFromServer(state, response.executor);
}

async function handleMessage(type: string, payload: Record<string, unknown> = {}) {
  switch (type) {
    case "get_state":
      return readExecutorState();
    case "save_config":
      return saveConfig(payload);
    case "pair_executor":
      return heartbeatCycle();
    case "heartbeat_now":
      return heartbeatCycle();
    case "attach_current_window":
      return attachCurrentWindow(payload);
    case "detach_executor":
      return detachExecutor();
    case "open_options":
      await chrome.runtime.openOptionsPage();
      return { opened: true };
    default:
      throw new Error(`Unsupported runtime message: ${type}`);
  }
}

chrome.runtime.onInstalled.addListener((details: { reason?: string }) => {
  void ensureAlarm();
  void refreshRuntimeMetadata();
  queueLog(
    "info",
    details.reason === "update" ? "extension_updated" : "extension_installed",
    details.reason === "update"
      ? "Chrome extension executor updated"
      : "Chrome extension executor installed",
    {
      reason: details.reason ?? "unknown",
    },
  );
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void refreshRuntimeMetadata();
});

chrome.alarms.onAlarm.addListener((alarm: { name?: string }) => {
  if (alarm.name !== HEARTBEAT_ALARM_NAME) {
    return;
  }
  void heartbeatCycle().catch(async (error) => {
    const message = toErrorMessage(error);
    queueLog("warn", "heartbeat_failed", "Chrome extension heartbeat failed", {
      error: message,
    });
    await patchExecutorState({
      lastError: message,
    });
  });
});

chrome.runtime.onMessage.addListener((message: { type?: string; payload?: Record<string, unknown> }, _sender: unknown, sendResponse: (payload: unknown) => void) => {
  void handleMessage(String(message.type ?? ""), message.payload ?? {})
    .then((result) => {
      sendResponse({
        ok: true,
        result,
      });
    })
    .catch(async (error) => {
      const messageText = toErrorMessage(error);
      await patchExecutorState({
        lastError: messageText,
      });
      sendResponse({
        ok: false,
        error: messageText,
      });
    });
  return true;
});
