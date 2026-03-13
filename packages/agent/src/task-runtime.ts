import { createId, nowIso } from "@pulsarbot/core";
import {
  ApprovalRequestSchema,
  TaskRunSchema,
  type ApprovalRequest,
  type ExecutorCapability,
  type ExecutorNode,
  type Task,
  type TaskRun,
  type TaskTriggerKind,
  type WorkflowApprovalCheckpoint,
} from "@pulsarbot/shared";
import { runGraph } from "./graph/index.js";

function configuredExecutorCapability(task: Task): ExecutorCapability | null {
  const action = task.config.executorAction;
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return null;
  }
  const capability = (action as { capability?: unknown }).capability;
  return typeof capability === "string"
    ? capability as ExecutorCapability
    : null;
}

function requiredCapabilitiesForTask(task: Task): ExecutorCapability[] {
  const configuredCapability = configuredExecutorCapability(task);
  if (configuredCapability) {
    return [configuredCapability];
  }
  switch (task.templateKind) {
    case "web_watch_report":
      return ["http"];
    case "browser_workflow":
      return ["browser"];
    case "telegram_followup":
      return ["http"];
    case "webhook_fetch_analyze_push":
      return ["http"];
    case "document_digest_memory":
    default:
      return [];
  }
}

function requiresExecutor(task: Task): boolean {
  return requiredCapabilitiesForTask(task).length > 0;
}

function hasTaskCheckpoint(
  task: Task,
  checkpoint: WorkflowApprovalCheckpoint,
): boolean {
  return task.approvalCheckpoints.includes(checkpoint);
}

function taskHasTelegramPush(task: Task): boolean {
  const telegramTarget = task.config.telegramTarget;
  if (!telegramTarget || typeof telegramTarget !== "object" || Array.isArray(telegramTarget)) {
    return false;
  }
  const chatId = (telegramTarget as { chatId?: unknown }).chatId;
  if (typeof chatId === "number") {
    return Number.isFinite(chatId);
  }
  return typeof chatId === "string" && chatId.trim().length > 0;
}

function taskWillWriteMemory(task: Task): boolean {
  if (task.memoryPolicy !== "task_context_writeback") {
    return false;
  }
  if (task.templateKind === "document_digest_memory") {
    return task.config.writebackSummary !== false;
  }
  return true;
}

function resolveApprovalRequirement(args: {
  task: Task;
  executor: ExecutorNode | null;
  requiredCapabilities: ExecutorCapability[];
}): {
  required: boolean;
  reason: string;
  checkpoints: WorkflowApprovalCheckpoint[];
} {
  const triggeredCheckpoints: WorkflowApprovalCheckpoint[] = [];

  if (args.task.approvalPolicy === "approval_required") {
    return {
      required: true,
      reason: "Task policy requires explicit owner approval.",
      checkpoints: args.task.approvalCheckpoints,
    };
  }

  if (hasTaskCheckpoint(args.task, "before_executor") && requiresExecutor(args.task)) {
    triggeredCheckpoints.push("before_executor");
  }
  if (
    hasTaskCheckpoint(args.task, "before_memory_writeback") &&
    taskWillWriteMemory(args.task)
  ) {
    triggeredCheckpoints.push("before_memory_writeback");
  }
  if (
    hasTaskCheckpoint(args.task, "before_telegram_push") &&
    taskHasTelegramPush(args.task)
  ) {
    triggeredCheckpoints.push("before_telegram_push");
  }
  if (
    hasTaskCheckpoint(args.task, "before_fs_write") &&
    args.requiredCapabilities.includes("fs")
  ) {
    triggeredCheckpoints.push("before_fs_write");
  }
  if (
    hasTaskCheckpoint(args.task, "before_shell") &&
    args.requiredCapabilities.includes("shell")
  ) {
    triggeredCheckpoints.push("before_shell");
  }

  if (
    args.task.approvalPolicy === "approval_for_write" &&
    args.executor
  ) {
    if (
      args.requiredCapabilities.includes("fs") &&
      args.executor.scopes.fsRequiresApproval &&
      !triggeredCheckpoints.includes("before_fs_write")
    ) {
      triggeredCheckpoints.push("before_fs_write");
    }
    if (
      args.requiredCapabilities.includes("shell") &&
      args.executor.scopes.shellRequiresApproval &&
      !triggeredCheckpoints.includes("before_shell")
    ) {
      triggeredCheckpoints.push("before_shell");
    }
  }

  if (triggeredCheckpoints.length === 0) {
    return {
      required: false,
      reason: "",
      checkpoints: [],
    };
  }

  return {
    required: true,
    reason: `Approval checkpoints triggered: ${triggeredCheckpoints.join(", ")}`,
    checkpoints: triggeredCheckpoints,
  };
}

