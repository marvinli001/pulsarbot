import {
  Badge,
  Panel,
} from "@pulsarbot/ui-kit";
import {
  JsonPanel,
  KeyValueGrid,
  useSystemHealth,
} from "../shared.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "-";
}

function statusBadge(ok: boolean) {
  return <Badge tone={ok ? "success" : "warning"}>{ok ? "OK" : "Check"}</Badge>;
}

export function HealthPanel() {
  const health = useSystemHealth();
  const payload = asRecord(health.data);
  const jobs = asRecord(payload.jobs);
  const marketCounts = asRecord(payload.marketCounts);
  const telegram = asRecord(payload.telegram);
  const cloudflare = asRecord(payload.cloudflare);
  const activeTurnLocks = Array.isArray(payload.activeTurnLocks)
    ? payload.activeTurnLocks.length
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
              label: "Active Turn Locks",
              value: String(activeTurnLocks),
            },
            {
              label: "Market Skills/Plugins/MCP",
              value: `${asNumber(marketCounts.skills)}/${asNumber(marketCounts.plugins)}/${asNumber(marketCounts.mcp)}`,
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
        value={health.data ?? {}}
      />
    </div>
  );
}
