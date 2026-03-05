import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import sensible from "@fastify/sensible";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { AgentRuntime } from "@pulsarbot/agent";
import { CloudflareApiClient } from "@pulsarbot/cloudflare";
import {
  AppError,
  createId,
  createLogger,
  deriveHkdfKeyMaterial,
  loadEnv,
  nowIso,
} from "@pulsarbot/core";
import {
  createDefaultInstallRecords,
  filterCatalogByKind,
  loadMarketCatalog,
  resolveRuntimeSnapshot,
} from "@pulsarbot/market";
import { createMcpSupervisor, type McpSupervisor } from "@pulsarbot/mcp";
import { CloudflareMemoryStore } from "@pulsarbot/memory";
import {
  invokeProvider,
  invokeProviderMedia,
  supportsProviderCapability,
  type ProviderMediaInvocationInput,
  type ProviderInvocationInput,
  type ProviderInvocationResult,
} from "@pulsarbot/providers";
import {
  AgentProfileSchema,
  CloudflareCredentialsSchema,
  McpServerConfigSchema,
  ProviderTestCapabilitySchema,
  ProviderProfileSchema,
  ResolvedRuntimeSnapshotSchema,
  SearchSettingsSchema,
  WorkspaceExportBundleSchema,
  WorkspaceSchema,
  type AgentProfile,
  type CloudflareCredentials,
  type ConversationTurn,
  type DocumentArtifact,
  type DocumentMetadata,
  type InstallRecord,
  type LooseJsonValue,
  type McpServerConfig,
  type MemoryDocument,
  type ProviderTestCapability,
  type ProviderProfile,
  type ProviderTestRunResult,
  type ResolvedRuntimeSnapshot,
  type SearchSettings,
  type TelegramInboundContent,
  type Workspace,
} from "@pulsarbot/shared";
import {
  D1AppRepository,
  InMemoryAppRepository,
  decryptSecret,
  encryptSecret,
  requireWorkspace,
  rewrapSecret,
  runMigrations,
  type AppRepository,
  type ConversationMessage,
} from "@pulsarbot/storage";
import {
  createTelegramBot,
  type TelegramUpdatePayload,
} from "@pulsarbot/telegram";

const logger = createLogger({ name: "server" });
const repoRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const execFile = promisify(execFileCallback);

interface BootstrapFilePayload {
  workspaceId: string;
  cloudflareCredentials: CloudflareCredentials;
}

type BootstrapWorkspaceMode = "new" | "existing";

interface BootstrapWorkspaceSelection {
  d1DatabaseId?: string;
  r2BucketName?: string;
  vectorizeIndexName?: string;
  aiSearchIndexName?: string;
}

interface CreateAppOptions {
  env?: ReturnType<typeof loadEnv>;
  mcpSupervisor?: McpSupervisor;
  backgroundPollMs?: number;
  cloudflareClientFactory?: (credentials: CloudflareCredentials) => CloudflareApiClient;
  providerInvoker?: (args: {
    profile: ProviderProfile;
    apiKey: string;
    input: ProviderInvocationInput;
  }) => Promise<ProviderInvocationResult>;
  providerMediaInvoker?: (args: {
    profile: ProviderProfile;
    apiKey: string;
    input: ProviderMediaInvocationInput;
  }) => Promise<ProviderInvocationResult | null>;
  telegramFactory?: typeof createTelegramBot;
}

function compactRecord<T extends Record<string, string | undefined>>(
  value: T,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => Boolean(item)),
  ) as Record<string, string>;
}

function normalizeInstallGroups(records: InstallRecord[]) {
  return {
    skillInstalls: records.filter((item) => item.kind === "skills"),
    pluginInstalls: records.filter((item) => item.kind === "plugins"),
    mcpInstalls: records.filter((item) => item.kind === "mcp"),
  };
}

function toLooseJsonRecord(
  value: Record<string, unknown>,
): Record<string, LooseJsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, LooseJsonValue>;
}

function isoAfter(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function isIsoInFuture(value: string | null | undefined): boolean {
  return Boolean(value && Date.parse(value) > Date.now());
}

function isMissingSecretError(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.code === "SECRET_NOT_FOUND";
  }
  return error instanceof Error && error.message.startsWith("Secret not found for scope:");
}

interface TelegramWebhookInfo {
  url?: string;
  has_custom_certificate?: boolean;
  pending_update_count?: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  last_synchronization_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
}

function normalizePublicBaseUrl(input: string | undefined): string | null {
  if (!input) {
    return null;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function normalizeWebhookUrlInput(input: string | undefined): string | null {
  if (!input) {
    return null;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    const base = normalizePublicBaseUrl(trimmed);
    if (!base) {
      return null;
    }
    return new URL("/telegram/webhook", `${base}/`).toString();
  }
}

function inferPublicBaseUrlFromRequest(request: FastifyRequest): string | null {
  const forwardedProtoRaw = request.headers["x-forwarded-proto"];
  const forwardedHostRaw = request.headers["x-forwarded-host"];
  const hostRaw = request.headers.host;

  const forwardedProto = Array.isArray(forwardedProtoRaw)
    ? forwardedProtoRaw[0]
    : forwardedProtoRaw;
  const forwardedHost = Array.isArray(forwardedHostRaw)
    ? forwardedHostRaw[0]
    : forwardedHostRaw;
  const host = Array.isArray(hostRaw) ? hostRaw[0] : hostRaw;

  const proto = typeof forwardedProto === "string" && forwardedProto.trim()
    ? forwardedProto.split(",")[0]!.trim()
    : "https";
  const hostValue = typeof forwardedHost === "string" && forwardedHost.trim()
    ? forwardedHost.split(",")[0]!.trim()
    : typeof host === "string" && host.trim()
      ? host.trim()
      : "";

  if (!hostValue) {
    return null;
  }

  return normalizePublicBaseUrl(`${proto}://${hostValue}`);
}

function resolveExpectedTelegramWebhookUrl(
  env: ReturnType<typeof loadEnv>,
  request: FastifyRequest | null = null,
): string | null {
  if (env.TELEGRAM_WEBHOOK_URL) {
    try {
      return new URL(env.TELEGRAM_WEBHOOK_URL).toString();
    } catch {
      return null;
    }
  }

  const baseUrl =
    normalizePublicBaseUrl(env.PUBLIC_BASE_URL) ??
    normalizePublicBaseUrl(env.RAILWAY_STATIC_URL) ??
    normalizePublicBaseUrl(env.RAILWAY_PUBLIC_DOMAIN) ??
    (request ? inferPublicBaseUrlFromRequest(request) : null);
  if (!baseUrl) {
    return null;
  }

  try {
    return new URL("/telegram/webhook", `${baseUrl}/`).toString();
  } catch {
    return null;
  }
}

async function requestTelegramBotApi<T>(
  token: string,
  method: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(6_000),
  });
  const payload = await response.json() as {
    ok: boolean;
    result?: T;
    description?: string;
  };

  if (!response.ok || !payload.ok || typeof payload.result === "undefined") {
    throw new Error(payload.description ?? `Telegram API ${method} failed`);
  }

  return payload.result;
}

async function getTelegramWebhookInfo(token: string): Promise<TelegramWebhookInfo> {
  return requestTelegramBotApi<TelegramWebhookInfo>(token, "getWebhookInfo", {
    method: "GET",
  });
}

async function setTelegramWebhook(
  token: string,
  url: string,
  dropPendingUpdates = false,
): Promise<boolean> {
  return requestTelegramBotApi<boolean>(token, "setWebhook", {
    method: "POST",
    body: JSON.stringify({
      url,
      drop_pending_updates: dropPendingUpdates,
    }),
  });
}

class RuntimeState {
  public repository: AppRepository = new InMemoryAppRepository();
  public readonly marketRoot = path.resolve(repoRootDir, "market");
  public readonly dataDir: string;
  public cloudflare: {
    credentials: CloudflareCredentials;
    client: CloudflareApiClient;
    databaseId: string;
  } | null = null;
  public catalog: Awaited<ReturnType<typeof loadMarketCatalog>> = {
    skills: [],
    plugins: [],
    mcp: [],
  };
  public readonly agent: AgentRuntime;

  private pendingCloudflare: CloudflareCredentials | null = null;

  public constructor(
    public readonly env = loadEnv(),
    private readonly options: CreateAppOptions = {},
  ) {
    this.dataDir = env.DATA_DIR;
    this.agent = new AgentRuntime(
      {
        resolveProviderProfile: (profileId) => this.resolveProviderProfile(profileId),
        resolveApiKey: (apiKeyRef) => this.resolveApiKey(apiKeyRef),
        listEnabledMcpServers: (ids) => this.listEnabledMcpServers(ids),
        listConversationSummaries: (conversationId) =>
          this.repository.listConversationSummaries(conversationId),
        enqueueJob: (input) =>
          this.queueJob({
            workspaceId: input.workspaceId,
            kind: input.kind,
            payload: input.payload,
          }),
        ...(options.mcpSupervisor
          ? {
              mcpSupervisor: options.mcpSupervisor,
            }
          : {}),
        createMemoryStore: (workspaceId) => this.createMemoryStore(workspaceId),
        ...(options.providerInvoker
          ? {
              invokeProvider: options.providerInvoker,
            }
          : {}),
      },
      this.dataDir,
    );
  }

  public async initialize(): Promise<void> {
    this.catalog = await loadMarketCatalog(this.marketRoot);
    const bootstrap = await this.readBootstrapFile();
    if (!bootstrap?.cloudflareCredentials.d1DatabaseId) {
      return;
    }

    const client = this.makeCloudflareClient(bootstrap.cloudflareCredentials);
    await runMigrations(client, bootstrap.cloudflareCredentials.d1DatabaseId);
    this.cloudflare = {
      credentials: bootstrap.cloudflareCredentials,
      client,
      databaseId: bootstrap.cloudflareCredentials.d1DatabaseId,
    };
    this.repository = this.env.NODE_ENV === "test"
      ? new InMemoryAppRepository()
      : new D1AppRepository(client, bootstrap.cloudflareCredentials.d1DatabaseId);
    await this.releaseExpiredConversationLocks();
  }

  public async resolveProviderProfile(profileId: string): Promise<ProviderProfile> {
    const profile = (await this.repository.listProviderProfiles()).find(
      (item) => item.id === profileId,
    );
    if (!profile) {
      throw new Error(`Provider profile not found: ${profileId}`);
    }
    return profile;
  }

  public async resolveApiKey(apiKeyRef: string): Promise<string> {
    const workspace = await this.repository.getWorkspace();
    requireWorkspace(workspace);
    const secret = await this.repository.getSecretByScope(workspace.id, apiKeyRef);
    if (!secret) {
      throw new AppError(
        "SECRET_NOT_FOUND",
        `Secret not found for scope: ${apiKeyRef}`,
        400,
      );
    }
    return decryptSecret({
      accessToken: this.env.PULSARBOT_ACCESS_TOKEN,
      workspaceId: workspace.id,
      envelope: secret,
    });
  }

  public async listEnabledMcpServers(ids: string[]) {
    const servers = await this.repository.listMcpServers();
    return Promise.all(
      servers
        .filter((server) => ids.includes(server.id) && server.enabled)
        .map((server) => this.resolveMcpServerConfig(server)),
    );
  }

