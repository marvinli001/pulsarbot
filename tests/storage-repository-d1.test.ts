import { describe, expect, it, vi } from "vitest";
import type {
  InstallRecord,
  MemoryChunk,
  TurnEvent,
  TurnState,
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
      "DELETE FROM provider_profile",
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
