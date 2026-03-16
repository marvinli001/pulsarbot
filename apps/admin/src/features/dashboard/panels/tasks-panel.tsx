import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  CheckboxListField,
  MutationBadge,
  ResourceSelectField,
  SelectField,
  approvalPolicyOptions,
  formatJson,
  memoryPolicyOptions,
  parseJsonRecord,
  useExecutors,
  useProfiles,
  useTasks,
  useWorkflowTemplates,
} from "../shared.js";

type TemplateField = {
  key: string;
  kind: "text" | "textarea" | "number" | "boolean" | "select" | "json";
  label: string;
  description: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function getNestedValue(record: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, record);
}

function setNestedValue(record: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split(".");
  let cursor = record;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const current = cursor[segment];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

function safeConfigJson(input: string): Record<string, unknown> {
  try {
    return parseJsonRecord(input);
  } catch {
    return {};
  }
}

function stringifyFieldValue(field: TemplateField, config: Record<string, unknown>): string {
  const value = getNestedValue(config, field.key);
  if (typeof value === "undefined" || value === null) {
    return field.kind === "json" ? "[]" : "";
  }
  if (field.kind === "json") {
    return JSON.stringify(value, null, 2);
  }
  if (field.kind === "boolean") {
    return String(Boolean(value));
  }
  return String(value);
}

type BrowserWorkflowRecipe = {
  id: string;
  label: string;
  description: string;
  title: string;
  goal: string;
  config: Record<string, unknown>;
};

type BrowserStepSnippet = {
  id: string;
  label: string;
  description: string;
  steps: Array<Record<string, unknown>>;
};

function browserWorkflowConfig(
  startUrl: string,
  steps: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    startUrl,
    steps,
    captureScreenshot: true,
    telegramTarget: {},
  };
}

const browserWorkflowRecipes: BrowserWorkflowRecipe[] = [
  {
    id: "extract_text",
    label: "Extract Page Text",
    description: "Wait for a selector, extract its text, and keep a screenshot artifact.",
    title: "Extract text from a logged-in page",
    goal: "Open a page in the attached browser, wait for a key element, and extract the text for downstream agent reasoning.",
    config: browserWorkflowConfig("https://example.com", [
      { type: "wait_for_selector", selector: "#headline", timeoutMs: 10000 },
      { type: "extract_text", selector: "#headline", label: "Headline" },
    ]),
  },
  {
    id: "fill_submit",
    label: "Fill and Submit",
    description: "Type into a form, submit it, and capture the confirmation text.",
    title: "Fill a form in the attached browser",
    goal: "Use the attached browser window to fill a form and report the confirmation state back to the control plane.",
    config: browserWorkflowConfig("https://example.com/form", [
      { type: "type", selector: "#email", text: "demo@example.com" },
      { type: "type", selector: "#note", text: "Created by Pulsarbot" },
      { type: "click", selector: "button[type='submit']" },
      { type: "wait_for_selector", selector: ".success-message", timeoutMs: 10000 },
      { type: "extract_text", selector: ".success-message", label: "Submission Result" },
    ]),
  },
  {
    id: "search_capture",
    label: "Search and Capture",
    description: "Type into a search box, press Enter, then extract the first result block.",
    title: "Run a search in the attached browser",
    goal: "Search within a logged-in site, wait for the result view, and return the top result text with a screenshot.",
    config: browserWorkflowConfig("https://example.com/search", [
      { type: "type", selector: "input[type='search']", text: "weekly pipeline status" },
      { type: "press", selector: "input[type='search']", key: "Enter" },
      { type: "wait_for_selector", selector: ".search-result", timeoutMs: 10000 },
      { type: "extract_text", selector: ".search-result", label: "Top Result" },
    ]),
  },
  {
    id: "click_capture",
    label: "Click and Capture",
    description: "Click a control, wait briefly, and keep the resulting screenshot and final URL.",
    title: "Trigger a browser action and capture the result",
    goal: "Open a logged-in workflow page, click a known control, and capture the resulting browser state for the owner.",
    config: browserWorkflowConfig("https://example.com/dashboard", [
      { type: "click", selector: "#primary-action" },
      { type: "wait", ms: 1200 },
    ]),
  },
];

