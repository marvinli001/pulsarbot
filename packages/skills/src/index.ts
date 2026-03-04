import type { ToolDescriptor } from "@pulsarbot/shared";

export interface SkillDefinition {
  id: string;
  title: string;
  description: string;
  promptFragments: string[];
  toolBindings: string[];
  enabledByDefault: boolean;
}

const builtInSkills: SkillDefinition[] = [
  {
    id: "core-agent",
    title: "Core Agent",
    description: "Base reasoning loop and delegation rules.",
    promptFragments: [
      "You are Pulsarbot, a Telegram-native personal agent.",
      "Prefer tools when they improve precision, and keep responses concise.",
      "If the user explicitly asks to remember something, persist it through memory tools.",
    ],
    toolBindings: [],
    enabledByDefault: true,
  },
  {
    id: "memory-core",
    title: "Memory Core",
    description: "Persistent Markdown memory rules.",
    promptFragments: [
      "Long-term memory lives in MEMORY.md.",
      "Daily notes live in memory/YYYY-MM-DD.md and are append-only.",
      "When context is tight, refresh persistent memory before compaction.",
    ],
    toolBindings: [
      "memory_search",
      "memory_append_daily",
      "memory_upsert_longterm",
      "memory_refresh_before_compact",
    ],
    enabledByDefault: false,
  },
  {
    id: "web-search",
    title: "Web Search",
    description: "Search across Google, Bing, or Exa MCP.",
    promptFragments: [
      "Use web search before making claims that are likely to change over time.",
    ],
    toolBindings: ["google_search", "bing_search"],
    enabledByDefault: false,
  },
  {
    id: "web-browse",
    title: "Web Browse",
    description: "Open URLs and extract readable page text.",
    promptFragments: [
      "Use the browser tool to retrieve primary sources before summarizing them.",
    ],
    toolBindings: ["web_browse"],
    enabledByDefault: false,
  },
  {
    id: "document-tools",
    title: "Document Tools",
    description: "Extract and summarize document text.",
    promptFragments: [
      "Document tools are optimized for cleaning and chunking pasted text.",
    ],
    toolBindings: ["document_extract_text"],
    enabledByDefault: false,
  },
  {
    id: "mcp-bridge",
    title: "MCP Bridge",
    description: "Expose MCP-backed tools to the agent runtime.",
    promptFragments: [
      "MCP tools may come from official or custom servers and should be treated as external integrations.",
    ],
    toolBindings: [],
    enabledByDefault: false,
  },
];

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>(
    builtInSkills.map((skill) => [skill.id, skill]),
  );

  public list(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  public getByIds(ids: string[]): SkillDefinition[] {
    return ids
      .map((id) => this.skills.get(id))
      .filter((skill): skill is SkillDefinition => Boolean(skill));
  }

  public resolvePromptFragments(ids: string[]): string[] {
    return this.getByIds(ids).flatMap((skill) => skill.promptFragments);
  }

  public resolveToolBindings(ids: string[]): string[] {
    return [...new Set(this.getByIds(ids).flatMap((skill) => skill.toolBindings))];
  }

  public describeTools(toolIds: string[], tools: ToolDescriptor[]): string[] {
    return toolIds.flatMap((toolId) =>
      tools
        .filter((tool) => tool.id === toolId)
        .map((tool) => `${tool.id}: ${tool.description}`),
    );
  }
}

export function createSkillRegistry(): SkillRegistry {
  return new SkillRegistry();
}
