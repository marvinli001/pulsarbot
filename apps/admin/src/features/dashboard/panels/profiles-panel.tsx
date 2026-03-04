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
  CheckboxListField,
  JsonPanel,
  MutationBadge,
  ResourceSelectField,
  useMarket,
  useMcpServers,
  useProfiles,
  useProviders,
  useRuntimePreview,
} from "../shared.js";

export function ProfilesPanel() {
  const profiles = useProfiles();
  const providers = useProviders();
  const skillsMarket = useMarket("skills");
  const pluginsMarket = useMarket("plugins");
  const mcpServers = useMcpServers();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState({
    label: "balanced",
    description: "",
    systemPrompt:
      "You are Pulsarbot, a Telegram-native personal agent with tools, memory, and concise answers.",
    primaryModelProfileId: "",
    backgroundModelProfileId: "",
    embeddingModelProfileId: "",
    enabledSkillIds: ["core-agent", "memory-core"],
    enabledPluginIds: [
      "time-context",
      "native-google-search",
      "native-bing-search",
      "web-browse-fetcher",
      "document-processor",
    ],
    enabledMcpServerIds: [] as string[],
    maxPlanningSteps: "8",
    maxToolCalls: "6",
    maxTurnDurationMs: "30000",
    maxToolDurationMs: "15000",
    compactSoftThreshold: "0.7",
    compactHardThreshold: "0.85",
    allowNetworkTools: true,
    allowWriteTools: true,
    allowMcpTools: true,
  });

  useEffect(() => {
    if (!form.primaryModelProfileId && providers.data?.[0]?.id) {
      setForm((current) => ({
        ...current,
        primaryModelProfileId: String(providers.data?.[0]?.id ?? ""),
      }));
    }
  }, [form.primaryModelProfileId, providers.data]);

  const runtimePreview = useRuntimePreview(editingId);

  const providerOptions = [
    { value: "", label: "Select provider" },
    ...(providers.data ?? []).map((provider) => ({
      value: String(provider.id ?? ""),
      label: `${String(provider.label ?? "Provider")} · ${String(provider.kind ?? "unknown")}`,
    })),
  ];
  const skillOptions = (skillsMarket.data?.manifests ?? [])
    .filter((manifest) =>
      (skillsMarket.data?.installs ?? []).some(
        (install) =>
          install.manifestId === manifest.id &&
          Boolean(install.enabled),
      )
    )
    .map((manifest) => ({
      value: String(manifest.id ?? ""),
      label: String(manifest.title ?? manifest.id ?? ""),
      caption: String(manifest.description ?? ""),
    }));
  const pluginOptions = (pluginsMarket.data?.manifests ?? [])
    .filter((manifest) =>
      (pluginsMarket.data?.installs ?? []).some(
        (install) =>
          install.manifestId === manifest.id &&
          Boolean(install.enabled),
      )
    )
    .map((manifest) => ({
      value: String(manifest.id ?? ""),
      label: String(manifest.title ?? manifest.id ?? ""),
      caption: String(manifest.description ?? ""),
    }));
  const mcpOptions = (mcpServers.data ?? [])
    .filter((server) => Boolean(server.enabled))
    .map((server) => ({
      value: String(server.id ?? ""),
      label: `${String(server.label ?? server.id ?? "")} · ${String(server.transport ?? "unknown")}`,
      caption: String(server.description ?? ""),
    }));

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(editingId ? `/api/agent-profiles/${editingId}` : "/api/agent-profiles", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify({
          label: form.label,
          description: form.description,
          systemPrompt: form.systemPrompt,
          primaryModelProfileId: form.primaryModelProfileId,
          backgroundModelProfileId: form.backgroundModelProfileId || null,
          embeddingModelProfileId: form.embeddingModelProfileId || null,
          enabledSkillIds: form.enabledSkillIds,
          enabledPluginIds: form.enabledPluginIds,
          enabledMcpServerIds: form.enabledMcpServerIds,
          maxPlanningSteps: Number(form.maxPlanningSteps || "8"),
          maxToolCalls: Number(form.maxToolCalls || "6"),
          maxTurnDurationMs: Number(form.maxTurnDurationMs || "30000"),
          maxToolDurationMs: Number(form.maxToolDurationMs || "15000"),
          compactSoftThreshold: Number(form.compactSoftThreshold || "0.7"),
          compactHardThreshold: Number(form.compactHardThreshold || "0.85"),
          allowNetworkTools: form.allowNetworkTools,
          allowWriteTools: form.allowWriteTools,
          allowMcpTools: form.allowMcpTools,
        }),
      }),
    onSuccess: async (data) => {
      notificationOccurred("success");
      if (data && typeof data === "object" && "id" in data) {
        setEditingId(String((data as JsonRecord).id ?? ""));
      }
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      await queryClient.invalidateQueries({ queryKey: ["runtime-preview"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/agent-profiles/${id}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const loadProfile = (profile: JsonRecord) => {
    selectionChanged();
    setEditingId(String(profile.id ?? ""));
    setForm({
      label: String(profile.label ?? ""),
      description: String(profile.description ?? ""),
      systemPrompt: String(profile.systemPrompt ?? ""),
      primaryModelProfileId: String(profile.primaryModelProfileId ?? ""),
      backgroundModelProfileId: String(profile.backgroundModelProfileId ?? ""),
      embeddingModelProfileId: String(profile.embeddingModelProfileId ?? ""),
      enabledSkillIds: Array.isArray(profile.enabledSkillIds)
        ? profile.enabledSkillIds.map((item) => String(item))
        : [],
      enabledPluginIds: Array.isArray(profile.enabledPluginIds)
        ? profile.enabledPluginIds.map((item) => String(item))
        : [],
      enabledMcpServerIds: Array.isArray(profile.enabledMcpServerIds)
        ? profile.enabledMcpServerIds.map((item) => String(item))
        : [],
      maxPlanningSteps: String(profile.maxPlanningSteps ?? "8"),
      maxToolCalls: String(profile.maxToolCalls ?? "6"),
      maxTurnDurationMs: String(profile.maxTurnDurationMs ?? "30000"),
      maxToolDurationMs: String(profile.maxToolDurationMs ?? "15000"),
      compactSoftThreshold: String(profile.compactSoftThreshold ?? "0.7"),
      compactHardThreshold: String(profile.compactHardThreshold ?? "0.85"),
      allowNetworkTools: Boolean(profile.allowNetworkTools),
      allowWriteTools: Boolean(profile.allowWriteTools),
      allowMcpTools: Boolean(profile.allowMcpTools),
    });
  };

  useTelegramMainButton({
    text: editingId ? "Update Profile" : "Create Profile",
    isVisible: true,
    isEnabled: !saveMutation.isPending,
    isProgressVisible: saveMutation.isPending,
    onClick: () => saveMutation.mutate(),
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
      <Panel title="Agent Profiles" subtitle="真正控制 planner、tool、compact、权限边界的运行时 profile。">
        <div className="space-y-3">
          {profiles.data?.map((profile) => (
            <div key={String(profile.id)} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-medium">{String(profile.label)}</p>
                  <p className="text-sm text-slate-500">{String(profile.description ?? "")}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    primary={String(profile.primaryModelProfileId ?? "")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="neutral">
                    {Array.isArray(profile.enabledSkillIds)
                      ? `${profile.enabledSkillIds.length} skills`
                      : "0 skills"}
                  </Badge>
                  <Button type="button" tone="ghost" onClick={() => loadProfile(profile)}>
                    Load
                  </Button>
                  <Button
                    type="button"
                    tone="ghost"
                    onClick={() => deleteMutation.mutate(String(profile.id))}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Panel>
      <Panel
        title={editingId ? "Edit Profile" : "Create Profile"}
        subtitle="通过已安装的 skills / plugins / MCP servers 选择真实运行时能力，而不是手填内部 ID。"
        actions={<MutationBadge mutation={saveMutation} successLabel="Profile Saved" />}
      >
        <div className="grid gap-3">
          <Input value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} />
          <Input value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />
          <TextArea value={form.systemPrompt} onChange={(event) => setForm((current) => ({ ...current, systemPrompt: event.target.value }))} />
          <ResourceSelectField
            label="Primary Provider"
            hint="主对话模型。"
            value={form.primaryModelProfileId}
            onChange={(next) => setForm((current) => ({ ...current, primaryModelProfileId: next }))}
            options={providerOptions}
          />
          <ResourceSelectField
            label="Background Provider"
            hint="用于 compact、summary、后台任务。"
            value={form.backgroundModelProfileId}
            onChange={(next) => setForm((current) => ({ ...current, backgroundModelProfileId: next }))}
            options={[{ value: "", label: "No background provider" }, ...providerOptions.filter((option) => option.value)]}
          />
          <ResourceSelectField
            label="Embedding Provider"
            hint="可选。未配置时会继续走本地 hash embedding 回退。"
            value={form.embeddingModelProfileId}
            onChange={(next) => setForm((current) => ({ ...current, embeddingModelProfileId: next }))}
            options={[{ value: "", label: "No embedding provider" }, ...providerOptions.filter((option) => option.value)]}
          />
          <CheckboxListField
            label="Enabled Skills"
            hint="只显示已安装且已启用的 skills。"
            options={skillOptions}
            values={form.enabledSkillIds}
            onChange={(next) => setForm((current) => ({ ...current, enabledSkillIds: next }))}
          />
          <CheckboxListField
            label="Enabled Plugins"
            hint="只显示已安装且已启用的 plugins。"
            options={pluginOptions}
            values={form.enabledPluginIds}
            onChange={(next) => setForm((current) => ({ ...current, enabledPluginIds: next }))}
          />
          <CheckboxListField
            label="Enabled MCP Servers"
            hint="只显示已保存且启用的 MCP server。"
            options={mcpOptions}
            values={form.enabledMcpServerIds}
            onChange={(next) => setForm((current) => ({ ...current, enabledMcpServerIds: next }))}
          />
          <div className="grid gap-3 md:grid-cols-2">
            <Input value={form.maxPlanningSteps} onChange={(event) => setForm((current) => ({ ...current, maxPlanningSteps: event.target.value }))} placeholder="max planning steps" />
            <Input value={form.maxToolCalls} onChange={(event) => setForm((current) => ({ ...current, maxToolCalls: event.target.value }))} placeholder="max tool calls" />
            <Input value={form.maxTurnDurationMs} onChange={(event) => setForm((current) => ({ ...current, maxTurnDurationMs: event.target.value }))} placeholder="max turn duration ms" />
            <Input value={form.maxToolDurationMs} onChange={(event) => setForm((current) => ({ ...current, maxToolDurationMs: event.target.value }))} placeholder="max tool duration ms" />
            <Input value={form.compactSoftThreshold} onChange={(event) => setForm((current) => ({ ...current, compactSoftThreshold: event.target.value }))} placeholder="compact soft threshold" />
            <Input value={form.compactHardThreshold} onChange={(event) => setForm((current) => ({ ...current, compactHardThreshold: event.target.value }))} placeholder="compact hard threshold" />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <CheckboxField label="Allow Network Tools" checked={form.allowNetworkTools} onChange={(next) => setForm((current) => ({ ...current, allowNetworkTools: next }))} />
            <CheckboxField label="Allow Write Tools" checked={form.allowWriteTools} onChange={(next) => setForm((current) => ({ ...current, allowWriteTools: next }))} />
            <CheckboxField label="Allow MCP Tools" checked={form.allowMcpTools} onChange={(next) => setForm((current) => ({ ...current, allowMcpTools: next }))} />
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={() => saveMutation.mutate()}>
              {editingId ? "Update Profile" : "Create Profile"}
            </Button>
            <Button
              type="button"
              tone="ghost"
              onClick={() => {
                setEditingId("");
                setForm({
                  label: "balanced",
                  description: "",
                  systemPrompt:
                    "You are Pulsarbot, a Telegram-native personal agent with tools, memory, and concise answers.",
                  primaryModelProfileId: "",
                  backgroundModelProfileId: "",
                  embeddingModelProfileId: "",
                  enabledSkillIds: ["core-agent", "memory-core"],
                  enabledPluginIds: [
                    "time-context",
                    "native-google-search",
                    "native-bing-search",
                    "web-browse-fetcher",
                    "document-processor",
                  ],
                  enabledMcpServerIds: [],
                  maxPlanningSteps: "8",
                  maxToolCalls: "6",
                  maxTurnDurationMs: "30000",
                  maxToolDurationMs: "15000",
                  compactSoftThreshold: "0.7",
                  compactHardThreshold: "0.85",
                  allowNetworkTools: true,
                  allowWriteTools: true,
                  allowMcpTools: true,
                });
              }}
            >
              Reset Form
            </Button>
          </div>
        </div>
      </Panel>
      {editingId ? (
        <JsonPanel
          title="Runtime Preview"
          subtitle="当前 profile 在运行时真正会启用的 prompt fragments、tools、MCP 和 blocked reasons。"
          value={runtimePreview.data ?? {}}
          actions={<MutationBadge mutation={saveMutation} successLabel="Saved" />}
        />
      ) : null}
    </div>
  );
}
