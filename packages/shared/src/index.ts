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

export const ReasoningLevelSchema = z.preprocess(
  (value) => typeof value === "string" ? value.toLowerCase() : value,
  z.enum(["off", "low", "medium", "high"]),
);
export const MarketKindSchema = z.enum(["skills", "plugins", "mcp"]);
export const McpProviderKindSchema = z.enum(["bailian"]);
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
export const WorkflowTemplateKindSchema = z.enum([
  "web_watch_report",
  "browser_workflow",
  "document_digest_memory",
  "telegram_followup",
  "webhook_fetch_analyze_push",
]);
export const TaskStatusSchema = z.enum(["draft", "active", "paused", "archived"]);
export const TaskTriggerKindSchema = z.enum([
  "manual",
  "schedule",
  "webhook",
  "telegram_shortcut",
]);
export const TaskRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "waiting_retry",
  "completed",
  "failed",
  "aborted",
]);
export const ApprovalPolicySchema = z.enum([
  "auto_approve_safe",
  "approval_required",
  "approval_for_write",
]);
export const WorkflowApprovalCheckpointSchema = z.enum([
  "before_executor",
  "before_memory_writeback",
  "before_telegram_push",
  "before_fs_write",
  "before_shell",
]);
export const MemoryPolicySchema = z.enum([
  "chat_only",
  "task_context",
  "task_context_writeback",
]);
export const ApprovalRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);
export const ExecutorKindSchema = z.enum([
  "companion",
  "chrome_extension",
  "cloud_browser",
]);
export const ExecutorStatusSchema = z.enum([
  "offline",
  "pending_pairing",
  "online",
]);
export const ExecutorCapabilitySchema = z.enum([
  "browser",
  "http",
  "fs",
  "shell",
]);
export const TurnApprovalStateSchema = z.enum([
  "none",
  "pending",
  "approved",
  "rejected",
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

export const TelegramLoginReceiptSchema = z.object({
  id: z.string().min(1),
  receiptKey: z.string().min(1),
  telegramUserId: z.string().min(1),
  expiresAt: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
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

export const WorkflowBudgetSchema = z.object({
  maxSteps: z.number().int().positive().default(8),
  maxActions: z.number().int().positive().default(6),
  timeoutMs: z.number().int().positive().default(60_000),
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
  maxTurnDurationMs: z.number().int().positive().default(60_000),
  maxToolDurationMs: z.number().int().positive().default(30_000),
  compactSoftThreshold: z.number().min(0).max(1).default(0.7),
  compactHardThreshold: z.number().min(0).max(1).default(0.85),
  allowNetworkTools: z.boolean().default(true),
  allowWriteTools: z.boolean().default(true),
  allowMcpTools: z.boolean().default(true),
  defaultExecutorId: z.string().nullable().default(null),
  approvalPolicy: ApprovalPolicySchema.default("auto_approve_safe"),
  defaultMemoryPolicy: MemoryPolicySchema.default("chat_only"),
  defaultWorkflowBudget: WorkflowBudgetSchema.default({
    maxSteps: 8,
    maxActions: 6,
    timeoutMs: 60_000,
  }),
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

export const McpProviderCatalogServerSchema = z.object({
  remoteId: z.string().min(1),
  serverId: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  operationalUrl: z.string().url(),
  protocol: z.enum(["streamable_http", "sse", "unknown"]).default("streamable_http"),
  active: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  logoUrl: z.string().nullable().default(null),
  provider: z.string().nullable().default(null),
  providerUrl: z.string().nullable().default(null),
  fetchedAt: z.string().min(1),
});

export const McpProviderConfigSchema = z.object({
  id: z.string().min(1),
  kind: McpProviderKindSchema,
  label: z.string().min(1),
  apiKeyRef: z.string().min(1),
  enabled: z.boolean().default(true),
  catalogCache: z.array(McpProviderCatalogServerSchema).default([]),
  lastFetchedAt: z.string().nullable().default(null),
  lastFetchStatus: z.enum(["idle", "ok", "error"]).default("idle"),
  lastFetchError: z.string().nullable().default(null),
  createdAt: z.string().min(1),
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

export const ExecutorScopeSchema = z.object({
  allowedHosts: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  allowedCommands: z.array(z.string()).default([]),
  fsRequiresApproval: z.boolean().default(true),
  shellRequiresApproval: z.boolean().default(true),
});

export const BrowserAttachmentStateSchema = z.enum(["detached", "attached"]);
export const BrowserAttachmentModeSchema = z.enum(["single_window"]);

export const BrowserAttachmentSchema = z.object({
  state: BrowserAttachmentStateSchema.default("detached"),
  mode: BrowserAttachmentModeSchema.default("single_window"),
  windowId: z.number().int().nullable().default(null),
  tabId: z.number().int().nullable().default(null),
  url: z.string().nullable().default(null),
  origin: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  attachedAt: z.string().nullable().default(null),
  detachedAt: z.string().nullable().default(null),
  lastSnapshotAt: z.string().nullable().default(null),
  extensionInstanceId: z.string().nullable().default(null),
  browserName: z.string().nullable().default(null),
  browserVersion: z.string().nullable().default(null),
  profileLabel: z.string().nullable().default(null),
});

export const ExecutorNodeSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  label: z.string().min(1),
  kind: ExecutorKindSchema.default("companion"),
  status: ExecutorStatusSchema.default("offline"),
  version: z.string().nullable().default(null),
  platform: z.string().nullable().default(null),
  capabilities: z.array(ExecutorCapabilitySchema).default([]),
  scopes: ExecutorScopeSchema.default({
    allowedHosts: [],
    allowedPaths: [],
    allowedCommands: [],
    fsRequiresApproval: true,
    shellRequiresApproval: true,
  }),
  metadata: LooseRecordSchema.default({}),
  browserAttachment: BrowserAttachmentSchema.default({
    state: "detached",
    mode: "single_window",
    windowId: null,
    tabId: null,
    url: null,
    origin: null,
    title: null,
    attachedAt: null,
    detachedAt: null,
    lastSnapshotAt: null,
    extensionInstanceId: null,
    browserName: null,
    browserVersion: null,
    profileLabel: null,
  }),
  pairingCodeHash: z.string().nullable().default(null),
  executorTokenHash: z.string().nullable().default(null),
  pairingIssuedAt: z.string().nullable().default(null),
  pairedAt: z.string().nullable().default(null),
  lastHeartbeatAt: z.string().nullable().default(null),
  lastSeenAt: z.string().nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const TaskSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  description: z.string().default(""),
  config: LooseRecordSchema.default({}),
  templateKind: WorkflowTemplateKindSchema,
  status: TaskStatusSchema.default("draft"),
  agentProfileId: z.string().nullable().default(null),
  defaultExecutorId: z.string().nullable().default(null),
  approvalPolicy: ApprovalPolicySchema.default("auto_approve_safe"),
  approvalCheckpoints: z.array(WorkflowApprovalCheckpointSchema).default([
    "before_executor",
  ]),
  memoryPolicy: MemoryPolicySchema.default("chat_only"),
  defaultRunBudget: WorkflowBudgetSchema.default({
    maxSteps: 8,
    maxActions: 6,
    timeoutMs: 60_000,
  }),
  triggerIds: z.array(z.string()).default([]),
  relatedDocumentIds: z.array(z.string()).default([]),
  relatedThreadIds: z.array(z.number().int()).default([]),
  latestRunId: z.string().nullable().default(null),
  lastRunAt: z.string().nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const TriggerSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  taskId: z.string().nullable().default(null),
  label: z.string().min(1),
  kind: TaskTriggerKindSchema,
  enabled: z.boolean().default(true),
  config: LooseRecordSchema.default({}),
  webhookPath: z.string().nullable().default(null),
  webhookSecret: z.string().nullable().default(null),
  webhookSecretRef: z.string().nullable().default(null),
  nextRunAt: z.string().nullable().default(null),
  lastTriggeredAt: z.string().nullable().default(null),
  lastRunId: z.string().nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const McpServerConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  manifestId: z.string().nullable().default(null),
  providerId: z.string().nullable().optional(),
  providerKind: McpProviderKindSchema.nullable().optional(),
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
  source: z.enum(["official", "custom", "provider", "bailian_market"]).default("custom"),
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

export const McpProviderManifestSchema = z.object({
  id: z.string().min(1),
  providerKind: McpProviderKindSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().optional(),
  tags: z.array(z.string()).default([]),
  authMode: z.enum(["api_key"]).default("api_key"),
  apiBaseUrl: z.string().url().or(z.literal("")),
});

export const ToolDescriptorSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  inputSchema: LooseRecordSchema.default({}),
  permissionScopes: z.array(z.string()).default([]),
  source: z.enum(["plugin", "mcp", "builtin"]),
});

export const AgentSpecialistKindSchema = z.enum([
  "research",
  "memory",
  "document",
]);
export const AgentSubgraphSchema = z.enum([
  "main",
  "research",
  "memory",
  "document",
]);

export const AgentActionSchema = z.union([
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
    type: z.literal("delegate_specialist"),
    specialist: AgentSpecialistKindSchema,
    goal: z.string().min(1),
    input: LooseRecordSchema.default({}),
  }),
  z.object({
    type: z.literal("abort"),
    reason: z.string().min(1),
  }),
]);

export const PlannerActionSchema = AgentActionSchema;

export const AgentScratchpadEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "observation",
    "tool_result",
    "memory_result",
    "specialist_result",
    "summary",
    "decision",
  ]),
  nodeId: z.string().min(1),
  subgraph: AgentSubgraphSchema,
  text: z.string().min(1),
  createdAt: z.string().min(1),
});

