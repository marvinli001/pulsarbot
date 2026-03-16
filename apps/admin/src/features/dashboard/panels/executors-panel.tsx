import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  formatJson,
  useExecutors,
  executorCapabilityOptions,
  executorKindOptions,
} from "../shared.js";

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function kindLabel(value: unknown) {
  if (value === "chrome_extension") {
    return "Chrome Extension";
  }
  if (value === "cloud_browser") {
    return "Cloud Browser";
  }
  return "Companion";
}

function originMatchesAllowlist(origin: unknown, allowedHosts: string[]): boolean {
  if (typeof origin !== "string" || allowedHosts.length === 0) {
    return false;
  }
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return allowedHosts.some((pattern) => {
      const normalized = pattern.trim().toLowerCase();
      if (!normalized) {
        return false;
      }
      if (normalized.startsWith("*.")) {
        return hostname.endsWith(normalized.slice(1));
      }
      return hostname === normalized;
    });
  } catch {
    return false;
  }
}

function chromeExtensionStatusMeta(executor: Record<string, unknown>) {
  const attachment = (executor.browserAttachment ?? {}) as Record<string, unknown>;
  const scopes = (executor.scopes ?? {}) as Record<string, unknown>;
  const allowedHosts = Array.isArray(scopes.allowedHosts)
    ? scopes.allowedHosts.map((item) => String(item))
    : [];
  const attached = String(attachment.state ?? "detached") === "attached";
  const origin = typeof attachment.origin === "string" ? attachment.origin : "";
  const allowlisted = attached && originMatchesAllowlist(origin, allowedHosts);

  if (String(executor.status ?? "") === "pending_pairing") {
    return {
      tone: "warning" as const,
      headline: "Waiting for extension pair",
      detail: "Paste the pairing code into the extension popup, then click Pair.",
    };
  }
  if (String(executor.status ?? "") !== "online") {
    return {
      tone: "warning" as const,
      headline: "Extension is offline",
      detail: "Open the extension popup, confirm it is paired, then send a heartbeat.",
    };
  }
  if (!attached) {
    return {
      tone: "warning" as const,
      headline: "Browser not attached",
      detail: "Bring the target site to the front in Chrome, then click Attach Current Window.",
    };
  }
  if (!allowlisted) {
    return {
      tone: "danger" as const,
      headline: "Attached site is outside the allowlist",
      detail: "Update allowed hosts or force-detach and re-attach the correct site.",
    };
  }
  return {
    tone: "success" as const,
    headline: "Ready for browser workflows",
    detail: "The attached tab is inside the allowlist and can accept browser assignments.",
  };
}

