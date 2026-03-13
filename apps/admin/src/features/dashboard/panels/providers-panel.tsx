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
  type ProviderCapabilityTestResponse,
  type ProviderKindOption,
  type ProviderTestCapability,
  CheckboxField,
  JsonPanel,
  MutationBadge,
  ProviderCapabilityTestSummary,
  SelectField,
  formatJson,
  parseJsonRecord,
  providerKindOptions,
  providerKindTemplates,
  reasoningLevelOptions,
  thinkingBudgetOptionsForProvider,
  useProviders,
} from "../shared.js";

function normalizeReasoningLevel(value: unknown): "off" | "low" | "medium" | "high" {
  const normalized = String(value ?? "off").toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return "off";
}

function buildProviderDraftFingerprint(args: {
  editingId: string;
  form: Record<string, unknown>;
}) {
  return JSON.stringify({
    editingId: args.editingId || "new",
    ...args.form,
  });
}

export function ProvidersPanel() {
  const providers = useProviders();
  const queryClient = useQueryClient();
  const defaultTemplate = providerKindTemplates.openai;
  const [editingId, setEditingId] = useState("");
  const [accessTokenConfirmation, setAccessTokenConfirmation] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [validatedFingerprint, setValidatedFingerprint] = useState("");
  const [providerTestResults, setProviderTestResults] = useState<
    Record<string, ProviderCapabilityTestResponse>
  >({});
  const [activeProviderTest, setActiveProviderTest] = useState<{
    providerId: string;
    capabilities: ProviderTestCapability[];
  } | null>(null);
  const [form, setForm] = useState({
    label: defaultTemplate.label,
    kind: "openai" as ProviderKindOption,
    apiBaseUrl: defaultTemplate.apiBaseUrl,
    defaultModel: defaultTemplate.defaultModel,
    visionModel: defaultTemplate.visionModel,
    audioModel: defaultTemplate.audioModel,
    documentModel: defaultTemplate.documentModel,
    apiKey: "",
    stream: defaultTemplate.stream,
    reasoningEnabled: false,
    reasoningLevel: "off",
    thinkingBudget: "auto",
    temperature: "0.2",
    topP: "",
    maxOutputTokens: "2048",
    toolCallingEnabled: defaultTemplate.toolCallingEnabled,
    jsonModeEnabled: defaultTemplate.jsonModeEnabled,
    visionEnabled: defaultTemplate.visionEnabled,
    audioInputEnabled: defaultTemplate.audioInputEnabled,
    documentInputEnabled: defaultTemplate.documentInputEnabled,
    enabled: true,
    headersJson: "{}",
    extraBodyJson: "{}",
  });
  const [testResult, setTestResult] = useState<unknown>(null);

  const applyProviderKindTemplate = (nextKind: ProviderKindOption) => {
    setForm((current) => {
      const previousTemplate = providerKindTemplates[current.kind];
      const nextTemplate = providerKindTemplates[nextKind];
      const replaceLabel =
        current.label.trim().length === 0 ||
        current.label === previousTemplate.label;

      return {
        ...current,
        kind: nextKind,
        label: replaceLabel ? nextTemplate.label : current.label,
        apiBaseUrl: nextTemplate.apiBaseUrl,
        defaultModel: nextTemplate.defaultModel,
        visionModel: nextTemplate.visionModel,
        audioModel: nextTemplate.audioModel,
        documentModel: nextTemplate.documentModel,
        stream: nextTemplate.stream,
        toolCallingEnabled: nextTemplate.toolCallingEnabled,
        jsonModeEnabled: nextTemplate.jsonModeEnabled,
        visionEnabled: nextTemplate.visionEnabled,
        audioInputEnabled: nextTemplate.audioInputEnabled,
        documentInputEnabled: nextTemplate.documentInputEnabled,
      };
    });
    setValidatedFingerprint("");
  };

  const currentFingerprint = buildProviderDraftFingerprint({
    editingId,
    form,
  });

  const buildDraftPayload = () => ({
    ...(editingId ? { id: editingId } : {}),
    label: form.label,
    kind: form.kind,
    apiBaseUrl: form.apiBaseUrl,
    defaultModel: form.defaultModel,
    visionModel: form.visionModel || null,
    audioModel: form.audioModel || null,
    documentModel: form.documentModel || null,
    apiKey: form.apiKey || undefined,
    stream: form.stream,
    reasoningEnabled: form.reasoningEnabled,
    reasoningLevel: form.reasoningLevel,
    thinkingBudget: form.thinkingBudget === "auto" ? null : Number(form.thinkingBudget),
    temperature: Number(form.temperature || "0.2"),
    topP: form.topP ? Number(form.topP) : null,
    maxOutputTokens: Number(form.maxOutputTokens || "2048"),
    toolCallingEnabled: form.toolCallingEnabled,
    jsonModeEnabled: form.jsonModeEnabled,
    visionEnabled: form.visionEnabled,
    audioInputEnabled: form.audioInputEnabled,
    documentInputEnabled: form.documentInputEnabled,
    enabled: form.enabled,
    headers: parseJsonRecord(form.headersJson),
    extraBody: parseJsonRecord(form.extraBodyJson),
  });

  const draftTestMutation = useMutation({
    mutationFn: (capabilities: ProviderTestCapability[]) =>
      apiFetch<ProviderCapabilityTestResponse>("/api/providers/test-draft", {
        method: "POST",
        body: JSON.stringify({
          ...buildDraftPayload(),
          capabilities,
        }),
      }),
    onSuccess: (data) => {
      notificationOccurred("success");
      setValidatedFingerprint(currentFingerprint);
      setTestResult(data);
    },
    onError: () => notificationOccurred("error"),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(editingId ? `/api/providers/${editingId}` : "/api/providers", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify({
          ...buildDraftPayload(),
          accessToken: form.apiKey ? accessTokenConfirmation : undefined,
        }),
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
      setForm((current) => ({ ...current, apiKey: "" }));
      setAccessTokenConfirmation("");
      setValidatedFingerprint(currentFingerprint);
    },
    onError: () => notificationOccurred("error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/providers/${id}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
      if (editingId) {
        setEditingId("");
      }
      setAccessTokenConfirmation("");
      setValidatedFingerprint("");
    },
    onError: () => notificationOccurred("error"),
  });

  const testMutation = useMutation({
    mutationFn: (args: {
      id: string;
      capabilities: ProviderTestCapability[];
    }) =>
      apiFetch(`/api/providers/${args.id}/test`, {
        method: "POST",
        body: JSON.stringify({
          capabilities: args.capabilities,
        }),
      }),
    onMutate: (variables) => {
      setActiveProviderTest({
        providerId: variables.id,
        capabilities: variables.capabilities,
      });
    },
    onSuccess: (data, variables) => {
      notificationOccurred("success");
      setTestResult(data);
      setProviderTestResults((current) => ({
        ...current,
        [variables.id]: data as ProviderCapabilityTestResponse,
      }));
    },
    onError: () => notificationOccurred("error"),
    onSettled: () => {
      setActiveProviderTest(null);
    },
  });

  const resetForm = () => {
    setEditingId("");
    setTestResult(null);
    setValidatedFingerprint("");
    setAdvancedOpen(false);
    setForm({
      label: defaultTemplate.label,
      kind: "openai",
      apiBaseUrl: defaultTemplate.apiBaseUrl,
      defaultModel: defaultTemplate.defaultModel,
      visionModel: defaultTemplate.visionModel,
      audioModel: defaultTemplate.audioModel,
      documentModel: defaultTemplate.documentModel,
      apiKey: "",
      stream: defaultTemplate.stream,
      reasoningEnabled: false,
      reasoningLevel: "off",
      thinkingBudget: "auto",
      temperature: "0.2",
      topP: "",
      maxOutputTokens: "2048",
      toolCallingEnabled: defaultTemplate.toolCallingEnabled,
      jsonModeEnabled: defaultTemplate.jsonModeEnabled,
      visionEnabled: defaultTemplate.visionEnabled,
      audioInputEnabled: defaultTemplate.audioInputEnabled,
      documentInputEnabled: defaultTemplate.documentInputEnabled,
      enabled: true,
      headersJson: "{}",
      extraBodyJson: "{}",
    });
    setAccessTokenConfirmation("");
  };

  const loadProvider = (provider: JsonRecord) => {
    selectionChanged();
    setEditingId(String(provider.id ?? ""));
    setForm({
      label: String(provider.label ?? ""),
      kind: String(provider.kind ?? "openai") as ProviderKindOption,
      apiBaseUrl: String(provider.apiBaseUrl ?? ""),
      defaultModel: String(provider.defaultModel ?? ""),
      visionModel: provider.visionModel === null || provider.visionModel === undefined
        ? ""
        : String(provider.visionModel),
      audioModel: provider.audioModel === null || provider.audioModel === undefined
        ? ""
        : String(provider.audioModel),
      documentModel: provider.documentModel === null || provider.documentModel === undefined
        ? ""
        : String(provider.documentModel),
      apiKey: "",
      stream: Boolean(provider.stream),
      reasoningEnabled: Boolean(provider.reasoningEnabled),
      reasoningLevel: normalizeReasoningLevel(provider.reasoningLevel),
      thinkingBudget:
        provider.thinkingBudget === null || provider.thinkingBudget === undefined
          ? "auto"
          : String(provider.thinkingBudget),
      temperature: String(provider.temperature ?? "0.2"),
      topP: provider.topP === null || provider.topP === undefined ? "" : String(provider.topP),
      maxOutputTokens: String(provider.maxOutputTokens ?? "2048"),
      toolCallingEnabled: Boolean(provider.toolCallingEnabled),
      jsonModeEnabled: Boolean(provider.jsonModeEnabled),
      visionEnabled: Boolean(provider.visionEnabled),
      audioInputEnabled: Boolean(provider.audioInputEnabled),
      documentInputEnabled: Boolean(provider.documentInputEnabled),
      enabled: Boolean(provider.enabled),
      headersJson: formatJson(provider.headers ?? {}),
      extraBodyJson: formatJson(provider.extraBody ?? {}),
    });
    setAdvancedOpen(false);
    setAccessTokenConfirmation("");
    setValidatedFingerprint(
      buildProviderDraftFingerprint({
        editingId: String(provider.id ?? ""),
        form: {
          label: String(provider.label ?? ""),
          kind: String(provider.kind ?? "openai"),
          apiBaseUrl: String(provider.apiBaseUrl ?? ""),
          defaultModel: String(provider.defaultModel ?? ""),
          visionModel: provider.visionModel === null || provider.visionModel === undefined
            ? ""
            : String(provider.visionModel),
          audioModel: provider.audioModel === null || provider.audioModel === undefined
            ? ""
            : String(provider.audioModel),
          documentModel: provider.documentModel === null || provider.documentModel === undefined
            ? ""
            : String(provider.documentModel),
          apiKey: "",
          stream: Boolean(provider.stream),
          reasoningEnabled: Boolean(provider.reasoningEnabled),
          reasoningLevel: normalizeReasoningLevel(provider.reasoningLevel),
          thinkingBudget:
            provider.thinkingBudget === null || provider.thinkingBudget === undefined
              ? "auto"
              : String(provider.thinkingBudget),
          temperature: String(provider.temperature ?? "0.2"),
          topP: provider.topP === null || provider.topP === undefined ? "" : String(provider.topP),
          maxOutputTokens: String(provider.maxOutputTokens ?? "2048"),
          toolCallingEnabled: Boolean(provider.toolCallingEnabled),
          jsonModeEnabled: Boolean(provider.jsonModeEnabled),
          visionEnabled: Boolean(provider.visionEnabled),
          audioInputEnabled: Boolean(provider.audioInputEnabled),
          documentInputEnabled: Boolean(provider.documentInputEnabled),
          enabled: Boolean(provider.enabled),
          headersJson: formatJson(provider.headers ?? {}),
          extraBodyJson: formatJson(provider.extraBody ?? {}),
        },
      }),
    );
  };

  const saveDisabled =
    saveMutation.isPending ||
    (Boolean(form.apiKey) && !accessTokenConfirmation) ||
    validatedFingerprint !== currentFingerprint;

  useTelegramMainButton({
    text: editingId ? "Update Provider" : "Create Provider",
    isVisible: true,
    isEnabled: !saveDisabled,
    isProgressVisible: saveMutation.isPending,
    onClick: () => saveMutation.mutate(),
  });

  const thinkingBudgetOptions = thinkingBudgetOptionsForProvider(form.kind);
  const configuredProviders = providers.data ?? [];
  const template = providerKindTemplates[form.kind];

  return (
    <div className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
      <Panel title="Configured Providers" subtitle="已保存的 provider 档位，支持直接测试和装载到向导。">
        <div className="space-y-3">
          {configuredProviders.length > 0 ? configuredProviders.map((provider) => (
            <div
              key={String(provider.id)}
              className="rounded-2xl border border-slate-200 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-medium text-slate-900">{String(provider.label)}</p>
                  <p className="text-sm text-slate-500">
                    {String(provider.kind)} · {String(provider.defaultModel ?? "")}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={provider.enabled ? "success" : "warning"}>
                    {provider.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <Button type="button" tone="ghost" onClick={() => loadProvider(provider)}>
                    Load
                  </Button>
                  <Button
                    type="button"
                    tone="secondary"
                    onClick={() =>
                      testMutation.mutate({
                        id: String(provider.id),
                        capabilities: ["text"],
                      })}
                  >
                    Text
                  </Button>
                  <Button
                    type="button"
                    tone="ghost"
                    onClick={() =>
                      testMutation.mutate({
                        id: String(provider.id),
                        capabilities: ["vision"],
                      })}
                  >
                    Vision
                  </Button>
                  <Button
                    type="button"
                    tone="ghost"
                    onClick={() =>
                      testMutation.mutate({
                        id: String(provider.id),
                        capabilities: ["audio"],
                      })}
                  >
                    Audio
                  </Button>
                  <Button
                    type="button"
                    tone="ghost"
                    onClick={() =>
                      testMutation.mutate({
                        id: String(provider.id),
                        capabilities: ["document"],
                      })}
                  >
                    Document
                  </Button>
                  <Button
                    type="button"
                    tone="ghost"
                    onClick={() => deleteMutation.mutate(String(provider.id))}
                  >
                    Delete
                  </Button>
                </div>
              </div>
              <ProviderCapabilityTestSummary
                result={providerTestResults[String(provider.id)]}
                isRunning={
                  activeProviderTest?.providerId === String(provider.id) &&
                  testMutation.isPending
                }
                pendingCapabilities={
                  activeProviderTest?.providerId === String(provider.id)
                    ? activeProviderTest.capabilities
                    : undefined
                }
              />
            </div>
          )) : (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
              <p className="font-medium text-slate-900">No providers configured yet.</p>
              <p className="mt-1 text-sm text-slate-600">
                先通过右侧向导测试连接，再保存第一个 provider。
              </p>
            </div>
          )}
        </div>
      </Panel>

      <div className="grid gap-6">
        <Panel
          title={editingId ? "Provider Wizard" : "Add Provider via Wizard"}
          subtitle="默认走厂商模板和必填连接字段；保存前先通过草稿测试。"
          actions={<MutationBadge mutation={saveMutation} successLabel="Provider Saved" />}
        >
          <div className="grid gap-4">
            <div className="grid gap-2">
              <p className="text-sm font-medium text-slate-900">Provider Preset</p>
              <SelectField
                value={form.kind}
                onChange={(next) => applyProviderKindTemplate(next as ProviderKindOption)}
                options={providerKindOptions}
              />
            </div>

            <Input value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} placeholder="Provider label" />
            <Input value={form.apiBaseUrl} onChange={(event) => setForm((current) => ({ ...current, apiBaseUrl: event.target.value }))} placeholder="API base URL" />
            <Input value={form.defaultModel} onChange={(event) => setForm((current) => ({ ...current, defaultModel: event.target.value }))} placeholder="Default model" />

            {template.visionEnabled || form.visionEnabled ? (
              <Input value={form.visionModel} onChange={(event) => setForm((current) => ({ ...current, visionModel: event.target.value }))} placeholder="Vision model" />
            ) : null}
            {template.audioInputEnabled || form.audioInputEnabled ? (
              <Input value={form.audioModel} onChange={(event) => setForm((current) => ({ ...current, audioModel: event.target.value }))} placeholder="Audio model" />
            ) : null}
            {template.documentInputEnabled || form.documentInputEnabled ? (
              <Input value={form.documentModel} onChange={(event) => setForm((current) => ({ ...current, documentModel: event.target.value }))} placeholder="Document model" />
            ) : null}

            <Input
              type="password"
              placeholder={editingId ? "Leave blank to reuse stored API key" : "API key"}
              value={form.apiKey}
              onChange={(event) => {
                setValidatedFingerprint("");
                setForm((current) => ({ ...current, apiKey: event.target.value }));
              }}
            />
            <Input
              type="password"
              placeholder="Access token confirmation for saving new API key"
              value={accessTokenConfirmation}
              onChange={(event) => setAccessTokenConfirmation(event.target.value)}
            />

            <div className="grid gap-3 md:grid-cols-2">
              <CheckboxField label="Provider Enabled" checked={form.enabled} onChange={(next) => setForm((current) => ({ ...current, enabled: next }))} />
              <CheckboxField label="Stream" checked={form.stream} onChange={(next) => setForm((current) => ({ ...current, stream: next }))} />
              <CheckboxField label="Tool Calling" checked={form.toolCallingEnabled} onChange={(next) => setForm((current) => ({ ...current, toolCallingEnabled: next }))} />
              <CheckboxField label="JSON Mode" checked={form.jsonModeEnabled} onChange={(next) => setForm((current) => ({ ...current, jsonModeEnabled: next }))} />
              <CheckboxField label="Vision" checked={form.visionEnabled} onChange={(next) => setForm((current) => ({ ...current, visionEnabled: next }))} />
              <CheckboxField label="Audio Input" checked={form.audioInputEnabled} onChange={(next) => setForm((current) => ({ ...current, audioInputEnabled: next }))} />
              <CheckboxField label="Document Input" checked={form.documentInputEnabled} onChange={(next) => setForm((current) => ({ ...current, documentInputEnabled: next }))} />
              <CheckboxField label="Reasoning Enabled" checked={form.reasoningEnabled} onChange={(next) => setForm((current) => ({ ...current, reasoningEnabled: next }))} />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <SelectField
                value={form.reasoningLevel}
                onChange={(next) => setForm((current) => ({ ...current, reasoningLevel: next }))}
                options={reasoningLevelOptions}
              />
              <SelectField
                value={form.thinkingBudget}
                onChange={(next) => setForm((current) => ({ ...current, thinkingBudget: next }))}
                options={thinkingBudgetOptions}
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                tone="secondary"
                onClick={() => draftTestMutation.mutate(["text"])}
              >
                Test Draft Connection
              </Button>
              <Button
                type="button"
                disabled={saveDisabled}
                onClick={() => saveMutation.mutate()}
              >
                {editingId ? "Update Provider" : "Create Provider"}
              </Button>
              <Button type="button" tone="ghost" onClick={resetForm}>
                Reset Form
              </Button>
              <Button type="button" tone="ghost" onClick={() => setAdvancedOpen((current) => !current)}>
                {advancedOpen ? "Hide Advanced" : "Show Advanced"}
              </Button>
            </div>

            {advancedOpen ? (
              <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <Input value={form.temperature} onChange={(event) => setForm((current) => ({ ...current, temperature: event.target.value }))} placeholder="temperature" />
                <Input value={form.topP} onChange={(event) => setForm((current) => ({ ...current, topP: event.target.value }))} placeholder="topP" />
                <Input value={form.maxOutputTokens} onChange={(event) => setForm((current) => ({ ...current, maxOutputTokens: event.target.value }))} placeholder="max output tokens" />
                <TextArea value={form.headersJson} onChange={(event) => setForm((current) => ({ ...current, headersJson: event.target.value }))} />
                <TextArea value={form.extraBodyJson} onChange={(event) => setForm((current) => ({ ...current, extraBodyJson: event.target.value }))} />
              </div>
            ) : null}

            {validatedFingerprint === currentFingerprint ? (
              <Badge tone="success">Draft validated</Badge>
            ) : (
              <Badge tone="warning">Run draft test before saving</Badge>
            )}
          </div>
        </Panel>

        <JsonPanel
          title="Last Provider Test"
          subtitle="草稿测试和已保存 provider 测试结果都会显示在这里。"
          value={testResult ?? {}}
          actions={<MutationBadge mutation={draftTestMutation} successLabel="Draft Tested" />}
        />
      </div>
    </div>
  );
}