export const AgentSubgraphFrameSchema = z.object({
  id: z.string().min(1),
  kind: AgentSpecialistKindSchema,
  entryNode: z.string().min(1),
  returnNode: z.string().min(1),
  goal: z.string().min(1),
  status: z.enum(["running", "succeeded", "failed"]),
  startedAt: z.string().min(1),
  finishedAt: z.string().nullable().default(null),
});

export const AgentToolLedgerSchema = z.object({
  callId: z.string().min(1),
  toolId: z.string().min(1),
  subgraph: AgentSubgraphSchema,
  input: LooseRecordSchema.default({}),
  output: JsonValueSchema.nullable().default(null),
  status: z.enum(["pending", "completed", "failed"]),
  idempotencyKey: z.string().min(1),
  attempt: z.number().int().positive().default(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});

export const AgentMemoryLedgerSchema = z.object({
  id: z.string().min(1),
  target: z.enum(["daily", "longterm", "summary"]),
  content: z.string().min(1),
  status: z.enum(["pending", "completed", "failed"]),
  startedAt: z.string().min(1),
  finishedAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});

export const AgentGraphStateSchema = z.object({
  version: z.literal("v2"),
  status: z.enum(["idle", "running", "paused", "succeeded", "failed", "aborted"]),
  currentNode: z.string().nullable().default(null),
  currentSubgraph: AgentSubgraphSchema.nullable().default(null),
  iteration: z.number().int().nonnegative().default(0),
  plannerMode: z.enum(["native_tools", "json_action"]).nullable().default(null),
  lastAction: AgentActionSchema.nullable().default(null),
  pendingActions: z.array(AgentActionSchema).default([]),
  scratchpad: z.array(AgentScratchpadEntrySchema).default([]),
  subgraphStack: z.array(AgentSubgraphFrameSchema).default([]),
  toolLedger: z.array(AgentToolLedgerSchema).default([]),
  memoryLedger: z.array(AgentMemoryLedgerSchema).default([]),
  summary: z.object({
    existing: z.string().default(""),
    working: z.string().default(""),
    refreshedAt: z.string().nullable().default(null),
  }),
  reply: z.object({
    draft: z.string().default(""),
    final: z.string().default(""),
    streamedChars: z.number().int().nonnegative().default(0),
  }),
  counters: z.object({
    planningStepsUsed: z.number().int().nonnegative().default(0),
    toolCallsUsed: z.number().int().nonnegative().default(0),
    specialistCallsUsed: z.number().int().nonnegative().default(0),
    consecutiveNoopPlans: z.number().int().nonnegative().default(0),
  }),
  flags: z.object({
    needsCompaction: z.boolean().default(false),
    summaryDirty: z.boolean().default(false),
    finalReplyReady: z.boolean().default(false),
  }),
  checkpoints: z.object({
    lastPlannerAt: z.string().nullable().default(null),
    lastToolAt: z.string().nullable().default(null),
    lastSpecialistAt: z.string().nullable().default(null),
  }),
});

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
  graphVersion: z.string().nullable().default(null),
  stateSnapshotId: z.string().nullable().default(null),
  lastEventSeq: z.number().int().nonnegative().default(0),
  currentNode: z.string().nullable().default(null),
  resumeEligible: z.boolean().default(false),
  taskRunId: z.string().nullable().default(null),
  triggerType: TaskTriggerKindSchema.nullable().default(null),
  executorId: z.string().nullable().default(null),
  approvalState: TurnApprovalStateSchema.default("none"),
  startedAt: z.string().min(1),
  finishedAt: z.string().nullable().default(null),
  lockExpiresAt: z.string().nullable().default(null),
  updatedAt: z.string().min(1),
});

