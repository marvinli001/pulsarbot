import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { AppError, createLogger } from "@pulsarbot/core";
import {
  CloudflareCredentialsSchema,
  type CloudflareCredentials,
} from "@pulsarbot/shared";

const logger = createLogger({ name: "cloudflare" });

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
}

interface D1QueryRow {
  results?: Record<string, unknown>[];
}

export interface CloudflareResourceSelection {
  d1DatabaseId?: string;
  r2BucketName?: string;
  vectorizeIndexName?: string;
  aiSearchIndexName?: string;
}

export interface VectorizeVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  values?: number[];
}

export interface AiSearchResult {
  id?: string;
  score?: number;
  content?: string;
  snippet?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface R2ObjectPayload {
  body: Uint8Array;
  contentType: string | null;
}

function toBody(body: string | Uint8Array) {
  return typeof body === "string" ? body : Buffer.from(body);
}

export class CloudflareApiClient {
  private readonly credentials: CloudflareCredentials;
  private readonly baseUrl: string;
  private readonly r2Client: S3Client | null;

  public constructor(credentials: CloudflareCredentials) {
    this.credentials = CloudflareCredentialsSchema.parse(credentials);
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${this.credentials.accountId}`;
    this.r2Client = this.createR2Client();
  }

  public async verifyCredentials(): Promise<boolean> {
    if (this.credentials.apiToken) {
      const response = await this.request<{
        status: string;
      }>("/user/tokens/verify", {
        accountScoped: false,
        method: "GET",
      });
      return response.status === "active";
    }

    const account = await this.request<{
      id: string;
    }>("", {
      accountScoped: true,
      method: "GET",
    });

    return Boolean(account.id);
  }

  public getCredentials(): CloudflareCredentials {
    return this.credentials;
  }

  public hasR2DataPlaneCredentials(): boolean {
    return Boolean(
      this.credentials.r2AccessKeyId && this.credentials.r2SecretAccessKey,
    );
  }

  public async listD1Databases(): Promise<Array<{ uuid: string; name: string }>> {
    return this.request("/d1/database", {
      method: "GET",
    });
  }

  public async createD1Database(
    name: string,
  ): Promise<{ uuid: string; name: string }> {
    return this.request("/d1/database", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  public async queryD1<T extends Record<string, unknown>>(
    databaseId: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const results = await this.request<D1QueryRow[]>(
      `/d1/database/${databaseId}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          sql,
          params,
        }),
      },
    );

    return (results[0]?.results ?? []) as T[];
  }

  public async executeD1(
    databaseId: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<void> {
    await this.request(`/d1/database/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({
        sql,
        params,
      }),
    });
  }

  public async listR2Buckets(): Promise<Array<{ name: string }>> {
    return this.request("/r2/buckets", {
      method: "GET",
    });
  }

  public async createR2Bucket(name: string): Promise<{ name: string }> {
    return this.request("/r2/buckets", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  public async getR2Object(args: {
    bucketName: string;
    key: string;
  }): Promise<string | null> {
    const payload = await this.getR2ObjectRaw(args);
    if (!payload) {
      return null;
    }
    return Buffer.from(payload.body).toString("utf8");
  }

  public async getR2ObjectRaw(args: {
    bucketName: string;
    key: string;
  }): Promise<R2ObjectPayload | null> {
    this.assertR2Ready();

    try {
      const response = await this.r2Client!.send(
        new GetObjectCommand({
          Bucket: args.bucketName,
          Key: args.key,
        }),
      );

      if (!response.Body) {
        return null;
      }

      const body = new Uint8Array(await response.Body.transformToByteArray());
      return {
        body,
        contentType: response.ContentType ?? null,
      };
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  public async putR2Object(args: {
    bucketName: string;
    key: string;
    body: string | Uint8Array;
    contentType?: string;
  }): Promise<void> {
    this.assertR2Ready();

    await this.r2Client!.send(
      new PutObjectCommand({
        Bucket: args.bucketName,
        Key: args.key,
        Body: toBody(args.body),
        ContentType: args.contentType ?? "text/markdown; charset=utf-8",
      }),
    );
  }

  public async listR2Objects(args: {
    bucketName: string;
    prefix: string;
  }): Promise<string[]> {
    this.assertR2Ready();
    const response = await this.r2Client!.send(
      new ListObjectsV2Command({
        Bucket: args.bucketName,
        Prefix: args.prefix,
      }),
    );

    return response.Contents?.map((item) => item.Key ?? "").filter(Boolean) ?? [];
  }

  public async deleteR2Objects(args: {
    bucketName: string;
    keys: string[];
  }): Promise<void> {
    this.assertR2Ready();
    if (args.keys.length === 0) {
      return;
    }

    await this.r2Client!.send(
      new DeleteObjectsCommand({
        Bucket: args.bucketName,
        Delete: {
          Objects: args.keys.map((key) => ({ Key: key })),
        },
      }),
    );
  }

  public async listVectorizeIndexes(): Promise<Array<{ name: string }>> {
    return this.request("/vectorize/v2/indexes", {
      method: "GET",
    });
  }

  public async createVectorizeIndex(args: {
    name: string;
    dimensions: number;
    metric?: "cosine" | "dot-product" | "euclidean";
  }): Promise<{ name: string }> {
    return this.request("/vectorize/v2/indexes", {
      method: "POST",
      body: JSON.stringify({
        name: args.name,
        config: {
          dimensions: args.dimensions,
          metric: args.metric ?? "cosine",
        },
      }),
    });
  }

  public async upsertVectors(args: {
    indexName: string;
    vectors: VectorizeVector[];
  }): Promise<void> {
    await this.request(`/vectorize/v2/indexes/${args.indexName}/upsert`, {
      method: "POST",
      body: JSON.stringify({
        vectors: args.vectors,
      }),
    });
  }

  public async queryVectors(args: {
    indexName: string;
    vector: number[];
    topK: number;
    returnMetadata?: boolean;
    filter?: Record<string, unknown>;
  }): Promise<VectorizeMatch[]> {
    const result = await this.request<{
      matches?: VectorizeMatch[];
      count?: number;
    }>(`/vectorize/v2/indexes/${args.indexName}/query`, {
      method: "POST",
      body: JSON.stringify({
        vector: args.vector,
        topK: args.topK,
        returnMetadata: args.returnMetadata ?? true,
        filter: args.filter,
      }),
    });

    return result.matches ?? [];
  }

  public async deleteVectors(args: {
    indexName: string;
    ids: string[];
  }): Promise<void> {
    if (args.ids.length === 0) {
      return;
    }

    await this.request(`/vectorize/v2/indexes/${args.indexName}/delete-by-ids`, {
      method: "POST",
      body: JSON.stringify({
        ids: args.ids,
      }),
    });
  }

  public async listAiSearchIndexes(): Promise<Array<{ name: string }>> {
    try {
      return await this.request("/ai-search/indexes", {
        method: "GET",
      });
    } catch (error) {
      logger.debug({ error }, "AI Search listing is unavailable for this account");
      return [];
    }
  }

  public async searchAiSearch(args: {
    indexName: string;
    query: string;
    maxResults?: number;
  }): Promise<AiSearchResult[]> {
    try {
      const result = await this.request<{
        results?: AiSearchResult[];
        data?: AiSearchResult[];
      }>(`/autorag/rags/${args.indexName}/search`, {
        method: "POST",
        body: JSON.stringify({
          query: args.query,
          max_num_results: args.maxResults ?? 5,
          num_results: args.maxResults ?? 5,
        }),
      });
      return result.results ?? result.data ?? [];
    } catch (error) {
      logger.debug({ error, indexName: args.indexName }, "AI Search query failed");
      return [];
    }
  }

  public async initializeWorkspaceResources(args: {
    workspaceId: string;
    selection?: CloudflareResourceSelection;
  }): Promise<{
    d1DatabaseId: string;
    r2BucketName: string;
    vectorizeIndexName: string;
    aiSearchIndexName?: string;
  }> {
    const selected = args.selection ?? {};
    const d1Database =
      selected.d1DatabaseId ??
      (await this.createD1Database(`pulsarbot-${args.workspaceId}`)).uuid;
    const r2Bucket =
      selected.r2BucketName ??
      (await this.createR2Bucket(`pulsarbot-${args.workspaceId}`)).name;
    const vectorizeIndex =
      selected.vectorizeIndexName ??
      (await this.createVectorizeIndex({
        name: `pulsarbot-${args.workspaceId}`,
        dimensions: this.credentials.vectorizeDimensions ?? 256,
      })).name;

    return {
      d1DatabaseId: d1Database,
      r2BucketName: r2Bucket,
      vectorizeIndexName: vectorizeIndex,
      ...(selected.aiSearchIndexName
        ? { aiSearchIndexName: selected.aiSearchIndexName }
        : {}),
    };
  }

  private async request<T>(
    path: string,
    init: RequestInit & { accountScoped?: boolean },
  ): Promise<T> {
    const accountScoped = init.accountScoped ?? true;
    const url = accountScoped
      ? `${this.baseUrl}${path}`
      : `https://api.cloudflare.com/client/v4${path}`;

    const response = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...this.createAuthHeaders(),
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new AppError(
        "CLOUDFLARE_REQUEST_FAILED",
        `Cloudflare request failed: ${response.status} ${text}`,
        response.status,
      );
    }

    const payload = (await response.json()) as CloudflareEnvelope<T>;
    if (!payload.success) {
      throw new AppError(
        "CLOUDFLARE_ENVELOPE_FAILED",
        payload.errors?.map((item) => item.message).join("; ") ??
          "Cloudflare API returned an unsuccessful response",
        502,
      );
    }
    return payload.result;
  }

  private createAuthHeaders(): HeadersInit {
    if (this.credentials.apiToken) {
      return {
        Authorization: `Bearer ${this.credentials.apiToken}`,
      };
    }

    return {
      "X-Auth-Key": this.credentials.globalApiKey ?? "",
      "X-Auth-Email": this.credentials.email ?? "",
    };
  }

  private createR2Client(): S3Client | null {
    if (!this.hasR2DataPlaneCredentials()) {
      return null;
    }

    return new S3Client({
      region: "auto",
      endpoint: `https://${this.credentials.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.credentials.r2AccessKeyId!,
        secretAccessKey: this.credentials.r2SecretAccessKey!,
      },
      forcePathStyle: true,
    });
  }

  private assertR2Ready(): void {
    if (!this.r2Client) {
      throw new AppError(
        "R2_NOT_CONFIGURED",
        "R2 data-plane credentials are required for object read/write operations",
        400,
      );
    }
  }

  private isNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const name = "name" in error ? String(error.name) : "";
    const code = "Code" in error ? String(error.Code) : "";

    return (
      name.includes("NoSuchKey") ||
      code.includes("NoSuchKey") ||
      code.includes("NotFound")
    );
  }
}
