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
import { AgentRuntime, runGraph } from "@pulsarbot/agent";
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
  type AgentGraphState,
  CloudflareCredentialsSchema,
  McpServerConfigSchema,
  McpProviderConfigSchema,
  McpProviderCatalogServerSchema,
  ProviderTestCapabilitySchema,
  ProviderProfileSchema,
  ResolvedRuntimeSnapshotSchema,
  SearchSettingsSchema,
  TurnEventTypeSchema,
  TurnStateSchema,
  WorkspaceExportBundleSchema,
  WorkspaceSchema,
  type AgentProfile,
  type CloudflareCredentials,
  type ConversationTurn,
  type DocumentArtifact,
  type DocumentMetadata,
  type InstallRecord,
  type LooseJsonValue,
  type McpProviderConfig,
  type McpProviderCatalogServer,
  type McpProviderKind,
  type McpServerConfig,
  type MemoryDocument,
  type ProviderTestCapability,
  type ProviderProfile,
  type ProviderTestRunResult,
  type ResolvedRuntimeSnapshot,
  type SearchSettings,
  type TelegramInboundContent,
  type TurnEvent,
  type TurnEventType,
  type TurnState,
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
    timeoutMs?: number | undefined;
  }) => Promise<ProviderInvocationResult>;
  providerMediaInvoker?: (args: {
    profile: ProviderProfile;
    apiKey: string;
    input: ProviderMediaInvocationInput;
    timeoutMs?: number | undefined;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstStringField(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstStringFieldDeep(
  record: Record<string, unknown>,
  keys: string[],
  maxDepth = 2,
): string | null {
  const seen = new Set<unknown>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value: record, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || !current.value || typeof current.value !== "object") {
      continue;
    }
    if (seen.has(current.value)) {
      continue;
    }
    seen.add(current.value);

    const currentRecord = current.value as Record<string, unknown>;
    const direct = firstStringField(currentRecord, keys);
    if (direct) {
      return direct;
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    for (const nested of Object.values(currentRecord)) {
      if (nested && typeof nested === "object") {
        queue.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

const SECRET_TEMPLATE_PATTERN = /\{\{secret:([^}]+)\}\}/g;

export async function resolveSecretTemplateString(
  value: string,
  resolveSecret: (scope: string) => Promise<string | null>,
): Promise<string> {
  const matches = [...value.matchAll(SECRET_TEMPLATE_PATTERN)];
  if (matches.length === 0) {
    const exact = await resolveSecret(value);
    return exact ?? value;
  }

  const replacements = await Promise.all(
    matches.map(async (match) => {
      const scope = match[1]?.trim() ?? "";
      if (!scope) {
        return [match[0], match[0]] as const;
      }
      const secret = await resolveSecret(scope);
      return [match[0], secret ?? match[0]] as const;
    }),
  );

  let output = value;
  for (const [needle, replacement] of replacements) {
    output = output.replace(needle, replacement);
  }
  return output;
}

function toBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "enabled", "active", "activated", "yes"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "disabled", "inactive", "deactivated", "no"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function collectBailianMcpRecords(
  value: unknown,
  output: Record<string, unknown>[],
  seen = new Set<unknown>(),
) {
  if (seen.has(value)) {
    return;
  }
  if (value && typeof value === "object") {
    seen.add(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectBailianMcpRecords(item, output, seen);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }

  const hasServerIdentity = Boolean(
    firstStringField(record, [
      "serverCode",
      "server_code",
      "serverId",
      "server_id",
    ]),
  );
  const hasStreamableUrl = Boolean(
    firstStringFieldDeep(record, [
      "url",
      "mcp",
      "mcpUrl",
      "mcp_url",
      "sseUrl",
      "sse_url",
      "streamableHttpUrl",
      "streamable_http_url",
      "endpoint",
    ]),
  );
  const hasDisplayName = Boolean(firstStringField(record, ["serverName", "name", "title"]));
  const hasCodeWithName = typeof record.code === "string" &&
    Boolean(record.code.trim()) &&
    hasDisplayName;
  const hasCandidateShape = hasServerIdentity || hasStreamableUrl || hasCodeWithName;
  if (hasCandidateShape) {
    output.push(record);
  }

  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object") {
      collectBailianMcpRecords(nested, output, seen);
    }
  }
}

export function bailianServerCodeFromUrl(url: string): string | null {
  const match = /\/api\/v1\/mcps\/([^/?#]+)\/(?:sse|mcp)(?:[/?#]|$)/i.exec(url);
  if (!match?.[1]) {
    return null;
  }
  return decodeURIComponent(match[1]);
}

function buildBailianMcpHeaders(apiKeyRef: string): Record<string, string> {
  return {
    Authorization: `Bearer {{secret:${apiKeyRef}}}`,
    api_key: `{{secret:${apiKeyRef}}}`,
  };
}

export function resolveBailianMcpEndpointUrl(
  record: Record<string, unknown>,
  origin: string,
  serverCode: string,
): string {
  const explicitUrl = firstStringFieldDeep(record, [
    "operationalUrl",
    "operational_url",
    "url",
    "mcp",
    "mcpUrl",
    "mcp_url",
    "sseUrl",
    "sse_url",
    "streamableHttpUrl",
    "streamable_http_url",
    "endpoint",
  ]);
  if (explicitUrl) {
    try {
      const resolved = explicitUrl.startsWith("/")
        ? new URL(explicitUrl, origin)
        : new URL(explicitUrl);
      const explicitServerCode = bailianServerCodeFromUrl(resolved.toString());
      if (explicitServerCode) {
        resolved.pathname = `/api/v1/mcps/${encodeURIComponent(explicitServerCode)}/mcp`;
        return resolved.toString();
      }
      return resolved.toString();
    } catch {
      if (explicitUrl.startsWith("/")) {
        return new URL(explicitUrl, origin).toString();
      }
    }
  }
  return explicitUrl ?? `${origin}/api/v1/mcps/${encodeURIComponent(serverCode)}/mcp`;
}

function mcpProviderServerId(kind: McpProviderKind, remoteId: string): string {
  if (kind === "bailian") {
    return bailianServerId(remoteId);
  }
  return `mcp_provider_${safePathSegment(kind)}_${safePathSegment(remoteId)}`.toLowerCase();
}

function normalizeBailianProviderProtocol(value: unknown): "streamable_http" | "sse" | "unknown" {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "streamablehttp" || normalized === "streamable_http") {
    return "streamable_http";
  }
  if (normalized === "sse") {
    return "sse";
  }
  return "unknown";
}

async function fetchBailianProviderCatalog(
  apiKey: string,
): Promise<McpProviderCatalogServer[]> {
  const pageSize = 20;
  const fetchedAt = nowIso();
  const servers: McpProviderCatalogServer[] = [];
  let pageNo = 1;
  let total = Number.POSITIVE_INFINITY;

  while (servers.length < total) {
    const endpoint = `https://dashscope.aliyuncs.com/api/v1/mcps/user/list?pageNo=${pageNo}&pageSize=${pageSize}`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Bailian MCP provider fetch failed: HTTP ${response.status}`);
    }

    const payload = await response.json() as {
      success?: boolean;
      message?: string;
      total?: number;
      data?: Array<Record<string, unknown>>;
    };

    if (!payload.success) {
      throw new Error(payload.message || "Bailian MCP provider fetch failed");
    }

    const records = Array.isArray(payload.data) ? payload.data : [];
    total = typeof payload.total === "number" && Number.isFinite(payload.total)
      ? payload.total
      : records.length;

    for (const record of records) {
      const remoteId = firstStringField(record, ["id"]) ?? firstStringField(record, ["serverCode"]);
      const operationalUrl = firstStringField(record, ["operationalUrl", "url"]);
      if (!remoteId || !operationalUrl) {
        continue;
      }
      const rawProtocol = normalizeBailianProviderProtocol(record.type);
      const standardSseServerCode = rawProtocol === "sse"
        ? bailianServerCodeFromUrl(operationalUrl)
        : null;
      const resolvedOperationalUrl = standardSseServerCode
        ? resolveBailianMcpEndpointUrl(
            record,
            resolveBailianOrigin(operationalUrl),
            standardSseServerCode,
          )
        : operationalUrl;
      const protocol = standardSseServerCode ? "streamable_http" : rawProtocol;

      servers.push(
        McpProviderCatalogServerSchema.parse({
          remoteId,
          serverId: mcpProviderServerId("bailian", remoteId),
          label: firstStringField(record, ["name", "serverName", "title"]) ?? remoteId,
          description: firstStringField(record, ["description", "desc", "summary"]) ?? "",
          operationalUrl: resolvedOperationalUrl,
          protocol,
          active: toBooleanLike(record.active) ?? true,
          tags: Array.isArray(record.tags)
            ? record.tags.filter((value): value is string => typeof value === "string")
            : [],
          logoUrl: firstStringField(record, ["logoUrl", "logo_url"]),
          provider: firstStringField(record, ["provider"]),
          providerUrl: firstStringField(record, ["providerUrl", "provider_url"]),
          fetchedAt,
        }),
      );
    }

    if (records.length < pageSize) {
      break;
    }
    pageNo += 1;
  }

  return servers;
}

function bailianServerId(serverCode: string): string {
  const normalized = safePathSegment(serverCode).toLowerCase();
  return `mcp_bailian_${normalized}`;
}

function resolveBailianOrigin(apiBaseUrl: string): string {
  const fallback = "https://dashscope.aliyuncs.com";
  if (!apiBaseUrl) {
    return fallback;
  }
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    return fallback;
  }
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

function isMissingProviderProfileError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Provider profile not found:");
}

const TURN_GRAPH_VERSION = "v2";
const TURN_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TURN_GRAPH_RECOVERABLE_NODES_V1 = new Set([
  "persist_assistant_message",
  "persist_tool_runs",
  "finalize_turn",
]);
const TURN_GRAPH_NON_RESUMABLE_NODES_V1 = new Set(["run_agent_core", "emit_reply"]);
const TURN_GRAPH_RECOVERABLE_NODES_V2 = new Set([
  "run_agent_graph",
  "persist_assistant_artifacts",
  "finalize_turn",
]);
const TURN_GRAPH_NON_RESUMABLE_NODES_V2 = new Set(["emit_reply"]);

function turnGraphRecoverableNodes(graphVersion: TurnState["graphVersion"]): Set<string> {
  return graphVersion === "v1" ? TURN_GRAPH_RECOVERABLE_NODES_V1 : TURN_GRAPH_RECOVERABLE_NODES_V2;
}

function turnGraphNonResumableNodes(graphVersion: TurnState["graphVersion"]): Set<string> {
  return graphVersion === "v1" ? TURN_GRAPH_NON_RESUMABLE_NODES_V1 : TURN_GRAPH_NON_RESUMABLE_NODES_V2;
}

function toTurnError(args: {
  error: unknown;
  nodeId: string;
  retryable?: boolean;
  code?: string;
}): NonNullable<TurnState["error"]> {
  const message = args.error instanceof Error ? args.error.message : String(args.error);
  const errorCode = args.code ?? (args.error instanceof AppError ? args.error.code : "TURN_NODE_FAILED");
  return {
    code: errorCode,
    message,
    nodeId: args.nodeId,
    retryable: args.retryable ?? false,
    raw: toLooseJsonRecord({
      message,
    }),
  };
}

function turnErrorIncludes(
  error: TurnState["error"] | null | undefined,
  pattern: string,
): boolean {
  return Boolean(error?.message.toLowerCase().includes(pattern.toLowerCase()));
}

function describeTelegramTurnFailure(
  error: TurnState["error"] | null | undefined,
  status: TurnState["status"],
): string {
  if (error?.code === "TURN_LOCK_CONFLICT") {
    return "A previous agent turn is still running for this chat. Please try again in a moment.";
  }
  if (error?.code === "NO_AGENT_PROFILE") {
    return "No agent profile is configured yet. Open the Mini App first.";
  }
  if (error?.code === "NO_PROVIDER_PROFILE") {
    return "No provider is configured for the active profile yet. Open the Mini App to add one.";
  }
  if (error?.code === "SECRET_NOT_FOUND") {
    return "Provider API key is not configured. Open Mini App > Providers and save a valid API key.";
  }
  if (
    turnErrorIncludes(error, "planner model timed out")
  ) {
    return "Planning timed out before the agent could decide the next step. Please try again, or increase the planner timeout for the active profile.";
  }
  if (
    error?.code === "AGENT_PROVIDER_TIMEOUT" ||
    turnErrorIncludes(error, "provider request timed out") ||
    turnErrorIncludes(error, "final response generation timed out")
  ) {
    return "The model timed out before it could finish the request. Please try again, or increase the timeout for the active profile.";
  }
  if (status === "aborted") {
    return "The request was cancelled before completion.";
  }
  return "The agent turn failed. Open the Mini App health page for details.";
}

function titleCaseWords(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function humanizeToolId(toolId: string): string {
  return titleCaseWords(
    toolId
      .replace(/^mcp:/, "")
      .split(/[:_/-]+/)
      .filter(Boolean)
      .join(" "),
  );
}

function describeTurnProgressForGraphNode(nodeId: string): string | null {
  switch (nodeId) {
    case "ingest_input":
    case "preprocess_content":
    case "load_runtime":
    case "persist_user_message":
      return "Getting things ready...";
    case "run_agent_graph":
      return "Planning the next steps...";
    case "persist_assistant_artifacts":
    case "finalize_turn":
      return "Finalizing the reply...";
    default:
      return null;
  }
}

function describeTurnProgressForSubgraph(subgraph: string): string | null {
  switch (subgraph) {
    case "research":
      return "Researching the topic...";
    case "memory":
      return "Checking memory...";
    case "document":
      return "Reading the document...";
    default:
      return null;
  }
}

function describeTurnProgressForAgentNode(nodeId: string, subgraph?: string): string | null {
  if (subgraph) {
    const specialistStatus = describeTurnProgressForSubgraph(subgraph);
    if (specialistStatus) {
      return specialistStatus;
    }
  }

  switch (nodeId) {
    case "plan_step":
      return "Planning the next steps...";
    case "route_action":
      return "Choosing the next action...";
    case "generate_final_response":
      return "Writing the answer...";
    case "refresh_summary":
      return "Refreshing context...";
    case "merge_specialist_result":
      return "Combining the results...";
    default:
      return null;
  }
}

function describeTurnProgressForTool(toolId: string): string {
  switch (toolId) {
    case "search_web":
      return "Searching the web...";
    case "web_browse":
      return "Browsing a web page...";
    case "document_extract_text":
      return "Reading the document...";
    case "memory_search":
      return "Checking memory...";
    case "memory_append_daily":
    case "memory_upsert_longterm":
    case "memory_refresh_before_compact":
      return "Updating memory...";
    default:
      return `Using ${humanizeToolId(toolId)}...`;
  }
}

function syncTurnToolResultsFromAgentState(
  turnState: TurnState,
  agentState: AgentGraphState,
): TurnState["toolResults"] {
  if (turnState.graphVersion !== "v2") {
    return turnState.toolResults;
  }
  return agentState.toolLedger.map((tool) => ({
    callId: tool.callId,
    toolId: tool.toolId,
    source: tool.toolId.startsWith("mcp:")
      ? "mcp"
      : tool.toolId.startsWith("memory_")
        ? "builtin"
        : "plugin",
    input: toLooseJsonRecord(tool.input),
    output: JSON.parse(JSON.stringify(tool.output ?? null)) as LooseJsonValue,
    status: tool.status,
    idempotencyKey: tool.idempotencyKey,
    startedAt: tool.startedAt,
    finishedAt: tool.finishedAt,
    error: tool.error,
  }));
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

interface ActiveTurnQueueItem {
  promise: Promise<void>;
  resolve: () => void;
}

interface BailianMcpSyncStatus {
  status: "idle" | "ok" | "error" | "skipped";
  reason: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  endpoint: string | null;
  providerId: string | null;
  manifestEnabled: boolean | null;
  discoveredServers: number;
  syncedServers: number;
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

function parseTelegramUpdateId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const value = record.update_id;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
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
    mcpProviders: [],
  };
  public readonly agent: AgentRuntime;

  private pendingCloudflare: CloudflareCredentials | null = null;
  private bailianMcpSyncPromise: Promise<void> | null = null;
  private bailianMcpLastSyncAtMs = 0;
  private readonly bailianMcpSyncIntervalMs = 120_000;
  private bailianMcpSyncStatus: BailianMcpSyncStatus = {
    status: "idle",
    reason: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    endpoint: null,
    providerId: null,
    manifestEnabled: null,
    discoveredServers: 0,
    syncedServers: 0,
  };

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

  private async fetchBailianMcpMarketServers(args: {
    profile: ProviderProfile;
    apiKey: string;
  }): Promise<{ servers: McpServerConfig[]; endpoint: string | null }> {
    const fallbackBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const origin = resolveBailianOrigin(args.profile.apiBaseUrl || fallbackBaseUrl);
    const endpointCandidates = [
      `${origin}/api/v1/mcps?activated=true`,
      `${origin}/api/v1/mcps`,
    ];

    for (const endpoint of endpointCandidates) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${args.apiKey}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        logger.warn(
          {
            endpoint,
            reason: error instanceof Error ? error.message : String(error),
          },
          "Failed to fetch Bailian MCP market endpoint",
        );
        continue;
      }

      if (!response.ok) {
        continue;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = await response.text();
      }

      const candidateRecords: Record<string, unknown>[] = [];
      collectBailianMcpRecords(payload, candidateRecords);
      const entries = new Map<
        string,
        {
          serverCode: string;
          label: string;
          description: string;
          url: string;
          activated: boolean | null;
        }
      >();
      let activationSignals = 0;

      for (const record of candidateRecords) {
        const serverCode =
          firstStringField(record, [
            "serverCode",
            "server_code",
            "serverId",
            "server_id",
          ]) ??
          (typeof record.code === "string" && firstStringField(record, ["serverName", "name", "title"])
            ? record.code.trim()
            : null) ??
          (() => {
            const resolvedUrl = firstStringFieldDeep(record, [
              "url",
              "mcp",
              "mcpUrl",
              "mcp_url",
              "sseUrl",
              "sse_url",
              "streamableHttpUrl",
              "streamable_http_url",
              "endpoint",
            ]);
            return resolvedUrl ? bailianServerCodeFromUrl(resolvedUrl) : null;
          })();
        if (!serverCode) {
          continue;
        }

        const activated = toBooleanLike(
          record.activated ??
            record.isActivated ??
            record.active ??
            record.enabled ??
            record.isEnabled,
        );
        if (activated !== null) {
          activationSignals += 1;
        }

        const label = firstStringField(record, [
          "serverName",
          "server_name",
          "name",
          "title",
        ]) ?? serverCode;
        const description = firstStringField(record, [
          "description",
          "desc",
          "summary",
        ]) ?? "Synced from Alibaba Bailian MCP Market.";
        const resolvedUrl = resolveBailianMcpEndpointUrl(record, origin, serverCode);

        entries.set(serverCode, {
          serverCode,
          label,
          description,
          url: resolvedUrl,
          activated,
        });
      }

      let parsedEntries = [...entries.values()];
      if (activationSignals > 0) {
        parsedEntries = parsedEntries.filter((entry) => entry.activated === true);
      }
      if (parsedEntries.length === 0) {
        continue;
      }

      const timestamp = nowIso();
      return {
        endpoint,
        servers: parsedEntries.map((entry) =>
          McpServerConfigSchema.parse({
            id: bailianServerId(entry.serverCode),
            label: entry.label,
            description: `${entry.description}\n\nSynced from Alibaba Bailian MCP Market.`,
            manifestId: "alibaba-bailian",
            transport: "streamable_http",
            url: entry.url,
            envRefs: {},
            headers: buildBailianMcpHeaders(args.profile.apiKeyRef),
            restartPolicy: "on-failure",
            toolCache: {},
            lastHealthStatus: "unknown",
            lastHealthCheckedAt: null,
            enabled: true,
            source: "bailian_market",
            createdAt: timestamp,
            updatedAt: timestamp,
          })
        ),
      };
    }

    return { servers: [], endpoint: endpointCandidates[0] ?? null };
  }

  private async syncBailianMcpServersFromProvider(): Promise<void> {
    const attemptAt = nowIso();
    const mcpInstalls = await this.repository.listInstallRecords("mcp");
    const bailianInstallEnabled = mcpInstalls.some((install) =>
      install.manifestId === "alibaba-bailian" && install.enabled
    );
    this.bailianMcpSyncStatus = {
      ...this.bailianMcpSyncStatus,
      lastAttemptAt: attemptAt,
      manifestEnabled: bailianInstallEnabled,
      discoveredServers: 0,
      syncedServers: 0,
      endpoint: null,
      reason: null,
    };
    if (!bailianInstallEnabled) {
      this.bailianMcpSyncStatus = {
        ...this.bailianMcpSyncStatus,
        status: "skipped",
        reason: "Alibaba Bailian MCP manifest is not enabled",
        providerId: null,
      };
      return;
    }

    const providerProfiles = await this.repository.listProviderProfiles();
    const bailianProvider = providerProfiles.find((provider) =>
      provider.kind === "bailian" && provider.enabled
    );
    if (!bailianProvider) {
      this.bailianMcpSyncStatus = {
        ...this.bailianMcpSyncStatus,
        status: "skipped",
        reason: "Enabled Bailian provider not found",
        providerId: null,
      };
      return;
    }
    this.bailianMcpSyncStatus = {
      ...this.bailianMcpSyncStatus,
      providerId: bailianProvider.id,
    };

    let apiKey: string;
    try {
      apiKey = await this.resolveApiKey(bailianProvider.apiKeyRef);
    } catch (error) {
      this.bailianMcpSyncStatus = {
        ...this.bailianMcpSyncStatus,
        status: "error",
        reason: error instanceof Error ? error.message : "Bailian provider API key is missing",
      };
      return;
    }

    const result = await this.fetchBailianMcpMarketServers({
      profile: bailianProvider,
      apiKey,
    });
    this.bailianMcpSyncStatus = {
      ...this.bailianMcpSyncStatus,
      endpoint: result.endpoint,
      discoveredServers: result.servers.length,
    };
    if (result.servers.length === 0) {
      this.bailianMcpSyncStatus = {
        ...this.bailianMcpSyncStatus,
        status: "skipped",
        reason: "No activated Bailian MCP servers were returned",
      };
      return;
    }

    const existingServers = await this.repository.listMcpServers();
    const existingById = new Map(existingServers.map((server) => [server.id, server]));
    const syncedIds = new Set<string>();
    const timestamp = nowIso();

    for (const server of result.servers) {
      syncedIds.add(server.id);
      const existing = existingById.get(server.id);
      await this.repository.saveMcpServer(
        McpServerConfigSchema.parse({
          ...server,
          enabled: existing?.enabled ?? server.enabled,
          restartPolicy: existing?.restartPolicy ?? server.restartPolicy,
          toolCache: existing?.toolCache ?? server.toolCache,
          lastHealthStatus: existing?.lastHealthStatus ?? server.lastHealthStatus,
          lastHealthCheckedAt:
            existing?.lastHealthCheckedAt ?? server.lastHealthCheckedAt,
          createdAt: existing?.createdAt ?? server.createdAt,
          updatedAt: timestamp,
        }),
      );
    }

    for (const existing of existingServers) {
      if (existing.source !== "bailian_market" || syncedIds.has(existing.id)) {
        continue;
      }
      if (!existing.enabled) {
        continue;
      }
      await this.repository.saveMcpServer({
        ...existing,
        enabled: false,
        updatedAt: timestamp,
      });
    }

    this.bailianMcpSyncStatus = {
      ...this.bailianMcpSyncStatus,
      status: "ok",
      reason: null,
      lastSuccessAt: timestamp,
      syncedServers: result.servers.length,
    };
  }

  public async ensureBailianMcpServersSynced(
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      return;
    }

    const now = Date.now();
    if (
      !options.force &&
      now - this.bailianMcpLastSyncAtMs < this.bailianMcpSyncIntervalMs
    ) {
      return;
    }
    if (this.bailianMcpSyncPromise) {
      return this.bailianMcpSyncPromise;
    }

    this.bailianMcpSyncPromise = this.syncBailianMcpServersFromProvider()
      .catch((error) => {
        this.bailianMcpSyncStatus = {
          ...this.bailianMcpSyncStatus,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        };
        logger.warn(
          {
            reason: error instanceof Error ? error.message : String(error),
          },
          "Failed to sync Bailian MCP servers",
        );
      })
      .finally(() => {
        this.bailianMcpLastSyncAtMs = Date.now();
        this.bailianMcpSyncPromise = null;
      });

    return this.bailianMcpSyncPromise;
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

    const resolveSecretValue = async (scope: string) => {
      const secret = await this.repository.getSecretByScope(workspace.id, scope);
      if (!secret) {
        return null;
      }
      try {
        return decryptSecret({
          accessToken: this.env.PULSARBOT_ACCESS_TOKEN,
          workspaceId: workspace.id,
          envelope: secret,
        });
      } catch {
        return null;
      }
    };

    const resolveStringRecord = async (record: Record<string, string>) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(record).map(async ([key, value]) => [
            key,
            await resolveSecretTemplateString(value, resolveSecretValue),
          ]),
        ),
      );

    return {
      ...server,
      envRefs: await resolveStringRecord(server.envRefs),
      headers: await resolveStringRecord(server.headers),
    };
  }

  public getBailianMcpSyncStatus(): BailianMcpSyncStatus {
    return { ...this.bailianMcpSyncStatus };
  }

  public async runProvider(args: {
    profile: ProviderProfile;
    apiKey: string;
    input: ProviderInvocationInput;
    timeoutMs?: number | undefined;
  }) {
    return (this.options.providerInvoker ?? invokeProvider)(args);
  }

  public async runProviderMedia(args: {
    profile: ProviderProfile;
    apiKey: string;
    input: ProviderMediaInvocationInput;
    timeoutMs?: number | undefined;
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
    const snapshot = ResolvedRuntimeSnapshotSchema.parse(
      resolveRuntimeSnapshot({
        workspaceId: workspace.id,
        profile,
        searchSettings: await this.repository.getSearchSettings(),
        catalog: this.catalog,
        installs: await this.repository.listInstallRecords(),
        mcpServers: await this.repository.listMcpServers(),
      }),
    );
    if (snapshot.blocked.length > 0) {
      logger.warn(
        {
          profileId: profile.id,
          blocked: snapshot.blocked,
        },
        "Runtime resolved with blocked capabilities",
      );
    }
    return snapshot;
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
    const workspace = WorkspaceSchema.parse({
      id: args.workspaceId,
      label: args.label ?? "Pulsarbot Workspace",
      timezone: args.timezone ?? "UTC",
      ownerTelegramUserId: args.ownerTelegramUserId,
      ownerTelegramUsername: args.ownerTelegramUsername ?? null,
      primaryModelProfileId: null,
      backgroundModelProfileId: null,
      activeAgentProfileId: null,
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
      mcpProviders: await this.repository.listMcpProviders(),
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
    for (const provider of parsed.mcpProviders) {
      await this.repository.saveMcpProvider(provider);
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
        updateId?: number | null;
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
      updateId: payload.updateId ?? null,
      threadId: payload.threadId ?? null,
    };
  }

  return {
    updateId: payload.updateId ?? null,
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
  const activeTurns = new Map<string, ActiveTurnQueueItem>();
  const acquireActiveTurnSlot = async (
    conversationId: string,
    maxWaitMs = 60_000,
  ): Promise<ActiveTurnQueueItem | null> => {
    const deadline = Date.now() + maxWaitMs;

    while (true) {
      const existing = activeTurns.get(conversationId);
      if (!existing) {
        let resolve!: () => void;
        const promise = new Promise<void>((next) => {
          resolve = next;
        });
        const slot: ActiveTurnQueueItem = {
          promise,
          resolve,
        };
        activeTurns.set(conversationId, slot);
        return slot;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return null;
      }

      await new Promise<void>((next) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            next();
          }
        }, remainingMs);
        void existing.promise.then(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            next();
          }
        });
      });
    }
  };
  const jwtSecret = getJwtSecret(state.env.PULSARBOT_ACCESS_TOKEN);
  const officialMcpServerId = (manifestId: string) => `mcp_official_${manifestId}`;

  async function upsertOfficialMcpServer(
    manifestId: string,
    options: { enabled?: boolean } = {},
  ) {
    const manifest = state.catalog.mcp.find((item) => item.id === manifestId);
    if (!manifest) {
      throw app.httpErrors.notFound("MCP manifest not found");
    }

    const existing = (await state.repository.listMcpServers()).find((server) =>
      server.id === officialMcpServerId(manifest.id)
    );
    const timestamp = nowIso();
    const nextServer = McpServerConfigSchema.parse({
      id: officialMcpServerId(manifest.id),
      label: existing?.label ?? manifest.title,
      description: existing?.description ?? manifest.description,
      manifestId: manifest.id,
      providerId: null,
      providerKind: null,
      transport: manifest.transport,
      command: existing?.command ?? manifest.command,
      args: existing?.args ?? manifest.args ?? [],
      url: existing?.url ?? manifest.url,
      envRefs: existing?.envRefs ?? manifest.envTemplate ?? {},
      headers: existing?.headers ?? {},
      restartPolicy: existing?.restartPolicy ?? "on-failure",
      toolCache: existing?.toolCache ?? {},
      lastHealthStatus: existing?.lastHealthStatus ?? "unknown",
      lastHealthCheckedAt: existing?.lastHealthCheckedAt ?? null,
      enabled: options.enabled ?? existing?.enabled ?? false,
      source: "official",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await state.repository.saveMcpServer(nextServer);
    return nextServer;
  }

  async function attachMcpServerToActiveProfile(serverId: string) {
    const workspace = await state.repository.getWorkspace();
    if (!workspace?.activeAgentProfileId) {
      return {
        profileId: null,
        attached: false,
      };
    }

    const profiles = await state.repository.listAgentProfiles();
    const activeProfile = profiles.find((profile) => profile.id === workspace.activeAgentProfileId);
    if (!activeProfile) {
      return {
        profileId: workspace.activeAgentProfileId,
        attached: false,
      };
    }
    if (activeProfile.enabledMcpServerIds.includes(serverId)) {
      return {
        profileId: activeProfile.id,
        attached: true,
      };
    }

    await state.repository.saveAgentProfile({
      ...activeProfile,
      enabledMcpServerIds: [...activeProfile.enabledMcpServerIds, serverId],
      updatedAt: nowIso(),
    });
    return {
      profileId: activeProfile.id,
      attached: true,
    };
  }

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
    turnId?: string;
    graphVersion?: string | null;
    stateSnapshotId?: string | null;
    currentNode?: string | null;
    resumeEligible?: boolean;
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
    const turnId = args.turnId ?? createId("turn");
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
      graphVersion: args.graphVersion ?? TURN_GRAPH_VERSION,
      stateSnapshotId: args.stateSnapshotId ?? null,
      lastEventSeq: 0,
      currentNode: args.currentNode ?? "acquire_turn_lock",
      resumeEligible: args.resumeEligible ?? true,
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
    status?: ConversationTurn["status"];
    error?: string | null;
    stateSnapshotId?: string | null;
    currentNode?: string | null;
    resumeEligible?: boolean;
    lastEventSeq?: number;
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
        status: args.status ?? (args.error ? "failed" : "completed"),
        stepCount: args.stepCount,
        toolCallCount: args.toolCallCount,
        compacted: args.compacted,
        summaryId: latestSummary?.id ?? turn.summaryId,
        error: args.error ?? null,
        stateSnapshotId: args.stateSnapshotId ?? turn.stateSnapshotId ?? null,
        currentNode: args.currentNode ?? turn.currentNode ?? null,
        resumeEligible: args.resumeEligible ?? false,
        lastEventSeq: args.lastEventSeq ?? turn.lastEventSeq ?? 0,
        finishedAt: timestamp,
        lockExpiresAt: null,
        updatedAt: timestamp,
      });
    }
  };

  const updateTurnGraphPointers = async (args: {
    turnId: string;
    stateSnapshotId?: string | null;
    currentNode?: string | null;
    lastEventSeq?: number;
    resumeEligible?: boolean;
  }) => {
    const turn = await state.repository.getConversationTurn(args.turnId);
    if (!turn) {
      return;
    }
    await state.repository.saveConversationTurn({
      ...turn,
      ...(typeof args.stateSnapshotId !== "undefined"
        ? { stateSnapshotId: args.stateSnapshotId }
        : {}),
      ...(typeof args.currentNode !== "undefined"
        ? { currentNode: args.currentNode }
        : {}),
      ...(typeof args.lastEventSeq !== "undefined"
        ? { lastEventSeq: args.lastEventSeq }
        : {}),
      ...(typeof args.resumeEligible !== "undefined"
        ? { resumeEligible: args.resumeEligible }
        : {}),
      updatedAt: nowIso(),
    });
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
    const mediaTimeoutMs = Math.max(args.profile.maxToolDurationMs, 30_000);

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
          timeoutMs: mediaTimeoutMs,
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
          timeoutMs: mediaTimeoutMs,
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
          timeoutMs: mediaTimeoutMs,
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

  const userMessageIdForTurn = (turnId: string) => `msg:${turnId}:user`;
  const assistantMessageIdForTurn = (turnId: string) => `msg:${turnId}:assistant`;
  const toolRunIdForTurn = (turnId: string, callId: string) => `tool:${turnId}:${callId}`;

  const persistAssistantArtifactsFromState = async (args: {
    conversationId: string;
    stateSnapshot: TurnState;
  }) => {
    await state.repository.saveConversationMessage(args.conversationId, {
      id: assistantMessageIdForTurn(args.stateSnapshot.turnId),
      conversationId: args.conversationId,
      role: "assistant",
      content: args.stateSnapshot.output.replyText,
      sourceType: "text",
      telegramMessageId: null,
      metadata: toLooseJsonRecord({
        turnId: args.stateSnapshot.turnId,
        compacted: Boolean(args.stateSnapshot.context.summaryCursor),
        ...(args.stateSnapshot.context.summaryCursor
          ? {
              summary: args.stateSnapshot.context.summaryCursor,
            }
          : {}),
      }),
      createdAt: nowIso(),
    });
  };

  const telegram = (options.telegramFactory ?? createTelegramBot)({
    token: state.env.TELEGRAM_BOT_TOKEN,
    onMessage: async (rawPayload, stream) => {
      const streamController = stream ?? {
        enabled: false,
        emit: async () => {},
        finalize: async () => {},
      };
      let payload: TelegramUpdatePayload | null = null;
      let conversationId: string | null = null;
      let activeTurnSlot: ActiveTurnQueueItem | null = null;
      let releasedActiveTurnSlot = false;

      try {
        payload = normalizeTelegramPayload(rawPayload);
        const workspace = await state.repository.getWorkspace();
        requireWorkspace(workspace);

        if (
          workspace.ownerTelegramUserId &&
          workspace.ownerTelegramUserId !== String(payload.userId)
        ) {
          return "This Pulsarbot instance only responds to the configured owner.";
        }

        const resolvedPayload = payload;
        const resolvedConversationId = resolvedPayload.threadId === null
          ? `telegram:${resolvedPayload.chatId}`
          : `telegram:${resolvedPayload.chatId}:thread:${resolvedPayload.threadId}`;
        conversationId = resolvedConversationId;
        activeTurnSlot = await acquireActiveTurnSlot(resolvedConversationId, 60_000);
        if (!activeTurnSlot) {
          return "A previous agent turn is still running for this chat. Please try again in a moment.";
        }

        const startedAt = nowIso();
        const turnId = createId("turn");
        const stateSnapshotId = createId("state");
        const fallbackText = normalizeInboundText(resolvedPayload.content);

        let turnState = TurnStateSchema.parse({
        id: stateSnapshotId,
        turnId,
        workspaceId: workspace.id,
        conversationId: resolvedConversationId,
        graphVersion: TURN_GRAPH_VERSION,
        status: "running",
        currentNode: "ingest_input",
        version: 0,
        input: {
          updateId: resolvedPayload.updateId,
          chatId: resolvedPayload.chatId,
          threadId: resolvedPayload.threadId,
          userId: resolvedPayload.userId,
          username: resolvedPayload.username ?? null,
          messageId: resolvedPayload.messageId,
          contentKind: resolvedPayload.content.kind,
          normalizedText: fallbackText,
          rawMetadata: toLooseJsonRecord({
            ...resolvedPayload.content.metadata,
            threadId: resolvedPayload.threadId,
            ...(resolvedPayload.updateId !== null ? { updateId: resolvedPayload.updateId } : {}),
          }),
        },
        context: {
          profileId: null,
          timezone: workspace.timezone,
          nowIso: startedAt,
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
          deadlineAt: new Date(
            Date.parse(startedAt) + 60_000,
          ).toISOString(),
        },
        agent: {
          version: "v2",
          status: "idle",
          currentNode: null,
          currentSubgraph: null,
          iteration: 0,
          plannerMode: null,
          lastAction: null,
          pendingActions: [],
          scratchpad: [],
          subgraphStack: [],
          toolLedger: [],
          memoryLedger: [],
          summary: {
            existing: "",
            working: "",
            refreshedAt: null,
          },
          reply: {
            draft: "",
            final: "",
            streamedChars: 0,
          },
          counters: {
            planningStepsUsed: 0,
            toolCallsUsed: 0,
            specialistCallsUsed: 0,
            consecutiveNoopPlans: 0,
          },
          flags: {
            needsCompaction: false,
            summaryDirty: false,
            finalReplyReady: false,
          },
          checkpoints: {
            lastPlannerAt: null,
            lastToolAt: null,
            lastSpecialistAt: null,
          },
        },
        toolResults: [],
        output: {
          replyText: "",
          telegramReplyMessageId: null,
          streamingEnabled: streamController.enabled,
          lastRenderedChars: 0,
        },
        error: null,
        recovery: {
          resumeEligible: true,
          resumeCount: 0,
          lastRecoveredAt: null,
        },
        createdAt: startedAt,
        updatedAt: startedAt,
      });

        const graphContext: {
          workspace: Workspace;
          payload: TelegramUpdatePayload;
          conversationId: string;
        profile: AgentProfile | null;
        runtime: ResolvedRuntimeSnapshot | null;
        acquiredTurnId: string | null;
        document: DocumentMetadata | null;
        } = {
          workspace,
          payload: resolvedPayload,
          conversationId: resolvedConversationId,
          profile: null,
          runtime: null,
          acquiredTurnId: null,
        document: null,
      };

      let eventSeq = 0;

      const persistTurnState = async () => {
        turnState = TurnStateSchema.parse({
          ...turnState,
          version: turnState.version + 1,
          updatedAt: nowIso(),
        });
        await state.repository.saveTurnStateSnapshot(turnState);
        await updateTurnGraphPointers({
          turnId: turnState.turnId,
          stateSnapshotId: turnState.id,
          currentNode: turnState.currentNode,
          lastEventSeq: eventSeq,
          resumeEligible: turnState.recovery.resumeEligible,
        });
      };

      const appendTurnEvent = async (args: {
        nodeId: string;
        eventType: TurnEventType;
        attempt: number;
        payload?: Record<string, unknown>;
      }) => {
        eventSeq += 1;
        const event: TurnEvent = {
          id: createId("tevt"),
          turnId: turnState.turnId,
          seq: eventSeq,
          nodeId: args.nodeId,
          eventType: TurnEventTypeSchema.parse(args.eventType),
          attempt: args.attempt,
          payload: toLooseJsonRecord(args.payload ?? {}),
          occurredAt: nowIso(),
        };
        await state.repository.appendTurnEvent(event);
        await updateTurnGraphPointers({
          turnId: turnState.turnId,
          stateSnapshotId: turnState.id,
          currentNode: turnState.currentNode,
          lastEventSeq: eventSeq,
          resumeEligible: turnState.recovery.resumeEligible,
        });
      };

      let lastProgressPreview = "";
      const emitProgressPreview = async (message: string | null | undefined) => {
        if (!streamController.enabled || turnState.output.lastRenderedChars > 0 || turnState.output.replyText) {
          return;
        }
        const next = message?.trim();
        if (!next || next === lastProgressPreview) {
          return;
        }
        lastProgressPreview = next;
        try {
          await streamController.emit(next);
        } catch {
          // Ignore preview streaming failures and continue the turn.
        }
      };

      const agentObserver: NonNullable<Parameters<typeof state.agent.runTurn>[0]["observer"]> = {
        onNodeStarted: async ({ nodeId, subgraph, state: nextAgentState, attempt }) => {
          turnState.agent = nextAgentState;
          turnState.toolResults = syncTurnToolResultsFromAgentState(turnState, nextAgentState);
          turnState.budgets.stepsUsed = nextAgentState.counters.planningStepsUsed;
          turnState.budgets.toolCallsUsed = nextAgentState.counters.toolCallsUsed;
          turnState.context.summaryCursor = nextAgentState.summary.working || null;
          await persistTurnState();
          await appendTurnEvent({
            nodeId,
            eventType: "agent_node_started",
            attempt,
            payload: {
              subgraph,
            },
          });
          await emitProgressPreview(describeTurnProgressForAgentNode(nodeId, subgraph));
        },
        onNodeSucceeded: async ({ nodeId, subgraph, state: nextAgentState, attempt }) => {
          turnState.agent = nextAgentState;
          turnState.toolResults = syncTurnToolResultsFromAgentState(turnState, nextAgentState);
          turnState.budgets.stepsUsed = nextAgentState.counters.planningStepsUsed;
          turnState.budgets.toolCallsUsed = nextAgentState.counters.toolCallsUsed;
          turnState.context.summaryCursor = nextAgentState.summary.working || null;
          await persistTurnState();
          await appendTurnEvent({
            nodeId,
            eventType: "agent_node_succeeded",
            attempt,
            payload: {
              subgraph,
            },
          });
        },
        onNodeFailed: async ({ nodeId, subgraph, state: nextAgentState, attempt, error }) => {
          turnState.agent = nextAgentState;
          turnState.toolResults = syncTurnToolResultsFromAgentState(turnState, nextAgentState);
          await persistTurnState();
          await appendTurnEvent({
            nodeId,
            eventType: "agent_node_failed",
            attempt,
            payload: {
              subgraph,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        },
        onActionPlanned: async ({ action, state: nextAgentState }) => {
          turnState.agent = nextAgentState;
          await persistTurnState();
          await appendTurnEvent({
            nodeId: nextAgentState.currentNode ?? "plan_step",
            eventType: "agent_action_planned",
            attempt: 1,
            payload: {
              action: JSON.parse(JSON.stringify(action)) as Record<string, unknown>,
            },
          });
        },
        onToolUpdated: async ({ tool, previous, state: nextAgentState }) => {
          turnState.agent = nextAgentState;
          turnState.toolResults = syncTurnToolResultsFromAgentState(turnState, nextAgentState);
          turnState.budgets.toolCallsUsed = nextAgentState.counters.toolCallsUsed;
          await state.repository.saveToolRun({
            id: toolRunIdForTurn(turnState.turnId, tool.callId),
            conversationId: resolvedConversationId,
            turnId: turnState.turnId,
            toolId: tool.toolId,
            toolSource: tool.toolId.startsWith("mcp:")
              ? "mcp"
              : tool.toolId.startsWith("memory_")
                ? "builtin"
                : "plugin",
            input: toLooseJsonRecord(tool.input),
            output: JSON.parse(JSON.stringify(tool.output ?? null)) as LooseJsonValue,
            status: tool.status,
            durationMs:
              Date.parse(tool.finishedAt ?? tool.startedAt) -
              Date.parse(tool.startedAt),
            createdAt: tool.startedAt,
          });
          await persistTurnState();
          if (!previous || previous.status !== tool.status) {
            await appendTurnEvent({
              nodeId: tool.toolId,
              eventType: tool.status === "pending"
                ? "tool_started"
                : tool.status === "failed"
                  ? "tool_failed"
                  : "tool_succeeded",
              attempt: tool.attempt,
              payload: {
                callId: tool.callId,
                subgraph: tool.subgraph,
              },
            });
            if (tool.status === "pending") {
              await emitProgressPreview(describeTurnProgressForTool(tool.toolId));
            }
          }
        },
        onStatePatched: async ({ state: nextAgentState }) => {
          turnState.agent = nextAgentState;
          turnState.toolResults = syncTurnToolResultsFromAgentState(turnState, nextAgentState);
          turnState.budgets.stepsUsed = nextAgentState.counters.planningStepsUsed;
          turnState.budgets.toolCallsUsed = nextAgentState.counters.toolCallsUsed;
          turnState.context.summaryCursor = nextAgentState.summary.working || null;
          if (nextAgentState.reply.final) {
            turnState.output.replyText = nextAgentState.reply.final;
          }
          await persistTurnState();
        },
        onSubgraphEntered: async ({ subgraph, state: nextAgentState }) => {
          turnState.agent = nextAgentState;
          await persistTurnState();
          await appendTurnEvent({
            nodeId: subgraph,
            eventType: "agent_subgraph_entered",
            attempt: 1,
            payload: {
              subgraph,
            },
          });
          await emitProgressPreview(describeTurnProgressForSubgraph(subgraph));
        },
        onSubgraphExited: async ({ subgraph, state: nextAgentState, status }) => {
          turnState.agent = nextAgentState;
          await persistTurnState();
          await appendTurnEvent({
            nodeId: subgraph,
            eventType: "agent_subgraph_exited",
            attempt: 1,
            payload: {
              subgraph,
              status,
            },
          });
        },
      };

      const graphNodeOrder = [
        "ingest_input",
        "acquire_turn_lock",
        "preprocess_content",
        "load_runtime",
        "persist_user_message",
        "run_agent_graph",
        "persist_assistant_artifacts",
        "finalize_turn",
        "emit_reply",
      ] as const;

      const nextNodeFor = (nodeId: string): string | null => {
        if (nodeId === "fail_turn") {
          return "emit_reply";
        }
        if (nodeId === "emit_reply") {
          return null;
        }
        if (turnState.status === "aborted") {
          return graphContext.acquiredTurnId ? "finalize_turn" : "emit_reply";
        }
        const index = graphNodeOrder.indexOf(nodeId as (typeof graphNodeOrder)[number]);
        if (index < 0 || index + 1 >= graphNodeOrder.length) {
          return null;
        }
        return graphNodeOrder[index + 1] ?? null;
      };

        try {
          await persistTurnState();
          await appendTurnEvent({
            nodeId: "ingest_input",
            eventType: "turn_started",
            attempt: 1,
          });

        await runGraph({
          state: turnState,
          context: graphContext,
          startNode: "ingest_input",
          failNode: "fail_turn",
          resolveNext: ({ nodeId }) => nextNodeFor(nodeId),
          hooks: {
            onNodeStarted: async ({ nodeId, attempt }) => {
              turnState.currentNode = nodeId;
              turnState.recovery.resumeEligible = !turnGraphNonResumableNodes(
                turnState.graphVersion,
              ).has(nodeId);
              await persistTurnState();
              await appendTurnEvent({
                nodeId,
                eventType: "node_started",
                attempt,
                payload: {
                  status: turnState.status,
                },
              });
              await emitProgressPreview(describeTurnProgressForGraphNode(nodeId));
            },
            onNodeSucceeded: async ({ nodeId, attempt }) => {
              await persistTurnState();
              await appendTurnEvent({
                nodeId,
                eventType: "node_succeeded",
                attempt,
                payload: {
                  status: turnState.status,
                },
              });
            },
            onNodeFailed: async ({ nodeId, attempt, error }) => {
              turnState.status = "failed";
              turnState.error = toTurnError({
                error,
                nodeId,
              });
              turnState.recovery.resumeEligible = false;
              await persistTurnState();
              await appendTurnEvent({
                nodeId,
                eventType: "node_failed",
                attempt,
                payload: {
                  error: turnState.error.message,
                  code: turnState.error.code,
                },
              });
            },
          },
          nodes: {
            ingest_input: {
              id: "ingest_input",
              run: async () => {
                const profiles = await state.repository.listAgentProfiles();
                const profile =
                  profiles.find((item) => item.id === workspace.activeAgentProfileId) ??
                  profiles.find((item) => item.label === "balanced") ??
                  profiles[0];
                if (!profile) {
                  turnState.status = "aborted";
                  turnState.error = {
                    code: "NO_AGENT_PROFILE",
                    message: "No agent profile is configured",
                    nodeId: "ingest_input",
                    retryable: false,
                    raw: {},
                  };
                  turnState.output.replyText =
                    "No agent profile is configured yet. Open the Mini App first.";
                  turnState.recovery.resumeEligible = false;
                  return "emit_reply";
                }
                graphContext.profile = profile;
                turnState.context.profileId = profile.id;
                turnState.context.nowIso = nowIso();
                turnState.budgets.maxPlanningSteps = profile.maxPlanningSteps;
                turnState.budgets.maxToolCalls = profile.maxToolCalls;
                turnState.budgets.maxTurnDurationMs = profile.maxTurnDurationMs;
                turnState.budgets.deadlineAt = new Date(
                  Date.now() + profile.maxTurnDurationMs,
                ).toISOString();
              },
            },
            acquire_turn_lock: {
              id: "acquire_turn_lock",
              run: async () => {
                const profileId = turnState.context.profileId;
                if (!profileId) {
                  throw new Error("Profile id is missing before lock acquisition");
                }
                const acquired = await acquireConversationTurn({
                  workspaceId: workspace.id,
                  conversationId: resolvedConversationId,
                  profileId,
                  telegramChatId: String(resolvedPayload.chatId),
                  telegramUserId: String(resolvedPayload.userId),
                  turnId: turnState.turnId,
                  graphVersion: TURN_GRAPH_VERSION,
                  stateSnapshotId: turnState.id,
                  currentNode: "acquire_turn_lock",
                  resumeEligible: true,
                });
                if (!acquired.acquired) {
                  turnState.status = "aborted";
                  turnState.error = {
                    code: "TURN_LOCK_CONFLICT",
                    message: "A previous turn is still running",
                    nodeId: "acquire_turn_lock",
                    retryable: true,
                    raw: {},
                  };
                  turnState.output.replyText =
                    "A previous agent turn is still running for this chat. Please try again in a moment.";
                  turnState.recovery.resumeEligible = false;
                  return "emit_reply";
                }
                graphContext.acquiredTurnId = acquired.turnId ?? turnState.turnId;
                turnState.turnId = graphContext.acquiredTurnId;
              },
            },
            preprocess_content: {
              id: "preprocess_content",
              run: async () => {
                if (!graphContext.profile) {
                  throw new Error("Profile is missing for preprocess");
                }
                const processedPayload = await registerDocument(
                  workspace.id,
                  resolvedPayload,
                  graphContext.profile,
                  turnState.input.normalizedText,
                );
                graphContext.document = processedPayload.document;
                turnState.input.normalizedText = processedPayload.normalizedText;
                turnState.input.rawMetadata = toLooseJsonRecord({
                  ...turnState.input.rawMetadata,
                  ...(processedPayload.document
                    ? {
                        documentId: processedPayload.document.id,
                      }
                    : {}),
                });
              },
            },
            load_runtime: {
              id: "load_runtime",
              run: async () => {
                if (!graphContext.profile) {
                  throw new Error("Profile is missing for runtime resolution");
                }
                try {
                  graphContext.runtime = await state.resolveRuntime(graphContext.profile);
                  turnState.context.runtimeSnapshot = toLooseJsonRecord(
                    JSON.parse(JSON.stringify(graphContext.runtime)) as Record<string, unknown>,
                  );
                  turnState.context.searchSettings = graphContext.runtime.searchSettings;
                } catch (error) {
                  if (isMissingProviderProfileError(error)) {
                    turnState.status = "aborted";
                    turnState.error = {
                      code: "NO_PROVIDER_PROFILE",
                      message: error instanceof Error ? error.message : String(error),
                      nodeId: "load_runtime",
                      retryable: false,
                      raw: {},
                    };
                    turnState.output.replyText =
                      "No provider is configured for the active profile yet. Open the Mini App to add one.";
                    turnState.recovery.resumeEligible = false;
                    return graphContext.acquiredTurnId ? "finalize_turn" : "emit_reply";
                  }
                  throw error;
                }
              },
            },
            persist_user_message: {
              id: "persist_user_message",
              run: async () => {
                await state.repository.saveConversationMessage(resolvedConversationId, {
                  id: userMessageIdForTurn(turnState.turnId),
                  conversationId: resolvedConversationId,
                  role: "user",
                  content: turnState.input.normalizedText,
                  sourceType: sourceTypeForContent(resolvedPayload.content),
                  telegramMessageId: resolvedPayload.messageId ? String(resolvedPayload.messageId) : null,
                  metadata: toLooseJsonRecord({
                    ...resolvedPayload.content.metadata,
                    threadId: resolvedPayload.threadId,
                    ...(resolvedPayload.updateId !== null ? { updateId: resolvedPayload.updateId } : {}),
                    ...(graphContext.document ? { documentId: graphContext.document.id } : {}),
                  }),
                  createdAt: nowIso(),
                });
                turnState.context.historyWindow = (
                  await state.repository.listConversationMessages(resolvedConversationId)
                ).length;
              },
            },
            run_agent_graph: {
              id: "run_agent_graph",
              run: async () => {
                if (!graphContext.profile || !graphContext.runtime) {
                  throw new Error("Runtime prerequisites are missing");
                }
                const allMessages = await state.repository.listConversationMessages(resolvedConversationId);
                const history = allMessages.filter(
                  (message) => message.id !== userMessageIdForTurn(turnState.turnId),
                );
                try {
                  const result = await state.agent.runTurn({
                    profile: graphContext.profile,
                    userMessage: turnState.input.normalizedText,
                    history,
                    resumeState: turnState.agent.currentNode ? turnState.agent : undefined,
                    observer: agentObserver,
                    ...(streamController.enabled
                      ? {
                          streamReply: {
                            onPartial: async (text: string) => {
                              turnState.output.lastRenderedChars = text.length;
                              await streamController.emit(text);
                            },
                          },
                        }
                      : {}),
                    context: {
                      workspaceId: workspace.id,
                      conversationId: resolvedConversationId,
                      turnId: turnState.turnId,
                      nowIso: nowIso(),
                      timezone: workspace.timezone,
                      profileId: graphContext.profile.id,
                      searchSettings: graphContext.runtime.searchSettings,
                      runtime: graphContext.runtime,
                    },
                  });

                  turnState.output.replyText = result.reply;
                  turnState.budgets.stepsUsed = result.stepCount;
                  turnState.budgets.toolCallsUsed = result.toolRuns.length;
                  turnState.context.summaryCursor = result.summary ?? null;
                  turnState.agent = result.agentState;
                  turnState.toolResults = syncTurnToolResultsFromAgentState(
                    turnState,
                    result.agentState,
                  );
                } catch (error) {
                  if (isMissingProviderProfileError(error)) {
                    throw new AppError(
                      "NO_PROVIDER_PROFILE",
                      error instanceof Error ? error.message : String(error),
                      400,
                    );
                  }
                  if (isMissingSecretError(error)) {
                    turnState.status = "aborted";
                    turnState.error = {
                      code: "SECRET_NOT_FOUND",
                      message: error instanceof Error ? error.message : String(error),
                      nodeId: "run_agent_graph",
                      retryable: false,
                      raw: {},
                    };
                    turnState.output.replyText =
                      "Provider API key is not configured. Open Mini App > Providers and save a valid API key.";
                    turnState.recovery.resumeEligible = false;
                    return "finalize_turn";
                  }
                  throw error;
                }
              },
            },
            persist_assistant_artifacts: {
              id: "persist_assistant_artifacts",
              run: async () => {
                await persistAssistantArtifactsFromState({
                  conversationId: resolvedConversationId,
                  stateSnapshot: turnState,
                });
              },
            },
            finalize_turn: {
              id: "finalize_turn",
              run: async () => {
                if (!graphContext.acquiredTurnId) {
                  return;
                }
                await finalizeConversationTurn({
                  conversationId: resolvedConversationId,
                  turnId: graphContext.acquiredTurnId,
                  telegramChatId: String(resolvedPayload.chatId),
                  telegramUserId: String(resolvedPayload.userId),
                  stepCount: turnState.budgets.stepsUsed,
                  compacted: Boolean(turnState.context.summaryCursor),
                  toolCallCount: turnState.budgets.toolCallsUsed,
                  status: turnState.status === "aborted"
                    ? "aborted"
                    : turnState.error
                      ? "failed"
                      : "completed",
                  error: turnState.error?.message ?? null,
                  stateSnapshotId: turnState.id,
                  currentNode: turnState.currentNode,
                  resumeEligible: false,
                  lastEventSeq: eventSeq,
                });
                if (turnState.status === "running") {
                  turnState.status = "succeeded";
                }
                turnState.recovery.resumeEligible = false;
              },
            },
            emit_reply: {
              id: "emit_reply",
              run: async () => {
                if (!turnState.output.replyText) {
                  turnState.output.replyText = describeTelegramTurnFailure(
                    turnState.error,
                    turnState.status,
                  );
                }
              },
            },
            fail_turn: {
              id: "fail_turn",
              run: async () => {
                if (!turnState.error) {
                  turnState.error = {
                    code: "TURN_FAILED",
                    message: "Unknown turn failure",
                    nodeId: turnState.currentNode,
                    retryable: false,
                    raw: {},
                  };
                }
                turnState.status = "failed";
                turnState.recovery.resumeEligible = false;
                if (graphContext.acquiredTurnId) {
                  await finalizeConversationTurn({
                    conversationId: resolvedConversationId,
                    turnId: graphContext.acquiredTurnId,
                    telegramChatId: String(resolvedPayload.chatId),
                    telegramUserId: String(resolvedPayload.userId),
                    stepCount: turnState.budgets.stepsUsed,
                    compacted: Boolean(turnState.context.summaryCursor),
                    toolCallCount: turnState.budgets.toolCallsUsed,
                    status: "failed",
                    error: turnState.error.message,
                    stateSnapshotId: turnState.id,
                    currentNode: "fail_turn",
                    resumeEligible: false,
                    lastEventSeq: eventSeq,
                  });
                }
                if (!turnState.output.replyText) {
                  turnState.output.replyText = describeTelegramTurnFailure(
                    turnState.error,
                    turnState.status,
                  );
                }
              },
            },
          },
        });
        } catch (error) {
          logger.error({ error, conversationId, turnId: turnState.turnId }, "Turn graph execution failed");
          turnState.status = "failed";
          turnState.error = turnState.error ?? toTurnError({
            error,
            nodeId: turnState.currentNode,
            code: "TURN_GRAPH_CRASHED",
          });
          turnState.recovery.resumeEligible = false;
          if (!turnState.output.replyText) {
            turnState.output.replyText = describeTelegramTurnFailure(
              turnState.error,
              turnState.status,
            );
          }
          await persistTurnState();
        } finally {
          activeTurnSlot.resolve();
          if (activeTurns.get(conversationId) === activeTurnSlot) {
            activeTurns.delete(conversationId);
          }
          releasedActiveTurnSlot = true;
          const terminalEvent: TurnEventType = turnState.status === "failed" ||
              turnState.status === "aborted"
            ? "turn_failed"
            : "turn_succeeded";
          await appendTurnEvent({
            nodeId: turnState.currentNode,
            eventType: terminalEvent,
            attempt: 1,
            payload: {
              status: turnState.status,
              error: turnState.error?.message ?? null,
            },
          });
          await persistTurnState();
        }

        return turnState.output.replyText;
      } catch (outerError) {
        if (activeTurnSlot && conversationId && !releasedActiveTurnSlot) {
          activeTurnSlot.resolve();
          if (activeTurns.get(conversationId) === activeTurnSlot) {
            activeTurns.delete(conversationId);
          }
        }
        logger.error(
          {
            error: outerError,
            chatId: payload?.chatId ?? null,
            updateId: payload?.updateId ?? null,
          },
          "onMessage setup failed before graph execution",
        );
        return "Something went wrong during initialization. Please try again.";
      }
    },
  });

  const recoverInterruptedTurns = async () => {
    const runningTurns = await state.repository.listConversationTurns({ status: "running" });
    for (const turn of runningTurns) {
      const snapshot = await state.repository.getLatestTurnState(turn.id);
      const conversation = await state.repository.getConversation(turn.conversationId);
      const chatId = conversation?.telegramChatId ?? "0";
      const userId = conversation?.telegramUserId ?? "0";
      let seq = turn.lastEventSeq ?? 0;

      const appendRecoveryEvent = async (eventType: TurnEventType, payload: Record<string, unknown>) => {
        seq += 1;
        await state.repository.appendTurnEvent({
          id: createId("tevt"),
          turnId: turn.id,
          seq,
          nodeId: snapshot?.currentNode ?? turn.currentNode ?? "unknown",
          eventType,
          attempt: 1,
          payload: toLooseJsonRecord(payload),
          occurredAt: nowIso(),
        });
      };

      if (!snapshot) {
        await finalizeConversationTurn({
          conversationId: turn.conversationId,
          turnId: turn.id,
          telegramChatId: chatId,
          telegramUserId: userId,
          stepCount: turn.stepCount,
          compacted: turn.compacted,
          toolCallCount: turn.toolCallCount,
          status: "failed",
          error: "TURN_INTERRUPTED_NO_STATE",
          currentNode: turn.currentNode ?? "unknown",
          resumeEligible: false,
          lastEventSeq: seq,
        });
        continue;
      }

      const recoveredAt = nowIso();
      const recoveredState = TurnStateSchema.parse({
        ...snapshot,
        version: snapshot.version + 1,
        updatedAt: recoveredAt,
        recovery: {
          ...snapshot.recovery,
          resumeCount: snapshot.recovery.resumeCount + 1,
          lastRecoveredAt: recoveredAt,
        },
      });
      await state.repository.saveTurnStateSnapshot(recoveredState);

      if (recoveredState.graphVersion === "v2" && recoveredState.currentNode === "run_agent_graph") {
        const workspace = await state.repository.getWorkspace();
        const profileId = recoveredState.context.profileId ?? turn.profileId;
        const profile = (await state.repository.listAgentProfiles()).find((item) => item.id === profileId);
        if (!workspace || !profile) {
          const failedState = TurnStateSchema.parse({
            ...recoveredState,
            status: "failed",
            version: recoveredState.version + 1,
            updatedAt: nowIso(),
            error: {
              code: "TURN_INTERRUPTED_NON_RESUMABLE",
              message: "Turn interrupted before agent graph could resume",
              nodeId: recoveredState.currentNode,
              retryable: false,
              raw: {},
            },
            recovery: {
              ...recoveredState.recovery,
              resumeEligible: false,
            },
          });
          await state.repository.saveTurnStateSnapshot(failedState);
          await appendRecoveryEvent("turn_failed", {
            code: failedState.error?.code ?? "TURN_INTERRUPTED_NON_RESUMABLE",
            message: failedState.error?.message ?? "Turn interrupted",
          });
          await finalizeConversationTurn({
            conversationId: turn.conversationId,
            turnId: turn.id,
            telegramChatId: chatId,
            telegramUserId: userId,
            stepCount: failedState.budgets.stepsUsed,
            compacted: Boolean(failedState.context.summaryCursor),
            toolCallCount: failedState.budgets.toolCallsUsed,
            status: "failed",
            error: failedState.error?.message ?? "Turn interrupted",
            stateSnapshotId: failedState.id,
            currentNode: failedState.currentNode,
            resumeEligible: false,
            lastEventSeq: seq,
          });
          continue;
        }

        const runtime = await state.resolveRuntime(profile);
        const allMessages = await state.repository.listConversationMessages(turn.conversationId);
        const history = allMessages.filter((message) => message.id !== userMessageIdForTurn(turn.id));
        try {
          const result = await state.agent.runTurn({
            profile,
            userMessage: recoveredState.input.normalizedText,
            history,
            resumeState: recoveredState.agent,
            context: {
              workspaceId: workspace.id,
              conversationId: turn.conversationId,
              turnId: turn.id,
              nowIso: nowIso(),
              timezone: workspace.timezone,
              profileId: profile.id,
              searchSettings: runtime.searchSettings,
              runtime,
            },
          });
          const finishedState = TurnStateSchema.parse({
            ...recoveredState,
            version: recoveredState.version + 1,
            updatedAt: nowIso(),
            status: result.agentState.status === "aborted" ? "aborted" : "succeeded",
            agent: result.agentState,
            toolResults: syncTurnToolResultsFromAgentState(recoveredState, result.agentState),
            output: {
              ...recoveredState.output,
              replyText: result.reply,
            },
            context: {
              ...recoveredState.context,
              summaryCursor: result.summary ?? recoveredState.context.summaryCursor,
              runtimeSnapshot: toLooseJsonRecord(
                JSON.parse(JSON.stringify(runtime)) as Record<string, unknown>,
              ),
              searchSettings: runtime.searchSettings,
            },
            budgets: {
              ...recoveredState.budgets,
              stepsUsed: result.stepCount,
              toolCallsUsed: result.toolRuns.length,
            },
            recovery: {
              ...recoveredState.recovery,
              resumeEligible: false,
            },
          });
          await state.repository.saveTurnStateSnapshot(finishedState);
          await appendRecoveryEvent("turn_recovered", {
            resumed: true,
            node: recoveredState.currentNode,
          });
          await persistAssistantArtifactsFromState({
            conversationId: turn.conversationId,
            stateSnapshot: finishedState,
          });
          await finalizeConversationTurn({
            conversationId: turn.conversationId,
            turnId: turn.id,
            telegramChatId: chatId,
            telegramUserId: userId,
            stepCount: finishedState.budgets.stepsUsed,
            compacted: Boolean(finishedState.context.summaryCursor),
            toolCallCount: finishedState.budgets.toolCallsUsed,
            status: finishedState.status === "aborted" ? "aborted" : "completed",
            error: finishedState.error?.message ?? null,
            stateSnapshotId: finishedState.id,
            currentNode: "finalize_turn",
            resumeEligible: false,
            lastEventSeq: seq,
          });
          await appendRecoveryEvent(
            finishedState.status === "aborted" ? "turn_failed" : "turn_succeeded",
            {
              node: recoveredState.currentNode,
            },
          );
          continue;
        } catch (error) {
          const failedState = TurnStateSchema.parse({
            ...recoveredState,
            status: "failed",
            version: recoveredState.version + 1,
            updatedAt: nowIso(),
            error: {
              code: "TURN_INTERRUPTED_NON_RESUMABLE",
              message: error instanceof Error ? error.message : String(error),
              nodeId: recoveredState.currentNode,
              retryable: false,
              raw: {},
            },
            recovery: {
              ...recoveredState.recovery,
              resumeEligible: false,
            },
          });
          await state.repository.saveTurnStateSnapshot(failedState);
          await appendRecoveryEvent("turn_failed", {
            code: failedState.error?.code ?? "TURN_INTERRUPTED_NON_RESUMABLE",
            message: failedState.error?.message ?? "Turn interrupted",
          });
          await finalizeConversationTurn({
            conversationId: turn.conversationId,
            turnId: turn.id,
            telegramChatId: chatId,
            telegramUserId: userId,
            stepCount: failedState.budgets.stepsUsed,
            compacted: Boolean(failedState.context.summaryCursor),
            toolCallCount: failedState.budgets.toolCallsUsed,
            status: "failed",
            error: failedState.error?.message ?? "Turn interrupted",
            stateSnapshotId: failedState.id,
            currentNode: failedState.currentNode,
            resumeEligible: false,
            lastEventSeq: seq,
          });
          continue;
        }
      }

      if (
        !recoveredState.recovery.resumeEligible ||
        turnGraphNonResumableNodes(recoveredState.graphVersion).has(recoveredState.currentNode) ||
        !turnGraphRecoverableNodes(recoveredState.graphVersion).has(recoveredState.currentNode)
      ) {
        const failedState = TurnStateSchema.parse({
          ...recoveredState,
          status: "failed",
          version: recoveredState.version + 1,
          updatedAt: nowIso(),
          error: recoveredState.error ?? {
            code: "TURN_INTERRUPTED_NON_RESUMABLE",
            message: "Turn interrupted at non-resumable node",
            nodeId: recoveredState.currentNode,
            retryable: false,
            raw: {},
          },
          recovery: {
            ...recoveredState.recovery,
            resumeEligible: false,
          },
        });
        await state.repository.saveTurnStateSnapshot(failedState);
        await appendRecoveryEvent("turn_recovered", {
          resumed: false,
          reason: "non_resumable",
          node: recoveredState.currentNode,
        });
        await appendRecoveryEvent("turn_failed", {
          code: failedState.error?.code ?? "TURN_INTERRUPTED_NON_RESUMABLE",
          message: failedState.error?.message ?? "Turn interrupted",
        });
        await finalizeConversationTurn({
          conversationId: turn.conversationId,
          turnId: turn.id,
          telegramChatId: chatId,
          telegramUserId: userId,
          stepCount: failedState.budgets.stepsUsed,
          compacted: Boolean(failedState.context.summaryCursor),
          toolCallCount: failedState.budgets.toolCallsUsed,
          status: "failed",
          error: failedState.error?.message ?? "Turn interrupted",
          stateSnapshotId: failedState.id,
          currentNode: failedState.currentNode,
          resumeEligible: false,
          lastEventSeq: seq,
        });
        continue;
      }

      await appendRecoveryEvent("turn_recovered", {
        resumed: true,
        node: recoveredState.currentNode,
      });
      await persistAssistantArtifactsFromState({
        conversationId: turn.conversationId,
        stateSnapshot: recoveredState,
      });
      await finalizeConversationTurn({
        conversationId: turn.conversationId,
        turnId: turn.id,
        telegramChatId: chatId,
        telegramUserId: userId,
        stepCount: recoveredState.budgets.stepsUsed,
        compacted: Boolean(recoveredState.context.summaryCursor),
        toolCallCount: recoveredState.budgets.toolCallsUsed,
        status: recoveredState.error ? "failed" : "completed",
        error: recoveredState.error?.message ?? null,
        stateSnapshotId: recoveredState.id,
        currentNode: "finalize_turn",
        resumeEligible: false,
        lastEventSeq: seq,
      });
      await appendRecoveryEvent(
        recoveredState.error ? "turn_failed" : "turn_succeeded",
        {
          node: recoveredState.currentNode,
        },
      );
    }
  };

  const pruneOldTurnEvents = async () => {
    const cutoffIso = new Date(Date.now() - TURN_EVENT_RETENTION_MS).toISOString();
    const removed = await state.repository.pruneTurnEventsOlderThan(cutoffIso);
    if (removed > 0) {
      logger.info({ removed, cutoffIso }, "Pruned old turn events");
    }
  };

  await recoverInterruptedTurns();
  await pruneOldTurnEvents();

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
  const turnEventPruner = setInterval(() => {
    void pruneOldTurnEvents().catch((error) => {
      logger.warn({ error }, "Failed to prune turn events");
    });
  }, 24 * 60 * 60 * 1000);

  app.addHook("onClose", async () => {
    clearInterval(backgroundWorker);
    clearInterval(turnEventPruner);
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
      defaultModel: body.defaultModel ?? existing?.defaultModel ?? "gpt-5",
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
      const id = (request.params as { id: string }).id;
      const providers = await state.repository.listProviderProfiles();
      const target = providers.find((item) => item.id === id);
      if (!target) {
        throw app.httpErrors.notFound("Provider not found");
      }
      await state.repository.deleteProviderProfile(id);
      const workspace = await state.repository.getWorkspace();
      if (workspace) {
        const nextPrimary = workspace.primaryModelProfileId === id
          ? null
          : workspace.primaryModelProfileId;
        const nextBackground = workspace.backgroundModelProfileId === id
          ? null
          : workspace.backgroundModelProfileId;
        if (
          nextPrimary !== workspace.primaryModelProfileId ||
          nextBackground !== workspace.backgroundModelProfileId
        ) {
          await state.repository.saveWorkspace({
            ...workspace,
            primaryModelProfileId: nextPrimary,
            backgroundModelProfileId: nextBackground,
            updatedAt: nowIso(),
          });
        }
      }
      await audit(
        (request.user as { sub?: string }).sub ?? "unknown",
        "delete_provider",
        "provider_profile",
        id,
        {
          kind: target.kind,
          label: target.label,
        },
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
        body.maxTurnDurationMs ?? existing?.maxTurnDurationMs ?? 60_000,
      maxToolDurationMs:
        body.maxToolDurationMs ?? existing?.maxToolDurationMs ?? 30_000,
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
      const manifests = filterCatalogByKind(state.catalog, params.kind);
      const manifest = manifests.find((item) => item.id === params.id);
      if (!manifest) {
        throw app.httpErrors.notFound("Market manifest not found");
      }

      const existing = (await state.repository.listInstallRecords(params.kind)).find((record) =>
        record.manifestId === params.id
      );
      const timestamp = nowIso();
      const record = {
        id: existing?.id ?? createId("install"),
        manifestId: params.id,
        kind: params.kind,
        enabled: existing?.enabled ?? false,
        config: existing?.config ?? {},
        installedAt: existing?.installedAt ?? timestamp,
        updatedAt: timestamp,
      };
      await state.repository.saveInstallRecord(record);
      if (params.kind === "mcp") {
        await upsertOfficialMcpServer(params.id);
      }
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
      if (params.kind === "mcp") {
        const existing = (await state.repository.listMcpServers()).find((server) =>
          server.id === officialMcpServerId(params.id)
        );
        if (existing) {
          await state.repository.saveMcpServer({
            ...existing,
            enabled: false,
            updatedAt: nowIso(),
          });
        }
      }
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
    if (params.kind === "mcp") {
      const server = await upsertOfficialMcpServer(params.id, { enabled });
      if (enabled) {
        await attachMcpServerToActiveProfile(server.id);
      }
    }
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

  app.get("/api/mcp/providers/catalog", { preHandler: requireOwner }, async () =>
    state.catalog.mcpProviders,
  );

  app.get("/api/mcp/providers", { preHandler: requireOwner }, async () =>
    state.repository.listMcpProviders(),
  );

  async function saveMcpProviderHandler(request: FastifyRequest) {
    const workspace = await state.repository.getWorkspace();
    requireWorkspace(workspace);
    const body = request.body as Partial<McpProviderConfig> & { apiKey?: string; accessToken?: string };
    const params = (request.params ?? {}) as { id?: string };
    const providers = await state.repository.listMcpProviders();
    const existing = params.id
      ? providers.find((item) => item.id === params.id)
      : providers.find((item) => item.kind === (body.kind ?? "bailian"));
    const id = params.id ?? body.id ?? createId("mcpprovider");
    const timestamp = nowIso();
    const next = McpProviderConfigSchema.parse({
      id,
      kind: body.kind ?? existing?.kind ?? "bailian",
      label: body.label ?? existing?.label ?? "Alibaba Bailian",
      apiKeyRef: body.apiKeyRef ?? existing?.apiKeyRef ?? `mcp-provider:${id}:apiKey`,
      enabled: body.enabled ?? existing?.enabled ?? true,
      catalogCache: body.catalogCache ?? existing?.catalogCache ?? [],
      lastFetchedAt: body.lastFetchedAt ?? existing?.lastFetchedAt ?? null,
      lastFetchStatus: body.lastFetchStatus ?? existing?.lastFetchStatus ?? "idle",
      lastFetchError: body.lastFetchError ?? existing?.lastFetchError ?? null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });

    await state.repository.saveMcpProvider(next);
    if (body.apiKey) {
      if (body.accessToken !== state.env.PULSARBOT_ACCESS_TOKEN) {
        throw app.httpErrors.unauthorized("Invalid access token");
      }
      const existingSecret = await state.repository.getSecretByScope(
        workspace.id,
        next.apiKeyRef,
      );
      await state.repository.saveSecret(
        encryptSecret({
          accessToken: state.env.PULSARBOT_ACCESS_TOKEN,
          workspaceId: workspace.id,
          scope: next.apiKeyRef,
          plainText: body.apiKey,
          ...(existingSecret ? { existingId: existingSecret.id } : {}),
        }),
      );
    }
    return next;
  }

  app.post("/api/mcp/providers", { preHandler: requireOwner }, async (request) =>
    saveMcpProviderHandler(request),
  );
  app.put(
    "/api/mcp/providers/:id",
    { preHandler: requireOwner },
    async (request) => saveMcpProviderHandler(request),
  );
  app.delete(
    "/api/mcp/providers/:id",
    { preHandler: requireOwner },
    async (request) => {
      const id = (request.params as { id: string }).id;
      const providers = await state.repository.listMcpProviders();
      const target = providers.find((item) => item.id === id);
      if (!target) {
        throw app.httpErrors.notFound("MCP provider not found");
      }
      await state.repository.deleteMcpProvider(id);
      const servers = await state.repository.listMcpServers();
      await Promise.all(
        servers
          .filter((server) => server.providerId === id)
          .map((server) => state.repository.deleteMcpServer(server.id)),
      );
      return { ok: true };
    },
  );

  app.post(
    "/api/mcp/providers/:id/fetch",
    { preHandler: requireOwner },
    async (request) => {
      const id = (request.params as { id: string }).id;
      const provider = (await state.repository.listMcpProviders()).find((item) => item.id === id);
      if (!provider) {
        throw app.httpErrors.notFound("MCP provider not found");
      }

      let apiKey: string;
      try {
        apiKey = await state.resolveApiKey(provider.apiKeyRef);
      } catch (error) {
        throw app.httpErrors.badRequest(
          error instanceof Error ? error.message : "MCP provider API key is missing",
        );
      }

      try {
        const catalogCache = provider.kind === "bailian"
          ? await fetchBailianProviderCatalog(apiKey)
          : [];
        const next = McpProviderConfigSchema.parse({
          ...provider,
          catalogCache,
          lastFetchedAt: nowIso(),
          lastFetchStatus: "ok",
          lastFetchError: null,
          updatedAt: nowIso(),
        });
        await state.repository.saveMcpProvider(next);
        return {
          provider: next,
          servers: catalogCache,
        };
      } catch (error) {
        const next = McpProviderConfigSchema.parse({
          ...provider,
          lastFetchedAt: nowIso(),
          lastFetchStatus: "error",
          lastFetchError: error instanceof Error ? error.message : String(error),
          updatedAt: nowIso(),
        });
        await state.repository.saveMcpProvider(next);
        throw app.httpErrors.badRequest(next.lastFetchError ?? "MCP provider fetch failed");
      }
    },
  );

  app.post(
    "/api/mcp/providers/:id/servers",
    { preHandler: requireOwner },
    async (request) => {
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as { remoteId?: string };
      const remoteId = typeof body.remoteId === "string" ? body.remoteId : "";
      if (!remoteId) {
        throw app.httpErrors.badRequest("remoteId is required");
      }
      const provider = (await state.repository.listMcpProviders()).find((item) => item.id === id);
      if (!provider) {
        throw app.httpErrors.notFound("MCP provider not found");
      }
      const entry = provider.catalogCache.find((item) => item.remoteId === remoteId);
      if (!entry) {
        throw app.httpErrors.badRequest("Provider server was not found in the fetched catalog");
      }
      if (entry.protocol !== "streamable_http") {
        throw app.httpErrors.badRequest("Only streamable_http provider servers are supported");
      }

      const existing = (await state.repository.listMcpServers()).find((server) =>
        server.id === entry.serverId
      );
      const timestamp = nowIso();
      const nextServer = McpServerConfigSchema.parse({
        id: entry.serverId,
        label: entry.label,
        description: entry.description
          ? `${entry.description}\n\nAdded from MCP provider ${provider.label}.`
          : `Added from MCP provider ${provider.label}.`,
        manifestId: existing?.manifestId ?? null,
        providerId: provider.id,
        providerKind: provider.kind,
        transport: "streamable_http",
        command: existing?.command,
        args: existing?.args ?? [],
        url: entry.operationalUrl,
        envRefs: existing?.envRefs ?? {},
        headers: buildBailianMcpHeaders(provider.apiKeyRef),
        restartPolicy: existing?.restartPolicy ?? "on-failure",
        toolCache: existing?.toolCache ?? {},
        lastHealthStatus: existing?.lastHealthStatus ?? "unknown",
        lastHealthCheckedAt: existing?.lastHealthCheckedAt ?? null,
        enabled: existing?.enabled ?? true,
        source: "provider",
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      await state.repository.saveMcpServer(nextServer);
      await attachMcpServerToActiveProfile(nextServer.id);
      return nextServer;
    },
  );

  app.get("/api/mcp/servers", { preHandler: requireOwner }, async () => {
    return state.repository.listMcpServers();
  });

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
      providerId: body.providerId ?? existing?.providerId ?? null,
      providerKind: body.providerKind ?? existing?.providerKind ?? null,
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

  app.get(
    "/api/system/turns/:turnId/state",
    { preHandler: requireOwner },
    async (request, reply) => {
      const { turnId } = request.params as { turnId: string };
      const snapshot = await state.repository.getLatestTurnState(turnId);
      if (!snapshot) {
        return reply.code(404).send({ error: "Turn state not found" });
      }
      return snapshot;
    },
  );

  app.get(
    "/api/system/turns/:turnId/events",
    { preHandler: requireOwner },
    async (request) => {
      const { turnId } = request.params as { turnId: string };
      const query = request.query as {
        cursorSeq?: string | number;
        limit?: string | number;
      };
      const cursorSeq = query.cursorSeq === undefined
        ? undefined
        : Number(query.cursorSeq);
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      return state.repository.listTurnEvents(turnId, {
        ...(Number.isFinite(cursorSeq) ? { cursorSeq: Number(cursorSeq) } : {}),
        ...(Number.isFinite(limit) ? { limit: Number(limit) } : {}),
      });
    },
  );

  app.get("/api/system/health", { preHandler: requireOwner }, async (request) => {
    const jobs = await state.repository.listJobs();
    const providerTests = await state.repository.listProviderTestRuns({ limit: 20 });
    const mcpProviders = await state.repository.listMcpProviders();
    const mcpServers = await state.repository.listMcpServers();
    const workspace = await state.repository.getWorkspace();
    const providerProfiles = await state.repository.listProviderProfiles();
    const agentProfiles = await state.repository.listAgentProfiles();
    const allTurns = await state.repository.listConversationTurns({ limit: 200 });
    const runningTurns = allTurns.filter((turn) => turn.status === "running");
    const failedTurns = allTurns
      .filter((turn) => turn.status === "failed")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 5);
    const expectedWebhookUrl = resolveExpectedTelegramWebhookUrl(state.env, request);
    const webhookInfo = await readTelegramWebhookInfo();
    let runtimeDiagnostics: Record<string, unknown> | null = null;

    if (workspace?.activeAgentProfileId) {
      const activeProfile = agentProfiles.find((profile) =>
        profile.id === workspace.activeAgentProfileId
      );
      if (!activeProfile) {
        runtimeDiagnostics = {
          activeProfileId: workspace.activeAgentProfileId,
          error: "Active agent profile not found",
        };
      } else {
        try {
          const runtime = await state.resolveRuntime(activeProfile);
          const tools = await state.agent.previewTools({
            profile: activeProfile,
            context: {
              workspaceId: workspace.id,
              conversationId: "__system_health__",
              nowIso: nowIso(),
              timezone: workspace.timezone,
              profileId: activeProfile.id,
              searchSettings: runtime.searchSettings,
              runtime,
            },
          });
          runtimeDiagnostics = {
            activeProfile: {
              id: activeProfile.id,
              label: activeProfile.label,
              maxPlanningSteps: activeProfile.maxPlanningSteps,
              maxToolCalls: activeProfile.maxToolCalls,
              maxTurnDurationMs: activeProfile.maxTurnDurationMs,
              maxToolDurationMs: activeProfile.maxToolDurationMs,
              effectiveMaxTurnDurationMs: Math.max(activeProfile.maxTurnDurationMs, 60_000),
              effectiveMaxPlannerDurationMs: Math.min(
                Math.max(activeProfile.maxTurnDurationMs, 60_000),
                Math.max(activeProfile.maxToolDurationMs, 45_000),
              ),
              effectiveMaxToolDurationMs: Math.max(activeProfile.maxToolDurationMs, 30_000),
              allowNetworkTools: activeProfile.allowNetworkTools,
              allowWriteTools: activeProfile.allowWriteTools,
              allowMcpTools: activeProfile.allowMcpTools,
            },
            enabledSkills: runtime.enabledSkills,
            enabledPlugins: runtime.enabledPlugins,
            enabledMcpServers: runtime.enabledMcpServers,
            blocked: runtime.blocked,
            tools: tools.map((tool) => ({
              id: tool.id,
              title: tool.title,
              source: tool.source,
              permissionScopes: tool.permissionScopes,
            })),
            promptFragmentCount: runtime.promptFragments.length,
            searchSettings: runtime.searchSettings,
            generatedAt: runtime.generatedAt,
          };
        } catch (error) {
          runtimeDiagnostics = {
            activeProfile: {
              id: activeProfile.id,
              label: activeProfile.label,
            },
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

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
      hasWorkspace: Boolean(workspace),
      providerProfiles: providerProfiles.length,
      mcpProviders: mcpProviders.length,
      mcpServers: mcpServers.length,
      runtime: runtimeDiagnostics,
      activeTurnLocks: await state.listActiveConversationLocks(),
      graph: {
        enabled: true,
        runningTurns: runningTurns.length,
        resumableTurns: runningTurns.filter((turn) => turn.resumeEligible).length,
        stuckTurns: runningTurns.filter((turn) => !isIsoInFuture(turn.lockExpiresAt)).length,
        recentTurnFailures: failedTurns.map((turn) => ({
          turnId: turn.id,
          conversationId: turn.conversationId,
          error: turn.error,
          currentNode: turn.currentNode,
          updatedAt: turn.updatedAt,
        })),
      },
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
        mcpProviders: state.catalog.mcpProviders.length,
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

  app.post("/telegram/webhook", async (request, reply) => {
    const updateId = parseTelegramUpdateId(request.body);
    let claimed = false;

    if (updateId !== null) {
      try {
        const claimResult = await state.repository.claimTelegramUpdate(updateId, isoAfter(120_000));
        if (claimResult === "duplicate") {
          return reply.code(200).send({
            ok: true,
            ignored: true,
            reason: claimResult,
          });
        }
        if (claimResult === "in_progress") {
          return reply.code(200).send({
            ok: true,
            ignored: true,
            reason: claimResult,
          });
        }
        claimed = true;
      } catch (error) {
        logger.error({ error, updateId }, "Failed to claim Telegram update lock");
      }
    }

    try {
      await telegram.handler(request, reply);
      if (!claimed || updateId === null) {
        return;
      }

      try {
        await state.repository.completeTelegramUpdate(updateId);
      } catch (error) {
        logger.error(
          { error, updateId, statusCode: reply.statusCode },
          "Failed to finalize Telegram update receipt state",
        );
      }
    } catch (error) {
      if (claimed && updateId !== null) {
        try {
          await state.repository.completeTelegramUpdate(updateId);
        } catch (releaseError) {
          logger.warn(
            { error: releaseError, updateId },
            "Failed to complete Telegram update receipt after handler failure",
          );
        }
      }
      throw error;
    }
  });

  return app;
}