const TurnToolResultSchema = z.object({
  callId: z.string().min(1),
  toolId: z.string().min(1),
  source: z.enum(["plugin", "mcp", "builtin"]),
  input: LooseRecordSchema.default({}),
  output: JsonValueSchema,
  status: z.enum(["pending", "completed", "failed"]),
  idempotencyKey: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});

const TurnErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  nodeId: z.string().min(1).nullable().default(null),
  retryable: z.boolean().default(false),
  raw: LooseRecordSchema.default({}),
});

export const TurnStateSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  graphVersion: z.enum(["v1", "v2"]).default("v2"),
  status: z.enum(["running", "waiting_retry", "succeeded", "failed", "aborted"]),
  currentNode: z.string().min(1),
  taskRunId: z.string().nullable().default(null),
  triggerType: TaskTriggerKindSchema.nullable().default(null),
  executorId: z.string().nullable().default(null),
  approvalState: TurnApprovalStateSchema.default("none"),
  version: z.number().int().nonnegative().default(0),
  input: z.object({
    updateId: z.number().int().nullable().default(null),
    chatId: z.number().int(),
    threadId: z.number().int().nullable().default(null),
    userId: z.number().int(),
    username: z.string().nullable().default(null),
    messageId: z.number().int().nullable().default(null),
    contentKind: z.enum(["text", "voice", "image", "document", "audio"]),
    normalizedText: z.string().default(""),
    rawMetadata: LooseRecordSchema.default({}),
  }),
  context: z.object({
    profileId: z.string().min(1).nullable().default(null),
    timezone: z.string().min(1),
    nowIso: z.string().min(1),
    runtimeSnapshot: LooseRecordSchema.default({}),
    searchSettings: SearchSettingsSchema.nullable().default(null),
    historyWindow: z.number().int().nonnegative().default(0),
    summaryCursor: z.string().nullable().default(null),
  }),
  budgets: z.object({
    maxPlanningSteps: z.number().int().positive().default(1),
    maxToolCalls: z.number().int().positive().default(1),
    maxTurnDurationMs: z.number().int().positive().default(1),
    stepsUsed: z.number().int().nonnegative().default(0),
    toolCallsUsed: z.number().int().nonnegative().default(0),
    deadlineAt: z.string().min(1),
  }),
  agent: AgentGraphStateSchema.default({
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
  }),
  toolResults: z.array(TurnToolResultSchema).default([]),
  output: z.object({
    replyText: z.string().default(""),
    telegramReplyMessageId: z.string().nullable().default(null),
    streamingEnabled: z.boolean().default(false),
    lastRenderedChars: z.number().int().nonnegative().default(0),
  }),
  error: TurnErrorSchema.nullable().default(null),
  recovery: z.object({
    resumeEligible: z.boolean().default(true),
    resumeCount: z.number().int().nonnegative().default(0),
    lastRecoveredAt: z.string().nullable().default(null),
  }),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const TurnEventTypeSchema = z.enum([
  "turn_started",
  "node_started",
  "node_succeeded",
  "node_failed",
  "agent_node_started",
  "agent_node_succeeded",
  "agent_node_failed",
  "agent_subgraph_entered",
  "agent_subgraph_exited",
  "agent_action_planned",
  "tool_started",
  "tool_succeeded",
  "tool_failed",
  "turn_succeeded",
  "turn_failed",
  "turn_recovered",
  "task_run_queued",
  "task_run_started",
  "task_run_waiting_approval",
  "task_run_waiting_retry",
  "task_run_completed",
  "task_run_failed",
  "trigger_fired",
  "approval_requested",
  "approval_resolved",
  "executor_paired",
  "executor_heartbeat",
  "executor_log",
]);

