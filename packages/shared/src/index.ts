import { z } from "zod";

export const ProviderKindSchema = z.enum([
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "bailian",
  "openai_compatible_chat",
  "openai_compatible_responses",
]);

export const ReasoningLevelSchema = z.enum(["off", "low", "medium", "high"]);
export const MarketKindSchema = z.enum(["skills", "plugins", "mcp"]);
export const RuntimeKindSchema = z.enum([
  "internal",
  "http",
  "binary",
  "mcp-stdio",
  "mcp-streamable-http",
]);
export const McpTransportSchema = z.enum(["stdio", "streamable_http"]);
export const SearchProviderKindSchema = z.enum([
  "google_native",
  "bing_native",
  "exa_mcp",
  "web_browse",
]);
export const ProviderTestCapabilitySchema = z.enum([
  "text",
  "vision",
  "audio",
  "document",
]);
export const MessageSourceTypeSchema = z.enum([
  "text",
  "voice",
  "image",
  "document",
  "audio",
  "system",
  "tool",
]);

export type LooseJsonValue =
  | null
  | boolean
  | number
  | string
  | LooseJsonValue[]
  | { [key: string]: LooseJsonValue };

const JsonValueSchema: z.ZodType<LooseJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const LooseRecordSchema = z.record(JsonValueSchema);

export const CloudflareCredentialsSchema = z
  .object({
    accountId: z.string().min(1),
    apiToken: z.string().min(1).optional(),
    globalApiKey: z.string().min(1).optional(),
    email: z.string().email().optional(),
    r2AccessKeyId: z.string().min(1).optional(),
    r2SecretAccessKey: z.string().min(1).optional(),
    d1DatabaseId: z.string().min(1).optional(),
    r2BucketName: z.string().min(1).optional(),
    vectorizeIndexName: z.string().min(1).optional(),
    aiSearchIndexName: z.string().min(1).optional(),
    vectorizeDimensions: z.number().int().positive().default(256),
  })
  .superRefine((value, ctx) => {
    const hasApiToken = Boolean(value.apiToken);
    const hasGlobalAuth = Boolean(value.globalApiKey && value.email);

    if (!hasApiToken && !hasGlobalAuth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide apiToken or globalApiKey + email",
      });
    }
  });

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  timezone: z.string().min(1).default("UTC"),
  ownerTelegramUserId: z.string().nullable().default(null),
  ownerTelegramUsername: z.string().nullable().default(null),
  primaryModelProfileId: z.string().nullable().default(null),
  backgroundModelProfileId: z.string().nullable().default(null),
  activeAgentProfileId: z.string().nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const BootstrapStateSchema = z.object({
  verified: z.boolean().default(false),
  ownerBound: z.boolean().default(false),
  cloudflareConnected: z.boolean().default(false),
  resourcesInitialized: z.boolean().default(false),
});

export const AdminIdentitySchema = z.object({
  workspaceId: z.string().min(1),
  telegramUserId: z.string().min(1),
  telegramUsername: z.string().nullable().default(null),
  role: z.literal("owner").default("owner"),
  boundAt: z.string().min(1),
  lastVerifiedAt: z.string().min(1),
});

export const AuthSessionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  telegramUserId: z.string().min(1),
  jwtJti: z.string().min(1),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  revokedAt: z.string().nullable().default(null),
});

