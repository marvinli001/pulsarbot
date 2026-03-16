export interface ExtensionExecutorState {
  serverUrl: string;
  executorId: string;
  pairingCode: string | null;
  executorToken: string | null;
  profileLabel: string | null;
  attachState: "detached" | "attached";
  attachedWindowId: number | null;
  attachedTabId: number | null;
  attachedUrl: string | null;
  attachedOrigin: string | null;
  attachedTitle: string | null;
  attachedAt: string | null;
  detachedAt: string | null;
  lastSnapshotAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  extensionInstanceId: string | null;
  browserName: string | null;
  browserVersion: string | null;
  allowedHosts: string[];
  status: string;
}

export interface ExtensionAssignment {
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

export interface ExecutorLogEntry {
  taskRunId: string | null;
  scope: "assignment" | "heartbeat";
  level: "debug" | "info" | "warn" | "error";
  event: string;
  message: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

export interface CompletedRunPayload {
  taskRunId: string;
  status: "completed" | "failed" | "aborted";
  outputSummary: string;
  artifacts?: Array<{
    id: string;
    label: string;
    kind: "text" | "json" | "url" | "screenshot" | "file";
    content: unknown;
  }>;
  logs?: ExecutorLogEntry[];
  error?: string;
}

export interface BrowserStatePayload {
  attachState: "detached" | "attached";
  mode: "single_window";
  windowId: number | null;
  activeTab: {
    tabId: number | null;
    url: string | null;
    origin: string | null;
    title: string | null;
  };
  attachedAt: string | null;
  lastSnapshotAt: string | null;
  extensionInstanceId: string;
  profileLabel: string | null;
}

export const EXECUTOR_STORAGE_KEY = "pulsarbotChromeExecutorState";
export const HEARTBEAT_ALARM_NAME = "pulsarbot-chrome-extension-heartbeat";

export const defaultExecutorState: ExtensionExecutorState = {
  serverUrl: "",
  executorId: "",
  pairingCode: null,
  executorToken: null,
  profileLabel: null,
  attachState: "detached",
  attachedWindowId: null,
  attachedTabId: null,
  attachedUrl: null,
  attachedOrigin: null,
  attachedTitle: null,
  attachedAt: null,
  detachedAt: null,
  lastSnapshotAt: null,
  lastHeartbeatAt: null,
  lastError: null,
  extensionInstanceId: null,
  browserName: null,
  browserVersion: null,
  allowedHosts: [],
  status: "offline",
};

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeServerUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseOrigin(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

export function isHostAllowed(rawUrl: string, allowedHosts: string[]): boolean {
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

export async function readExecutorState(): Promise<ExtensionExecutorState> {
  const stored = await chrome.storage.local.get(EXECUTOR_STORAGE_KEY);
  return {
    ...defaultExecutorState,
    ...(stored?.[EXECUTOR_STORAGE_KEY] ?? {}),
  } as ExtensionExecutorState;
}

export async function writeExecutorState(state: ExtensionExecutorState) {
  await chrome.storage.local.set({
    [EXECUTOR_STORAGE_KEY]: state,
  });
  return state;
}

export async function patchExecutorState(
  patch: Partial<ExtensionExecutorState>,
): Promise<ExtensionExecutorState> {
  const current = await readExecutorState();
  const next = {
    ...current,
    ...patch,
  };
  await writeExecutorState(next);
  return next;
}

export async function sendRuntimeMessage<T>(type: string, payload?: Record<string, unknown>): Promise<T> {
  const response = await chrome.runtime.sendMessage({
    type,
    payload,
  });
  if (!response?.ok) {
    throw new Error(typeof response?.error === "string" ? response.error : "Extension request failed");
  }
  return response.result as T;
}