export interface TaskRuntimeInput {
  workspaceId: string;
  task: Task;
  triggerType: TaskTriggerKind;
  triggerId?: string | null | undefined;
  executor?: ExecutorNode | null | undefined;
  inputSnapshot?: Record<string, unknown> | undefined;
  executionPlan?: Record<string, unknown> | undefined;
  sourceTurnId?: string | null | undefined;
  runId?: string;
  sessionId?: string;
  approvalExpiresAt?: string | null;
  now?: string;
}

export interface TaskRuntimePlanResult {
  taskRun: TaskRun;
  approval: ApprovalRequest | null;
}

interface TaskPlanningState {
  taskRun: TaskRun;
  task: Task;
  executor: ExecutorNode | null;
  approval: ApprovalRequest | null;
  requiredCapabilities: ExecutorCapability[];
}

export class TaskRuntime {
  public async stageRun(input: TaskRuntimeInput): Promise<TaskRuntimePlanResult> {
    const timestamp = input.now ?? nowIso();
    const taskRunId = input.runId ?? createId("taskrun");
    const sessionId = input.sessionId ?? `task-session:${taskRunId}`;
    const state: TaskPlanningState = {
      taskRun: TaskRunSchema.parse({
        id: taskRunId,
        workspaceId: input.workspaceId,
        taskId: input.task.id,
        templateKind: input.task.templateKind,
        status: "queued",
        triggerType: input.triggerType,
        triggerId: input.triggerId ?? null,
        executorId: input.executor?.id ?? input.task.defaultExecutorId ?? null,
        approvalId: null,
        sourceTurnId: input.sourceTurnId ?? null,
        sessionId,
        inputSnapshot: input.inputSnapshot ?? {},
        executionPlan: input.executionPlan ?? {},
        outputSummary: null,
        artifacts: [],
        relatedDocumentIds: input.task.relatedDocumentIds,
        relatedMemoryDocumentIds: [],
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        finishedAt: null,
      }),
      task: input.task,
      executor: input.executor ?? null,
      approval: null,
      requiredCapabilities: requiredCapabilitiesForTask(input.task),
    };

    await runGraph({
      state,
      context: {
        now: timestamp,
        approvalExpiresAt: input.approvalExpiresAt ?? null,
      },
      startNode: "bind_executor",
      nodes: {
        bind_executor: {
          id: "bind_executor",
          async run(args) {
            if (!requiresExecutor(args.state.task)) {
              return "evaluate_approval";
            }
            if (!args.state.executor || args.state.executor.status !== "online") {
              args.state.taskRun.status = "waiting_retry";
              args.state.taskRun.error = "Executor is required but unavailable or offline";
              args.state.taskRun.updatedAt = args.context.now;
              return "finalize";
            }
            const capabilitySet = new Set(args.state.executor.capabilities);
            const missingCapabilities = args.state.requiredCapabilities.filter((capability) =>
              !capabilitySet.has(capability)
            );
            if (missingCapabilities.length > 0) {
              args.state.taskRun.status = "waiting_retry";
              args.state.taskRun.error =
                `Executor is missing required capabilities: ${missingCapabilities.join(", ")}`;
              args.state.taskRun.updatedAt = args.context.now;
              return "finalize";
            }
            return "evaluate_approval";
          },
        },
        evaluate_approval: {
          id: "evaluate_approval",
          async run(args) {
            const approval = resolveApprovalRequirement({
              task: args.state.task,
              executor: args.state.executor,
              requiredCapabilities: args.state.requiredCapabilities,
            });
            if (!approval.required) {
              return "finalize";
            }
            args.state.approval = ApprovalRequestSchema.parse({
              id: createId("approval"),
              workspaceId: args.state.task.workspaceId,
              taskId: args.state.task.id,
              taskRunId: args.state.taskRun.id,
              executorId: args.state.executor?.id ?? args.state.taskRun.executorId ?? null,
              status: "pending",
              reason: approval.reason,
              requestedCapabilities: args.state.requiredCapabilities,
              requestedScopes: {
                executorLabel: args.state.executor?.label ?? null,
                templateKind: args.state.task.templateKind,
                checkpoints: approval.checkpoints,
              },
              decisionNote: null,
              requestedAt: args.context.now,
              decidedAt: null,
              expiresAt: args.context.approvalExpiresAt,
              createdAt: args.context.now,
              updatedAt: args.context.now,
            });
            args.state.taskRun.approvalId = args.state.approval.id;
            args.state.taskRun.status = "waiting_approval";
            args.state.taskRun.updatedAt = args.context.now;
            return "finalize";
          },
        },
        finalize: {
          id: "finalize",
          async run() {
            return null;
          },
        },
      },
    });

    return {
      taskRun: TaskRunSchema.parse(state.taskRun),
      approval: state.approval ? ApprovalRequestSchema.parse(state.approval) : null,
    };
  }
}
