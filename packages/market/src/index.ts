import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createId, nowIso } from "@pulsarbot/core";
import {
  ResolvedRuntimeSnapshotSchema,
  MarketKindSchema,
  McpManifestSchema,
  McpProviderManifestSchema,
  PluginManifestSchema,
  type AgentProfile,
  SkillManifestSchema,
  type AnyMarketManifest,
  type InstallRecord,
  type McpManifest,
  type McpProviderManifest,
  type McpServerConfig,
  type PluginManifest,
  type ResolvedRuntimeSnapshot,
  type SearchSettings,
  type SkillManifest,
  type ToolDescriptor,
} from "@pulsarbot/shared";

function manifestSchemaForKind(kind: "skills" | "plugins" | "mcp") {
  if (kind === "skills") {
    return SkillManifestSchema;
  }
  if (kind === "plugins") {
    return PluginManifestSchema;
  }
  return McpManifestSchema;
}

export async function loadMarketCatalog(rootDir: string): Promise<{
  skills: SkillManifest[];
  plugins: PluginManifest[];
  mcp: McpManifest[];
  mcpProviders: McpProviderManifest[];
}> {
  const [skills, plugins, mcp, mcpProviders] = await Promise.all([
    loadMarketManifests(path.join(rootDir, "skills"), "skills"),
    loadMarketManifests(path.join(rootDir, "plugins"), "plugins"),
    loadMarketManifests(path.join(rootDir, "mcp"), "mcp"),
    loadProviderCatalog(path.join(rootDir, "mcp-providers")),
  ]);

  return {
    skills: skills as SkillManifest[],
    plugins: plugins as PluginManifest[],
    mcp: mcp as McpManifest[],
    mcpProviders: mcpProviders as McpProviderManifest[],
  };
}

export async function loadMarketManifests(
  directory: string,
  kind: "skills" | "plugins" | "mcp",
): Promise<AnyMarketManifest[]> {
  const files = await readdir(directory);
  const schema = manifestSchemaForKind(kind);

  return Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const content = await readFile(path.join(directory, file), "utf8");
        return schema.parse(JSON.parse(content));
      }),
  );
}

export async function loadProviderCatalog(
  directory: string,
): Promise<McpProviderManifest[]> {
  const files = await readdir(directory);
  return Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const content = await readFile(path.join(directory, file), "utf8");
        return McpProviderManifestSchema.parse(JSON.parse(content));
      }),
  );
}

export function createDefaultInstallRecords(catalog: {
  skills: SkillManifest[];
  plugins: PluginManifest[];
  mcp: McpManifest[];
  mcpProviders?: McpProviderManifest[];
}): InstallRecord[] {
  const timestamp = nowIso();

  return [
    ...catalog.skills.map((manifest) => ({
      id: createId("install"),
      manifestId: manifest.id,
      kind: "skills" as const,
      enabled: manifest.enabledByDefault,
      config: {},
      installedAt: timestamp,
      updatedAt: timestamp,
    })),
    ...catalog.plugins.map((manifest) => ({
      id: createId("install"),
      manifestId: manifest.id,
      kind: "plugins" as const,
      enabled: manifest.id === "time-context",
      config: {},
      installedAt: timestamp,
      updatedAt: timestamp,
    })),
    ...catalog.mcp.map((manifest) => ({
      id: createId("install"),
      manifestId: manifest.id,
      kind: "mcp" as const,
      enabled: false,
      config: {},
      installedAt: timestamp,
      updatedAt: timestamp,
    })),
  ];
}

export function filterCatalogByKind(
  catalog: {
    skills: SkillManifest[];
    plugins: PluginManifest[];
    mcp: McpManifest[];
    mcpProviders?: McpProviderManifest[];
  },
  kind: string,
): AnyMarketManifest[] {
  const parsedKind = MarketKindSchema.parse(kind);
  if (parsedKind === "skills") {
    return catalog.skills;
  }
  if (parsedKind === "plugins") {
    return catalog.plugins;
  }
  return catalog.mcp;
}

function enabledInstallByManifestId(
  installs: InstallRecord[],
  kind: InstallRecord["kind"],
) {
  return new Map(
    installs
      .filter((install) => install.kind === kind && install.enabled)
      .map((install) => [install.manifestId, install]),
  );
}

