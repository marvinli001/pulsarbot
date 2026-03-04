import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError, createId, deriveHkdfKeyMaterial, nowIso } from "@pulsarbot/core";
import { CloudflareApiClient } from "@pulsarbot/cloudflare";
import {
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
  JobRecordSchema,
  McpServerConfigSchema,
  MemoryChunkSchema,
  MemoryDocumentSchema,
  MessageRecordSchema,
  ProviderProfileSchema,
  ProviderTestRunSchema,
  SearchSettingsSchema,
  SecretEnvelopeSchema,
  ToolRunRecordSchema,
  WorkspaceSchema,
  type AdminIdentity,
  type AgentProfile,
  type AuditEvent,
  type BootstrapState,
  type ConversationRecord,
  type ConversationSummary,
  type ConversationTurn,
  type DocumentMetadata,
  type ImportExportRun,
  type InstallRecord,
  type JobRecord,
  type McpServerConfig,
  type MemoryChunk,
  type MemoryDocument,
  type MessageRecord,
  type ProviderProfile,
  type ProviderTestRun,
  type SearchSettings,
  type SecretEnvelope,
  type ToolRunRecord,
  type Workspace,
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
  `CREATE TABLE IF NOT EXISTS mcp_server (
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
];

const alterStatements = [
  "ALTER TABLE workspace ADD COLUMN active_agent_profile_id TEXT",
  "ALTER TABLE message ADD COLUMN source_type TEXT NOT NULL DEFAULT 'text'",
  "ALTER TABLE message ADD COLUMN telegram_message_id TEXT",
  "ALTER TABLE message ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'",
];

function isIgnorableMigrationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /duplicate column name|already exists|duplicate/i.test(error.message);
}

export const migrationStatements = [...createTableStatements, ...alterStatements];

export async function runMigrations(
  client: CloudflareApiClient,
  databaseId: string,
): Promise<void> {
  for (const statement of createTableStatements) {
    await client.executeD1(databaseId, statement);
  }
  for (const statement of alterStatements) {
    try {
      await client.executeD1(databaseId, statement);
    } catch (error) {
      if (!isIgnorableMigrationError(error)) {
        throw error;
      }
    }
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
  listMcpServers(): Promise<McpServerConfig[]>;
  saveMcpServer(server: McpServerConfig): Promise<void>;
  deleteMcpServer(id: string): Promise<void>;
  listSecrets(): Promise<SecretEnvelope[]>;
  getSecretByScope(workspaceId: string, scope: string): Promise<SecretEnvelope | null>;
  saveSecret(secret: SecretEnvelope): Promise<void>;
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
  listConversationMessages(conversationId: string): Promise<ConversationMessage[]>;
  appendConversationMessage(
    conversationId: string,
    message: ConversationMessage,
  ): Promise<void>;
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
    const records = await this.listJsonTable("install_record", InstallRecordSchema);
    return kind ? records.filter((item) => item.kind === kind) : records;
  }

  public async saveInstallRecord(record: InstallRecord): Promise<void> {
    await this.saveJsonRow("install_record", {
      id: record.id,
      data: InstallRecordSchema.parse(record),
    });
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
    const rows = await this.listJsonTable("memory_chunk", MemoryChunkSchema);
    return rows.filter((row) => {
      if (args?.documentId && row.documentId !== args.documentId) {
        return false;
      }
      if (args?.workspaceId && row.workspaceId !== args.workspaceId) {
        return false;
      }
      return true;
    });
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
    const parsed = MessageRecordSchema.parse({
      ...message,
      conversationId,
    });
    await this.client.executeD1(
      this.databaseId,
      `INSERT INTO message (
        id, conversation_id, role, content, source_type, telegram_message_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
  private messages = new Map<string, ConversationMessage[]>();
  private auditEvents = new Map<string, AuditEvent>();
  private importExportRuns = new Map<string, ImportExportRun>();
  private providerTestRuns = new Map<string, ProviderTestRun>();

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

  public async listConversationMessages(
    conversationId: string,
  ): Promise<ConversationMessage[]> {
    return this.messages.get(conversationId) ?? [];
  }

  public async appendConversationMessage(
    conversationId: string,
    message: ConversationMessage,
  ): Promise<void> {
    const parsed = MessageRecordSchema.parse({
      ...message,
      conversationId,
    });
    const list = this.messages.get(conversationId) ?? [];
    list.push(parsed);
    this.messages.set(conversationId, list);
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
