import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  ConversationTurn,
  AuditEvent,
  ConversationRecord,
  DocumentMetadata,
  ExecutorNode,
  ImportExportRun,
  InstallRecord,
  JobRecord,
  MemoryChunk,
  MemoryDocument,
  ProviderTestRun,
  Task,
  TaskRun,
  TurnEvent,
  TurnState,
  Trigger,
  ToolRunRecord,
} from "../packages/shared/src/index.js";
import { TurnStateSchema } from "../packages/shared/src/index.js";
import { D1AppRepository, runMigrations } from "../packages/storage/src/index.js";

function makeInstallRecord(): InstallRecord {
  return {
    id: "install_1",
    manifestId: "native-google-search",
    kind: "plugins",
    enabled: true,
    config: {},
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "task_1",
    workspaceId: "workspace_1",
    title: "Daily Watch",
    goal: "Watch the target page",
    description: "",
    config: {},
    templateKind: "web_watch_report",
    status: "active",
    agentProfileId: null,
    defaultExecutorId: null,
    approvalPolicy: "auto_approve_safe",
    approvalCheckpoints: ["before_executor"],
    memoryPolicy: "chat_only",
    defaultRunBudget: {
      maxSteps: 8,
      maxActions: 6,
      timeoutMs: 60_000,
    },
    triggerIds: [],
    relatedDocumentIds: [],
    relatedThreadIds: [],
    latestRunId: null,
    lastRunAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDocumentMetadata(overrides?: Partial<DocumentMetadata>): DocumentMetadata {
  return {
    id: "document_1",
    workspaceId: "workspace_1",
    sourceType: "upload",
    kind: "text",
    title: "Spec",
    path: "documents/document_1/source/spec.txt",
    derivedTextPath: "documents/document_1/derived/content.md",
    sourceObjectKey: null,
    derivedTextObjectKey: null,
    previewText: "spec preview",
    fileId: null,
    sizeBytes: 128,
    mimeType: "text/plain",
    extractionStatus: "completed",
    extractionMethod: "decode_text",
    extractionProviderProfileId: null,
    lastExtractionError: null,
    lastExtractedAt: "2026-01-01T00:00:00.000Z",
    lastIndexedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMemoryChunk(): MemoryChunk {
  return {
    id: "chunk_1",
    workspaceId: "workspace_1",
    documentId: "document_1",
    vectorId: "vector_1",
    content: "chunk content",
    tokenEstimate: 12,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeMemoryDocument(overrides?: Partial<MemoryDocument>): MemoryDocument {
  return {
    id: "memorydoc_1",
    workspaceId: "workspace_1",
    kind: "daily",
    path: "memory/daily/2026-01-01.md",
    title: "Daily Notes",
    content: undefined,
    contentHash: "hash_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTurnState(): TurnState {
  return TurnStateSchema.parse({
    id: "state_1",
    turnId: "turn_1",
    workspaceId: "workspace_1",
    conversationId: "conversation_1",
    graphVersion: "v1",
    status: "running",
    currentNode: "ingest_input",
    version: 1,
    input: {
      updateId: 123,
      chatId: 1,
      threadId: null,
      userId: 42,
      username: "owner",
      messageId: 9,
      contentKind: "text",
      normalizedText: "hello",
      rawMetadata: {},
    },
    context: {
      profileId: "agent_1",
      timezone: "UTC",
      nowIso: "2026-01-01T00:00:00.000Z",
      runtimeSnapshot: {},
      searchSettings: null,
      historyWindow: 0,
      summaryCursor: null,
    },
    budgets: {
      maxPlanningSteps: 8,
      maxToolCalls: 6,
      maxTurnDurationMs: 30_000,
      stepsUsed: 0,
      toolCallsUsed: 0,
      deadlineAt: "2026-01-01T00:00:30.000Z",
    },
    toolResults: [],
    output: {
      replyText: "",
      telegramReplyMessageId: null,
      streamingEnabled: false,
      lastRenderedChars: 0,
    },
    error: null,
    recovery: {
      resumeEligible: true,
      resumeCount: 0,
      lastRecoveredAt: null,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function makeTurnEvent(): TurnEvent {
  return {
    id: "tevt_1",
    turnId: "turn_1",
    seq: 1,
    nodeId: "ingest_input",
    eventType: "node_started",
    attempt: 1,
    payload: {},
    occurredAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeJobRecord(overrides?: Partial<JobRecord>): JobRecord {
  return {
    id: "job_1",
    workspaceId: "workspace_1",
    kind: "task_run_retry",
    status: "pending",
    dedupeKey: "task_run_retry:run_1",
    payload: {
      taskRunId: "run_1",
    },
    result: {},
    attempts: 0,
    runAfter: "2026-01-01T00:00:00.000Z",
    lockedAt: null,
    lockedBy: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTaskRun(overrides?: Partial<TaskRun>): TaskRun {
  return {
    id: "taskrun_1",
    workspaceId: "workspace_1",
    taskId: "task_1",
    templateKind: "web_watch_report",
    status: "queued",
    triggerType: "schedule",
    triggerId: "trigger_1",
    executorId: "executor_1",
    approvalId: null,
    sourceTurnId: null,
    sessionId: "session_1",
    sessionTarget: null,
    retryPolicy: {
      enabled: false,
      maxAttempts: 1,
      backoffSeconds: [],
      retryOn: ["executor_unavailable"],
    },
    attemptCount: 1,
    retryCount: 0,
    nextRetryAt: null,
    lastRetryAt: null,
    inputSnapshot: {},
    executionPlan: {},
    outputSummary: null,
    artifacts: [],
    relatedDocumentIds: [],
    relatedMemoryDocumentIds: [],
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeConversationTurn(overrides?: Partial<ConversationTurn>): ConversationTurn {
  return {
    id: "turn_1",
    workspaceId: "workspace_1",
    conversationId: "conversation_1",
    profileId: "agent_1",
    status: "running",
    stepCount: 0,
    toolCallCount: 0,
    compacted: false,
    summaryId: null,
    error: null,
    graphVersion: "v2",
    stateSnapshotId: null,
    lastEventSeq: 0,
    currentNode: "ingest_input",
    resumeEligible: false,
    taskRunId: null,
    triggerType: null,
    executorId: null,
    approvalState: "none",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    lockExpiresAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeToolRunRecord(overrides?: Partial<ToolRunRecord>): ToolRunRecord {
  return {
    id: "toolrun_1",
    conversationId: "conversation_1",
    turnId: "turn_1",
    toolId: "browser.fetch",
    toolSource: "builtin",
    input: {},
    output: {
      ok: true,
    },
    status: "completed",
    durationMs: 12,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTrigger(overrides?: Partial<Trigger>): Trigger {
  return {
    id: "trigger_1",
    workspaceId: "workspace_1",
    taskId: "task_1",
    label: "Daily Trigger",
    kind: "schedule",
    enabled: true,
    config: {},
    sessionTarget: null,
    retryPolicy: {
      enabled: false,
      maxAttempts: 1,
      backoffSeconds: [],
      retryOn: ["executor_unavailable"],
    },
    webhookPath: null,
    webhookSecret: null,
    webhookSecretRef: null,
    nextRunAt: null,
    lastTriggeredAt: null,
    lastRunId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeApprovalRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: "approval_1",
    workspaceId: "workspace_1",
    taskId: "task_1",
    taskRunId: "taskrun_1",
    executorId: "executor_1",
    status: "pending",
    reason: "Need approval",
    requestedCapabilities: [],
    requestedScopes: {},
    decisionNote: null,
    requestedAt: "2026-01-01T00:00:00.000Z",
    decidedAt: null,
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeConversationRecord(
  overrides?: Partial<ConversationRecord>,
): ConversationRecord {
  return {
    id: "conversation_1",
    workspaceId: "workspace_1",
    telegramChatId: "chat_1",
    telegramUserId: "user_1",
    mode: "private",
    activeTurnLock: false,
    activeTurnLockExpiresAt: null,
    lastTurnId: null,
    lastCompactedAt: null,
    lastSummaryId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeExecutorNode(overrides?: Partial<ExecutorNode>): ExecutorNode {
  return {
    id: "executor_1",
    workspaceId: "workspace_1",
    label: "Browser Worker",
    kind: "companion",
    status: "offline",
    version: null,
    platform: null,
    capabilities: [],
    scopes: {
      allowedHosts: [],
      allowedPaths: [],
      allowedCommands: [],
      fsRequiresApproval: true,
      shellRequiresApproval: true,
    },
    metadata: {},
    browserAttachment: {
      state: "detached",
      mode: "single_window",
      windowId: null,
      tabId: null,
      url: null,
      origin: null,
      title: null,
      attachedAt: null,
      detachedAt: null,
      lastSnapshotAt: null,
      extensionInstanceId: null,
      browserName: null,
      browserVersion: null,
      profileLabel: null,
    },
    pairingCodeHash: null,
    executorTokenHash: null,
    pairingIssuedAt: null,
    pairedAt: null,
    lastHeartbeatAt: null,
    lastSeenAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeAuditEvent(overrides?: Partial<AuditEvent>): AuditEvent {
  return {
    id: "audit_1",
    workspaceId: "workspace_1",
    actorTelegramUserId: "42",
    eventType: "task.updated",
    targetType: "task",
    targetId: "task_1",
    detail: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeImportExportRun(overrides?: Partial<ImportExportRun>): ImportExportRun {
  return {
    id: "impexp_1",
    workspaceId: "workspace_1",
    type: "export",
    status: "completed",
    operatorTelegramUserId: "42",
    artifactPath: "/tmp/export.zip",
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProviderTestRun(overrides?: Partial<ProviderTestRun>): ProviderTestRun {
  return {
    id: "ptest_1",
    workspaceId: "workspace_1",
    providerId: "provider_1",
    providerKind: "openai_compatible_chat",
    requestedCapabilities: [],
    results: [],
    ok: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("D1AppRepository", () => {
  it("persists install_record kind column on upsert", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => []);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );
    const record = makeInstallRecord();

    await repository.saveInstallRecord(record);

    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("INSERT INTO install_record (id, kind, data)"),
      [record.id, record.kind, JSON.stringify(record)],
    );
  });

  it("queries install records by kind in SQL", async () => {
    const record = makeInstallRecord();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(record) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listInstallRecords("plugins");

    expect(rows).toEqual([record]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      "SELECT data FROM install_record WHERE kind = ?",
      ["plugins"],
    );
  });

  it("claims telegram login receipts in a dedicated SQL table", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => []);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const result = await repository.claimTelegramLoginReceipt({
      receiptKey: "receipt_1",
      telegramUserId: "42",
      expiresAt: "2026-01-01T00:15:00.000Z",
    });

    expect(result).toBe("claimed");
    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      "DELETE FROM telegram_login_receipt WHERE expires_at <= ?",
      expect.any(Array),
    );
    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("INSERT INTO telegram_login_receipt"),
      expect.arrayContaining(["receipt_1", "42", "2026-01-01T00:15:00.000Z"]),
    );
  });

  it("filters memory chunks in SQL instead of full-table post-filtering", async () => {
    const chunk = makeMemoryChunk();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(chunk) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listMemoryChunks({
      workspaceId: "workspace_1",
      documentId: "document_1",
    });

    expect(rows).toEqual([chunk]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining(
        "WHERE json_extract(data, '$.documentId') = ? AND json_extract(data, '$.workspaceId') = ?",
      ),
      ["document_1", "workspace_1"],
    );
  });

  it("filters jobs in SQL instead of full-table post-filtering", async () => {
    const job = makeJobRecord();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(job) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listJobs({
      status: "pending",
      kind: "task_run_retry",
    });

    expect(rows).toEqual([job]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining(
        "WHERE json_extract(data, '$.status') = ? AND json_extract(data, '$.kind') = ?",
      ),
      ["pending", "task_run_retry"],
    );
  });

  it("filters jobs by workspace, runAfter, and locked state in SQL", async () => {
    const job = makeJobRecord();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(job) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listJobs({
      status: "pending",
      workspaceId: "workspace_1",
      runAfterLte: "2026-01-01T00:00:00.000Z",
      lockedState: "unlocked",
      limit: 10,
      orderByCreatedAt: "desc",
    });

    expect(rows).toEqual([job]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("json_extract(data, '$.workspaceId') = ?"),
      ["pending", "workspace_1", "2026-01-01T00:00:00.000Z", 10],
    );
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("json_extract(data, '$.lockedAt') IS NULL"),
      ["pending", "workspace_1", "2026-01-01T00:00:00.000Z", 10],
    );
  });

  it("counts jobs by status in SQL instead of loading the full job table", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [
      { status: "pending", count: 7 },
      { status: "failed", count: 2 },
    ]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const counts = await repository.countJobsByStatus({
      workspaceId: "workspace_1",
    });

    expect(counts).toMatchObject({
      pending: 7,
      running: 0,
      completed: 0,
      failed: 2,
      cancelled: 0,
    });
  });

  it("filters tasks by status in SQL instead of loading the full task table", async () => {
    const task = makeTask();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(task) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listTasksByStatus({
      statuses: ["active", "paused"],
      limit: 5,
    });

    expect(rows).toEqual([task]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("WHERE json_extract(data, '$.status') IN (?, ?)"),
      ["active", "paused", 5],
    );
  });

  it("gets tasks by exact title in SQL instead of scanning the full table", async () => {
    const task = makeTask({
      title: "Daily Watch",
    });
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(task) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const row = await repository.getTaskByTitle("Daily Watch");

    expect(row).toEqual(task);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("WHERE LOWER(json_extract(data, '$.title')) = ?"),
      ["daily watch"],
    );
  });

  it("counts tasks by status in SQL instead of post-processing the full table", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [
      { status: "active", count: 3 },
      { status: "paused", count: 1 },
    ]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const counts = await repository.countTasksByStatus();

    expect(counts).toMatchObject({
      draft: 0,
      active: 3,
      paused: 1,
      archived: 0,
    });
  });

  it("filters task runs in SQL instead of full-table post-filtering", async () => {
    const taskRun = makeTaskRun();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(taskRun) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listTaskRuns({
      taskId: "task_1",
      status: "queued",
      executorId: "executor_1",
      limit: 5,
    });

    expect(rows).toEqual([taskRun]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining(
        "WHERE json_extract(data, '$.taskId') = ? AND json_extract(data, '$.status') = ? AND json_extract(data, '$.executorId') = ?",
      ),
      ["task_1", "queued", "executor_1", 5],
    );
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("ORDER BY json_extract(data, '$.createdAt') DESC LIMIT ?"),
      ["task_1", "queued", "executor_1", 5],
    );
  });

  it("counts task runs by status in SQL instead of loading sampled rows", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [
      { status: "queued", count: 4 },
      { status: "waiting_retry", count: 2 },
    ]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const counts = await repository.countTaskRunsByStatus();

    expect(counts).toMatchObject({
      queued: 4,
      waiting_retry: 2,
      running: 0,
      completed: 0,
    });
  });

  it("gets documents by id in SQL instead of scanning the full table", async () => {
    const document = makeDocumentMetadata();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(document) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const row = await repository.getDocument("document_1");

    expect(row).toEqual(document);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      "SELECT data FROM document_metadata WHERE id = ? LIMIT 1",
      ["document_1"],
    );
  });

  it("lists recent document failures in SQL instead of filtering all documents in memory", async () => {
    const document = makeDocumentMetadata({
      extractionStatus: "failed",
      lastExtractionError: "decode failed",
    });
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(document) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listRecentDocumentFailures(6);

    expect(rows).toEqual([document]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("FROM document_metadata"),
      [6],
    );
  });

  it("counts document extraction statuses in SQL instead of loading the full table", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [
      { status: "completed", count: 5 },
      { status: "failed", count: 2 },
    ]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const counts = await repository.countDocumentsByExtractionStatus();

    expect(counts).toMatchObject({
      pending: 0,
      processing: 0,
      completed: 5,
      failed: 2,
    });
  });

  it("lists memory documents by workspace in SQL instead of loading the full memory table", async () => {
    const document = makeMemoryDocument();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(document) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listMemoryDocumentsByWorkspace("workspace_1");

    expect(rows).toEqual([document]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("WHERE json_extract(data, '$.workspaceId') = ?"),
      ["workspace_1"],
    );
  });

  it("lists memory documents by kind in SQL instead of post-filtering", async () => {
    const document = makeMemoryDocument();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(document) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listMemoryDocumentsByKind({
      workspaceId: "workspace_1",
      kind: "daily",
      limit: 2,
    });

    expect(rows).toEqual([document]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("WHERE json_extract(data, '$.kind') = ? AND json_extract(data, '$.workspaceId') = ?"),
      ["daily", "workspace_1", 2],
    );
  });

  it("finds memory documents by path in SQL instead of scanning all rows", async () => {
    const document = makeMemoryDocument();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(document) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const row = await repository.findMemoryDocumentByPath({
      workspaceId: "workspace_1",
      path: "memory/daily/2026-01-01.md",
    });

    expect(row).toEqual(document);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("WHERE json_extract(data, '$.workspaceId') = ?"),
      ["workspace_1", "memory/daily/2026-01-01.md"],
    );
  });

  it("filters triggers in SQL instead of full-table post-filtering", async () => {
    const trigger = makeTrigger();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(trigger) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listTriggers({
      taskId: "task_1",
      kind: "schedule",
      enabled: true,
    });

    expect(rows).toEqual([trigger]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining(
        "WHERE json_extract(data, '$.taskId') = ? AND json_extract(data, '$.kind') = ? AND json_extract(data, '$.enabled') = ?",
      ),
      ["task_1", "schedule", 1],
    );
  });

  it("filters approval requests in SQL instead of full-table post-filtering", async () => {
    const approval = makeApprovalRequest();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(approval) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listApprovalRequests({
      taskRunId: "taskrun_1",
      status: "pending",
      limit: 4,
    });

    expect(rows).toEqual([approval]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining(
        "WHERE json_extract(data, '$.taskRunId') = ? AND json_extract(data, '$.status') = ?",
      ),
      ["taskrun_1", "pending", 4],
    );
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("ORDER BY json_extract(data, '$.createdAt') DESC LIMIT ?"),
      ["taskrun_1", "pending", 4],
    );
  });

  it("counts approval requests by status in SQL instead of loading sampled rows", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [
      { status: "pending", count: 5 },
      { status: "approved", count: 3 },
    ]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const counts = await repository.countApprovalRequestsByStatus();

    expect(counts).toMatchObject({
      pending: 5,
      approved: 3,
      rejected: 0,
      cancelled: 0,
    });
  });

  it("filters conversation turns in SQL instead of full-table post-filtering", async () => {
    const turn = makeConversationTurn();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(turn) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listConversationTurns({
      conversationId: "conversation_1",
      status: "running",
      limit: 3,
    });

    expect(rows).toEqual([turn]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining(
        "WHERE json_extract(data, '$.conversationId') = ? AND json_extract(data, '$.status') = ?",
      ),
      ["conversation_1", "running", 3],
    );
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("ORDER BY json_extract(data, '$.startedAt') DESC LIMIT ?"),
      ["conversation_1", "running", 3],
    );
  });

  it("counts conversation turns by status in SQL instead of loading sampled rows", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [
      { status: "running", count: 2 },
      { status: "failed", count: 1 },
    ]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const counts = await repository.countConversationTurnsByStatus();

    expect(counts).toMatchObject({
      running: 2,
      failed: 1,
      completed: 0,
      aborted: 0,
    });
  });

  it("summarizes running conversation turn flags in SQL instead of loading all running turns", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [
      { running: 4, resumable: 2, stuck: 1 },
    ]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const summary = await repository.summarizeRunningConversationTurns("2026-01-01T00:00:00.000Z");

    expect(summary).toEqual({
      running: 4,
      resumable: 2,
      stuck: 1,
    });
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("WHERE json_extract(data, '$.status') = 'running'"),
      ["2026-01-01T00:00:00.000Z"],
    );
  });

  it("filters tool runs in SQL instead of full-table post-filtering", async () => {
    const toolRun = makeToolRunRecord();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(toolRun) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listToolRuns("conversation_1");

    expect(rows).toEqual([toolRun]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      "SELECT data FROM tool_run WHERE json_extract(data, '$.conversationId') = ?",
      ["conversation_1"],
    );
  });

  it("gets conversations by id in SQL instead of scanning the full table", async () => {
    const conversation = makeConversationRecord();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(conversation) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const row = await repository.getConversation("conversation_1");

    expect(row).toEqual(conversation);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      "SELECT data FROM conversation WHERE id = ? LIMIT 1",
      ["conversation_1"],
    );
  });

  it("lists conversations with active locks in SQL instead of loading the full table", async () => {
    const conversation = makeConversationRecord({
      activeTurnLock: true,
      activeTurnLockExpiresAt: "2026-01-01T00:10:00.000Z",
    });
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(conversation) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listConversationsWithActiveTurnLock();

    expect(rows).toEqual([conversation]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      "SELECT data\n      FROM conversation\n      WHERE json_extract(data, '$.activeTurnLock') = 1",
    );
  });

  it("gets executor nodes by id in SQL instead of sorting/scanning all rows", async () => {
    const executor = makeExecutorNode();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(executor) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const row = await repository.getExecutorNode("executor_1");

    expect(row).toEqual(executor);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      "SELECT data FROM executor_node WHERE id = ? LIMIT 1",
      ["executor_1"],
    );
  });

  it("limits audit events in SQL instead of post-sorting the full table", async () => {
    const event = makeAuditEvent();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(event) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listAuditEvents(10);

    expect(rows).toEqual([event]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("FROM audit_event"),
      [10],
    );
  });

  it("limits import/export runs in SQL instead of post-sorting the full table", async () => {
    const run = makeImportExportRun();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(run) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listImportExportRuns(7);

    expect(rows).toEqual([run]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("FROM import_export_run"),
      [7],
    );
  });

  it("filters provider test runs in SQL instead of full-table post-filtering", async () => {
    const run = makeProviderTestRun();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(run) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listProviderTestRuns({
      providerId: "provider_1",
      limit: 2,
    });

    expect(rows).toEqual([run]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("WHERE json_extract(data, '$.providerId') = ?"),
      ["provider_1", 2],
    );
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("ORDER BY json_extract(data, '$.createdAt') DESC LIMIT ?"),
      ["provider_1", 2],
    );
  });

  it("upserts turn state snapshots by id", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => []);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );
    const snapshot = makeTurnState();

    await repository.saveTurnStateSnapshot(snapshot);

    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("INSERT INTO turn_state_snapshot (id, data) VALUES (?, ?)"),
      [snapshot.id, JSON.stringify(snapshot)],
    );
  });

  it("claims conversation turn locks in a dedicated SQL table", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => []);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const result = await repository.claimConversationTurnLock({
      conversationId: "conversation_1",
      turnId: "turn_1",
      lockExpiresAt: "2026-01-01T00:01:30.000Z",
    });

    expect(result).toBe("claimed");
    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("INSERT INTO conversation_turn_lock"),
      expect.arrayContaining([
        "convturn:conversation_1",
        "conversation_1",
        "turn_1",
        "2026-01-01T00:01:30.000Z",
      ]),
    );
  });

  it("returns in_progress when a live conversation turn lock already exists", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{
      turn_id: "turn_existing",
      lock_expires_at: "2999-01-01T00:00:00.000Z",
    }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const result = await repository.claimConversationTurnLock({
      conversationId: "conversation_1",
      turnId: "turn_1",
      lockExpiresAt: "2026-01-01T00:01:30.000Z",
    });

    expect(result).toBe("in_progress");
    expect(executeD1).not.toHaveBeenCalled();
  });

  it("lists turn events by turn + cursor + limit in SQL", async () => {
    const event = makeTurnEvent();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [{ data: JSON.stringify(event) }]);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const rows = await repository.listTurnEvents("turn_1", {
      cursorSeq: 3,
      limit: 25,
    });

    expect(rows).toEqual([event]);
    expect(queryD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("FROM turn_event"),
      ["turn_1", 3, 25],
    );
  });

  it("prunes turn events older than cutoff", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async (databaseId: string, sql: string) => {
      void databaseId;
      if (sql.includes("SELECT id FROM turn_event")) {
        return [{ id: "tevt_1" }, { id: "tevt_2" }];
      }
      return [];
    });
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const count = await repository.pruneTurnEventsOlderThan("2026-01-08T00:00:00.000Z");

    expect(count).toBe(2);
    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      "DELETE FROM turn_event WHERE id = ?",
      ["tevt_1"],
    );
    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      "DELETE FROM turn_event WHERE id = ?",
      ["tevt_2"],
    );
  });

  it("clears imported workspace state before a full restore", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => []);
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    await repository.clearWorkspaceForImport("workspace_1");

    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      "DELETE FROM job_dedupe_index",
      undefined,
    );
    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      "DELETE FROM provider_profile",
      undefined,
    );
    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      "DELETE FROM conversation_turn_lock",
      undefined,
    );
    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      "DELETE FROM secret_envelope WHERE workspace_id = ?",
      ["workspace_1"],
    );
    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      "DELETE FROM workspace",
      undefined,
    );
  });

  it("looks up active deduped jobs through the index table before falling back", async () => {
    const job = makeJobRecord();
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async (databaseId: string, sql: string, params?: unknown[]) => {
      void databaseId;
      if (sql.includes("FROM job_dedupe_index")) {
        expect(params).toEqual(["workspace_1:task_run_retry:task_run_retry:run_1"]);
        return [{ job_id: job.id }];
      }
      if (sql.includes("SELECT data FROM job WHERE id = ? LIMIT 1")) {
        expect(params).toEqual([job.id]);
        return [{ data: JSON.stringify(job) }];
      }
      if (sql.includes("json_extract(data, '$.dedupeKey')")) {
        throw new Error("fallback query should not run when dedupe index hits");
      }
      return [];
    });
    const repository = new D1AppRepository(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    const row = await repository.getActiveJobByDedupeKey({
      workspaceId: "workspace_1",
      kind: "task_run_retry",
      dedupeKey: "task_run_retry:run_1",
    });

    expect(row).toEqual(job);
  });

  it("replays stable migrations when legacy ordinal ids are already recorded", async () => {
    const executeD1 = vi.fn(async () => undefined);
    const queryD1 = vi.fn(async () => [
      { id: "create_1" },
      { id: "create_2" },
      { id: "create_3" },
      { id: "index_1" },
    ]);

    await runMigrations(
      {
        executeD1,
        queryD1,
      } as never,
      "db_1",
    );

    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("CREATE TABLE IF NOT EXISTS mcp_provider"),
    );
    expect(executeD1).toHaveBeenCalledWith(
      "db_1",
      expect.stringContaining("INSERT INTO migration_history"),
      expect.arrayContaining([
        "create_table_mcp_provider",
        expect.stringContaining("CREATE TABLE IF NOT EXISTS mcp_provider"),
        expect.any(String),
      ]),
    );
  });
});
