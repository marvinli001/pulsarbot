import { describe, expect, it } from "vitest";
import { TaskRuntime } from "../packages/agent/src/task-runtime.js";
import {
  ExecutorNodeSchema,
  TaskSchema,
} from "../packages/shared/src/index.js";

describe("TaskRuntime", () => {
  it("stages approval when the task policy requires it", async () => {
    const runtime = new TaskRuntime();
    const task = TaskSchema.parse({
      id: "task-browser",
      workspaceId: "main",
      title: "Browser Task",
      goal: "Open a page and capture the result.",
      templateKind: "browser_workflow",
      status: "active",
      defaultExecutorId: "executor-1",
      approvalPolicy: "approval_required",
      memoryPolicy: "task_context",
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });
    const executor = ExecutorNodeSchema.parse({
      id: "executor-1",
      workspaceId: "main",
      label: "Companion",
      status: "online",
      capabilities: ["browser", "http"],
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });

    const result = await runtime.stageRun({
      workspaceId: "main",
      task,
      executor,
      triggerType: "manual",
      now: "2026-03-13T00:00:01.000Z",
      approvalExpiresAt: "2026-03-14T00:00:01.000Z",
    });

    expect(result.taskRun.status).toBe("waiting_approval");
    expect(result.approval?.status).toBe("pending");
    expect(result.approval?.executorId).toBe("executor-1");
    expect(result.approval?.expiresAt).toBe("2026-03-14T00:00:01.000Z");
  });

  it("moves to waiting_retry when an executor-backed template has no online executor", async () => {
    const runtime = new TaskRuntime();
    const task = TaskSchema.parse({
      id: "task-watch",
      workspaceId: "main",
      title: "Watch Task",
      goal: "Monitor a page and report back.",
      templateKind: "web_watch_report",
      status: "active",
      defaultExecutorId: "executor-1",
      approvalPolicy: "auto_approve_safe",
      memoryPolicy: "task_context",
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });

    const result = await runtime.stageRun({
      workspaceId: "main",
      task,
      executor: null,
      triggerType: "manual",
      now: "2026-03-13T00:00:01.000Z",
    });

    expect(result.taskRun.status).toBe("waiting_retry");
    expect(result.taskRun.error).toContain("Executor");
    expect(result.approval).toBeNull();
  });

  it("stages approval when memory writeback checkpoint is enabled for internal workflows", async () => {
    const runtime = new TaskRuntime();
    const task = TaskSchema.parse({
      id: "task-document",
      workspaceId: "main",
      title: "Document Digest",
      goal: "Summarize a document and write memory.",
      templateKind: "document_digest_memory",
      status: "active",
      approvalPolicy: "auto_approve_safe",
      approvalCheckpoints: ["before_memory_writeback"],
      memoryPolicy: "task_context_writeback",
      config: {
        documentId: "doc-1",
        writebackSummary: true,
      },
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });

    const result = await runtime.stageRun({
      workspaceId: "main",
      task,
      executor: null,
      triggerType: "manual",
      now: "2026-03-13T00:00:01.000Z",
    });

    expect(result.taskRun.status).toBe("waiting_approval");
    expect(result.approval?.status).toBe("pending");
    expect(result.approval?.requestedCapabilities).toEqual([]);
    expect(result.approval?.reason).toContain("before_memory_writeback");
  });

  it("skips memory-write approval when writeback is disabled in config", async () => {
    const runtime = new TaskRuntime();
    const task = TaskSchema.parse({
      id: "task-document-nowrite",
      workspaceId: "main",
      title: "Document Digest",
      goal: "Summarize without memory writeback.",
      templateKind: "document_digest_memory",
      status: "active",
      approvalPolicy: "auto_approve_safe",
      approvalCheckpoints: ["before_memory_writeback"],
      memoryPolicy: "task_context_writeback",
      config: {
        documentId: "doc-1",
        writebackSummary: false,
      },
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });

    const result = await runtime.stageRun({
      workspaceId: "main",
      task,
      executor: null,
      triggerType: "manual",
      now: "2026-03-13T00:00:01.000Z",
    });

    expect(result.taskRun.status).toBe("queued");
    expect(result.approval).toBeNull();
  });

  it("maps approval_for_write to shell checkpoints for shell capabilities", async () => {
    const runtime = new TaskRuntime();
    const task = TaskSchema.parse({
      id: "task-shell",
      workspaceId: "main",
      title: "Shell Task",
      goal: "Run an allowlisted command.",
      templateKind: "browser_workflow",
      status: "active",
      defaultExecutorId: "executor-1",
      approvalPolicy: "approval_for_write",
      memoryPolicy: "chat_only",
      config: {
        executorAction: {
          capability: "shell",
          command: "echo",
        },
      },
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });
    const executor = ExecutorNodeSchema.parse({
      id: "executor-1",
      workspaceId: "main",
      label: "Companion",
      status: "online",
      capabilities: ["shell"],
      scopes: {
        allowedHosts: [],
        allowedPaths: ["/tmp"],
        allowedCommands: ["echo"],
        fsRequiresApproval: false,
        shellRequiresApproval: true,
      },
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });

    const result = await runtime.stageRun({
      workspaceId: "main",
      task,
      executor,
      triggerType: "manual",
      now: "2026-03-13T00:00:01.000Z",
    });

    expect(result.taskRun.status).toBe("waiting_approval");
    expect(result.approval?.reason).toContain("before_shell");
    expect(result.approval?.reason).not.toContain("before_fs_write");
  });

  it("does not require approval for an empty telegram target placeholder", async () => {
    const runtime = new TaskRuntime();
    const task = TaskSchema.parse({
      id: "task-document-telegram-placeholder",
      workspaceId: "main",
      title: "Document Digest",
      goal: "Summarize without a configured Telegram destination.",
      templateKind: "document_digest_memory",
      status: "active",
      approvalPolicy: "auto_approve_safe",
      approvalCheckpoints: ["before_telegram_push"],
      memoryPolicy: "chat_only",
      config: {
        documentId: "doc-1",
        telegramTarget: {},
      },
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });

    const result = await runtime.stageRun({
      workspaceId: "main",
      task,
      executor: null,
      triggerType: "manual",
      now: "2026-03-13T00:00:01.000Z",
      approvalExpiresAt: "2026-03-14T00:00:01.000Z",
    });

    expect(result.taskRun.status).toBe("queued");
    expect(result.approval).toBeNull();
  });

  it("moves browser workflows to waiting_retry when a chrome extension executor is detached", async () => {
    const runtime = new TaskRuntime();
    const task = TaskSchema.parse({
      id: "task-browser-detached",
      workspaceId: "main",
      title: "Browser Task",
      goal: "Open a page in a logged-in browser tab.",
      templateKind: "browser_workflow",
      status: "active",
      defaultExecutorId: "executor-browser",
      approvalPolicy: "auto_approve_safe",
      approvalCheckpoints: [],
      memoryPolicy: "chat_only",
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });
    const executor = ExecutorNodeSchema.parse({
      id: "executor-browser",
      workspaceId: "main",
      label: "Chrome Executor",
      kind: "chrome_extension",
      status: "online",
      capabilities: ["browser"],
      scopes: {
        allowedHosts: ["example.com"],
        allowedPaths: [],
        allowedCommands: [],
        fsRequiresApproval: true,
        shellRequiresApproval: true,
      },
      browserAttachment: {
        state: "detached",
        mode: "single_window",
      },
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });

    const result = await runtime.stageRun({
      workspaceId: "main",
      task,
      executor,
      triggerType: "manual",
      now: "2026-03-13T00:00:01.000Z",
    });

    expect(result.taskRun.status).toBe("waiting_retry");
    expect(result.taskRun.error).toContain("not attached");
  });

  it("moves browser workflows to waiting_retry when a chrome extension executor is attached outside the allowlist", async () => {
    const runtime = new TaskRuntime();
    const task = TaskSchema.parse({
      id: "task-browser-host",
      workspaceId: "main",
      title: "Browser Task",
      goal: "Open a page in a logged-in browser tab.",
      templateKind: "browser_workflow",
      status: "active",
      defaultExecutorId: "executor-browser",
      approvalPolicy: "auto_approve_safe",
      approvalCheckpoints: [],
      memoryPolicy: "chat_only",
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });
    const executor = ExecutorNodeSchema.parse({
      id: "executor-browser",
      workspaceId: "main",
      label: "Chrome Executor",
      kind: "chrome_extension",
      status: "online",
      capabilities: ["browser"],
      scopes: {
        allowedHosts: ["example.com"],
        allowedPaths: [],
        allowedCommands: [],
        fsRequiresApproval: true,
        shellRequiresApproval: true,
      },
      browserAttachment: {
        state: "attached",
        mode: "single_window",
        windowId: 11,
        tabId: 22,
        origin: "https://not-allowed.test",
        url: "https://not-allowed.test/dashboard",
        title: "Dashboard",
      },
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });

    const result = await runtime.stageRun({
      workspaceId: "main",
      task,
      executor,
      triggerType: "manual",
      now: "2026-03-13T00:00:01.000Z",
    });

    expect(result.taskRun.status).toBe("waiting_retry");
    expect(result.taskRun.error).toContain("allowed hosts");
  });
});
