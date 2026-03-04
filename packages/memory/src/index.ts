import {
  type AiSearchResult,
  CloudflareApiClient,
  type VectorizeMatch,
  type VectorizeVector,
} from "@pulsarbot/cloudflare";
import { createId, nowIso, sha256 } from "@pulsarbot/core";
import type { ToolDescriptor } from "@pulsarbot/shared";
import {
  type AppRepository,
  type ConversationMessage,
} from "@pulsarbot/storage";

export interface StartupMemoryContext {
  longterm: string;
  today: string;
  yesterday: string;
}

export interface MemorySearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface MemoryStoreLike {
  getStartupContext(now?: Date): Promise<StartupMemoryContext>;
  appendDaily(line: string, now?: Date): Promise<string>;
  upsertLongterm(content: string): Promise<string>;
  writeSummarySnapshot(conversationId: string, content: string): Promise<string>;
  compactTranscript(messages: string[]): string;
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
  processPendingJobs(limit?: number): Promise<number>;
  queueFullReindex(): Promise<void>;
  listToolDescriptors(): ToolDescriptor[];
  executeTool(toolId: string, input: Record<string, unknown>): Promise<unknown>;
}

const MEMORY_TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    id: "memory_search",
    title: "Memory Search",
    description: "Search persistent memory chunks using Vectorize-backed retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
    permissionScopes: ["memory:read"],
    source: "builtin",
  },
  {
    id: "memory_append_daily",
    title: "Append Daily Memory",
    description: "Append a bullet point to today's daily memory note.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
    permissionScopes: ["memory:write"],
    source: "builtin",
  },
  {
    id: "memory_upsert_longterm",
    title: "Upsert Long-term Memory",
    description: "Rewrite the curated long-term MEMORY.md file.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
      },
      required: ["content"],
    },
    permissionScopes: ["memory:write"],
    source: "builtin",
  },
  {
    id: "memory_refresh_before_compact",
    title: "Refresh Memory Before Compact",
    description: "Persist important context before transcript compaction runs.",
    inputSchema: {
      type: "object",
      properties: {
        notes: { type: "string" },
      },
      required: ["notes"],
    },
    permissionScopes: ["memory:write"],
    source: "builtin",
  },
];

export function listMemoryToolDescriptors(): ToolDescriptor[] {
  return MEMORY_TOOL_DESCRIPTORS;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function chunkText(text: string, maxChars = 1200): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buffer = "";

  for (const paragraph of paragraphs) {
    const next = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (next.length > maxChars && buffer) {
      chunks.push(buffer);
      buffer = paragraph;
      continue;
    }
    buffer = next;
  }

  if (buffer) {
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    chunks.push(normalized.slice(0, maxChars));
  }

  return chunks;
}

