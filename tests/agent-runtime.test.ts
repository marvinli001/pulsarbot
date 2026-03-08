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

const originalFetch = global.fetch;

function createSseResponse(deltas: string[]): Response {
  const body = [
    ...deltas.map((delta) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`
    ),
    "data: [DONE]\n\n",
  ].join("");

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

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

function createProviderProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
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
    ...overrides,
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
    const modelCalls: ProviderInvocationInput["messages"][] = [];
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
            if (system.includes("Summarize the conversation")) {
              return {
                text: "summary",
                raw: {},
              };
            }

            modelCalls.push(args.input.messages);
            if (args.input.jsonMode) {
              return {
                text: JSON.stringify({
                  type: "final_response",
                  content: "done",
                }),
                raw: {},
              };
            }

            return { text: "done", raw: {} };
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

    const flattened = modelCalls[0]?.map((message) => message.content).join("\n") ?? "";
    expect(flattened).toContain("recent user message");
    expect(flattened).not.toContain("old user message");
    expect(flattened).not.toContain("old assistant answer");
  });

  it("passes the effective tool timeout budget through to provider calls", async () => {
    const memory = createMemoryStore();
    const provider = createProviderProfile();
    const seenTimeouts: number[] = [];
    const runtime = new AgentRuntime(
      {
        resolveProviderProfile: async () => provider,
        resolveApiKey: async () => "sk-test",
        listEnabledMcpServers: async () => [],
        listConversationSummaries: async () => [],
        createMemoryStore: async () => memory,
        invokeProvider: vi.fn(
          async (args: {
            profile: ProviderProfile;
            apiKey: string;
            input: ProviderInvocationInput;
            timeoutMs?: number;
          }): Promise<ProviderInvocationResult> => {
            void args.profile;
            void args.apiKey;
            seenTimeouts.push(args.timeoutMs ?? 0);
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
      profile: createAgentProfile({
        maxToolDurationMs: 45_000,
      }),
      userMessage: "Hello",
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

    expect(seenTimeouts[0]).toBe(45_000);
  });

  it("uses a longer planner timeout floor than the generic tool timeout", async () => {
    const memory = createMemoryStore();
    const provider = createProviderProfile();
    const seenTimeouts: number[] = [];
    const runtime = new AgentRuntime(
      {
        resolveProviderProfile: async () => provider,
        resolveApiKey: async () => "sk-test",
        listEnabledMcpServers: async () => [],
        listConversationSummaries: async () => [],
        createMemoryStore: async () => memory,
        invokeProvider: vi.fn(
          async (args: {
            profile: ProviderProfile;
            apiKey: string;
            input: ProviderInvocationInput;
            timeoutMs?: number;
          }): Promise<ProviderInvocationResult> => {
            void args.profile;
            void args.apiKey;
            seenTimeouts.push(args.timeoutMs ?? 0);
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
      profile: createAgentProfile({
        maxToolDurationMs: 30_000,
      }),
      userMessage: "Hello",
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

    expect(seenTimeouts[0]).toBe(45_000);
  });

  it("injects the current runtime capability snapshot into the system prompt", async () => {
    const memory = createMemoryStore();
    const provider = createProviderProfile();
    const providerCalls: ProviderInvocationInput[] = [];
    const runtime = new AgentRuntime(
      {
        resolveProviderProfile: async () => provider,
        resolveApiKey: async () => "sk-test",
        listEnabledMcpServers: async () => [],
        listConversationSummaries: async () => [],
        createMemoryStore: async () => memory,
        invokeProvider: vi.fn(
          async (args: {
            profile: ProviderProfile;
            apiKey: string;
            input: ProviderInvocationInput;
          }): Promise<ProviderInvocationResult> => {
            void args.profile;
            void args.apiKey;
            providerCalls.push(args.input);
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
      profile: createAgentProfile({
        enabledSkillIds: ["core-agent"],
        enabledPluginIds: ["time-context", "native-google-search"],
      }),
      userMessage: "What can you do?",
      history: [],
      context: {
        workspaceId: "main",
        conversationId: "conversation_1",
        nowIso: "2026-01-01T00:00:00.000Z",
        timezone: "UTC",
        profileId: "agent_1",
        runtime: {
          ...createRuntime(),
          enabledSkills: [
            {
              id: "core-agent",
              title: "Core Agent",
              kind: "skill",
              source: "market",
              installId: "install_skill_1",
              manifestId: "core-agent",
            },
          ],
          enabledPlugins: [
            {
              id: "time-context",
              title: "Time Context",
              kind: "plugin",
              source: "market",
              installId: "install_plugin_1",
              manifestId: "time-context",
            },
            {
              id: "native-google-search",
              title: "Google Search",
              kind: "plugin",
              source: "market",
              installId: "install_plugin_2",
              manifestId: "native-google-search",
            },
          ],
          enabledMcpServers: [
            {
              id: "mcp-exa",
              label: "Exa Search",
              transport: "streamable_http",
              source: "official",
              manifestId: "exa-search",
            },
          ],
          blocked: [
            {
              scope: "plugin",
              id: "web-browse-fetcher",
              reason: "Plugin is not installed or not enabled",
            },
          ],
        },
        searchSettings: createSearchSettings(),
      },
    });

    const firstCall = providerCalls[0];
    const systemPrompt = String(firstCall?.messages[0]?.content ?? "");
    expect(systemPrompt).toContain("Runtime capability snapshot:");
    expect(systemPrompt).toContain("Enabled skills: core-agent");
    expect(systemPrompt).toContain("Enabled plugins: time-context, native-google-search");
    expect(systemPrompt).toContain("Enabled MCP servers: Exa Search");
    expect(systemPrompt).toContain("Blocked runtime references: plugin:web-browse-fetcher");
    expect(systemPrompt).toContain("Available tool ids right now:");
  });

  it("executes native tool calls and feeds tool results back to the provider", async () => {
    const memory = createMemoryStore();
    memory.listToolDescriptors = vi.fn(() => [
      {
        id: "memory_search",
        title: "Memory Search",
        description: "Search saved memory.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        permissionScopes: [],
        source: "builtin",
      },
    ]);
    memory.executeTool = vi.fn(async () => ({ hits: ["result-1"] }));
    const provider = createProviderProfile();
    const providerCalls: ProviderInvocationInput[] = [];
    const invokeProvider = vi.fn(
      async (args: {
        profile: ProviderProfile;
        apiKey: string;
        input: ProviderInvocationInput;
      }): Promise<ProviderInvocationResult> => {
        void args.profile;
        void args.apiKey;
        providerCalls.push(args.input);
        if (providerCalls.length === 1) {
          return {
            text: "",
            raw: {},
            toolCalls: [
              {
                id: "call_1",
                toolId: "memory_search",
                input: { query: "alpha" },
              },
            ],
          };
        }
        return {
          text: "final answer",
          raw: {},
        };
      },
    );

    const runtime = new AgentRuntime(
      {
        resolveProviderProfile: async () => provider,
        resolveApiKey: async () => "sk-test",
        listEnabledMcpServers: async () => [],
        listConversationSummaries: async () => [],
        createMemoryStore: async () => memory,
        invokeProvider,
      },
      "/tmp",
    );

    const result = await runtime.runTurn({
      profile: createAgentProfile(),
      userMessage: "Find memory",
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

    expect(result.reply).toBe("final answer");
    expect(result.toolRuns).toHaveLength(1);
    expect(result.toolRuns[0]).toMatchObject({
      toolId: "memory_search",
      input: { query: "alpha" },
    });
    expect(memory.executeTool).toHaveBeenCalledWith("memory_search", { query: "alpha" });
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          toolCalls: [
            expect.objectContaining({
              id: "call_1",
              toolId: "memory_search",
              input: { query: "alpha" },
            }),
          ],
        }),
        expect.objectContaining({
          role: "tool",
          toolCallId: "call_1",
        }),
      ]),
    );
  });

  it("streams native direct replies when tool calling stops without tool calls", async () => {
    global.fetch = vi.fn(async () => createSseResponse(["Hel", "lo"])) as typeof fetch;

    try {
      const memory = createMemoryStore();
      const provider = createProviderProfile({
        stream: true,
      });
      const partials: string[] = [];
      const invokeProvider = vi.fn(
        async (args: {
          profile: ProviderProfile;
          apiKey: string;
          input: ProviderInvocationInput;
        }): Promise<ProviderInvocationResult> => {
          void args.profile;
          void args.apiKey;
          return {
            text: "Hello",
            raw: {},
          };
        },
      );

      const runtime = new AgentRuntime(
        {
          resolveProviderProfile: async () => provider,
          resolveApiKey: async () => "sk-test",
          listEnabledMcpServers: async () => [],
          listConversationSummaries: async () => [],
          createMemoryStore: async () => memory,
          invokeProvider,
        },
        "/tmp",
      );

      const result = await runtime.runTurn({
        profile: createAgentProfile(),
        userMessage: "Say hello",
        history: [],
        streamReply: {
          onPartial: async (text: string) => {
            partials.push(text);
          },
        },
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

      expect(result.reply).toBe("Hello");
      expect(partials).toEqual(["Hel", "Hello"]);
      expect(invokeProvider).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("streams native final replies after tool loops complete", async () => {
    global.fetch = vi.fn(async () => createSseResponse(["Final ", "answer"])) as typeof fetch;

    try {
      const memory = createMemoryStore();
      memory.listToolDescriptors = vi.fn(() => [
        {
          id: "memory_search",
          title: "Memory Search",
          description: "Search saved memory.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          permissionScopes: [],
          source: "builtin",
        },
      ]);
      memory.executeTool = vi.fn(async () => ({ hits: ["result-1"] }));
      const provider = createProviderProfile({
        stream: true,
      });
      const partials: string[] = [];
      const invokeProvider = vi.fn(
        async (args: {
          profile: ProviderProfile;
          apiKey: string;
          input: ProviderInvocationInput;
        }): Promise<ProviderInvocationResult> => {
          void args.profile;
          void args.apiKey;
          if (invokeProvider.mock.calls.length === 1) {
            return {
              text: "",
              raw: {},
              toolCalls: [
                {
                  id: "call_1",
                  toolId: "memory_search",
                  input: { query: "alpha" },
                },
              ],
            };
          }

          return {
            text: "unexpected",
            raw: {},
          };
        },
      );

      const runtime = new AgentRuntime(
        {
          resolveProviderProfile: async () => provider,
          resolveApiKey: async () => "sk-test",
          listEnabledMcpServers: async () => [],
          listConversationSummaries: async () => [],
          createMemoryStore: async () => memory,
          invokeProvider,
        },
        "/tmp",
      );

      const result = await runtime.runTurn({
        profile: createAgentProfile({
          maxPlanningSteps: 1,
        }),
        userMessage: "Find memory",
        history: [],
        streamReply: {
          onPartial: async (text: string) => {
            partials.push(text);
          },
        },
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

      expect(result.reply).toBe("Final answer");
      expect(result.toolRuns).toHaveLength(1);
      expect(partials).toEqual(["Final ", "Final answer"]);
      expect(invokeProvider).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("enables native tool-calling path for gemini, openrouter, and bailian providers", async () => {
    for (const kind of ["gemini", "openrouter", "bailian"] as const) {
      const memory = createMemoryStore();
      memory.listToolDescriptors = vi.fn(() => [
        {
          id: "memory_search",
          title: "Memory Search",
          description: "Search saved memory.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          permissionScopes: [],
          source: "builtin",
        },
      ]);
      const provider = createProviderProfile({
        kind,
        apiBaseUrl:
          kind === "gemini"
            ? "https://generativelanguage.googleapis.com/v1beta"
            : kind === "openrouter"
            ? "https://openrouter.ai/api/v1"
            : "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
      });
      const invokeProvider = vi.fn(
        async (args: {
          profile: ProviderProfile;
          apiKey: string;
          input: ProviderInvocationInput;
        }): Promise<ProviderInvocationResult> => {
          void args.profile;
          void args.apiKey;
          return {
            text: "done",
            raw: {},
          };
        },
      );
      const runtime = new AgentRuntime(
        {
          resolveProviderProfile: async () => provider,
          resolveApiKey: async () => "sk-test",
          listEnabledMcpServers: async () => [],
          listConversationSummaries: async () => [],
          createMemoryStore: async () => memory,
          invokeProvider,
        },
        "/tmp",
      );

      await runtime.runTurn({
        profile: createAgentProfile(),
        userMessage: "Hello",
        history: [],
        context: {
          workspaceId: "main",
          conversationId: `conversation_${kind}`,
          nowIso: "2026-01-01T00:00:00.000Z",
          timezone: "UTC",
          profileId: "agent_1",
          runtime: createRuntime(),
          searchSettings: createSearchSettings(),
        },
      });

      const firstCallInput = invokeProvider.mock.calls[0]?.[0]?.input as
        | ProviderInvocationInput
        | undefined;
      expect(firstCallInput?.jsonMode).toBeUndefined();
      expect(firstCallInput?.tools?.length ?? 0).toBeGreaterThan(0);
      expect(firstCallInput?.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "memory_search",
          }),
        ]),
      );
      expect(firstCallInput?.toolChoice).toBe("auto");
    }
  });

  it("falls back to browsing bare domains when search providers return empty results", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://www.google.com/search?")) {
        return new Response(
          "<html><head><title>Google Search</title></head><body>Please click here.</body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=UTF-8" },
          },
        );
      }

      if (url === "https://html.duckduckgo.com/html/?q=coserlab.io") {
        return new Response("<html><body></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=UTF-8" },
        });
      }

      if (url === "https://coserlab.io/") {
        return new Response(
          "<html><head><title>CoserLab</title></head><body><article>Official site</article></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=UTF-8" },
          },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const memory = createMemoryStore();
      const provider = createProviderProfile();
      const invokeProvider = vi.fn(
        async (args: {
          profile: ProviderProfile;
          apiKey: string;
          input: ProviderInvocationInput;
        }): Promise<ProviderInvocationResult> => {
          void args.profile;
          void args.apiKey;
          if (invokeProvider.mock.calls.length === 1) {
            return {
              text: "",
              raw: {},
              toolCalls: [
                {
                  id: "call_search",
                  toolId: "search_web",
                  input: { query: "coserlab.io" },
                },
              ],
            };
          }

          return {
            text: "final answer",
            raw: {},
          };
        },
      );

      const runtime = new AgentRuntime(
        {
          resolveProviderProfile: async () => provider,
          resolveApiKey: async () => "sk-test",
          listEnabledMcpServers: async () => [],
          listConversationSummaries: async () => [],
          createMemoryStore: async () => memory,
          invokeProvider,
        },
        "/tmp",
      );

      const result = await runtime.runTurn({
        profile: createAgentProfile({
          enabledPluginIds: ["native-google-search", "web-browse-fetcher"],
        }),
        userMessage: "Tell me about coserlab.io",
        history: [],
        context: {
          workspaceId: "main",
          conversationId: "conversation_1",
          nowIso: "2026-01-01T00:00:00.000Z",
          timezone: "UTC",
          profileId: "agent_1",
          runtime: {
            ...createRuntime(),
            enabledPlugins: [
              {
                id: "native-google-search",
                title: "Google Search",
                kind: "plugin",
                source: "market",
                installId: "install_plugin_google",
                manifestId: "native-google-search",
              },
              {
                id: "web-browse-fetcher",
                title: "Web Browse",
                kind: "plugin",
                source: "market",
                installId: "install_plugin_browse",
                manifestId: "web-browse-fetcher",
              },
            ],
          },
          searchSettings: {
            ...createSearchSettings(),
            providerPriority: ["google_native", "web_browse"],
          },
        },
      });

      expect(result.reply).toBe("final answer");
      expect(result.toolRuns).toEqual([
        expect.objectContaining({
          toolId: "search_web",
          output: expect.objectContaining({
            url: "https://coserlab.io/",
            title: "CoserLab",
          }),
        }),
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
