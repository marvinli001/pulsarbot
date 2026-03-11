import {
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Badge,
  Button,
  Panel,
} from "@pulsarbot/ui-kit";
import { apiFetch } from "../../../lib/api.js";
import { notificationOccurred } from "../../../lib/telegram.js";
import {
  MutationBadge,
  useMarket,
} from "../shared.js";

export function MarketPanel({ kind }: { kind: "skills" | "plugins" | "mcp" }) {
  const market = useMarket(kind);
  const queryClient = useQueryClient();

  const actionMutation = useMutation({
    mutationFn: async ({
      action,
      id,
    }: {
      action: "install" | "uninstall" | "enable" | "disable";
      id: string;
    }) =>
      apiFetch(`/api/market/${kind}/${id}/${action}`, {
        method: "POST",
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["market", kind] }),
        queryClient.invalidateQueries({ queryKey: ["profiles"] }),
        ...(kind === "mcp"
          ? [
              queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
              queryClient.invalidateQueries({ queryKey: ["system-health"] }),
            ]
          : []),
      ]);
    },
    onError: () => notificationOccurred("error"),
  });

  const installs = market.data?.installs ?? [];

  return (
    <Panel
      title={kind === "mcp" ? "MCP Market" : `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)} Market`}
      subtitle={kind === "mcp"
        ? "官方 MCP manifest 池。Install 会自动创建 MCP server 配置，Enable 会启用它并加入当前 active profile；模板或占位 preset 仍可在 MCP Servers 中继续编辑。"
        : "仓库内官方 manifest 池，支持 install / uninstall / enable / disable。"}
      actions={<MutationBadge mutation={actionMutation} successLabel="Market Updated" />}
    >
      <div className="space-y-3">
        {market.data?.manifests.map((manifest) => {
          const manifestId = String(manifest.id);
          const install = installs.find((item) => item.manifestId === manifestId);
          const installed = Boolean(install);
          const enabled = Boolean(install?.enabled);
          const configSchema =
            manifest.configSchema && typeof manifest.configSchema === "object"
              ? manifest.configSchema as Record<string, unknown>
              : {};
          const authConfig =
            configSchema.auth && typeof configSchema.auth === "object"
              ? configSchema.auth as Record<string, unknown>
              : {};
          const configNote =
            typeof authConfig.note === "string" && authConfig.note.trim().length > 0
              ? authConfig.note.trim()
              : null;

          return (
            <div key={manifestId} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div>
                    <p className="font-medium text-slate-900">{String(manifest.title)}</p>
                    <p className="text-sm text-slate-500">{String(manifest.description)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                    <Badge tone={installed ? "success" : "warning"}>
                      {installed ? "Installed" : "Not Installed"}
                    </Badge>
                    <Badge tone={enabled ? "success" : "neutral"}>
                      {enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </div>
                  <p className="text-xs text-slate-500">
                    Dependencies: {Array.isArray(manifest.dependencies) ? manifest.dependencies.join(", ") || "None" : "None"}
                  </p>
                  {configNote ? (
                    <p className="text-xs text-slate-500">
                      Auth: {configNote}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {!installed ? (
                    <Button
                      type="button"
                      onClick={() => actionMutation.mutate({ action: "install", id: manifestId })}
                    >
                      Install
                    </Button>
                  ) : null}
                  {installed ? (
                    <Button
                      type="button"
                      tone={enabled ? "secondary" : "primary"}
                      onClick={() =>
                        actionMutation.mutate({
                          action: enabled ? "disable" : "enable",
                          id: manifestId,
                        })
                      }
                    >
                      {enabled ? "Disable" : "Enable"}
                    </Button>
                  ) : null}
                  {installed ? (
                    <Button
                      type="button"
                      tone="ghost"
                      onClick={() => actionMutation.mutate({ action: "uninstall", id: manifestId })}
                    >
                      Uninstall
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
