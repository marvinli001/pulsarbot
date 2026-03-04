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
  useProviders,
} from "../shared.js";

export function ProvidersPanel() {
  const providers = useProviders();
  const queryClient = useQueryClient();
  const defaultTemplate = providerKindTemplates.openai;
  const [editingId, setEditingId] = useState("");
  const [accessTokenConfirmation, setAccessTokenConfirmation] = useState("");
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
    thinkingBudget: "",
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
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(editingId ? `/api/providers/${editingId}` : "/api/providers", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify({
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
          thinkingBudget: form.thinkingBudget ? Number(form.thinkingBudget) : null,
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
          accessToken: form.apiKey ? accessTokenConfirmation : undefined,
        }),
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
      setForm((current) => ({ ...current, apiKey: "" }));
      setAccessTokenConfirmation("");
    },
    onError: () => notificationOccurred("error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/providers/${id}`, {
        method: "DELETE",
        body: JSON.stringify({
          accessToken: accessTokenConfirmation,
        }),
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
      if (editingId) {
        setEditingId("");
      }
      setAccessTokenConfirmation("");
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
      reasoningLevel: String(provider.reasoningLevel ?? "off"),
      thinkingBudget:
        provider.thinkingBudget === null || provider.thinkingBudget === undefined
          ? ""
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
  };

  useTelegramMainButton({
    text: editingId ? "Update Provider" : "Create Provider",
    isVisible: true,
    isEnabled:
      !saveMutation.isPending &&
      (!form.apiKey || Boolean(accessTokenConfirmation)),
    isProgressVisible: saveMutation.isPending,
    onClick: () => saveMutation.mutate(),
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
      <Panel title="Configured Providers" subtitle="原生 OpenAI / Claude / Gemini / OpenRouter / 百炼 / Compatible provider 档位。">
        <div className="space-y-3">
          {providers.data?.map((provider) => (
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
                    onClick={() =>
                      testMutation.mutate({
                        id: String(provider.id),
                        capabilities: [
                          "text",
                          ...(Boolean(provider.visionEnabled) ? ["vision" as const] : []),
                          ...(Boolean(provider.audioInputEnabled) ? ["audio" as const] : []),
                          ...(Boolean(provider.documentInputEnabled)
                            ? ["document" as const]
                            : []),
                        ],
                      })}
                  >
                    All
                  </Button>
                  <Button
                    type="button"
                    tone="ghost"
                    disabled={!accessTokenConfirmation}
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
          ))}
        </div>
      </Panel>
      <div className="grid gap-6">
        <Panel
          title={editingId ? "Edit Provider" : "Add Provider"}
          subtitle="支持 reasoning、stream、tool calling、vision、audio、document、媒体专用模型、headers 和 extraBody。"
          actions={<MutationBadge mutation={saveMutation} successLabel="Provider Saved" />}
        >
          <div className="grid gap-3">
            <Input value={form.label} onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))} />
            <SelectField
              value={form.kind}
              onChange={(next) => applyProviderKindTemplate(next as ProviderKindOption)}
              options={providerKindOptions}
            />
            <Input value={form.apiBaseUrl} onChange={(event) => setForm((current) => ({ ...current, apiBaseUrl: event.target.value }))} />
            <Input value={form.defaultModel} onChange={(event) => setForm((current) => ({ ...current, defaultModel: event.target.value }))} />
            <div className="grid gap-3 md:grid-cols-3">
              <Input value={form.visionModel} onChange={(event) => setForm((current) => ({ ...current, visionModel: event.target.value }))} placeholder="vision model override" />
              <Input value={form.audioModel} onChange={(event) => setForm((current) => ({ ...current, audioModel: event.target.value }))} placeholder="audio / transcription model override" />
              <Input value={form.documentModel} onChange={(event) => setForm((current) => ({ ...current, documentModel: event.target.value }))} placeholder="document model override" />
            </div>
            <Input
              type="password"
              placeholder={editingId ? "Leave blank to keep existing API key" : "API key"}
              value={form.apiKey}
              onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
            />
            <Input
              type="password"
              placeholder="Access token confirmation"
              value={accessTokenConfirmation}
              onChange={(event) => setAccessTokenConfirmation(event.target.value)}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <Input value={form.reasoningLevel} onChange={(event) => setForm((current) => ({ ...current, reasoningLevel: event.target.value }))} placeholder="off | low | medium | high" />
              <Input value={form.thinkingBudget} onChange={(event) => setForm((current) => ({ ...current, thinkingBudget: event.target.value }))} placeholder="thinking budget" />
              <Input value={form.temperature} onChange={(event) => setForm((current) => ({ ...current, temperature: event.target.value }))} placeholder="temperature" />
              <Input value={form.topP} onChange={(event) => setForm((current) => ({ ...current, topP: event.target.value }))} placeholder="topP" />
              <Input value={form.maxOutputTokens} onChange={(event) => setForm((current) => ({ ...current, maxOutputTokens: event.target.value }))} placeholder="max output tokens" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <CheckboxField label="Stream" checked={form.stream} onChange={(next) => setForm((current) => ({ ...current, stream: next }))} />
              <CheckboxField label="Reasoning Enabled" checked={form.reasoningEnabled} onChange={(next) => setForm((current) => ({ ...current, reasoningEnabled: next }))} />
              <CheckboxField label="Tool Calling Enabled" checked={form.toolCallingEnabled} onChange={(next) => setForm((current) => ({ ...current, toolCallingEnabled: next }))} />
              <CheckboxField label="JSON Mode Enabled" checked={form.jsonModeEnabled} onChange={(next) => setForm((current) => ({ ...current, jsonModeEnabled: next }))} />
              <CheckboxField label="Vision Enabled" checked={form.visionEnabled} onChange={(next) => setForm((current) => ({ ...current, visionEnabled: next }))} />
              <CheckboxField label="Audio Input Enabled" checked={form.audioInputEnabled} onChange={(next) => setForm((current) => ({ ...current, audioInputEnabled: next }))} />
              <CheckboxField label="Document Input Enabled" checked={form.documentInputEnabled} onChange={(next) => setForm((current) => ({ ...current, documentInputEnabled: next }))} />
              <CheckboxField label="Provider Enabled" checked={form.enabled} onChange={(next) => setForm((current) => ({ ...current, enabled: next }))} />
            </div>
            <TextArea value={form.headersJson} onChange={(event) => setForm((current) => ({ ...current, headersJson: event.target.value }))} />
            <TextArea value={form.extraBodyJson} onChange={(event) => setForm((current) => ({ ...current, extraBodyJson: event.target.value }))} />
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                disabled={Boolean(form.apiKey) && !accessTokenConfirmation}
                onClick={() => saveMutation.mutate()}
              >
                {editingId ? "Update Provider" : "Create Provider"}
              </Button>
              <Button
                type="button"
                tone="ghost"
                onClick={() => {
                  setEditingId("");
                  setTestResult(null);
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
                    thinkingBudget: "",
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
                }}
              >
                Reset Form
              </Button>
            </div>
          </div>
        </Panel>
        <JsonPanel
          title="Last Provider Test"
          subtitle="调用 `/api/providers/:id/test` 的最近一次 capability 测试结果。"
          value={testResult ?? {}}
          actions={<MutationBadge mutation={testMutation} successLabel="Test Completed" />}
        />
      </div>
    </div>
  );
}