export function ExecutorsPanel() {
  const executors = useExecutors();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [form, setForm] = useState({
    label: "Owner Companion",
    kind: "companion",
    capabilities: ["browser", "http"],
    allowedHosts: "",
    allowedPaths: "",
    allowedCommands: "",
    fsRequiresApproval: true,
    shellRequiresApproval: true,
  });

  const activeExecutor = useMemo(
    () => (executors.data ?? []).find((executor) => String(executor.id ?? "") === editingId) ?? null,
    [editingId, executors.data],
  );
  const isChromeExtension = form.kind === "chrome_extension";
  const activeChromeStatus = useMemo(
    () => (
      activeExecutor?.kind === "chrome_extension"
        ? chromeExtensionStatusMeta(activeExecutor)
        : null
    ),
    [activeExecutor],
  );

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/executors", {
        method: "POST",
        body: JSON.stringify({
          ...(editingId ? { id: editingId } : {}),
          label: form.label,
          kind: form.kind,
          capabilities: form.kind === "chrome_extension" ? ["browser"] : form.capabilities,
          scopes: {
            allowedHosts: parseCsv(form.allowedHosts),
            allowedPaths: form.kind === "companion" ? parseCsv(form.allowedPaths) : [],
            allowedCommands: form.kind === "companion" ? parseCsv(form.allowedCommands) : [],
            fsRequiresApproval: form.kind === "companion" ? form.fsRequiresApproval : true,
            shellRequiresApproval: form.kind === "companion" ? form.shellRequiresApproval : true,
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

  const forceDetachMutation = useMutation({
    mutationFn: (executorId: string) =>
      apiFetch(`/api/executors/${executorId}/force-detach`, {
        method: "POST",
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["executors"] });
      await queryClient.invalidateQueries({ queryKey: ["task-runs"] });
      await queryClient.invalidateQueries({ queryKey: ["system-health"] });
    },
    onError: () => notificationOccurred("error"),
  });

  const loadExecutor = (executor: Record<string, unknown>) => {
    selectionChanged();
    setEditingId(String(executor.id ?? ""));
    const scopes = (executor.scopes ?? {}) as Record<string, unknown>;
    const kind = String(executor.kind ?? "companion");
    setForm({
      label: String(executor.label ?? ""),
      kind,
      capabilities: kind === "chrome_extension"
        ? ["browser"]
        : Array.isArray(executor.capabilities)
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
        subtitle="Browser-only Chrome extensions and native companions both plug into the same control plane."
      >
        <div className="space-y-3">
          {(executors.data ?? []).map((executor) => {
            const attachment = (executor.browserAttachment ?? {}) as Record<string, unknown>;
            const attached = String(attachment.state ?? "detached") === "attached";
            const chromeStatus = executor.kind === "chrome_extension"
              ? chromeExtensionStatusMeta(executor)
              : null;
            return (
              <div key={String(executor.id)} className="rounded-2xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="font-medium">{String(executor.label ?? executor.id ?? "")}</p>
                    <p className="text-sm text-slate-500">
                      {kindLabel(executor.kind)} · {String(executor.status ?? "offline")} · {String(executor.platform ?? "unknown")}
                    </p>
                    <p className="text-xs text-slate-500">
                      {(Array.isArray(executor.capabilities) ? executor.capabilities : []).join(", ") || "No capabilities"}
                    </p>
                    {executor.kind === "chrome_extension" ? (
                      <>
                        <p className="text-xs text-slate-500">
                          Attach: {attached ? "attached" : "detached"}
                          {attachment.origin ? ` · ${String(attachment.origin)}` : ""}
                        </p>
                        {attachment.profileLabel ? (
                          <p className="text-xs text-slate-500">
                            Profile: {String(attachment.profileLabel)}
                          </p>
                        ) : null}
                        {attachment.attachedAt ? (
                          <p className="text-xs text-slate-500">
                            Attached at: {String(attachment.attachedAt)}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                    {chromeStatus ? (
                      <div
                        className={[
                          "mt-2 rounded-2xl border px-3 py-2 text-xs",
                          chromeStatus.tone === "success"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                            : chromeStatus.tone === "danger"
                              ? "border-rose-200 bg-rose-50 text-rose-900"
                              : "border-amber-200 bg-amber-50 text-amber-900",
                        ].join(" ")}
                      >
                        <p className="font-medium">{chromeStatus.headline}</p>
                        <p className="mt-1 opacity-90">{chromeStatus.detail}</p>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge tone={String(executor.status) === "online" ? "success" : "warning"}>
                      {String(executor.status ?? "offline")}
                    </Badge>
                    {executor.kind === "chrome_extension" ? (
                      <Badge tone={attached ? "success" : "warning"}>
                        {attached ? "Attached" : "Detached"}
                      </Badge>
                    ) : null}
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
                    {executor.kind === "chrome_extension" ? (
                      <Button
                        type="button"
                        tone="ghost"
                        onClick={() => forceDetachMutation.mutate(String(executor.id ?? ""))}
                        disabled={forceDetachMutation.isPending}
                      >
                        Force Detach
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <div className="grid gap-6">
        <Panel
          title={editingId ? "Edit Executor" : "Create Executor"}
          subtitle={isChromeExtension
            ? "Chrome extension executors only expose browser capability and require explicit attach."
            : "Companion executors own higher-risk browser, http, fs, and shell execution."}
          actions={<MutationBadge mutation={saveMutation} successLabel="Executor Saved" />}
        >
          <div className="grid gap-3">
            <Input
              value={form.label}
              onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
              placeholder="Executor label"
            />
            <ResourceSelectField
              label="Kind"
              hint="Cloud browser is reserved for a later phase; phase1 supports companion and Chrome extension."
              value={form.kind}
              onChange={(next) =>
                setForm((current) => ({
                  ...current,
                  kind: next,
                  capabilities: next === "chrome_extension" ? ["browser"] : current.capabilities,
                  allowedPaths: next === "chrome_extension" ? "" : current.allowedPaths,
                  allowedCommands: next === "chrome_extension" ? "" : current.allowedCommands,
                  fsRequiresApproval: next === "chrome_extension" ? true : current.fsRequiresApproval,
                  shellRequiresApproval: next === "chrome_extension" ? true : current.shellRequiresApproval,
                }))
              }
              options={[...executorKindOptions]}
              selectAriaLabel="Executor kind"
            />
            {isChromeExtension ? (
              <div className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600">
                Chrome extension executors are browser-only in phase1. They use explicit attach/detach and the current tab in one attached browser window.
              </div>
            ) : (
              <CheckboxListField
                label="Capabilities"
                hint="Companion v1 capabilities."
                options={[...executorCapabilityOptions]}
                values={form.capabilities}
                onChange={(next) => setForm((current) => ({ ...current, capabilities: next }))}
              />
            )}
            <Input
              value={form.allowedHosts}
              onChange={(event) =>
                setForm((current) => ({ ...current, allowedHosts: event.target.value }))
              }
              placeholder="Allowed hosts (comma separated)"
            />
            {isChromeExtension ? (
              <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-600">
                推荐在 Chrome 里单独使用 dedicated profile，并只 attach 到你愿意让 agent 继承登录态的站点。
              </div>
            ) : (
              <>
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
              </>
            )}
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
          subtitle={activeExecutor?.kind === "chrome_extension"
            ? "Use this short-lived code in the unpacked Chrome extension, then explicitly attach a browser window."
            : "Use this one-time code in the companion process to claim the executor."}
          actions={
            editingId ? (
              <Button type="button" tone="secondary" onClick={() => pairMutation.mutate(editingId)}>
                Refresh Pair Code
              </Button>
            ) : undefined
          }
        >
          <TextArea value={pairingCode} readOnly rows={4} placeholder="No pairing code yet." />
          {activeChromeStatus ? (
            <div
              className={[
                "mt-3 rounded-2xl border px-4 py-3 text-sm",
                activeChromeStatus.tone === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : activeChromeStatus.tone === "danger"
                    ? "border-rose-200 bg-rose-50 text-rose-900"
                    : "border-amber-200 bg-amber-50 text-amber-900",
              ].join(" ")}
            >
              <p className="font-medium">{activeChromeStatus.headline}</p>
              <p className="mt-1 text-xs opacity-90">{activeChromeStatus.detail}</p>
            </div>
          ) : null}
          <pre className="mt-3 overflow-x-auto rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
            {formatJson(
              activeExecutor?.kind === "chrome_extension"
                ? {
                    installUnpackedPath: "apps/chrome-extension/dist",
                    steps: [
                      "Build the repo so the unpacked extension exists.",
                      "Open chrome://extensions and enable Developer mode.",
                      "Load unpacked -> apps/chrome-extension/dist.",
                      "Open the extension popup and paste server URL, executor ID, and pairing code.",
                      "Pair first, then bring the target browser window to front and click Attach Current Window.",
                    ],
                  }
                : {
                    commandExample: editingId
                      ? `PULSARBOT_SERVER_URL=https://your-server PULSARBOT_EXECUTOR_ID=${editingId} PULSARBOT_PAIRING_CODE=${pairingCode || "<pairing-code>"} npm exec --yes pnpm@10.6.3 --filter @pulsarbot/companion dev`
                      : "Create and pair an executor first.",
                  },
            )}
          </pre>
        </Panel>
      </div>
    </div>
  );
}
