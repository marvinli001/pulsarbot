import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createLogger,
  createId,
  nowIso,
  sha256,
} from "@pulsarbot/core";
import {
  McpServerConfigSchema,
  type McpServerConfig,
  type ToolDescriptor,
} from "@pulsarbot/shared";

export interface McpHealthResult {
  status: "ok" | "error";
  checkedAt: string;
  detail: string;
  toolCount?: number;
  logs?: string[];
}

export interface McpSupervisorOptions {
  logDir?: string;
}

interface McpSession {
  fingerprint: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  logs: string[];
  tools: ToolDescriptor[];
  closed: boolean;
}

const logger = createLogger({ name: "mcp" });

function compactStringRecord(
  input: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => typeof value === "string"),
  ) as Record<string, string>;
}

function toolId(serverId: string, toolName: string): string {
  return `mcp:${serverId}:${toolName}`;
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown MCP error";
}

function resolveStandardBailianSseUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (!/^\/api\/v1\/mcps\/[^/]+\/mcp\/?$/i.test(parsed.pathname)) {
      return null;
    }
    parsed.pathname = parsed.pathname.replace(/\/mcp\/?$/i, "/sse");
    return parsed;
  } catch {
    return null;
  }
}

function shouldTrySseFallback(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) {
    return typeof error.code === "number" && error.code >= 400 && error.code < 500;
  }
  return error instanceof Error;
}

function normalizeContent(result: Record<string, unknown>) {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(
      (item): item is { type: string; text?: string } =>
        Boolean(item) && typeof item === "object" && "type" in item,
    )
    .map((item) =>
      item.type === "text" && typeof item.text === "string"
        ? item.text
        : JSON.stringify(item),
    )
    .join("\n")
    .trim();

  return {
    ...result,
    text,
  };
}

function normalizeInputSchema(schema: unknown): ToolDescriptor["inputSchema"] {
  return JSON.parse(
    JSON.stringify(
      schema ?? {
        type: "object",
        properties: {},
      },
    ),
  ) as ToolDescriptor["inputSchema"];
}

export class McpSupervisor {
  private readonly sessions = new Map<string, McpSession>();
  private logDirReady: Promise<void> | null = null;

  public constructor(private readonly options: McpSupervisorOptions = {}) {}

  public async validate(config: McpServerConfig): Promise<McpServerConfig> {
    const parsed = McpServerConfigSchema.parse(config);

    if (parsed.transport === "stdio" && !parsed.command) {
      throw new Error("stdio MCP requires a command");
    }

    if (parsed.transport === "streamable_http" && !parsed.url) {
      throw new Error("streamable_http MCP requires a URL");
    }

    return parsed;
  }

  public async healthcheck(config: McpServerConfig): Promise<McpHealthResult> {
    try {
      const session = await this.getSession(config, { refreshTools: true });
      return {
        status: "ok",
        checkedAt: nowIso(),
        detail: `Connected to ${config.label}`,
        toolCount: session.tools.length,
        logs: session.logs.slice(-20),
      };
    } catch (error) {
      return {
        status: "error",
        checkedAt: nowIso(),
        detail: normalizeError(error),
      };
    }
  }

  public async listToolDescriptors(
    configs: McpServerConfig[],
  ): Promise<ToolDescriptor[]> {
    const descriptors = await Promise.all(
      configs
        .filter((config) => config.enabled)
        .map(async (config) => {
          try {
            return (await this.getSession(config, { refreshTools: true })).tools;
          } catch (error) {
            const message = normalizeError(error);
            this.recordLog(
              config.id,
              this.sessions.get(config.id)?.logs ?? [],
              `tool discovery failed: ${message}`,
            );
            logger.error(
              {
                serverId: config.id,
                label: config.label,
                transport: config.transport,
                error: message,
              },
              "Failed to list MCP tool descriptors",
            );
            return [];
          }
        }),
    );

    return descriptors.flat();
  }

