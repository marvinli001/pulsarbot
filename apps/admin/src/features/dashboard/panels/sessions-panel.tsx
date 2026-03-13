import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Panel,
} from "@pulsarbot/ui-kit";
import { apiFetch } from "../../../lib/api.js";
import { notificationOccurred } from "../../../lib/telegram.js";
import {
  JsonPanel,
  formatJson,
  useApprovals,
  useTaskRuns,
} from "../shared.js";

export function SessionsPanel() {
  const taskRuns = useTaskRuns();
  const approvals = useApprovals();
  const queryClient = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState("");

  const selectedRun = useMemo(
    () => (taskRuns.data ?? []).find((run) => String(run.sessionId ?? "") === selectedSessionId) ?? null,
    [selectedSessionId, taskRuns.data],
  );
  const selectedApproval = useMemo(
    () =>
      (approvals.data ?? []).find((approval) =>
        selectedRun && String(approval.taskRunId ?? "") === String(selectedRun.id ?? "")
      ) ?? null,
    [approvals.data, selectedRun],
  );

  const sessionState = useQuery({
    queryKey: ["session-state", selectedSessionId],
    queryFn: () => apiFetch(`/api/system/turns/${encodeURIComponent(selectedSessionId)}/state`),
    enabled: Boolean(selectedSessionId),
  });
  const sessionEvents = useQuery({
    queryKey: ["session-events", selectedSessionId],
    queryFn: () => apiFetch(`/api/system/turns/${encodeURIComponent(selectedSessionId)}/events`),
    enabled: Boolean(selectedSessionId),
    refetchInterval: 10_000,
  });

  const approvalMutation = useMutation({
    mutationFn: (decision: "approved" | "rejected") =>
      apiFetch("/api/approvals", {
        method: "POST",
        body: JSON.stringify({
          approvalId: String(selectedApproval?.id ?? ""),
          decision,
        }),
      }),
    onSuccess: async () => {
      notificationOccurred("success");
      await queryClient.invalidateQueries({ queryKey: ["approvals"] });
      await queryClient.invalidateQueries({ queryKey: ["task-runs"] });
      await queryClient.invalidateQueries({ queryKey: ["session-state", selectedSessionId] });
      await queryClient.invalidateQueries({ queryKey: ["session-events", selectedSessionId] });
      await queryClient.invalidateQueries({ queryKey: ["system-health"] });
    },
    onError: () => notificationOccurred("error"),
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
      <Panel
        title="Sessions"
        subtitle="Task runs reuse the existing turn event timeline through task-session IDs."
      >
        <div className="space-y-3">
          {(taskRuns.data ?? []).map((run) => (
            <button
              key={String(run.id)}
              type="button"
              onClick={() => setSelectedSessionId(String(run.sessionId ?? ""))}
              className="w-full rounded-2xl border border-slate-200 p-4 text-left transition hover:bg-slate-50"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-medium">{String(run.taskId ?? run.id ?? "")}</p>
                  <p className="text-sm text-slate-500">
                    {String(run.triggerType ?? "manual")} · {String(run.templateKind ?? "unknown")}
                  </p>
                  <p className="text-xs text-slate-500">{String(run.sessionId ?? "")}</p>
                </div>
                <Badge tone={String(run.status) === "completed" ? "success" : "warning"}>
                  {String(run.status ?? "queued")}
                </Badge>
              </div>
            </button>
          ))}
        </div>
      </Panel>

      <div className="grid gap-6">
        <Panel
          title="Selected Session"
          subtitle={selectedRun ? `Task run ${String(selectedRun.id ?? "")}` : "Select a session to inspect."}
          actions={
            selectedApproval && String(selectedApproval.status) === "pending"
              ? (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      tone="secondary"
                      onClick={() => approvalMutation.mutate("approved")}
                    >
                      Approve
                    </Button>
                    <Button
                      type="button"
                      tone="ghost"
                      onClick={() => approvalMutation.mutate("rejected")}
                    >
                      Reject
                    </Button>
                  </div>
                )
              : undefined
          }
        >
          <pre className="overflow-x-auto rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
            {formatJson({
              taskRun: selectedRun,
              approval: selectedApproval,
              sessionState: sessionState.data ?? null,
            })}
          </pre>
        </Panel>

        <JsonPanel
          title="Session Events"
          subtitle="Planner/tool/task/executor events converge here."
          value={sessionEvents.data ?? []}
        />
      </div>
    </div>
  );
}