export const SecretEnvelopeSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  scope: z.string().min(1),
  cipherText: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  keyVersion: z.number().int().positive().default(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const ProviderProfileSchema = z.object({
  id: z.string().min(1),
  kind: ProviderKindSchema,
  label: z.string().min(1),
  apiBaseUrl: z.string().url().or(z.literal("")),
  apiKeyRef: z.string().min(1),
  defaultModel: z.string().min(1),
  visionModel: z.string().min(1).nullable().default(null),
  audioModel: z.string().min(1).nullable().default(null),
  documentModel: z.string().min(1).nullable().default(null),
  stream: z.boolean().default(true),
  reasoningEnabled: z.boolean().default(false),
  reasoningLevel: ReasoningLevelSchema.default("off"),
  thinkingBudget: z.number().int().positive().nullable().default(null),
  temperature: z.number().min(0).max(2).default(0.2),
  topP: z.number().min(0).max(1).nullable().default(null),
  maxOutputTokens: z.number().int().positive().default(2048),
  toolCallingEnabled: z.boolean().default(true),
  jsonModeEnabled: z.boolean().default(true),
  visionEnabled: z.boolean().default(false),
  audioInputEnabled: z.boolean().default(false),
  documentInputEnabled: z.boolean().default(false),
  headers: z.record(z.string()).default({}),
  extraBody: LooseRecordSchema.default({}),
  enabled: z.boolean().default(true),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const AgentProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  systemPrompt: z.string().min(1),
  primaryModelProfileId: z.string().min(1),
  backgroundModelProfileId: z.string().nullable().default(null),
  embeddingModelProfileId: z.string().nullable().default(null),
  enabledSkillIds: z.array(z.string()).default([]),
  enabledPluginIds: z.array(z.string()).default([]),
  enabledMcpServerIds: z.array(z.string()).default([]),
  maxPlanningSteps: z.number().int().positive().default(8),
  maxToolCalls: z.number().int().positive().default(6),
  maxTurnDurationMs: z.number().int().positive().default(30_000),
  maxToolDurationMs: z.number().int().positive().default(15_000),
  compactSoftThreshold: z.number().min(0).max(1).default(0.7),
  compactHardThreshold: z.number().min(0).max(1).default(0.85),
  allowNetworkTools: z.boolean().default(true),
  allowWriteTools: z.boolean().default(true),
  allowMcpTools: z.boolean().default(true),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const InstallRecordSchema = z.object({
  id: z.string().min(1),
  manifestId: z.string().min(1),
  kind: MarketKindSchema,
  enabled: z.boolean().default(false),
  config: LooseRecordSchema.default({}),
  installedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const SearchSettingsSchema = z.object({
  id: z.string().min(1).default("main"),
  providerPriority: z.array(SearchProviderKindSchema).default([
    "google_native",
    "bing_native",
    "exa_mcp",
    "web_browse",
  ]),
  allowNetwork: z.boolean().default(true),
  fallbackStrategy: z.enum(["exa_then_browse", "browse_only"]).default(
    "exa_then_browse",
  ),
  maxResults: z.number().int().positive().default(5),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const McpServerConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  manifestId: z.string().nullable().default(null),
  transport: McpTransportSchema,
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().url().optional(),
  envRefs: z.record(z.string()).default({}),
  headers: z.record(z.string()).default({}),
  restartPolicy: z.enum(["never", "on-failure", "always"]).default("on-failure"),
  toolCache: LooseRecordSchema.default({}),
  lastHealthStatus: z.enum(["unknown", "ok", "error"]).default("unknown"),
  lastHealthCheckedAt: z.string().nullable().default(null),
  enabled: z.boolean().default(false),
  source: z.enum(["official", "custom"]).default("custom"),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const MarketManifestBaseSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().optional(),
  tags: z.array(z.string()).default([]),
  configSchema: LooseRecordSchema.default({}),
  permissions: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
});

export const SkillManifestSchema = MarketManifestBaseSchema.extend({
  kind: z.literal("skill"),
  promptFragments: z.array(z.string()).default([]),
  toolBindings: z.array(z.string()).default([]),
  enabledByDefault: z.boolean().default(false),
});

export const PluginManifestSchema = MarketManifestBaseSchema.extend({
  kind: z.literal("plugin"),
  runtimeKind: RuntimeKindSchema,
  entrypoint: z.string().min(1),
  healthcheck: z.string().optional(),
});

export const McpManifestSchema = MarketManifestBaseSchema.extend({
  kind: z.literal("mcp"),
  transport: McpTransportSchema,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  envTemplate: z.record(z.string()).optional(),
});

export const ToolDescriptorSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  inputSchema: LooseRecordSchema.default({}),
  permissionScopes: z.array(z.string()).default([]),
  source: z.enum(["plugin", "mcp", "builtin"]),
});

export const PlannerActionSchema = z.union([
  z.object({
    type: z.literal("final_response"),
    content: z.string().min(1),
  }),
  z.object({
    type: z.literal("call_tool"),
    toolId: z.string().min(1),
    input: LooseRecordSchema.default({}),
  }),
  z.object({
    type: z.literal("write_memory"),
    target: z.enum(["daily", "longterm"]),
    content: z.string().min(1),
  }),
  z.object({
    type: z.literal("compact_now"),
  }),
  z.object({
    type: z.literal("abort"),
    reason: z.string().min(1),
  }),
]);

export const ConversationRecordSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  telegramChatId: z.string().min(1),
  telegramUserId: z.string().min(1),
  mode: z.literal("private").default("private"),
  activeTurnLock: z.boolean().default(false),
  activeTurnLockExpiresAt: z.string().nullable().default(null),
  lastTurnId: z.string().nullable().default(null),
  lastCompactedAt: z.string().nullable().default(null),
  lastSummaryId: z.string().nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const MessageRecordSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: z.enum(["user", "assistant", "tool", "system"]),
  content: z.string().min(1),
  sourceType: MessageSourceTypeSchema.default("text"),
  telegramMessageId: z.string().nullable().default(null),
  metadata: LooseRecordSchema.default({}),
  createdAt: z.string().min(1),
});

export const ToolRunRecordSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  turnId: z.string().min(1),
  toolId: z.string().min(1),
  toolSource: z.enum(["plugin", "mcp", "builtin"]),
  input: LooseRecordSchema.default({}),
  output: JsonValueSchema,
  status: z.enum(["pending", "completed", "failed"]),
  durationMs: z.number().int().nonnegative().default(0),
  createdAt: z.string().min(1),
});