function toVector(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const token of tokens) {
    const digest = sha256(token);
    for (let index = 0; index < digest.length; index += 4) {
      const piece = digest.slice(index, index + 4);
      if (!piece) {
        continue;
      }
      const bucket = parseInt(piece, 16) % dimensions;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function objectKey(workspaceId: string, path: string): string {
  return `workspace/${workspaceId}/${path}`;
}

function summaryPath(conversationId: string): string {
  return `snapshots/summary/${conversationId}/${Date.now()}.md`;
}

export class CloudflareMemoryStore implements MemoryStoreLike {
  public constructor(
    private readonly args: {
      workspaceId: string;
      cloudflare: CloudflareApiClient;
      repository: AppRepository;
      bucketName: string;
      aiSearchIndexName?: string;
      vectorizeIndexName?: string;
      vectorizeDimensions?: number;
    },
  ) {}

  public listToolDescriptors(): ToolDescriptor[] {
    return listMemoryToolDescriptors();
  }

  public async executeTool(
    toolId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (toolId === "memory_search") {
      return this.search(String(input.query ?? ""), Number(input.limit ?? 5));
    }

    if (toolId === "memory_append_daily") {
      return {
        path: await this.appendDaily(String(input.text ?? "")),
      };
    }

    if (toolId === "memory_upsert_longterm") {
      return {
        path: await this.upsertLongterm(String(input.content ?? "")),
      };
    }

    if (toolId === "memory_refresh_before_compact") {
      const notes = String(input.notes ?? "");
      const path = await this.appendDaily(`Compact refresh: ${notes}`);
      await this.processPendingJobs();
      return { path, refreshed: true };
    }

    throw new Error(`Unknown memory tool: ${toolId}`);
  }

  public async getStartupContext(now = new Date()): Promise<StartupMemoryContext> {
    const today = dateKey(now);
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    return {
      longterm: (await this.readText("memory/MEMORY.md")) ?? "",
      today: (await this.readText(`memory/daily/${today}.md`)) ?? "",
      yesterday:
        (await this.readText(`memory/daily/${dateKey(yesterday)}.md`)) ?? "",
    };
  }

  public async appendDaily(line: string, now = new Date()): Promise<string> {
    const relativePath = `memory/daily/${dateKey(now)}.md`;
    const current = (await this.readText(relativePath)) ?? "";
    const next = `${current}${current ? "\n" : ""}- ${line}`.trim();
    await this.writeDocument({
      kind: "daily",
      path: relativePath,
      title: `Daily ${dateKey(now)}`,
      content: next,
    });
    return relativePath;
  }

  public async upsertLongterm(content: string): Promise<string> {
    const relativePath = "memory/MEMORY.md";
    await this.writeDocument({
      kind: "longterm",
      path: relativePath,
      title: "MEMORY.md",
      content,
    });
    return relativePath;
  }

  public async writeSummarySnapshot(
    conversationId: string,
    content: string,
  ): Promise<string> {
    const relativePath = summaryPath(conversationId);
    await this.writeDocument({
      kind: "summary",
      path: relativePath,
      title: `Summary ${conversationId}`,
      content,
      reindex: false,
    });

    await this.args.repository.saveConversationSummary({
      id: createId("summary"),
      conversationId,
      content,
      createdAt: nowIso(),
    });
    return relativePath;
  }

  public async ingestDocument(args: {
    documentId: string;
    title: string;
    path: string;
    content: string;
  }): Promise<void> {
    await this.writeDocument({
      kind: "document",
      path: args.path,
      title: args.title,
      content: args.content,
      reindex: true,
    });
  }

  public compactTranscript(messages: string[]): string {
    const head = messages.slice(-6).join("\n");
    const previous = messages.slice(0, -6).join("\n");
    return [
      `Summary generated at ${nowIso()}:`,
      previous.slice(0, 3000),
      "",
      "Recent messages:",
      head,
    ].join("\n");
  }

  public async search(
    query: string,
    limit = 5,
  ): Promise<MemorySearchResult[]> {
    const chunks = await this.args.repository.listMemoryChunks({
      workspaceId: this.args.workspaceId,
    });

    if (chunks.length === 0) {
      return [];
    }

    if (this.args.aiSearchIndexName) {
      const aiSearchMatches = await this.searchWithAiSearch(query, limit);
      if (aiSearchMatches.length > 0) {
        return aiSearchMatches;
      }
    }

    if (!this.args.vectorizeIndexName) {
      return this.lexicalSearch(query, chunks, limit);
    }

    try {
      const matches = await this.args.cloudflare.queryVectors({
        indexName: this.args.vectorizeIndexName,
        vector: toVector(query, this.args.vectorizeDimensions ?? 256),
        topK: limit,
        returnMetadata: true,
      });

      return this.materializeMatches(matches, chunks);
    } catch {
      return this.lexicalSearch(query, chunks, limit);
    }
  }

  private async searchWithAiSearch(
    query: string,
    limit: number,
  ): Promise<MemorySearchResult[]> {
    const results = await this.args.cloudflare.searchAiSearch({
      indexName: this.args.aiSearchIndexName!,
      query,
      maxResults: limit,
    });

    return results
      .map((item, index) => this.normalizeAiSearchResult(item, index))
      .filter((item): item is MemorySearchResult => Boolean(item));
  }

  public async queueFullReindex(): Promise<void> {
    await this.args.repository.saveJob({
      id: createId("job"),
      workspaceId: this.args.workspaceId,
      kind: "memory_reindex_all",
      status: "pending",
      payload: {},
      result: {},
      attempts: 0,
      runAfter: nowIso(),
      lockedAt: null,
      lockedBy: null,
      completedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  public async processPendingJobs(limit = 10): Promise<number> {
    const jobs = (await this.args.repository.listJobs({ status: "pending" }))
      .filter((job) => job.workspaceId === this.args.workspaceId)
      .slice(0, limit);

    for (const job of jobs) {
      await this.args.repository.saveJob({
        ...job,
        status: "running",
        attempts: job.attempts + 1,
        lockedAt: nowIso(),
        lockedBy: "memory-store",
        updatedAt: nowIso(),
      });

      try {
        if (job.kind === "memory_reindex_document") {
          await this.reindexDocument(String(job.payload.documentId ?? ""));
        }

        if (job.kind === "memory_reindex_all") {
          const documents = await this.args.repository.listMemoryDocuments();
          for (const document of documents.filter(
            (item) => item.workspaceId === this.args.workspaceId,
          )) {
            await this.reindexDocument(document.id);
          }
        }

        if (job.kind === "memory_refresh_before_compact") {
          await this.appendDaily(String(job.payload.notes ?? ""));
        }

        await this.args.repository.saveJob({
          ...job,
          status: "completed",
          result: {
            processedAt: nowIso(),
          },
          lockedAt: null,
          lockedBy: null,
          completedAt: nowIso(),
          updatedAt: nowIso(),
        });
      } catch (error) {
        await this.args.repository.saveJob({
          ...job,
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
          lockedAt: null,
          lockedBy: null,
          updatedAt: nowIso(),
        });
      }
    }

    return jobs.length;
  }

  private async writeDocument(args: {
    kind: "daily" | "longterm" | "summary" | "document";
    path: string;
    title: string;
    content: string;
    reindex?: boolean;
  }): Promise<void> {
    await this.args.cloudflare.putR2Object({
      bucketName: this.args.bucketName,
      key: objectKey(this.args.workspaceId, args.path),
      body: args.content,
    });

    const existing = (await this.args.repository.listMemoryDocuments()).find(
      (document) =>
        document.workspaceId === this.args.workspaceId && document.path === args.path,
    );

    const document = {
      id: existing?.id ?? createId("memorydoc"),
      workspaceId: this.args.workspaceId,
      kind: args.kind,
      path: args.path,
      title: args.title,
      contentHash: sha256(args.content),
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    } as const;

    await this.args.repository.saveMemoryDocument(document);

    if (args.reindex ?? true) {
      await this.args.repository.saveJob({
        id: createId("job"),
        workspaceId: this.args.workspaceId,
        kind: "memory_reindex_document",
        status: "pending",
        payload: {
          documentId: document.id,
        },
        result: {},
        attempts: 0,
        runAfter: nowIso(),
        lockedAt: null,
        lockedBy: null,
        completedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      await this.processPendingJobs(1);
    }
  }

  private async readText(relativePath: string): Promise<string | null> {
    return this.args.cloudflare.getR2Object({
      bucketName: this.args.bucketName,
      key: objectKey(this.args.workspaceId, relativePath),
    });
  }

  private async reindexDocument(documentId: string): Promise<void> {
    if (!documentId) {
      return;
    }

    const document = (await this.args.repository.listMemoryDocuments()).find(
      (item) => item.id === documentId && item.workspaceId === this.args.workspaceId,
    );
    if (!document) {
      return;
    }

    const content = await this.readText(document.path);
    if (!content) {
      return;
    }

    const previousChunks = await this.args.repository.listMemoryChunks({ documentId });
    if (this.args.vectorizeIndexName && previousChunks.length > 0) {
      await this.args.cloudflare.deleteVectors({
        indexName: this.args.vectorizeIndexName,
        ids: previousChunks.map((chunk) => chunk.vectorId),
      });
    }
    await this.args.repository.deleteMemoryChunksByDocument(documentId);

    const chunks = chunkText(content).map((chunk, index) => ({
      id: createId("chunk"),
      workspaceId: this.args.workspaceId,
      documentId,
      vectorId: `vec_${documentId}_${index}`,
      content: chunk,
      tokenEstimate: estimateTokens(chunk),
      metadata: {
        path: document.path,
        kind: document.kind,
        title: document.title,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }));

    for (const chunk of chunks) {
      await this.args.repository.saveMemoryChunk(chunk);
    }

    if (this.args.vectorizeIndexName && chunks.length > 0) {
      const vectors: VectorizeVector[] = chunks.map((chunk) => ({
        id: chunk.vectorId,
        values: toVector(chunk.content, this.args.vectorizeDimensions ?? 256),
        metadata: {
          chunkId: chunk.id,
          documentId: chunk.documentId,
          path: document.path,
          kind: document.kind,
        },
      }));

      await this.args.cloudflare.upsertVectors({
        indexName: this.args.vectorizeIndexName,
        vectors,
      });
    }
  }

  private materializeMatches(
    matches: VectorizeMatch[],
    chunks: Awaited<ReturnType<AppRepository["listMemoryChunks"]>>,
  ): MemorySearchResult[] {
    const chunkByVectorId = new Map(chunks.map((chunk) => [chunk.vectorId, chunk]));
    return matches
      .map((match) => {
        const chunk = chunkByVectorId.get(match.id);
        if (!chunk) {
          return null;
        }
        return {
          chunkId: chunk.id,
          documentId: chunk.documentId,
          content: chunk.content,
          score: match.score,
          metadata: {
            ...chunk.metadata,
            ...(match.metadata ?? {}),
          },
        } satisfies MemorySearchResult;
      })
      .filter((item): item is MemorySearchResult => Boolean(item));
  }

  private normalizeAiSearchResult(
    item: AiSearchResult,
    index: number,
  ): MemorySearchResult | null {
    const contentCandidate =
      (typeof item.content === "string" ? item.content : null) ??
      (typeof item.text === "string" ? item.text : null) ??
      (typeof item.snippet === "string" ? item.snippet : null);

    const content = contentCandidate?.trim();
    if (!content) {
      return null;
    }

    const metadata =
      item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
        ? item.metadata
        : {};
    const metadataRecord = metadata as Record<string, unknown>;
    const documentId =
      typeof metadataRecord.documentId === "string"
        ? metadataRecord.documentId
        : typeof metadataRecord.document_id === "string"
          ? metadataRecord.document_id
          : typeof item.id === "string"
            ? item.id
            : `ai-search-doc-${index}`;
    const chunkId =
      typeof metadataRecord.chunkId === "string"
        ? metadataRecord.chunkId
        : typeof metadataRecord.chunk_id === "string"
          ? metadataRecord.chunk_id
          : `${documentId}:chunk:${index}`;

    return {
      chunkId,
      documentId,
      content,
      score: Number(item.score ?? metadataRecord.score ?? 1),
      metadata: {
        source: "ai-search",
        ...metadataRecord,
      },
    };
  }

  private lexicalSearch(
    query: string,
    chunks: Awaited<ReturnType<AppRepository["listMemoryChunks"]>>,
    limit: number,
  ): MemorySearchResult[] {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);

    return chunks
      .map((chunk) => {
        const haystack = chunk.content.toLowerCase();
        const score = tokens.reduce(
          (total, token) => total + (haystack.includes(token) ? 1 : 0),
          0,
        );
        return {
          chunkId: chunk.id,
          documentId: chunk.documentId,
          content: chunk.content,
          score,
          metadata: chunk.metadata,
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
}

export function messagesToTranscript(messages: ConversationMessage[]): string[] {
  return messages.map((message) => `${message.role}: ${message.content}`);
}