  public async invokeTool(
    fullToolId: string,
    input: Record<string, unknown>,
    configs: McpServerConfig[],
  ): Promise<unknown> {
    const match = /^mcp:([^:]+):(.+)$/.exec(fullToolId);
    if (!match) {
      throw new Error(`Invalid MCP tool id: ${fullToolId}`);
    }

    const [, serverId, toolName] = match;
    const config = configs.find((item) => item.id === serverId && item.enabled);
    if (!config || !toolName) {
      throw new Error(`MCP server not found or disabled: ${serverId}`);
    }

    const session = await this.getSession(config, { refreshTools: false });
    const response = (await session.client.callTool({
      name: toolName,
      arguments: input,
    })) as Record<string, unknown>;

    return normalizeContent(response);
  }

  public async closeServer(serverId: string): Promise<void> {
    const existing = this.sessions.get(serverId);
    if (!existing) {
      return;
    }

    await existing.client.close();
    this.sessions.delete(serverId);
  }

  public async closeAll(): Promise<void> {
    for (const serverId of this.sessions.keys()) {
      await this.closeServer(serverId);
    }
  }

  public async readServerLogs(
    serverId: string,
    options: { tailLines?: number } = {},
  ): Promise<string[]> {
    const liveLogs = this.sessions.get(serverId)?.logs ?? [];
    const persistedLogs = this.options.logDir
      ? await this.readPersistedLogs(serverId)
      : [];
    const merged = [...persistedLogs, ...liveLogs];
    const tailLines = options.tailLines ?? 200;
    return merged.slice(-tailLines);
  }

  public createDraftConfig(): McpServerConfig {
    const timestamp = nowIso();
    return {
      id: createId("mcp"),
      label: "MCP Server",
      description: "",
      manifestId: null,
      transport: "stdio",
      args: [],
      envRefs: {},
      headers: {},
      restartPolicy: "on-failure",
      toolCache: {},
      lastHealthStatus: "unknown",
      lastHealthCheckedAt: null,
      enabled: false,
      source: "custom",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private createClient(): Client {
    return new Client(
      {
        name: "pulsarbot-mcp-client",
        version: "0.1.0",
      },
      {
        capabilities: {},
      },
    );
  }

  private async getSession(
    config: McpServerConfig,
    options: { refreshTools: boolean },
  ): Promise<McpSession> {
    const parsed = await this.validate(config);
    const fingerprint = sha256(
      JSON.stringify({
        transport: parsed.transport,
        command: parsed.command,
        args: parsed.args,
        url: parsed.url,
        envRefs: parsed.envRefs,
        headers: parsed.headers,
      }),
    );
    const existing = this.sessions.get(parsed.id);

    if (existing && existing.fingerprint === fingerprint && !existing.closed) {
      if (options.refreshTools) {
        existing.tools = await this.fetchTools(existing.client, parsed);
      }
      return existing;
    }

    if (existing?.closed && existing.fingerprint === fingerprint) {
      if (parsed.restartPolicy === "never") {
        throw new Error(`MCP server ${parsed.label} is closed and restartPolicy=never`);
      }
      this.sessions.delete(parsed.id);
    }

    if (existing && !existing.closed) {
      await existing.client.close();
      this.sessions.delete(parsed.id);
    }

    const logs: string[] = [];
    const {
      client,
      transport,
      transportLabel,
    } = await this.connectTransport(parsed, logs);

    if ("stderr" in transport && transport.stderr) {
      transport.stderr.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (!text) {
          return;
        }
        this.recordLog(parsed.id, logs, text);
      });
    }
    transport.onclose = () => {
      const session = this.sessions.get(parsed.id);
      if (!session) {
        return;
      }
      session.closed = true;
      this.recordLog(
        parsed.id,
        logs,
        `transport closed restartPolicy=${parsed.restartPolicy}`,
      );
    };

    const session: McpSession = {
      fingerprint,
      client,
      transport,
      logs,
      tools: options.refreshTools ? await this.fetchTools(client, parsed) : [],
      closed: false,
    };
    this.recordLog(parsed.id, logs, `connected transport=${transportLabel}`);
    this.sessions.set(parsed.id, session);
    return session;
  }

