import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudflareCredentials, ProviderProfile } from "../packages/shared/src/index.js";
import { TurnStateSchema } from "../packages/shared/src/index.js";
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

    if (system.includes("10 字内标题")) {
      return {
        text: "会话标题",
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

const IMPLICIT_THREAD_RENAME_THRESHOLD = 2;

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

function buildFakeForumTopicRequestText(content: ReturnType<typeof buildFakeTelegramContent>) {
  if (content.kind === "text") {
    return content.text ?? "";
  }
  if ("caption" in content && typeof content.caption === "string" && content.caption) {
    return content.caption;
  }
  return String(content.metadata.fileName ?? content.metadata.title ?? content.kind);
}

function isFakeForumTopicServiceMessage(message: Record<string, any>): boolean {
  return Boolean(
    message.forum_topic_created ||
    message.forum_topic_edited ||
    message.forum_topic_closed ||
    message.forum_topic_reopened ||
    message.general_forum_topic_hidden ||
    message.general_forum_topic_unhidden,
  );
}

function isFakeMeaningfulForumMessage(content: ReturnType<typeof buildFakeTelegramContent>) {
  if (content.kind === "text") {
    return Boolean(content.text?.trim());
  }
  return true;
}

const fakeTelegramFactory = ({ onMessage, resolveForumTopicName }: {
  onMessage: (
    payload: {
      updateId: number | null;
      chatId: number;
      threadId: number | null;
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
  resolveForumTopicName?: (context: {
    chatId: number;
    threadId: number | null;
    requestText: string;
    replyText: string;
  }) => Promise<string | null>;
}) => {
  const implicitTopicStates = new Map<string, { effectiveMessageCount: number }>();
  const topicKey = (chatId: number, threadId: number) => `${chatId}:${threadId}`;
  const sendMessage = vi.fn(async () => ({ message_id: 9001 }));

  return {
    bot: {
      api: {
        sendMessage,
      },
    },
    handler: async (request: { body?: any }, reply: { send: (payload: unknown) => unknown }) => {
      const body = request.body ?? {};
      const message = body.message ?? body;
      const streamed: string[] = [];
      const rawThreadId = message.message_thread_id ?? body.messageThreadId ?? body.threadId;
      const parsedThreadId = Number(rawThreadId);
      const chatId = Number(message.chat?.id ?? body.chatId ?? 1);
      const content = buildFakeTelegramContent(message, body);
      if (message.forum_topic_created?.is_name_implicit === true && Number.isFinite(parsedThreadId)) {
        implicitTopicStates.set(topicKey(chatId, Math.trunc(parsedThreadId)), {
          effectiveMessageCount: 0,
        });
      }
      if (!isFakeForumTopicServiceMessage(message) && Number.isFinite(parsedThreadId)) {
        const state = implicitTopicStates.get(topicKey(chatId, Math.trunc(parsedThreadId)));
        if (state && isFakeMeaningfulForumMessage(content)) {
          state.effectiveMessageCount += 1;
        }
      }
      const response = await onMessage({
        updateId: Number.isFinite(Number(body.update_id))
          ? Math.trunc(Number(body.update_id))
          : null,
        chatId,
        threadId: Number.isFinite(parsedThreadId) ? Math.trunc(parsedThreadId) : null,
        username: message.from?.username ?? body.username,
        userId: Number(message.from?.id ?? body.userId ?? 1),
        messageId: Number(message.message_id ?? body.messageId ?? 1),
        content,
      }, {
        enabled: Boolean(body.enableStream),
        async emit(partialText: string) {
          streamed.push(partialText);
        },
        async finalize(finalText: string) {
          streamed.push(finalText);
        },
      });
      const state = Number.isFinite(parsedThreadId)
        ? implicitTopicStates.get(topicKey(chatId, Math.trunc(parsedThreadId)))
        : null;
      const topicName = Number.isFinite(parsedThreadId) &&
        body.resolveForumTopicName !== false &&
        state &&
        state.effectiveMessageCount >= IMPLICIT_THREAD_RENAME_THRESHOLD
        ? await resolveForumTopicName?.({
            chatId,
            threadId: Math.trunc(parsedThreadId),
            requestText: buildFakeForumTopicRequestText(content),
            replyText: response,
          }) ?? null
        : null;
      if (topicName && Number.isFinite(parsedThreadId)) {
        implicitTopicStates.delete(topicKey(chatId, Math.trunc(parsedThreadId)));
      }
      return reply.send({ ok: true, response, streamed, topicName });
    },
    describeWebhookState: () => ({
      updatedAt: new Date().toISOString(),
      status: "ready",
    }),
  };
};

const crashingTelegramFactory = ({ onMessage }: {
  onMessage: (
    payload: {
      updateId: number | null;
      chatId: number;
      threadId: number | null;
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
}) => {
  let crashedOnce = false;
  const sendMessage = vi.fn(async () => ({ message_id: 9002 }));
  return {
    bot: {
      api: {
        sendMessage,
      },
    },
    handler: async (request: { body?: any }, reply: { send: (payload: unknown) => unknown }) => {
      const body = request.body ?? {};
      const message = body.message ?? body;
      const response = await onMessage({
        updateId: Number.isFinite(Number(body.update_id))
          ? Math.trunc(Number(body.update_id))
          : null,
        chatId: Number(message.chat?.id ?? body.chatId ?? 1),
        threadId: null,
        username: message.from?.username ?? body.username,
        userId: Number(message.from?.id ?? body.userId ?? 1),
        messageId: Number(message.message_id ?? body.messageId ?? 1),
        content: buildFakeTelegramContent(message, body),
      }, {
        enabled: false,
        async emit() {},
        async finalize() {},
      });
      if (!crashedOnce) {
        crashedOnce = true;
        throw new Error("telegram handler crashed after processing update");
      }
      return reply.send({ ok: true, response });
    },
    describeWebhookState: () => ({
      updatedAt: new Date().toISOString(),
      status: "ready",
    }),
  };
};

const invalidPayloadTelegramFactory = ({ onMessage }: {
  onMessage: (
    payload: {
      updateId: number | null;
      chatId: number;
      threadId: number | null;
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
  bot: {
    api: {
      sendMessage: vi.fn(async () => ({ message_id: 9003 })),
    },
  },
  handler: async (_request: { body?: any }, reply: { send: (payload: unknown) => unknown }) => {
    const response = await onMessage(null as never, {
      enabled: false,
      async emit() {},
      async finalize() {},
    });
    return reply.send({ ok: true, response });
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
    telegramFactory?: typeof fakeTelegramFactory;
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
    telegramFactory: (options?.telegramFactory ?? fakeTelegramFactory) as never,
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
  const ensurePrimaryProvider = async () => {
    const providersResponse = await app.inject({
      method: "GET",
      url: "/api/providers",
      headers: {
        cookie,
      },
    });
    const providers = providersResponse.json<Array<Record<string, any>>>();
    if (providers[0]) {
      return providers[0];
    }

    const created = await app.inject({
      method: "POST",
      url: "/api/providers",
      headers: {
        cookie,
      },
      payload: {
        label: "Primary Provider",
        kind: "openai",
        apiBaseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
        stream: true,
      },
    });
    expect(created.statusCode).toBe(200);
    return created.json<Record<string, any>>();
  };

  const ensureBalancedProfile = async (primaryProviderId: string) => {
    for (const [kind, manifestId] of [
      ["skills", "core-agent"],
      ["skills", "memory-core"],
      ["plugins", "time-context"],
      ["plugins", "native-google-search"],
      ["plugins", "native-bing-search"],
      ["plugins", "web-browse-fetcher"],
      ["plugins", "document-processor"],
    ] as const) {
      const enable = await app.inject({
        method: "POST",
        url: `/api/market/${kind}/${manifestId}/enable`,
        headers: {
          cookie,
        },
      });
      expect(enable.statusCode).toBe(200);
    }

    const payload = {
      label: "balanced",
      description: "Default interactive Telegram profile.",
      systemPrompt:
        "You are Pulsarbot, a Telegram-native personal agent with tools, memory, and concise answers.",
      primaryModelProfileId: primaryProviderId,
      backgroundModelProfileId: null,
      embeddingModelProfileId: null,
      enabledSkillIds: ["core-agent", "memory-core"],
      enabledPluginIds: [
        "time-context",
        "native-google-search",
        "native-bing-search",
        "web-browse-fetcher",
        "document-processor",
      ],
      enabledMcpServerIds: [],
      maxPlanningSteps: 8,
      maxToolCalls: 6,
      maxTurnDurationMs: 30_000,
      maxToolDurationMs: 15_000,
      compactSoftThreshold: 0.7,
      compactHardThreshold: 0.85,
      allowNetworkTools: true,
      allowWriteTools: true,
      allowMcpTools: true,
    };

    const profilesResponse = await app.inject({
      method: "GET",
      url: "/api/agent-profiles",
      headers: {
        cookie,
      },
    });
    const profiles = profilesResponse.json<Array<Record<string, any>>>();
    const existing = profiles.find((item) => item.label === "balanced") ?? profiles[0];
    if (existing) {
      const updated = await app.inject({
        method: "PUT",
        url: `/api/agent-profiles/${String(existing.id)}`,
        headers: {
          cookie,
        },
        payload,
      });
      expect(updated.statusCode).toBe(200);
      return String(existing.id);
    }

    const created = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      headers: {
        cookie,
      },
      payload,
    });
    expect(created.statusCode).toBe(200);
    return String(created.json<Record<string, any>>().id);
  };

  const primary = await ensurePrimaryProvider();

  const providerUpdate = await app.inject({
    method: "PUT",
    url: `/api/providers/${primary.id}`,
    headers: {
      cookie,
    },
    payload: {
      ...primary,
      apiKey: "test-provider-key",
      accessToken: "dev-access-token",
    },
  });
  expect(providerUpdate.statusCode).toBe(200);

  const profileId = await ensureBalancedProfile(String(primary.id));

  const workspaceResponse = await app.inject({
    method: "GET",
    url: "/api/workspace",
    headers: {
      cookie,
    },
  });
  const workspace = workspaceResponse.json<Record<string, any>>().workspace as Record<string, any>;
  if (
    workspace.primaryModelProfileId !== String(primary.id) ||
    workspace.activeAgentProfileId !== profileId
  ) {
    const workspaceUpdate = await app.inject({
      method: "PUT",
      url: "/api/workspace",
      headers: {
        cookie,
      },
      payload: {
        primaryModelProfileId: String(primary.id),
        activeAgentProfileId: profileId,
      },
    });
    expect(workspaceUpdate.statusCode).toBe(200);
  }

  return String(primary.id);
}

async function createProviderRecord(
  app: Awaited<ReturnType<typeof bootstrapApp>>["app"],
  cookie: string,
  overrides: Record<string, unknown> = {},
) {
  const created = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: {
      cookie,
    },
    payload: {
      label: "Primary Provider",
      kind: "openai",
      apiBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4.1-mini",
      stream: true,
      ...overrides,
    },
  });
  expect(created.statusCode).toBe(200);
  return created.json<Record<string, any>>();
}

async function createAgentProfileRecord(
  app: Awaited<ReturnType<typeof bootstrapApp>>["app"],
  cookie: string,
  overrides: Record<string, unknown> = {},
) {
  const created = await app.inject({
    method: "POST",
    url: "/api/agent-profiles",
    headers: {
      cookie,
    },
    payload: {
      label: "balanced",
      description: "Default interactive Telegram profile.",
      systemPrompt:
        "You are Pulsarbot, a Telegram-native personal agent with tools, memory, and concise answers.",
      primaryModelProfileId: "missing-provider",
      backgroundModelProfileId: null,
      embeddingModelProfileId: null,
      enabledSkillIds: [],
      enabledPluginIds: [],
      enabledMcpServerIds: [],
      maxPlanningSteps: 8,
      maxToolCalls: 6,
      maxTurnDurationMs: 60_000,
      maxToolDurationMs: 30_000,
      compactSoftThreshold: 0.7,
      compactHardThreshold: 0.85,
      allowNetworkTools: true,
      allowWriteTools: true,
      allowMcpTools: true,
      ...overrides,
    },
  });
  expect(created.statusCode).toBe(200);
  return created.json<Record<string, any>>();
}

async function updateWorkspaceProfiles(
  app: Awaited<ReturnType<typeof bootstrapApp>>["app"],
  cookie: string,
  payload: {
    primaryModelProfileId?: string | null;
    activeAgentProfileId?: string | null;
  },
) {
  const updated = await app.inject({
    method: "PUT",
    url: "/api/workspace",
    headers: {
      cookie,
    },
    payload,
  });
  expect(updated.statusCode).toBe(200);
  return updated.json<Record<string, any>>();
}

async function ensurePrimaryProviderWithoutApiKey(
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
  if (providers[0]) {
    return String(providers[0].id);
  }

  const created = await app.inject({
    method: "POST",
    url: "/api/providers",
    headers: {
      cookie,
    },
    payload: {
      label: "Primary Provider",
      kind: "openai",
      apiBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4.1-mini",
      stream: true,
    },
  });
  expect(created.statusCode).toBe(200);
  return String(created.json<Record<string, any>>().id);
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
  }, 15_000);

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
    const providerId = await ensurePrimaryProviderWithoutApiKey(app, cookie);

    const providerTest = await app.inject({
      method: "POST",
      url: `/api/providers/${providerId}/test`,
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
      providerId,
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
    const providerId = await ensurePrimaryProviderWithoutApiKey(app, cookie);

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/providers/${providerId}`,
      headers: {
        cookie,
      },
      payload: {
        reasoningEnabled: true,
        reasoningLevel: "High",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: providerId,
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
    expect(
      restoredBundle.providers.map((provider: Record<string, any>) => provider.id).sort(),
    ).toEqual(
      bundle.providers.map((provider: Record<string, any>) => provider.id).sort(),
    );
    expect(
      restoredBundle.profiles.map((profile: Record<string, any>) => profile.id).sort(),
    ).toEqual(
      bundle.profiles.map((profile: Record<string, any>) => profile.id).sort(),
    );
    expect(
      restoredBundle.documents.map((document: Record<string, any>) => document.id).sort(),
    ).toEqual(
      bundle.documents.map((document: Record<string, any>) => document.id).sort(),
    );
    expect(
      restoredBundle.installs.map((install: Record<string, any>) => install.id).sort(),
    ).toEqual(
      bundle.installs.map((install: Record<string, any>) => install.id).sort(),
    );
    expect(
      restoredBundle.encryptedSecrets.map((secret: Record<string, any>) => secret.scope).sort(),
    ).toEqual(
      bundle.encryptedSecrets.map((secret: Record<string, any>) => secret.scope).sort(),
    );

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

  it("creates official MCP server configs on install and attaches them to the active profile on enable", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const install = await appState.app.inject({
      method: "POST",
      url: "/api/market/mcp/exa-search/install",
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(install.statusCode).toBe(200);

    const serversAfterInstall = await appState.app.inject({
      method: "GET",
      url: "/api/mcp/servers",
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(serversAfterInstall.statusCode).toBe(200);
    expect(serversAfterInstall.json<Array<Record<string, any>>>()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mcp_official_exa-search",
          label: "Exa Search",
          manifestId: "exa-search",
          transport: "stdio",
          command: "uvx",
          args: ["exa-mcp"],
          source: "official",
          enabled: false,
        }),
      ]),
    );

    const enable = await appState.app.inject({
      method: "POST",
      url: "/api/market/mcp/exa-search/enable",
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(enable.statusCode).toBe(200);

    const profilesResponse = await appState.app.inject({
      method: "GET",
      url: "/api/agent-profiles",
      headers: {
        cookie: appState.cookie,
      },
    });
    const balancedProfile = profilesResponse
      .json<Array<Record<string, any>>>()
      .find((item) => item.label === "balanced");
    expect(balancedProfile?.enabledMcpServerIds).toEqual(
      expect.arrayContaining(["mcp_official_exa-search"]),
    );

    const runtimePreview = await appState.app.inject({
      method: "GET",
      url: `/api/runtime/preview?agentProfileId=${encodeURIComponent(String(balancedProfile?.id ?? ""))}`,
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(runtimePreview.statusCode).toBe(200);
    expect(runtimePreview.json<Record<string, any>>().enabledMcpServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mcp_official_exa-search",
          manifestId: "exa-search",
          source: "official",
        }),
      ]),
    );
  });

  it("fetches Bailian MCP provider servers with an API key, upgrades standard SSE endpoints, and rejects unsupported ones", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://dashscope.aliyuncs.com/api/v1/mcps/user/list")) {
        return new Response(
          JSON.stringify({
            success: true,
            total: 3,
            data: [
              {
                id: "web-search",
                name: "联网搜索",
                description: "Bailian Web Search MCP",
                operationalUrl: "https://dashscope.aliyuncs.com/api/v1/mcps/web-search/mcp",
                type: "streamableHttp",
                active: true,
              },
              {
                id: "tavily-ai",
                name: "Tavily",
                description: "Standard Bailian SSE MCP",
                operationalUrl: "https://dashscope.aliyuncs.com/api/v1/mcps/tavily-ai/sse",
                type: "sse",
                active: true,
              },
              {
                id: "legacy-sse",
                name: "Legacy SSE",
                description: "Unsupported non-standard SSE MCP",
                operationalUrl: "https://dashscope.aliyuncs.com/legacy/legacy-sse/sse",
                type: "sse",
                active: true,
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return originalFetch(input);
    }) as typeof fetch;

    try {
      const createProvider = await appState.app.inject({
        method: "POST",
        url: "/api/mcp/providers",
        headers: {
          cookie: appState.cookie,
        },
        payload: {
          kind: "bailian",
          label: "Alibaba Bailian",
          apiKey: "bailian-provider-key",
          accessToken: "dev-access-token",
          enabled: true,
        },
      });
      expect(createProvider.statusCode).toBe(200);
      const providerId = String(createProvider.json<Record<string, any>>().id);

      const fetchCatalog = await appState.app.inject({
        method: "POST",
        url: `/api/mcp/providers/${providerId}/fetch`,
        headers: {
          cookie: appState.cookie,
        },
      });
      expect(fetchCatalog.statusCode).toBe(200);
      expect(fetchCatalog.json<Record<string, any>>()).toMatchObject({
        provider: {
          id: providerId,
          lastFetchStatus: "ok",
        },
        servers: [
          expect.objectContaining({
            remoteId: "web-search",
            serverId: "mcp_bailian_web-search",
            protocol: "streamable_http",
          }),
          expect.objectContaining({
            remoteId: "tavily-ai",
            serverId: "mcp_bailian_tavily-ai",
            operationalUrl: "https://dashscope.aliyuncs.com/api/v1/mcps/tavily-ai/mcp",
            protocol: "streamable_http",
          }),
          expect.objectContaining({
            remoteId: "legacy-sse",
            operationalUrl: "https://dashscope.aliyuncs.com/legacy/legacy-sse/sse",
            protocol: "sse",
          }),
        ],
      });

      const addSupported = await appState.app.inject({
        method: "POST",
        url: `/api/mcp/providers/${providerId}/servers`,
        headers: {
          cookie: appState.cookie,
        },
        payload: {
          remoteId: "web-search",
        },
      });
      expect(addSupported.statusCode).toBe(200);
      expect(addSupported.json<Record<string, any>>()).toMatchObject({
        id: "mcp_bailian_web-search",
        source: "provider",
        providerId,
        providerKind: "bailian",
        transport: "streamable_http",
      });

      const addTavily = await appState.app.inject({
        method: "POST",
        url: `/api/mcp/providers/${providerId}/servers`,
        headers: {
          cookie: appState.cookie,
        },
        payload: {
          remoteId: "tavily-ai",
        },
      });
      expect(addTavily.statusCode).toBe(200);
      expect(addTavily.json<Record<string, any>>()).toMatchObject({
        id: "mcp_bailian_tavily-ai",
        source: "provider",
        providerId,
        providerKind: "bailian",
        transport: "streamable_http",
        url: "https://dashscope.aliyuncs.com/api/v1/mcps/tavily-ai/mcp",
      });

      const profilesResponse = await appState.app.inject({
        method: "GET",
        url: "/api/agent-profiles",
        headers: {
          cookie: appState.cookie,
        },
      });
      const balancedProfile = profilesResponse
        .json<Array<Record<string, any>>>()
        .find((item) => item.label === "balanced");
      expect(balancedProfile?.enabledMcpServerIds).toEqual(
        expect.arrayContaining(["mcp_bailian_web-search", "mcp_bailian_tavily-ai"]),
      );

      const addUnsupported = await appState.app.inject({
        method: "POST",
        url: `/api/mcp/providers/${providerId}/servers`,
        headers: {
          cookie: appState.cookie,
        },
        payload: {
          remoteId: "legacy-sse",
        },
      });
      expect(addUnsupported.statusCode).toBe(400);

      const listServers = await appState.app.inject({
        method: "GET",
        url: "/api/mcp/servers",
        headers: {
          cookie: appState.cookie,
        },
      });
      expect(listServers.statusCode).toBe(200);
      expect(listServers.json<Array<Record<string, any>>>()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "mcp_bailian_web-search",
            source: "provider",
            providerId,
          }),
          expect.objectContaining({
            id: "mcp_bailian_tavily-ai",
            source: "provider",
            providerId,
            url: "https://dashscope.aliyuncs.com/api/v1/mcps/tavily-ai/mcp",
          }),
        ]),
      );
    } finally {
      global.fetch = originalFetch;
    }
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
      ["skills", "web-search"],
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
        enabledSkillIds: [...new Set([
          ...((profile?.enabledSkillIds as string[] | undefined) ?? []),
          "web-search",
        ])],
        enabledPluginIds: [...new Set([
          ...((profile?.enabledPluginIds as string[] | undefined) ?? []),
          "native-google-search",
          "native-bing-search",
          "web-browse-fetcher",
          "document-processor",
        ])],
      },
    });
    expect(enableNetworkTools.statusCode).toBe(200);

    const configuredProfile = enableNetworkTools.json<Record<string, any>>();

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
        ...configuredProfile,
      },
    });

    expect(invalidSave.statusCode).toBe(400);
    expect(invalidSave.body).toContain("Invalid runtime references");

    const invalidProviderRef = await appState.app.inject({
      method: "PUT",
      url: `/api/agent-profiles/${String(profile!.id)}`,
      headers: {
        cookie: appState.cookie,
      },
      payload: {
        ...profile,
        primaryModelProfileId: "provider_missing",
      },
    });
    expect(invalidProviderRef.statusCode).toBe(400);
    expect(invalidProviderRef.body).toContain("Provider reference is missing");

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

  it("queues concurrent turns for the same Telegram chat instead of returning a lock error", async () => {
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

    const overlappingTurn = appState.app.inject({
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

    const completedTurn = await firstTurn;
    expect(completedTurn.statusCode).toBe(200);
    expect(completedTurn.json()).toMatchObject({
      ok: true,
      response: "Echo: slow turn",
    });

    const queuedTurn = await overlappingTurn;
    expect(queuedTurn.statusCode).toBe(200);
    expect(queuedTurn.json<Record<string, unknown>>()).toMatchObject({
      ok: true,
    });
    expect(
      queuedTurn.json<Record<string, unknown>>().response,
    ).not.toBe("A previous agent turn is still running for this chat. Please try again in a moment.");

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

  it("deduplicates repeated Telegram webhook deliveries by update_id", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const payload = {
      update_id: 99123,
      message: {
        message_id: 321,
        text: "duplicate check",
        chat: { id: 7101 },
        from: { id: 42, username: "owner" },
      },
    };

    const firstDelivery = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload,
    });
    expect(firstDelivery.statusCode).toBe(200);
    expect(firstDelivery.json<Record<string, unknown>>()).toMatchObject({
      ok: true,
    });

    const duplicateDelivery = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload,
    });
    expect(duplicateDelivery.statusCode).toBe(200);
    expect(duplicateDelivery.json()).toMatchObject({
      ok: true,
      ignored: true,
      reason: "duplicate",
    });

    await appState.app.close();
  });

  it("silences retried Telegram deliveries when a matching persisted turn already exists", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    const providerId = await upsertPrimaryProviderApiKey(appState.app, appState.cookie);
    const internals = (appState.app as any).__pulsarbot as {
      state: {
        repository: {
          getWorkspace(): Promise<Record<string, any> | null>;
          listAgentProfiles(): Promise<Array<Record<string, any>>>;
          saveConversationTurn(turn: Record<string, any>): Promise<void>;
          saveTurnStateSnapshot(state: ReturnType<typeof TurnStateSchema.parse>): Promise<void>;
        };
      };
    };
    const workspace = await internals.state.repository.getWorkspace();
    const profiles = await internals.state.repository.listAgentProfiles();
    const profile = profiles.find((item) => item.primaryModelProfileId === providerId) ?? profiles[0];

    expect(workspace).toBeTruthy();
    expect(profile).toBeTruthy();

    await internals.state.repository.saveConversationTurn({
      id: "turn_duplicate_delivery",
      workspaceId: String(workspace!.id),
      conversationId: "telegram:7103",
      profileId: String(profile!.id),
      status: "running",
      stepCount: 0,
      toolCallCount: 0,
      compacted: false,
      summaryId: null,
      error: null,
      graphVersion: "v2",
      stateSnapshotId: "state_duplicate_delivery",
      lastEventSeq: 0,
      currentNode: "run_agent_graph",
      resumeEligible: true,
      startedAt: "2026-03-12T00:00:00.000Z",
      finishedAt: null,
      lockExpiresAt: "2026-03-12T00:01:30.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
    });
    await internals.state.repository.saveTurnStateSnapshot(
      TurnStateSchema.parse({
        id: "state_duplicate_delivery",
        turnId: "turn_duplicate_delivery",
        workspaceId: String(workspace!.id),
        conversationId: "telegram:7103",
        graphVersion: "v2",
        status: "running",
        currentNode: "run_agent_graph",
        version: 1,
        input: {
          updateId: 99125,
          chatId: 7103,
          threadId: null,
          userId: 42,
          username: "owner",
          messageId: 323,
          contentKind: "text",
          normalizedText: "duplicate after persisted turn",
          rawMetadata: {},
        },
        context: {
          profileId: String(profile!.id),
          timezone: "UTC",
          nowIso: "2026-03-12T00:00:00.000Z",
          runtimeSnapshot: {},
          searchSettings: null,
          historyWindow: 0,
          summaryCursor: null,
        },
        budgets: {
          maxPlanningSteps: 8,
          maxToolCalls: 6,
          maxTurnDurationMs: 60_000,
          stepsUsed: 0,
          toolCallsUsed: 0,
          deadlineAt: "2026-03-12T00:01:00.000Z",
        },
        output: {
          replyText: "",
          telegramReplyMessageId: null,
          streamingEnabled: false,
          lastRenderedChars: 0,
        },
        recovery: {
          resumeEligible: true,
          resumeCount: 0,
          lastRecoveredAt: null,
        },
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      }),
    );

    const duplicateDelivery = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        update_id: 99125,
        message: {
          message_id: 323,
          text: "duplicate after persisted turn",
          chat: { id: 7103 },
          from: { id: 42, username: "owner" },
        },
      },
    });

    expect(duplicateDelivery.statusCode).toBe(200);
    expect(duplicateDelivery.json()).toMatchObject({
      ok: true,
      response: "",
    });

    await appState.app.close();
  });

  it("releases the Telegram update receipt when the webhook handler crashes so Telegram can retry", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir, {
      telegramFactory: crashingTelegramFactory,
    });
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const payload = {
      update_id: 99124,
      message: {
        message_id: 322,
        text: "duplicate after crash",
        chat: { id: 7102 },
        from: { id: 42, username: "owner" },
      },
    };

    const firstDelivery = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload,
    });
    expect(firstDelivery.statusCode).toBe(500);

    const duplicateDelivery = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload,
    });
    expect(duplicateDelivery.statusCode).toBe(200);
    expect(duplicateDelivery.json()).toMatchObject({
      ok: true,
      response: expect.any(String),
    });

    await appState.app.close();
  });

  it("returns a safe fallback when Telegram onMessage setup throws before graph execution", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir, {
      telegramFactory: invalidPayloadTelegramFactory,
    });
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const response = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        update_id: 99125,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, unknown>>()).toMatchObject({
      ok: true,
      response: "Something went wrong during initialization. Please try again.",
    });

    await appState.app.close();
  });

  it("streams progress previews before the final Telegram reply when draft streaming is enabled", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const response = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        enableStream: true,
        message: {
          text: "show progress",
          chat: { id: 7106 },
          from: { id: 42, username: "owner" },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json<Record<string, any>>();
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.streamed)).toBe(true);
    expect(payload.streamed).toContain("Planning the next steps...");
    expect(payload.streamed).toContain("Writing the answer...");
    expect(payload.response).toBe("OK");

    await appState.app.close();
  });

  it("generates threaded forum topic titles with the configured title prompt", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const topicTitleInvoker = vi.fn(
      async (args: {
        profile: ProviderProfile;
        apiKey: string;
        input: ProviderInvocationInput;
        timeoutMs?: number;
      }): Promise<ProviderInvocationResult> => {
        void args.profile;
        void args.apiKey;
        void args.timeoutMs;
        const system = args.input.messages.find((message) => message.role === "system")?.content ?? "";
        const user = args.input.messages.find((message) => message.role === "user")?.content ?? "";
        if (system.includes("10 字内标题")) {
          expect(system).toContain("语言为 中文");
          expect(user).toContain("用户消息：我感冒了怎么办");
          expect(user).toContain("助手消息：OK");
          expect(user).toContain("用户消息：还有咳嗽");
          return {
            text: "感冒建议！！！",
            raw: {},
          };
        }
        return fakeProviderInvoker(args as never);
      },
    );

    const appState = await bootstrapApp(dataDir, {
      providerInvoker: topicTitleInvoker,
    });
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const topicCreated = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        message: {
          message_id: 900,
          message_thread_id: 777,
          forum_topic_created: {
            name: "New Topic",
            icon_color: 0x6fb9f0,
            is_name_implicit: true,
          },
          chat: { id: 7107 },
          from: { id: 42, username: "owner" },
        },
      },
    });
    expect(topicCreated.statusCode).toBe(200);

    const firstResponse = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        message: {
          text: "我感冒了怎么办",
          message_id: 901,
          message_thread_id: 777,
          chat: { id: 7107 },
          from: { id: 42, username: "owner" },
        },
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json<Record<string, unknown>>()).toMatchObject({
      ok: true,
      response: "OK",
      topicName: null,
    });

    const secondResponse = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        message: {
          text: "还有咳嗽",
          message_id: 902,
          message_thread_id: 777,
          chat: { id: 7107 },
          from: { id: 42, username: "owner" },
        },
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json<Record<string, unknown>>()).toMatchObject({
      ok: true,
      response: "OK",
      topicName: "感冒建议",
    });

    await appState.app.close();
  });

  it("returns a planner-specific timeout reply to Telegram", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const plannerTimeoutProviderInvoker = vi.fn(
      async (args: {
        profile: ProviderProfile;
        apiKey: string;
        input: ProviderInvocationInput;
        timeoutMs?: number;
      }): Promise<ProviderInvocationResult> => {
        void args.profile;
        void args.apiKey;
        void args.timeoutMs;
        if (args.input.jsonMode || args.input.toolChoice === "auto") {
          throw new Error("Planner model timed out");
        }
        return {
          text: "OK",
          raw: {},
        };
      },
    );

    const appState = await bootstrapApp(dataDir, {
      providerInvoker: plannerTimeoutProviderInvoker,
    });
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const response = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        message: {
          text: "trigger planner timeout",
          chat: { id: 7103 },
          from: { id: 42, username: "owner" },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, unknown>>()).toMatchObject({
      ok: true,
      response:
        "Planning timed out before the agent could decide the next step. Please try again, or increase the planner timeout for the active profile.",
    });

    await appState.app.close();
  });

  it("returns a provider-profile-specific reply to Telegram when the active profile points to a missing provider", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    const internals = (appState.app as any).__pulsarbot as {
      state: {
        repository: {
          deleteProviderProfile(id: string): Promise<void>;
        };
      };
    };
    const provider = await upsertPrimaryProviderApiKey(appState.app, appState.cookie);
    const profile = await createAgentProfileRecord(appState.app, appState.cookie, {
      label: "missing-provider",
      primaryModelProfileId: String(provider),
    });
    await internals.state.repository.deleteProviderProfile(String(provider));
    await updateWorkspaceProfiles(appState.app, appState.cookie, {
      primaryModelProfileId: String(provider),
      activeAgentProfileId: String(profile.id),
    });

    const response = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        message: {
          text: "missing provider",
          chat: { id: 7104 },
          from: { id: 42, username: "owner" },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, unknown>>()).toMatchObject({
      ok: true,
      response: "No provider is configured for the active profile yet. Open the Mini App to add one.",
    });

    await appState.app.close();
  });

  it("returns an API-key-specific reply to Telegram when the provider secret is missing", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    const provider = await createProviderRecord(appState.app, appState.cookie);
    const profile = await createAgentProfileRecord(appState.app, appState.cookie, {
      label: "missing-secret",
      primaryModelProfileId: String(provider.id),
    });
    await updateWorkspaceProfiles(appState.app, appState.cookie, {
      primaryModelProfileId: String(provider.id),
      activeAgentProfileId: String(profile.id),
    });

    const response = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        message: {
          text: "missing api key",
          chat: { id: 7105 },
          from: { id: 42, username: "owner" },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, unknown>>()).toMatchObject({
      ok: true,
      response:
        "Provider API key is not configured. Open Mini App > Providers and save a valid API key.",
    });

    await appState.app.close();
  });

  it("exposes active runtime diagnostics and blocked capability reasons in system health", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const disablePlugin = await appState.app.inject({
      method: "POST",
      url: "/api/market/plugins/web-browse-fetcher/disable",
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(disablePlugin.statusCode).toBe(200);

    const health = await appState.app.inject({
      method: "GET",
      url: "/api/system/health",
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(health.statusCode).toBe(200);
    const payload = health.json<Record<string, any>>();

    expect(payload.runtime?.activeProfile?.label).toBe("balanced");
    expect(payload.runtime?.activeProfile?.effectiveMaxPlannerDurationMs).toBe(45_000);
    expect(Array.isArray(payload.runtime?.tools)).toBe(true);
    expect(
      payload.runtime.tools.some((tool: Record<string, unknown>) => tool.id === "memory_search"),
    ).toBe(true);
    expect(payload.runtime?.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "plugin",
          id: "web-browse-fetcher",
          reason: "Plugin is not installed or not enabled",
        }),
      ]),
    );

    await appState.app.close();
  });

  it("exposes graph turn state and events through system diagnostics APIs", async () => {
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
          await new Promise((resolve) => setTimeout(resolve, 180));
          return {
            text: JSON.stringify({
              type: "final_response",
              content: `Echo: ${user}`,
            }),
            raw: {},
          };
        }

        if (!hasToolResult) {
          await new Promise((resolve) => setTimeout(resolve, 180));
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

    const pendingTurn = appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        update_id: 120045,
        message: {
          message_id: 9001,
          text: "graph diagnostics",
          chat: { id: 7301 },
          from: { id: 42, username: "owner" },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    const health = await appState.app.inject({
      method: "GET",
      url: "/api/system/health",
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(health.statusCode).toBe(200);
    const healthPayload = health.json<Record<string, any>>();
    expect(healthPayload.graph?.enabled).toBe(true);
    expect(Array.isArray(healthPayload.activeTurnLocks)).toBe(true);
    expect(healthPayload.activeTurnLocks.length).toBeGreaterThan(0);

    const turnId = String(healthPayload.activeTurnLocks[0].id);

    const stateDuringTurn = await appState.app.inject({
      method: "GET",
      url: `/api/system/turns/${turnId}/state`,
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(stateDuringTurn.statusCode).toBe(200);
    expect(stateDuringTurn.json<Record<string, any>>()).toMatchObject({
      turnId,
      graphVersion: "v2",
    });

    const eventsDuringTurn = await appState.app.inject({
      method: "GET",
      url: `/api/system/turns/${turnId}/events?limit=200`,
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(eventsDuringTurn.statusCode).toBe(200);
    const events = eventsDuringTurn.json<Array<Record<string, any>>>();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.eventType === "turn_started")).toBe(true);
    expect(events.some((event) => event.eventType === "node_started")).toBe(true);

    const turnResponse = await pendingTurn;
    expect(turnResponse.statusCode).toBe(200);

    const stateAfterTurn = await appState.app.inject({
      method: "GET",
      url: `/api/system/turns/${turnId}/state`,
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(stateAfterTurn.statusCode).toBe(200);
    expect(["succeeded", "failed", "aborted"]).toContain(
      stateAfterTurn.json<Record<string, any>>().status,
    );

    const missing = await appState.app.inject({
      method: "GET",
      url: "/api/system/turns/turn_missing/state",
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(missing.statusCode).toBe(404);

    await appState.app.close();
  });

  it("allows concurrent turns for different Telegram threads in the same chat", async () => {
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
          text: "thread one",
          message_thread_id: 1001,
          chat: { id: 7002 },
          from: { id: 42, username: "owner" },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    const secondTurn = await appState.app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        message: {
          text: "thread two",
          message_thread_id: 1002,
          chat: { id: 7002 },
          from: { id: 42, username: "owner" },
        },
      },
    });

    expect(secondTurn.statusCode).toBe(200);
    expect(secondTurn.json()).toMatchObject({
      ok: true,
      response: "Echo: thread two",
    });

    const completedTurn = await firstTurn;
    expect(completedTurn.statusCode).toBe(200);
    expect(completedTurn.json()).toMatchObject({
      ok: true,
      response: "Echo: thread one",
    });

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
          attemptKey: "audio",
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
          attemptKey: "image",
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
          attemptKey: "document",
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

        let document: Record<string, any> | null = null;
        await waitForCondition(async () => {
          const documentsResponse = await appState.app.inject({
            method: "GET",
            url: "/api/documents",
            headers: {
              cookie: appState.cookie,
            },
          });
          document = documentsResponse
            .json<Array<Record<string, any>>>()
            .find((item) => item.fileId === testCase.fileId) ?? null;
          return Boolean(document);
        }, 5_000, 50);
        expect(document).toBeTruthy();

        const jobsResponse = await appState.app.inject({
          method: "GET",
          url: "/api/jobs",
          headers: {
            cookie: appState.cookie,
          },
        });
        let queuedJob = jobsResponse
          .json<Array<Record<string, any>>>()
          .find((job) =>
            job.payload?.documentId === document?.id && job.kind === testCase.expectedStatus
          ) ?? null;

        if (queuedJob && queuedJob.status !== "completed") {
          const refreshedJobsResponse = await appState.app.inject({
            method: "GET",
            url: "/api/jobs",
            headers: {
              cookie: appState.cookie,
            },
          });
          queuedJob = refreshedJobsResponse
            .json<Array<Record<string, any>>>()
            .find((job) => job.id === queuedJob?.id) ?? queuedJob;
        }
        if (queuedJob && queuedJob.status !== "completed") {
          const retry = await appState.app.inject({
            method: "POST",
            url: `/api/jobs/${String(queuedJob.id)}/retry`,
            headers: {
              cookie: appState.cookie,
            },
          });
          expect(retry.statusCode).toBe(200);
        }
      }

      expect(flakyProviderMediaInvoker).toHaveBeenCalled();

      await appState.app.close();
    } finally {
      fetchSpy.mockRestore();
    }
  }, 15_000);

  it("emits a Telegram reply when recovering an interrupted turn", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    const providerId = await upsertPrimaryProviderApiKey(appState.app, appState.cookie);
    const internals = (appState.app as any).__pulsarbot as {
      state: {
        repository: {
          getWorkspace(): Promise<Record<string, any> | null>;
          getSearchSettings(): Promise<Record<string, any>>;
          listAgentProfiles(): Promise<Array<Record<string, any>>>;
          saveConversation(conversation: Record<string, any>): Promise<void>;
          saveConversationTurn(turn: Record<string, any>): Promise<void>;
          saveTurnStateSnapshot(state: ReturnType<typeof TurnStateSchema.parse>): Promise<void>;
          getConversationTurn(id: string): Promise<Record<string, any> | null>;
        };
      };
      telegram: {
        bot: {
          api: {
            sendMessage: ReturnType<typeof vi.fn>;
          };
        };
      };
      recoverInterruptedTurns(): Promise<void>;
    };
    const workspace = await internals.state.repository.getWorkspace();
    const profiles = await internals.state.repository.listAgentProfiles();
    const profile = profiles.find((item) => item.primaryModelProfileId === providerId) ?? profiles[0];
    expect(workspace).toBeTruthy();
    expect(profile).toBeTruthy();

    const turnId = "turn_recovery_case";
    const conversationId = "telegram:4242";
    const timestamp = "2026-03-12T00:00:00.000Z";

    await internals.state.repository.saveConversation({
      id: conversationId,
      workspaceId: String(workspace!.id),
      telegramChatId: "4242",
      telegramUserId: "42",
      mode: "private",
      activeTurnLock: true,
      activeTurnLockExpiresAt: "2026-03-12T00:01:30.000Z",
      lastTurnId: turnId,
      lastCompactedAt: null,
      lastSummaryId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await internals.state.repository.saveConversationTurn({
      id: turnId,
      workspaceId: String(workspace!.id),
      conversationId,
      profileId: String(profile!.id),
      status: "running",
      stepCount: 0,
      toolCallCount: 0,
      compacted: false,
      summaryId: null,
      error: null,
      graphVersion: "v2",
      stateSnapshotId: "state_recovery_case",
      lastEventSeq: 0,
      currentNode: "run_agent_graph",
      resumeEligible: true,
      startedAt: timestamp,
      finishedAt: null,
      lockExpiresAt: "2026-03-12T00:01:30.000Z",
      updatedAt: timestamp,
    });
    await internals.state.repository.saveTurnStateSnapshot(
      TurnStateSchema.parse({
        id: "state_recovery_case",
        turnId,
        workspaceId: String(workspace!.id),
        conversationId,
        graphVersion: "v2",
        status: "running",
        currentNode: "run_agent_graph",
        version: 1,
        input: {
          updateId: 100,
          chatId: 4242,
          threadId: null,
          userId: 42,
          username: "owner",
          messageId: 9,
          contentKind: "text",
          normalizedText: "hello",
          rawMetadata: {},
        },
        context: {
          profileId: String(profile!.id),
          timezone: "UTC",
          nowIso: timestamp,
          runtimeSnapshot: {},
          searchSettings: await internals.state.repository.getSearchSettings(),
          historyWindow: 0,
          summaryCursor: null,
        },
        budgets: {
          maxPlanningSteps: 8,
          maxToolCalls: 6,
          maxTurnDurationMs: 30_000,
          stepsUsed: 0,
          toolCallsUsed: 0,
          deadlineAt: "2026-03-12T00:00:30.000Z",
        },
        output: {
          replyText: "",
          telegramReplyMessageId: null,
          streamingEnabled: false,
          lastRenderedChars: 0,
        },
        recovery: {
          resumeEligible: true,
          resumeCount: 0,
          lastRecoveredAt: null,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );

    await internals.recoverInterruptedTurns();

    expect(internals.telegram.bot.api.sendMessage).toHaveBeenCalledWith(4242, "OK");
    const recoveredTurn = await internals.state.repository.getConversationTurn(turnId);
    expect(recoveredTurn).toMatchObject({
      id: turnId,
      status: "completed",
      resumeEligible: false,
    });

    await appState.app.close();
  });

  it("marks import and export runs as failed when execution throws", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    const internals = (appState.app as any).__pulsarbot as {
      state: {
        exportBundle: (passphrase: string) => Promise<unknown>;
        importBundle: (bundle: unknown, passphrase: string) => Promise<void>;
        repository: {
          listImportExportRuns(limit?: number): Promise<Array<Record<string, any>>>;
        };
      };
    };

    const exportSpy = vi.spyOn(internals.state, "exportBundle").mockRejectedValueOnce(
      new Error("export failed"),
    );
    const exported = await appState.app.inject({
      method: "POST",
      url: "/api/settings/export",
      headers: {
        cookie: appState.cookie,
      },
      payload: {
        accessToken: "dev-access-token",
      },
    });
    expect(exported.statusCode).toBe(500);
    const exportRun = (await internals.state.repository.listImportExportRuns(10))
      .find((run) => run.type === "export");
    expect(exportRun).toMatchObject({
      status: "failed",
      error: "export failed",
    });
    exportSpy.mockRestore();

    const importSpy = vi.spyOn(internals.state, "importBundle").mockRejectedValueOnce(
      new Error("import failed"),
    );
    const imported = await appState.app.inject({
      method: "POST",
      url: "/api/settings/import",
      headers: {
        cookie: appState.cookie,
      },
      payload: {
        accessToken: "dev-access-token",
        bundle: {},
      },
    });
    expect(imported.statusCode).toBe(500);
    const importRun = (await internals.state.repository.listImportExportRuns(10))
      .find((run) => run.type === "import");
    expect(importRun).toMatchObject({
      status: "failed",
      error: "import failed",
    });
    importSpy.mockRestore();

    await appState.app.close();
  });

  it("protects provider deletion and cleans profile references for deleted MCP servers and agent profiles", async () => {
    const dataDir = await createTempDataDir();
    createdDirs.push(dataDir);

    const appState = await bootstrapApp(dataDir);
    const providerId = await upsertPrimaryProviderApiKey(appState.app, appState.cookie);

    const profilesResponse = await appState.app.inject({
      method: "GET",
      url: "/api/agent-profiles",
      headers: {
        cookie: appState.cookie,
      },
    });
    const profile = profilesResponse
      .json<Array<Record<string, any>>>()
      .find((item) => item.primaryModelProfileId === providerId);
    expect(profile).toBeTruthy();

    const createdServer = await appState.app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      headers: {
        cookie: appState.cookie,
      },
      payload: {
        label: "Custom MCP",
        transport: "stdio",
        command: "npx",
        args: ["example-mcp"],
        enabled: true,
      },
    });
    expect(createdServer.statusCode).toBe(200);
    const server = createdServer.json<Record<string, any>>();

    const updatedProfile = await appState.app.inject({
      method: "PUT",
      url: `/api/agent-profiles/${String(profile!.id)}`,
      headers: {
        cookie: appState.cookie,
      },
      payload: {
        ...profile,
        enabledMcpServerIds: [...(profile!.enabledMcpServerIds ?? []), String(server.id)],
      },
    });
    expect(updatedProfile.statusCode).toBe(200);

    const deleteProvider = await appState.app.inject({
      method: "DELETE",
      url: `/api/providers/${providerId}`,
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(deleteProvider.statusCode).toBe(409);

    const deleteServer = await appState.app.inject({
      method: "DELETE",
      url: `/api/mcp/servers/${String(server.id)}`,
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(deleteServer.statusCode).toBe(200);

    const refreshedProfiles = await appState.app.inject({
      method: "GET",
      url: "/api/agent-profiles",
      headers: {
        cookie: appState.cookie,
      },
    });
    const refreshedProfile = refreshedProfiles
      .json<Array<Record<string, any>>>()
      .find((item) => item.id === profile!.id);
    expect(refreshedProfile?.enabledMcpServerIds ?? []).not.toContain(String(server.id));

    const deleteProfile = await appState.app.inject({
      method: "DELETE",
      url: `/api/agent-profiles/${String(profile!.id)}`,
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(deleteProfile.statusCode).toBe(200);

    const workspaceResponse = await appState.app.inject({
      method: "GET",
      url: "/api/workspace",
      headers: {
        cookie: appState.cookie,
      },
    });
    expect(workspaceResponse.json<Record<string, any>>().workspace).toMatchObject({
      activeAgentProfileId: null,
    });

    await appState.app.close();
  });

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
