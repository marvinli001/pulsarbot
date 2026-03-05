import type { ComponentType, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Panel,
} from "@pulsarbot/ui-kit";
import {
  Bot,
  BrainCircuit,
  Database,
  FileJson,
  HeartPulse,
  LayoutDashboard,
  MemoryStick,
  PackageSearch,
  PlugZap,
  ScrollText,
  Search,
  Settings2,
  Sparkles,
  Wrench,
} from "lucide-react";
import { apiFetch, devTelegramSessionPayload } from "../../lib/api.js";
import {
  selectionChanged,
} from "../../lib/telegram.js";
import { useAdminUiStore } from "../../lib/store.js";

export type Section = ReturnType<typeof useAdminUiStore.getState>["activeSection"];
export type JsonRecord = Record<string, unknown>;
export type ProviderKindOption =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "bailian"
  | "openai_compatible_chat"
  | "openai_compatible_responses";
export type ProviderTestCapability = "text" | "vision" | "audio" | "document";
export type CloudflareBootstrapMode = "new" | "existing";
export type CloudflareAuthMode = "global_api_key" | "api_token";

export interface SessionPayload {
  user: { userId: string; username?: string };
  bootstrapState: BootstrapState;
  workspace?: WorkspacePayload | null;
  adminIdentity?: JsonRecord | null;
}

export interface ProviderCapabilityTestEntry {
  capability: ProviderTestCapability;
  status: "ok" | "failed" | "skipped" | "unsupported";
  outputPreview?: string;
  reason?: string;
  error?: string;
}

export interface ProviderCapabilityTestResponse {
  ok: boolean;
  providerId: string;
  providerKind: string;
  requestedCapabilities: ProviderTestCapability[];
  results: ProviderCapabilityTestEntry[];
}

export interface BootstrapState {
  verified: boolean;
  ownerBound: boolean;
  cloudflareConnected: boolean;
  resourcesInitialized: boolean;
}

export interface WorkspacePayload {
  id?: string;
  label: string;
  timezone: string;
  primaryModelProfileId: string | null;
  backgroundModelProfileId: string | null;
  activeAgentProfileId?: string | null;
  ownerTelegramUserId?: string | null;
}

export interface WorkspaceEnvelope {
  bootstrapState: BootstrapState;
  workspace: WorkspacePayload | null;
  searchSettings?: JsonRecord | null;
}

export interface CloudflareResourceInventory {
  d1: Array<{ uuid: string; name: string }>;
  r2: Array<{ name: string }>;
  vectorize: Array<{ name: string }>;
  aiSearch: Array<{ name: string }>;
}

export const navigation = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "workspace", label: "Workspace", icon: Settings2 },
  { id: "providers", label: "Providers", icon: Bot },
  { id: "profiles", label: "Profiles", icon: BrainCircuit },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "plugins", label: "Plugins", icon: PlugZap },
  { id: "mcp-market", label: "MCP Market", icon: PackageSearch },
  { id: "mcp-servers", label: "MCP Servers", icon: Wrench },
  { id: "search", label: "Search", icon: Search },
  { id: "memory", label: "Memory", icon: MemoryStick },
  { id: "documents", label: "Documents", icon: ScrollText },
  { id: "import-export", label: "Import/Export", icon: FileJson },
  { id: "logs", label: "Logs", icon: Database },
  { id: "health", label: "Health", icon: HeartPulse },
] as const satisfies Array<{
  id: Section;
  label: string;
  icon: ComponentType<{ className?: string }>;
}>;

export function formatJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

export function parseJsonRecord(input: string): JsonRecord {
  const parsed = JSON.parse(input || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed as JsonRecord;
}

export function parseArgs(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readableMutationError(error: unknown) {
  let message = error instanceof Error ? error.message : "Request failed";

  try {
    const parsed = JSON.parse(message) as {
      message?: string;
      error?: string;
    };
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      message = parsed.message.trim();
    } else if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      message = parsed.error.trim();
    }
  } catch {
    // Keep original message when body is not JSON.
  }

  if (message.includes("Missing \"Authorization\" header")) {
    return "Cloudflare 鉴权失败：当前流程需要有效 API Token（Bearer）或正确的 Global API Key + Email。请检查鉴权模式与字段。";
  }

  return message;
}

