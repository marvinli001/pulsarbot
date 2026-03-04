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
});
