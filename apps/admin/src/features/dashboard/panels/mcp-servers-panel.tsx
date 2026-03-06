import { useState } from "react";
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
  formatJson,
  parseArgs,
  parseJsonRecord,
  useMcpServers,
} from "../shared.js";

export function McpServersPanel() {
  const servers = useMcpServers();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState("");
  const [selectedServerId, setSelectedServerId] = useState("");
  const [inspection, setInspection] = useState<unknown>(null);
  const [form, setForm] = useState({
    label: "MCP Server",
    description: "",
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

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(editingId ? `/api/mcp/servers/${editingId}` : "/api/mcp/servers", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify({
          label: form.label,
          description: form.description,
          transport: form.transport,
          command: form.command || undefined,
          args: parseArgs(form.args),
          url: form.url || undefined,
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
    setForm({
      label: String(server.label ?? ""),
      description: String(server.description ?? ""),
      transport: String(server.transport ?? "stdio"),
      command: String(server.command ?? ""),
      args: Array.isArray(server.args) ? server.args.join("\n") : "",
      url: String(server.url ?? ""),
      envRefsJson: formatJson(server.envRefs ?? {}),
      headersJson: formatJson(server.headers ?? {}),
      restartPolicy: String(server.restartPolicy ?? "on-failure"),
      enabled: Boolean(server.enabled),
      source: String(server.source ?? "custom"),
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
      <Panel title="Configured MCP Servers" subtitle="支持 stdio / streamable_http、自定义 env refs、headers、healthcheck、tools 和 logs。已启用的 Alibaba Bailian manifest 会在这里自动同步市场里的 MCP 实例。">
        <div className="space-y-3">
          {servers.data?.map((server) => (
            <div key={String(server.id)} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-medium">{String(server.label)}</p>
                  <p className="text-sm text-slate-500">
                    {String(server.transport)} · {String(server.lastHealthStatus ?? "unknown")} · {String(server.source ?? "custom")}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    id={String(server.id ?? "")}
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
          title={editingId ? "Edit MCP Server" : "Add MCP Server"}
          subtitle="表单字段对齐 transport、command/url、args、env refs、headers、restart policy。"
          actions={<MutationBadge mutation={saveMutation} successLabel="MCP Saved" />}
        >
          <div className="grid gap-3">
            <Input value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} />
            <TextArea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />
            <Input value={form.transport} onChange={(event) => setForm((current) => ({ ...current, transport: event.target.value }))} placeholder="stdio | streamable_http" />
            <Input value={form.command} onChange={(event) => setForm((current) => ({ ...current, command: event.target.value }))} placeholder="uvx / npx / bunx" />
            <TextArea value={form.args} onChange={(event) => setForm((current) => ({ ...current, args: event.target.value }))} />
            <Input value={form.url} onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))} placeholder="https://example.com/mcp" />
            <TextArea value={form.envRefsJson} onChange={(event) => setForm((current) => ({ ...current, envRefsJson: event.target.value }))} />
            <TextArea value={form.headersJson} onChange={(event) => setForm((current) => ({ ...current, headersJson: event.target.value }))} />
            <Input value={form.restartPolicy} onChange={(event) => setForm((current) => ({ ...current, restartPolicy: event.target.value }))} placeholder="never | on-failure | always" />
            <Input value={form.source} onChange={(event) => setForm((current) => ({ ...current, source: event.target.value }))} placeholder="official | custom | bailian_market" />
            <CheckboxField label="Enabled" checked={form.enabled} onChange={(next) => setForm((current) => ({ ...current, enabled: next }))} />
            <div className="flex flex-wrap gap-3">
              <Button type="button" onClick={() => saveMutation.mutate()}>
                {editingId ? "Update MCP Server" : "Create MCP Server"}
              </Button>
              <Button
                type="button"
                tone="ghost"
                onClick={() => {
                  setEditingId("");
                  setForm({
                    label: "MCP Server",
                    description: "",
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
                }}
              >
                Reset Form
              </Button>
            </div>
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