export const ConversationSummarySchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  content: z.string().min(1),
  createdAt: z.string().min(1),
});

export const ConversationTurnSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  profileId: z.string().min(1),
  status: z.enum(["running", "completed", "failed", "aborted"]),
  stepCount: z.number().int().nonnegative().default(0),
  toolCallCount: z.number().int().nonnegative().default(0),
  compacted: z.boolean().default(false),
  summaryId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  startedAt: z.string().min(1),
  finishedAt: z.string().nullable().default(null),
  lockExpiresAt: z.string().nullable().default(null),
  updatedAt: z.string().min(1),
});

export const DocumentMetadataSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  sourceType: z.enum(["telegram", "upload", "import"]),
  kind: z.enum(["text", "pdf", "docx", "csv", "json", "binary"]),
  title: z.string().min(1),
  path: z.string().min(1),
  derivedTextPath: z.string().nullable().default(null),
  sourceObjectKey: z.string().nullable().default(null),
  derivedTextObjectKey: z.string().nullable().default(null),
  previewText: z.string().nullable().default(null),
  fileId: z.string().nullable().default(null),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  mimeType: z.string().nullable().default(null),
  extractionStatus: z
    .enum(["pending", "processing", "completed", "failed"])
    .default("pending"),
  extractionProviderProfileId: z.string().nullable().default(null),
  lastExtractionError: z.string().nullable().default(null),
  lastIndexedAt: z.string().nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const DocumentArtifactSchema = z.object({
  documentId: z.string().min(1).nullable().default(null),
  path: z.string().min(1),
  contentBase64: z.string().min(1),
  contentType: z.string().nullable().default(null),
});

export const MemoryDocumentSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: z.enum(["daily", "longterm", "document", "summary"]),
  path: z.string().min(1),
  title: z.string().min(1),
  content: z.string().optional(),
  contentHash: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const MemoryChunkSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  documentId: z.string().min(1),
  vectorId: z.string().min(1),
  content: z.string().min(1),
  tokenEstimate: z.number().int().positive(),
  metadata: LooseRecordSchema.default({}),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const JobRecordSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: z.enum([
    "memory_reindex_document",
    "memory_reindex_all",
    "memory_refresh_before_compact",
    "document_extract",
    "telegram_file_fetch",
    "telegram_voice_transcribe",
    "telegram_image_describe",
    "mcp_healthcheck",
    "export_bundle_build",
  ]),
  status: z.enum(["pending", "running", "completed", "failed"]),
  payload: LooseRecordSchema.default({}),
  result: LooseRecordSchema.default({}),
  error: z.string().optional(),
  attempts: z.number().int().nonnegative().default(0),
  runAfter: z.string().nullable().default(null),
  lockedAt: z.string().nullable().default(null),
  lockedBy: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const ProviderTestRunResultSchema = z.object({
  capability: ProviderTestCapabilitySchema,
  status: z.enum(["ok", "failed", "skipped", "unsupported"]),
  outputPreview: z.string().optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
});

export const ProviderTestRunSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  providerId: z.string().min(1),
  providerKind: ProviderKindSchema,
  requestedCapabilities: z.array(ProviderTestCapabilitySchema).default([]),
  results: z.array(ProviderTestRunResultSchema).default([]),
  ok: z.boolean().default(false),
  createdAt: z.string().min(1),
});

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  actorTelegramUserId: z.string().min(1),
  eventType: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  detail: LooseRecordSchema.default({}),
  createdAt: z.string().min(1),
});

export const ImportExportRunSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  type: z.enum(["import", "export"]),
  status: z.enum(["pending", "running", "completed", "failed"]),
  operatorTelegramUserId: z.string().min(1),
  artifactPath: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const TelegramInboundContentSchema = z.object({
  kind: z.enum(["text", "voice", "image", "document", "audio"]),
  text: z.string().optional(),
  fileId: z.string().optional(),
  mimeType: z.string().optional(),
  caption: z.string().optional(),
  metadata: LooseRecordSchema.default({}),
});