export function resolveRuntimeSnapshot(args: {
  workspaceId: string;
  profile: AgentProfile;
  searchSettings: SearchSettings;
  catalog: {
    skills: SkillManifest[];
    plugins: PluginManifest[];
    mcp: McpManifest[];
    mcpProviders?: McpProviderManifest[];
  };
  installs: InstallRecord[];
  mcpServers: McpServerConfig[];
  tools?: ToolDescriptor[];
}): ResolvedRuntimeSnapshot {
  const skillManifests = new Map(
    args.catalog.skills.map((manifest) => [manifest.id, manifest]),
  );
  const pluginManifests = new Map(
    args.catalog.plugins.map((manifest) => [manifest.id, manifest]),
  );
  const mcpManifests = new Map(
    args.catalog.mcp.map((manifest) => [manifest.id, manifest]),
  );
  const enabledSkillInstalls = enabledInstallByManifestId(args.installs, "skills");
  const enabledPluginInstalls = enabledInstallByManifestId(args.installs, "plugins");
  const enabledMcpInstalls = enabledInstallByManifestId(args.installs, "mcp");
  const serversById = new Map(args.mcpServers.map((server) => [server.id, server]));
  const selectedSkillIds = new Set(args.profile.enabledSkillIds);
  const selectedPluginIds = new Set(args.profile.enabledPluginIds);
  const selectedMcpServerIds = new Set(args.profile.enabledMcpServerIds);
  const promptFragments: string[] = [];
  const allowedToolIds: string[] = [];
  const blocked: ResolvedRuntimeSnapshot["blocked"] = [];

  const missingDependenciesFor = (dependencies: string[]): string[] =>
    dependencies.filter((dependencyId) => {
      if (skillManifests.has(dependencyId)) {
        return !selectedSkillIds.has(dependencyId) || !enabledSkillInstalls.has(dependencyId);
      }
      if (pluginManifests.has(dependencyId)) {
        return !selectedPluginIds.has(dependencyId) || !enabledPluginInstalls.has(dependencyId);
      }
      if (mcpManifests.has(dependencyId)) {
        return !args.mcpServers.some((server) =>
          selectedMcpServerIds.has(server.id) &&
          server.enabled &&
          server.manifestId === dependencyId &&
          enabledMcpInstalls.has(dependencyId)
        );
      }
      const server = serversById.get(dependencyId);
      if (server) {
        return !selectedMcpServerIds.has(server.id) ||
          !server.enabled ||
          Boolean(server.manifestId && !enabledMcpInstalls.has(server.manifestId));
      }
      return true;
    });

  const enabledSkills = args.profile.enabledSkillIds.flatMap((id) => {
    const manifest = skillManifests.get(id);
    if (!manifest) {
      blocked.push({
        scope: "skill",
        id,
        reason: "Skill manifest not found",
      });
      return [];
    }
    const install = enabledSkillInstalls.get(id);
    if (!install) {
      blocked.push({
        scope: "skill",
        id,
        reason: "Skill is not installed or not enabled",
      });
      return [];
    }
    const missingDependencies = missingDependenciesFor(manifest.dependencies);
    if (missingDependencies.length > 0) {
      blocked.push({
        scope: "skill",
        id,
        reason: `Missing runtime dependencies: ${missingDependencies.join(", ")}`,
      });
      return [];
    }
    promptFragments.push(...manifest.promptFragments);
    allowedToolIds.push(...manifest.toolBindings);
    return [{
      id: manifest.id,
      title: manifest.title,
      kind: "skill" as const,
      source: "market" as const,
      installId: install.id,
      manifestId: manifest.id,
    }];
  });

  const enabledPlugins = args.profile.enabledPluginIds.flatMap((id) => {
    const manifest = pluginManifests.get(id);
    if (!manifest) {
      blocked.push({
        scope: "plugin",
        id,
        reason: "Plugin manifest not found",
      });
      return [];
    }
    const install = enabledPluginInstalls.get(id);
    if (!install) {
      blocked.push({
        scope: "plugin",
        id,
        reason: "Plugin is not installed or not enabled",
      });
      return [];
    }
    const missingDependencies = missingDependenciesFor(manifest.dependencies);
    if (missingDependencies.length > 0) {
      blocked.push({
        scope: "plugin",
        id,
        reason: `Missing runtime dependencies: ${missingDependencies.join(", ")}`,
      });
      return [];
    }
    return [{
      id: manifest.id,
      title: manifest.title,
      kind: "plugin" as const,
      source: "market" as const,
      installId: install.id,
      manifestId: manifest.id,
    }];
  });

  const enabledMcpServers = args.profile.enabledMcpServerIds.flatMap((id) => {
    const server = serversById.get(id);
    if (!server) {
      blocked.push({
        scope: "mcp",
        id,
        reason: "MCP server not found",
      });
      return [];
    }
    if (!server.enabled) {
      blocked.push({
        scope: "mcp",
        id,
        reason: "MCP server is disabled",
      });
      return [];
    }
    if (server.manifestId) {
      const manifest = mcpManifests.get(server.manifestId);
      if (!manifest) {
        blocked.push({
          scope: "mcp",
          id,
          reason: server.source === "official"
            ? "Official MCP manifest not found"
            : "Linked MCP manifest not found",
        });
        return [];
      }
      if (!enabledMcpInstalls.get(server.manifestId)) {
        blocked.push({
          scope: "mcp",
          id,
          reason: server.source === "official"
            ? "Official MCP manifest is not installed or not enabled"
            : "Linked MCP manifest is not installed or not enabled",
        });
        return [];
      }
      const missingDependencies = missingDependenciesFor(manifest.dependencies);
      if (missingDependencies.length > 0) {
        blocked.push({
          scope: "mcp",
          id,
          reason: `Missing runtime dependencies: ${missingDependencies.join(", ")}`,
        });
        return [];
      }
      return [{
        id: server.id,
        label: server.label,
        transport: server.transport,
        source: server.source,
        manifestId: manifest.id,
      }];
    }
    return [{
      id: server.id,
      label: server.label,
      transport: server.transport,
      source: server.source,
      manifestId: server.manifestId ?? null,
    }];
  });

  return ResolvedRuntimeSnapshotSchema.parse({
    workspaceId: args.workspaceId,
    agentProfileId: args.profile.id,
    promptFragments: [...new Set(promptFragments)],
    allowedToolIds: [...new Set(allowedToolIds)],
    enabledSkills,
    enabledPlugins,
    enabledMcpServers,
    tools: args.tools ?? [],
    blocked,
    searchSettings: args.searchSettings,
    generatedAt: nowIso(),
  });
}