  public async resolveMcpServerConfig(server: McpServerConfig): Promise<McpServerConfig> {
    const workspace = await this.repository.getWorkspace();
    if (!workspace) {
      return server;
    }

    const resolveValue = async (value: string) => {
      const secret = await this.repository.getSecretByScope(workspace.id, value);
      if (!secret) {
        return value;
      }
      try {
        return decryptSecret({
          accessToken: this.env.PULSARBOT_ACCESS_TOKEN,
          workspaceId: workspace.id,
          envelope: secret,
        });
      } catch {
        return value;
      }
    };

    const resolveStringRecord = async (record: Record<string, string>) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(record).map(async ([key, value]) => [key, await resolveValue(value)]),
        ),
      );

    return {
      ...server,
      envRefs: await resolveStringRecord(server.envRefs),
      headers: await resolveStringRecord(server.headers),
    };
  }

  public async runProvider(args: {
    profile: ProviderProfile;
    apiKey: string;
    input: ProviderInvocationInput;
  }) {
    return (this.options.providerInvoker ?? invokeProvider)(args);
  }

  public async runProviderMedia(args: {
    profile: ProviderProfile;
    apiKey: string;
    input: ProviderMediaInvocationInput;
  }) {
    return (this.options.providerMediaInvoker ?? invokeProviderMedia)(args);
  }

  public async createMemoryStore(workspaceId: string) {
    const cloudflare = this.requireCloudflare();
    const bucketName = cloudflare.credentials.r2BucketName;
    if (!bucketName) {
      throw new Error("R2 bucket is not configured for memory persistence");
    }

    return new CloudflareMemoryStore({
      workspaceId,
      cloudflare: cloudflare.client,
      repository: this.repository,
      bucketName,
      ...(cloudflare.credentials.aiSearchIndexName
        ? {
            aiSearchIndexName: cloudflare.credentials.aiSearchIndexName,
          }
        : {}),
      ...(cloudflare.credentials.vectorizeIndexName
        ? {
            vectorizeIndexName: cloudflare.credentials.vectorizeIndexName,
          }
        : {}),
      ...(cloudflare.credentials.vectorizeDimensions
        ? {
            vectorizeDimensions: cloudflare.credentials.vectorizeDimensions,
          }
        : {}),
    });
  }

  public async queueJob(args: {
    workspaceId: string;
    kind: "memory_reindex_document" | "memory_reindex_all" | "memory_refresh_before_compact" | "document_extract" | "telegram_file_fetch" | "telegram_voice_transcribe" | "telegram_image_describe" | "mcp_healthcheck" | "export_bundle_build";
    payload: Record<string, unknown>;
    runAfter?: string | null;
  }) {
    const timestamp = nowIso();
    await this.repository.saveJob({
      id: createId("job"),
      workspaceId: args.workspaceId,
      kind: args.kind,
      status: "pending",
      payload: toLooseJsonRecord(args.payload),
      result: {},
      attempts: 0,
      runAfter: args.runAfter ?? timestamp,
      lockedAt: null,
      lockedBy: null,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  public async releaseExpiredConversationLocks(): Promise<void> {
    const conversations = await this.repository.listConversations();
    const timestamp = nowIso();
    for (const conversation of conversations) {
      if (
        conversation.activeTurnLock &&
        conversation.activeTurnLockExpiresAt &&
        Date.parse(conversation.activeTurnLockExpiresAt) <= Date.now()
      ) {
        await this.repository.saveConversation({
          ...conversation,
          activeTurnLock: false,
          activeTurnLockExpiresAt: null,
          updatedAt: timestamp,
        });
      }
    }
  }

  public async listActiveConversationLocks(): Promise<ConversationTurn[]> {
    const turns = await this.repository.listConversationTurns({ status: "running" });
    return turns.filter((turn) => isIsoInFuture(turn.lockExpiresAt));
  }

  public async resolveRuntime(profile: AgentProfile): Promise<ResolvedRuntimeSnapshot> {
    const workspace = await this.repository.getWorkspace();
    requireWorkspace(workspace);
    return ResolvedRuntimeSnapshotSchema.parse(
      resolveRuntimeSnapshot({
        workspaceId: workspace.id,
        profile,
        searchSettings: await this.repository.getSearchSettings(),
        catalog: this.catalog,
        installs: await this.repository.listInstallRecords(),
        mcpServers: await this.repository.listMcpServers(),
      }),
    );
  }

  public async setPendingCloudflare(credentials: CloudflareCredentials): Promise<void> {
    this.pendingCloudflare = CloudflareCredentialsSchema.parse(credentials);
  }

  public getPendingCloudflare(): CloudflareCredentials | null {
    return this.pendingCloudflare ?? this.cloudflare?.credentials ?? null;
  }

  public async listCloudflareResources() {
    const credentials = this.getPendingCloudflare();
    if (!credentials) {
      throw new Error("Cloudflare credentials have not been connected");
    }
    const client = this.makeCloudflareClient(credentials) as CloudflareApiClient & Record<string, unknown>;
    const safeList = async (fn: string): Promise<unknown> => {
      const handler = client[fn];
      if (typeof handler !== "function") {
        return [];
      }
      try {
        return (await (handler as (this: typeof client) => Promise<unknown>).call(client)) ?? [];
      } catch (error) {
        logger.warn({ error, fn }, "Cloudflare resource listing failed");
        return [];
      }
    };

    const extractCollection = <T>(value: unknown, preferredKeys: string[]): T[] => {
      if (Array.isArray(value)) {
        return value as T[];
      }
      if (!value || typeof value !== "object") {
        return [];
      }

      const keys = [...preferredKeys, "result", "results", "data", "items"];
      const queue: Array<unknown> = [value];

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || typeof current !== "object") {
          continue;
        }
        const record = current as Record<string, unknown>;
        for (const key of keys) {
          const candidate = record[key];
          if (Array.isArray(candidate)) {
            return candidate as T[];
          }
          if (candidate && typeof candidate === "object") {
            queue.push(candidate);
          }
        }
      }

      return [];
    };

    const toNamedResources = (
      value: unknown,
      preferredKeys: string[],
    ): Array<{ name: string }> => {
      return extractCollection<unknown>(value, preferredKeys)
        .flatMap((item) => {
          if (typeof item === "string") {
            return [{ name: item }];
          }
          if (!item || typeof item !== "object") {
            return [];
          }
          const record = item as Record<string, unknown>;
          const nameCandidate = [
            record.name,
            record.id,
            record.index_name,
            record.bucket,
            record.bucketName,
            record.title,
          ].find((entry) => typeof entry === "string" && entry.length > 0);

          return typeof nameCandidate === "string"
            ? [{ name: nameCandidate }]
            : [];
        })
        .filter((entry, index, list) =>
          list.findIndex((candidate) => candidate.name === entry.name) === index
        );
    };

    const toD1Resources = (value: unknown): Array<{ uuid: string; name: string }> => {
      return extractCollection<unknown>(value, ["databases", "d1"])
        .flatMap((item) => {
          if (typeof item === "string") {
            return [{ uuid: item, name: item }];
          }
          if (!item || typeof item !== "object") {
            return [];
          }
          const record = item as Record<string, unknown>;
          const uuidCandidate = [
            record.uuid,
            record.id,
            record.database_id,
          ].find((entry) => typeof entry === "string" && entry.length > 0);
          if (typeof uuidCandidate !== "string") {
            return [];
          }
          const nameCandidate = typeof record.name === "string" && record.name.length > 0
            ? record.name
            : uuidCandidate;
          return [{ uuid: uuidCandidate, name: nameCandidate }];
        })
        .filter((entry, index, list) =>
          list.findIndex((candidate) => candidate.uuid === entry.uuid) === index
        );
    };

    return {
      d1: toD1Resources(await safeList("listD1Databases")),
      r2: toNamedResources(await safeList("listR2Buckets"), ["buckets", "r2"]),
      vectorize: toNamedResources(await safeList("listVectorizeIndexes"), [
        "indexes",
        "vectorize",
      ]),
      aiSearch: toNamedResources(await safeList("listAiSearchIndexes"), [
        "indexes",
        "rags",
        "aiSearch",
      ]),
    };
  }

  public async bootstrapWorkspace(args: {
    ownerTelegramUserId: string;
    ownerTelegramUsername?: string | undefined;
    label?: string | undefined;
    timezone?: string | undefined;
    mode?: BootstrapWorkspaceMode;
    selection?: BootstrapWorkspaceSelection | undefined;
  }): Promise<void> {
    if (!this.pendingCloudflare) {
      throw new Error("Cloudflare credentials have not been connected");
    }

    const defaultWorkspaceId = "main";
    const mode = args.mode ?? "new";
    const client = this.makeCloudflareClient(this.pendingCloudflare);
    let existingWorkspace: Workspace | null = null;
    let storedCredentials: CloudflareCredentials | null = null;

    if (mode === "existing") {
      if (!args.selection?.d1DatabaseId) {
        throw new Error("Select an existing D1 database before loading a workspace");
      }

      await this.activateCloudflareRepository(
        CloudflareCredentialsSchema.parse({
          ...this.pendingCloudflare,
          d1DatabaseId: args.selection.d1DatabaseId,
        }),
      );
      existingWorkspace = await this.repository.getWorkspace();
      if (existingWorkspace) {
        storedCredentials = await this.readStoredCloudflareCredentials(existingWorkspace.id);
      }
    }

    const workspaceId = existingWorkspace?.id ?? defaultWorkspaceId;
    const selection = compactRecord({
      d1DatabaseId: args.selection?.d1DatabaseId,
      r2BucketName: args.selection?.r2BucketName ?? storedCredentials?.r2BucketName,
      vectorizeIndexName:
        args.selection?.vectorizeIndexName ?? storedCredentials?.vectorizeIndexName,
      aiSearchIndexName:
        args.selection?.aiSearchIndexName ?? storedCredentials?.aiSearchIndexName,
    });
    const resources = await client.initializeWorkspaceResources(
      Object.keys(selection).length > 0
        ? {
            workspaceId,
            selection,
          }
        : {
            workspaceId,
          },
    );
    const credentials = CloudflareCredentialsSchema.parse({
      ...storedCredentials,
      ...this.pendingCloudflare,
      ...(this.pendingCloudflare.apiToken
        ? {
            apiToken: this.pendingCloudflare.apiToken,
            globalApiKey: undefined,
            email: undefined,
          }
        : {
            apiToken: undefined,
            globalApiKey: this.pendingCloudflare.globalApiKey,
            email: this.pendingCloudflare.email,
          }),
      d1DatabaseId: resources.d1DatabaseId,
      r2BucketName: resources.r2BucketName,
      vectorizeIndexName: resources.vectorizeIndexName,
      aiSearchIndexName: resources.aiSearchIndexName,
      r2AccessKeyId:
        this.pendingCloudflare.r2AccessKeyId ?? storedCredentials?.r2AccessKeyId,
      r2SecretAccessKey:
        this.pendingCloudflare.r2SecretAccessKey ??
        storedCredentials?.r2SecretAccessKey,
      vectorizeDimensions:
        this.pendingCloudflare.vectorizeDimensions ??
        storedCredentials?.vectorizeDimensions ??
        256,
    });

    await this.activateCloudflareRepository(credentials);
    existingWorkspace = await this.repository.getWorkspace();

    const timestamp = nowIso();
    const resolvedWorkspaceId = existingWorkspace?.id ?? workspaceId;

    if (existingWorkspace) {
      await this.repository.saveWorkspace({
        ...existingWorkspace,
        ownerTelegramUserId: args.ownerTelegramUserId,
        ownerTelegramUsername:
          args.ownerTelegramUsername ?? existingWorkspace.ownerTelegramUsername,
        updatedAt: timestamp,
      });
    } else {
      await this.seedFreshWorkspace({
        workspaceId: resolvedWorkspaceId,
        ownerTelegramUserId: args.ownerTelegramUserId,
        ownerTelegramUsername: args.ownerTelegramUsername,
        label: args.label,
        timezone: args.timezone,
        timestamp,
      });
    }

    await this.repository.saveBootstrapState({
      verified: true,
      ownerBound: true,
      cloudflareConnected: true,
      resourcesInitialized: true,
    });
    await this.repository.saveAdminIdentity({
      workspaceId: resolvedWorkspaceId,
      telegramUserId: args.ownerTelegramUserId,
      telegramUsername: args.ownerTelegramUsername ?? null,
      role: "owner",
      boundAt: timestamp,
      lastVerifiedAt: timestamp,
    });
    await this.repository.saveSecret(
      encryptSecret({
        accessToken: this.env.PULSARBOT_ACCESS_TOKEN,
        workspaceId: resolvedWorkspaceId,
        scope: "cloudflare:credentials",
        plainText: JSON.stringify(credentials),
      }),
    );
    await this.writeBootstrapFile({
      workspaceId: resolvedWorkspaceId,
      cloudflareCredentials: credentials,
    });
  }

  private async activateCloudflareRepository(credentials: CloudflareCredentials) {
    if (!credentials.d1DatabaseId) {
      throw new Error("Cloudflare D1 database is required to initialize the repository");
    }

    const client = this.makeCloudflareClient(credentials);
    await runMigrations(client, credentials.d1DatabaseId);
    this.cloudflare = {
      credentials,
      client,
      databaseId: credentials.d1DatabaseId,
    };
    this.repository = this.env.NODE_ENV === "test"
      ? new InMemoryAppRepository()
      : new D1AppRepository(client, credentials.d1DatabaseId);
  }

  private async readStoredCloudflareCredentials(
    workspaceId: string,
  ): Promise<CloudflareCredentials | null> {
    const secret = await this.repository.getSecretByScope(
      workspaceId,
      "cloudflare:credentials",
    );
    if (!secret) {
      return null;
    }

    try {
      return CloudflareCredentialsSchema.parse(
        JSON.parse(
          decryptSecret({
            accessToken: this.env.PULSARBOT_ACCESS_TOKEN,
            workspaceId,
            envelope: secret,
          }),
        ),
      );
    } catch (error) {
      logger.warn({ error, workspaceId }, "Stored Cloudflare credentials could not be loaded");
      return null;
    }
  }

  private async seedFreshWorkspace(args: {
    workspaceId: string;
    ownerTelegramUserId: string;
    ownerTelegramUsername?: string | undefined;
    label?: string | undefined;
    timezone?: string | undefined;
    timestamp: string;
  }) {
    const primaryProviderProfileId = createId("provider");
    const backgroundProviderProfileId = createId("provider");
    const balancedProfileId = createId("agent");
    const backgroundProfileId = createId("agent");
    const workspace = WorkspaceSchema.parse({
      id: args.workspaceId,
      label: args.label ?? "Pulsarbot Workspace",
      timezone: args.timezone ?? "UTC",
      ownerTelegramUserId: args.ownerTelegramUserId,
      ownerTelegramUsername: args.ownerTelegramUsername ?? null,
      primaryModelProfileId: primaryProviderProfileId,
      backgroundModelProfileId: backgroundProviderProfileId,
      activeAgentProfileId: balancedProfileId,
      createdAt: args.timestamp,
      updatedAt: args.timestamp,
    });

    await this.repository.saveWorkspace(workspace);
    await this.repository.saveSearchSettings(
      SearchSettingsSchema.parse({
        id: "main",
        createdAt: args.timestamp,
        updatedAt: args.timestamp,
      }),
    );

    for (const record of createDefaultInstallRecords(this.catalog)) {
      await this.repository.saveInstallRecord(record);
    }

    const makeProvider = (
      id: string,
      label: string,
      apiKeyRef: string,
      stream: boolean,
    ): ProviderProfile => ({
      id,
      kind: "openai",
      label,
      apiBaseUrl: "https://api.openai.com/v1",
      apiKeyRef,
      defaultModel: "gpt-4.1-mini",
      visionModel: null,
      audioModel: null,
      documentModel: null,
      stream,
      reasoningEnabled: false,
      reasoningLevel: "off",
      thinkingBudget: null,
      temperature: stream ? 0.2 : 0.1,
      topP: null,
      maxOutputTokens: stream ? 2048 : 1024,
      toolCallingEnabled: stream,
      jsonModeEnabled: stream,
      visionEnabled: false,
      audioInputEnabled: false,
      documentInputEnabled: false,
      headers: {},
      extraBody: {},
      enabled: true,
      createdAt: args.timestamp,
      updatedAt: args.timestamp,
    });

    await this.repository.saveProviderProfile(
      makeProvider(
        primaryProviderProfileId,
        "Primary Provider",
        "provider:primary:apiKey",
        true,
      ),
    );
    await this.repository.saveProviderProfile(
      makeProvider(
        backgroundProviderProfileId,
        "Background Provider",
        "provider:background:apiKey",
        false,
      ),
    );

    await this.repository.saveAgentProfile(
      AgentProfileSchema.parse({
        id: balancedProfileId,
        label: "balanced",
        description: "Default interactive Telegram profile.",
        systemPrompt:
          "You are Pulsarbot, a Telegram-native personal agent with tools, memory, and concise answers.",
        primaryModelProfileId: primaryProviderProfileId,
        backgroundModelProfileId: backgroundProviderProfileId,
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
        createdAt: args.timestamp,
        updatedAt: args.timestamp,
      }),
    );
    await this.repository.saveAgentProfile(
      AgentProfileSchema.parse({
        id: backgroundProfileId,
        label: "background-low-cost",
        description: "Compact and summarize conversations.",
        systemPrompt: "You summarize and compact conversations for Pulsarbot.",
        primaryModelProfileId: backgroundProviderProfileId,
        backgroundModelProfileId: null,
        embeddingModelProfileId: null,
        enabledSkillIds: ["core-agent"],
        enabledPluginIds: ["time-context"],
        enabledMcpServerIds: [],
        maxPlanningSteps: 2,
        maxToolCalls: 1,
        maxTurnDurationMs: 15_000,
        maxToolDurationMs: 10_000,
        compactSoftThreshold: 0.7,
        compactHardThreshold: 0.85,
        allowNetworkTools: false,
        allowWriteTools: true,
        allowMcpTools: false,
        createdAt: args.timestamp,
        updatedAt: args.timestamp,
      }),
    );
  }

  public async exportBundle(exportPassphrase: string) {
    const workspace = await this.repository.getWorkspace();
    requireWorkspace(workspace);
    const memories = await this.readMemoryDocumentsForExport(workspace.id);
    const installs = await this.repository.listInstallRecords();
    const documents = await this.repository.listDocuments();
    const bundle = WorkspaceExportBundleSchema.parse({
      version: "0.2.0",
      workspace,
      providers: await this.repository.listProviderProfiles(),
      profiles: await this.repository.listAgentProfiles(),
      ...normalizeInstallGroups(installs),
      installs,
      mcpServers: await this.repository.listMcpServers(),
      searchSettings: await this.repository.getSearchSettings(),
      documents,
      documentArtifacts: await this.readDocumentArtifactsForExport(workspace.id, documents),
      memories,
      encryptedSecrets: (await this.repository.listSecrets()).map((secret) => {
        const plain = decryptSecret({
          accessToken: this.env.PULSARBOT_ACCESS_TOKEN,
          workspaceId: workspace.id,
          envelope: secret,
        });
        return encryptSecret({
          accessToken: exportPassphrase,
          workspaceId: workspace.id,
          scope: secret.scope,
          plainText: plain,
          existingId: secret.id,
        });
      }),
    });
    return bundle;
  }

  public async importBundle(bundle: unknown, importPassphrase: string) {
    const parsed = WorkspaceExportBundleSchema.parse(bundle);
    const installs = parsed.installs.length
      ? parsed.installs
      : [
          ...parsed.skillInstalls,
          ...parsed.pluginInstalls,
          ...parsed.mcpInstalls,
        ];
    await this.repository.saveWorkspace(parsed.workspace);
    await this.repository.saveSearchSettings(
      parsed.searchSettings ??
        SearchSettingsSchema.parse({
          id: "main",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }),
    );
    for (const profile of parsed.providers) {
      await this.repository.saveProviderProfile(profile);
    }
    for (const profile of parsed.profiles) {
      await this.repository.saveAgentProfile(profile);
    }
    for (const install of installs) {
      await this.repository.saveInstallRecord(install);
    }
    for (const server of parsed.mcpServers) {
      await this.repository.saveMcpServer(server);
    }
    for (const document of parsed.documents) {
      await this.repository.saveDocument(document);
    }
    await this.restoreDocumentArtifacts(parsed.workspace.id, parsed.documentArtifacts);
    await this.restoreMemoryDocuments(parsed.workspace.id, parsed.memories);

    for (const secret of parsed.encryptedSecrets) {
      const plain = decryptSecret({
        accessToken: importPassphrase,
        workspaceId: parsed.workspace.id,
        envelope: secret,
      });
      await this.repository.saveSecret(
        encryptSecret({
          accessToken: this.env.PULSARBOT_ACCESS_TOKEN,
          workspaceId: parsed.workspace.id,
          scope: secret.scope,
          plainText: plain,
          existingId: secret.id,
        }),
      );
    }

    try {
      const store = await this.createMemoryStore(parsed.workspace.id);
      await store.queueFullReindex();
      await store.processPendingJobs(20);
    } catch {
      logger.warn(
        "Memory reindex skipped after import because Cloudflare memory resources are unavailable",
      );
    }
  }

  public async rewrapAllSecrets(args: {
    workspaceId: string;
    oldAccessToken: string;
    newAccessToken: string;
  }) {
    const secrets = await this.repository.listSecrets();
    for (const secret of secrets.filter((item) => item.workspaceId === args.workspaceId)) {
      await this.repository.saveSecret(
        rewrapSecret({
          oldAccessToken: args.oldAccessToken,
          newAccessToken: args.newAccessToken,
          workspaceId: args.workspaceId,
          envelope: secret,
        }),
      );
    }
  }

  private async readBootstrapFile(): Promise<BootstrapFilePayload | null> {
    const target = this.bootstrapFilePath();
    try {
      const raw = await readFile(target, "utf8");
      const envelope = JSON.parse(raw);
      const plainText = decryptSecret({
        accessToken: this.env.PULSARBOT_ACCESS_TOKEN,
        workspaceId: "bootstrap",
        envelope,
      });
      return JSON.parse(plainText) as BootstrapFilePayload;
    } catch {
      return null;
    }
  }

  private async writeBootstrapFile(payload: BootstrapFilePayload): Promise<void> {
    const target = this.bootstrapFilePath();
    await mkdir(path.dirname(target), { recursive: true });
    const envelope = encryptSecret({
      accessToken: this.env.PULSARBOT_ACCESS_TOKEN,
      workspaceId: "bootstrap",
      scope: "cloudflare-bootstrap",
      plainText: JSON.stringify(payload),
    });
    await writeFile(target, JSON.stringify(envelope, null, 2), "utf8");
  }

  private bootstrapFilePath(): string {
    return path.join(this.dataDir, "bootstrap", "cloudflare.json");
  }

  public makeCloudflareClient(credentials: CloudflareCredentials) {
    return this.options.cloudflareClientFactory?.(credentials) ?? new CloudflareApiClient(credentials);
  }

  public requireCloudflare() {
    if (!this.cloudflare) {
      throw new Error("Cloudflare resources are not initialized");
    }
    return this.cloudflare;
  }

  private async readMemoryDocumentsForExport(
    workspaceId: string,
  ): Promise<MemoryDocument[]> {
    const cloudflare = this.cloudflare;
    const documents = await this.repository.listMemoryDocuments();

    if (!cloudflare?.credentials.r2BucketName) {
      return documents.filter((item) => item.workspaceId === workspaceId);
    }

    const scoped = documents.filter((item) => item.workspaceId === workspaceId);
    const enriched = await Promise.all(
      scoped.map(async (document) => ({
        ...document,
        content:
          (await cloudflare.client.getR2Object({
            bucketName: cloudflare.credentials.r2BucketName!,
            key: `workspace/${workspaceId}/${document.path}`,
          })) ?? undefined,
      })),
    );
    return enriched;
  }

  private async restoreMemoryDocuments(
    workspaceId: string,
    documents: MemoryDocument[],
  ): Promise<void> {
    const cloudflare = this.cloudflare;
    for (const document of documents) {
      await this.repository.saveMemoryDocument({
        ...document,
        content: undefined,
      });

      if (!document.content || !cloudflare?.credentials.r2BucketName) {
        continue;
      }

      await cloudflare.client.putR2Object({
        bucketName: cloudflare.credentials.r2BucketName,
        key: `workspace/${workspaceId}/${document.path}`,
        body: document.content,
      });
    }
  }

  private documentObjectKey(workspaceId: string, relativePath: string): string {
    return `workspace/${workspaceId}/${relativePath}`;
  }

  private async readDocumentArtifactsForExport(
    workspaceId: string,
    documents: DocumentMetadata[],
  ): Promise<DocumentArtifact[]> {
    const cloudflare = this.cloudflare;
    if (!cloudflare?.credentials.r2BucketName) {
      return [];
    }

    const artifactRefs = documents.flatMap((document) =>
      [document.path, document.derivedTextPath]
        .filter((value): value is string => Boolean(value))
        .map((pathValue) => ({
          documentId: document.id,
          path: pathValue,
        })),
    );

    const uniqueRefs = [...new Map(artifactRefs.map((item) => [item.path, item])).values()];
    const artifacts: Array<DocumentArtifact | null> = await Promise.all(
      uniqueRefs.map(async (artifact) => {
        const payload = await cloudflare.client.getR2ObjectRaw({
          bucketName: cloudflare.credentials.r2BucketName!,
          key: this.documentObjectKey(workspaceId, artifact.path),
        });
        if (!payload) {
          return null;
        }
        return {
          documentId: artifact.documentId ?? null,
          path: artifact.path,
          contentBase64: Buffer.from(payload.body).toString("base64"),
          contentType: payload.contentType,
        } satisfies DocumentArtifact;
      }),
    );

    return artifacts.filter((artifact): artifact is DocumentArtifact => Boolean(artifact));
  }

  private async restoreDocumentArtifacts(
    workspaceId: string,
    artifacts: DocumentArtifact[],
  ): Promise<void> {
    const cloudflare = this.cloudflare;
    if (!cloudflare?.credentials.r2BucketName) {
      return;
    }

    for (const artifact of artifacts) {
      await cloudflare.client.putR2Object({
        bucketName: cloudflare.credentials.r2BucketName,
        key: this.documentObjectKey(workspaceId, artifact.path),
        body: Buffer.from(artifact.contentBase64, "base64"),
        ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
      });
    }
  }
}

