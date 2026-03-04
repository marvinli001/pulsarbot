import { Panel } from "@pulsarbot/ui-kit";
import {
  JsonPanel,
  KeyValueGrid,
  useSystemAudit,
  useSystemLogs,
} from "../shared.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
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

export function LogsPanel() {
  const logs = useSystemLogs();
  const audit = useSystemAudit();
  const logsPayload = asRecord(logs.data);
  const recentJobs = asArray(logsPayload.recentJobs).slice(0, 10);
  const recentProviderTests = asArray(logsPayload.recentProviderTests).slice(0, 8);
  const recentAudit = asArray(audit.data).slice(0, 12);
  const mcpLogs = asArray(logsPayload.recentMcpLogs);
  const importExportRuns = asArray(logsPayload.importExportRuns);

  return (
    <div className="grid gap-6">
      <Panel
        title="Logs Overview"
        subtitle="快速查看最近作业、provider tests、导入导出与审计数量。"
      >
        <KeyValueGrid
          items={[
            { label: "Recent Jobs", value: String(recentJobs.length) },
            {
              label: "Recent Provider Tests",
              value: String(recentProviderTests.length),
            },
            {
              label: "Import/Export Runs",
              value: String(importExportRuns.length),
            },
            { label: "Audit Events", value: String(recentAudit.length) },
            { label: "MCP Log Streams", value: String(mcpLogs.length) },
          ]}
        />
      </Panel>
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Recent Jobs"
          subtitle="最近后台任务状态。"
        >
          <div className="grid gap-2">
            {recentJobs.length === 0 ? (
              <p className="text-sm text-slate-500">No recent jobs.</p>
            ) : null}
            {recentJobs.map((item) => (
              <div
                key={asString(item.id)}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs"
              >
                <p className="font-medium text-slate-900">
                  {asString(item.kind)} · {asString(item.status)}
                </p>
                <p className="mt-1 text-slate-500">
                  {asString(item.id)} · attempts {String(item.attempts ?? 0)}
                </p>
                <p className="mt-1 text-slate-500">{asString(item.updatedAt)}</p>
              </div>
            ))}
          </div>
        </Panel>
        <Panel
          title="Recent Provider Tests"
          subtitle="最近 capability test 结果。"
        >
          <div className="grid gap-2">
            {recentProviderTests.length === 0 ? (
              <p className="text-sm text-slate-500">No provider tests recorded.</p>
            ) : null}
            {recentProviderTests.map((item) => (
              <div
                key={asString(item.id)}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs"
              >
                <p className="font-medium text-slate-900">
                  {asString(item.providerId)} · {asString(item.status)}
                </p>
                <p className="mt-1 text-slate-500">
                  capabilities: {Array.isArray(item.requestedCapabilities)
                    ? item.requestedCapabilities.join(", ")
                    : "-"}
                </p>
                <p className="mt-1 text-slate-500">{asString(item.createdAt)}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <Panel
        title="Audit Events"
        subtitle="最近 owner 行为与系统审计轨迹。"
      >
        <div className="grid gap-2">
          {recentAudit.length === 0 ? (
            <p className="text-sm text-slate-500">No audit events.</p>
          ) : null}
          {recentAudit.map((item) => (
            <div
              key={asString(item.id)}
              className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs"
            >
              <p className="font-medium text-slate-900">
                {asString(item.eventType)} · {asString(item.targetType)}
              </p>
              <p className="mt-1 text-slate-500">
                actor {asString(item.actorTelegramUserId)} · target {asString(item.targetId)}
              </p>
              <p className="mt-1 text-slate-500">{asString(item.createdAt)}</p>
            </div>
          ))}
        </div>
      </Panel>
      <div className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
        <JsonPanel
          title="System Logs (Raw JSON)"
          subtitle="保留完整输出用于深度排障。"
          value={logs.data ?? {}}
        />
        <JsonPanel
          title="Audit Events (Raw JSON)"
          subtitle="完整审计 JSON。"
          value={audit.data ?? []}
        />
      </div>
    </div>
  );
}
