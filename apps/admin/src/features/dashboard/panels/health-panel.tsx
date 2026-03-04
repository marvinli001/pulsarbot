import {
  JsonPanel,
  useSystemHealth,
} from "../shared.js";

export function HealthPanel() {
  const health = useSystemHealth();

  return (
    <div className="grid gap-6">
      <JsonPanel
        title="System Health"
        subtitle="显示 Telegram webhook、bootstrap、provider counts、market counts 与 Cloudflare 依赖健康。"
        value={health.data ?? {}}
      />
    </div>
  );
}
