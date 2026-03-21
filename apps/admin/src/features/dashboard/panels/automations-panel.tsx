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

type ScheduleMode = "interval" | "daily" | "weekly" | "cron";

function parseWeekdaysCsv(value: string) {
  return [...new Set(
    value
      .split(/[,\s]+/)
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item >= 1 && item <= 7),
  )].sort((left, right) => left - right);
}

function readScheduleConfig(config: Record<string, unknown>) {
  const nested = config.schedule;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const schedule = nested as Record<string, unknown>;
    const mode = String(schedule.mode ?? "interval");
    if (mode === "daily" || mode === "weekly") {
      return {
        mode,
        time: String(schedule.time ?? "08:00"),
        timezone: String(schedule.timezone ?? "UTC"),
        weekdays: Array.isArray(schedule.weekdays)
          ? schedule.weekdays.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 1 && item <= 7)
          : [1],
        cron: String(schedule.cron ?? ""),
      };
    }
    if (mode === "cron") {
      return {
        mode,
        time: "08:00",
        timezone: String(schedule.timezone ?? "UTC"),
        weekdays: [1],
        cron: String(schedule.cron ?? ""),
      };
    }
  }
  return {
    mode: "interval" as const,
    intervalMinutes: String(config.intervalMinutes ?? config.everyMinutes ?? "60"),
    time: "08:00",
    timezone: "UTC",
    weekdays: [1],
    cron: "",
  };
}

function buildScheduleConfig(form: {
  scheduleMode: ScheduleMode;
  intervalMinutes: string;
  scheduleTime: string;
  scheduleTimezone: string;
  scheduleWeekdays: string;
  cronExpression: string;
}) {
  if (form.scheduleMode === "interval") {
    return {
      intervalMinutes: Number(form.intervalMinutes || "60"),
    };
  }
  return {
    schedule: {
      mode: form.scheduleMode,
      timezone: form.scheduleTimezone || "UTC",
      ...(form.scheduleMode === "cron"
        ? {
            cron: form.cronExpression || "0 8 * * *",
          }
        : {
            time: form.scheduleTime || "08:00",
          }),
      ...(form.scheduleMode === "weekly"
        ? {
            weekdays: parseWeekdaysCsv(form.scheduleWeekdays),
          }
        : {}),
    },
  };
}