export const providerKindOptions: Array<{
  value: ProviderKindOption;
  label: string;
}> = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "bailian", label: "Bailian" },
  { value: "openai_compatible_chat", label: "OpenAI-compatible Chat" },
  { value: "openai_compatible_responses", label: "OpenAI-compatible Responses" },
];

export const searchProviderOptions = [
  {
    value: "google_native",
    label: "Google Native",
    caption: "Use the built-in Google search plugin when installed and enabled.",
  },
  {
    value: "bing_native",
    label: "Bing Native",
    caption: "Use the built-in Bing search plugin when installed and enabled.",
  },
  {
    value: "exa_mcp",
    label: "Exa MCP",
    caption: "Route search to an enabled MCP server that exposes Exa search tools.",
  },
  {
    value: "web_browse",
    label: "Web Browse",
    caption: "Fallback to direct page fetch when the query is a URL and browse is enabled.",
  },
] as const;

export const fallbackStrategyOptions = [
  { value: "exa_then_browse", label: "Exa then Browse" },
  { value: "browse_only", label: "Browse Only" },
] as const;

export const providerKindTemplates: Record<
  ProviderKindOption,
  {
    label: string;
    apiBaseUrl: string;
    defaultModel: string;
    visionModel: string;
    audioModel: string;
    documentModel: string;
    visionEnabled: boolean;
    audioInputEnabled: boolean;
    documentInputEnabled: boolean;
    stream: boolean;
    toolCallingEnabled: boolean;
    jsonModeEnabled: boolean;
  }
> = {
  openai: {
    label: "OpenAI Provider",
    apiBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5",
    visionModel: "gpt-5",
    audioModel: "gpt-4o-mini-transcribe",
    documentModel: "",
    visionEnabled: true,
    audioInputEnabled: true,
    documentInputEnabled: false,
    stream: true,
    toolCallingEnabled: true,
    jsonModeEnabled: true,
  },
  anthropic: {
    label: "Anthropic Provider",
    apiBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
    visionModel: "claude-sonnet-4-5",
    audioModel: "",
    documentModel: "claude-sonnet-4-5",
    visionEnabled: true,
    audioInputEnabled: false,
    documentInputEnabled: true,
    stream: true,
    toolCallingEnabled: true,
    jsonModeEnabled: true,
  },
  gemini: {
    label: "Gemini Provider",
    apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
    visionModel: "gemini-2.5-flash",
    audioModel: "gemini-2.5-flash",
    documentModel: "gemini-2.5-flash",
    visionEnabled: true,
    audioInputEnabled: true,
    documentInputEnabled: true,
    stream: true,
    toolCallingEnabled: true,
    jsonModeEnabled: true,
  },
  openrouter: {
    label: "OpenRouter Provider",
    apiBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4.1-mini",
    visionModel: "google/gemini-2.5-flash",
    audioModel: "google/gemini-2.5-flash",
    documentModel: "google/gemini-2.5-flash",
    visionEnabled: true,
    audioInputEnabled: true,
    documentInputEnabled: true,
    stream: true,
    toolCallingEnabled: true,
    jsonModeEnabled: true,
  },
  bailian: {
    label: "Bailian Provider",
    apiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.5-plus",
    visionModel: "qwen3.5-plus",
    audioModel: "qwen3-asr-flash",
    documentModel: "qwen-doc-turbo",
    visionEnabled: true,
    audioInputEnabled: true,
    documentInputEnabled: true,
    stream: true,
    toolCallingEnabled: true,
    jsonModeEnabled: true,
  },
  openai_compatible_chat: {
    label: "Compatible Chat Provider",
    apiBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    visionModel: "gpt-4.1-mini",
    audioModel: "gpt-4o-mini-transcribe",
    documentModel: "",
    visionEnabled: true,
    audioInputEnabled: true,
    documentInputEnabled: false,
    stream: true,
    toolCallingEnabled: true,
    jsonModeEnabled: true,
  },
  openai_compatible_responses: {
    label: "Compatible Responses Provider",
    apiBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    visionModel: "gpt-4.1-mini",
    audioModel: "gpt-4o-mini-transcribe",
    documentModel: "",
    visionEnabled: true,
    audioInputEnabled: true,
    documentInputEnabled: false,
    stream: true,
    toolCallingEnabled: true,
    jsonModeEnabled: true,
  },
};

