import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareCredentials, ProviderProfile } from "../packages/shared/src/index.js";
import type {
  ProviderInvocationInput,
  ProviderInvocationResult,
  ProviderMediaInvocationInput,
} from "../packages/providers/src/index.js";

const fakeObjects = new Map<string, string>();
const fakeVectors = new Map<
  string,
  Map<string, { values: number[]; metadata?: Record<string, unknown> }>
>();

function scoreVectors(a: number[], b: number[]) {
  const size = Math.min(a.length, b.length);
  let total = 0;
  for (let index = 0; index < size; index += 1) {
    total += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return total;
}

function toStoredString(body: string | Uint8Array): string {
  return typeof body === "string"
    ? body
    : Buffer.from(body).toString("utf8");
}

function toStoredBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === "string"
    ? Uint8Array.from(Buffer.from(body, "utf8"))
    : body;
}

class FakeCloudflareClient {
  public constructor(public readonly credentials: CloudflareCredentials) {}

  public async verifyCredentials() {
    return true;
  }

  public async initializeWorkspaceResources(args: {
    selection?: Record<string, string>;
    workspaceId: string;
  }) {
    return {
      d1DatabaseId: args.selection?.d1DatabaseId ?? `${args.workspaceId}-d1`,
      r2BucketName: args.selection?.r2BucketName ?? `${args.workspaceId}-r2`,
      vectorizeIndexName:
        args.selection?.vectorizeIndexName ?? `${args.workspaceId}-vector`,
      aiSearchIndexName: args.selection?.aiSearchIndexName,
    };
  }

  public async executeD1() {
    return { success: true };
  }

  public async queryD1() {
    return [];
  }

  public async listD1Databases() {
    return [
      {
        uuid: `${this.credentials.accountId}-existing-d1`,
        name: `${this.credentials.accountId}-existing-d1`,
      },
    ];
  }

  public async listR2Buckets() {
    return [
      {
        name: `${this.credentials.accountId}-existing-r2`,
      },
    ];
  }

  public async listVectorizeIndexes() {
    return [
      {
        name: `${this.credentials.accountId}-existing-vector`,
      },
    ];
  }

  public async listAiSearchIndexes() {
    return [
      {
        name: `${this.credentials.accountId}-existing-ai-search`,
      },
    ];
  }

  public async putR2Object(args: {
    bucketName: string;
    key: string;
    body: string | Uint8Array;
  }) {
    fakeObjects.set(`${args.bucketName}:${args.key}`, toStoredString(args.body));
  }

  public async getR2Object(args: { bucketName: string; key: string }) {
    return fakeObjects.get(`${args.bucketName}:${args.key}`) ?? null;
  }

  public async getR2ObjectRaw(args: { bucketName: string; key: string }) {
    const body = fakeObjects.get(`${args.bucketName}:${args.key}`);
    if (typeof body !== "string") {
      return null;
    }
    return {
      body: toStoredBytes(body),
      contentType: "text/plain",
    };
  }

  public async listR2Objects(args: { bucketName: string; prefix?: string }) {
    const prefix = `${args.bucketName}:${args.prefix ?? ""}`;
    return [...fakeObjects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({
        key: key.replace(`${args.bucketName}:`, ""),
      }));
  }

  public async deleteR2Objects(args: { bucketName: string; keys: string[] }) {
    for (const key of args.keys) {
      fakeObjects.delete(`${args.bucketName}:${key}`);
    }
  }