export const TurnEventSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  nodeId: z.string().min(1),
  eventType: TurnEventTypeSchema,
  attempt: z.number().int().positive().default(1),
  payload: LooseRecordSchema.default({}),
  occurredAt: z.string().min(1),
});

export const TaskRunArtifactSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["text", "json", "url", "screenshot", "file"]),
  content: JsonValueSchema.nullable().default(null),
  createdAt: z.string().min(1),
});

export const TaskRunSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  taskId: z.string().nullable().default(null),
  templateKind: WorkflowTemplateKindSchema,
  status: TaskRunStatusSchema,
  triggerType: TaskTriggerKindSchema,
  triggerId: z.string().nullable().default(null),
  executorId: z.string().nullable().default(null),
  approvalId: z.string().nullable().default(null),
  sourceTurnId: z.string().nullable().default(null),
  sessionId: z.string().min(1),
  inputSnapshot: LooseRecordSchema.default({}),
  executionPlan: LooseRecordSchema.default({}),
  outputSummary: z.string().nullable().default(null),
  artifacts: z.array(TaskRunArtifactSchema).default([]),
  relatedDocumentIds: z.array(z.string()).default([]),
  relatedMemoryDocumentIds: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
});

export const ApprovalRequestSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  taskId: z.string().nullable().default(null),
  taskRunId: z.string().min(1),
  executorId: z.string().nullable().default(null),
  status: ApprovalRequestStatusSchema.default("pending"),
  reason: z.string().min(1),
  requestedCapabilities: z.array(ExecutorCapabilitySchema).default([]),
  requestedScopes: LooseRecordSchema.default({}),
  decisionNote: z.string().nullable().default(null),
  requestedAt: z.string().min(1),
  decidedAt: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
  createdAt: z.string().min(1),
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
  extractionMethod: z
    .enum([
      "decode_text",
      "fallback_text",
      "provider_vision",
      "provider_audio",
      "provider_document",
      "pdf_parse",
      "docx_mammoth",
    ])
    .nullable()
    .default(null),
  extractionProviderProfileId: z.string().nullable().default(null),
  lastExtractionError: z.string().nullable().default(null),
  lastExtractedAt: z.string().nullable().default(null),
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
  mcpProviders: z.array(McpProviderConfigSchema).default([]),
  mcpServers: z.array(McpServerConfigSchema),
  searchSettings: SearchSettingsSchema.optional(),
  tasks: z.array(TaskSchema).default([]),
  taskRuns: z.array(TaskRunSchema).default([]),
  triggers: z.array(TriggerSchema).default([]),
  approvals: z.array(ApprovalRequestSchema).default([]),
  executors: z.array(ExecutorNodeSchema).default([]),
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
  source: z.enum(["official", "custom", "provider", "bailian_market"]),
  manifestId: z.string().nullable().default(null),
});

