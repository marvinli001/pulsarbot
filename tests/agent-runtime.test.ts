import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../packages/agent/src/index.js";
import type { MemoryStoreLike } from "../packages/memory/src/index.js";
import type {
  AgentProfile,
  ConversationSummary,
  ProviderProfile,
  ResolvedRuntimeSnapshot,
  SearchSettings,
} from "../packages/shared/src/index.js";
import type {
  ProviderInvocationInput,
  ProviderInvocationResult,
} from "../packages/providers/src/index.js";

function createSearchSettings(): SearchSettings {
  return {
    id: "main",
    providerPriority: ["google_native", "bing_native", "exa_mcp", "web_browse"],
    allowNetwork: true,
    fallbackStrategy: "exa_then_browse",
    maxResults: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createRuntime(searchSettings = createSearchSettings()): ResolvedRuntimeSnapshot {
  return {
    workspaceId: "main",
    agentProfileId: "agent_1",
    promptFragments: [],
    enabledSkills: [],
    enabledPlugins: [],
    enabledMcpServers: [],
    tools: [],
    blocked: [],
    searchSettings,
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createProviderProfile(): ProviderProfile {
  return {
    id: "provider_1",
    kind: "openai",
    label: "Primary",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKeyRef: "provider:primary:apiKey",
    defaultModel: "gpt-4.1-mini",
    visionModel: null,
    audioModel: null,
    documentModel: null,
    stream: false,
    reasoningEnabled: false,
    reasoningLevel: "off",
    thinkingBudget: null,
    temperature: 0.2,
    topP: null,
    maxOutputTokens: 1024,
    toolCallingEnabled: true,
    jsonModeEnabled: true,
    visionEnabled: false,
    audioInputEnabled: false,
    documentInputEnabled: false,
    headers: {},
    extraBody: {},
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createAgentProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent_1",
    label: "balanced",
    description: "",
    systemPrompt: "You are Pulsarbot.",
    primaryModelProfileId: "provider_1",
    backgroundModelProfileId: "provider_1",
    embeddingModelProfileId: null,
    enabledSkillIds: [],
    enabledPluginIds: [],
    enabledMcpServerIds: [],
    maxPlanningSteps: 3,
    maxToolCalls: 2,
    maxTurnDurationMs: 30_000,
    maxToolDurationMs: 5_000,
    compactSoftThreshold: 0.7,
    compactHardThreshold: 0.85,
    allowNetworkTools: true,
    allowWriteTools: true,
    allowMcpTools: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMemoryStore() {
  const store: MemoryStoreLike = {
    getStartupContext: vi.fn(async () => ({
      longterm: "",
      today: "",
      yesterday: "",
    })),
    appendDaily: vi.fn(async () => "daily"),
    upsertLongterm: vi.fn(async () => "longterm"),
    writeSummarySnapshot: vi.fn(async () => "summary-doc"),
    compactTranscript: vi.fn((messages: string[]) => messages.join("\n").slice(0, 200)),
    search: vi.fn(async () => []),
    processPendingJobs: vi.fn(async () => 0),
    queueFullReindex: vi.fn(async () => undefined),
    listToolDescriptors: vi.fn(() => []),
    executeTool: vi.fn(async () => ({ ok: true })),
  };

  return store;
}

describe("AgentRuntime", () => {
  it("uses profile compaction thresholds and persists summary refresh work", async () => {
    const memory = createMemoryStore();
    const enqueueJob = vi.fn(async () => undefined);
    const provider = createProviderProfile();
    const runtime = new AgentRuntime(
      {
        resolveProviderProfile: async () => provider,
        resolveApiKey: async () => "sk-test",
        listEnabledMcpServers: async () => [],
        listConversationSummaries: async () => [],
        enqueueJob,
        createMemoryStore: async () => memory,
        invokeProvider: vi.fn(
          async (args: {
            profile: ProviderProfile;
            apiKey: string;
            input: ProviderInvocationInput;
          }): Promise<ProviderInvocationResult> => {
            void args.profile;
            void args.apiKey;
            const system = args.input.messages[0]?.content ?? "";
            if (system.includes("Summarize the conversation")) {
              return {
                text: "summary note",
                raw: {},
              };
            }

            return {
              text: JSON.stringify({
                type: "final_response",
                content: "done",
              }),
              raw: {},
            };
          },
        ),
      },
      "/tmp",
    );

    const result = await runtime.runTurn({
      profile: createAgentProfile({
        compactSoftThreshold: 0,
        compactHardThreshold: 0.01,
      }),
      userMessage: "x".repeat(1024),
      history: [],
      context: {
        workspaceId: "main",
        conversationId: "conversation_1",
        nowIso: "2026-01-01T00:00:00.000Z",
        timezone: "UTC",
        profileId: "agent_1",
        runtime: createRuntime(),
        searchSettings: createSearchSettings(),
      },
    });

    expect(result.compacted).toBe(true);
    expect(result.summary).toBe("summary note");
    expect(enqueueJob).toHaveBeenCalledWith({
      workspaceId: "main",
      kind: "memory_refresh_before_compact",
      payload: {
        notes: "summary note",
      },
    });
    expect(memory.writeSummarySnapshot).toHaveBeenCalledWith(
      "conversation_1",
      "summary note",
    );
  });

  it("uses the latest saved summary as a cursor and only replays newer history", async () => {
    const memory = createMemoryStore();
    const summary: ConversationSummary = {
      id: "summary_1",
      conversationId: "conversation_1",
      content: "Earlier context",
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const planningCalls: ProviderInvocationInput["messages"][] = [];
    const provider = createProviderProfile();
    const runtime = new AgentRuntime(
      {
        resolveProviderProfile: async () => provider,
        resolveApiKey: async () => "sk-test",
        listEnabledMcpServers: async () => [],
        listConversationSummaries: async () => [summary],
        createMemoryStore: async () => memory,
        invokeProvider: vi.fn(
          async (args: {
            profile: ProviderProfile;
            apiKey: string;
            input: ProviderInvocationInput;
          }): Promise<ProviderInvocationResult> => {
            void args.profile;
            void args.apiKey;
            const system = args.input.messages[0]?.content ?? "";
            if (system.includes("Return strict JSON")) {
              planningCalls.push(args.input.messages);
              return {
                text: JSON.stringify({
                  type: "final_response",
                  content: "done",
                }),
                raw: {},
              };
            }

            return {
              text: "done",
              raw: {},
            };
          },
        ),
      },
      "/tmp",
    );

    await runtime.runTurn({
      profile: createAgentProfile(),
      userMessage: "Current question",
      history: [
        {
          id: "msg_1",
          conversationId: "conversation_1",
          role: "user",
          content: "old user message",
          sourceType: "text",
          telegramMessageId: null,
          metadata: {},
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "msg_2",
          conversationId: "conversation_1",
          role: "assistant",
          content: "old assistant answer",
          sourceType: "text",
          telegramMessageId: null,
          metadata: {},
          createdAt: "2026-01-01T00:00:02.000Z",
        },
        {
          id: "msg_3",
          conversationId: "conversation_1",
          role: "user",
          content: "recent user message",
          sourceType: "text",
          telegramMessageId: null,
          metadata: {},
          createdAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      context: {
        workspaceId: "main",
        conversationId: "conversation_1",
        nowIso: "2026-01-01T00:00:04.000Z",
        timezone: "UTC",
        profileId: "agent_1",
        runtime: createRuntime(),
        searchSettings: createSearchSettings(),
      },
    });

    const flattened = planningCalls[0]?.map((message) => message.content).join("\n") ?? "";
    expect(flattened).toContain("recent user message");
    expect(flattened).not.toContain("old user message");
    expect(flattened).not.toContain("old assistant answer");
  });
});
