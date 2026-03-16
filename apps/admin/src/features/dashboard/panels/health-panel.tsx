import {
  Badge,
  Button,
  Panel,
} from "@pulsarbot/ui-kit";
import { notificationOccurred } from "../../../lib/telegram.js";
import {
  formatJson,
  JsonPanel,
  KeyValueGrid,
  useSystemHealth,
} from "../shared.js";
import { useState } from "react";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "-";
}

function statusBadge(ok: boolean) {
  return <Badge tone={ok ? "success" : "warning"}>{ok ? "OK" : "Check"}</Badge>;
}

function toneForStatus(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "completed" || status === "ok") {
    return "success";
  }
  if (status === "failed" || status === "error") {
    return "danger";
  }
  if (status === "pending" || status === "running" || status === "processing") {
    return "warning";
  }
  return "neutral";
}

function triggerDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

async function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function SystemHealthExportActions({ value }: { value: unknown }) {
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  const handleDownload = async (format: "text" | "json") => {
    try {
      triggerDownload(`/api/system/health/export?format=${format}`);
      notificationOccurred("success");
      setDownloadOpen(false);
    } catch {
      notificationOccurred("error");
    }
  };

  const handleCopy = async (format: "text" | "json") => {
    try {
      const content = format === "text" ? formatJson(value) : JSON.stringify(value ?? {}, null, 2);
      await copyToClipboard(content);
      notificationOccurred("success");
      setCopyOpen(false);
    } catch {
      notificationOccurred("error");
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      <div className="relative">
        <Button type="button" tone="secondary" onClick={() => setDownloadOpen((open) => !open)}>
          Download JSON as...
        </Button>
        {downloadOpen ? (
          <div
            className="absolute right-0 z-10 mt-2 grid min-w-52 gap-1 rounded-2xl border p-2 shadow-lg"
            style={{
              background: "var(--app-surface)",
              borderColor: "var(--app-border)",
            }}
          >
            <Button type="button" tone="ghost" className="justify-start" onClick={() => void handleDownload("text")}>
              Plain text (.txt)
            </Button>
            <Button type="button" tone="ghost" className="justify-start" onClick={() => void handleDownload("json")}>
              JSON (.json)
            </Button>
          </div>
        ) : null}
      </div>
      <div className="relative">
        <Button type="button" tone="ghost" onClick={() => setCopyOpen((open) => !open)}>
          Copy JSON as...
        </Button>
        {copyOpen ? (
          <div
            className="absolute right-0 z-10 mt-2 grid min-w-44 gap-1 rounded-2xl border p-2 shadow-lg"
            style={{
              background: "var(--app-surface)",
              borderColor: "var(--app-border)",
            }}
          >
            <Button type="button" tone="ghost" className="justify-start" onClick={() => void handleCopy("text")}>
              Plain text
            </Button>
            <Button type="button" tone="ghost" className="justify-start" onClick={() => void handleCopy("json")}>
              JSON
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function HealthPanel() {
  const health = useSystemHealth();
  const payload = asRecord(health.data);
  const jobs = asRecord(payload.jobs);
  const documents = asRecord(payload.documents);
  const marketCounts = asRecord(payload.marketCounts);
  const telegram = asRecord(payload.telegram);
  const cloudflare = asRecord(payload.cloudflare);
  const runtime = asRecord(payload.runtime);
  const graph = asRecord(payload.graph);
  const activeTurnLocks = Array.isArray(payload.activeTurnLocks)
    ? payload.activeTurnLocks.length
    : 0;
  const recentDocumentFailures = asArray(documents.recentFailures);
  const recentMcpHealth = asArray(payload.recentMcpHealth);
  const runtimeBlocked = asArray(runtime.blocked);
  const runtimeTools = asArray(runtime.tools);
  const recentTurnFailures = asArray(graph.recentTurnFailures);
  const enabledSkills = Array.isArray(runtime.enabledSkills)
    ? runtime.enabledSkills.length
    : 0;
  const enabledPlugins = Array.isArray(runtime.enabledPlugins)
    ? runtime.enabledPlugins.length
    : 0;
  const enabledMcpServers = Array.isArray(runtime.enabledMcpServers)
    ? runtime.enabledMcpServers.length
    : 0;

  const dependencyRows = ["d1", "r2", "vectorize", "aiSearch"].map((key) => {
    const status = asRecord(cloudflare[key]);
    return {
      key,
      ok: Boolean(status.ok),
      detail: asString(status.detail),
    };
  });

  return (
    <div className="grid gap-6">
      <Panel
        title="System Health Overview"
        subtitle="结构化展示当前运行模式、作业状态与外部依赖。"
      >
        <KeyValueGrid
          items={[
            { label: "Mode", value: asString(payload.mode) },
            {
              label: "Workspace",
              value: payload.hasWorkspace ? "ready" : "missing",
            },
            {
              label: "Providers",
              value: String(asNumber(payload.providerProfiles)),
            },
            {
              label: "MCP Servers",
              value: String(asNumber(payload.mcpServers)),
            },
            {
              label: "MCP Providers",
              value: String(asNumber(payload.mcpProviders)),
            },
            {
              label: "Active Turn Locks",
              value: String(activeTurnLocks),
            },
            {
              label: "Market S/P/M/Pv",
              value: `${asNumber(marketCounts.skills)}/${asNumber(marketCounts.plugins)}/${asNumber(marketCounts.mcp)}/${asNumber(marketCounts.mcpProviders)}`,
            },
          ]}
        />
      </Panel>
      <Panel
        title="Jobs Snapshot"
        subtitle="后台作业队列的当前数量。"
      >
        <div className="grid gap-3 md:grid-cols-4">
          {[
            ["pending", asNumber(jobs.pending)],
            ["running", asNumber(jobs.running)],
            ["failed", asNumber(jobs.failed)],
            ["completed", asNumber(jobs.completed)],
          ].map(([label, count]) => (
            <div
              key={label}
              className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
            >
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">
                {label}
              </p>
              <p className="mt-2 text-lg font-semibold text-slate-900">{count}</p>
              {label === "failed" ? statusBadge(Number(count) === 0) : null}
            </div>
          ))}
        </div>
      </Panel>
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Document Extraction"
          subtitle="抽取状态必须收口到 completed 或 failed，不允许长期停在 processing。"
        >
          <KeyValueGrid
            items={[
              { label: "Documents", value: String(asNumber(documents.total)) },
              { label: "Pending", value: String(asNumber(documents.pending)) },
              { label: "Processing", value: String(asNumber(documents.processing)) },
              { label: "Failed", value: String(asNumber(documents.failed)) },
              { label: "Completed", value: String(asNumber(documents.completed)) },
              { label: "Recent Failures", value: String(recentDocumentFailures.length) },
            ]}
          />
        </Panel>
        <Panel
          title="Runtime Diagnostics"
          subtitle="展示当前 active profile 实际会启用什么，以及为什么会被 block。"
        >
          <KeyValueGrid
            items={[
              {
                label: "Active Profile",
                value: asString(asRecord(runtime.activeProfile).label),
              },
              { label: "Enabled Skills", value: String(enabledSkills) },
              { label: "Enabled Plugins", value: String(enabledPlugins) },
              { label: "Enabled MCP", value: String(enabledMcpServers) },
              { label: "Enabled Tools", value: String(runtimeTools.length) },
              {
                label: "Prompt Fragments",
                value: String(asNumber(runtime.promptFragmentCount)),
              },
              { label: "Blocked", value: String(runtimeBlocked.length) },
              { label: "Generated At", value: asString(runtime.generatedAt) },
            ]}
          />
          <div className="mt-4 grid gap-2">
            {runtimeBlocked.length === 0 ? (
              <p className="text-sm text-slate-500">No blocked capabilities.</p>
            ) : null}
            {runtimeBlocked.slice(0, 6).map((item) => (
              <div
                key={`${asString(item.scope)}-${asString(item.id)}`}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-slate-900">
                    {asString(item.scope)} · {asString(item.id)}
                  </p>
                  <Badge tone="warning">blocked</Badge>
                </div>
                <p className="mt-1 text-slate-500">{asString(item.reason)}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Recent Document Failures"
          subtitle="面向 owner 的最近失败原因，便于确认后台重试是否有效。"
        >
          <div className="grid gap-2">
            {recentDocumentFailures.length === 0 ? (
              <p className="text-sm text-slate-500">No document failures.</p>
            ) : null}
            {recentDocumentFailures.map((item) => (
              <div
                key={asString(item.id)}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-slate-900">{asString(item.title)}</p>
                  <Badge tone={toneForStatus(asString(item.extractionStatus))}>
                    {asString(item.extractionStatus)}
                  </Badge>
                </div>
                <p className="mt-1 text-slate-500">
                  method {asString(item.extractionMethod)} · updated {asString(item.updatedAt)}
                </p>
                <p className="mt-1 break-words text-rose-600">
                  {asString(item.lastExtractionError)}
                </p>
              </div>
            ))}
          </div>
        </Panel>
        <Panel
          title="Recent MCP Health"
          subtitle="最近健康检查结果，失败时在这里先暴露，不要求用户手动重试。"
        >
          <div className="grid gap-2">
            {recentMcpHealth.length === 0 ? (
              <p className="text-sm text-slate-500">No MCP health checks recorded.</p>
            ) : null}
            {recentMcpHealth.map((item) => (
              <div
                key={asString(item.id)}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-slate-900">{asString(item.label)}</p>
                  <Badge tone={toneForStatus(asString(item.lastHealthStatus))}>
                    {asString(item.lastHealthStatus)}
                  </Badge>
                </div>
                <p className="mt-1 text-slate-500">
                  {asString(item.transport)} · checked {asString(item.lastHealthCheckedAt)}
                </p>
                <p className="mt-1 text-slate-500">{asString(item.description)}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Turn Graph"
          subtitle="查看 threaded turn 当前运行、卡住和最近失败情况。"
        >
          <KeyValueGrid
            items={[
              { label: "Running Turns", value: String(asNumber(graph.runningTurns)) },
              { label: "Resumable Turns", value: String(asNumber(graph.resumableTurns)) },
              { label: "Stuck Turns", value: String(asNumber(graph.stuckTurns)) },
              { label: "Recent Failures", value: String(recentTurnFailures.length) },
            ]}
          />
          <div className="mt-4 grid gap-2">
            {recentTurnFailures.length === 0 ? (
              <p className="text-sm text-slate-500">No recent turn failures.</p>
            ) : null}
            {recentTurnFailures.map((item) => (
              <div
                key={asString(item.turnId)}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs"
              >
                <p className="font-medium text-slate-900">
                  {asString(item.turnId)} · {asString(item.currentNode)}
                </p>
                <p className="mt-1 text-slate-500">
                  conversation {asString(item.conversationId)} · updated {asString(item.updatedAt)}
                </p>
                <p className="mt-1 break-words text-rose-600">{asString(item.error)}</p>
              </div>
            ))}
          </div>
        </Panel>
        <Panel
          title="Enabled Tool Snapshot"
          subtitle="当前 active runtime 真正暴露给 agent 的工具快照。"
        >
          <div className="grid gap-2">
            {runtimeTools.length === 0 ? (
              <p className="text-sm text-slate-500">No tools resolved.</p>
            ) : null}
            {runtimeTools.slice(0, 10).map((tool) => (
              <div
                key={asString(tool.id)}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-slate-900">{asString(tool.title)}</p>
                  <Badge tone="neutral">{asString(tool.source)}</Badge>
                </div>
                <p className="mt-1 text-slate-500">{asString(tool.id)}</p>
                <p className="mt-1 text-slate-500">
                  scopes {Array.isArray(tool.permissionScopes)
                    ? tool.permissionScopes.join(", ")
                    : "-"}
                </p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel
        title="Cloudflare Dependencies"
        subtitle="D1 / R2 / Vectorize / AI Search 的健康状态。"
      >
        <div className="grid gap-3 md:grid-cols-2">
          {dependencyRows.map((item) => (
            <div
              key={item.key}
              className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium capitalize text-slate-900">
                  {item.key}
                </p>
                {statusBadge(item.ok)}
              </div>
              <p className="mt-2 text-xs text-slate-500">{item.detail}</p>
            </div>
          ))}
        </div>
      </Panel>
      <Panel
        title="Telegram Webhook"
        subtitle="最近 webhook 更新状态与会话上下文。"
      >
        <KeyValueGrid
          items={[
            { label: "Status", value: asString(telegram.status) },
            { label: "Last Update Type", value: asString(telegram.lastUpdateType) },
            { label: "Last Chat ID", value: asString(telegram.lastChatId) },
            { label: "Updated At", value: asString(telegram.updatedAt) },
          ]}
        />
      </Panel>
      <JsonPanel
        title="System Health (Raw JSON)"
        subtitle="用于排障时查看完整原始响应。"
        actions={<SystemHealthExportActions value={health.data ?? {}} />}
        value={health.data ?? {}}
      />
    </div>
  );
}
