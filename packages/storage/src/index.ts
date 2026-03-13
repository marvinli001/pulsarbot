import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError, createId, deriveHkdfKeyMaterial, nowIso } from "@pulsarbot/core";
import { CloudflareApiClient } from "@pulsarbot/cloudflare";
import {
  ApprovalRequestSchema,
  AdminIdentitySchema,
  AgentProfileSchema,
  AuthSessionSchema,
  AuditEventSchema,
  BootstrapStateSchema,
  ConversationRecordSchema,
  ConversationSummarySchema,
  ConversationTurnSchema,
  DocumentMetadataSchema,
  ImportExportRunSchema,
  InstallRecordSchema,
  McpProviderConfigSchema,
  JobRecordSchema,
  McpServerConfigSchema,
  MemoryChunkSchema,
  MemoryDocumentSchema,
  MessageRecordSchema,
  ProviderProfileSchema,
  ProviderTestRunSchema,
  SearchSettingsSchema,
  SecretEnvelopeSchema,
  TaskRunSchema,
  TaskSchema,
  TelegramLoginReceiptSchema,
  TriggerSchema,
  ToolRunRecordSchema,
  TurnEventSchema,
  TurnStateSchema,
  WorkspaceSchema,
  ExecutorNodeSchema,
  type ApprovalRequest,
  type AdminIdentity,
  type AgentProfile,
  type AuthSession,
  type AuditEvent,
  type BootstrapState,
  type ConversationRecord,
  type ConversationSummary,
  type ConversationTurn,
  type DocumentMetadata,
  type ImportExportRun,
  type InstallRecord,
  type JobRecord,
  type McpProviderConfig,
  type McpServerConfig,
  type MemoryChunk,
  type MemoryDocument,
  type MessageRecord,
  type ProviderProfile,
  type ProviderTestRun,
  type SearchSettings,
  type SecretEnvelope,
  type Task,
  type TaskRun,
  type TelegramLoginReceipt,
  type Trigger,
  type ToolRunRecord,
  type TurnEvent,
  type TurnState,
  type Workspace,
  type ExecutorNode,
} from "@pulsarbot/shared";

const createTableStatements = [
  `CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    timezone TEXT NOT NULL,
    owner_telegram_user_id TEXT,
    owner_telegram_username TEXT,
    primary_model_profile_id TEXT,
    background_model_profile_id TEXT,
    active_agent_profile_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bootstrap_state (
    id TEXT PRIMARY KEY,
    verified INTEGER NOT NULL,
    owner_bound INTEGER NOT NULL,
    cloudflare_connected INTEGER NOT NULL,
    resources_initialized INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS secret_envelope (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    cipher_text TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, scope)
  )`,
  `CREATE TABLE IF NOT EXISTS admin_identity (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_session (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS telegram_login_receipt (
    id TEXT PRIMARY KEY,
    receipt_key TEXT NOT NULL UNIQUE,
    telegram_user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS provider_profile (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_profile (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS install_record (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS search_settings (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS task (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS task_run (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS task_trigger (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS approval_request (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS executor_node (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_server (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_provider (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversation (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    source_type TEXT NOT NULL,
    telegram_message_id TEXT,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS document_metadata (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memory_document (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memory_chunk (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_summary (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_turn_lock (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE,
    turn_id TEXT NOT NULL,
    lock_expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_turn (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tool_run (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS job (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_event (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS import_export_run (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS provider_test_run (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS telegram_update_receipt (
    id TEXT PRIMARY KEY,
    update_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL,
    lock_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS turn_state_snapshot (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS turn_event (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  )`,
];

const createIndexStatements = [
  "CREATE INDEX IF NOT EXISTS idx_install_record_kind ON install_record(kind)",
  "CREATE INDEX IF NOT EXISTS idx_message_conversation_created_at ON message(conversation_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_message_telegram_message_id ON message(telegram_message_id)",
  "CREATE INDEX IF NOT EXISTS idx_auth_session_jwt_jti ON auth_session(json_extract(data, '$.jwtJti'))",
  "CREATE INDEX IF NOT EXISTS idx_auth_session_expires_at ON auth_session(json_extract(data, '$.expiresAt'))",
  "CREATE INDEX IF NOT EXISTS idx_telegram_login_receipt_expires_at ON telegram_login_receipt(expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_memory_chunk_workspace_id ON memory_chunk(json_extract(data, '$.workspaceId'))",
  "CREATE INDEX IF NOT EXISTS idx_memory_chunk_document_id ON memory_chunk(json_extract(data, '$.documentId'))",
  "CREATE INDEX IF NOT EXISTS idx_job_status_kind ON job(json_extract(data, '$.status'), json_extract(data, '$.kind'))",
  "CREATE INDEX IF NOT EXISTS idx_task_status ON task(json_extract(data, '$.status'))",
  "CREATE INDEX IF NOT EXISTS idx_task_run_status ON task_run(json_extract(data, '$.status'))",
  "CREATE INDEX IF NOT EXISTS idx_task_run_task_id ON task_run(json_extract(data, '$.taskId'))",
  "CREATE INDEX IF NOT EXISTS idx_task_trigger_task_id ON task_trigger(json_extract(data, '$.taskId'))",
  "CREATE INDEX IF NOT EXISTS idx_task_trigger_kind ON task_trigger(json_extract(data, '$.kind'))",
  "CREATE INDEX IF NOT EXISTS idx_approval_request_status ON approval_request(json_extract(data, '$.status'))",
  "CREATE INDEX IF NOT EXISTS idx_executor_node_status ON executor_node(json_extract(data, '$.status'))",
  "CREATE INDEX IF NOT EXISTS idx_telegram_update_receipt_status ON telegram_update_receipt(status, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_conversation_turn_lock_expires_at ON conversation_turn_lock(lock_expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_turn_event_turn_seq ON turn_event(json_extract(data, '$.turnId'), json_extract(data, '$.seq'))",
  "CREATE INDEX IF NOT EXISTS idx_turn_event_occurred_at ON turn_event(json_extract(data, '$.occurredAt'))",
  "CREATE INDEX IF NOT EXISTS idx_turn_state_turn_id ON turn_state_snapshot(json_extract(data, '$.turnId'))",
  "CREATE INDEX IF NOT EXISTS idx_turn_state_updated_at ON turn_state_snapshot(json_extract(data, '$.updatedAt'))",
];

const alterStatements = [
  "ALTER TABLE workspace ADD COLUMN active_agent_profile_id TEXT",
  "ALTER TABLE message ADD COLUMN source_type TEXT NOT NULL DEFAULT 'text'",
  "ALTER TABLE message ADD COLUMN telegram_message_id TEXT",
  "ALTER TABLE message ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'",
];

