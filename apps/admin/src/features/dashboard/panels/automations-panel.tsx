import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Input,
  Panel,
} from "@pulsarbot/ui-kit";
import { apiFetch } from "../../../lib/api.js";
import {
  notificationOccurred,
  selectionChanged,
  useTelegramMainButton,
} from "../../../lib/telegram.js";
import {
  MutationBadge,
  ResourceSelectField,
  SelectField,
  triggerKindOptions,
  useTasks,
  useTriggers,
} from "../shared.js";

export function AutomationsPanel() {
  const tasks = useTasks();
  const triggers = useTriggers();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState({
    taskId: "",
    label: "Morning Trigger",
    kind: "schedule",
    enabled: true,
    intervalMinutes: "60",
    webhookPath: "",
    webhookSecret: "",
    shortcutText: "/digest",
  });

  const taskOptions = useMemo(
    () => [
      { value: "", label: "Select task" },
      ...(tasks.data ?? []).map((task) => ({
        value: String(task.id ?? ""),
        label: `${String(task.title ?? task.id ?? "")} · ${String(task.status ?? "draft")}`,
      })),
    ],
    [tasks.data],
  );

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/triggers", {
        method: "POST",
        body: JSON.stringify({
          ...(editingId ? { id: editingId } : {}),
          taskId: form.taskId || null,
          label: form.label,
          kind: form.kind,
          enabled: form.enabled,
          webhookPath: form.kind === "webhook" ? form.webhookPath || null : null,
          webhookSecret: form.kind === "webhook" ? form.webhookSecret || null : null,
          config:
            form.kind === "schedule"
              ? {
                  intervalMinutes: Number(form.intervalMinutes || "60"),
                }
              : form.kind === "telegram_shortcut"
                ? {
                    command: form.shortcutText,
                  }
                : {},
        }),
      }),
    onSuccess: async (data) => {
      notificationOccurred("success");
      setEditingId(String((data as Record<string, unknown>).id ?? ""));
      await queryClient.invalidateQueries({ queryKey: ["triggers"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["system-health"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const loadTrigger = (trigger: Record<string, unknown>) => {
    selectionChanged();
      const config = (trigger.config ?? {}) as Record<string, unknown>;
      setEditingId(String(trigger.id ?? ""));
      setForm({
        taskId: String(trigger.taskId ?? ""),
        label: String(trigger.label ?? ""),
        kind: String(trigger.kind ?? "manual"),
        enabled: Boolean(trigger.enabled),
        intervalMinutes: String(config.intervalMinutes ?? config.everyMinutes ?? "60"),
        webhookPath: String(trigger.webhookPath ?? ""),
        webhookSecret: "",
        shortcutText: String(config.command ?? "/digest"),
      });
  };

  useTelegramMainButton({
    text: editingId ? "Update Trigger" : "Create Trigger",
    isVisible: true,
    isEnabled: !saveMutation.isPending,
    isProgressVisible: saveMutation.isPending,
    onClick: () => saveMutation.mutate(),
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
      <Panel
        title="Automations"
        subtitle="Schedule, webhook, and the /digest shortcut feed the same task runtime."
      >
        <div className="space-y-3">
          {(triggers.data ?? []).map((trigger) => (
            <div key={String(trigger.id)} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-medium">{String(trigger.label ?? trigger.id ?? "")}</p>
                  <p className="text-sm text-slate-500">
                    {String(trigger.kind ?? "manual")} · task {String(trigger.taskId ?? "-")}
                  </p>
                  {trigger.kind === "webhook" ? (
                    <p className="text-xs text-slate-500">
                      /api/triggers/webhook/{String(trigger.webhookPath ?? "")}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={Boolean(trigger.enabled) ? "success" : "warning"}>
                    {Boolean(trigger.enabled) ? "Enabled" : "Disabled"}
                  </Badge>
                  <Button type="button" tone="ghost" onClick={() => loadTrigger(trigger)}>
                    Load
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title={editingId ? "Edit Trigger" : "Create Trigger"}
        subtitle="Goal-first task after, trigger first only for wiring."
        actions={<MutationBadge mutation={saveMutation} successLabel="Trigger Saved" />}
      >
        <div className="grid gap-3">
          <ResourceSelectField
            label="Task"
            hint="Triggers attach to one task."
            value={form.taskId}
            onChange={(next) => setForm((current) => ({ ...current, taskId: next }))}
            options={taskOptions}
          />
          <Input
            value={form.label}
            onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
            placeholder="Trigger label"
          />
          <div>
            <p className="mb-2 text-sm font-medium text-slate-900">Kind</p>
            <SelectField
              value={form.kind}
              onChange={(next) => setForm((current) => ({ ...current, kind: next }))}
              options={[...triggerKindOptions]}
            />
          </div>
          {form.kind === "schedule" ? (
            <Input
              value={form.intervalMinutes}
              onChange={(event) =>
                setForm((current) => ({ ...current, intervalMinutes: event.target.value }))
              }
              placeholder="Interval minutes"
            />
          ) : null}
          {form.kind === "webhook" ? (
            <>
              <Input
                value={form.webhookPath}
                onChange={(event) =>
                  setForm((current) => ({ ...current, webhookPath: event.target.value }))
                }
                placeholder="Webhook path slug"
              />
              <Input
                value={form.webhookSecret}
                onChange={(event) =>
                  setForm((current) => ({ ...current, webhookSecret: event.target.value }))
                }
                placeholder={editingId ? "Leave blank to keep current secret" : "Webhook secret"}
              />
            </>
          ) : null}
          {form.kind === "telegram_shortcut" ? (
            <Input value="/digest" readOnly placeholder="/digest" />
          ) : null}
          <label className="flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
            />
            Enabled
          </label>
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              {editingId ? "Update Trigger" : "Create Trigger"}
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