export const reasoningLevelOptions: Array<{ value: string; label: string }> = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const commonThinkingBudgetOptions: Array<{ value: string; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "512", label: "512" },
  { value: "1024", label: "1024" },
  { value: "2048", label: "2048" },
  { value: "4096", label: "4096" },
];

const bailianThinkingBudgetOptions: Array<{ value: string; label: string }> = [
  { value: "auto", label: "Auto (Bailian default)" },
  { value: "512", label: "512" },
  { value: "1024", label: "1024" },
  { value: "2048", label: "2048" },
  { value: "4096", label: "4096" },
  { value: "8192", label: "8192" },
];

export function thinkingBudgetOptionsForProvider(
  kind: ProviderKindOption,
): Array<{ value: string; label: string }> {
  if (kind === "bailian") {
    return bailianThinkingBudgetOptions;
  }
  return commonThinkingBudgetOptions;
}

export function useSessionBootstrap() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () =>
      apiFetch<SessionPayload>("/api/session/telegram", {
        method: "POST",
        body: JSON.stringify(devTelegramSessionPayload()),
      }),
  });
}

export function useWorkspaceData() {
  return useQuery({
    queryKey: ["workspace"],
    queryFn: () => apiFetch<WorkspaceEnvelope>("/api/workspace"),
  });
}

export function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: () => apiFetch<Array<JsonRecord>>("/api/providers"),
  });
}

export function useProfiles() {
  return useQuery({
    queryKey: ["profiles"],
    queryFn: () => apiFetch<Array<JsonRecord>>("/api/agent-profiles"),
  });
}

export function useRuntimePreview(agentProfileId: string) {
  return useQuery({
    queryKey: ["runtime-preview", agentProfileId],
    queryFn: () =>
      apiFetch<JsonRecord>(
        `/api/runtime/preview?agentProfileId=${encodeURIComponent(agentProfileId)}`,
      ),
    enabled: Boolean(agentProfileId),
  });
}

export function useMarket(kind: "skills" | "plugins" | "mcp") {
  return useQuery({
    queryKey: ["market", kind],
    queryFn: () =>
      apiFetch<{
        manifests: Array<JsonRecord>;
        installs: Array<JsonRecord>;
      }>(`/api/market/${kind}`),
  });
}

export function useMcpServers() {
  return useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => apiFetch<Array<JsonRecord>>("/api/mcp/servers"),
  });
}

export function useSearchSettings() {
  return useQuery({
    queryKey: ["search-settings"],
    queryFn: () => apiFetch<JsonRecord>("/api/search/settings"),
  });
}

export function useMemoryStatus() {
  return useQuery({
    queryKey: ["memory-status"],
    queryFn: () => apiFetch<JsonRecord>("/api/memory/status"),
  });
}

export function useDocuments() {
  return useQuery({
    queryKey: ["documents"],
    queryFn: () => apiFetch<Array<JsonRecord>>("/api/documents"),
  });
}

export function useSystemHealth() {
  return useQuery({
    queryKey: ["system-health"],
    queryFn: () => apiFetch<JsonRecord>("/api/system/health"),
    refetchInterval: 10_000,
  });
}

export function useSystemLogs() {
  return useQuery({
    queryKey: ["system-logs"],
    queryFn: () => apiFetch<JsonRecord>("/api/system/logs"),
  });
}

