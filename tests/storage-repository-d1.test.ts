import { describe, expect, it, vi } from "vitest";
import type { InstallRecord, MemoryChunk } from "../packages/shared/src/index.js";
import { D1AppRepository } from "../packages/storage/src/index.js";

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
});