function parseTelegramInitData(initData: string, botToken: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");
  const checkString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const digest = createHmac("sha256", secret).update(checkString).digest();

  if (!hash || !timingSafeEqual(Buffer.from(hash, "hex"), digest)) {
    throw new Error("Telegram initData verification failed");
  }

  const userRaw = params.get("user");
  const user = userRaw ? JSON.parse(userRaw) : null;
  return {
    userId: String(user?.id ?? ""),
    username: user?.username as string | undefined,
  };
}

function getJwtSecret(accessToken: string): string {
  return deriveHkdfKeyMaterial({
    accessToken,
    workspaceId: "server",
    info: "pulsarbot-jwt",
  }).toString("hex");
}

function normalizeInboundText(content: TelegramInboundContent): string {
  if (content.kind === "text") {
    return content.text ?? "";
  }

  const lines = [
    `User sent a ${content.kind} message.`,
    content.caption ? `Caption: ${content.caption}` : "",
    content.fileId ? `Telegram file id: ${content.fileId}` : "",
    content.mimeType ? `MIME type: ${content.mimeType}` : "",
    Object.keys(content.metadata ?? {}).length
      ? `Metadata: ${JSON.stringify(content.metadata)}`
      : "",
  ].filter(Boolean);

  return lines.join("\n");
}

function normalizeTelegramPayload(
  payload:
    | TelegramUpdatePayload
    | {
        chatId: number;
        threadId?: number | null;
        userId: number;
        username?: string;
        text?: string;
        messageId?: number | null;
      },
): TelegramUpdatePayload {
  if ("content" in payload && payload.content) {
    return {
      ...payload,
      threadId: payload.threadId ?? null,
    };
  }

  return {
    chatId: payload.chatId,
    threadId: payload.threadId ?? null,
    userId: payload.userId,
    username: payload.username,
    messageId: payload.messageId ?? null,
    content: {
      kind: "text",
      text: "text" in payload ? (payload.text ?? "") : "",
      metadata: {},
    },
  };
}

function sourceTypeForContent(content: TelegramInboundContent): ConversationMessage["sourceType"] {
  switch (content.kind) {
    case "text":
      return "text";
    case "voice":
      return "voice";
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "document":
      return "document";
  }
}

function safePathSegment(input: string): string {
  return input
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "file";
}

function fileExtensionForContent(content: TelegramInboundContent): string {
  const metadataFileName = typeof content.metadata?.fileName === "string"
    ? content.metadata.fileName
    : null;
  const existingExtension = metadataFileName?.split(".").pop()?.toLowerCase();
  if (existingExtension && existingExtension.length <= 10) {
    return existingExtension;
  }
  if (content.mimeType?.includes("pdf")) {
    return "pdf";
  }
  if (content.mimeType?.includes("json")) {
    return "json";
  }
  if (content.mimeType?.includes("csv")) {
    return "csv";
  }
  if (content.mimeType?.includes("markdown")) {
    return "md";
  }
  if (content.mimeType?.startsWith("text/")) {
    return "txt";
  }
  if (content.mimeType?.includes("word")) {
    return "docx";
  }
  if (content.kind === "voice") {
    return "ogg";
  }
  if (content.kind === "audio") {
    return "mp3";
  }
  if (content.kind === "image") {
    return "jpg";
  }
  return "bin";
}

function inferDocumentKind(content: TelegramInboundContent): DocumentMetadata["kind"] {
  if (content.mimeType?.includes("pdf")) {
    return "pdf";
  }
  if (content.mimeType?.includes("word")) {
    return "docx";
  }
  if (content.mimeType?.includes("json")) {
    return "json";
  }
  if (content.mimeType?.includes("csv")) {
    return "csv";
  }
  if (
    content.mimeType?.startsWith("text/") ||
    content.mimeType?.includes("markdown") ||
    fileExtensionForContent(content).match(/^(txt|md|yaml|yml|log)$/)
  ) {
    return "text";
  }
  return "binary";
}

function isTextualDocument(kind: DocumentMetadata["kind"]): boolean {
  return kind === "text" || kind === "json" || kind === "csv";
}

function decodeBestEffortText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function deriveDocumentText(args: {
  content: TelegramInboundContent;
  kind: DocumentMetadata["kind"];
  normalizedText: string;
  rawBody: Uint8Array | null;
}): string {
  if (args.rawBody && isTextualDocument(args.kind)) {
    const decoded = decodeBestEffortText(args.rawBody).trim();
    if (decoded) {
      return decoded.slice(0, 30_000);
    }
  }

  const metadata = args.content.metadata ?? {};
  const lines = [
    args.normalizedText,
    typeof metadata.fileName === "string" ? `File name: ${metadata.fileName}` : "",
    typeof metadata.fileSize === "number" ? `File size: ${metadata.fileSize} bytes` : "",
    typeof metadata.duration === "number" ? `Duration: ${metadata.duration} seconds` : "",
    typeof metadata.width === "number" && typeof metadata.height === "number"
      ? `Dimensions: ${metadata.width}x${metadata.height}`
      : "",
  ].filter(Boolean);

  return lines.join("\n").slice(0, 12_000);
}

const providerTestCapabilities = [
  "text",
  "vision",
  "audio",
  "document",
] as const satisfies ProviderTestCapability[];

function createProviderTestImageBytes(): Uint8Array {
  const width = 16;
  const height = 16;
  const rowLength = 1 + width * 4;
  const raw = Buffer.alloc(rowLength * height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * rowLength;
    raw[rowOffset] = 0; // PNG filter type: None
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = rowOffset + 1 + x * 4;
      raw[pixelOffset] = 24;
      raw[pixelOffset + 1] = 93;
      raw[pixelOffset + 2] = 214;
      raw[pixelOffset + 3] = 255;
    }
  }

  const crc32 = (input: Uint8Array): number => {
    let crc = 0xffffffff;
    for (const byte of input) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        const mask = -(crc & 1);
        crc = (crc >>> 1) ^ (0xedb88320 & mask);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };

  const chunk = (type: string, data: Uint8Array): Buffer => {
    const typeBytes = Buffer.from(type, "ascii");
    const dataBytes = Buffer.from(data);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(dataBytes.length, 0);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, dataBytes])), 0);
    return Buffer.concat([length, typeBytes, dataBytes, checksum]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);

  return Uint8Array.from(png);
}

function escapePdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function createProviderTestPdfBytes(): Uint8Array {
  const content = [
    "BT",
    "/F1 18 Tf",
    "36 96 Td",
    `(${escapePdfText("Pulsarbot provider test PDF")}) Tj`,
    "ET",
  ].join("\n");

  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let offset = Buffer.byteLength(header, "utf8");
  const offsets = objects.map((objectText) => {
    const current = offset;
    offset += Buffer.byteLength(objectText, "utf8");
    return current;
  });

  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`),
  ].join("");
  const trailer = [
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
  ].join("\n");

  return Uint8Array.from(
    Buffer.from(`${header}${objects.join("")}${xref}${trailer}`, "utf8"),
  );
}

function createProviderTestWavBytes(): Uint8Array {
  const sampleRate = 16_000;
  const durationMs = 250;
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.floor((sampleRate * durationMs) / 1000);
  const dataSize = sampleCount * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let offset = 0;
  const writeAscii = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
    offset += value.length;
  };

  writeAscii("RIFF");
  view.setUint32(offset, 36 + dataSize, true);
  offset += 4;
  writeAscii("WAVE");
  writeAscii("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, channels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * channels * bytesPerSample, true);
  offset += 4;
  view.setUint16(offset, channels * bytesPerSample, true);
  offset += 2;
  view.setUint16(offset, bitsPerSample, true);
  offset += 2;
  writeAscii("data");
  view.setUint32(offset, dataSize, true);

  return bytes;
}

function providerMediaTestInput(
  capability: Exclude<ProviderTestCapability, "text">,
): ProviderMediaInvocationInput {
  switch (capability) {
    case "vision":
      return {
        kind: "image",
        prompt: "Describe this provider test image in one sentence.",
        rawBody: createProviderTestImageBytes(),
        mimeType: "image/png",
        fileName: "provider-test.png",
      };
    case "audio":
      return {
        kind: "audio",
        prompt: "Transcribe this provider test audio. Return plain text only.",
        rawBody: createProviderTestWavBytes(),
        mimeType: "audio/wav",
        fileName: "provider-test.wav",
      };
    case "document":
      return {
        kind: "document",
        prompt: "Extract the text from this provider test PDF. Return plain text only.",
        rawBody: createProviderTestPdfBytes(),
        mimeType: "application/pdf",
        fileName: "provider-test.pdf",
      };
    default:
      throw new Error(`Unhandled provider test capability: ${capability}`);
  }
}

async function extractPdfText(rawBody: Uint8Array): Promise<string> {
  const module = await import("pdf-parse");
  const pdfParse = ("default" in module ? module.default : module) as (
    input: Buffer,
  ) => Promise<{ text?: string }>;
  const result = await pdfParse(Buffer.from(rawBody));
  return result.text?.trim() ?? "";
}

async function extractDocxTextViaPython(tempPath: string): Promise<string> {
  const script = [
    "import sys, zipfile, xml.etree.ElementTree as ET",
    "ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}",
    "path = sys.argv[1]",
    "with zipfile.ZipFile(path) as zf:",
    "    xml = zf.read('word/document.xml')",
    "root = ET.fromstring(xml)",
    "paragraphs = []",
    "for p in root.findall('.//w:p', ns):",
    "    parts = []",
    "    for t in p.findall('.//w:t', ns):",
    "        if t.text:",
    "            parts.append(t.text)",
    "    text = ''.join(parts).strip()",
    "    if text:",
    "        paragraphs.append(text)",
    "print('\\n'.join(paragraphs))",
  ].join("\n");
  const { stdout } = await execFile("python3", ["-c", script, tempPath], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function extractDocxText(args: {
  rawBody: Uint8Array;
  dataDir: string;
  title: string;
}): Promise<string> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({
      buffer: Buffer.from(args.rawBody),
    });
    const text = result.value.trim();
    if (text) {
      return text;
    }
  } catch (error) {
    logger.debug({ error }, "Mammoth DOCX extraction fell back to textutil");
  }

  const tempRoot = path.join(args.dataDir, "temp-docs");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(path.join(tempRoot, "docx-"));
  const tempPath = path.join(tempDir, `${safePathSegment(args.title || "document")}.docx`);

  try {
    await writeFile(tempPath, args.rawBody);
    if (process.platform === "darwin") {
      const { stdout } = await execFile("/usr/bin/textutil", [
        "-convert",
        "txt",
        "-stdout",
        tempPath,
      ], {
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout.trim();
    }

    return await extractDocxTextViaPython(tempPath);
  } catch (error) {
    logger.warn({ error }, "DOCX extraction failed");
    return "";
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function buildCloudflareHealth(state: RuntimeState) {
  if (!state.cloudflare) {
    return {
      d1: { ok: false, detail: "bootstrap" },
      r2: { ok: false, detail: "bootstrap" },
      vectorize: { ok: false, detail: "bootstrap" },
      aiSearch: { ok: false, detail: "bootstrap" },
    };
  }

  const { client, credentials, databaseId } = state.cloudflare;
  const safe = async <T>(fn: () => Promise<T>, label: string) => {
    try {
      await fn();
      return { ok: true, detail: label };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : label,
      };
    }
  };

  return {
    d1: await safe(() => client.queryD1(databaseId, "SELECT 1"), "connected"),
    r2: credentials.r2BucketName
      ? await safe(
          () =>
            client.listR2Objects({
              bucketName: credentials.r2BucketName!,
              prefix: `workspace/main/`,
            }),
          "connected",
        )
      : { ok: false, detail: "not-configured" },
    vectorize: credentials.vectorizeIndexName
      ? await safe(
          () =>
            client.queryVectors({
              indexName: credentials.vectorizeIndexName!,
              vector: new Array(credentials.vectorizeDimensions ?? 256).fill(0),
              topK: 1,
            }),
          "connected",
        )
      : { ok: false, detail: "not-configured" },
    aiSearch: credentials.aiSearchIndexName
      ? await safe(
          () =>
            client.searchAiSearch({
              indexName: credentials.aiSearchIndexName!,
              query: "healthcheck",
              maxResults: 1,
            }),
          credentials.aiSearchIndexName,
        )
      : { ok: false, detail: "not-configured" },
  };
}

async function requireSession(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    await reply.code(401).send({ error: "Unauthorized" });
  }
}

export async function createApp(
  options: CreateAppOptions = {},
): Promise<ReturnType<typeof Fastify>> {
  const env = options.env ?? loadEnv();
  const allowedCorsOrigins = (env.CORS_ORIGIN ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const mcpSupervisor = options.mcpSupervisor ?? createMcpSupervisor({
    logDir: path.resolve(env.DATA_DIR, "mcp-logs"),
  });
  const state = new RuntimeState(env, {
    ...options,
    env,
    mcpSupervisor,
  });
  await state.initialize();

  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: env.BODY_LIMIT_BYTES,
  });
  const activeTurns = new Set<string>();
  const jwtSecret = getJwtSecret(state.env.PULSARBOT_ACCESS_TOKEN);

  await app.register(sensible);
  await app.register(cors, {
    origin: allowedCorsOrigins.length === 0
      ? true
      : (origin, callback) => {
          if (!origin || allowedCorsOrigins.includes(origin)) {
            callback(null, true);
            return;
          }
          callback(null, false);
        },
    credentials: true,
  });
  await app.register(cookie);
  await app.register(jwt, {
    secret: jwtSecret,
    cookie: {
      cookieName: "pulsarbot_session",
      signed: false,
    },
  });

  app.decorateRequest("authUser", null);

  const adminDist = path.resolve(repoRootDir, "apps/admin/dist");
  try {
    await access(adminDist);
    await app.register(fastifyStatic, {
      root: adminDist,
      prefix: "/miniapp/",
      index: ["index.html"],
    });
    app.get("/miniapp", async (_request, reply) => {
      await reply.redirect("/miniapp/");
    });
  } catch {
    logger.warn(
      { adminDist },
      "Admin miniapp dist not found. Build @pulsarbot/admin before starting the server.",
    );
  }

  const requireSessionGuard = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    await requireSession(request, reply);
    if (reply.sent) {
      return;
    }

    const user = request.user as { jti?: string; sub?: string } | undefined;
    if (!user?.jti || !user.sub) {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    const session = await state.repository.getAuthSessionByJti(user.jti);
    if (
      !session ||
      session.revokedAt ||
      session.telegramUserId !== user.sub ||
      Date.parse(session.expiresAt) <= Date.now()
    ) {
      reply.clearCookie("pulsarbot_session", { path: "/" });
      await reply.code(401).send({ error: "Unauthorized" });
    }
  };

  const requireOwner = async (request: FastifyRequest, reply: FastifyReply) => {
    await requireSessionGuard(request, reply);
    if (reply.sent) {
      return;
    }
    const user = request.user as { sub?: string };
    const workspace = await state.repository.getWorkspace();
    if (workspace?.ownerTelegramUserId && workspace.ownerTelegramUserId !== user.sub) {
      await reply.code(403).send({ error: "Owner only" });
    }
  };

  const issueSession = async (
    reply: FastifyReply,
    args: { userId: string; username?: string },
  ) => {
    const workspace = await state.repository.getWorkspace();
    const jti = createId("jwt");
    const userId = args.userId || "dev-owner";
    const token = await reply.jwtSign(
      {
        sub: userId,
        username: args.username,
        role: "owner",
        jti,
      },
      {
        expiresIn: "12h",
      },
    );

    reply.setCookie("pulsarbot_session", token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: state.env.NODE_ENV === "production",
    });

    await state.repository.saveAuthSession({
      workspaceId: workspace?.id ?? "bootstrap",
      telegramUserId: userId,
      jwtJti: jti,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString(),
    });
  };

  const audit = async (
    actorTelegramUserId: string,
    eventType: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown> = {},
  ) => {
    const workspace = await state.repository.getWorkspace();
    await state.repository.saveAuditEvent({
      id: createId("audit"),
      workspaceId: workspace?.id ?? "bootstrap",
      actorTelegramUserId,
      eventType,
      targetType,
      targetId,
      detail: toLooseJsonRecord(detail),
      createdAt: nowIso(),
    });
  };

  const buildRuntimePreview = async (profile: AgentProfile) => {
    const workspace = await state.repository.getWorkspace();
    requireWorkspace(workspace);
    const runtime = await state.resolveRuntime(profile);
    const tools = await state.agent.previewTools({
      profile,
      context: {
        workspaceId: workspace.id,
        conversationId: "preview",
        nowIso: nowIso(),
        timezone: workspace.timezone,
        profileId: profile.id,
        searchSettings: runtime.searchSettings,
        runtime,
      },
    });
    return {
      ...runtime,
      tools,
      generatedAt: nowIso(),
    };
  };

  const validateAgentProfileReferences = async (profile: AgentProfile) => {
    const preview = await buildRuntimePreview(profile);
    const blocking = preview.blocked.filter((item) =>
      item.scope === "skill" || item.scope === "plugin" || item.scope === "mcp"
    );
    if (blocking.length > 0) {
      throw app.httpErrors.badRequest(
        JSON.stringify({
          error: "Invalid runtime references",
          blocked: blocking,
        }),
      );
    }
    return preview;
  };

  const acquireConversationTurn = async (args: {
    workspaceId: string;
    conversationId: string;
    profileId: string;
    telegramChatId: string;
    telegramUserId: string;
  }) => {
    const existingConversation = await state.repository.getConversation(args.conversationId);
    if (
      existingConversation?.activeTurnLock &&
      isIsoInFuture(existingConversation.activeTurnLockExpiresAt)
    ) {
      return {
        acquired: false as const,
        conversation: existingConversation,
        turnId: existingConversation.lastTurnId,
      };
    }

    const timestamp = nowIso();
    const turnId = createId("turn");
    const lockExpiresAt = isoAfter(90_000);

    await state.repository.saveConversation({
      id: args.conversationId,
      workspaceId: args.workspaceId,
      telegramChatId: args.telegramChatId,
      telegramUserId: args.telegramUserId,
      mode: "private",
      activeTurnLock: true,
      activeTurnLockExpiresAt: lockExpiresAt,
      lastTurnId: turnId,
      lastCompactedAt: existingConversation?.lastCompactedAt ?? null,
      lastSummaryId: existingConversation?.lastSummaryId ?? null,
      createdAt: existingConversation?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await state.repository.saveConversationTurn({
      id: turnId,
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      profileId: args.profileId,
      status: "running",
      stepCount: 0,
      toolCallCount: 0,
      compacted: false,
      summaryId: null,
      error: null,
      startedAt: timestamp,
      finishedAt: null,
      lockExpiresAt,
      updatedAt: timestamp,
    });
    return {
      acquired: true as const,
      conversation: await state.repository.getConversation(args.conversationId),
      turnId,
    };
  };

  const finalizeConversationTurn = async (args: {
    conversationId: string;
    turnId: string;
    telegramChatId: string;
    telegramUserId: string;
    stepCount: number;
    compacted: boolean;
    toolCallCount: number;
    error?: string | null;
  }) => {
    const conversation = await state.repository.getConversation(args.conversationId);
    const turn = await state.repository.getConversationTurn(args.turnId);
    const latestSummary = (await state.repository.listConversationSummaries(args.conversationId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
    const timestamp = nowIso();

    if (conversation) {
      await state.repository.saveConversation({
        ...conversation,
        telegramChatId: args.telegramChatId,
        telegramUserId: args.telegramUserId,
        activeTurnLock: false,
        activeTurnLockExpiresAt: null,
        lastTurnId: args.turnId,
        lastCompactedAt: args.compacted ? timestamp : conversation.lastCompactedAt,
        lastSummaryId: latestSummary?.id ?? conversation.lastSummaryId,
        updatedAt: timestamp,
      });
    }

    if (turn) {
      await state.repository.saveConversationTurn({
        ...turn,
        status: args.error ? "failed" : "completed",
        stepCount: args.stepCount,
        toolCallCount: args.toolCallCount,
        compacted: args.compacted,
        summaryId: latestSummary?.id ?? turn.summaryId,
        error: args.error ?? null,
        finishedAt: timestamp,
        lockExpiresAt: null,
        updatedAt: timestamp,
      });
    }
  };

  const resolveMediaProvider = async (
    profile: AgentProfile,
    capability: "vision" | "audio" | "document",
    options?: {
      fileName?: string | undefined;
      mimeType?: string | null | undefined;
    },
  ): Promise<{ profile: ProviderProfile; apiKey: string } | null> => {
    const candidateIds = [
      profile.backgroundModelProfileId,
      profile.primaryModelProfileId,
    ].filter((value): value is string => Boolean(value));

    for (const candidateId of candidateIds) {
      try {
        const provider = await state.resolveProviderProfile(candidateId);
        if (!provider.enabled) {
          continue;
        }
        if (capability === "vision" && !provider.visionEnabled) {
          continue;
        }
        if (capability === "audio" && !provider.audioInputEnabled) {
          continue;
        }
        if (capability === "document" && !provider.documentInputEnabled) {
          continue;
        }
        if (
          !supportsProviderCapability(provider, capability, {
            fileName: options?.fileName,
            mimeType: options?.mimeType,
          })
        ) {
          continue;
        }
        return {
          profile: provider,
          apiKey: await state.resolveApiKey(provider.apiKeyRef),
        };
      } catch {
        continue;
      }
    }

    return null;
  };

  const extractDocumentBodyText = async (args: {
    title: string;
    content: TelegramInboundContent;
    rawBody: Uint8Array | null;
    kind: DocumentMetadata["kind"];
    profile: AgentProfile;
  }): Promise<string | null> => {
    if (!args.rawBody) {
      return null;
    }

    const fileName = `${safePathSegment(args.title)}.${fileExtensionForContent(args.content)}`;

    if (args.kind === "text" || args.kind === "json" || args.kind === "csv") {
      return decodeBestEffortText(args.rawBody).trim() || null;
    }

    if (args.content.kind === "image") {
      const mediaProvider = await resolveMediaProvider(args.profile, "vision");
      if (!mediaProvider) {
        return null;
      }
      try {
        const result = await state.runProviderMedia({
          profile: mediaProvider.profile,
          apiKey: mediaProvider.apiKey,
          input: {
            kind: "image",
            rawBody: args.rawBody,
            mimeType: args.content.mimeType ?? "image/jpeg",
            fileName,
            prompt: [
              "You are extracting useful content from a Telegram image for an agent runtime.",
              "First transcribe any visible text accurately.",
              "Then add a concise scene description.",
              "Return plain text only.",
              args.content.caption ? `User caption: ${args.content.caption}` : "",
            ].filter(Boolean).join("\n"),
          },
        });
        return result?.text.trim() || null;
      } catch (error) {
        logger.warn(
          {
            error,
            providerKind: mediaProvider.profile.kind,
          },
          "Image extraction failed",
        );
        return null;
      }
    }

    if (args.content.kind === "voice" || args.content.kind === "audio") {
      const mediaProvider = await resolveMediaProvider(args.profile, "audio");
      if (!mediaProvider) {
        return null;
      }
      try {
        const result = await state.runProviderMedia({
          profile: mediaProvider.profile,
          apiKey: mediaProvider.apiKey,
          input: {
            kind: "audio",
            rawBody: args.rawBody,
            mimeType: args.content.mimeType ?? "audio/ogg",
            fileName,
            prompt: [
              "Transcribe the speech from this Telegram audio message.",
              "Return plain text only.",
            ].join("\n"),
          },
        });
        return result?.text.trim() || null;
      } catch (error) {
        logger.warn(
          {
            error,
            providerKind: mediaProvider.profile.kind,
          },
          "Audio transcription failed",
        );
        return null;
      }
    }

    const documentProvider = await resolveMediaProvider(args.profile, "document", {
      fileName,
      mimeType: args.content.mimeType ?? null,
    });

    if (documentProvider) {
      try {
        const result = await state.runProviderMedia({
          profile: documentProvider.profile,
          apiKey: documentProvider.apiKey,
          input: {
            kind: "document",
            rawBody: args.rawBody,
            mimeType: args.content.mimeType ?? "application/octet-stream",
            fileName,
            prompt: [
              "Extract the document text in reading order for an agent runtime.",
              "Preserve headings, lists, and tables as plain text when possible.",
              "Return plain text only.",
            ].join("\n"),
          },
        });
        if (result?.text.trim()) {
          return result.text.trim();
        }
      } catch (error) {
        logger.warn(
          {
            error,
            providerKind: documentProvider.profile.kind,
            mimeType: args.content.mimeType,
          },
          "Document extraction via provider failed",
        );
      }
    }

    if (args.kind === "pdf") {
      return (await extractPdfText(args.rawBody)).trim() || null;
    }

    if (args.kind === "docx") {
      return (await extractDocxText({
        rawBody: args.rawBody,
        dataDir: state.dataDir,
        title: args.title,
      })).trim() || null;
    }

    return null;
  };

  const registerDocument = async (
    workspaceId: string,
    payload: TelegramUpdatePayload,
    profile: AgentProfile,
    fallbackText: string,
  ) => {
    if (payload.content.kind === "text") {
      return {
        document: null,
        normalizedText: payload.content.text ?? "",
      };
    }
    const metadata = payload.content.metadata ?? {};
    const documentId = createId("doc");
    const title = String(
      metadata.fileName ?? payload.content.caption ?? payload.content.kind,
    );
    const kind = inferDocumentKind(payload.content);
    const sourcePath = `documents/${documentId}/source/${safePathSegment(title)}.${fileExtensionForContent(payload.content)}`;
    const derivedTextPath = `documents/${documentId}/derived/content.md`;

    let rawBody: Uint8Array | null = null;
    let downloadError: string | null = null;
    const fileUrl = typeof metadata.fileUrl === "string" ? metadata.fileUrl : null;
    if (fileUrl) {
      try {
        const response = await fetch(fileUrl);
        if (response.ok) {
          rawBody = new Uint8Array(await response.arrayBuffer());
        } else {
          downloadError = `File download failed with status ${response.status}`;
        }
      } catch (error) {
        downloadError = error instanceof Error ? error.message : "File download failed";
        logger.warn({ error, fileUrl }, "Failed to download Telegram file");
      }
    }

    const sourceObjectKey = rawBody && state.cloudflare?.credentials.r2BucketName
      ? `workspace/${workspaceId}/${sourcePath}`
      : null;

    if (rawBody && state.cloudflare?.credentials.r2BucketName) {
      await state.cloudflare.client.putR2Object({
        bucketName: state.cloudflare.credentials.r2BucketName,
        key: sourceObjectKey!,
        body: rawBody,
        ...(payload.content.mimeType ? { contentType: payload.content.mimeType } : {}),
      });
    }

    let extractedText: string | null = null;
    try {
      extractedText = await extractDocumentBodyText({
        title,
        content: payload.content,
        rawBody,
        kind,
        profile,
      });
    } catch (error) {
      logger.warn({ error, documentId, kind }, "Failed to extract document body text");
    }

    const derivedText = (extractedText?.trim() || deriveDocumentText({
      content: payload.content,
      kind,
      normalizedText: fallbackText,
      rawBody,
    })).slice(0, 30_000);
    const queuedRetryKind =
      rawBody && !extractedText?.trim()
        ? payload.content.kind === "image"
          ? "telegram_image_describe"
          : payload.content.kind === "voice" || payload.content.kind === "audio"
            ? "telegram_voice_transcribe"
            : payload.content.kind === "document"
              ? "telegram_file_fetch"
              : null
        : null;
    const extractionStatus: DocumentMetadata["extractionStatus"] = extractedText?.trim()
      ? "completed"
      : queuedRetryKind
        ? "pending"
        : rawBody
          ? "failed"
          : "pending";

    const document = {
      id: documentId,
      workspaceId,
      sourceType: "telegram" as const,
      kind,
      title,
      path: sourcePath,
      derivedTextPath,
      sourceObjectKey,
      derivedTextObjectKey: `workspace/${workspaceId}/${derivedTextPath}`,
      previewText: derivedText.slice(0, 500),
      fileId: payload.content.fileId ?? null,
      sizeBytes: typeof metadata.fileSize === "number"
        ? metadata.fileSize
        : rawBody?.byteLength ?? null,
      mimeType: payload.content.mimeType ?? null,
      extractionStatus,
      extractionProviderProfileId: null,
      lastExtractionError:
        extractedText?.trim()
          ? null
          : downloadError ?? (queuedRetryKind
            ? "Extraction queued for retry"
            : rawBody
              ? "Extraction returned no content"
              : "Source file unavailable"),
      lastIndexedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await state.repository.saveDocument(document);

    if (queuedRetryKind) {
      await state.queueJob({
        workspaceId,
        kind: queuedRetryKind,
        payload: { documentId },
      });
    }

    try {
      const memory = await state.createMemoryStore(workspaceId);
      await memory.ingestDocument({
        documentId,
        title,
        path: derivedTextPath,
        content: derivedText || fallbackText,
      });
      await state.repository.saveDocument({
        ...document,
        extractionStatus: extractedText?.trim()
          ? "completed"
          : document.extractionStatus,
        lastIndexedAt: nowIso(),
        updatedAt: nowIso(),
      });
    } catch (error) {
      logger.warn({ error, documentId }, "Failed to ingest document into memory store");
    }

    return {
      document,
      normalizedText: derivedText || fallbackText,
    };
  };

  const buildInboundContentForStoredDocument = (
    document: DocumentMetadata,
    rawBody: Uint8Array,
  ): TelegramInboundContent => {
    const mimeType = document.mimeType ?? undefined;
    const metadata = {
      fileName: document.title,
      fileSize: rawBody.byteLength,
    };
    if (mimeType?.startsWith("image/")) {
      return {
        kind: "image",
        mimeType,
        metadata,
      };
    }
    if (mimeType?.startsWith("audio/")) {
      return {
        kind: "audio",
        mimeType,
        metadata,
      };
    }
    return {
      kind: "document",
      mimeType,
      metadata,
    };
  };

  const reExtractDocument = async (documentId: string) => {
    const workspace = await state.repository.getWorkspace();
    requireWorkspace(workspace);
    const document = (await state.repository.listDocuments()).find(
      (item) => item.id === documentId,
    );
    if (!document) {
      throw new Error("Document not found");
    }
    const sourceObjectKey = document.sourceObjectKey ??
      `workspace/${workspace.id}/${document.path}`;
    const raw = await state.requireCloudflare().client.getR2ObjectRaw({
      bucketName: state.requireCloudflare().credentials.r2BucketName!,
      key: sourceObjectKey,
    });
    if (!raw) {
      throw new Error("Document source object is unavailable in R2");
    }

    const profiles = await state.repository.listAgentProfiles();
    const profile =
      profiles.find((item) => item.id === workspace.activeAgentProfileId) ??
      profiles[0];
    if (!profile) {
      throw new Error("No agent profile is configured");
    }

    await state.repository.saveDocument({
      ...document,
      extractionStatus: "processing",
      lastExtractionError: null,
      updatedAt: nowIso(),
    });

    const content = buildInboundContentForStoredDocument(document, raw.body);
    const extractedText = await extractDocumentBodyText({
      title: document.title,
      content,
      rawBody: raw.body,
      kind: document.kind,
      profile,
    });
    const derivedText = (extractedText?.trim() || deriveDocumentText({
      content,
      kind: document.kind,
      normalizedText: document.previewText ?? document.title,
      rawBody: raw.body,
    })).slice(0, 30_000);

    const memory = await state.createMemoryStore(workspace.id);
    await memory.ingestDocument({
      documentId: document.id,
      title: document.title,
      path: document.derivedTextPath ?? `documents/${document.id}/derived/content.md`,
      content: derivedText,
    });
    await state.repository.saveDocument({
      ...document,
      previewText: derivedText.slice(0, 500),
      extractionStatus: extractedText?.trim() ? "completed" : "failed",
      derivedTextObjectKey:
        document.derivedTextObjectKey ??
        `workspace/${workspace.id}/${document.derivedTextPath ?? `documents/${document.id}/derived/content.md`}`,
      lastExtractionError: extractedText?.trim() ? null : "Extraction returned no content",
      lastIndexedAt: nowIso(),
      updatedAt: nowIso(),
    });
  };

  const retryDelayMs = (attempts: number) => {
    if (attempts <= 1) {
      return 30_000;
    }
    if (attempts === 2) {
      return 120_000;
    }
    return 600_000;
  };

  const processBackgroundJobs = async (limit = 10) => {
    const workspace = await state.repository.getWorkspace();
    if (!workspace) {
      return 0;
    }

    try {
      const memory = await state.createMemoryStore(workspace.id);
      await memory.processPendingJobs(limit);
    } catch (error) {
      logger.debug({ error }, "Skipping memory worker tick");
    }

    const pending = (await state.repository.listJobs({ status: "pending" }))
      .filter((job) =>
        job.workspaceId === workspace.id &&
        (!job.runAfter || Date.parse(job.runAfter) <= Date.now()) &&
        !job.lockedAt,
      )
      .filter((job) =>
        ![
          "memory_reindex_document",
          "memory_reindex_all",
          "memory_refresh_before_compact",
        ].includes(job.kind),
      )
      .slice(0, limit);

    for (const job of pending) {
      const startedAt = nowIso();
      await state.repository.saveJob({
        ...job,
        status: "running",
        attempts: job.attempts + 1,
        lockedAt: startedAt,
        lockedBy: `server:${process.pid}`,
        updatedAt: startedAt,
      });

      try {
        if (
          job.kind === "document_extract" ||
          job.kind === "telegram_file_fetch" ||
          job.kind === "telegram_voice_transcribe" ||
          job.kind === "telegram_image_describe"
        ) {
          await reExtractDocument(String(job.payload.documentId ?? ""));
        }

        if (job.kind === "mcp_healthcheck") {
          const serverId = String(job.payload.serverId ?? "");
          const server = (await state.repository.listMcpServers()).find(
            (item) => item.id === serverId,
          );
          if (!server) {
            throw new Error("MCP server not found");
          }
          const result = await mcpSupervisor.healthcheck(
            await state.resolveMcpServerConfig(server),
          );
          await state.repository.saveMcpServer({
            ...server,
            lastHealthStatus: result.status === "ok" ? "ok" : "error",
            lastHealthCheckedAt: result.checkedAt,
            updatedAt: nowIso(),
          });
        }

        await state.repository.saveJob({
          ...job,
          status: "completed",
          attempts: job.attempts + 1,
          result: {
            processedAt: nowIso(),
          },
          error: undefined,
          lockedAt: null,
          lockedBy: null,
          completedAt: nowIso(),
          updatedAt: nowIso(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown job error";
        const attempts = job.attempts + 1;
        if (attempts < 3) {
          await state.repository.saveJob({
            ...job,
            status: "pending",
            attempts,
            error: message,
            lockedAt: null,
            lockedBy: null,
            runAfter: isoAfter(retryDelayMs(attempts)),
            updatedAt: nowIso(),
          });
        } else {
          await state.repository.saveJob({
            ...job,
            status: "failed",
            attempts,
            error: message,
            lockedAt: null,
            lockedBy: null,
            completedAt: null,
            updatedAt: nowIso(),
          });
        }
      }
    }

    return pending.length;
  };

	  const telegram = (options.telegramFactory ?? createTelegramBot)({
	    token: state.env.TELEGRAM_BOT_TOKEN,
	    onMessage: async (rawPayload, stream) => {
	      const streamController = stream ?? {
	        enabled: false,
	        emit: async () => {},
	      };
	      const payload = normalizeTelegramPayload(rawPayload);
      const workspace = await state.repository.getWorkspace();
      requireWorkspace(workspace);

      if (
        workspace.ownerTelegramUserId &&
        workspace.ownerTelegramUserId !== String(payload.userId)
      ) {
        return "This Pulsarbot instance only responds to the configured owner.";
      }

      const conversationId = payload.threadId === null
        ? `telegram:${payload.chatId}`
        : `telegram:${payload.chatId}:thread:${payload.threadId}`;
      if (activeTurns.has(conversationId)) {
        return "A previous agent turn is still running for this chat. Please try again in a moment.";
      }
      const profiles = await state.repository.listAgentProfiles();
      const profile =
        profiles.find((item) => item.id === workspace.activeAgentProfileId) ??
        profiles.find((item) => item.label === "balanced") ??
        profiles[0];
      if (!profile) {
        return "No agent profile is configured yet. Open the Mini App first.";
      }

      const acquired = await acquireConversationTurn({
        workspaceId: workspace.id,
        conversationId,
        profileId: profile.id,
        telegramChatId: String(payload.chatId),
        telegramUserId: String(payload.userId),
      });
      if (!acquired.acquired) {
        return "A previous agent turn is still running for this chat. Please try again in a moment.";
      }

      activeTurns.add(conversationId);

      try {
        const history = await state.repository.listConversationMessages(conversationId);
        const fallbackText = normalizeInboundText(payload.content);
        const processedPayload = await registerDocument(
          workspace.id,
          payload,
          profile,
          fallbackText,
        );
        const normalizedText = processedPayload.normalizedText;
        const document = processedPayload.document;
        const runtime = await state.resolveRuntime(profile);
        await state.repository.appendConversationMessage(conversationId, {
          id: createId("msg"),
          conversationId,
          role: "user",
          content: normalizedText,
          sourceType: sourceTypeForContent(payload.content),
          telegramMessageId: payload.messageId ? String(payload.messageId) : null,
          metadata: {
            ...payload.content.metadata,
            threadId: payload.threadId,
            ...(document ? { documentId: document.id } : {}),
          },
          createdAt: nowIso(),
        });

        const result = await state.agent.runTurn({
          profile,
          userMessage: normalizedText,
          history,
	          ...(streamController.enabled
	            ? {
	                streamReply: {
	                  onPartial: (text: string) => streamController.emit(text),
	                },
	              }
	            : {}),
          context: {
            workspaceId: workspace.id,
            conversationId,
            turnId: acquired.turnId ?? undefined,
            nowIso: nowIso(),
            timezone: workspace.timezone,
            profileId: profile.id,
            searchSettings: runtime.searchSettings,
            runtime,
          },
        });

        await state.repository.appendConversationMessage(conversationId, {
          id: createId("msg"),
          conversationId,
          role: "assistant",
          content: result.reply,
          sourceType: "text",
          telegramMessageId: null,
          metadata: {
            turnId: result.turnId,
            compacted: result.compacted,
            ...(result.summary ? { summary: result.summary } : {}),
          },
          createdAt: nowIso(),
        });
        for (const toolRun of result.toolRuns) {
          await state.repository.saveToolRun({
            id: toolRun.id,
            conversationId,
            turnId: result.turnId,
            toolId: toolRun.toolId,
            toolSource: toolRun.source,
            input: toLooseJsonRecord(toolRun.input),
            output: toolRun.output as never,
            status: "completed",
            durationMs: 0,
            createdAt: nowIso(),
          });
        }
        await finalizeConversationTurn({
          conversationId,
          turnId: result.turnId,
          telegramChatId: String(payload.chatId),
          telegramUserId: String(payload.userId),
          stepCount: result.stepCount,
          compacted: result.compacted,
          toolCallCount: result.toolRuns.length,
        });
        return result.reply;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown agent error";
        if (isMissingSecretError(error)) {
          logger.warn({ error, conversationId }, "Provider API key is not configured");
          await finalizeConversationTurn({
            conversationId,
            turnId: acquired.turnId!,
            telegramChatId: String(payload.chatId),
            telegramUserId: String(payload.userId),
            stepCount: 0,
            compacted: false,
            toolCallCount: 0,
            error: message,
          });
          return "Provider API key is not configured. Open Mini App > Providers and save a valid API key.";
        }
        logger.error({ error, conversationId }, "Telegram turn failed");
        await finalizeConversationTurn({
          conversationId,
          turnId: acquired.turnId!,
          telegramChatId: String(payload.chatId),
          telegramUserId: String(payload.userId),
          stepCount: 0,
          compacted: false,
          toolCallCount: 0,
          error: message,
        });
        return "The agent turn failed. Open the Mini App health page for details.";
      } finally {
        activeTurns.delete(conversationId);
      }
    },
  });

  let webhookInfoCache:
    | {
        fetchedAt: number;
        info: TelegramWebhookInfo | null;
        error: string | null;
      }
    | null = null;
  const webhookDiagnosticsEnabled = Boolean(
    state.env.TELEGRAM_WEBHOOK_URL ||
      state.env.PUBLIC_BASE_URL ||
      state.env.RAILWAY_PUBLIC_DOMAIN ||
      state.env.RAILWAY_STATIC_URL,
  );
  const readTelegramWebhookInfo = async (force = false) => {
    const now = Date.now();
    if (!force && webhookInfoCache && now - webhookInfoCache.fetchedAt < 30_000) {
      return webhookInfoCache;
    }
    if (!force && !webhookDiagnosticsEnabled) {
      return {
        fetchedAt: now,
        info: null,
        error: null,
      };
    }

    try {
      const info = await getTelegramWebhookInfo(state.env.TELEGRAM_BOT_TOKEN);
      webhookInfoCache = {
        fetchedAt: now,
        info,
        error: null,
      };
      return webhookInfoCache;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      webhookInfoCache = {
        fetchedAt: now,
        info: null,
        error: message,
      };
      return webhookInfoCache;
    }
  };

  const startupWebhookUrl = resolveExpectedTelegramWebhookUrl(state.env);
  if (startupWebhookUrl) {
    void setTelegramWebhook(state.env.TELEGRAM_BOT_TOKEN, startupWebhookUrl).then(
      async () => {
        await readTelegramWebhookInfo(true);
        logger.info({ webhookUrl: startupWebhookUrl }, "Telegram webhook synced on startup");
      },
      (error) => {
        logger.warn(
          {
            webhookUrl: startupWebhookUrl,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to sync Telegram webhook on startup",
        );
      },
    );
  }

  const backgroundWorker = setInterval(() => {
    void processBackgroundJobs(10).catch((error) => {
      logger.error({ error }, "Background job tick failed");
    });
  }, options.backgroundPollMs ?? 5_000);

  app.addHook("onClose", async () => {
    clearInterval(backgroundWorker);
    await mcpSupervisor.closeAll();
  });

  app.get("/healthz", async () => ({
    ok: true,
    mode: state.cloudflare ? "d1" : "bootstrap",
    time: nowIso(),
  }));

  app.get("/favicon.ico", async (_request, reply) =>
    reply.code(204).type("image/x-icon").send(),
  );

  app.get("/", async (_request, reply) => {
    return reply.type("text/html").send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Pulsarbot</title>
          <style>
            body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f5f0e5; padding: 48px; color: #0f172a; }
            a { color: #0f172a; }
          </style>
        </head>
        <body>
          <h1>Pulsarbot</h1>
          <p>The server is online. Open <a href="/miniapp/">/miniapp/</a> inside Telegram or a browser during development.</p>
        </body>
      </html>
    `);
  });

  app.post("/api/session/telegram", async (request, reply) => {
    const body = request.body as { initData?: string; userId?: string; username?: string };
    let user = {
      userId: body?.userId ?? "",
      username: body?.username,
    };

    if (body?.initData) {
      user = parseTelegramInitData(body.initData, state.env.TELEGRAM_BOT_TOKEN);
    } else if (!["development", "test"].includes(state.env.NODE_ENV)) {
      return reply.code(400).send({ error: "initData is required outside development" });
    }

    const workspace = await state.repository.getWorkspace();
    if (
      workspace?.ownerTelegramUserId &&
      workspace.ownerTelegramUserId !== user.userId
    ) {
      return reply.code(403).send({ error: "Only the configured owner can access this Mini App" });
    }

    const bootstrapState = await state.repository.getBootstrapState();
    const sessionUser = {
      userId: user.userId || "dev-owner",
      ...(user.username ? { username: user.username } : {}),
    };
    await issueSession(reply, sessionUser);

    return {
      user: sessionUser,
      bootstrapState,
      workspace,
      adminIdentity: await state.repository.getAdminIdentity(),
    };
  });

  app.post("/api/bootstrap/verify-access-token", async (request, reply) => {
    const body = request.body as { accessToken?: string };
    if (body.accessToken !== state.env.PULSARBOT_ACCESS_TOKEN) {
      return reply.code(401).send({ error: "Invalid access token" });
    }

    const bootstrapState = await state.repository.getBootstrapState();
    await state.repository.saveBootstrapState({
      ...bootstrapState,
      verified: true,
    });
    return { ok: true };
  });

  app.post("/api/session/logout", { preHandler: requireSessionGuard }, async (request, reply) => {
    const user = request.user as { jti?: string };
    if (user.jti) {
      await state.repository.revokeAuthSession(user.jti);
    }
    reply.clearCookie("pulsarbot_session", { path: "/" });
    return { ok: true };
  });

  app.post(
    "/api/bootstrap/bind-owner",
    { preHandler: requireSessionGuard },
    async (request, reply) => {
      const user = request.user as { sub?: string; username?: string };
      if (!user.sub) {
        return reply.code(400).send({ error: "Missing telegram user" });
      }
      const workspace = await state.repository.getWorkspace();
      if (workspace?.ownerTelegramUserId && workspace.ownerTelegramUserId !== user.sub) {
        return reply.code(403).send({ error: "Owner already bound" });
      }
      const timestamp = nowIso();
      if (workspace) {
        await state.repository.saveWorkspace({
          ...workspace,
          ownerTelegramUserId: user.sub,
          ownerTelegramUsername: user.username ?? null,
          updatedAt: timestamp,
        });
      }
      await state.repository.saveAdminIdentity({
        workspaceId: workspace?.id ?? "main",
        telegramUserId: user.sub,
        telegramUsername: user.username ?? null,
        role: "owner",
        boundAt: timestamp,
        lastVerifiedAt: timestamp,
      });
      const bootstrapState = await state.repository.getBootstrapState();
      await state.repository.saveBootstrapState({
        ...bootstrapState,
        ownerBound: true,
      });
      await audit(user.sub, "bind_owner", "workspace", workspace?.id ?? "bootstrap");
      return { ok: true };
    },
  );

  app.post(
    "/api/bootstrap/cloudflare/connect",
    { preHandler: requireSessionGuard },
    async (request) => {
      const body = request.body as CloudflareCredentials & { accessToken?: string };
      if (body.accessToken !== state.env.PULSARBOT_ACCESS_TOKEN) {
        throw app.httpErrors.unauthorized("Invalid access token");
      }
      const credentials = CloudflareCredentialsSchema.parse(body);
      const client = state.makeCloudflareClient(credentials);
      const verified = await client.verifyCredentials();
      if (!verified) {
        throw new Error("Cloudflare token verification failed");
      }
      await state.setPendingCloudflare(credentials);
      const bootstrapState = await state.repository.getBootstrapState();
      await state.repository.saveBootstrapState({
        ...bootstrapState,
        cloudflareConnected: true,
      });
      return { ok: true };
    },
  );

  app.get(
    "/api/bootstrap/cloudflare/resources",
    { preHandler: requireSessionGuard },
    async () => state.listCloudflareResources(),
  );

  app.post(
    "/api/bootstrap/cloudflare/init-resources",
    { preHandler: requireSessionGuard },
    async (request, reply) => {
      const bootstrapState = await state.repository.getBootstrapState();
      if (!bootstrapState.verified) {
        return reply.code(403).send({ error: "Verify access token first" });
      }
      const body = request.body as {
        label?: string;
        timezone?: string;
        mode?: BootstrapWorkspaceMode;
        selection?: BootstrapWorkspaceSelection;
      };
      if (body.mode === "existing" && !body.selection?.d1DatabaseId) {
        return reply.code(400).send({
          error: "Select an existing D1 database before loading a workspace",
        });
      }
      const user = request.user as {
        sub?: string;
        username?: string | undefined;
      };
      const bootstrapArgs: {
        ownerTelegramUserId: string;
        ownerTelegramUsername?: string;
        label?: string;
        timezone?: string;
        mode?: BootstrapWorkspaceMode;
        selection?: BootstrapWorkspaceSelection;
      } = {
        ownerTelegramUserId: user.sub ?? "dev-owner",
      };
      if (user.username) {
        bootstrapArgs.ownerTelegramUsername = user.username;
      }
      if (body.label) {
        bootstrapArgs.label = body.label;
      }
      if (body.timezone) {
        bootstrapArgs.timezone = body.timezone;
      }
      if (body.mode) {
        bootstrapArgs.mode = body.mode;
      }
      if (body.selection) {
        bootstrapArgs.selection = body.selection;
      }
      await state.bootstrapWorkspace(bootstrapArgs);
      await issueSession(reply, {
        userId: user.sub ?? "dev-owner",
        ...(user.username ? { username: user.username } : {}),
      });
      await audit(user.sub ?? "dev-owner", "bootstrap_workspace", "workspace", "main");
      return {
        ok: true,
        workspace: await state.repository.getWorkspace(),
      };
    },
  );

  app.get("/api/workspace", { preHandler: requireOwner }, async () => {
    return {
      bootstrapState: await state.repository.getBootstrapState(),
      workspace: await state.repository.getWorkspace(),
      searchSettings: await state.repository.getSearchSettings(),
    };
  });

  app.put("/api/workspace", { preHandler: requireOwner }, async (request) => {
    const current = await state.repository.getWorkspace();
    requireWorkspace(current);
    const body = request.body as Partial<{
      label: string;
      timezone: string;
      primaryModelProfileId: string | null;
      backgroundModelProfileId: string | null;
      activeAgentProfileId: string | null;
    }>;
    const next = WorkspaceSchema.parse({
      ...current,
      ...body,
      updatedAt: nowIso(),
    });
    await state.repository.saveWorkspace(next);
    await audit(
      (request.user as { sub?: string }).sub ?? "unknown",
      "update_workspace",
      "workspace",
      next.id,
      body as Record<string, unknown>,
    );
    return next;
  });

  app.get("/api/providers", { preHandler: requireOwner }, async () =>
    state.repository.listProviderProfiles(),
  );

  async function saveProvider(request: FastifyRequest) {
    const currentWorkspace = await state.repository.getWorkspace();
    requireWorkspace(currentWorkspace);
    const body = request.body as Partial<ProviderProfile> & {
      apiKey?: string;
      accessToken?: string;
    };
    const timestamp = nowIso();
    const params = (request.params ?? {}) as { id?: string };
    const existing = params.id
      ? (await state.repository.listProviderProfiles()).find((item) => item.id === params.id)
      : undefined;
    const id = params.id ?? body.id ?? createId("provider");
    const next = ProviderProfileSchema.parse({
      id,
      kind: body.kind ?? "openai",
      label: body.label ?? "Provider",
      apiBaseUrl: body.apiBaseUrl ?? existing?.apiBaseUrl ?? "",
      apiKeyRef: body.apiKeyRef ?? existing?.apiKeyRef ?? `provider:${id}:apiKey`,
      defaultModel: body.defaultModel ?? existing?.defaultModel ?? "gpt-4.1-mini",
      visionModel: body.visionModel ?? existing?.visionModel ?? null,
      audioModel: body.audioModel ?? existing?.audioModel ?? null,
      documentModel: body.documentModel ?? existing?.documentModel ?? null,
      stream: body.stream ?? existing?.stream ?? true,
      reasoningEnabled: body.reasoningEnabled ?? existing?.reasoningEnabled ?? false,
      reasoningLevel: body.reasoningLevel ?? existing?.reasoningLevel ?? "off",
      thinkingBudget: body.thinkingBudget ?? existing?.thinkingBudget ?? null,
      temperature: body.temperature ?? existing?.temperature ?? 0.2,
      topP: body.topP ?? existing?.topP ?? null,
      maxOutputTokens: body.maxOutputTokens ?? existing?.maxOutputTokens ?? 2048,
      toolCallingEnabled:
        body.toolCallingEnabled ?? existing?.toolCallingEnabled ?? true,
      jsonModeEnabled: body.jsonModeEnabled ?? existing?.jsonModeEnabled ?? true,
      visionEnabled: body.visionEnabled ?? existing?.visionEnabled ?? false,
      audioInputEnabled:
        body.audioInputEnabled ?? existing?.audioInputEnabled ?? false,
      documentInputEnabled:
        body.documentInputEnabled ?? existing?.documentInputEnabled ?? false,
      headers: body.headers ?? existing?.headers ?? {},
      extraBody: body.extraBody ?? existing?.extraBody ?? {},
      enabled: body.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await state.repository.saveProviderProfile(next);
    if (body.apiKey) {
      if (body.accessToken !== state.env.PULSARBOT_ACCESS_TOKEN) {
        throw app.httpErrors.unauthorized("Invalid access token");
      }
      const existingSecret = await state.repository.getSecretByScope(
        currentWorkspace.id,
        next.apiKeyRef,
      );
      await state.repository.saveSecret(
        encryptSecret({
          accessToken: state.env.PULSARBOT_ACCESS_TOKEN,
          workspaceId: currentWorkspace.id,
          scope: next.apiKeyRef,
          plainText: body.apiKey,
          ...(existingSecret ? { existingId: existingSecret.id } : {}),
        }),
      );
    }
    await audit(
      (request.user as { sub?: string }).sub ?? "unknown",
      existing ? "update_provider" : "create_provider",
      "provider_profile",
      next.id,
      { kind: next.kind, label: next.label },
    );
    return next;
  }

  app.post("/api/providers", { preHandler: requireOwner }, async (request) =>
    saveProvider(request),
  );
  app.put("/api/providers/:id", { preHandler: requireOwner }, async (request) =>
    saveProvider(request),
  );
  app.delete(
    "/api/providers/:id",
    { preHandler: requireOwner },
    async (request) => {
      const body = (request.body ?? {}) as { accessToken?: string };
      if (body.accessToken !== state.env.PULSARBOT_ACCESS_TOKEN) {
        throw app.httpErrors.unauthorized("Invalid access token");
      }
      const id = (request.params as { id: string }).id;
      await state.repository.deleteProviderProfile(id);
      await audit(
        (request.user as { sub?: string }).sub ?? "unknown",
        "delete_provider",
        "provider_profile",
        id,
      );
      return { ok: true };
    },
  );
  app.post(
    "/api/providers/:id/test",
    { preHandler: requireOwner },
    async (request) => {
      const profile = await state.resolveProviderProfile(
        (request.params as { id: string }).id,
      );
      const body = (request.body ?? {}) as {
        capabilities?: string[];
      };
      const requested = Array.isArray(body.capabilities)
        ? body.capabilities.filter((value): value is ProviderTestCapability => {
            const parsed = ProviderTestCapabilitySchema.safeParse(value);
            return parsed.success &&
              providerTestCapabilities.includes(parsed.data);
          })
        : [];
      const capabilities: ProviderTestCapability[] = requested.length > 0
        ? requested
        : ["text"];

      let apiKey: string | null = null;
      let apiKeyError: string | null = null;
      try {
        apiKey = await state.resolveApiKey(profile.apiKeyRef);
      } catch (error) {
        apiKeyError = error instanceof Error
          ? error.message
          : "Provider API key is missing";
      }

      const results: ProviderTestRunResult[] = apiKey
        ? await Promise.all(
            capabilities.map(async (capability) => {
              if (capability === "text") {
                try {
                  const result = await state.runProvider({
                    profile,
                    apiKey,
                    input: {
                      messages: [
                        {
                          role: "system",
                          content: "Reply with OK.",
                        },
                        {
                          role: "user",
                          content: "Ping",
                        },
                      ],
                    },
                  });
                  return {
                    capability,
                    status: "ok" as const,
                    outputPreview: result.text.slice(0, 200),
                  };
                } catch (error) {
                  return {
                    capability,
                    status: "failed" as const,
                    error: error instanceof Error ? error.message : String(error),
                  };
                }
              }

              if (capability === "vision" && !profile.visionEnabled) {
                return {
                  capability,
                  status: "skipped" as const,
                  reason: "vision-disabled",
                };
              }
              if (capability === "audio" && !profile.audioInputEnabled) {
                return {
                  capability,
                  status: "skipped" as const,
                  reason: "audio-disabled",
                };
              }
              if (capability === "document" && !profile.documentInputEnabled) {
                return {
                  capability,
                  status: "skipped" as const,
                  reason: "document-disabled",
                };
              }

              const mediaCapability = capability as Exclude<ProviderTestCapability, "text">;
              const input = providerMediaTestInput(mediaCapability);
              const supported = supportsProviderCapability(profile, mediaCapability, {
                fileName: input.fileName,
                mimeType: input.mimeType,
              });
              if (!supported) {
                return {
                  capability: capability as ProviderTestCapability,
                  status: "unsupported" as const,
                };
              }

              try {
                const result = await state.runProviderMedia({
                  profile,
                  apiKey,
                  input,
                });
                if (!result) {
                  return {
                    capability: capability as ProviderTestCapability,
                    status: "unsupported" as const,
                  };
                }
                return {
                  capability,
                  status: "ok" as const,
                  outputPreview: result.text.slice(0, 200),
                };
              } catch (error) {
                return {
                  capability,
                  status: "failed" as const,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            }),
          )
        : capabilities.map((capability) => ({
            capability,
            status: "failed" as const,
            error: apiKeyError ?? "Provider API key is missing",
          }));

      const workspace = await state.repository.getWorkspace();
      requireWorkspace(workspace);
      await state.repository.saveProviderTestRun({
        id: createId("providertest"),
        workspaceId: workspace.id,
        providerId: profile.id,
        providerKind: profile.kind,
        requestedCapabilities: capabilities,
        results,
        ok: results.every((item) => item.status === "ok"),
        createdAt: nowIso(),
      });

      return {
        ok: results.every((item) => item.status === "ok"),
        providerId: profile.id,
        providerKind: profile.kind,
        requestedCapabilities: capabilities,
        results,
      };
    },
  );
  app.get(
    "/api/providers/:id/tests",
    { preHandler: requireOwner },
    async (request) =>
      state.repository.listProviderTestRuns({
        providerId: (request.params as { id: string }).id,
        limit: 20,
      }),
  );

  app.get("/api/agent-profiles", { preHandler: requireOwner }, async () =>
    state.repository.listAgentProfiles(),
  );

  async function saveAgentProfileHandler(request: FastifyRequest) {
    const body = request.body as Partial<AgentProfile>;
    const params = (request.params ?? {}) as { id?: string };
    const existing = params.id
      ? (await state.repository.listAgentProfiles()).find((item) => item.id === params.id)
      : undefined;
    const id = params.id ?? body.id ?? createId("agent");
    const timestamp = nowIso();
    const next = AgentProfileSchema.parse({
      id,
      label: body.label ?? existing?.label ?? "profile",
      description: body.description ?? existing?.description ?? "",
      systemPrompt: body.systemPrompt ?? existing?.systemPrompt ?? "You are Pulsarbot.",
      primaryModelProfileId:
        body.primaryModelProfileId ?? existing?.primaryModelProfileId ?? "",
      backgroundModelProfileId:
        body.backgroundModelProfileId ?? existing?.backgroundModelProfileId ?? null,
      embeddingModelProfileId:
        body.embeddingModelProfileId ?? existing?.embeddingModelProfileId ?? null,
      enabledSkillIds: body.enabledSkillIds ?? existing?.enabledSkillIds ?? [],
      enabledPluginIds: body.enabledPluginIds ?? existing?.enabledPluginIds ?? [],
      enabledMcpServerIds:
        body.enabledMcpServerIds ?? existing?.enabledMcpServerIds ?? [],
      maxPlanningSteps: body.maxPlanningSteps ?? existing?.maxPlanningSteps ?? 8,
      maxToolCalls: body.maxToolCalls ?? existing?.maxToolCalls ?? 6,
      maxTurnDurationMs:
        body.maxTurnDurationMs ?? existing?.maxTurnDurationMs ?? 30_000,
      maxToolDurationMs:
        body.maxToolDurationMs ?? existing?.maxToolDurationMs ?? 15_000,
      compactSoftThreshold:
        body.compactSoftThreshold ?? existing?.compactSoftThreshold ?? 0.7,
      compactHardThreshold:
        body.compactHardThreshold ?? existing?.compactHardThreshold ?? 0.85,
      allowNetworkTools:
        body.allowNetworkTools ?? existing?.allowNetworkTools ?? true,
      allowWriteTools: body.allowWriteTools ?? existing?.allowWriteTools ?? true,
      allowMcpTools: body.allowMcpTools ?? existing?.allowMcpTools ?? true,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await validateAgentProfileReferences(next);
    await state.repository.saveAgentProfile(next);
    await audit(
      (request.user as { sub?: string }).sub ?? "unknown",
      existing ? "update_agent_profile" : "create_agent_profile",
      "agent_profile",
      next.id,
      { label: next.label },
    );
    return next;
  }

  app.post(
    "/api/agent-profiles",
    { preHandler: requireOwner },
    async (request) => saveAgentProfileHandler(request),
  );
  app.put(
    "/api/agent-profiles/:id",
    { preHandler: requireOwner },
    async (request) => saveAgentProfileHandler(request),
  );
  app.delete(
    "/api/agent-profiles/:id",
    { preHandler: requireOwner },
    async (request) => {
      const id = (request.params as { id: string }).id;
      await state.repository.deleteAgentProfile(id);
      await audit(
        (request.user as { sub?: string }).sub ?? "unknown",
        "delete_agent_profile",
        "agent_profile",
        id,
      );
      return { ok: true };
    },
  );

  app.get(
    "/api/runtime/preview",
    { preHandler: requireOwner },
    async (request) => {
      const query = request.query as { agentProfileId?: string };
      const profileId = query.agentProfileId;
      if (!profileId) {
        throw app.httpErrors.badRequest("agentProfileId is required");
      }
      const profile = (await state.repository.listAgentProfiles()).find(
        (item) => item.id === profileId,
      );
      if (!profile) {
        throw app.httpErrors.notFound("Agent profile not found");
      }
      return buildRuntimePreview(profile);
    },
  );

  app.get("/api/market/:kind", { preHandler: requireOwner }, async (request) => {
    const kind = (request.params as { kind: string }).kind;
    return {
      manifests: filterCatalogByKind(state.catalog, kind),
      installs: await state.repository.listInstallRecords(kind as never),
    };
  });

  app.post(
    "/api/market/:kind/:id/install",
    { preHandler: requireOwner },
    async (request) => {
      const params = request.params as { kind: "skills" | "plugins" | "mcp"; id: string };
      const record = {
        id: createId("install"),
        manifestId: params.id,
        kind: params.kind,
        enabled: false,
        config: {},
        installedAt: nowIso(),
        updatedAt: nowIso(),
      };
      await state.repository.saveInstallRecord(record);
      return record;
    },
  );

  app.post(
    "/api/market/:kind/:id/uninstall",
    { preHandler: requireOwner },
    async (request) => {
      const params = request.params as {
        kind: "skills" | "plugins" | "mcp";
        id: string;
      };
      await state.repository.deleteInstallRecord(params.kind, params.id);
      return { ok: true };
    },
  );

  async function toggleInstall(request: FastifyRequest, enabled: boolean) {
    const params = request.params as {
      kind: "skills" | "plugins" | "mcp";
      id: string;
    };
    const records = await state.repository.listInstallRecords(params.kind);
    const match = records.find((record) => record.manifestId === params.id);
    if (!match) {
      throw new Error("Install record not found");
    }
    const next = {
      ...match,
      enabled,
      updatedAt: nowIso(),
    };
    await state.repository.saveInstallRecord(next);
    return next;
  }

  app.post(
    "/api/market/:kind/:id/enable",
    { preHandler: requireOwner },
    (request) => toggleInstall(request, true),
  );
  app.post(
    "/api/market/:kind/:id/disable",
    { preHandler: requireOwner },
    (request) => toggleInstall(request, false),
  );

  app.get("/api/search/settings", { preHandler: requireOwner }, async () =>
    state.repository.getSearchSettings(),
  );
  app.put("/api/search/settings", { preHandler: requireOwner }, async (request) => {
    const existing = await state.repository.getSearchSettings();
    const body = request.body as Partial<SearchSettings>;
    const next = SearchSettingsSchema.parse({
      ...existing,
      ...body,
      updatedAt: nowIso(),
    });
    await state.repository.saveSearchSettings(next);
    return next;
  });

  app.get("/api/mcp/servers", { preHandler: requireOwner }, async () =>
    state.repository.listMcpServers(),
  );

  async function saveMcpServerHandler(request: FastifyRequest) {
    const body = request.body as Partial<ReturnType<typeof McpServerConfigSchema.parse>>;
    const params = (request.params ?? {}) as { id?: string };
    const existing = params.id
      ? (await state.repository.listMcpServers()).find((item) => item.id === params.id)
      : undefined;
    const id = params.id ?? body.id ?? createId("mcp");
    const timestamp = nowIso();
    const next = McpServerConfigSchema.parse({
      id,
      label: body.label ?? existing?.label ?? "MCP Server",
      description: body.description ?? existing?.description ?? "",
      manifestId: body.manifestId ?? existing?.manifestId ?? null,
      transport: body.transport ?? existing?.transport ?? "stdio",
      command: body.command ?? existing?.command,
      args: body.args ?? existing?.args ?? [],
      url: body.url ?? existing?.url,
      envRefs: body.envRefs ?? existing?.envRefs ?? {},
      headers: body.headers ?? existing?.headers ?? {},
      restartPolicy: body.restartPolicy ?? existing?.restartPolicy ?? "on-failure",
      toolCache: body.toolCache ?? existing?.toolCache ?? {},
      lastHealthStatus:
        body.lastHealthStatus ?? existing?.lastHealthStatus ?? "unknown",
      lastHealthCheckedAt:
        body.lastHealthCheckedAt ?? existing?.lastHealthCheckedAt ?? null,
      enabled: body.enabled ?? existing?.enabled ?? false,
      source: body.source ?? existing?.source ?? "custom",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await state.repository.saveMcpServer(next);
    return next;
  }

  app.post("/api/mcp/servers", { preHandler: requireOwner }, async (request) =>
    saveMcpServerHandler(request),
  );
  app.put(
    "/api/mcp/servers/:id",
    { preHandler: requireOwner },
    async (request) => saveMcpServerHandler(request),
  );
  app.delete(
    "/api/mcp/servers/:id",
    { preHandler: requireOwner },
    async (request) => {
      const id = (request.params as { id: string }).id;
      await state.repository.deleteMcpServer(id);
      return { ok: true };
    },
  );
  app.post(
    "/api/mcp/servers/:id/test",
    { preHandler: requireOwner },
    async (request) => {
      const server = (await state.repository.listMcpServers()).find(
        (item) => item.id === (request.params as { id: string }).id,
      );
      if (!server) {
        throw new Error("MCP server not found");
      }
      const result = await mcpSupervisor.healthcheck(
        await state.resolveMcpServerConfig(server),
      );
      await state.repository.saveMcpServer({
        ...server,
        lastHealthStatus: result.status === "ok" ? "ok" : "error",
        lastHealthCheckedAt: result.checkedAt,
        updatedAt: nowIso(),
      });
      return result;
    },
  );
  app.get(
    "/api/mcp/servers/:id/tools",
    { preHandler: requireOwner },
    async (request) => {
      const server = (await state.repository.listMcpServers()).find(
        (item) => item.id === (request.params as { id: string }).id,
      );
      if (!server) {
        throw new Error("MCP server not found");
      }
      return mcpSupervisor.listToolDescriptors([
        await state.resolveMcpServerConfig(server),
      ]);
    },
  );
  app.get(
    "/api/mcp/servers/:id/logs",
    { preHandler: requireOwner },
    async (request) => {
      const server = (await state.repository.listMcpServers()).find(
        (item) => item.id === (request.params as { id: string }).id,
      );
      if (!server) {
        throw new Error("MCP server not found");
      }
      const result = await mcpSupervisor.healthcheck(
        await state.resolveMcpServerConfig(server),
      );
      const logs = await mcpSupervisor.readServerLogs(server.id);
      return {
        logs,
        detail: result.detail,
        checkedAt: result.checkedAt,
      };
    },
  );

  app.get("/api/memory/status", { preHandler: requireOwner }, async () => {
    const workspace = await state.repository.getWorkspace();
    const documents = await state.repository.listMemoryDocuments();
    const chunks = await state.repository.listMemoryChunks();
    const pendingJobs = await state.repository.listJobs({ status: "pending" });
    const longterm = documents.find((item) => item.kind === "longterm");
    const daily = documents.filter((item) => item.kind === "daily").slice(-2);
    return {
      workspace,
      hasCloudflare: Boolean(state.cloudflare),
      storage: {
        r2BucketName: state.cloudflare?.credentials.r2BucketName ?? null,
        vectorizeIndexName: state.cloudflare?.credentials.vectorizeIndexName ?? null,
      },
      documents: documents.length,
      chunks: chunks.length,
      pendingJobs: pendingJobs.length,
      longterm,
      recentDaily: daily,
    };
  });

  app.post("/api/memory/reindex", { preHandler: requireOwner }, async () => {
    const workspace = await state.repository.getWorkspace();
    requireWorkspace(workspace);
    await state.queueJob({
      workspaceId: workspace.id,
      kind: "memory_reindex_all",
      payload: {},
    });
    return {
      ok: true,
      queuedAt: nowIso(),
      status: "queued",
    };
  });

  app.get("/api/documents", { preHandler: requireOwner }, async () =>
    state.repository.listDocuments(),
  );
  app.get(
    "/api/documents/:id",
    { preHandler: requireOwner },
    async (request, reply) => {
      const document = (await state.repository.listDocuments()).find(
        (item) => item.id === (request.params as { id: string }).id,
      );
      if (!document) {
        return reply.code(404).send({ error: "Document not found" });
      }
      return document;
    },
  );
  app.post(
    "/api/documents/:id/re-extract",
    { preHandler: requireOwner },
    async (request) => {
      const workspace = await state.repository.getWorkspace();
      requireWorkspace(workspace);
      const documentId = (request.params as { id: string }).id;
      await state.queueJob({
        workspaceId: workspace.id,
        kind: "document_extract",
        payload: { documentId },
      });
      return { ok: true, queuedAt: nowIso(), status: "queued" };
    },
  );
  app.post(
    "/api/documents/:id/reindex",
    { preHandler: requireOwner },
    async (request) => {
      const workspace = await state.repository.getWorkspace();
      requireWorkspace(workspace);
      const documentId = (request.params as { id: string }).id;
      await state.queueJob({
        workspaceId: workspace.id,
        kind: "memory_reindex_document",
        payload: { documentId },
      });
      return { ok: true, queuedAt: nowIso(), status: "queued" };
    },
  );

  app.get(
    "/api/jobs",
    { preHandler: requireOwner },
    async (request) => {
      const query = request.query as {
        status?: "pending" | "running" | "failed" | "completed";
        kind?: string;
      };
      const jobs = await state.repository.listJobs({
        ...(query.status ? { status: query.status } : {}),
        ...(query.kind ? { kind: query.kind as never } : {}),
      });
      return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
  );

  app.post(
    "/api/jobs/:id/retry",
    { preHandler: requireOwner },
    async (request) => {
      const job = await state.repository.getJob((request.params as { id: string }).id);
      if (!job) {
        throw app.httpErrors.notFound("Job not found");
      }
      await state.repository.saveJob({
        ...job,
        status: "pending",
        error: undefined,
        runAfter: nowIso(),
        lockedAt: null,
        lockedBy: null,
        completedAt: null,
        updatedAt: nowIso(),
      });
      return { ok: true };
    },
  );

  app.post("/api/settings/export", { preHandler: requireOwner }, async (request) => {
    const body = request.body as { accessToken?: string; exportPassphrase?: string };
    if (body.accessToken !== state.env.PULSARBOT_ACCESS_TOKEN) {
      return app.httpErrors.unauthorized("Invalid access token");
    }
    const workspace = await state.repository.getWorkspace();
    requireWorkspace(workspace);
    const runId = createId("export");
    await state.repository.saveImportExportRun({
      id: runId,
      workspaceId: workspace.id,
      type: "export",
      status: "running",
      operatorTelegramUserId: (request.user as { sub?: string }).sub ?? "unknown",
      artifactPath: null,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const bundle = await state.exportBundle(
      body.exportPassphrase ?? state.env.PULSARBOT_ACCESS_TOKEN,
    );
    await state.repository.saveImportExportRun({
      id: runId,
      workspaceId: workspace.id,
      type: "export",
      status: "completed",
      operatorTelegramUserId: (request.user as { sub?: string }).sub ?? "unknown",
      artifactPath: null,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    return bundle;
  });

  app.post("/api/settings/import", { preHandler: requireOwner }, async (request) => {
    const body = request.body as {
      accessToken?: string;
      importPassphrase?: string;
      bundle: unknown;
    };
    if (body.accessToken !== state.env.PULSARBOT_ACCESS_TOKEN) {
      return app.httpErrors.unauthorized("Invalid access token");
    }
    const workspace = await state.repository.getWorkspace();
    const workspaceId = workspace?.id ?? "main";
    const runId = createId("import");
    await state.repository.saveImportExportRun({
      id: runId,
      workspaceId,
      type: "import",
      status: "running",
      operatorTelegramUserId: (request.user as { sub?: string }).sub ?? "unknown",
      artifactPath: null,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    await state.importBundle(
      body.bundle,
      body.importPassphrase ?? state.env.PULSARBOT_ACCESS_TOKEN,
    );
    await state.repository.saveImportExportRun({
      id: runId,
      workspaceId,
      type: "import",
      status: "completed",
      operatorTelegramUserId: (request.user as { sub?: string }).sub ?? "unknown",
      artifactPath: null,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    return { ok: true };
  });

  app.post(
    "/api/settings/rewrap-secrets",
    { preHandler: requireOwner },
    async (request) => {
      const workspace = await state.repository.getWorkspace();
      requireWorkspace(workspace);
      const body = request.body as {
        accessToken?: string;
        newAccessToken?: string;
      };
      if (body.accessToken !== state.env.PULSARBOT_ACCESS_TOKEN || !body.newAccessToken) {
        return app.httpErrors.unauthorized("Invalid access token");
      }
      await state.rewrapAllSecrets({
        workspaceId: workspace.id,
        oldAccessToken: body.accessToken,
        newAccessToken: body.newAccessToken,
      });
      return { ok: true };
    },
  );

  app.get("/api/system/logs", { preHandler: requireOwner }, async () => {
    const servers = await state.repository.listMcpServers();
    return {
      note: "Structured logs stream to stdout. Runtime job, import/export, provider test, and MCP summaries are returned here for diagnostics.",
      importExportRuns: await state.repository.listImportExportRuns(20),
      recentAudit: await state.repository.listAuditEvents(20),
      recentProviderTests: await state.repository.listProviderTestRuns({ limit: 20 }),
      recentJobs: (await state.repository.listJobs())
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 30),
      recentMcpLogs: await Promise.all(
        servers.slice(0, 10).map(async (server) => ({
          serverId: server.id,
          label: server.label,
          logs: await mcpSupervisor.readServerLogs(server.id, { tailLines: 40 }),
        })),
      ),
    };
  });

  app.get("/api/system/audit", { preHandler: requireOwner }, async () =>
    state.repository.listAuditEvents(100),
  );

  app.get("/api/system/health", { preHandler: requireOwner }, async (request) => {
    const jobs = await state.repository.listJobs();
    const providerTests = await state.repository.listProviderTestRuns({ limit: 20 });
    const mcpServers = await state.repository.listMcpServers();
    const expectedWebhookUrl = resolveExpectedTelegramWebhookUrl(state.env, request);
    const webhookInfo = await readTelegramWebhookInfo();
    return {
      time: nowIso(),
      mode: state.cloudflare ? "d1" : "bootstrap",
      telegram: {
        ...telegram.describeWebhookState(),
        expectedWebhookUrl,
        webhookInfo: webhookInfo.info,
        webhookInfoError: webhookInfo.error,
      },
      bootstrapState: await state.repository.getBootstrapState(),
      hasWorkspace: Boolean(await state.repository.getWorkspace()),
      providerProfiles: (await state.repository.listProviderProfiles()).length,
      mcpServers: mcpServers.length,
      activeTurnLocks: await state.listActiveConversationLocks(),
      jobs: {
        pending: jobs.filter((job) => job.status === "pending").length,
        running: jobs.filter((job) => job.status === "running").length,
        failed: jobs.filter((job) => job.status === "failed").length,
        completed: jobs.filter((job) => job.status === "completed").length,
      },
      recentProviderTests: providerTests.slice(0, 5),
      recentMcpHealth: mcpServers
        .filter((server) => server.lastHealthCheckedAt)
        .sort((left, right) =>
          String(right.lastHealthCheckedAt).localeCompare(String(left.lastHealthCheckedAt))
        )
        .slice(0, 5),
      marketCounts: {
        skills: state.catalog.skills.length,
        plugins: state.catalog.plugins.length,
        mcp: state.catalog.mcp.length,
      },
      cloudflare: await buildCloudflareHealth(state),
    };
  });

  app.get("/api/system/telegram-webhook", { preHandler: requireOwner }, async (request) => {
    const expectedWebhookUrl = resolveExpectedTelegramWebhookUrl(state.env, request);
    const webhookInfo = await readTelegramWebhookInfo(true);
    return {
      expectedWebhookUrl,
      webhookInfo: webhookInfo.info,
      webhookInfoError: webhookInfo.error,
      local: telegram.describeWebhookState(),
    };
  });

  app.post(
    "/api/system/telegram-webhook/sync",
    { preHandler: requireOwner },
    async (request, reply) => {
      const body = request.body as { url?: string; dropPendingUpdates?: boolean } | undefined;
      const targetUrl = body?.url
        ? normalizeWebhookUrlInput(body.url)
        : resolveExpectedTelegramWebhookUrl(state.env, request);
      if (!targetUrl) {
        return reply.code(400).send({
          ok: false,
          error:
            "Cannot determine webhook URL. Set TELEGRAM_WEBHOOK_URL or PUBLIC_BASE_URL, or pass body.url.",
        });
      }

      await setTelegramWebhook(
        state.env.TELEGRAM_BOT_TOKEN,
        targetUrl,
        body?.dropPendingUpdates ?? false,
      );
      const webhookInfo = await readTelegramWebhookInfo(true);
      return {
        ok: true,
        url: targetUrl,
        webhookInfo: webhookInfo.info,
        webhookInfoError: webhookInfo.error,
      };
    },
  );

  app.post("/telegram/webhook", async (request, reply) => telegram.handler(request, reply));

  return app;
}