export function useSystemAudit() {
  return useQuery({
    queryKey: ["system-audit"],
    queryFn: () => apiFetch<Array<JsonRecord>>("/api/system/audit"),
  });
}

export function useCloudflareResources(enabled: boolean) {
  return useQuery({
    queryKey: ["cloudflare-resources"],
    queryFn: () =>
      apiFetch<CloudflareResourceInventory>("/api/bootstrap/cloudflare/resources"),
    enabled,
  });
}

export function Sidebar() {
  const { activeSection, setActiveSection } = useAdminUiStore();

  return (
    <>
      <div className="hidden space-y-4 xl:block">
        <div className="rounded-[24px] bg-slate-950 p-5 text-white">
          <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
            Pulsarbot
          </p>
          <h1 className="mt-2 font-['Space_Grotesk',sans-serif] text-2xl font-semibold">
            Agent Control Plane
          </h1>
          <p className="mt-2 text-sm text-slate-300">
            Mini App 管理台，统一处理 provider、profile、market、MCP、记忆与导入导出。
          </p>
        </div>
        <nav className="space-y-1">
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = item.id === activeSection;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  selectionChanged();
                  setActiveSection(item.id);
                }}
                className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left text-sm transition hover:bg-slate-100"
                style={
                  active
                    ? {
                        background: "var(--tg-button-color)",
                        color: "var(--tg-button-text-color)",
                      }
                    : {
                        color: "var(--app-muted-text)",
                      }
                }
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>
      <div
        className="fixed inset-x-0 bottom-0 z-40 overflow-hidden border-t border-slate-200 bg-white/95 px-2 py-2 shadow-[0_-12px_32px_rgba(15,23,42,0.08)] backdrop-blur xl:hidden"
        style={{
          background: "color-mix(in srgb, var(--tg-bottom-bar-bg-color) 92%, transparent)",
          borderColor: "var(--app-border)",
          paddingBottom: "calc(0.5rem + var(--app-safe-area-bottom))",
          paddingLeft: "0.5rem",
          paddingRight: "0.5rem",
          maxWidth: "100vw",
          overflowX: "clip",
        }}
      >
        <div
          className="flex min-w-0 max-w-full gap-1 overflow-x-auto"
          style={{
            WebkitOverflowScrolling: "touch",
            overscrollBehaviorX: "contain",
            touchAction: "pan-x",
          }}
        >
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = item.id === activeSection;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  selectionChanged();
                  setActiveSection(item.id);
                }}
                className="min-w-[88px] rounded-2xl px-3 py-2 text-xs transition"
                style={
                  active
                    ? {
                        background: "var(--tg-button-color)",
                        color: "var(--tg-button-text-color)",
                      }
                    : {
                        background: "var(--app-surface-soft)",
                        color: "var(--app-muted-text)",
                      }
                }
              >
                <Icon className="mx-auto mb-1 h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

export function StatusTile({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <div className="mt-2">
        <Badge tone={ok ? "success" : "warning"}>
          {ok ? "Ready" : "Pending"}
        </Badge>
      </div>
    </div>
  );
}

export function MutationBadge({
  mutation,
  successLabel = "Saved",
  idleLabel = "Idle",
}: {
  mutation: {
    isPending: boolean;
    isSuccess: boolean;
    isError: boolean;
    error: unknown;
  };
  successLabel?: string;
  idleLabel?: string;
}) {
  if (mutation.isError) {
    const message = readableMutationError(mutation.error);
    return (
      <div
        className="w-full rounded-2xl border px-3 py-2 text-xs leading-5 md:w-auto"
        style={{
          background: "var(--app-danger-bg)",
          borderColor: "color-mix(in srgb, var(--app-danger-text) 30%, var(--app-border))",
          color: "var(--app-danger-text)",
          overflowWrap: "anywhere",
        }}
      >
        {message}
      </div>
    );
  }

  if (mutation.isPending) {
    return <Badge tone="warning">Working</Badge>;
  }

  if (mutation.isSuccess) {
    return <Badge tone="success">{successLabel}</Badge>;
  }

  return <Badge tone="neutral">{idleLabel}</Badge>;
}