export const ResolvedRuntimeSnapshotSchema = z.object({
  workspaceId: z.string().min(1),
  agentProfileId: z.string().min(1),
  promptFragments: z.array(z.string()).default([]),
  allowedToolIds: z.array(z.string()).default([]),
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
export type WorkflowTemplateKind = z.infer<typeof WorkflowTemplateKindSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskTriggerKind = z.infer<typeof TaskTriggerKindSchema>;
export type TaskRunStatus = z.infer<typeof TaskRunStatusSchema>;
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export type WorkflowApprovalCheckpoint = z.infer<typeof WorkflowApprovalCheckpointSchema>;
export type MemoryPolicy = z.infer<typeof MemoryPolicySchema>;
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;
export type ExecutorKind = z.infer<typeof ExecutorKindSchema>;
export type ExecutorStatus = z.infer<typeof ExecutorStatusSchema>;
export type ExecutorCapability = z.infer<typeof ExecutorCapabilitySchema>;
export type BrowserAttachmentState = z.infer<typeof BrowserAttachmentStateSchema>;
export type BrowserAttachmentMode = z.infer<typeof BrowserAttachmentModeSchema>;
export type TurnApprovalState = z.infer<typeof TurnApprovalStateSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type BootstrapState = z.infer<typeof BootstrapStateSchema>;
export type AdminIdentity = z.infer<typeof AdminIdentitySchema>;
export type AuthSession = z.infer<typeof AuthSessionSchema>;
export type TelegramLoginReceipt = z.infer<typeof TelegramLoginReceiptSchema>;
export type SecretEnvelope = z.infer<typeof SecretEnvelopeSchema>;
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type InstallRecord = z.infer<typeof InstallRecordSchema>;
export type McpProviderKind = z.infer<typeof McpProviderKindSchema>;
export type McpProviderCatalogServer = z.infer<typeof McpProviderCatalogServerSchema>;
export type McpProviderConfig = z.infer<typeof McpProviderConfigSchema>;
export type SearchSettings = z.infer<typeof SearchSettingsSchema>;
export type WorkflowBudget = z.infer<typeof WorkflowBudgetSchema>;
export type ExecutorScope = z.infer<typeof ExecutorScopeSchema>;
export type BrowserAttachment = z.infer<typeof BrowserAttachmentSchema>;
export type ExecutorNode = z.infer<typeof ExecutorNodeSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type McpManifest = z.infer<typeof McpManifestSchema>;
export type McpProviderManifest = z.infer<typeof McpProviderManifestSchema>;
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;
export type AgentSpecialistKind = z.infer<typeof AgentSpecialistKindSchema>;
export type AgentSubgraph = z.infer<typeof AgentSubgraphSchema>;
export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentScratchpadEntry = z.infer<typeof AgentScratchpadEntrySchema>;
export type AgentSubgraphFrame = z.infer<typeof AgentSubgraphFrameSchema>;
export type AgentToolLedger = z.infer<typeof AgentToolLedgerSchema>;
export type AgentMemoryLedger = z.infer<typeof AgentMemoryLedgerSchema>;
export type AgentGraphState = z.infer<typeof AgentGraphStateSchema>;
export type PlannerAction = z.infer<typeof PlannerActionSchema>;
export type ConversationRecord = z.infer<typeof ConversationRecordSchema>;
export type MessageRecord = z.infer<typeof MessageRecordSchema>;
export type ToolRunRecord = z.infer<typeof ToolRunRecordSchema>;
export type CloudflareCredentials = z.infer<typeof CloudflareCredentialsSchema>;
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
export type TurnState = z.infer<typeof TurnStateSchema>;
export type TurnEventType = z.infer<typeof TurnEventTypeSchema>;
export type TurnEvent = z.infer<typeof TurnEventSchema>;
export type TaskRunArtifact = z.infer<typeof TaskRunArtifactSchema>;
export type TaskRun = z.infer<typeof TaskRunSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
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