  private async connectTransport(
    config: McpServerConfig,
    logs: string[],
  ): Promise<{
    client: Client;
    transport: McpSession["transport"];
    transportLabel: string;
  }> {
    if (config.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: config.command!,
        args: config.args,
        env: compactStringRecord({
          ...process.env,
          ...config.envRefs,
        }),
        stderr: "pipe",
      });
      const client = this.createClient();
      await client.connect(transport as Parameters<Client["connect"]>[0]);
      return {
        client,
        transport,
        transportLabel: "stdio",
      };
    }

    return this.connectRemoteTransport(config, logs);
  }

  private async connectRemoteTransport(
    config: McpServerConfig,
    logs: string[],
  ): Promise<{
    client: Client;
    transport: StreamableHTTPClientTransport | SSEClientTransport;
    transportLabel: string;
  }> {
    const streamableTransport = new StreamableHTTPClientTransport(new URL(config.url!), {
      requestInit: {
        headers: config.headers,
      },
    });
    const streamableClient = this.createClient();

    try {
      await streamableClient.connect(
        streamableTransport as Parameters<Client["connect"]>[0],
      );
      return {
        client: streamableClient,
        transport: streamableTransport,
        transportLabel: "streamable_http",
      };
    } catch (error) {
      await Promise.allSettled([
        streamableClient.close(),
        streamableTransport.close(),
      ]);

      const fallbackUrl = resolveStandardBailianSseUrl(config.url!);
      if (!fallbackUrl || !shouldTrySseFallback(error)) {
        throw error;
      }

      this.recordLog(
        config.id,
        logs,
        `streamable_http connect failed, trying sse fallback url=${fallbackUrl.toString()} error=${normalizeError(error)}`,
      );

      const sseTransport = new SSEClientTransport(fallbackUrl, {
        requestInit: {
          headers: config.headers,
        },
      });
      const sseClient = this.createClient();

      try {
        await sseClient.connect(sseTransport as Parameters<Client["connect"]>[0]);
        return {
          client: sseClient,
          transport: sseTransport,
          transportLabel: "sse fallback_from=streamable_http",
        };
      } catch (fallbackError) {
        await Promise.allSettled([
          sseClient.close(),
          sseTransport.close(),
        ]);
        throw new Error(
          `Failed to connect using streamable_http and sse fallback: primary=${normalizeError(error)} fallback=${normalizeError(fallbackError)}`,
        );
      }
    }
  }

  private async fetchTools(
    client: Client,
    config: McpServerConfig,
  ): Promise<ToolDescriptor[]> {
    const response = await client.listTools();
    return response.tools.map((tool) => ({
      id: toolId(config.id, tool.name),
      title: tool.title ?? tool.name,
      description:
        tool.description ??
        `Tool exposed by MCP server ${config.label}.`,
      inputSchema: normalizeInputSchema(tool.inputSchema),
      permissionScopes: ["mcp:invoke"],
      source: "mcp" as const,
    }));
  }

  private recordLog(serverId: string, target: string[], line: string) {
    target.push(line);
    if (target.length > 200) {
      target.splice(0, target.length - 200);
    }
    void this.persistLog(serverId, line).catch(() => undefined);
  }

  private async persistLog(serverId: string, line: string): Promise<void> {
    if (!this.options.logDir) {
      return;
    }
    await this.ensureLogDir();
    await appendFile(
      this.logFilePath(serverId),
      `[${nowIso()}] ${line}\n`,
      "utf8",
    );
  }

  private async ensureLogDir(): Promise<void> {
    if (!this.options.logDir) {
      return;
    }
    if (!this.logDirReady) {
      this.logDirReady = mkdir(this.options.logDir, { recursive: true }).then(
        () => undefined,
      );
    }
    await this.logDirReady;
  }

  private logFilePath(serverId: string): string {
    if (!this.options.logDir) {
      throw new Error("MCP log directory is not configured");
    }
    return path.join(
      this.options.logDir,
      `${serverId.replace(/[^a-zA-Z0-9._-]+/g, "_")}.log`,
    );
  }

  private async readPersistedLogs(serverId: string): Promise<string[]> {
    try {
      const raw = await readFile(this.logFilePath(serverId), "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

export function createMcpSupervisor(
  options: McpSupervisorOptions = {},
): McpSupervisor {
  return new McpSupervisor(options);
}
