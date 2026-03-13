import process from "node:process";
import { createLogger, nowIso } from "@pulsarbot/core";
import {
  executeAssignment,
  type CompanionAssignment,
  type CompanionExecutionLogEntry,
} from "./runtime.js";

const logger = createLogger({ name: "companion" });

interface CompanionConfig {
  serverUrl: string;
  executorId: string;
  pairingCode: string | null;
  executorToken: string | null;
  intervalMs: number;
  capabilities: string[];
  autoComplete: boolean;
}

function readConfig(): CompanionConfig {
  const serverUrl = process.env.PULSARBOT_SERVER_URL?.trim();
  const executorId = process.env.PULSARBOT_EXECUTOR_ID?.trim();
  if (!serverUrl || !executorId) {
    throw new Error(
      "PULSARBOT_SERVER_URL and PULSARBOT_EXECUTOR_ID are required for the companion.",
    );
  }
  return {
    serverUrl: serverUrl.replace(/\/+$/, ""),
    executorId,
    pairingCode: process.env.PULSARBOT_PAIRING_CODE?.trim() || null,
    executorToken: process.env.PULSARBOT_EXECUTOR_TOKEN?.trim() || null,
    intervalMs: Number(process.env.PULSARBOT_HEARTBEAT_INTERVAL_MS ?? 15_000),
    capabilities: (process.env.PULSARBOT_CAPABILITIES ?? "browser,http,fs,shell")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    autoComplete: process.env.PULSARBOT_COMPANION_AUTO_COMPLETE === "1",
  };
}

async function postJson<T>(url: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(typeof parsed === "string" ? parsed : JSON.stringify(parsed));
  }
  return parsed as T;
}

async function main() {
  const config = readConfig();
  let executorToken = config.executorToken;
  const completedRuns: Array<{
    taskRunId: string;
    status: "completed" | "failed" | "aborted";
    outputSummary: string;
    artifacts?: unknown[];
    logs?: CompanionExecutionLogEntry[];
    error?: string;
  }> = [];
  const pendingLogs: CompanionExecutionLogEntry[] = [];
  let currentScopes = {
    allowedHosts: [] as string[],
    allowedPaths: [] as string[],
    allowedCommands: [] as string[],
    fsRequiresApproval: true,
    shellRequiresApproval: true,
  };

  logger.info(
    {
      executorId: config.executorId,
      serverUrl: config.serverUrl,
      capabilities: config.capabilities,
    },
    "Starting Pulsarbot companion",
  );

  const queueLog = (
    level: CompanionExecutionLogEntry["level"],
    event: string,
    message: string,
    detail: Record<string, unknown> = {},
    taskRunId: string | null = null,
  ) => {
    pendingLogs.push({
      taskRunId,
      scope: "heartbeat",
      level,
      event,
      message,
      detail: JSON.parse(JSON.stringify(detail)) as Record<string, unknown>,
      occurredAt: nowIso(),
    });
    if (pendingLogs.length > 1_000) {
      pendingLogs.splice(0, pendingLogs.length - 1_000);
    }
  };

  queueLog("info", "companion_starting", "Companion process starting", {
    executorId: config.executorId,
    serverUrl: config.serverUrl,
    capabilities: config.capabilities,
  });

  const sendHeartbeat = async () => {
    const completedRunBatch = completedRuns.slice();
    const companionLogBatch = pendingLogs.slice();
    const response = await postJson<{
      ok: boolean;
      paired?: boolean;
      executorToken?: string | null;
      executor?: {
        scopes?: typeof currentScopes;
      };
      assignments?: CompanionAssignment[];
    }>(
      `${config.serverUrl}/api/executors/${encodeURIComponent(config.executorId)}/heartbeat`,
      {
        ...(executorToken
          ? {
              executorToken,
            }
          : {
              pairingCode: config.pairingCode,
            }),
        version: "0.1.0",
        platform: `${process.platform}-${process.arch}`,
        capabilities: config.capabilities,
        metadata: {
          pid: process.pid,
          node: process.version,
        },
        completedRuns: completedRunBatch,
        companionLogs: companionLogBatch,
      },
    );
    completedRuns.splice(0, completedRunBatch.length);
    pendingLogs.splice(0, companionLogBatch.length);

    if (response.executor?.scopes) {
      currentScopes = {
        ...currentScopes,
        ...response.executor.scopes,
      };
    }

    if (response.executorToken) {
      executorToken = response.executorToken;
      logger.info(
        { executorId: config.executorId, executorToken },
        "Executor paired successfully. Persist this executor token for subsequent runs.",
      );
      queueLog("info", "companion_paired", "Executor paired successfully", {
        executorId: config.executorId,
      });
    }

    const assignments = response.assignments ?? [];
    if (assignments.length > 0) {
      logger.info({ assignments }, "Received task assignments");
      queueLog("info", "assignments_received", "Received task assignments", {
        assignmentCount: assignments.length,
      });
      for (const assignment of assignments) {
        try {
          if (config.autoComplete) {
            completedRuns.push({
              taskRunId: assignment.id,
              status: "completed",
              outputSummary: `Auto-completed by companion stub for ${String(assignment.templateKind ?? "unknown")} (${String(assignment.taskId ?? "no-task")}).`,
              logs: [
                {
                  taskRunId: assignment.id,
                  scope: "assignment",
                  level: "info",
                  event: "assignment_auto_completed",
                  message: "Assignment auto-completed by companion stub.",
                  detail: {
                    templateKind: String(assignment.templateKind ?? "unknown"),
                    taskId: String(assignment.taskId ?? "no-task"),
                  },
                  occurredAt: nowIso(),
                },
              ],
            });
            continue;
          }
          const result = await executeAssignment({
            assignment,
            scopes: currentScopes,
          });
          const completedRun = {
            taskRunId: result.taskRunId,
            status: result.status,
            outputSummary: result.outputSummary,
            artifacts: result.artifacts,
            logs: result.logs,
            ...(result.error ? { error: result.error } : {}),
          };
          completedRuns.push(completedRun);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          completedRuns.push({
            taskRunId: assignment.id,
            status: "failed",
            outputSummary: `Execution failed for ${assignment.id}`,
            error: message,
            logs: [
              {
                taskRunId: assignment.id,
                scope: "assignment",
                level: "error",
                event: "assignment_crashed",
                message: "Assignment crashed before a structured result could be produced.",
                detail: {
                  error: message,
                },
                occurredAt: nowIso(),
              },
            ],
          });
        }
      }
    }
  };

  await sendHeartbeat();
  const scheduleNextHeartbeat = () => {
    setTimeout(() => {
      void sendHeartbeat()
        .catch((error) => {
          logger.error(
            { error: error instanceof Error ? error.message : String(error) },
            "Companion heartbeat failed",
          );
        })
        .finally(scheduleNextHeartbeat);
    }, config.intervalMs);
  };
  scheduleNextHeartbeat();
}

void main().catch((error) => {
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    "Companion failed to start",
  );
  process.exit(1);
});