const browserStepSnippets: BrowserStepSnippet[] = [
  {
    id: "snippet_click",
    label: "Append Click",
    description: "Add a click step with a placeholder selector.",
    steps: [{ type: "click", selector: "#primary-action" }],
  },
  {
    id: "snippet_type_press",
    label: "Append Type + Press",
    description: "Add a text entry step followed by Enter.",
    steps: [
      { type: "type", selector: "input[type='search']", text: "replace me" },
      { type: "press", selector: "input[type='search']", key: "Enter" },
    ],
  },
  {
    id: "snippet_wait_extract",
    label: "Append Wait + Extract",
    description: "Wait for a result selector and extract its text.",
    steps: [
      { type: "wait_for_selector", selector: ".result", timeoutMs: 10000 },
      { type: "extract_text", selector: ".result", label: "Result" },
    ],
  },
];

function browserPreviewCallout(preview: Record<string, unknown> | null): {
  tone: "success" | "warning" | "danger";
  title: string;
  detail: string;
} | null {
  if (!preview) {
    return null;
  }
  const blockers = Array.isArray(preview.blockers) ? preview.blockers as Array<Record<string, unknown>> : [];
  const firstBlocker = blockers[0];
  const code = typeof firstBlocker?.code === "string" ? firstBlocker.code : "";
  const message = typeof firstBlocker?.message === "string" ? firstBlocker.message : "";

  if (code === "browser_not_attached") {
    return {
      tone: "warning",
      title: "Chrome executor is not attached",
      detail: "Go to Executors, bring the target site to the front in Chrome, then attach the current window before running this task.",
    };
  }
  if (code === "attached_origin_not_allowed") {
    return {
      tone: "danger",
      title: "Attached site is outside the allowlist",
      detail: "Update allowed hosts or re-attach a tab whose origin matches the executor allowlist.",
    };
  }
  if (code === "executor_offline") {
    return {
      tone: "warning",
      title: "Executor is offline",
      detail: message || "Bring the local executor online before running this workflow.",
    };
  }
  if (code === "executor_missing") {
    return {
      tone: "warning",
      title: "No default executor selected",
      detail: "Pick a Chrome extension or companion executor so this workflow has somewhere to run.",
    };
  }
  if (blockers.length === 0 && preview.executor && preview.taskRunStatus !== "waiting_retry") {
    return {
      tone: "success",
      title: "Browser workflow looks runnable",
      detail: "The selected executor is ready. You can still tweak selectors or apply one of the quick recipes below.",
    };
  }
  return null;
}

