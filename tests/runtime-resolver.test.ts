import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefaultInstallRecords,
  loadMarketCatalog,
  resolveRuntimeSnapshot,
} from "../packages/market/src/index.js";
import type {
  AgentProfile,
  InstallRecord,
  McpServerConfig,
  SearchSettings,
} from "../packages/shared/src/index.js";

function createProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  const timestamp = new Date().toISOString();
  return {
    id: "profile-balanced",
    label: "balanced",
    description: "",
    systemPrompt: "You are Pulsarbot.",
    primaryModelProfileId: "provider-primary",
    backgroundModelProfileId: null,
    embeddingModelProfileId: null,
    enabledSkillIds: ["core-agent", "memory-core"],
    enabledPluginIds: ["native-google-search", "web-browse-fetcher"],
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
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function createSearchSettings(): SearchSettings {
  const timestamp = new Date().toISOString();
  return {
    id: "main",
    providerPriority: ["google_native", "exa_mcp", "web_browse"],
    allowNetwork: true,
    fallbackStrategy: "exa_then_browse",
    maxResults: 5,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function setInstallEnabled(
  installs: InstallRecord[],
  kind: InstallRecord["kind"],
  manifestId: string,
  enabled: boolean,
) {
  const target = installs.find((install) =>
    install.kind === kind && install.manifestId === manifestId
  );
  if (!target) {
    throw new Error(`Missing install record for ${kind}:${manifestId}`);
  }
  target.enabled = enabled;
}

function createOfficialMcpServer(): McpServerConfig {
  const timestamp = new Date().toISOString();
  return {
    id: "mcp-exa",
    label: "Exa Search",
    description: "",
    manifestId: "exa-search",
    transport: "stdio",
    command: "uvx",
    args: ["exa-mcp"],
    envRefs: {},
    headers: {},
    restartPolicy: "on-failure",
    toolCache: {},
    lastHealthStatus: "unknown",
    lastHealthCheckedAt: null,
    enabled: true,
    source: "official",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createBailianSyncedServer(): McpServerConfig {
  const timestamp = new Date().toISOString();
  return {
    id: "mcp_bailian_weather",
    label: "Bailian Weather",
    description: "",
    manifestId: "alibaba-bailian",
    transport: "streamable_http",
    url: "https://dashscope.aliyuncs.com/api/v1/mcps/weather/mcp",
    args: [],
    envRefs: {},
    headers: {
      Authorization: "Bearer {{secret:provider:bailian:apiKey}}",
      api_key: "{{secret:provider:bailian:apiKey}}",
    },
    restartPolicy: "on-failure",
    toolCache: {},
    lastHealthStatus: "unknown",
    lastHealthCheckedAt: null,
    enabled: true,
    source: "bailian_market",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("runtime resolver", () => {
  it("resolves enabled skills and plugins from installed manifests only", async () => {
    const catalog = await loadMarketCatalog(path.resolve(process.cwd(), "market"));
    const installs = createDefaultInstallRecords(catalog);
    setInstallEnabled(installs, "skills", "core-agent", true);
    setInstallEnabled(installs, "skills", "memory-core", true);
    setInstallEnabled(installs, "plugins", "native-google-search", false);
    setInstallEnabled(installs, "plugins", "web-browse-fetcher", true);

    const snapshot = resolveRuntimeSnapshot({
      workspaceId: "main",
      profile: createProfile(),
      searchSettings: createSearchSettings(),
      catalog,
      installs,
      mcpServers: [],
    });

    expect(snapshot.enabledSkills.map((item) => item.id)).toEqual([
      "core-agent",
      "memory-core",
    ]);
    expect(snapshot.enabledPlugins.map((item) => item.id)).toEqual([
      "web-browse-fetcher",
    ]);
    expect(snapshot.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "plugin",
          id: "native-google-search",
          reason: "Plugin is not installed or not enabled",
        }),
      ]),
    );
  });

  it("blocks official MCP servers when the matching market install is disabled", async () => {
    const catalog = await loadMarketCatalog(path.resolve(process.cwd(), "market"));
    const installs = createDefaultInstallRecords(catalog);
    setInstallEnabled(installs, "skills", "core-agent", true);
    setInstallEnabled(installs, "skills", "memory-core", true);
    setInstallEnabled(installs, "mcp", "exa-search", false);

    const blockedSnapshot = resolveRuntimeSnapshot({
      workspaceId: "main",
      profile: createProfile({
        enabledPluginIds: [],
        enabledMcpServerIds: ["mcp-exa"],
      }),
      searchSettings: createSearchSettings(),
      catalog,
      installs,
      mcpServers: [createOfficialMcpServer()],
    });

    expect(blockedSnapshot.enabledMcpServers).toEqual([]);
    expect(blockedSnapshot.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "mcp",
          id: "mcp-exa",
          reason: "Official MCP manifest is not installed or not enabled",
        }),
      ]),
    );

    setInstallEnabled(installs, "mcp", "exa-search", true);

    const enabledSnapshot = resolveRuntimeSnapshot({
      workspaceId: "main",
      profile: createProfile({
        enabledPluginIds: [],
        enabledMcpServerIds: ["mcp-exa"],
      }),
      searchSettings: createSearchSettings(),
      catalog,
      installs,
      mcpServers: [createOfficialMcpServer()],
    });

    expect(enabledSnapshot.enabledMcpServers).toEqual([
      expect.objectContaining({
        id: "mcp-exa",
        manifestId: "exa-search",
      }),
    ]);
  });

  it("gates Bailian-synced MCP servers on the linked market manifest", async () => {
    const catalog = await loadMarketCatalog(path.resolve(process.cwd(), "market"));
    const installs = createDefaultInstallRecords(catalog);
    setInstallEnabled(installs, "skills", "core-agent", true);
    setInstallEnabled(installs, "skills", "memory-core", true);
    setInstallEnabled(installs, "mcp", "alibaba-bailian", false);

    const blockedSnapshot = resolveRuntimeSnapshot({
      workspaceId: "main",
      profile: createProfile({
        enabledPluginIds: [],
        enabledMcpServerIds: ["mcp_bailian_weather"],
      }),
      searchSettings: createSearchSettings(),
      catalog,
      installs,
      mcpServers: [createBailianSyncedServer()],
    });

    expect(blockedSnapshot.enabledMcpServers).toEqual([]);
    expect(blockedSnapshot.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "mcp",
          id: "mcp_bailian_weather",
          reason: "Linked MCP manifest is not installed or not enabled",
        }),
      ]),
    );

    setInstallEnabled(installs, "mcp", "alibaba-bailian", true);

    const enabledSnapshot = resolveRuntimeSnapshot({
      workspaceId: "main",
      profile: createProfile({
        enabledPluginIds: [],
        enabledMcpServerIds: ["mcp_bailian_weather"],
      }),
      searchSettings: createSearchSettings(),
      catalog,
      installs,
      mcpServers: [createBailianSyncedServer()],
    });

    expect(enabledSnapshot.enabledMcpServers).toEqual([
      expect.objectContaining({
        id: "mcp_bailian_weather",
        manifestId: "alibaba-bailian",
        source: "bailian_market",
      }),
    ]);
  });
});
