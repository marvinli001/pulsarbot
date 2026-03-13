import {
  useEffect,
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
  TextArea,
} from "@pulsarbot/ui-kit";
import { apiFetch } from "../../../lib/api.js";
import {
  notificationOccurred,
  selectionChanged,
  useTelegramMainButton,
} from "../../../lib/telegram.js";
import {
  type JsonRecord,
  CheckboxField,
  JsonPanel,
  MutationBadge,
  ResourceSelectField,
  SelectField,
  formatJson,
  parseArgs,
  parseJsonRecord,
  useMarket,
  useMcpProviders,
  useMcpServers,
} from "../shared.js";

type McpPreset =
  | "custom_stdio"
  | "custom_streamable_http"
  | "official"
  | "provider_bailian";

export function McpServersPanel() {
  const servers = useMcpServers();
  const market = useMarket("mcp");
  const mcpProviders = useMcpProviders();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState("");
  const [selectedServerId, setSelectedServerId] = useState("");
  const [inspection, setInspection] = useState<unknown>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [form, setForm] = useState({
    label: "MCP Server",
    description: "",
    preset: "custom_stdio" as McpPreset,
    manifestId: "",
    providerId: "",
    transport: "stdio",
    command: "uvx",
    args: "exa-mcp",
    url: "",
    envRefsJson: "{}",
    headersJson: "{}",
    restartPolicy: "on-failure",
    enabled: false,
    source: "custom",
  });

  const applyPreset = (preset: McpPreset) => {
    setForm((current) => {
      if (preset === "custom_stdio") {
        return {
          ...current,
          preset,
          transport: "stdio",
          command: current.command || "uvx",
          url: "",
          source: "custom",
          manifestId: "",
          providerId: "",
        };
      }
      if (preset === "custom_streamable_http") {
        return {
          ...current,
          preset,
          transport: "streamable_http",
          command: "",
          args: "",
          source: "custom",
          manifestId: "",
          providerId: "",
        };
      }
      if (preset === "provider_bailian") {
        return {
          ...current,
          preset,
          transport: "streamable_http",
          command: "",
          args: "",
          source: "provider",
          manifestId: "",
        };
      }
      return {
        ...current,
        preset,
        source: "official",
        providerId: "",
      };
    });
  };

  useEffect(() => {
    if (form.preset !== "official" || !form.manifestId) {
      return;
    }
    const manifest = (market.data?.manifests ?? []).find((item) => item.id === form.manifestId);
    if (!manifest) {
      return;
    }
    setForm((current) => ({
      ...current,
      label: String(manifest.title ?? current.label),
      description: String(manifest.description ?? current.description),
      transport: String(manifest.transport ?? current.transport),
      command: String(manifest.command ?? current.command ?? ""),
      args: Array.isArray(manifest.args) ? manifest.args.join("\n") : current.args,
      url: String(manifest.url ?? current.url ?? ""),
      source: "official",
    }));
  }, [form.manifestId, form.preset, market.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(editingId ? `/api/mcp/servers/${editingId}` : "/api/mcp/servers", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify({
          label: form.label,
          description: form.description,
          manifestId: form.preset === "official" ? form.manifestId || null : null,
          providerId: form.preset === "provider_bailian" ? form.providerId || null : null,
          providerKind: form.preset === "provider_bailian" ? "bailian" : null,
          transport: form.transport,
          command: form.transport === "stdio" ? form.command || undefined : undefined,
          args: form.transport === "stdio" ? parseArgs(form.args) : [],
          url: form.transport === "streamable_http" ? form.url || undefined : undefined,
          envRefs: parseJsonRecord(form.envRefsJson),
          headers: parseJsonRecord(form.headersJson),
          restartPolicy: form.restartPolicy,
          enabled: form.enabled,
          source: form.source,
        }),
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/mcp/servers/${id}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/mcp/servers/${id}/test`, {
        method: "POST",
      }),
    onSuccess: (data, id) => {
      notificationOccurred("success");
      setSelectedServerId(id);
      setInspection(data);
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const toolsMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/mcp/servers/${id}/tools`),
    onSuccess: (data, id) => {
      notificationOccurred("success");
      setSelectedServerId(id);
      setInspection(data);
    },
    onError: () => notificationOccurred("error"),
  });

  const logsMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/mcp/servers/${id}/logs`),
    onSuccess: (data, id) => {
      notificationOccurred("success");
      setSelectedServerId(id);
      setInspection(data);
    },
    onError: () => notificationOccurred("error"),
  });

  const loadServer = (server: JsonRecord) => {
    selectionChanged();
    setEditingId(String(server.id ?? ""));
    const source = String(server.source ?? "custom");
    setForm({
      label: String(server.label ?? ""),
      description: String(server.description ?? ""),
      preset: source === "official"
        ? "official"
        : source === "provider"
          ? "provider_bailian"
          : String(server.transport) === "streamable_http"
            ? "custom_streamable_http"
            : "custom_stdio",
      manifestId: String(server.manifestId ?? ""),
      providerId: String(server.providerId ?? ""),
      transport: String(server.transport ?? "stdio"),
      command: String(server.command ?? ""),
      args: Array.isArray(server.args) ? server.args.join("\n") : "",
      url: String(server.url ?? ""),
      envRefsJson: formatJson(server.envRefs ?? {}),
      headersJson: formatJson(server.headers ?? {}),
      restartPolicy: String(server.restartPolicy ?? "on-failure"),
      enabled: Boolean(server.enabled),
      source,
    });
  };

  useTelegramMainButton({
    text: editingId ? "Update MCP Server" : "Create MCP Server",
    isVisible: true,
    isEnabled: !saveMutation.isPending,
    isProgressVisible: saveMutation.isPending,
    onClick: () => saveMutation.mutate(),
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
      <Panel title="Configured MCP Servers" subtitle="已保存的 MCP server；向导默认只暴露 preset 所需字段。">
        <div className="space-y-3">
          {servers.data?.map((server) => (
            <div key={String(server.id)} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-medium">{String(server.label)}</p>
                  <p className="text-sm text-slate-500">
                    {String(server.transport)} · {String(server.lastHealthStatus ?? "unknown")} · {String(server.source ?? "custom")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={Boolean(server.enabled) ? "success" : "warning"}>
                    {Boolean(server.enabled) ? "Enabled" : "Disabled"}
                  </Badge>
                  <Button type="button" tone="ghost" onClick={() => loadServer(server)}>
                    Load
                  </Button>
                  <Button type="button" tone="secondary" onClick={() => testMutation.mutate(String(server.id))}>
                    Test
                  </Button>
                  <Button type="button" tone="secondary" onClick={() => toolsMutation.mutate(String(server.id))}>
                    Tools
                  </Button>
                  <Button type="button" tone="secondary" onClick={() => logsMutation.mutate(String(server.id))}>
                    Logs
                  </Button>
                  <Button type="button" tone="ghost" onClick={() => deleteMutation.mutate(String(server.id))}>
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid gap-6">
        <Panel
          title={editingId ? "MCP Wizard" : "Add MCP via Wizard"}
          subtitle="官方模板、Bailian provider、通用 stdio、通用 streamable HTTP 都走 preset 驱动；高级字段默认收起。"
          actions={<MutationBadge mutation={saveMutation} successLabel="MCP Saved" />}
        >
          <div className="grid gap-3">
            <ResourceSelectField
              label="Preset"
              hint="先选择你想接入的 MCP 类型。"
              value={form.preset}
              onChange={(next) => applyPreset(next as McpPreset)}
              options={[
                { value: "custom_stdio", label: "Generic stdio" },
                { value: "custom_streamable_http", label: "Generic streamable HTTP" },
                { value: "official", label: "Official market template" },
                { value: "provider_bailian", label: "Bailian provider-backed" },
              ]}
            />
            {form.preset === "official" ? (
              <ResourceSelectField
                label="Official Template"
                hint="从官方 market manifest 自动填充 transport、command/url 和默认描述。"
                value={form.manifestId}
                onChange={(next) => setForm((current) => ({ ...current, manifestId: next }))}
                options={[
                  { value: "", label: "Select manifest" },
                  ...(market.data?.manifests ?? []).map((manifest) => ({
                    value: String(manifest.id ?? ""),
                    label: String(manifest.title ?? manifest.id ?? ""),
                  })),
                ]}
              />
            ) : null}
            {form.preset === "provider_bailian" ? (
              <ResourceSelectField
                label="MCP Provider"
                hint="选择已经配置好的 provider-backed MCP provider。"
                value={form.providerId}
                onChange={(next) => setForm((current) => ({ ...current, providerId: next, url: current.url || "https://dashscope.aliyuncs.com/api/v1/mcps" }))}
                options={[
                  { value: "", label: "Select MCP provider" },
                  ...(mcpProviders.data ?? []).map((provider) => ({
                    value: String(provider.id ?? ""),
                    label: String(provider.label ?? provider.id ?? ""),
                  })),
                ]}
              />
            ) : null}

            <Input value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} placeholder="MCP label" />
            <TextArea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />

            {form.transport === "stdio" ? (
              <>
                <Input value={form.command} onChange={(event) => setForm((current) => ({ ...current, command: event.target.value }))} placeholder="Command" />
                <TextArea value={form.args} onChange={(event) => setForm((current) => ({ ...current, args: event.target.value }))} placeholder="One arg per line" />
              </>
            ) : null}
            {form.transport === "streamable_http" ? (
              <Input value={form.url} onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))} placeholder="https://example.com/mcp" />
            ) : null}

            <CheckboxField label="Enabled" checked={form.enabled} onChange={(next) => setForm((current) => ({ ...current, enabled: next }))} />

            <div className="flex flex-wrap gap-3">
              <Button type="button" onClick={() => saveMutation.mutate()}>
                {editingId ? "Update MCP Server" : "Create MCP Server"}
              </Button>
              <Button type="button" tone="ghost" onClick={() => {
                setEditingId("");
                setAdvancedOpen(false);
                setForm({
                  label: "MCP Server",
                  description: "",
                  preset: "custom_stdio",
                  manifestId: "",
                  providerId: "",
                  transport: "stdio",
                  command: "uvx",
                  args: "exa-mcp",
                  url: "",
                  envRefsJson: "{}",
                  headersJson: "{}",
                  restartPolicy: "on-failure",
                  enabled: false,
                  source: "custom",
                });
              }}>
                Reset Form
              </Button>
              <Button type="button" tone="ghost" onClick={() => setAdvancedOpen((current) => !current)}>
                {advancedOpen ? "Hide Advanced" : "Show Advanced"}
              </Button>
            </div>

            {advancedOpen ? (
              <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <SelectField
                  value={form.restartPolicy}
                  onChange={(next) => setForm((current) => ({ ...current, restartPolicy: next }))}
                  options={[
                    { value: "never", label: "never" },
                    { value: "on-failure", label: "on-failure" },
                    { value: "always", label: "always" },
                  ]}
                />
                <TextArea value={form.envRefsJson} onChange={(event) => setForm((current) => ({ ...current, envRefsJson: event.target.value }))} />
                <TextArea value={form.headersJson} onChange={(event) => setForm((current) => ({ ...current, headersJson: event.target.value }))} />
              </div>
            ) : null}
          </div>
        </Panel>

        <JsonPanel
          title="Selected MCP Inspection"
          subtitle={selectedServerId ? `最近查看的 MCP server: ${selectedServerId}` : "测试 / 工具发现 / 日志检查结果会显示在这里。"}
          value={inspection ?? {}}
          actions={<div className="flex gap-2"><MutationBadge mutation={testMutation} successLabel="Health OK" /><MutationBadge mutation={toolsMutation} successLabel="Tools Loaded" /><MutationBadge mutation={logsMutation} successLabel="Logs Loaded" /></div>}
        />
      </div>
    </div>
  );
}