  public async upsertVectors(args: {
    indexName: string;
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }>;
  }) {
    const index = fakeVectors.get(args.indexName) ?? new Map();
    for (const vector of args.vectors) {
      index.set(vector.id, {
        values: vector.values,
        metadata: vector.metadata,
      });
    }
    fakeVectors.set(args.indexName, index);
  }

  public async queryVectors(args: {
    indexName: string;
    vector: number[];
    topK?: number;
    returnMetadata?: boolean;
  }) {
    const index = fakeVectors.get(args.indexName) ?? new Map();
    return [...index.entries()]
      .map(([id, entry]) => ({
        id,
        score: scoreVectors(args.vector, entry.values),
        metadata: args.returnMetadata ? entry.metadata : undefined,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, args.topK ?? 5);
  }

  public async deleteVectors(args: { indexName: string; ids: string[] }) {
    const index = fakeVectors.get(args.indexName);
    if (!index) {
      return;
    }
    for (const id of args.ids) {
      index.delete(id);
    }
  }
}

const fakeProviderInvoker = vi.fn(
  async (args: {
    profile: ProviderProfile;
    apiKey: string;
    input: ProviderInvocationInput;
  }): Promise<ProviderInvocationResult> => {
    void args.profile;
    void args.apiKey;
    const messages = args.input.messages;
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const user = messages.find((message) => message.role === "user")?.content ?? "";
    const hasToolResult = messages.some((message) => message.role === "tool");
    const rememberText = user.replace(/^.*remember this[:：]?\s*/i, "").trim() || user;

    if (hasToolResult) {
      return {
        text: "已记录。",
        raw: {},
      };
    }

    if (/remember this/i.test(user)) {
      if (args.input.tools?.length && !args.input.jsonMode) {
        return {
          text: "",
          raw: {},
          toolCalls: [
            {
              id: "call_memory_append_daily",
              toolId: "memory_append_daily",
              input: {
                text: rememberText,
              },
            },
          ],
        };
      }

      return {
        text: JSON.stringify({
          finalResponse: "已记录。",
          toolCalls: [
            {
              toolId: "memory_append_daily",
              input: {
                text: rememberText,
              },
            },
          ],
        }),
        raw: {},
      };
    }

    if (system.includes("Return strict JSON")) {
      return {
        text: JSON.stringify({
          finalResponse: `Echo: ${user}`,
          toolCalls: [],
        }),
        raw: {},
      };
    }

    return {
      text: "OK",
      raw: {},
    };
  },
);

const fakeProviderMediaInvoker = vi.fn(
  async (args: {
    profile: ProviderProfile;
    apiKey: string;
    input: ProviderMediaInvocationInput;
  }): Promise<ProviderInvocationResult | null> => {
    void args.profile;
    void args.apiKey;
    return {
      text: `${args.input.kind.toUpperCase()} OK`,
      raw: {},
    };
  },
);

function buildFakeTelegramContent(message: Record<string, any>, body: Record<string, any>) {
  if (typeof message.text === "string" || typeof body.text === "string") {
    return {
      kind: "text" as const,
      text: String(message.text ?? body.text ?? ""),
      metadata: {},
    };
  }

  if (message.voice) {
    return {
      kind: "voice" as const,
      fileId: String(message.voice.file_id),
      mimeType: message.voice.mime_type,
      metadata: {
        duration: message.voice.duration,
        fileSize: message.voice.file_size,
        fileUrl: message.voice.file_url,
      },
    };
  }

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    return {
      kind: "image" as const,
      fileId: String(photo.file_id),
      caption: message.caption,
      metadata: {
        width: photo.width,
        height: photo.height,
        fileSize: photo.file_size,
        fileUrl: photo.file_url,
      },
    };
  }

  if (message.document) {
    return {
      kind: "document" as const,
      fileId: String(message.document.file_id),
      mimeType: message.document.mime_type,
      caption: message.caption,
      metadata: {
        fileName: message.document.file_name,
        fileSize: message.document.file_size,
        fileUrl: message.document.file_url,
      },
    };
  }

  if (message.audio) {
    return {
      kind: "audio" as const,
      fileId: String(message.audio.file_id),
      mimeType: message.audio.mime_type,
      caption: message.caption,
      metadata: {
        title: message.audio.title,
        performer: message.audio.performer,
        duration: message.audio.duration,
        fileName: message.audio.file_name,
        fileSize: message.audio.file_size,
        fileUrl: message.audio.file_url,
      },
    };
  }

  return {
    kind: "text" as const,
    text: "",
    metadata: {},
  };
}

const fakeTelegramFactory = ({ onMessage }: {
  onMessage: (
    payload: {
      chatId: number;
      userId: number;
      username?: string;
      messageId: number | null;
      content: ReturnType<typeof buildFakeTelegramContent>;
    },
    stream: {
      enabled: boolean;
      emit(partialText: string): Promise<void>;
      finalize(finalText: string): Promise<void>;
    },
  ) => Promise<string>;
}) => ({
  handler: async (request: { body?: any }, reply: { send: (payload: unknown) => unknown }) => {
    const body = request.body ?? {};
    const message = body.message ?? body;
    const streamed: string[] = [];
    const response = await onMessage({
      chatId: Number(message.chat?.id ?? body.chatId ?? 1),
      username: message.from?.username ?? body.username,
      userId: Number(message.from?.id ?? body.userId ?? 1),
      messageId: Number(message.message_id ?? body.messageId ?? 1),
      content: buildFakeTelegramContent(message, body),
    }, {
      enabled: Boolean(body.enableStream),
      async emit(partialText: string) {
        streamed.push(partialText);
      },
      async finalize(finalText: string) {
        streamed.push(finalText);
      },
    });
    return reply.send({ ok: true, response, streamed });
  },
  describeWebhookState: () => ({
    updatedAt: new Date().toISOString(),
    status: "ready",
  }),
});

async function createTempDataDir() {
  return mkdtemp(path.join(os.tmpdir(), "pulsarbot-test-"));
}

async function importAppModule() {
  vi.resetModules();
  return import("../apps/server/src/app.js");
}