export function KeyValueGrid({
  items,
}: {
  items: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
        >
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
            {item.label}
          </p>
          <p className="mt-2 break-all text-sm text-slate-900">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

export function JsonPanel({
  title,
  subtitle,
  value,
  actions,
}: {
  title: string;
  subtitle: string;
  value: unknown;
  actions?: ReactNode;
}) {
  return (
    <Panel title={title} subtitle={subtitle} actions={actions}>
      <pre
        className="overflow-x-auto rounded-2xl p-4 text-xs"
        style={{
          background: "var(--app-header-bg)",
          color: "var(--app-header-text)",
        }}
      >
        {formatJson(value)}
      </pre>
    </Panel>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className="flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm"
      style={{
        borderColor: "var(--app-border)",
        background: "var(--app-surface-soft)",
        color: "var(--tg-text-color)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

export function SelectField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-2xl border px-4 py-3 text-sm outline-none transition"
      style={{
        borderColor: "var(--app-border)",
        background: "var(--app-surface-soft)",
        color: "var(--tg-text-color)",
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function CheckboxListField({
  label,
  hint,
  options,
  values,
  onChange,
}: {
  label: string;
  hint?: string;
  options: Array<{ value: string; label: string; caption?: string }>;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const selected = new Set(values);
  return (
    <div className="grid gap-2">
      <div>
        <p className="text-sm font-medium text-slate-900">{label}</p>
        {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
      </div>
      <div className="grid gap-2">
        {options.length === 0 ? (
          <div
            className="rounded-2xl border px-4 py-3 text-sm"
            style={{
              borderColor: "var(--app-border)",
              background: "var(--app-surface-soft)",
              color: "var(--app-muted-text)",
            }}
          >
            No available options.
          </div>
        ) : null}
        {options.map((option) => (
          <label
            key={option.value}
            className="flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm"
            style={{
              borderColor: "var(--app-border)",
              background: "var(--app-surface-soft)",
              color: "var(--tg-text-color)",
            }}
          >
            <input
              type="checkbox"
              checked={selected.has(option.value)}
              onChange={(event) => {
                const next = new Set(values);
                if (event.target.checked) {
                  next.add(option.value);
                } else {
                  next.delete(option.value);
                }
                onChange([...next]);
              }}
            />
            <span className="grid gap-1">
              <span>{option.label}</span>
              {option.caption ? (
                <span className="text-xs text-slate-500">{option.caption}</span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function OrderedCheckboxListField({
  label,
  hint,
  options,
  values,
  onChange,
}: {
  label: string;
  hint?: string;
  options: Array<{ value: string; label: string; caption?: string }>;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const selected = new Set(values);
  const sorted = [
    ...values
      .map((value) => options.find((option) => option.value === value))
      .filter((option): option is { value: string; label: string; caption?: string } =>
        Boolean(option)
      ),
    ...options.filter((option) => !selected.has(option.value)),
  ];

  const move = (value: string, direction: -1 | 1) => {
    const index = values.indexOf(value);
    const nextIndex = index + direction;
    if (index === -1 || nextIndex < 0 || nextIndex >= values.length) {
      return;
    }
    const next = [...values];
    const [item] = next.splice(index, 1);
    if (!item) {
      return;
    }
    next.splice(nextIndex, 0, item);
    onChange(next);
  };

  return (
    <div className="grid gap-2">
      <div>
        <p className="text-sm font-medium text-slate-900">{label}</p>
        {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
      </div>
      <div className="grid gap-2">
        {sorted.map((option) => {
          const isSelected = selected.has(option.value);
          const position = values.indexOf(option.value);
          return (
            <div
              key={option.value}
              className="flex items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-sm"
              style={{
                borderColor: "var(--app-border)",
                background: "var(--app-surface-soft)",
                color: "var(--tg-text-color)",
              }}
            >
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(event) => {
                    if (event.target.checked) {
                      onChange([...values, option.value]);
                      return;
                    }
                    onChange(values.filter((item) => item !== option.value));
                  }}
                />
                <span className="grid gap-1">
                  <span>{option.label}</span>
                  {option.caption ? (
                    <span className="text-xs text-slate-500">{option.caption}</span>
                  ) : null}
                </span>
              </label>
              {isSelected ? (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    tone="ghost"
                    disabled={position <= 0}
                    onClick={() => move(option.value, -1)}
                  >
                    Up
                  </Button>
                  <Button
                    type="button"
                    tone="ghost"
                    disabled={position === -1 || position >= values.length - 1}
                    onClick={() => move(option.value, 1)}
                  >
                    Down
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BootstrapModeCard({
  title,
  description,
  active,
  onClick,
}: {
  title: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-2xl border px-4 py-4 text-left transition"
      style={{
        borderColor: active ? "var(--tg-button-color)" : "var(--app-border)",
        background: active ? "rgba(15, 23, 42, 0.04)" : "var(--app-surface-soft)",
        color: "var(--tg-text-color)",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">{title}</p>
        <Badge tone={active ? "success" : "neutral"}>
          {active ? "Selected" : "Available"}
        </Badge>
      </div>
      <p className="mt-2 text-sm" style={{ color: "var(--app-muted-text)" }}>
        {description}
      </p>
    </button>
  );
}

export function ResourceSelectField({
  label,
  hint,
  value,
  onChange,
  options,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="grid gap-2">
      <div>
        <p className="text-sm font-medium text-slate-900">{label}</p>
        <p className="text-xs text-slate-500">{hint}</p>
      </div>
      <SelectField value={value} onChange={onChange} options={options} />
    </div>
  );
}

function providerTestTone(
  status: ProviderCapabilityTestEntry["status"],
): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "ok":
      return "success";
    case "skipped":
    case "unsupported":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

function providerTestLabel(
  status: ProviderCapabilityTestEntry["status"],
): string {
  switch (status) {
    case "ok":
      return "OK";
    case "skipped":
      return "Skipped";
    case "unsupported":
      return "Unsupported";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

export function ProviderCapabilityTestSummary({
  result,
  isRunning,
  pendingCapabilities,
}: {
  result: ProviderCapabilityTestResponse | undefined;
  isRunning: boolean;
  pendingCapabilities: ProviderTestCapability[] | undefined;
}) {
  if (!result && !isRunning) {
    return (
      <div
        className="mt-4 rounded-2xl border px-4 py-3 text-sm"
        style={{
          borderColor: "var(--app-border)",
          background: "var(--app-surface-soft)",
          color: "var(--app-muted-text)",
        }}
      >
        No capability test yet.
      </div>
    );
  }

  return (
    <div
      className="mt-4 rounded-2xl border p-4"
      style={{
        borderColor: "var(--app-border)",
        background: "var(--app-surface-soft)",
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {isRunning ? <Badge tone="warning">Testing</Badge> : null}
        {result ? (
          <Badge tone={result.ok ? "success" : "warning"}>
            {result.ok ? "All Passed" : "Needs Attention"}
          </Badge>
        ) : null}
        {(result?.requestedCapabilities ?? pendingCapabilities ?? []).map((capability) => (
          <Badge key={capability} tone="neutral">
            {capability}
          </Badge>
        ))}
      </div>
      {result ? (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr
                className="text-xs uppercase tracking-[0.18em]"
                style={{ color: "var(--app-muted-text)" }}
              >
                <th className="pb-2 pr-4 font-medium">Capability</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((entry) => (
                <tr key={entry.capability} className="border-t" style={{ borderColor: "var(--app-border)" }}>
                  <td className="py-3 pr-4 font-medium text-slate-900">
                    {entry.capability}
                  </td>
                  <td className="py-3 pr-4">
                    <Badge tone={providerTestTone(entry.status)}>
                      {providerTestLabel(entry.status)}
                    </Badge>
                  </td>
                  <td className="py-3 text-slate-600">
                    {entry.outputPreview || entry.reason || entry.error || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
