import { describe, expect, it, vi } from "vitest";
import { CloudflareMemoryStore } from "../packages/memory/src/index.js";
import { InMemoryAppRepository } from "../packages/storage/src/index.js";

describe("memory search", () => {
  it("prefers AI Search results before vector or lexical fallback", async () => {
    const repository = new InMemoryAppRepository();
    const objects = new Map<string, string>();
    const searchAiSearch = vi.fn(async () => [
      {
        id: "doc-ai",
        content: "AI Search hit",
        score: 0.91,
        metadata: {
          documentId: "doc-ai",
          chunkId: "chunk-ai",
        },
      },
    ]);

    const cloudflare = {
      async putR2Object(args: { key: string; body: string }) {
        objects.set(args.key, args.body);
      },
      async getR2Object(args: { key: string }) {
        return objects.get(args.key) ?? null;
      },
      searchAiSearch,
      queryVectors: vi.fn(async () => []),
      upsertVectors: vi.fn(async () => undefined),
      deleteVectors: vi.fn(async () => undefined),
    };

    const memory = new CloudflareMemoryStore({
      workspaceId: "workspace_1",
      cloudflare: cloudflare as never,
      repository,
      bucketName: "bucket",
      aiSearchIndexName: "rag_1",
    });

    await memory.ingestDocument({
      documentId: "doc_1",
      title: "Notes",
      path: "documents/doc_1/derived/content.txt",
      content: "Local fallback content",
    });

    const results = await memory.search("agent memory", 3);

    expect(searchAiSearch).toHaveBeenCalledWith({
      indexName: "rag_1",
      query: "agent memory",
      maxResults: 3,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      documentId: "doc-ai",
      chunkId: "chunk-ai",
      content: "AI Search hit",
    });
  });

  it("ignores non-memory jobs and retries managed memory jobs with backoff", async () => {
    const repository = new InMemoryAppRepository();
    const putR2Object = vi.fn(async () => {
      throw new Error("r2 unavailable");
    });
    const cloudflare = {
      putR2Object,
      getR2Object: vi.fn(async () => null),
      searchAiSearch: vi.fn(async () => []),
      queryVectors: vi.fn(async () => []),
      upsertVectors: vi.fn(async () => undefined),
      deleteVectors: vi.fn(async () => undefined),
    };
    const memory = new CloudflareMemoryStore({
      workspaceId: "workspace_1",
      cloudflare: cloudflare as never,
      repository,
      bucketName: "bucket",
    });

    const createdAt = new Date().toISOString();
    await repository.saveJob({
      id: "job_memory",
      workspaceId: "workspace_1",
      kind: "memory_refresh_before_compact",
      status: "pending",
      payload: { notes: "remember this" },
      result: {},
      attempts: 0,
      runAfter: createdAt,
      lockedAt: null,
      lockedBy: null,
      completedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    await repository.saveJob({
      id: "job_document",
      workspaceId: "workspace_1",
      kind: "document_extract",
      status: "pending",
      payload: { documentId: "doc_1" },
      result: {},
      attempts: 0,
      runAfter: createdAt,
      lockedAt: null,
      lockedBy: null,
      completedAt: null,
      createdAt,
      updatedAt: createdAt,
    });

    expect(await memory.processPendingJobs(10)).toBe(1);

    const documentJobAfterFirstTick = await repository.getJob("job_document");
    expect(documentJobAfterFirstTick).toMatchObject({
      status: "pending",
      attempts: 0,
    });

    const firstAttempt = await repository.getJob("job_memory");
    expect(firstAttempt).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "r2 unavailable",
    });
    expect(Date.parse(String(firstAttempt?.runAfter ?? ""))).toBeGreaterThan(Date.now());

    await repository.saveJob({
      ...firstAttempt!,
      runAfter: new Date(Date.now() - 1_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await memory.processPendingJobs(10);
    const secondAttempt = await repository.getJob("job_memory");
    expect(secondAttempt).toMatchObject({
      status: "pending",
      attempts: 2,
    });

    await repository.saveJob({
      ...secondAttempt!,
      runAfter: new Date(Date.now() - 1_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await memory.processPendingJobs(10);
    const thirdAttempt = await repository.getJob("job_memory");
    expect(thirdAttempt).toMatchObject({
      status: "failed",
      attempts: 3,
      error: "r2 unavailable",
    });
    expect(putR2Object).toHaveBeenCalledTimes(3);
  });
});
