import {
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Badge,
  Button,
  Input,
  Panel,
} from "@pulsarbot/ui-kit";
import { apiFetch } from "../../../lib/api.js";
import { notificationOccurred } from "../../../lib/telegram.js";
import {
  type JsonRecord,
  CheckboxField,
  MutationBadge,
  useMcpProviderCatalog,
  useMcpProviders,
  useMcpServers,
} from "../shared.js";
import { MarketPanel } from "./market-panel.js";

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function isProviderServerAddable(server: JsonRecord) {
  return asString(server.protocol) === "streamable_http";
}

export function McpMarketPanel() {
  const providerCatalog = useMcpProviderCatalog();
  const providerConfigs = useMcpProviders();
  const mcpServers = useMcpServers();
  const queryClient = useQueryClient();
  const providerManifests = providerCatalog.data ?? [];
  const [selectedEntry, setSelectedEntry] = useState("marketplace");
  const selectedProviderManifest = providerManifests.find((item) =>
    `provider:${String(item.id ?? "")}` === selectedEntry
  );
  const selectedProviderConfig = useMemo(
    () => {
      if (!selectedProviderManifest) {
        return null;
      }
      return (providerConfigs.data ?? []).find((item) =>
        String(item.kind ?? "") === String(selectedProviderManifest.providerKind ?? "")
      ) ?? null;
    },
    [providerConfigs.data, selectedProviderManifest],
  );
  const [label, setLabel] = useState("Alibaba Bailian");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [accessTokenConfirmation, setAccessTokenConfirmation] = useState("");

  useEffect(() => {
    setLabel(asString(selectedProviderConfig?.label, asString(selectedProviderManifest?.title, "")));
    setEnabled(Boolean(selectedProviderConfig?.enabled ?? true));
    setApiKey("");
    setAccessTokenConfirmation("");
  }, [selectedProviderConfig, selectedProviderManifest]);

  const existingServerIds = new Set(
    (mcpServers.data ?? []).map((server) => asString(server.id)),
  );

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mcp-provider-catalog"] }),
      queryClient.invalidateQueries({ queryKey: ["mcp-providers"] }),
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
      queryClient.invalidateQueries({ queryKey: ["profiles"] }),
      queryClient.invalidateQueries({ queryKey: ["system-health"] }),
    ]);
  };

  const upsertProvider = async () => {
    if (!selectedProviderManifest) {
      throw new Error("No MCP provider selected");
    }
    return apiFetch<JsonRecord>(
      selectedProviderConfig
        ? `/api/mcp/providers/${encodeURIComponent(asString(selectedProviderConfig.id))}`
        : "/api/mcp/providers",
      {
        method: selectedProviderConfig ? "PUT" : "POST",
        body: JSON.stringify({
          label: label || asString(selectedProviderManifest.title, "MCP Provider"),
          kind: selectedProviderManifest.providerKind,
          enabled,
          apiKey: apiKey || undefined,
          accessToken: apiKey ? accessTokenConfirmation : undefined,
        }),
      },
    );
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const result = await upsertProvider();
      return result;
    },
    onSuccess: async () => {
      notificationOccurred("success");
      setApiKey("");
      setAccessTokenConfirmation("");
      await invalidateAll();
    },
    onError: () => notificationOccurred("error"),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!selectedProviderConfig) {
        throw new Error("MCP provider not found");
      }
      return apiFetch(`/api/mcp/providers/${encodeURIComponent(asString(selectedProviderConfig.id))}`, {
        method: "DELETE",
      });
    },
    onSuccess: async () => {
      notificationOccurred("success");
      setApiKey("");
      setAccessTokenConfirmation("");
      await invalidateAll();
    },
    onError: () => notificationOccurred("error"),
  });

  const fetchMutation = useMutation({
    mutationFn: async () => {
      const provider = await upsertProvider();
      const providerId = asString(provider.id);
      if (!providerId) {
        throw new Error("MCP provider id is missing");
      }
      return apiFetch<JsonRecord>(`/api/mcp/providers/${encodeURIComponent(providerId)}/fetch`, {
        method: "POST",
      });
    },
    onSuccess: async () => {
      notificationOccurred("success");
      setApiKey("");
      setAccessTokenConfirmation("");
      await invalidateAll();
    },
    onError: () => notificationOccurred("error"),
  });

  const addServerMutation = useMutation({
    mutationFn: async (remoteId: string) => {
      if (!selectedProviderConfig) {
        throw new Error("MCP provider not found");
      }
      return apiFetch<JsonRecord>(
        `/api/mcp/providers/${encodeURIComponent(asString(selectedProviderConfig.id))}/servers`,
        {
          method: "POST",
          body: JSON.stringify({ remoteId }),
        },
      );
    },
    onSuccess: async () => {
      notificationOccurred("success");
      await invalidateAll();
    },
    onError: () => notificationOccurred("error"),
  });

  const providerServers = Array.isArray(selectedProviderConfig?.catalogCache)
    ? selectedProviderConfig.catalogCache as JsonRecord[]
    : [];

  return (
    <div className="grid gap-6 xl:grid-cols-[260px,1fr]">
      <Panel title="MCP Market" subtitle="先选择 MCP 分类，再决定是启用官方 marketplace 条目，还是通过 MCP provider 拉取远端服务。">
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Discovery</p>
            <button
              type="button"
              onClick={() => setSelectedEntry("marketplace")}
              className="w-full rounded-2xl border px-4 py-3 text-left text-sm"
            >
              MCP Marketplace
            </button>
          </div>
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Providers</p>
            {providerManifests.map((manifest) => {
              const key = `provider:${String(manifest.id ?? "")}`;
              const config = (providerConfigs.data ?? []).find((item) =>
                String(item.kind ?? "") === String(manifest.providerKind ?? "")
              );
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedEntry(key)}
                  className="flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left text-sm"
                >
                  <span>{String(manifest.title ?? manifest.id ?? "")}</span>
                  <Badge tone={config ? "success" : "neutral"}>
                    {config ? "Configured" : "Setup"}
                  </Badge>
                </button>
              );
            })}
          </div>
        </div>
      </Panel>

      {selectedEntry === "marketplace" ? (
        <MarketPanel kind="mcp" />
      ) : selectedProviderManifest ? (
        <div className="grid gap-6">
          <Panel
            title={asString(selectedProviderManifest.title, "MCP Provider")}
            subtitle={asString(selectedProviderManifest.description)}
            actions={<MutationBadge mutation={saveMutation} successLabel="Provider Saved" />}
          >
            <div className="grid gap-3">
              <Input value={label} onChange={(event) => setLabel(event.target.value)} />
              <Input
                type="password"
                placeholder={selectedProviderConfig ? "Leave blank to keep existing API key" : "API key"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <Input
                type="password"
                placeholder="Access token confirmation"
                value={accessTokenConfirmation}
                onChange={(event) => setAccessTokenConfirmation(event.target.value)}
              />
              <CheckboxField label="Provider Enabled" checked={enabled} onChange={setEnabled} />
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  disabled={Boolean(apiKey) && !accessTokenConfirmation}
                  onClick={() => saveMutation.mutate()}
                >
                  {selectedProviderConfig ? "Update Provider" : "Create Provider"}
                </Button>
                <Button
                  type="button"
                  tone="secondary"
                  disabled={Boolean(apiKey) && !accessTokenConfirmation}
                  onClick={() => fetchMutation.mutate()}
                >
                  Fetch Servers
                </Button>
                {selectedProviderConfig ? (
                  <Button type="button" tone="ghost" onClick={() => deleteMutation.mutate()}>
                    Delete Provider
                  </Button>
                ) : null}
              </div>
              {selectedProviderConfig ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                  <p>Status: {asString(selectedProviderConfig.lastFetchStatus, "idle")}</p>
                  <p>Last Fetched: {asString(selectedProviderConfig.lastFetchedAt, "-")}</p>
                  <p>Error: {asString(selectedProviderConfig.lastFetchError, "-")}</p>
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel
            title="Fetched MCP Servers"
            subtitle="拉取到的远端服务需要逐条加入本地 MCP Servers；加入后会自动挂到当前 active profile。当前仅支持 streamable_http。"
            actions={<MutationBadge mutation={fetchMutation} successLabel="Fetched" />}
          >
            <div className="space-y-3">
              {providerServers.length > 0 ? providerServers.map((server) => {
                const serverId = asString(server.serverId);
                const addable = isProviderServerAddable(server);
                const alreadyAdded = existingServerIds.has(serverId);
                return (
                  <div key={serverId} className="rounded-2xl border border-slate-200 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="font-medium text-slate-900">{asString(server.label, serverId)}</p>
                        <p className="text-sm text-slate-500">{asString(server.description, "")}</p>
                        <p className="mt-2 text-xs text-slate-500">
                          {asString(server.protocol, "unknown")} · {asString(server.operationalUrl, "")}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={Boolean(server.active) ? "success" : "warning"}>
                          {Boolean(server.active) ? "Active" : "Inactive"}
                        </Badge>
                        <Badge tone={addable ? "neutral" : "warning"}>
                          {addable ? "Supported" : "Unsupported"}
                        </Badge>
                        <Button
                          type="button"
                          tone={alreadyAdded ? "ghost" : "primary"}
                          disabled={alreadyAdded || !addable || addServerMutation.isPending}
                          onClick={() => addServerMutation.mutate(asString(server.remoteId))}
                        >
                          {alreadyAdded ? "Added" : "Add Server"}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              }) : (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
                  <p className="font-medium text-slate-900">No provider servers fetched yet.</p>
                  <p className="mt-1 text-sm text-slate-600">
                    保存 API key 后点击 <span className="font-medium">Fetch Servers</span>，再把需要的条目逐个加入本地 MCP Servers。
                  </p>
                </div>
              )}
            </div>
          </Panel>
        </div>
      ) : (
        <Panel title="MCP Provider" subtitle="No provider selected." />
      )}
    </div>
  );
}