function getCookie(response: { headers: Record<string, unknown> }) {
  const header = response.headers["set-cookie"];
  const raw = Array.isArray(header) ? header[0] : String(header ?? "");
  return raw.split(";")[0];
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 7_000,
  intervalMs = 200,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function bootstrapApp(
  dataDir: string,
  options?: {
    providerInvoker?: typeof fakeProviderInvoker;
    providerMediaInvoker?: typeof fakeProviderMediaInvoker;
    backgroundPollMs?: number;
    cloudflareClientFactory?: (credentials: CloudflareCredentials) => unknown;
  },
) {
  process.env.NODE_ENV = "test";
  process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
  process.env.PULSARBOT_ACCESS_TOKEN = "dev-access-token";
  process.env.DATA_DIR = dataDir;
  process.env.PORT = "3001";

  const { createApp } = await importAppModule();
  const app = await createApp({
    env: {
      NODE_ENV: "test",
      TELEGRAM_BOT_TOKEN: "123456:TESTTOKEN",
      PULSARBOT_ACCESS_TOKEN: "dev-access-token",
      DATA_DIR: dataDir,
      PORT: 3001,
    },
    cloudflareClientFactory:
      options?.cloudflareClientFactory ??
      ((credentials) => new FakeCloudflareClient(credentials) as never),
    providerInvoker: options?.providerInvoker ?? fakeProviderInvoker,
    providerMediaInvoker: options?.providerMediaInvoker ?? fakeProviderMediaInvoker,
    backgroundPollMs: options?.backgroundPollMs,
    telegramFactory: fakeTelegramFactory as never,
  });

  const session = await app.inject({
    method: "POST",
    url: "/api/session/telegram",
    payload: {
      userId: "42",
      username: "owner",
    },
  });

  const cookie = getCookie(session);

  await app.inject({
    method: "POST",
    url: "/api/bootstrap/verify-access-token",
    payload: {
      accessToken: "dev-access-token",
    },
  });

  await app.inject({
    method: "POST",
    url: "/api/bootstrap/cloudflare/connect",
    headers: {
      cookie,
    },
    payload: {
      accessToken: "dev-access-token",
      accountId: "test-account",
      apiToken: "test-token",
      r2AccessKeyId: "local-key",
      r2SecretAccessKey: "local-secret",
    },
  });

  await app.inject({
    method: "POST",
    url: "/api/bootstrap/cloudflare/init-resources",
    headers: {
      cookie,
    },
    payload: {
      label: "Pulsarbot Test",
      timezone: "UTC",
    },
  });

  const refreshedSession = await app.inject({
    method: "POST",
    url: "/api/session/telegram",
    payload: {
      userId: "42",
      username: "owner",
    },
  });

  return {
    app,
    cookie: getCookie(refreshedSession),
  };
}

async function upsertPrimaryProviderApiKey(
  app: Awaited<ReturnType<typeof bootstrapApp>>["app"],
  cookie: string,
) {
  const providersResponse = await app.inject({
    method: "GET",
    url: "/api/providers",
    headers: {
      cookie,
    },
  });
  const providers = providersResponse.json<Array<Record<string, any>>>();
  const primary = providers.find((provider) => provider.label === "Primary Provider");
  expect(primary).toBeTruthy();

  await app.inject({
    method: "PUT",
    url: `/api/providers/${primary!.id}`,
    headers: {
      cookie,
    },
    payload: {
      ...primary,
      apiKey: "test-provider-key",
      accessToken: "dev-access-token",
    },
  });

  return primary!.id as string;
}

const createdDirs: string[] = [];

beforeEach(() => {
  fakeObjects.clear();
  fakeVectors.clear();
  fakeProviderInvoker.mockClear();
  fakeProviderMediaInvoker.mockClear();
});

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("server flows", () => {
  it("keeps admin API session valid after bootstrap switches repository", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    process.env.NODE_ENV = "test";
    process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
    process.env.PULSARBOT_ACCESS_TOKEN = "dev-access-token";
    process.env.DATA_DIR = dataDir;
    process.env.PORT = "3001";

    const { createApp } = await importAppModule();
    const app = await createApp({
      env: {
        NODE_ENV: "test",
        TELEGRAM_BOT_TOKEN: "123456:TESTTOKEN",
        PULSARBOT_ACCESS_TOKEN: "dev-access-token",
        DATA_DIR: dataDir,
        PORT: 3001,
      },
      cloudflareClientFactory: (credentials) =>
        new FakeCloudflareClient(credentials) as never,
      providerInvoker: fakeProviderInvoker,
      providerMediaInvoker: fakeProviderMediaInvoker,
      telegramFactory: fakeTelegramFactory as never,
    });

    const session = await app.inject({
      method: "POST",
      url: "/api/session/telegram",
      payload: {
        userId: "42",
        username: "owner",
      },
    });
    const initialCookie = getCookie(session);

    await app.inject({
      method: "POST",
      url: "/api/bootstrap/verify-access-token",
      payload: {
        accessToken: "dev-access-token",
      },
    });

    const connect = await app.inject({
      method: "POST",
      url: "/api/bootstrap/cloudflare/connect",
      headers: {
        cookie: initialCookie,
      },
      payload: {
        accessToken: "dev-access-token",
        accountId: "test-account",
        apiToken: "test-token",
      },
    });
    expect(connect.statusCode).toBe(200);

    const initResources = await app.inject({
      method: "POST",
      url: "/api/bootstrap/cloudflare/init-resources",
      headers: {
        cookie: initialCookie,
      },
      payload: {
        label: "Pulsarbot Test",
        timezone: "UTC",
      },
    });
    expect(initResources.statusCode).toBe(200);

    const refreshedCookie = getCookie(initResources);
    expect(refreshedCookie).toContain("pulsarbot_session=");

    const workspace = await app.inject({
      method: "GET",
      url: "/api/workspace",
      headers: {
        cookie: refreshedCookie,
      },
    });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json()).toMatchObject({
      bootstrapState: {
        resourcesInitialized: true,
      },
      workspace: {
        id: "main",
      },
    });
  });

  it("lists cloudflare resources without losing method context", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const { app, cookie } = await bootstrapApp(dataDir);
    const response = await app.inject({
      method: "GET",
      url: "/api/bootstrap/cloudflare/resources",
      headers: {
        cookie,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      d1: [
        {
          uuid: "test-account-existing-d1",
          name: "test-account-existing-d1",
        },
      ],
      r2: [
        {
          name: "test-account-existing-r2",
        },
      ],
      vectorize: [
        {
          name: "test-account-existing-vector",
        },
      ],
      aiSearch: [
        {
          name: "test-account-existing-ai-search",
        },
      ],
    });
  });

  it("returns structured provider test failure when API key is missing", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const { app, cookie } = await bootstrapApp(dataDir);
    const providersResponse = await app.inject({
      method: "GET",
      url: "/api/providers",
      headers: {
        cookie,
      },
    });
    const providers = providersResponse.json<Array<Record<string, any>>>();
    const primary = providers.find((provider) => provider.label === "Primary Provider");
    expect(primary).toBeTruthy();

    const providerTest = await app.inject({
      method: "POST",
      url: `/api/providers/${String(primary!.id)}/test`,
      headers: {
        cookie,
      },
      payload: {
        capabilities: ["text"],
      },
    });

    expect(providerTest.statusCode).toBe(200);
    expect(providerTest.json()).toMatchObject({
      ok: false,
      providerId: String(primary!.id),
      requestedCapabilities: ["text"],
      results: [
        {
          capability: "text",
          status: "failed",
        },
      ],
    });
  });

  it("normalizes provider reasoning level casing on save", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const { app, cookie } = await bootstrapApp(dataDir);
    const providersResponse = await app.inject({
      method: "GET",
      url: "/api/providers",
      headers: {
        cookie,
      },
    });
    const providers = providersResponse.json<Array<Record<string, any>>>();
    const primary = providers.find((provider) => provider.label === "Primary Provider");
    expect(primary).toBeTruthy();

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/providers/${String(primary!.id)}`,
      headers: {
        cookie,
      },
      payload: {
        ...primary,
        reasoningEnabled: true,
        reasoningLevel: "High",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: String(primary!.id),
      reasoningEnabled: true,
      reasoningLevel: "high",
    });
  });

  it("normalizes wrapped cloudflare resource payloads to arrays", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    class WrappedCloudflareClient extends FakeCloudflareClient {
      public override async listD1Databases(): Promise<any> {
        return {
          result: {
            databases: [
              {
                id: "wrapped-d1-id",
                name: "wrapped-d1-name",
              },
            ],
          },
        };
      }

      public override async listR2Buckets(): Promise<any> {
        return {
          buckets: [
            {
              name: "wrapped-r2",
            },
          ],
        };
      }

      public override async listVectorizeIndexes(): Promise<any> {
        return {
          data: {
            indexes: [
              {
                name: "wrapped-vectorize",
              },
            ],
          },
        };
      }

      public override async listAiSearchIndexes(): Promise<any> {
        return {
          results: [
            {
              id: "wrapped-ai-search",
            },
          ],
        };
      }
    }

    const { app, cookie } = await bootstrapApp(dataDir, {
      cloudflareClientFactory: (credentials) =>
        new WrappedCloudflareClient(credentials) as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/bootstrap/cloudflare/resources",
      headers: {
        cookie,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      d1: [
        {
          uuid: "wrapped-d1-id",
          name: "wrapped-d1-name",
        },
      ],
      r2: [
        {
          name: "wrapped-r2",
        },
      ],
      vectorize: [
        {
          name: "wrapped-vectorize",
        },
      ],
      aiSearch: [
        {
          name: "wrapped-ai-search",
        },
      ],
    });
  });

  it("covers bootstrap, provider test, telegram turn, and export/import restore", async () => {
    const firstDir = await createTempDataDir();
    createdDirs.push(firstDir);

    const first = await bootstrapApp(firstDir);
    const providerId = await upsertPrimaryProviderApiKey(first.app, first.cookie);

    const providerTest = await first.app.inject({
      method: "POST",
      url: `/api/providers/${providerId}/test`,
      headers: {
        cookie: first.cookie,
      },
    });

    expect(providerTest.statusCode).toBe(200);
    expect(providerTest.json()).toMatchObject({
      ok: true,
      requestedCapabilities: ["text"],
      results: [
        {
          capability: "text",
          status: "ok",
          outputPreview: "OK",
        },
      ],
    });

    const providerTestHistory = await first.app.inject({
      method: "GET",
      url: `/api/providers/${providerId}/tests`,
      headers: {
        cookie: first.cookie,
      },
    });
    expect(providerTestHistory.statusCode).toBe(200);
    expect(providerTestHistory.json()).toMatchObject([
      {
        providerId,
        requestedCapabilities: ["text"],
        ok: true,
      },
    ]);

    const telegram = await first.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        message: {
          text: "remember this: project codename is nova",
          chat: {
            id: 9001,
          },
          from: {
            id: 42,
            username: "owner",
          },
        },
      },
    });

    expect(telegram.statusCode).toBe(200);
    expect(telegram.json()).toMatchObject({
      ok: true,
      response: "已记录。",
    });

    const memoryStatus = await first.app.inject({
      method: "GET",
      url: "/api/memory/status",
      headers: {
        cookie: first.cookie,
      },
    });

    expect(memoryStatus.json()).toMatchObject({
      documents: 1,
      chunks: 1,
    });

    const exported = await first.app.inject({
      method: "POST",
      url: "/api/settings/export",
      headers: {
        cookie: first.cookie,
      },
      payload: {
        accessToken: "dev-access-token",
        exportPassphrase: "bundle-passphrase",
      },
    });

    const bundle = exported.json<Record<string, any>>();
    expect(bundle.memories[0].content).toContain("project codename is nova");

    const secondDir = await createTempDataDir();
    createdDirs.push(secondDir);
    const second = await bootstrapApp(secondDir);
    await upsertPrimaryProviderApiKey(second.app, second.cookie);

    const imported = await second.app.inject({
      method: "POST",
      url: "/api/settings/import",
      headers: {
        cookie: second.cookie,
      },
      payload: {
        accessToken: "dev-access-token",
        importPassphrase: "bundle-passphrase",
        bundle,
      },
    });

    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({
      ok: true,
    });

    const restoredExport = await second.app.inject({
      method: "POST",
      url: "/api/settings/export",
      headers: {
        cookie: second.cookie,
      },
      payload: {
        accessToken: "dev-access-token",
        exportPassphrase: "bundle-passphrase",
      },
    });

    const restoredBundle = restoredExport.json<Record<string, any>>();
    expect(restoredBundle.memories[0].content).toContain("project codename is nova");

    const reindex = await second.app.inject({
      method: "POST",
      url: "/api/memory/reindex",
      headers: {
        cookie: second.cookie,
      },
    });

    expect(reindex.json()).toMatchObject({
      ok: true,
    });

    await first.app.close();
    await second.app.close();
  });

  it("can validate provider media capabilities individually", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    const providerId = await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    await appState.app.inject({
      method: "PUT",
      url: `/api/providers/${providerId}`,
      headers: {
        cookie: appState.cookie,
      },
      payload: {
        kind: "openrouter",
        label: "Primary Provider",
        apiBaseUrl: "https://openrouter.ai/api/v1",
        defaultModel: "openai/gpt-4.1-mini",
        visionModel: "google/gemini-2.5-flash",
        audioModel: "google/gemini-2.5-flash",
        documentModel: "google/gemini-2.5-flash",
        visionEnabled: true,
        audioInputEnabled: true,
        documentInputEnabled: true,
      },
    });

    const providerTest = await appState.app.inject({
      method: "POST",
      url: `/api/providers/${providerId}/test`,
      headers: {
        cookie: appState.cookie,
      },
      payload: {
        capabilities: ["vision", "audio", "document"],
      },
    });

    expect(providerTest.statusCode).toBe(200);
    expect(providerTest.json()).toMatchObject({
      ok: true,
      requestedCapabilities: ["vision", "audio", "document"],
      results: [
        { capability: "vision", status: "ok", outputPreview: "IMAGE OK" },
        { capability: "audio", status: "ok", outputPreview: "AUDIO OK" },
        { capability: "document", status: "ok", outputPreview: "DOCUMENT OK" },
      ],
    });
    expect(fakeProviderMediaInvoker).toHaveBeenCalledTimes(3);
  });

  it("keeps runtime preview aligned with install state and rejects invalid profile references", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const profilesResponse = await appState.app.inject({
      method: "GET",
      url: "/api/agent-profiles",
      headers: {
        cookie: appState.cookie,
      },
    });
    const profile = profilesResponse
      .json<Array<Record<string, any>>>()
      .find((item) => item.label === "balanced");
    expect(profile).toBeTruthy();

    for (const [kind, manifestId] of [
      ["skills", "memory-core"],
      ["plugins", "native-google-search"],
      ["plugins", "native-bing-search"],
      ["plugins", "web-browse-fetcher"],
      ["plugins", "document-processor"],
    ] as const) {
      const enable = await appState.app.inject({
        method: "POST",
        url: `/api/market/${kind}/${manifestId}/enable`,
        headers: {
          cookie: appState.cookie,
        },
      });
      expect(enable.statusCode).toBe(200);
    }

    const enableNetworkTools = await appState.app.inject({
      method: "PUT",
      url: `/api/agent-profiles/${String(profile!.id)}`,
      headers: {
        cookie: appState.cookie,
      },
      payload: {
        ...profile,
        allowNetworkTools: true,
      },
    });
    expect(enableNetworkTools.statusCode).toBe(200);

    const beforePreview = await appState.app.inject({
      method: "GET",
      url: `/api/runtime/preview?agentProfileId=${encodeURIComponent(String(profile!.id))}`,
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(beforePreview.statusCode).toBe(200);
    expect(beforePreview.json<Record<string, any>>().tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "search_web",
        }),
      ]),
    );

    for (const manifestId of [
      "native-google-search",
      "native-bing-search",
      "web-browse-fetcher",
    ]) {
      const disable = await appState.app.inject({
        method: "POST",
        url: `/api/market/plugins/${manifestId}/disable`,
        headers: {
          cookie: appState.cookie,
        },
      });
      expect(disable.statusCode).toBe(200);
    }

    const afterPreview = await appState.app.inject({
      method: "GET",
      url: `/api/runtime/preview?agentProfileId=${encodeURIComponent(String(profile!.id))}`,
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(afterPreview.statusCode).toBe(200);
    expect(afterPreview.json<Record<string, any>>()).toMatchObject({
      blocked: expect.arrayContaining([
        expect.objectContaining({ scope: "plugin", id: "native-google-search" }),
        expect.objectContaining({ scope: "plugin", id: "native-bing-search" }),
        expect.objectContaining({ scope: "plugin", id: "web-browse-fetcher" }),
      ]),
    });
    expect(afterPreview.json<Record<string, any>>().tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "search_web",
        }),
      ]),
    );

    const invalidSave = await appState.app.inject({
      method: "PUT",
      url: `/api/agent-profiles/${String(profile!.id)}`,
      headers: {
        cookie: appState.cookie,
      },
      payload: {
        ...profile,
      },
    });

    expect(invalidSave.statusCode).toBe(400);
    expect(invalidSave.body).toContain("Invalid runtime references");

    await appState.app.close();
  });

  it("enforces owner auth boundaries, rejects tampering, and revokes logged-out sessions", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const invalidAccessToken = await appState.app.inject({
      method: "POST",
      url: "/api/bootstrap/verify-access-token",
      payload: {
        accessToken: "wrong-token",
      },
    });
    expect(invalidAccessToken.statusCode).toBe(401);

    const tamperedCookie = "pulsarbot_session=not-a-valid-jwt";
    const tampered = await appState.app.inject({
      method: "GET",
      url: "/api/providers",
      headers: {
        cookie: tamperedCookie,
      },
    });
    expect(tampered.statusCode).toBe(401);

    const logout = await appState.app.inject({
      method: "POST",
      url: "/api/session/logout",
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await appState.app.inject({
      method: "GET",
      url: "/api/providers",
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(afterLogout.statusCode).toBe(401);

    const nonOwner = await appState.app.inject({
      method: "POST",
      url: "/api/session/telegram",
      payload: {
        userId: "99",
        username: "intruder",
      },
    });
    expect(nonOwner.statusCode).toBe(403);

    await appState.app.close();
  });

  it("blocks concurrent turns for the same Telegram chat while a turn is running", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const slowProviderInvoker = vi.fn(
      async (args: {
        profile: ProviderProfile;
        apiKey: string;
        input: ProviderInvocationInput;
      }): Promise<ProviderInvocationResult> => {
        void args.profile;
        void args.apiKey;
        const messages = args.input.messages;
        const system = messages.find((message) => message.role === "system")?.content ?? "";
        const user = messages.find((message) => message.role === "user")?.content ?? "";
        const hasToolResult = messages.some((message) => message.role === "tool");

        if (system.includes("Return strict JSON")) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return {
            text: JSON.stringify({
              type: "final_response",
              content: `Echo: ${user}`,
            }),
            raw: {},
          };
        }

        if (!hasToolResult) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }

        return {
          text: `Echo: ${user || "done"}`,
          raw: {},
        };
      },
    );

    const appState = await bootstrapApp(dataDir, {
      providerInvoker: slowProviderInvoker,
      backgroundPollMs: 50,
    });
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const firstTurn = appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        message: {
          text: "slow turn",
          chat: { id: 7001 },
          from: { id: 42, username: "owner" },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    const healthDuringTurn = await appState.app.inject({
      method: "GET",
      url: "/api/system/health",
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(healthDuringTurn.statusCode).toBe(200);
    expect(healthDuringTurn.json<Record<string, any>>().activeTurnLocks).toHaveLength(1);

    const overlappingTurn = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        message: {
          text: "second turn",
          chat: { id: 7001 },
          from: { id: 42, username: "owner" },
        },
      },
    });

    expect(overlappingTurn.statusCode).toBe(200);
    expect(overlappingTurn.json()).toMatchObject({
      ok: true,
      response: "A previous agent turn is still running for this chat. Please try again in a moment.",
    });

    const completedTurn = await firstTurn;
    expect(completedTurn.statusCode).toBe(200);
    expect(completedTurn.json()).toMatchObject({
      ok: true,
      response: "Echo: slow turn",
    });

    await waitForCondition(async () => {
      const response = await appState.app.inject({
        method: "GET",
        url: "/api/system/health",
        headers: {
          cookie: appState.cookie,
        },
      });
      return response.json<Record<string, any>>().activeTurnLocks.length === 0;
    }, 5_000, 50);

    await appState.app.close();
  });

  it("retries inbound voice, image, and document extraction through queued background jobs", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const attempts = new Map<string, number>();
    const flakyProviderMediaInvoker = vi.fn(
      async (args: {
        profile: ProviderProfile;
        apiKey: string;
        input: ProviderMediaInvocationInput;
      }): Promise<ProviderInvocationResult | null> => {
        void args.profile;
        void args.apiKey;
        const nextAttempt = (attempts.get(args.input.kind) ?? 0) + 1;
        attempts.set(args.input.kind, nextAttempt);
        if (nextAttempt === 1) {
          throw new Error(`temporary ${args.input.kind} failure`);
        }
        return {
          text: `${args.input.kind.toUpperCase()} RETRY OK`,
          raw: {},
        };
      },
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/voice.ogg")) {
        return new Response(Uint8Array.from([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/ogg" },
        });
      }
      if (url.endsWith("/image.png")) {
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.endsWith("/report.pdf")) {
        return new Response(Buffer.from("not-a-real-pdf", "utf8"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      return new Response("not-found", { status: 404 });
    });

    try {
      const appState = await bootstrapApp(dataDir, {
        providerMediaInvoker: flakyProviderMediaInvoker,
        backgroundPollMs: 50,
      });
      const providerId = await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

      await appState.app.inject({
        method: "PUT",
        url: `/api/providers/${providerId}`,
        headers: {
          cookie: appState.cookie,
        },
        payload: {
          kind: "openrouter",
          label: "Primary Provider",
          apiBaseUrl: "https://openrouter.ai/api/v1",
          defaultModel: "openai/gpt-4.1-mini",
          visionModel: "google/gemini-2.5-flash",
          audioModel: "google/gemini-2.5-flash",
          documentModel: "google/gemini-2.5-flash",
          visionEnabled: true,
          audioInputEnabled: true,
          documentInputEnabled: true,
        },
      });

      const cases = [
        {
          fileId: "voice-1",
          expectedStatus: "telegram_voice_transcribe",
          payload: {
            message: {
              chat: { id: 8001 },
              from: { id: 42, username: "owner" },
              voice: {
                file_id: "voice-1",
                mime_type: "audio/ogg",
                duration: 2,
                file_size: 4,
                file_url: "https://files.local/voice.ogg",
              },
            },
          },
        },
        {
          fileId: "photo-1",
          expectedStatus: "telegram_image_describe",
          payload: {
            message: {
              chat: { id: 8002 },
              from: { id: 42, username: "owner" },
              caption: "receipt image",
              photo: [
                {
                  file_id: "photo-1",
                  width: 320,
                  height: 240,
                  file_size: 4,
                  file_url: "https://files.local/image.png",
                },
              ],
            },
          },
        },
        {
          fileId: "doc-1",
          expectedStatus: "telegram_file_fetch",
          payload: {
            message: {
              chat: { id: 8003 },
              from: { id: 42, username: "owner" },
              document: {
                file_id: "doc-1",
                mime_type: "application/pdf",
                file_name: "report.pdf",
                file_size: 12,
                file_url: "https://files.local/report.pdf",
              },
            },
          },
        },
      ] as const;

      for (const testCase of cases) {
        const webhook = await appState.app.inject({
          method: "POST",
          url: "/telegram/webhook",
          payload: testCase.payload,
        });
        expect(webhook.statusCode).toBe(200);

        await waitForCondition(async () => {
          const jobsResponse = await appState.app.inject({
            method: "GET",
            url: `/api/jobs?kind=${encodeURIComponent(testCase.expectedStatus)}`,
            headers: {
              cookie: appState.cookie,
            },
          });
          return jobsResponse
            .json<Array<Record<string, any>>>()
            .some((job) => job.kind === testCase.expectedStatus && job.status === "completed");
        }, 5_000, 50);

        const documentsResponse = await appState.app.inject({
          method: "GET",
          url: "/api/documents",
          headers: {
            cookie: appState.cookie,
          },
        });
        const document = documentsResponse
          .json<Array<Record<string, any>>>()
          .find((item) => item.fileId === testCase.fileId);
        expect(document).toBeTruthy();
      }

      expect(flakyProviderMediaInvoker).toHaveBeenCalled();

      await appState.app.close();
    } finally {
      fetchSpy.mockRestore();
    }
  }, 15_000);

  it("queues document re-extraction jobs, supports retry, and completes the job in background", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const exported = await appState.app.inject({
      method: "POST",
      url: "/api/settings/export",
      headers: {
        cookie: appState.cookie,
      },
      payload: {
        accessToken: "dev-access-token",
        exportPassphrase: "bundle-passphrase",
      },
    });
    const bundle = exported.json<Record<string, any>>();
    const documentId = "doc-imported-note";
    const sourcePath = "documents/doc-imported-note/source/notes.txt";
    const derivedTextPath = "documents/doc-imported-note/derived/content.md";

    bundle.documents = [
      ...(Array.isArray(bundle.documents) ? bundle.documents : []),
      {
        id: documentId,
        workspaceId: "main",
        sourceType: "import",
        kind: "text",
        title: "notes.txt",
        path: sourcePath,
        derivedTextPath,
        sourceObjectKey: `workspace/main/${sourcePath}`,
        derivedTextObjectKey: `workspace/main/${derivedTextPath}`,
        previewText: "stale preview",
        fileId: null,
        sizeBytes: 24,
        mimeType: "text/plain",
        extractionStatus: "failed",
        extractionProviderProfileId: null,
        lastExtractionError: "stale",
        lastIndexedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    bundle.documentArtifacts = [
      ...(Array.isArray(bundle.documentArtifacts) ? bundle.documentArtifacts : []),
      {
        documentId,
        path: sourcePath,
        contentBase64: Buffer.from("re-extracted content from source", "utf8").toString("base64"),
        contentType: "text/plain",
      },
    ];

    const imported = await appState.app.inject({
      method: "POST",
      url: "/api/settings/import",
      headers: {
        cookie: appState.cookie,
      },
      payload: {
        accessToken: "dev-access-token",
        importPassphrase: "bundle-passphrase",
        bundle,
      },
    });
    expect(imported.statusCode).toBe(200);

    const reextract = await appState.app.inject({
      method: "POST",
      url: `/api/documents/${documentId}/re-extract`,
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(reextract.statusCode).toBe(200);
    expect(reextract.json()).toMatchObject({
      ok: true,
      status: "queued",
    });

    const queuedJobs = await appState.app.inject({
      method: "GET",
      url: "/api/jobs?kind=document_extract",
      headers: {
        cookie: appState.cookie,
      },
    });
    const queuedJob = queuedJobs
      .json<Array<Record<string, any>>>()
      .find((job) => job.payload?.documentId === documentId);
    expect(queuedJob).toBeTruthy();

    const retried = await appState.app.inject({
      method: "POST",
      url: `/api/jobs/${String(queuedJob!.id)}/retry`,
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ ok: true });

    await waitForCondition(async () => {
      const response = await appState.app.inject({
        method: "GET",
        url: "/api/jobs?kind=document_extract",
        headers: {
          cookie: appState.cookie,
        },
      });
      const jobs = response.json<Array<Record<string, any>>>();
      return jobs.some((job) =>
        job.payload?.documentId === documentId && job.status === "completed"
      );
    });

    const documentResponse = await appState.app.inject({
      method: "GET",
      url: `/api/documents/${documentId}`,
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(documentResponse.statusCode).toBe(200);
    expect(documentResponse.json()).toMatchObject({
      id: documentId,
    });

    await appState.app.close();
  }, 15_000);
});
