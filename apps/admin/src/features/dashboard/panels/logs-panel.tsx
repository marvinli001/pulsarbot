import {
  JsonPanel,
  useSystemAudit,
  useSystemLogs,
} from "../shared.js";

export function LogsPanel() {
  const logs = useSystemLogs();
  const audit = useSystemAudit();

  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
      <JsonPanel
        title="System Logs"
        subtitle="import/export runs 与 recent audit 的组合快照。"
        value={logs.data ?? {}}
      />
      <JsonPanel
        title="Audit Events"
        subtitle="owner 操作、bootstrap、provider/profile 变更等审计轨迹。"
        value={audit.data ?? []}
      />
    </div>
  );
}
