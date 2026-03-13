import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
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
  formatJson,
  useExecutors,
  executorCapabilityOptions,
} from "../shared.js";

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ExecutorsPanel() {
  const executors = useExecutors();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [form, setForm] = useState({
    label: "Owner Companion",
    capabilities: ["browser", "http"],
    allowedHosts: "",
    allowedPaths: "",
    allowedCommands: "",
    fsRequiresApproval: true,
    shellRequiresApproval: true,
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/executors", {
        method: "POST",
        body: JSON.stringify({
          ...(editingId ? { id: editingId } : {}),
          label: form.label,
          capabilities: form.capabilities,
          scopes: {
            allowedHosts: parseCsv(form.allowedHosts),
            allowedPaths: parseCsv(form.allowedPaths),
            allowedCommands: parseCsv(form.allowedCommands),
            fsRequiresApproval: form.fsRequiresApproval,
            shellRequiresApproval: form.shellRequiresApproval,
          },
        }),
      }),
    onSuccess: async (data) => {
      notificationOccurred("success");
      setEditingId(String((data as Record<string, unknown>).id ?? ""));
      await queryClient.invalidateQueries({ queryKey: ["executors"] });
      await queryClient.invalidateQueries({ queryKey: ["system-health"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const pairMutation = useMutation({
    mutationFn: (executorId: string) =>
      apiFetch<{ pairingCode: string }>(`/api/executors/${executorId}/pair`, {
        method: "POST",
      }),
    onSuccess: async (data, executorId) => {
      notificationOccurred("success");
      setEditingId(executorId);
      setPairingCode(data.pairingCode);
      await queryClient.invalidateQueries({ queryKey: ["executors"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const loadExecutor = (executor: Record<string, unknown>) => {
    selectionChanged();
    setEditingId(String(executor.id ?? ""));
    const scopes = (executor.scopes ?? {}) as Record<string, unknown>;
    setForm({
      label: String(executor.label ?? ""),
      capabilities: Array.isArray(executor.capabilities)
        ? executor.capabilities.map((item) => String(item))
        : [],
      allowedHosts: Array.isArray(scopes.allowedHosts)
        ? scopes.allowedHosts.map((item) => String(item)).join(", ")
        : "",
      allowedPaths: Array.isArray(scopes.allowedPaths)
        ? scopes.allowedPaths.map((item) => String(item)).join(", ")
        : "",
      allowedCommands: Array.isArray(scopes.allowedCommands)
        ? scopes.allowedCommands.map((item) => String(item)).join(", ")
        : "",
      fsRequiresApproval: Boolean(scopes.fsRequiresApproval ?? true),
      shellRequiresApproval: Boolean(scopes.shellRequiresApproval ?? true),
    });
  };

  useTelegramMainButton({
    text: editingId ? "Update Executor" : "Create Executor",
    isVisible: true,
    isEnabled: !saveMutation.isPending,
    isProgressVisible: saveMutation.isPending,
    onClick: () => saveMutation.mutate(),
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr,1fr]">
      <Panel
        title="Executors"
        subtitle="Companion nodes own higher-risk browser, http, fs, and shell execution."
      >
        <div className="space-y-3">
          {(executors.data ?? []).map((executor) => (
            <div key={String(executor.id)} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-medium">{String(executor.label ?? executor.id ?? "")}</p>
                  <p className="text-sm text-slate-500">
                    {String(executor.status ?? "offline")} · {String(executor.platform ?? "unknown")}
                  </p>
                  <p className="text-xs text-slate-500">
                    {(Array.isArray(executor.capabilities) ? executor.capabilities : []).join(", ") || "No capabilities"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" tone="ghost" onClick={() => loadExecutor(executor)}>
                    Load
                  </Button>
                  <Button
                    type="button"
                    tone="secondary"
                    onClick={() => pairMutation.mutate(String(executor.id ?? ""))}
                  >
                    Pair
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid gap-6">
        <Panel
          title={editingId ? "Edit Executor" : "Create Executor"}
          subtitle="配对后 companion 主动回连服务端；默认最小权限。"
          actions={<MutationBadge mutation={saveMutation} successLabel="Executor Saved" />}
        >
          <div className="grid gap-3">
            <Input
              value={form.label}
              onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
              placeholder="Executor label"
            />
            <CheckboxListField
              label="Capabilities"
              hint="Companion v1 capabilities."
              options={[...executorCapabilityOptions]}
              values={form.capabilities}
              onChange={(next) => setForm((current) => ({ ...current, capabilities: next }))}
            />
            <Input
              value={form.allowedHosts}
              onChange={(event) =>
                setForm((current) => ({ ...current, allowedHosts: event.target.value }))
              }
              placeholder="Allowed hosts (comma separated)"
            />
            <Input
              value={form.allowedPaths}
              onChange={(event) =>
                setForm((current) => ({ ...current, allowedPaths: event.target.value }))
              }
              placeholder="Allowed paths (comma separated)"
            />
            <Input
              value={form.allowedCommands}
              onChange={(event) =>
                setForm((current) => ({ ...current, allowedCommands: event.target.value }))
              }
              placeholder="Allowed commands (comma separated)"
            />
            <label className="flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm">
              <input
                type="checkbox"
                checked={form.fsRequiresApproval}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    fsRequiresApproval: event.target.checked,
                  }))
                }
              />
              Filesystem actions require approval
            </label>
            <label className="flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm">
              <input
                type="checkbox"
                checked={form.shellRequiresApproval}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    shellRequiresApproval: event.target.checked,
                  }))
                }
              />
              Shell actions require approval
            </label>
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
              >
                {editingId ? "Update Executor" : "Create Executor"}
              </Button>
            </div>
          </div>
        </Panel>

        <Panel
          title="Pairing Code"
          subtitle="Use this one-time code in the companion process to claim the executor."
          actions={
            editingId ? (
              <Button type="button" tone="secondary" onClick={() => pairMutation.mutate(editingId)}>
                Refresh Pair Code
              </Button>
            ) : undefined
          }
        >
          <TextArea value={pairingCode} readOnly rows={4} placeholder="No pairing code yet." />
          <pre className="mt-3 overflow-x-auto rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
            {formatJson({
              commandExample: editingId
                ? `PULSARBOT_SERVER_URL=https://your-server PULSARBOT_EXECUTOR_ID=${editingId} PULSARBOT_PAIRING_CODE=${pairingCode || "<pairing-code>"} npm exec --yes pnpm@10.6.3 --filter @pulsarbot/companion dev`
                : "Create and pair an executor first.",
            })}
          </pre>
        </Panel>
      </div>
    </div>
  );
}