function describeSchedule(config: Record<string, unknown>) {
  const schedule = readScheduleConfig(config);
  if (schedule.mode === "interval") {
    return `Every ${String(schedule.intervalMinutes ?? "60")} min`;
  }
  if (schedule.mode === "daily") {
    return `Daily ${schedule.time} (${schedule.timezone})`;
  }
  if (schedule.mode === "cron") {
    return `Cron ${schedule.cron} (${schedule.timezone})`;
  }
  return `Weekly ${schedule.time} (${schedule.timezone}) · weekdays ${schedule.weekdays.join(",")}`;
}

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
    scheduleMode: "interval" as ScheduleMode,
    scheduleTime: "08:00",
    scheduleTimezone: "UTC",
    scheduleWeekdays: "1",
    cronExpression: "0 8 * * *",
    sessionTargetKind: "owner_chat",
    sessionChatId: "",
    sessionThreadId: "",
    automationSessionKey: "",
    retryEnabled: true,
    retryMaxAttempts: "4",
    retryBackoffSeconds: "300,900,3600",
    retryConditions: "executor_unavailable,task_failed",
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
          sessionTarget: form.sessionTargetKind === "telegram_chat"
            ? {
                kind: "telegram_chat",
                telegramChatId: form.sessionChatId || null,
                telegramThreadId: form.sessionThreadId ? Number(form.sessionThreadId) : null,
              }
            : form.sessionTargetKind === "isolated_automation_session"
              ? {
                  kind: "isolated_automation_session",
                  automationSessionKey: form.automationSessionKey || null,
                  telegramChatId: form.sessionChatId || null,
                  telegramThreadId: form.sessionThreadId ? Number(form.sessionThreadId) : null,
                }
            : {
                kind: "owner_chat",
              },
          retryPolicy: {
            enabled: form.retryEnabled,
            maxAttempts: Number(form.retryMaxAttempts || "1"),
            backoffSeconds: form.retryBackoffSeconds
              .split(/[,\s]+/)
              .map((item) => Number(item.trim()))
              .filter((item) => Number.isInteger(item) && item > 0),
            retryOn: form.retryConditions
              .split(/[,\s]+/)
              .map((item) => item.trim())
              .filter(Boolean),
          },
          config:
            form.kind === "schedule"
              ? buildScheduleConfig(form)
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
      const schedule = readScheduleConfig(config);
      const sessionTarget = (trigger.sessionTarget ?? {}) as Record<string, unknown>;
      const retryPolicy = (trigger.retryPolicy ?? {}) as Record<string, unknown>;
      setForm({
        taskId: String(trigger.taskId ?? ""),
        label: String(trigger.label ?? ""),
        kind: String(trigger.kind ?? "manual"),
        enabled: Boolean(trigger.enabled),
        intervalMinutes: String(config.intervalMinutes ?? config.everyMinutes ?? "60"),
        scheduleMode: schedule.mode as ScheduleMode,
        scheduleTime: schedule.time,
        scheduleTimezone: schedule.timezone,
        scheduleWeekdays: schedule.weekdays.join(","),
        cronExpression: schedule.cron,
        sessionTargetKind: String(sessionTarget.kind ?? "owner_chat"),
        sessionChatId: String(sessionTarget.telegramChatId ?? ""),
        sessionThreadId: String(sessionTarget.telegramThreadId ?? ""),
        automationSessionKey: String(sessionTarget.automationSessionKey ?? ""),
        retryEnabled: retryPolicy.enabled !== false,
        retryMaxAttempts: String(retryPolicy.maxAttempts ?? "1"),
        retryBackoffSeconds: Array.isArray(retryPolicy.backoffSeconds)
          ? retryPolicy.backoffSeconds.join(",")
          : "",
        retryConditions: Array.isArray(retryPolicy.retryOn)
          ? retryPolicy.retryOn.join(",")
          : "executor_unavailable",
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
                  {trigger.kind === "schedule" ? (
                    <p className="text-xs text-slate-500">
                      {describeSchedule((trigger.config ?? {}) as Record<string, unknown>)}
                    </p>
                  ) : null}
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
            <>
              <div>
                <p className="mb-2 text-sm font-medium text-slate-900">Schedule Mode</p>
                <SelectField
                  value={form.scheduleMode}
                  onChange={(next) =>
                    setForm((current) => ({
                      ...current,
                      scheduleMode: next as ScheduleMode,
                    }))
                  }
                  options={[
                    { value: "interval", label: "Interval" },
                    { value: "daily", label: "Daily" },
                    { value: "weekly", label: "Weekly" },
                    { value: "cron", label: "Cron" },
                  ]}
                />
              </div>
              {form.scheduleMode === "interval" ? (
                <Input
                  value={form.intervalMinutes}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, intervalMinutes: event.target.value }))
                  }
                  placeholder="Interval minutes"
                />
              ) : form.scheduleMode === "cron" ? (
                <>
                  <Input
                    value={form.cronExpression}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, cronExpression: event.target.value }))
                    }
                    placeholder="0 8 * * 1-5"
                  />
                  <Input
                    value={form.scheduleTimezone}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, scheduleTimezone: event.target.value }))
                    }
                    placeholder="UTC"
                  />
                </>
              ) : (
                <>
                  <Input
                    value={form.scheduleTime}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, scheduleTime: event.target.value }))
                    }
                    placeholder="08:00"
                  />
                  <Input
                    value={form.scheduleTimezone}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, scheduleTimezone: event.target.value }))
                    }
                    placeholder="UTC"
                  />
                  {form.scheduleMode === "weekly" ? (
                    <Input
                      value={form.scheduleWeekdays}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, scheduleWeekdays: event.target.value }))
                      }
                      placeholder="1,3,5"
                    />
                  ) : null}
                </>
              )}
            </>
          ) : null}
          <div>
            <p className="mb-2 text-sm font-medium text-slate-900">Session Target</p>
            <SelectField
              value={form.sessionTargetKind}
              onChange={(next) => setForm((current) => ({ ...current, sessionTargetKind: next }))}
              options={[
                { value: "owner_chat", label: "Owner Chat" },
                { value: "telegram_chat", label: "Custom Telegram Chat" },
                { value: "isolated_automation_session", label: "Isolated Automation Session" },
              ]}
            />
          </div>
          {form.sessionTargetKind === "telegram_chat" || form.sessionTargetKind === "isolated_automation_session" ? (
            <>
              {form.sessionTargetKind === "isolated_automation_session" ? (
                <Input
                  value={form.automationSessionKey}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, automationSessionKey: event.target.value }))
                  }
                  placeholder="task:daily-ops"
                />
              ) : null}
              <Input
                value={form.sessionChatId}
                onChange={(event) =>
                  setForm((current) => ({ ...current, sessionChatId: event.target.value }))
                }
                placeholder="Telegram chat id"
              />
              <Input
                value={form.sessionThreadId}
                onChange={(event) =>
                  setForm((current) => ({ ...current, sessionThreadId: event.target.value }))
                }
                placeholder="Telegram thread id (optional)"
              />
            </>
          ) : null}
          <label className="flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm">
            <input
              type="checkbox"
              checked={form.retryEnabled}
              onChange={(event) =>
                setForm((current) => ({ ...current, retryEnabled: event.target.checked }))
              }
            />
            Retry Policy Enabled
          </label>
          {form.retryEnabled ? (
            <>
              <Input
                value={form.retryMaxAttempts}
                onChange={(event) =>
                  setForm((current) => ({ ...current, retryMaxAttempts: event.target.value }))
                }
                placeholder="Max attempts"
              />
              <Input
                value={form.retryBackoffSeconds}
                onChange={(event) =>
                  setForm((current) => ({ ...current, retryBackoffSeconds: event.target.value }))
                }
                placeholder="300,900,3600"
              />
              <Input
                value={form.retryConditions}
                onChange={(event) =>
                  setForm((current) => ({ ...current, retryConditions: event.target.value }))
                }
                placeholder="executor_unavailable,task_failed"
              />
            </>
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