export const WorkspaceExportBundleSchema = z.object({
  version: z.string().min(1),
  workspace: WorkspaceSchema,
  providers: z.array(ProviderProfileSchema),
  profiles: z.array(AgentProfileSchema),
  skillInstalls: z.array(InstallRecordSchema).default([]),
  pluginInstalls: z.array(InstallRecordSchema).default([]),
  mcpInstalls: z.array(InstallRecordSchema).default([]),
  installs: z.array(InstallRecordSchema).default([]),
  mcpServers: z.array(McpServerConfigSchema),
  searchSettings: SearchSettingsSchema.optional(),
  documents: z.array(DocumentMetadataSchema).default([]),
  documentArtifacts: z.array(DocumentArtifactSchema).default([]),
  memories: z.array(MemoryDocumentSchema),
  encryptedSecrets: z.array(SecretEnvelopeSchema),
});

export const RuntimeResolvedItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["skill", "plugin", "mcp"]),
  source: z.enum(["market", "server"]),
  installId: z.string().nullable().default(null),
  manifestId: z.string().nullable().default(null),
});

export const RuntimeBlockedReasonSchema = z.object({
  scope: z.enum(["skill", "plugin", "mcp", "tool", "profile"]),
  id: z.string().min(1),
  reason: z.string().min(1),
});

export const ResolvedMcpServerSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  transport: McpTransportSchema,
  source: z.enum(["official", "custom"]),
  manifestId: z.string().nullable().default(null),
});

export const ResolvedRuntimeSnapshotSchema = z.object({
  workspaceId: z.string().min(1),
  agentProfileId: z.string().min(1),
  promptFragments: z.array(z.string()).default([]),
  enabledSkills: z.array(RuntimeResolvedItemSchema).default([]),
  enabledPlugins: z.array(RuntimeResolvedItemSchema).default([]),
  enabledMcpServers: z.array(ResolvedMcpServerSchema).default([]),
  tools: z.array(ToolDescriptorSchema).default([]),
  blocked: z.array(RuntimeBlockedReasonSchema).default([]),
  searchSettings: SearchSettingsSchema,
  generatedAt: z.string().min(1),
});

export type ProviderKind = z.infer<typeof ProviderKindSchema>;
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;
export type ProviderTestCapability = z.infer<typeof ProviderTestCapabilitySchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type BootstrapState = z.infer<typeof BootstrapStateSchema>;
export type AdminIdentity = z.infer<typeof AdminIdentitySchema>;
export type AuthSession = z.infer<typeof AuthSessionSchema>;
export type SecretEnvelope = z.infer<typeof SecretEnvelopeSchema>;
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type InstallRecord = z.infer<typeof InstallRecordSchema>;
export type SearchSettings = z.infer<typeof SearchSettingsSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type McpManifest = z.infer<typeof McpManifestSchema>;
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;
export type PlannerAction = z.infer<typeof PlannerActionSchema>;
export type ConversationRecord = z.infer<typeof ConversationRecordSchema>;
export type MessageRecord = z.infer<typeof MessageRecordSchema>;
export type ToolRunRecord = z.infer<typeof ToolRunRecordSchema>;
export type CloudflareCredentials = z.infer<typeof CloudflareCredentialsSchema>;
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;
export type DocumentArtifact = z.infer<typeof DocumentArtifactSchema>;
export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>;
export type MemoryChunk = z.infer<typeof MemoryChunkSchema>;
export type JobRecord = z.infer<typeof JobRecordSchema>;
export type ProviderTestRunResult = z.infer<typeof ProviderTestRunResultSchema>;
export type ProviderTestRun = z.infer<typeof ProviderTestRunSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type ImportExportRun = z.infer<typeof ImportExportRunSchema>;
export type TelegramInboundContent = z.infer<typeof TelegramInboundContentSchema>;
export type WorkspaceExportBundle = z.infer<typeof WorkspaceExportBundleSchema>;
export type RuntimeResolvedItem = z.infer<typeof RuntimeResolvedItemSchema>;
export type RuntimeBlockedReason = z.infer<typeof RuntimeBlockedReasonSchema>;
export type ResolvedMcpServer = z.infer<typeof ResolvedMcpServerSchema>;
export type ResolvedRuntimeSnapshot = z.infer<typeof ResolvedRuntimeSnapshotSchema>;

export type AnyMarketManifest =
  | SkillManifest
  | PluginManifest
  | McpManifest;