const migrationHistoryBootstrapStatement = `CREATE TABLE IF NOT EXISTS migration_history (
  id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

interface MigrationDefinition {
  id: string;
  statement: string;
}

function tableMigrationId(statement: string): string {
  const match = statement.match(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/i);
  const tableName = match?.[1];
  if (!tableName) {
    throw new Error(`Unable to derive table migration id from statement: ${statement}`);
  }
  return `create_table_${tableName.toLowerCase()}`;
}

function alterMigrationId(statement: string): string {
  const match = statement.match(/ALTER TABLE\s+([a-z_]+)\s+ADD COLUMN\s+([a-z_]+)/i);
  const tableName = match?.[1];
  const columnName = match?.[2];
  if (!tableName || !columnName) {
    throw new Error(`Unable to derive alter migration id from statement: ${statement}`);
  }
  return `alter_table_${tableName.toLowerCase()}_add_column_${columnName.toLowerCase()}`;
}

function indexMigrationId(statement: string): string {
  const match = statement.match(/CREATE INDEX IF NOT EXISTS\s+([a-z_]+)/i);
  const indexName = match?.[1];
  if (!indexName) {
    throw new Error(`Unable to derive index migration id from statement: ${statement}`);
  }
  return `create_index_${indexName.toLowerCase()}`;
}

const migrationDefinitions: MigrationDefinition[] = [
  ...createTableStatements.map((statement) => ({
    id: tableMigrationId(statement),
    statement,
  })),
  ...alterStatements.map((statement) => ({
    id: alterMigrationId(statement),
    statement,
  })),
  ...createIndexStatements.map((statement) => ({
    id: indexMigrationId(statement),
    statement,
  })),
];

function isIgnorableMigrationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /duplicate column name|already exists|duplicate/i.test(error.message);
}

export const migrationStatements = migrationDefinitions.map((migration) => migration.statement);

export async function runMigrations(
  client: CloudflareApiClient,
  databaseId: string,
): Promise<void> {
  await client.executeD1(databaseId, migrationHistoryBootstrapStatement);
  const appliedMigrations = new Set(
    (
      await client.queryD1<{ id: string }>(
        databaseId,
        "SELECT id FROM migration_history",
      )
    ).map((row) => row.id),
  );

  for (const migration of migrationDefinitions) {
    if (appliedMigrations.has(migration.id)) {
      continue;
    }
    try {
      await client.executeD1(databaseId, migration.statement);
    } catch (error) {
      if (!isIgnorableMigrationError(error)) {
        throw error;
      }
    }
    await client.executeD1(
      databaseId,
      `INSERT INTO migration_history (id, statement, applied_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO NOTHING`,
      [migration.id, migration.statement, nowIso()],
    );
  }
}

export function encryptSecret(args: {
  accessToken: string;
  workspaceId: string;
  scope: string;
  plainText: string;
  existingId?: string;
}): SecretEnvelope {
  const iv = randomBytes(12);
  const key = deriveHkdfKeyMaterial({
    accessToken: args.accessToken,
    workspaceId: args.workspaceId,
    info: "pulsarbot-master-key",
  });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const cipherText = Buffer.concat([
    cipher.update(args.plainText, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const timestamp = nowIso();

  return SecretEnvelopeSchema.parse({
    id: args.existingId ?? createId("secret"),
    workspaceId: args.workspaceId,
    scope: args.scope,
    cipherText: cipherText.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    keyVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function decryptSecret(args: {
  accessToken: string;
  workspaceId: string;
  envelope: SecretEnvelope;
}): string {
  const key = deriveHkdfKeyMaterial({
    accessToken: args.accessToken,
    workspaceId: args.workspaceId,
    info: "pulsarbot-master-key",
  });
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(args.envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(args.envelope.tag, "base64"));

  const plain = Buffer.concat([
    decipher.update(Buffer.from(args.envelope.cipherText, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

export function rewrapSecret(args: {
  oldAccessToken: string;
  newAccessToken: string;
  workspaceId: string;
  envelope: SecretEnvelope;
}): SecretEnvelope {
  const plainText = decryptSecret({
    accessToken: args.oldAccessToken,
    workspaceId: args.workspaceId,
    envelope: args.envelope,
  });
  return encryptSecret({
    accessToken: args.newAccessToken,
    workspaceId: args.workspaceId,
    scope: args.envelope.scope,
    plainText,
    existingId: args.envelope.id,
  });
}

export type ConversationMessage = MessageRecord;
type TelegramUpdateClaimResult = "claimed" | "duplicate" | "in_progress";
type ConversationTurnLockClaimResult = "claimed" | "in_progress";

export interface AppRepository {
  getWorkspace(): Promise<Workspace | null>;
  saveWorkspace(workspace: Workspace): Promise<void>;
  getBootstrapState(): Promise<BootstrapState>;
  saveBootstrapState(state: BootstrapState): Promise<void>;
  getAdminIdentity(): Promise<AdminIdentity | null>;
  saveAdminIdentity(identity: AdminIdentity): Promise<void>;
  saveAuthSession(session: {
    workspaceId: string;
    telegramUserId: string;
    jwtJti: string;
    expiresAt: string;
  }): Promise<void>;
  getAuthSessionByJti(jwtJti: string): Promise<AuthSession | null>;
  revokeAuthSession(jwtJti: string): Promise<void>;
  claimTelegramLoginReceipt(args: {
    receiptKey: string;
    telegramUserId: string;
    expiresAt: string;
  }): Promise<"claimed" | "duplicate">;
  listProviderProfiles(): Promise<ProviderProfile[]>;
  saveProviderProfile(profile: ProviderProfile): Promise<void>;
  deleteProviderProfile(id: string): Promise<void>;
  listAgentProfiles(): Promise<AgentProfile[]>;
  saveAgentProfile(profile: AgentProfile): Promise<void>;
  deleteAgentProfile(id: string): Promise<void>;
  listInstallRecords(kind?: InstallRecord["kind"]): Promise<InstallRecord[]>;
  saveInstallRecord(record: InstallRecord): Promise<void>;
  deleteInstallRecord(kind: InstallRecord["kind"], manifestId: string): Promise<void>;
  getSearchSettings(): Promise<SearchSettings>;
  saveSearchSettings(settings: SearchSettings): Promise<void>;
  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  saveTask(task: Task): Promise<void>;
  listTaskRuns(args?: {
    taskId?: string;
    status?: TaskRun["status"];
    executorId?: string;
    limit?: number;
  }): Promise<TaskRun[]>;
  getTaskRun(id: string): Promise<TaskRun | null>;
  saveTaskRun(taskRun: TaskRun): Promise<void>;
  listTriggers(args?: {
    taskId?: string;
    kind?: Trigger["kind"];
    enabled?: boolean;
  }): Promise<Trigger[]>;
  getTrigger(id: string): Promise<Trigger | null>;
  saveTrigger(trigger: Trigger): Promise<void>;
  listApprovalRequests(args?: {
    taskRunId?: string;
    status?: ApprovalRequest["status"];
    limit?: number;
  }): Promise<ApprovalRequest[]>;
  getApprovalRequest(id: string): Promise<ApprovalRequest | null>;
  saveApprovalRequest(approval: ApprovalRequest): Promise<void>;
  listExecutorNodes(): Promise<ExecutorNode[]>;
  getExecutorNode(id: string): Promise<ExecutorNode | null>;
  saveExecutorNode(executor: ExecutorNode): Promise<void>;
  listMcpServers(): Promise<McpServerConfig[]>;
  saveMcpServer(server: McpServerConfig): Promise<void>;
  deleteMcpServer(id: string): Promise<void>;
  listMcpProviders(): Promise<McpProviderConfig[]>;
  saveMcpProvider(provider: McpProviderConfig): Promise<void>;
  deleteMcpProvider(id: string): Promise<void>;
  listSecrets(): Promise<SecretEnvelope[]>;
  getSecretByScope(workspaceId: string, scope: string): Promise<SecretEnvelope | null>;
  saveSecret(secret: SecretEnvelope): Promise<void>;
  clearWorkspaceForImport(workspaceId: string): Promise<void>;
  listDocuments(): Promise<DocumentMetadata[]>;
  saveDocument(document: DocumentMetadata): Promise<void>;
  listMemoryDocuments(): Promise<MemoryDocument[]>;
  saveMemoryDocument(document: MemoryDocument): Promise<void>;
  listMemoryChunks(args?: { documentId?: string; workspaceId?: string }): Promise<MemoryChunk[]>;
  saveMemoryChunk(chunk: MemoryChunk): Promise<void>;
  deleteMemoryChunksByDocument(documentId: string): Promise<void>;
  listConversationSummaries(conversationId: string): Promise<ConversationSummary[]>;
  saveConversationSummary(summary: ConversationSummary): Promise<void>;
  listConversationTurns(args?: {
    conversationId?: string;
    status?: ConversationTurn["status"];
    limit?: number;
  }): Promise<ConversationTurn[]>;
  getConversationTurn(id: string): Promise<ConversationTurn | null>;
  saveConversationTurn(turn: ConversationTurn): Promise<void>;
  listToolRuns(conversationId?: string): Promise<ToolRunRecord[]>;
  saveToolRun(record: ToolRunRecord): Promise<void>;
  listJobs(args?: { status?: JobRecord["status"]; kind?: JobRecord["kind"] }): Promise<JobRecord[]>;
  getJob(id: string): Promise<JobRecord | null>;
  saveJob(job: JobRecord): Promise<void>;
  getConversation(id: string): Promise<ConversationRecord | null>;
  listConversations(): Promise<ConversationRecord[]>;
  saveConversation(conversation: ConversationRecord): Promise<void>;
  claimConversationTurnLock(args: {
    conversationId: string;
    turnId: string;
    lockExpiresAt: string;
  }): Promise<ConversationTurnLockClaimResult>;
  releaseConversationTurnLock(conversationId: string, turnId?: string): Promise<void>;
  listConversationMessages(conversationId: string): Promise<ConversationMessage[]>;
  saveConversationMessage(
    conversationId: string,
    message: ConversationMessage,
  ): Promise<void>;
  appendConversationMessage(
    conversationId: string,
    message: ConversationMessage,
  ): Promise<void>;
  getLatestTurnState(turnId: string): Promise<TurnState | null>;
  saveTurnStateSnapshot(state: TurnState): Promise<void>;
  appendTurnEvent(event: TurnEvent): Promise<void>;
  listTurnEvents(
    turnId: string,
    args?: {
      cursorSeq?: number;
      limit?: number;
    },
  ): Promise<TurnEvent[]>;
  pruneTurnEventsOlderThan(cutoffIso: string): Promise<number>;
  claimTelegramUpdate(
    updateId: number,
    lockExpiresAt: string,
  ): Promise<TelegramUpdateClaimResult>;
  completeTelegramUpdate(updateId: number): Promise<void>;
  releaseTelegramUpdate(updateId: number): Promise<void>;
  listAuditEvents(limit?: number): Promise<AuditEvent[]>;
  saveAuditEvent(event: AuditEvent): Promise<void>;
  listImportExportRuns(limit?: number): Promise<ImportExportRun[]>;
  saveImportExportRun(run: ImportExportRun): Promise<void>;
  listProviderTestRuns(args?: {
    providerId?: string;
    limit?: number;
  }): Promise<ProviderTestRun[]>;
  saveProviderTestRun(run: ProviderTestRun): Promise<void>;
}

export class D1AppRepository implements AppRepository {
  public constructor(
    private readonly client: CloudflareApiClient,
    private readonly databaseId: string,
  ) {}

  public async getWorkspace(): Promise<Workspace | null> {
    const rows = await this.client.queryD1<{
      id: string;
      label: string;
      timezone: string;
      owner_telegram_user_id: string | null;
      owner_telegram_username: string | null;
      primary_model_profile_id: string | null;
      background_model_profile_id: string | null;
      active_agent_profile_id: string | null;
      created_at: string;
      updated_at: string;
    }>(this.databaseId, "SELECT * FROM workspace LIMIT 1");

    const row = rows[0];
    if (!row) {
      return null;
    }

    return WorkspaceSchema.parse({
      id: row.id,
      label: row.label,
      timezone: row.timezone,
      ownerTelegramUserId: row.owner_telegram_user_id,
      ownerTelegramUsername: row.owner_telegram_username,
      primaryModelProfileId: row.primary_model_profile_id,
      backgroundModelProfileId: row.background_model_profile_id,
      activeAgentProfileId: row.active_agent_profile_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  public async saveWorkspace(workspace: Workspace): Promise<void> {
    const parsed = WorkspaceSchema.parse(workspace);
    await this.client.executeD1(
      this.databaseId,
      `INSERT INTO workspace (
        id, label, timezone, owner_telegram_user_id, owner_telegram_username,
        primary_model_profile_id, background_model_profile_id, active_agent_profile_id,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        timezone = excluded.timezone,
        owner_telegram_user_id = excluded.owner_telegram_user_id,
        owner_telegram_username = excluded.owner_telegram_username,
        primary_model_profile_id = excluded.primary_model_profile_id,
        background_model_profile_id = excluded.background_model_profile_id,
        active_agent_profile_id = excluded.active_agent_profile_id,
        updated_at = excluded.updated_at`,
      [
        parsed.id,
        parsed.label,
        parsed.timezone,
        parsed.ownerTelegramUserId,
        parsed.ownerTelegramUsername,
        parsed.primaryModelProfileId,
        parsed.backgroundModelProfileId,
        parsed.activeAgentProfileId,
        parsed.createdAt,
        parsed.updatedAt,
      ],
    );
  }

  public async getBootstrapState(): Promise<BootstrapState> {
    const rows = await this.client.queryD1<{
      verified: number;
      owner_bound: number;
      cloudflare_connected: number;
      resources_initialized: number;
    }>(
      this.databaseId,
      "SELECT verified, owner_bound, cloudflare_connected, resources_initialized FROM bootstrap_state WHERE id = ?",
      ["main"],
    );
    const row = rows[0];
    if (!row) {
      return BootstrapStateSchema.parse({});
    }

    return BootstrapStateSchema.parse({
      verified: Boolean(row.verified),
      ownerBound: Boolean(row.owner_bound),
      cloudflareConnected: Boolean(row.cloudflare_connected),
      resourcesInitialized: Boolean(row.resources_initialized),
    });
  }

  public async saveBootstrapState(state: BootstrapState): Promise<void> {
    const parsed = BootstrapStateSchema.parse(state);
    await this.client.executeD1(
      this.databaseId,
      `INSERT INTO bootstrap_state (
        id, verified, owner_bound, cloudflare_connected, resources_initialized
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        verified = excluded.verified,
        owner_bound = excluded.owner_bound,
        cloudflare_connected = excluded.cloudflare_connected,
        resources_initialized = excluded.resources_initialized`,
      [
        "main",
        Number(parsed.verified),
        Number(parsed.ownerBound),
        Number(parsed.cloudflareConnected),
        Number(parsed.resourcesInitialized),
      ],
    );
  }

  public async getAdminIdentity(): Promise<AdminIdentity | null> {
    const identities = await this.listJsonTable("admin_identity", AdminIdentitySchema);
    return identities[0] ?? null;
  }

  public async saveAdminIdentity(identity: AdminIdentity): Promise<void> {
    const parsed = AdminIdentitySchema.parse(identity);
    await this.saveJsonRow("admin_identity", {
      id: `${parsed.workspaceId}:${parsed.telegramUserId}`,
      data: parsed,
    });
  }

  public async saveAuthSession(session: {
    workspaceId: string;
    telegramUserId: string;
    jwtJti: string;
    expiresAt: string;
  }): Promise<void> {
    const timestamp = nowIso();
    const parsed = {
      id: createId("session"),
      workspaceId: session.workspaceId,
      telegramUserId: session.telegramUserId,
      jwtJti: session.jwtJti,
      createdAt: timestamp,
      expiresAt: session.expiresAt,
      revokedAt: null,
    };
    await this.saveJsonRow("auth_session", {
      id: parsed.id,
      data: AuthSessionSchema.parse(parsed),
    });
  }

  public async getAuthSessionByJti(jwtJti: string): Promise<AuthSession | null> {
    const rows = await this.client.queryD1<{ data: string }>(
      this.databaseId,
      "SELECT data FROM auth_session WHERE json_extract(data, '$.jwtJti') = ? LIMIT 1",
      [jwtJti],
    );
    const row = rows[0];
    return row ? AuthSessionSchema.parse(JSON.parse(row.data)) : null;
  }

  public async revokeAuthSession(jwtJti: string): Promise<void> {
    const match = await this.getAuthSessionByJti(jwtJti);
    if (!match) {
      return;
    }
    await this.saveJsonRow("auth_session", {
      id: match.id,
      data: {
        ...match,
        revokedAt: nowIso(),
      },
    });
  }

  public async claimTelegramLoginReceipt(args: {
    receiptKey: string;
    telegramUserId: string;
    expiresAt: string;
  }): Promise<"claimed" | "duplicate"> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const currentTimestamp = nowIso();
      await this.client.executeD1(
        this.databaseId,
        "DELETE FROM telegram_login_receipt WHERE expires_at <= ?",
        [currentTimestamp],
      );

      const existingRows = await this.client.queryD1<{
        expires_at: string;
      }>(
        this.databaseId,
        "SELECT expires_at FROM telegram_login_receipt WHERE receipt_key = ? LIMIT 1",
        [args.receiptKey],
      );
      const existing = existingRows[0];
      if (existing && Date.parse(existing.expires_at) > Date.now()) {
        return "duplicate";
      }

      try {
        await this.client.executeD1(
          this.databaseId,
          `INSERT INTO telegram_login_receipt (
            id, receipt_key, telegram_user_id, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            createId("tglogin"),
            args.receiptKey,
            args.telegramUserId,
            args.expiresAt,
            currentTimestamp,
            currentTimestamp,
          ],
        );
        return "claimed";
      } catch (error) {
        if (error instanceof Error && /unique|constraint/i.test(error.message)) {
          continue;
        }
        throw error;
      }
    }

    return "duplicate";
  }

  public async listProviderProfiles(): Promise<ProviderProfile[]> {
    return this.listJsonTable("provider_profile", ProviderProfileSchema);
  }

  public async saveProviderProfile(profile: ProviderProfile): Promise<void> {
    await this.saveJsonRow("provider_profile", {
      id: profile.id,
      data: ProviderProfileSchema.parse(profile),
    });
  }

  public async deleteProviderProfile(id: string): Promise<void> {
    await this.deleteJsonRow("provider_profile", id);
  }

  public async listAgentProfiles(): Promise<AgentProfile[]> {
    return this.listJsonTable("agent_profile", AgentProfileSchema);
  }

  public async saveAgentProfile(profile: AgentProfile): Promise<void> {
    await this.saveJsonRow("agent_profile", {
      id: profile.id,
      data: AgentProfileSchema.parse(profile),
    });
  }

  public async deleteAgentProfile(id: string): Promise<void> {
    await this.deleteJsonRow("agent_profile", id);
  }

  public async listInstallRecords(kind?: InstallRecord["kind"]): Promise<InstallRecord[]> {
    const rows = await this.client.queryD1<{ data: string }>(
      this.databaseId,
      kind
        ? "SELECT data FROM install_record WHERE kind = ?"
        : "SELECT data FROM install_record",
      kind ? [kind] : [],
    );
    return rows.map((row) => InstallRecordSchema.parse(JSON.parse(row.data)));
  }

  public async saveInstallRecord(record: InstallRecord): Promise<void> {
    const parsed = InstallRecordSchema.parse(record);
    await this.client.executeD1(
      this.databaseId,
      `INSERT INTO install_record (id, kind, data)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        data = excluded.data`,
      [parsed.id, parsed.kind, JSON.stringify(parsed)],
    );
  }

  public async deleteInstallRecord(
    kind: InstallRecord["kind"],
    manifestId: string,
  ): Promise<void> {
    const records = await this.listInstallRecords(kind);
    const match = records.find((item) => item.manifestId === manifestId);
    if (!match) {
      return;
    }
    await this.deleteJsonRow("install_record", match.id);
  }

  public async getSearchSettings(): Promise<SearchSettings> {
    const settings = await this.listJsonTable("search_settings", SearchSettingsSchema);
    if (settings[0]) {
      return settings[0];
    }
    const timestamp = nowIso();
    return SearchSettingsSchema.parse({
      id: "main",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  public async saveSearchSettings(settings: SearchSettings): Promise<void> {
    const parsed = SearchSettingsSchema.parse(settings);
    await this.saveJsonRow("search_settings", {
      id: parsed.id,
      data: parsed,
    });
  }

  public async listTasks(): Promise<Task[]> {
    return this.listJsonTable("task", TaskSchema);
  }

  public async getTask(id: string): Promise<Task | null> {
    const tasks = await this.listTasks();
    return tasks.find((task) => task.id === id) ?? null;
  }

  public async saveTask(task: Task): Promise<void> {
    await this.saveJsonRow("task", {
      id: task.id,
      data: TaskSchema.parse(task),
    });
  }

  public async listTaskRuns(args?: {
    taskId?: string;
    status?: TaskRun["status"];
    executorId?: string;
    limit?: number;
  }): Promise<TaskRun[]> {
    let rows = await this.listJsonTable("task_run", TaskRunSchema);
    rows = rows.filter((taskRun) => {
      if (args?.taskId && taskRun.taskId !== args.taskId) {
        return false;
      }
      if (args?.status && taskRun.status !== args.status) {
        return false;
      }
      if (args?.executorId && taskRun.executorId !== args.executorId) {
        return false;
      }
      return true;
    });
    rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return typeof args?.limit === "number" ? rows.slice(0, args.limit) : rows;
  }

  public async getTaskRun(id: string): Promise<TaskRun | null> {
    const rows = await this.listTaskRuns();
    return rows.find((taskRun) => taskRun.id === id) ?? null;
  }

  public async saveTaskRun(taskRun: TaskRun): Promise<void> {
    await this.saveJsonRow("task_run", {
      id: taskRun.id,
      data: TaskRunSchema.parse(taskRun),
    });
  }

  public async listTriggers(args?: {
    taskId?: string;
    kind?: Trigger["kind"];
    enabled?: boolean;
  }): Promise<Trigger[]> {
    let rows = await this.listJsonTable("task_trigger", TriggerSchema);
    rows = rows.filter((trigger) => {
      if (args?.taskId && trigger.taskId !== args.taskId) {
        return false;
      }
      if (args?.kind && trigger.kind !== args.kind) {
        return false;
      }
      if (typeof args?.enabled === "boolean" && trigger.enabled !== args.enabled) {
        return false;
      }
      return true;
    });
    rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return rows;
  }

  public async getTrigger(id: string): Promise<Trigger | null> {
    const rows = await this.listTriggers();
    return rows.find((trigger) => trigger.id === id) ?? null;
  }

  public async saveTrigger(trigger: Trigger): Promise<void> {
    await this.saveJsonRow("task_trigger", {
      id: trigger.id,
      data: TriggerSchema.parse(trigger),
    });
  }

  public async listApprovalRequests(args?: {
    taskRunId?: string;
    status?: ApprovalRequest["status"];
    limit?: number;
  }): Promise<ApprovalRequest[]> {
    let rows = await this.listJsonTable("approval_request", ApprovalRequestSchema);
    rows = rows.filter((approval) => {
      if (args?.taskRunId && approval.taskRunId !== args.taskRunId) {
        return false;
      }
      if (args?.status && approval.status !== args.status) {
        return false;
      }
      return true;
    });
    rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return typeof args?.limit === "number" ? rows.slice(0, args.limit) : rows;
  }

  public async getApprovalRequest(id: string): Promise<ApprovalRequest | null> {
    const rows = await this.listApprovalRequests();
    return rows.find((approval) => approval.id === id) ?? null;
  }

  public async saveApprovalRequest(approval: ApprovalRequest): Promise<void> {
    await this.saveJsonRow("approval_request", {
      id: approval.id,
      data: ApprovalRequestSchema.parse(approval),
    });
  }

  public async listExecutorNodes(): Promise<ExecutorNode[]> {
    return this.listJsonTable("executor_node", ExecutorNodeSchema);
  }

  public async getExecutorNode(id: string): Promise<ExecutorNode | null> {
    const rows = await this.listExecutorNodes();
    return rows.find((executor) => executor.id === id) ?? null;
  }

  public async saveExecutorNode(executor: ExecutorNode): Promise<void> {
    await this.saveJsonRow("executor_node", {
      id: executor.id,
      data: ExecutorNodeSchema.parse(executor),
    });
  }

  public async listMcpServers(): Promise<McpServerConfig[]> {
    return this.listJsonTable("mcp_server", McpServerConfigSchema);
  }

  public async saveMcpServer(server: McpServerConfig): Promise<void> {
    await this.saveJsonRow("mcp_server", {
      id: server.id,
      data: McpServerConfigSchema.parse(server),
    });
  }

  public async deleteMcpServer(id: string): Promise<void> {
    await this.deleteJsonRow("mcp_server", id);
  }

  public async listMcpProviders(): Promise<McpProviderConfig[]> {
    return this.listJsonTable("mcp_provider", McpProviderConfigSchema);
  }

  public async saveMcpProvider(provider: McpProviderConfig): Promise<void> {
    await this.saveJsonRow("mcp_provider", {
      id: provider.id,
      data: McpProviderConfigSchema.parse(provider),
    });
  }

  public async deleteMcpProvider(id: string): Promise<void> {
    await this.deleteJsonRow("mcp_provider", id);
  }

  public async listSecrets(): Promise<SecretEnvelope[]> {
    const rows = await this.client.queryD1<{
      id: string;
      workspace_id: string;
      scope: string;
      cipher_text: string;
      iv: string;
      tag: string;
      key_version: number;
      created_at: string;
      updated_at: string;
    }>(this.databaseId, "SELECT * FROM secret_envelope ORDER BY updated_at DESC");

    return rows.map((row) =>
      SecretEnvelopeSchema.parse({
        id: row.id,
        workspaceId: row.workspace_id,
        scope: row.scope,
        cipherText: row.cipher_text,
        iv: row.iv,
        tag: row.tag,
        keyVersion: row.key_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    );
  }

  public async getSecretByScope(
    workspaceId: string,
    scope: string,
  ): Promise<SecretEnvelope | null> {
    const rows = await this.client.queryD1<{
      id: string;
      workspace_id: string;
      scope: string;
      cipher_text: string;
      iv: string;
      tag: string;
      key_version: number;
      created_at: string;
      updated_at: string;
    }>(
      this.databaseId,
      "SELECT * FROM secret_envelope WHERE workspace_id = ? AND scope = ? LIMIT 1",
      [workspaceId, scope],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return SecretEnvelopeSchema.parse({
      id: row.id,
      workspaceId: row.workspace_id,
      scope: row.scope,
      cipherText: row.cipher_text,
      iv: row.iv,
      tag: row.tag,
      keyVersion: row.key_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  public async saveSecret(secret: SecretEnvelope): Promise<void> {
    const parsed = SecretEnvelopeSchema.parse(secret);
    const existing = await this.getSecretByScope(parsed.workspaceId, parsed.scope);
    await this.client.executeD1(
      this.databaseId,
      `INSERT INTO secret_envelope (
        id, workspace_id, scope, cipher_text, iv, tag, key_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, scope) DO UPDATE SET
        id = excluded.id,
        cipher_text = excluded.cipher_text,
        iv = excluded.iv,
        tag = excluded.tag,
        key_version = excluded.key_version,
        updated_at = excluded.updated_at`,
      [
        existing?.id ?? parsed.id,
        parsed.workspaceId,
        parsed.scope,
        parsed.cipherText,
        parsed.iv,
        parsed.tag,
        parsed.keyVersion,
        existing?.createdAt ?? parsed.createdAt,
        parsed.updatedAt,
      ],
    );
  }

  public async clearWorkspaceForImport(workspaceId: string): Promise<void> {
    const statements: Array<{ sql: string; params?: unknown[] }> = [
      { sql: "DELETE FROM turn_event" },
      { sql: "DELETE FROM turn_state_snapshot" },
      { sql: "DELETE FROM conversation_turn_lock" },
      { sql: "DELETE FROM tool_run" },
      { sql: "DELETE FROM conversation_turn" },
      { sql: "DELETE FROM conversation_summary" },
      { sql: "DELETE FROM message" },
      { sql: "DELETE FROM conversation" },
      { sql: "DELETE FROM job" },
      { sql: "DELETE FROM provider_test_run" },
      { sql: "DELETE FROM audit_event" },
      { sql: "DELETE FROM import_export_run" },
      { sql: "DELETE FROM document_metadata" },
      { sql: "DELETE FROM memory_chunk" },
      { sql: "DELETE FROM memory_document" },
      { sql: "DELETE FROM mcp_server" },
      { sql: "DELETE FROM mcp_provider" },
      { sql: "DELETE FROM install_record" },
      { sql: "DELETE FROM provider_profile" },
      { sql: "DELETE FROM agent_profile" },
      { sql: "DELETE FROM search_settings" },
      { sql: "DELETE FROM admin_identity" },
      { sql: "DELETE FROM telegram_login_receipt" },
      {
        sql: "DELETE FROM secret_envelope WHERE workspace_id = ?",
        params: [workspaceId],
      },
      { sql: "DELETE FROM workspace" },
      { sql: "DELETE FROM telegram_update_receipt" },
    ];

    for (const statement of statements) {
      await this.client.executeD1(
        this.databaseId,
        statement.sql,
        statement.params,
      );
    }
  }

  public async listDocuments(): Promise<DocumentMetadata[]> {
    return this.listJsonTable("document_metadata", DocumentMetadataSchema);
  }

  public async saveDocument(document: DocumentMetadata): Promise<void> {
    await this.saveJsonRow("document_metadata", {
      id: document.id,
      data: DocumentMetadataSchema.parse(document),
    });
  }

  public async listMemoryDocuments(): Promise<MemoryDocument[]> {
    return this.listJsonTable("memory_document", MemoryDocumentSchema);
  }

  public async saveMemoryDocument(document: MemoryDocument): Promise<void> {
    await this.saveJsonRow("memory_document", {
      id: document.id,
      data: MemoryDocumentSchema.parse(document),
    });
  }

  public async listMemoryChunks(args?: {
    documentId?: string;
    workspaceId?: string;
  }): Promise<MemoryChunk[]> {
    const predicates: string[] = [];
    const params: unknown[] = [];
    if (args?.documentId) {
      predicates.push("json_extract(data, '$.documentId') = ?");
      params.push(args.documentId);
    }
    if (args?.workspaceId) {
      predicates.push("json_extract(data, '$.workspaceId') = ?");
      params.push(args.workspaceId);
    }
    const whereClause = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
    const rows = await this.client.queryD1<{ data: string }>(
      this.databaseId,
      `SELECT data FROM memory_chunk${whereClause}`,
      params,
    );
    return rows.map((row) => MemoryChunkSchema.parse(JSON.parse(row.data)));
  }

  public async saveMemoryChunk(chunk: MemoryChunk): Promise<void> {
    await this.saveJsonRow("memory_chunk", {
      id: chunk.id,
      data: MemoryChunkSchema.parse(chunk),
    });
  }

  public async deleteMemoryChunksByDocument(documentId: string): Promise<void> {
    const chunks = await this.listMemoryChunks({ documentId });
    for (const chunk of chunks) {
      await this.deleteJsonRow("memory_chunk", chunk.id);
    }
  }

  public async listConversationSummaries(
    conversationId: string,
  ): Promise<ConversationSummary[]> {
    const rows = await this.listJsonTable(
      "conversation_summary",
      ConversationSummarySchema,
    );
    return rows.filter((row) => row.conversationId === conversationId);
  }

  public async saveConversationSummary(summary: ConversationSummary): Promise<void> {
    await this.saveJsonRow("conversation_summary", {
      id: summary.id,
      data: ConversationSummarySchema.parse(summary),
    });
  }

  public async listConversationTurns(args?: {
    conversationId?: string;
    status?: ConversationTurn["status"];
    limit?: number;
  }): Promise<ConversationTurn[]> {
    let rows = await this.listJsonTable("conversation_turn", ConversationTurnSchema);
    rows = rows.filter((row) => {
      if (args?.conversationId && row.conversationId !== args.conversationId) {
        return false;
      }
      if (args?.status && row.status !== args.status) {
        return false;
      }
      return true;
    });
    rows.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return typeof args?.limit === "number" ? rows.slice(0, args.limit) : rows;
  }

  public async getConversationTurn(id: string): Promise<ConversationTurn | null> {
    const rows = await this.listJsonTable("conversation_turn", ConversationTurnSchema);
    return rows.find((row) => row.id === id) ?? null;
  }

  public async saveConversationTurn(turn: ConversationTurn): Promise<void> {
    await this.saveJsonRow("conversation_turn", {
      id: turn.id,
      data: ConversationTurnSchema.parse(turn),
    });
  }

  public async listToolRuns(conversationId?: string): Promise<ToolRunRecord[]> {
    const rows = await this.listJsonTable("tool_run", ToolRunRecordSchema);
    return conversationId
      ? rows.filter((row) => row.conversationId === conversationId)
      : rows;
  }

  public async saveToolRun(record: ToolRunRecord): Promise<void> {
    await this.saveJsonRow("tool_run", {
      id: record.id,
      data: ToolRunRecordSchema.parse(record),
    });
  }

  public async listJobs(args?: {
    status?: JobRecord["status"];
    kind?: JobRecord["kind"];
  }): Promise<JobRecord[]> {
    const rows = await this.listJsonTable("job", JobRecordSchema);
    return rows.filter((row) => {
      if (args?.status && row.status !== args.status) {
        return false;
      }
      if (args?.kind && row.kind !== args.kind) {
        return false;
      }
      return true;
    });
  }

  public async getJob(id: string): Promise<JobRecord | null> {
    const rows = await this.listJsonTable("job", JobRecordSchema);
    return rows.find((row) => row.id === id) ?? null;
  }

  public async saveJob(job: JobRecord): Promise<void> {
    await this.saveJsonRow("job", {
      id: job.id,
      data: JobRecordSchema.parse(job),
    });
  }

  public async getConversation(id: string): Promise<ConversationRecord | null> {
    const rows = await this.listJsonTable("conversation", ConversationRecordSchema);
    return rows.find((row) => row.id === id) ?? null;
  }

  public async listConversations(): Promise<ConversationRecord[]> {
    return this.listJsonTable("conversation", ConversationRecordSchema);
  }

  public async saveConversation(conversation: ConversationRecord): Promise<void> {
    await this.saveJsonRow("conversation", {
      id: conversation.id,
      data: ConversationRecordSchema.parse(conversation),
    });
  }

  public async claimConversationTurnLock(args: {
    conversationId: string;
    turnId: string;
    lockExpiresAt: string;
  }): Promise<ConversationTurnLockClaimResult> {
    const lockId = `convturn:${args.conversationId}`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existingRows = await this.client.queryD1<{
        turn_id: string;
        lock_expires_at: string;
      }>(
        this.databaseId,
        `SELECT turn_id, lock_expires_at
        FROM conversation_turn_lock
        WHERE conversation_id = ?
        LIMIT 1`,
        [args.conversationId],
      );
      const existing = existingRows[0];
      if (existing && Date.parse(existing.lock_expires_at) > Date.now()) {
        return "in_progress";
      }
      if (existing) {
        await this.client.executeD1(
          this.databaseId,
          "DELETE FROM conversation_turn_lock WHERE conversation_id = ? AND turn_id = ?",
          [args.conversationId, existing.turn_id],
        );
      }

      try {
        const timestamp = nowIso();
        await this.client.executeD1(
          this.databaseId,
          `INSERT INTO conversation_turn_lock (
            id, conversation_id, turn_id, lock_expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            lockId,
            args.conversationId,
            args.turnId,
            args.lockExpiresAt,
            timestamp,
            timestamp,
          ],
        );
        return "claimed";
      } catch (error) {
        if (error instanceof Error && /unique|constraint/i.test(error.message)) {
          continue;
        }
        throw error;
      }
    }

    return "in_progress";
  }

  public async releaseConversationTurnLock(
    conversationId: string,
    turnId?: string,
  ): Promise<void> {
    if (turnId) {
      await this.client.executeD1(
        this.databaseId,
        "DELETE FROM conversation_turn_lock WHERE conversation_id = ? AND turn_id = ?",
        [conversationId, turnId],
      );
      return;
    }
    await this.client.executeD1(
      this.databaseId,
      "DELETE FROM conversation_turn_lock WHERE conversation_id = ?",
      [conversationId],
    );
  }

  public async listConversationMessages(
    conversationId: string,
  ): Promise<ConversationMessage[]> {
    const rows = await this.client.queryD1<{
      id: string;
      role: MessageRecord["role"];
      content: string;
      source_type: MessageRecord["sourceType"];
      telegram_message_id: string | null;
      metadata_json: string;
      created_at: string;
    }>(
      this.databaseId,
      `SELECT id, role, content, source_type, telegram_message_id, metadata_json, created_at
      FROM message
      WHERE conversation_id = ?
      ORDER BY created_at ASC`,
      [conversationId],
    );

    return rows.map((row) =>
      MessageRecordSchema.parse({
        id: row.id,
        conversationId,
        role: row.role,
        content: row.content,
        sourceType: row.source_type,
        telegramMessageId: row.telegram_message_id,
        metadata: JSON.parse(row.metadata_json || "{}") as Record<string, unknown>,
        createdAt: row.created_at,
      }),
    );
  }

  public async appendConversationMessage(
    conversationId: string,
    message: ConversationMessage,
  ): Promise<void> {
    await this.saveConversationMessage(conversationId, message);
  }

  public async saveConversationMessage(
    conversationId: string,
    message: ConversationMessage,
  ): Promise<void> {
    const parsed = MessageRecordSchema.parse({
      ...message,
      conversationId,
    });
    await this.client.executeD1(
      this.databaseId,
      `INSERT INTO message (
        id, conversation_id, role, content, source_type, telegram_message_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        role = excluded.role,
        content = excluded.content,
        source_type = excluded.source_type,
        telegram_message_id = excluded.telegram_message_id,
        metadata_json = excluded.metadata_json`,
      [
        parsed.id,
        conversationId,
        parsed.role,
        parsed.content,
        parsed.sourceType,
        parsed.telegramMessageId,
        JSON.stringify(parsed.metadata),
        parsed.createdAt,
      ],
    );
  }

  public async getLatestTurnState(turnId: string): Promise<TurnState | null> {
    const rows = await this.client.queryD1<{ data: string }>(
      this.databaseId,
      `SELECT data FROM turn_state_snapshot
      WHERE json_extract(data, '$.turnId') = ?
      ORDER BY json_extract(data, '$.updatedAt') DESC
      LIMIT 1`,
      [turnId],
    );
    const row = rows[0];
    return row ? TurnStateSchema.parse(JSON.parse(row.data)) : null;
  }

  public async saveTurnStateSnapshot(state: TurnState): Promise<void> {
    await this.saveJsonRow("turn_state_snapshot", {
      id: state.id,
      data: TurnStateSchema.parse(state),
    });
  }

  public async appendTurnEvent(event: TurnEvent): Promise<void> {
    const parsed = TurnEventSchema.parse(event);
    await this.client.executeD1(
      this.databaseId,
      `INSERT INTO turn_event (id, data)
      VALUES (?, ?)
      ON CONFLICT(id) DO NOTHING`,
      [parsed.id, JSON.stringify(parsed)],
    );
  }

  public async listTurnEvents(
    turnId: string,
    args?: {
      cursorSeq?: number;
      limit?: number;
    },
  ): Promise<TurnEvent[]> {
    const limit = Math.min(Math.max(args?.limit ?? 100, 1), 500);
    const predicates = ["json_extract(data, '$.turnId') = ?"];
    const params: unknown[] = [turnId];

    if (typeof args?.cursorSeq === "number") {
      predicates.push("CAST(json_extract(data, '$.seq') AS INTEGER) > ?");
      params.push(args.cursorSeq);
    }

    const rows = await this.client.queryD1<{ data: string }>(
      this.databaseId,
      `SELECT data FROM turn_event
      WHERE ${predicates.join(" AND ")}
      ORDER BY CAST(json_extract(data, '$.seq') AS INTEGER) ASC
      LIMIT ?`,
      [...params, limit],
    );
    return rows.map((row) => TurnEventSchema.parse(JSON.parse(row.data)));
  }

  public async pruneTurnEventsOlderThan(cutoffIso: string): Promise<number> {
    const staleIds = await this.client.queryD1<{ id: string }>(
      this.databaseId,
      `SELECT id FROM turn_event
      WHERE json_extract(data, '$.occurredAt') < ?`,
      [cutoffIso],
    );
    for (const row of staleIds) {
      await this.client.executeD1(
        this.databaseId,
        "DELETE FROM turn_event WHERE id = ?",
        [row.id],
      );
    }
    return staleIds.length;
  }

  public async claimTelegramUpdate(
    updateId: number,
    lockExpiresAt: string,
  ): Promise<TelegramUpdateClaimResult> {
    const lockId = `tgupd:${updateId}`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existingRows = await this.client.queryD1<{
        status: string;
        lock_expires_at: string | null;
      }>(
        this.databaseId,
        "SELECT status, lock_expires_at FROM telegram_update_receipt WHERE update_id = ? LIMIT 1",
        [updateId],
      );
      const existing = existingRows[0];

      if (existing) {
        if (existing.status === "completed") {
          return "duplicate";
        }
        if (
          existing.status === "processing" &&
          existing.lock_expires_at &&
          Date.parse(existing.lock_expires_at) > Date.now()
        ) {
          return "in_progress";
        }
        await this.client.executeD1(
          this.databaseId,
          "DELETE FROM telegram_update_receipt WHERE update_id = ? AND status = 'processing'",
          [updateId],
        );
      }

      try {
        const timestamp = nowIso();
        await this.client.executeD1(
          this.databaseId,
          `INSERT INTO telegram_update_receipt (
            id, update_id, status, lock_expires_at, created_at, updated_at
          ) VALUES (?, ?, 'processing', ?, ?, ?)`,
          [lockId, updateId, lockExpiresAt, timestamp, timestamp],
        );
        return "claimed";
      } catch (error) {
        if (error instanceof Error && /unique|constraint/i.test(error.message)) {
          continue;
        }
        throw error;
      }
    }

    return "in_progress";
  }

  public async completeTelegramUpdate(updateId: number): Promise<void> {
    await this.client.executeD1(
      this.databaseId,
      `UPDATE telegram_update_receipt
      SET status = 'completed',
          lock_expires_at = NULL,
          updated_at = ?
      WHERE update_id = ?`,
      [nowIso(), updateId],
    );
  }

  public async releaseTelegramUpdate(updateId: number): Promise<void> {
    await this.client.executeD1(
      this.databaseId,
      "DELETE FROM telegram_update_receipt WHERE update_id = ? AND status = 'processing'",
      [updateId],
    );
  }

  public async listAuditEvents(limit = 50): Promise<AuditEvent[]> {
    const rows = await this.listJsonTable("audit_event", AuditEventSchema);
    return rows
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  public async saveAuditEvent(event: AuditEvent): Promise<void> {
    await this.saveJsonRow("audit_event", {
      id: event.id,
      data: AuditEventSchema.parse(event),
    });
  }

  public async listImportExportRuns(limit = 50): Promise<ImportExportRun[]> {
    const rows = await this.listJsonTable("import_export_run", ImportExportRunSchema);
    return rows
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  public async saveImportExportRun(run: ImportExportRun): Promise<void> {
    await this.saveJsonRow("import_export_run", {
      id: run.id,
      data: ImportExportRunSchema.parse(run),
    });
  }

  public async listProviderTestRuns(args?: {
    providerId?: string;
    limit?: number;
  }): Promise<ProviderTestRun[]> {
    let rows = await this.listJsonTable("provider_test_run", ProviderTestRunSchema);
    if (args?.providerId) {
      rows = rows.filter((row) => row.providerId === args.providerId);
    }
    rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return typeof args?.limit === "number" ? rows.slice(0, args.limit) : rows;
  }

  public async saveProviderTestRun(run: ProviderTestRun): Promise<void> {
    await this.saveJsonRow("provider_test_run", {
      id: run.id,
      data: ProviderTestRunSchema.parse(run),
    });
  }

  private async listJsonTable<T>(
    table: string,
    schema: { parse(value: unknown): T },
  ): Promise<T[]> {
    const rows = await this.client.queryD1<{ data: string }>(
      this.databaseId,
      `SELECT data FROM ${table}`,
    );
    return rows.map((row) => schema.parse(JSON.parse(row.data)));
  }

  private async saveJsonRow<T extends { id: string; data: unknown }>(
    table: string,
    value: T,
  ): Promise<void> {
    await this.client.executeD1(
      this.databaseId,
      `INSERT INTO ${table} (id, data) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [value.id, JSON.stringify(value.data)],
    );
  }

  private async deleteJsonRow(table: string, id: string): Promise<void> {
    await this.client.executeD1(
      this.databaseId,
      `DELETE FROM ${table} WHERE id = ?`,
      [id],
    );
  }
}

export class InMemoryAppRepository implements AppRepository {
  private workspace: Workspace | null = null;
  private bootstrapState: BootstrapState = BootstrapStateSchema.parse({});
  private adminIdentity: AdminIdentity | null = null;
  private authSessions = new Map<string, {
    workspaceId: string;
    telegramUserId: string;
    jwtJti: string;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
  }>();
  private providerProfiles = new Map<string, ProviderProfile>();
  private agentProfiles = new Map<string, AgentProfile>();
  private installs = new Map<string, InstallRecord>();
  private searchSettings: SearchSettings | null = null;
  private tasks = new Map<string, Task>();
  private taskRuns = new Map<string, TaskRun>();
  private triggers = new Map<string, Trigger>();
  private approvalRequests = new Map<string, ApprovalRequest>();
  private executorNodes = new Map<string, ExecutorNode>();
  private mcpProviders = new Map<string, McpProviderConfig>();
  private mcpServers = new Map<string, McpServerConfig>();
  private secrets = new Map<string, SecretEnvelope>();
  private documents = new Map<string, DocumentMetadata>();
  private memoryDocuments = new Map<string, MemoryDocument>();
  private memoryChunks = new Map<string, MemoryChunk>();
  private conversationSummaries = new Map<string, ConversationSummary>();
  private conversationTurns = new Map<string, ConversationTurn>();
  private toolRuns = new Map<string, ToolRunRecord>();
  private jobs = new Map<string, JobRecord>();
  private conversations = new Map<string, ConversationRecord>();
  private conversationTurnLocks = new Map<string, {
    turnId: string;
    lockExpiresAt: string;
    updatedAt: string;
  }>();
  private messages = new Map<string, ConversationMessage[]>();
  private turnStateSnapshots = new Map<string, TurnState>();
  private turnEvents = new Map<string, TurnEvent>();
  private auditEvents = new Map<string, AuditEvent>();
  private importExportRuns = new Map<string, ImportExportRun>();
  private providerTestRuns = new Map<string, ProviderTestRun>();
  private telegramUpdates = new Map<number, {
    status: "processing" | "completed";
    lockExpiresAt: string | null;
    updatedAt: string;
  }>();
  private telegramLoginReceipts = new Map<string, TelegramLoginReceipt>();

  public async getWorkspace(): Promise<Workspace | null> {
    return this.workspace;
  }

  public async saveWorkspace(workspace: Workspace): Promise<void> {
    this.workspace = WorkspaceSchema.parse(workspace);
  }

  public async getBootstrapState(): Promise<BootstrapState> {
    return this.bootstrapState;
  }

  public async saveBootstrapState(state: BootstrapState): Promise<void> {
    this.bootstrapState = BootstrapStateSchema.parse(state);
  }

  public async getAdminIdentity(): Promise<AdminIdentity | null> {
    return this.adminIdentity;
  }

  public async saveAdminIdentity(identity: AdminIdentity): Promise<void> {
    this.adminIdentity = AdminIdentitySchema.parse(identity);
  }

  public async saveAuthSession(session: {
    workspaceId: string;
    telegramUserId: string;
    jwtJti: string;
    expiresAt: string;
  }): Promise<void> {
    const createdAt = nowIso();
    this.authSessions.set(session.jwtJti, {
      ...session,
      createdAt,
      revokedAt: null,
    });
  }

  public async getAuthSessionByJti(jwtJti: string): Promise<AuthSession | null> {
    const session = this.authSessions.get(jwtJti);
    if (!session) {
      return null;
    }
    return AuthSessionSchema.parse({
      id: `session:${session.jwtJti}`,
      ...session,
    });
  }

  public async revokeAuthSession(jwtJti: string): Promise<void> {
    const session = this.authSessions.get(jwtJti);
    if (!session) {
      return;
    }
    this.authSessions.set(jwtJti, {
      ...session,
      revokedAt: nowIso(),
    });
  }

  public async claimTelegramLoginReceipt(args: {
    receiptKey: string;
    telegramUserId: string;
    expiresAt: string;
  }): Promise<"claimed" | "duplicate"> {
    for (const [key, receipt] of this.telegramLoginReceipts.entries()) {
      if (Date.parse(receipt.expiresAt) <= Date.now()) {
        this.telegramLoginReceipts.delete(key);
      }
    }
    const existing = this.telegramLoginReceipts.get(args.receiptKey);
    if (existing && Date.parse(existing.expiresAt) > Date.now()) {
      return "duplicate";
    }
    const timestamp = nowIso();
    this.telegramLoginReceipts.set(
      args.receiptKey,
      TelegramLoginReceiptSchema.parse({
        id: existing?.id ?? createId("tglogin"),
        receiptKey: args.receiptKey,
        telegramUserId: args.telegramUserId,
        expiresAt: args.expiresAt,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }),
    );
    return "claimed";
  }

  public async listProviderProfiles(): Promise<ProviderProfile[]> {
    return [...this.providerProfiles.values()];
  }

  public async saveProviderProfile(profile: ProviderProfile): Promise<void> {
    const parsed = ProviderProfileSchema.parse(profile);
    this.providerProfiles.set(parsed.id, parsed);
  }

  public async deleteProviderProfile(id: string): Promise<void> {
    this.providerProfiles.delete(id);
  }

  public async listAgentProfiles(): Promise<AgentProfile[]> {
    return [...this.agentProfiles.values()];
  }

  public async saveAgentProfile(profile: AgentProfile): Promise<void> {
    const parsed = AgentProfileSchema.parse(profile);
    this.agentProfiles.set(parsed.id, parsed);
  }

  public async deleteAgentProfile(id: string): Promise<void> {
    this.agentProfiles.delete(id);
  }

  public async listInstallRecords(kind?: InstallRecord["kind"]): Promise<InstallRecord[]> {
    const records = [...this.installs.values()];
    return kind ? records.filter((item) => item.kind === kind) : records;
  }

  public async saveInstallRecord(record: InstallRecord): Promise<void> {
    const parsed = InstallRecordSchema.parse(record);
    this.installs.set(parsed.id, parsed);
  }

  public async deleteInstallRecord(
    kind: InstallRecord["kind"],
    manifestId: string,
  ): Promise<void> {
    for (const [id, record] of this.installs.entries()) {
      if (record.kind === kind && record.manifestId === manifestId) {
        this.installs.delete(id);
      }
    }
  }

  public async getSearchSettings(): Promise<SearchSettings> {
    if (this.searchSettings) {
      return this.searchSettings;
    }
    const timestamp = nowIso();
    return SearchSettingsSchema.parse({
      id: "main",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  public async saveSearchSettings(settings: SearchSettings): Promise<void> {
    this.searchSettings = SearchSettingsSchema.parse(settings);
  }

  public async listTasks(): Promise<Task[]> {
    return [...this.tasks.values()];
  }

  public async getTask(id: string): Promise<Task | null> {
    return this.tasks.get(id) ?? null;
  }

  public async saveTask(task: Task): Promise<void> {
    const parsed = TaskSchema.parse(task);
    this.tasks.set(parsed.id, parsed);
  }

  public async listTaskRuns(args?: {
    taskId?: string;
    status?: TaskRun["status"];
    executorId?: string;
    limit?: number;
  }): Promise<TaskRun[]> {
    let rows = [...this.taskRuns.values()].filter((taskRun) => {
      if (args?.taskId && taskRun.taskId !== args.taskId) {
        return false;
      }
      if (args?.status && taskRun.status !== args.status) {
        return false;
      }
      if (args?.executorId && taskRun.executorId !== args.executorId) {
        return false;
      }
      return true;
    });
    rows = rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return typeof args?.limit === "number" ? rows.slice(0, args.limit) : rows;
  }

  public async getTaskRun(id: string): Promise<TaskRun | null> {
    return this.taskRuns.get(id) ?? null;
  }

  public async saveTaskRun(taskRun: TaskRun): Promise<void> {
    const parsed = TaskRunSchema.parse(taskRun);
    this.taskRuns.set(parsed.id, parsed);
  }

  public async listTriggers(args?: {
    taskId?: string;
    kind?: Trigger["kind"];
    enabled?: boolean;
  }): Promise<Trigger[]> {
    return [...this.triggers.values()]
      .filter((trigger) => {
        if (args?.taskId && trigger.taskId !== args.taskId) {
          return false;
        }
        if (args?.kind && trigger.kind !== args.kind) {
          return false;
        }
        if (typeof args?.enabled === "boolean" && trigger.enabled !== args.enabled) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async getTrigger(id: string): Promise<Trigger | null> {
    return this.triggers.get(id) ?? null;
  }

  public async saveTrigger(trigger: Trigger): Promise<void> {
    const parsed = TriggerSchema.parse(trigger);
    this.triggers.set(parsed.id, parsed);
  }

  public async listApprovalRequests(args?: {
    taskRunId?: string;
    status?: ApprovalRequest["status"];
    limit?: number;
  }): Promise<ApprovalRequest[]> {
    let rows = [...this.approvalRequests.values()].filter((approval) => {
      if (args?.taskRunId && approval.taskRunId !== args.taskRunId) {
        return false;
      }
      if (args?.status && approval.status !== args.status) {
        return false;
      }
      return true;
    });
    rows = rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return typeof args?.limit === "number" ? rows.slice(0, args.limit) : rows;
  }

  public async getApprovalRequest(id: string): Promise<ApprovalRequest | null> {
    return this.approvalRequests.get(id) ?? null;
  }

  public async saveApprovalRequest(approval: ApprovalRequest): Promise<void> {
    const parsed = ApprovalRequestSchema.parse(approval);
    this.approvalRequests.set(parsed.id, parsed);
  }

  public async listExecutorNodes(): Promise<ExecutorNode[]> {
    return [...this.executorNodes.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async getExecutorNode(id: string): Promise<ExecutorNode | null> {
    return this.executorNodes.get(id) ?? null;
  }

  public async saveExecutorNode(executor: ExecutorNode): Promise<void> {
    const parsed = ExecutorNodeSchema.parse(executor);
    this.executorNodes.set(parsed.id, parsed);
  }

  public async listMcpServers(): Promise<McpServerConfig[]> {
    return [...this.mcpServers.values()];
  }

  public async saveMcpServer(server: McpServerConfig): Promise<void> {
    const parsed = McpServerConfigSchema.parse(server);
    this.mcpServers.set(parsed.id, parsed);
  }

  public async deleteMcpServer(id: string): Promise<void> {
    this.mcpServers.delete(id);
  }

  public async listMcpProviders(): Promise<McpProviderConfig[]> {
    return [...this.mcpProviders.values()];
  }

  public async saveMcpProvider(provider: McpProviderConfig): Promise<void> {
    const parsed = McpProviderConfigSchema.parse(provider);
    this.mcpProviders.set(parsed.id, parsed);
  }

  public async deleteMcpProvider(id: string): Promise<void> {
    this.mcpProviders.delete(id);
  }

  public async listSecrets(): Promise<SecretEnvelope[]> {
    return [...this.secrets.values()];
  }

  public async getSecretByScope(
    workspaceId: string,
    scope: string,
  ): Promise<SecretEnvelope | null> {
    return [...this.secrets.values()].find(
      (item) => item.workspaceId === workspaceId && item.scope === scope,
    ) ?? null;
  }

  public async saveSecret(secret: SecretEnvelope): Promise<void> {
    const parsed = SecretEnvelopeSchema.parse(secret);
    const existing = await this.getSecretByScope(parsed.workspaceId, parsed.scope);
    const next = existing
      ? {
          ...parsed,
          id: existing.id,
          createdAt: existing.createdAt,
        }
      : parsed;
    this.secrets.set(next.id, next);
  }

  public async clearWorkspaceForImport(workspaceId: string): Promise<void> {
    void workspaceId;
    this.workspace = null;
    this.adminIdentity = null;
    this.providerProfiles.clear();
    this.agentProfiles.clear();
    this.installs.clear();
    this.searchSettings = null;
    this.tasks.clear();
    this.taskRuns.clear();
    this.triggers.clear();
    this.approvalRequests.clear();
    this.executorNodes.clear();
    this.mcpProviders.clear();
    this.mcpServers.clear();
    this.secrets.clear();
    this.documents.clear();
    this.memoryDocuments.clear();
    this.memoryChunks.clear();
    this.conversationSummaries.clear();
    this.conversationTurns.clear();
    this.toolRuns.clear();
    this.jobs.clear();
    this.conversations.clear();
    this.conversationTurnLocks.clear();
    this.messages.clear();
    this.turnStateSnapshots.clear();
    this.turnEvents.clear();
    this.auditEvents.clear();
    this.importExportRuns.clear();
    this.providerTestRuns.clear();
    this.telegramUpdates.clear();
    this.telegramLoginReceipts.clear();
  }

  public async listDocuments(): Promise<DocumentMetadata[]> {
    return [...this.documents.values()];
  }

  public async saveDocument(document: DocumentMetadata): Promise<void> {
    const parsed = DocumentMetadataSchema.parse(document);
    this.documents.set(parsed.id, parsed);
  }

  public async listMemoryDocuments(): Promise<MemoryDocument[]> {
    return [...this.memoryDocuments.values()];
  }

  public async saveMemoryDocument(document: MemoryDocument): Promise<void> {
    const parsed = MemoryDocumentSchema.parse(document);
    this.memoryDocuments.set(parsed.id, parsed);
  }

  public async listMemoryChunks(args?: {
    documentId?: string;
    workspaceId?: string;
  }): Promise<MemoryChunk[]> {
    return [...this.memoryChunks.values()].filter((chunk) => {
      if (args?.documentId && chunk.documentId !== args.documentId) {
        return false;
      }
      if (args?.workspaceId && chunk.workspaceId !== args.workspaceId) {
        return false;
      }
      return true;
    });
  }

  public async saveMemoryChunk(chunk: MemoryChunk): Promise<void> {
    const parsed = MemoryChunkSchema.parse(chunk);
    this.memoryChunks.set(parsed.id, parsed);
  }

  public async deleteMemoryChunksByDocument(documentId: string): Promise<void> {
    for (const [id, chunk] of this.memoryChunks.entries()) {
      if (chunk.documentId === documentId) {
        this.memoryChunks.delete(id);
      }
    }
  }

  public async listConversationSummaries(
    conversationId: string,
  ): Promise<ConversationSummary[]> {
    return [...this.conversationSummaries.values()].filter(
      (item) => item.conversationId === conversationId,
    );
  }

  public async saveConversationSummary(summary: ConversationSummary): Promise<void> {
    const parsed = ConversationSummarySchema.parse(summary);
    this.conversationSummaries.set(parsed.id, parsed);
  }

  public async listConversationTurns(args?: {
    conversationId?: string;
    status?: ConversationTurn["status"];
    limit?: number;
  }): Promise<ConversationTurn[]> {
    let rows = [...this.conversationTurns.values()].filter((turn) => {
      if (args?.conversationId && turn.conversationId !== args.conversationId) {
        return false;
      }
      if (args?.status && turn.status !== args.status) {
        return false;
      }
      return true;
    });
    rows = rows.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return typeof args?.limit === "number" ? rows.slice(0, args.limit) : rows;
  }

  public async getConversationTurn(id: string): Promise<ConversationTurn | null> {
    return this.conversationTurns.get(id) ?? null;
  }

  public async saveConversationTurn(turn: ConversationTurn): Promise<void> {
    const parsed = ConversationTurnSchema.parse(turn);
    this.conversationTurns.set(parsed.id, parsed);
  }

  public async listToolRuns(conversationId?: string): Promise<ToolRunRecord[]> {
    const rows = [...this.toolRuns.values()];
    return conversationId
      ? rows.filter((item) => item.conversationId === conversationId)
      : rows;
  }

  public async saveToolRun(record: ToolRunRecord): Promise<void> {
    const parsed = ToolRunRecordSchema.parse(record);
    this.toolRuns.set(parsed.id, parsed);
  }

  public async listJobs(args?: {
    status?: JobRecord["status"];
    kind?: JobRecord["kind"];
  }): Promise<JobRecord[]> {
    return [...this.jobs.values()].filter((job) => {
      if (args?.status && job.status !== args.status) {
        return false;
      }
      if (args?.kind && job.kind !== args.kind) {
        return false;
      }
      return true;
    });
  }

  public async getJob(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  public async saveJob(job: JobRecord): Promise<void> {
    const parsed = JobRecordSchema.parse(job);
    this.jobs.set(parsed.id, parsed);
  }

  public async getConversation(id: string): Promise<ConversationRecord | null> {
    return this.conversations.get(id) ?? null;
  }

  public async listConversations(): Promise<ConversationRecord[]> {
    return [...this.conversations.values()];
  }

  public async saveConversation(conversation: ConversationRecord): Promise<void> {
    const parsed = ConversationRecordSchema.parse(conversation);
    this.conversations.set(parsed.id, parsed);
  }

  public async claimConversationTurnLock(args: {
    conversationId: string;
    turnId: string;
    lockExpiresAt: string;
  }): Promise<ConversationTurnLockClaimResult> {
    const existing = this.conversationTurnLocks.get(args.conversationId);
    if (existing && Date.parse(existing.lockExpiresAt) > Date.now()) {
      return "in_progress";
    }
    this.conversationTurnLocks.set(args.conversationId, {
      turnId: args.turnId,
      lockExpiresAt: args.lockExpiresAt,
      updatedAt: nowIso(),
    });
    return "claimed";
  }

  public async releaseConversationTurnLock(
    conversationId: string,
    turnId?: string,
  ): Promise<void> {
    const existing = this.conversationTurnLocks.get(conversationId);
    if (!existing) {
      return;
    }
    if (turnId && existing.turnId !== turnId) {
      return;
    }
    this.conversationTurnLocks.delete(conversationId);
  }

  public async listConversationMessages(
    conversationId: string,
  ): Promise<ConversationMessage[]> {
    return this.messages.get(conversationId) ?? [];
  }

  public async appendConversationMessage(
    conversationId: string,
    message: ConversationMessage,
  ): Promise<void> {
    await this.saveConversationMessage(conversationId, message);
  }

  public async saveConversationMessage(
    conversationId: string,
    message: ConversationMessage,
  ): Promise<void> {
    const parsed = MessageRecordSchema.parse({
      ...message,
      conversationId,
    });
    const list = this.messages.get(conversationId) ?? [];
    const existingIndex = list.findIndex((item) => item.id === parsed.id);
    if (existingIndex >= 0) {
      list[existingIndex] = parsed;
    } else {
      list.push(parsed);
    }
    list.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    this.messages.set(conversationId, list);
  }

  public async getLatestTurnState(turnId: string): Promise<TurnState | null> {
    const states = [...this.turnStateSnapshots.values()]
      .filter((state) => state.turnId === turnId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return states[0] ?? null;
  }

  public async saveTurnStateSnapshot(state: TurnState): Promise<void> {
    const parsed = TurnStateSchema.parse(state);
    this.turnStateSnapshots.set(parsed.id, parsed);
  }

  public async appendTurnEvent(event: TurnEvent): Promise<void> {
    const parsed = TurnEventSchema.parse(event);
    if (this.turnEvents.has(parsed.id)) {
      return;
    }
    this.turnEvents.set(parsed.id, parsed);
  }

  public async listTurnEvents(
    turnId: string,
    args?: {
      cursorSeq?: number;
      limit?: number;
    },
  ): Promise<TurnEvent[]> {
    const limit = Math.min(Math.max(args?.limit ?? 100, 1), 500);
    return [...this.turnEvents.values()]
      .filter((event) => {
        if (event.turnId !== turnId) {
          return false;
        }
        if (typeof args?.cursorSeq === "number" && event.seq <= args.cursorSeq) {
          return false;
        }
        return true;
      })
      .sort((left, right) => left.seq - right.seq)
      .slice(0, limit);
  }

  public async pruneTurnEventsOlderThan(cutoffIso: string): Promise<number> {
    let deleted = 0;
    for (const [id, event] of this.turnEvents.entries()) {
      if (event.occurredAt < cutoffIso) {
        this.turnEvents.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  public async claimTelegramUpdate(
    updateId: number,
    lockExpiresAt: string,
  ): Promise<TelegramUpdateClaimResult> {
    const existing = this.telegramUpdates.get(updateId);
    if (existing?.status === "completed") {
      return "duplicate";
    }
    if (
      existing?.status === "processing" &&
      existing.lockExpiresAt &&
      Date.parse(existing.lockExpiresAt) > Date.now()
    ) {
      return "in_progress";
    }
    this.telegramUpdates.set(updateId, {
      status: "processing",
      lockExpiresAt,
      updatedAt: nowIso(),
    });
    return "claimed";
  }

  public async completeTelegramUpdate(updateId: number): Promise<void> {
    const existing = this.telegramUpdates.get(updateId);
    if (!existing) {
      return;
    }
    this.telegramUpdates.set(updateId, {
      status: "completed",
      lockExpiresAt: null,
      updatedAt: nowIso(),
    });
  }

  public async releaseTelegramUpdate(updateId: number): Promise<void> {
    const existing = this.telegramUpdates.get(updateId);
    if (!existing || existing.status !== "processing") {
      return;
    }
    this.telegramUpdates.delete(updateId);
  }

  public async listAuditEvents(limit = 50): Promise<AuditEvent[]> {
    return [...this.auditEvents.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  public async saveAuditEvent(event: AuditEvent): Promise<void> {
    const parsed = AuditEventSchema.parse(event);
    this.auditEvents.set(parsed.id, parsed);
  }

  public async listImportExportRuns(limit = 50): Promise<ImportExportRun[]> {
    return [...this.importExportRuns.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  public async saveImportExportRun(run: ImportExportRun): Promise<void> {
    const parsed = ImportExportRunSchema.parse(run);
    this.importExportRuns.set(parsed.id, parsed);
  }

  public async listProviderTestRuns(args?: {
    providerId?: string;
    limit?: number;
  }): Promise<ProviderTestRun[]> {
    let rows = [...this.providerTestRuns.values()];
    if (args?.providerId) {
      rows = rows.filter((run) => run.providerId === args.providerId);
    }
    rows = rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return typeof args?.limit === "number" ? rows.slice(0, args.limit) : rows;
  }

  public async saveProviderTestRun(run: ProviderTestRun): Promise<void> {
    const parsed = ProviderTestRunSchema.parse(run);
    this.providerTestRuns.set(parsed.id, parsed);
  }
}

export function requireWorkspace(
  workspace: Workspace | null,
): asserts workspace is Workspace {
  if (!workspace) {
    throw new AppError("WORKSPACE_NOT_READY", "Workspace has not been initialized", 409);
  }
}