export function TasksPanel() {
  const tasks = useTasks();
  const profiles = useProfiles();
  const executors = useExecutors();
  const workflowTemplates = useWorkflowTemplates();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState("");
  const [lastRunResult, setLastRunResult] = useState<unknown>(null);
  const [form, setForm] = useState({
    title: "Daily Briefing",
    goal: "每天整理重要更新并回推 Telegram。",
    description: "",
    templateKind: "web_watch_report",
    status: "draft",
    agentProfileId: "",
    defaultExecutorId: "",
    approvalPolicy: "auto_approve_safe",
    approvalCheckpoints: ["before_executor", "before_telegram_push"],
    memoryPolicy: "task_context",
    maxSteps: "8",
    maxActions: "6",
    timeoutMs: "60000",
    relatedDocumentIds: "",
    configJson: "{}",
  });

  const templateOptions = useMemo(
    () => (workflowTemplates.data ?? []).map((template) => ({
      value: String(template.id ?? ""),
      label: String(template.title ?? template.id ?? ""),
    })),
    [workflowTemplates.data],
  );
  const selectedTemplate = useMemo(
    () =>
      (workflowTemplates.data ?? []).find((template) =>
        String(template.id ?? "") === form.templateKind
      ) ?? null,
    [form.templateKind, workflowTemplates.data],
  );
  const selectedTemplateFields = useMemo(
    () => (selectedTemplate?.fields ?? []) as TemplateField[],
    [selectedTemplate],
  );

  useEffect(() => {
    if (!selectedTemplate || editingId || form.configJson !== "{}") {
      return;
    }
    setForm((current) => ({
      ...current,
      configJson: formatJson(selectedTemplate.defaultConfig ?? {}),
      approvalCheckpoints: asStringArray(selectedTemplate.defaultApprovalCheckpoints),
    }));
  }, [editingId, form.configJson, selectedTemplate]);

  const profileOptions = useMemo(
    () => [
      { value: "", label: "No profile override" },
      ...(profiles.data ?? []).map((profile) => ({
        value: String(profile.id ?? ""),
        label: String(profile.label ?? profile.id ?? ""),
      })),
    ],
    [profiles.data],
  );
  const executorOptions = useMemo(
    () => [
      { value: "", label: "No executor" },
      ...(executors.data ?? []).map((executor) => ({
        value: String(executor.id ?? ""),
        label: `${String(executor.label ?? executor.id ?? "")} · ${String(executor.kind ?? "companion")} · ${String(executor.status ?? "offline")}${executor.kind === "chrome_extension" ? ` · ${String((executor.browserAttachment as Record<string, unknown> | undefined)?.state ?? "detached")}` : ""}`,
      })),
    ],
    [executors.data],
  );

  const previewQuery = useQuery({
    queryKey: [
      "workflow-preview",
      form.templateKind,
      form.defaultExecutorId,
      form.approvalPolicy,
      form.memoryPolicy,
      form.approvalCheckpoints.join(","),
      form.relatedDocumentIds,
      form.configJson,
    ],
    queryFn: () =>
      apiFetch<Record<string, unknown>>("/api/workflow/preview", {
        method: "POST",
        body: JSON.stringify({
          templateKind: form.templateKind,
          title: form.title,
          goal: form.goal,
          defaultExecutorId: form.defaultExecutorId || null,
          approvalPolicy: form.approvalPolicy,
          memoryPolicy: form.memoryPolicy,
          approvalCheckpoints: form.approvalCheckpoints,
          relatedDocumentIds: form.relatedDocumentIds
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          config: safeConfigJson(form.configJson),
        }),
      }),
    enabled: Boolean(selectedTemplate),
  });
  const browserPreviewMeta = useMemo(
    () =>
      form.templateKind === "browser_workflow"
        ? browserPreviewCallout(previewQuery.data ?? null)
        : null,
    [form.templateKind, previewQuery.data],
  );

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          ...(editingId ? { id: editingId } : {}),
          title: form.title,
          goal: form.goal,
          description: form.description,
          templateKind: form.templateKind,
          status: form.status,
          agentProfileId: form.agentProfileId || null,
          defaultExecutorId: form.defaultExecutorId || null,
          approvalPolicy: form.approvalPolicy,
          approvalCheckpoints: form.approvalCheckpoints,
          memoryPolicy: form.memoryPolicy,
          defaultRunBudget: {
            maxSteps: Number(form.maxSteps || "8"),
            maxActions: Number(form.maxActions || "6"),
            timeoutMs: Number(form.timeoutMs || "60000"),
          },
          config: safeConfigJson(form.configJson),
          relatedDocumentIds: form.relatedDocumentIds
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess: async (data) => {
      notificationOccurred("success");
      const record = data as Record<string, unknown>;
      setEditingId(String(record.id ?? ""));
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["workflow-preview"] });
      await queryClient.invalidateQueries({ queryKey: ["system-health"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const runMutation = useMutation({
    mutationFn: (taskId: string) =>
      apiFetch("/api/task-runs", {
        method: "POST",
        body: JSON.stringify({
          taskId,
          triggerType: "manual",
          inputSnapshot: {
            launchedFrom: "miniapp",
          },
        }),
      }),
    onSuccess: async (data) => {
      notificationOccurred("success");
      setLastRunResult(data);
      await queryClient.invalidateQueries({ queryKey: ["task-runs"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["approvals"] });
      await queryClient.invalidateQueries({ queryKey: ["system-health"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const updateTemplateConfig = (field: TemplateField, rawValue: unknown) => {
    const next = safeConfigJson(form.configJson);
    if (field.kind === "number") {
      const numeric = Number(rawValue);
      setNestedValue(next, field.key, Number.isFinite(numeric) ? numeric : 0);
    } else if (field.kind === "boolean") {
      setNestedValue(next, field.key, Boolean(rawValue));
    } else if (field.kind === "json") {
      try {
        setNestedValue(next, field.key, JSON.parse(String(rawValue || "[]")));
      } catch {
        return;
      }
    } else {
      setNestedValue(next, field.key, String(rawValue));
    }
    setForm((current) => ({ ...current, configJson: formatJson(next) }));
  };

  const applyTemplateDefaults = (templateId: string) => {
    const template = (workflowTemplates.data ?? []).find((item) => String(item.id ?? "") === templateId);
    setForm((current) => ({
      ...current,
      templateKind: templateId,
      approvalCheckpoints: asStringArray(template?.defaultApprovalCheckpoints),
      configJson: formatJson(template?.defaultConfig ?? {}),
    }));
  };

  const applyBrowserWorkflowRecipe = (recipe: BrowserWorkflowRecipe) => {
    selectionChanged();
    setEditingId("");
    setForm((current) => ({
      ...current,
      title: recipe.title,
      goal: recipe.goal,
      templateKind: "browser_workflow",
      approvalCheckpoints: ["before_executor", "before_telegram_push"],
      configJson: formatJson(recipe.config),
    }));
  };

  const appendBrowserStepSnippet = (snippet: BrowserStepSnippet) => {
    const nextConfig = safeConfigJson(form.configJson);
    const steps = Array.isArray(nextConfig.steps) ? nextConfig.steps : [];
    nextConfig.steps = [...steps, ...snippet.steps];
    if (typeof nextConfig.startUrl !== "string" || nextConfig.startUrl.length === 0) {
      nextConfig.startUrl = "https://example.com";
    }
    if (typeof nextConfig.captureScreenshot === "undefined") {
      nextConfig.captureScreenshot = true;
    }
    setForm((current) => ({
      ...current,
      templateKind: "browser_workflow",
      configJson: formatJson(nextConfig),
    }));
  };

  const loadTask = (task: Record<string, unknown>) => {
    selectionChanged();
    setEditingId(String(task.id ?? ""));
    const budget = (task.defaultRunBudget ?? {}) as Record<string, unknown>;
    setForm({
      title: String(task.title ?? ""),
      goal: String(task.goal ?? ""),
      description: String(task.description ?? ""),
      templateKind: String(task.templateKind ?? "web_watch_report"),
      status: String(task.status ?? "draft"),
      agentProfileId: String(task.agentProfileId ?? ""),
      defaultExecutorId: String(task.defaultExecutorId ?? ""),
      approvalPolicy: String(task.approvalPolicy ?? "auto_approve_safe"),
      approvalCheckpoints: asStringArray(task.approvalCheckpoints),
      memoryPolicy: String(task.memoryPolicy ?? "task_context"),
      maxSteps: String(budget.maxSteps ?? "8"),
      maxActions: String(budget.maxActions ?? "6"),
      timeoutMs: String(budget.timeoutMs ?? "60000"),
      relatedDocumentIds: asStringArray(task.relatedDocumentIds).join(", "),
      configJson: formatJson(task.config ?? {}),
    });
  };

  useTelegramMainButton({
    text: editingId ? "Update Task" : "Create Task",
    isVisible: true,
    isEnabled: !saveMutation.isPending,
    isProgressVisible: saveMutation.isPending,
    onClick: () => saveMutation.mutate(),
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
      <Panel
        title="Tasks"
        subtitle="Workflow templates now drive fields, execution plans, and capability preview."
      >
        <div className="space-y-3">
          {(tasks.data ?? []).map((task) => (
            <div key={String(task.id)} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-medium">{String(task.title ?? task.id ?? "")}</p>
                  <p className="text-sm text-slate-500">{String(task.goal ?? "")}</p>
                  <p className="text-xs text-slate-500">
                    {String(task.templateKind ?? "unknown")} · {String(task.status ?? "draft")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={String(task.status) === "active" ? "success" : "warning"}>
                    {String(task.status ?? "draft")}
                  </Badge>
                  <Button type="button" tone="ghost" onClick={() => loadTask(task)}>
                    Load
                  </Button>
                  <Button
                    type="button"
                    tone="secondary"
                    onClick={() => runMutation.mutate(String(task.id ?? ""))}
                  >
                    Run
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid gap-6">
        <Panel
          title={editingId ? "Edit Task" : "Create Task"}
          subtitle="Template-specific fields replace generic execution config."
          actions={<MutationBadge mutation={saveMutation} successLabel="Task Saved" />}
        >
          <div className="grid gap-3">
            <Input
              value={form.title}
              aria-label="Task title"
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              placeholder="Task title"
            />
            <TextArea
              value={form.goal}
              aria-label="Task goal"
              onChange={(event) => setForm((current) => ({ ...current, goal: event.target.value }))}
              rows={3}
              placeholder="What should this task accomplish?"
            />
            <TextArea
              value={form.description}
              aria-label="Task description"
              onChange={(event) =>
                setForm((current) => ({ ...current, description: event.target.value }))
              }
              rows={3}
              placeholder="Optional operating notes"
            />
            <ResourceSelectField
              label="Template"
              hint="Choose the workflow shape first; fields and preview update automatically."
              value={form.templateKind}
              onChange={(next) => applyTemplateDefaults(next)}
              options={templateOptions}
              selectAriaLabel="Task template"
            />
            <ResourceSelectField
              label="Agent Profile"
              hint="Optional profile override for this task."
              value={form.agentProfileId}
              onChange={(next) => setForm((current) => ({ ...current, agentProfileId: next }))}
              options={profileOptions}
              selectAriaLabel="Task agent profile"
            />
            <ResourceSelectField
              label="Default Executor"
              hint="Executor that should receive runs by default."
              value={form.defaultExecutorId}
              onChange={(next) => setForm((current) => ({ ...current, defaultExecutorId: next }))}
              options={executorOptions}
              selectAriaLabel="Task default executor"
            />
            {form.templateKind === "browser_workflow" ? (
              <div className="grid gap-3 rounded-2xl border border-slate-200 p-4">
                <div>
                  <p className="text-sm font-medium text-slate-900">Agentflow Browser Recipes</p>
                  <p className="text-xs text-slate-500">
                    Start from a common browser workflow, then adjust selectors and steps below.
                  </p>
                </div>
                {browserPreviewMeta ? (
                  <div
                    className={[
                      "rounded-2xl border px-4 py-3 text-sm",
                      browserPreviewMeta.tone === "success"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                        : browserPreviewMeta.tone === "danger"
                          ? "border-rose-200 bg-rose-50 text-rose-900"
                          : "border-amber-200 bg-amber-50 text-amber-900",
                    ].join(" ")}
                  >
                    <p className="font-medium">{browserPreviewMeta.title}</p>
                    <p className="mt-1 text-xs opacity-90">{browserPreviewMeta.detail}</p>
                  </div>
                ) : null}
                <div className="grid gap-2 md:grid-cols-2">
                  {browserWorkflowRecipes.map((recipe) => (
                    <button
                      key={recipe.id}
                      type="button"
                      onClick={() => applyBrowserWorkflowRecipe(recipe)}
                      className="rounded-2xl border border-slate-200 px-4 py-4 text-left transition hover:border-slate-300 hover:bg-slate-50"
                    >
                      <p className="text-sm font-medium text-slate-900">{recipe.label}</p>
                      <p className="mt-1 text-xs text-slate-500">{recipe.description}</p>
                    </button>
                  ))}
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-900">Step Snippets</p>
                  <p className="text-xs text-slate-500">
                    Append a starter block to the current browser steps JSON.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {browserStepSnippets.map((snippet) => (
                    <Button
                      key={snippet.id}
                      type="button"
                      tone="secondary"
                      title={snippet.description}
                      onClick={() => appendBrowserStepSnippet(snippet)}
                    >
                      {snippet.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {selectedTemplateFields.map((field) => {
              const config = safeConfigJson(form.configJson);
              const value = stringifyFieldValue(field, config);
              if (field.kind === "textarea") {
                return (
                  <div key={field.key}>
                    <p className="mb-2 text-sm font-medium text-slate-900">{field.label}</p>
                    <p className="mb-2 text-xs text-slate-500">{field.description}</p>
                    <TextArea
                      value={value}
                      rows={4}
                      aria-label={field.label}
                      placeholder={field.placeholder}
                      onChange={(event) => updateTemplateConfig(field, event.target.value)}
                    />
                  </div>
                );
              }
              if (field.kind === "select") {
                return (
                  <div key={field.key}>
                    <p className="mb-2 text-sm font-medium text-slate-900">{field.label}</p>
                    <p className="mb-2 text-xs text-slate-500">{field.description}</p>
                    <SelectField
                      value={value}
                      onChange={(next) => updateTemplateConfig(field, next)}
                      options={field.options ?? []}
                      ariaLabel={field.label}
                    />
                  </div>
                );
              }
              if (field.kind === "boolean") {
                return (
                  <label key={field.key} className="flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm">
                    <input
                      type="checkbox"
                      checked={value === "true"}
                      aria-label={field.label}
                      onChange={(event) => updateTemplateConfig(field, event.target.checked)}
                    />
                    <span>
                      <span className="block font-medium">{field.label}</span>
                      <span className="block text-xs text-slate-500">{field.description}</span>
                    </span>
                  </label>
                );
              }
              if (field.kind === "json") {
                return (
                  <div key={field.key}>
                    <p className="mb-2 text-sm font-medium text-slate-900">{field.label}</p>
                    <p className="mb-2 text-xs text-slate-500">{field.description}</p>
                    <TextArea
                      value={value}
                      rows={8}
                      aria-label={field.label}
                      onChange={(event) => updateTemplateConfig(field, event.target.value)}
                    />
                  </div>
                );
              }
              return (
                <div key={field.key}>
                  <p className="mb-2 text-sm font-medium text-slate-900">{field.label}</p>
                  <p className="mb-2 text-xs text-slate-500">{field.description}</p>
                  <Input
                    value={value}
                    aria-label={field.label}
                    placeholder={field.placeholder}
                    onChange={(event) => updateTemplateConfig(field, event.target.value)}
                  />
                </div>
              );
            })}

            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-sm font-medium text-slate-900">Status</p>
                <SelectField
                  value={form.status}
                  onChange={(next) => setForm((current) => ({ ...current, status: next }))}
                  ariaLabel="Task status"
                  options={[
                    { value: "draft", label: "Draft" },
                    { value: "active", label: "Active" },
                    { value: "paused", label: "Paused" },
                    { value: "archived", label: "Archived" },
                  ]}
                />
              </div>
              <div>
                <p className="mb-2 text-sm font-medium text-slate-900">Approval Policy</p>
                <SelectField
                  value={form.approvalPolicy}
                  onChange={(next) =>
                    setForm((current) => ({ ...current, approvalPolicy: next }))
                  }
                  ariaLabel="Task approval policy"
                  options={[...approvalPolicyOptions]}
                />
              </div>
            </div>
            <CheckboxListField
              label="Approval Checkpoints"
              hint="These checkpoints decide where the task waits for owner approval."
              options={[
                { value: "before_executor", label: "Before executor" },
                { value: "before_memory_writeback", label: "Before memory writeback" },
                { value: "before_telegram_push", label: "Before Telegram push" },
                { value: "before_fs_write", label: "Before filesystem write" },
                { value: "before_shell", label: "Before shell" },
              ]}
              values={form.approvalCheckpoints}
              onChange={(next) => setForm((current) => ({ ...current, approvalCheckpoints: next }))}
            />
            <div>
              <p className="mb-2 text-sm font-medium text-slate-900">Memory Policy</p>
              <SelectField
                value={form.memoryPolicy}
                onChange={(next) => setForm((current) => ({ ...current, memoryPolicy: next }))}
                ariaLabel="Task memory policy"
                options={[...memoryPolicyOptions]}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                value={form.maxSteps}
                aria-label="Task max steps"
                onChange={(event) => setForm((current) => ({ ...current, maxSteps: event.target.value }))}
                placeholder="Max steps"
              />
              <Input
                value={form.maxActions}
                aria-label="Task max actions"
                onChange={(event) => setForm((current) => ({ ...current, maxActions: event.target.value }))}
                placeholder="Max actions"
              />
              <Input
                value={form.timeoutMs}
                aria-label="Task timeout ms"
                onChange={(event) => setForm((current) => ({ ...current, timeoutMs: event.target.value }))}
                placeholder="Timeout ms"
              />
            </div>
            <Input
              value={form.relatedDocumentIds}
              aria-label="Task related document ids"
              onChange={(event) =>
                setForm((current) => ({ ...current, relatedDocumentIds: event.target.value }))
              }
              placeholder="Related document IDs (comma separated)"
            />
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
              >
                {editingId ? "Update Task" : "Create Task"}
              </Button>
            </div>
          </div>
        </Panel>

        <Panel
          title="Workflow Capability Preview"
          subtitle="Readiness, blockers, approval checkpoints, and derived execution plan."
        >
          <pre className="overflow-x-auto rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
            {formatJson(previewQuery.data ?? {
              loading: previewQuery.isLoading,
            })}
          </pre>
        </Panel>

        <Panel
          title="Last Manual Run"
          subtitle="Create task runs directly from the Mini App and inspect the returned control-plane payload."
        >
          <pre className="overflow-x-auto rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
            {formatJson(lastRunResult)}
          </pre>
        </Panel>
      </div>
    </div>
  );
}
