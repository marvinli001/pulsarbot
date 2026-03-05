import { AppError, createId, TokenBudgetManager } from "@pulsarbot/core";
import {
  listMemoryToolDescriptors,
  type MemoryStoreLike,
} from "@pulsarbot/memory";
import { createMcpSupervisor, type McpSupervisor } from "@pulsarbot/mcp";
import { createBuiltinPluginRegistry, type BuiltinPluginRegistry } from "@pulsarbot/plugins";
import {
  invokeProvider,
  invokeProviderStream,
  supportsProviderTextStreaming,
  type ProviderInvocationInput,
  type ProviderMessage,
  type ProviderInvocationResult,
  type ProviderToolDefinition,
} from "@pulsarbot/providers";
import {
  PlannerActionSchema,
  type ConversationSummary,
  type AgentProfile,
  type McpServerConfig,
  type MessageRecord,
  type PlannerAction,
  type ProviderProfile,
  type ResolvedRuntimeSnapshot,
  type SearchSettings,
  type ToolDescriptor,
} from "@pulsarbot/shared";

export interface AgentRuntimeContext {
  workspaceId: string;
  conversationId: string;
  turnId?: string | undefined;
  nowIso: string;
  timezone: string;
  profileId: string;
  searchSettings: SearchSettings;
  runtime: ResolvedRuntimeSnapshot;
}

export interface AgentExecutionServices {
  resolveProviderProfile(profileId: string): Promise<ProviderProfile>;
  resolveApiKey(apiKeyRef: string): Promise<string>;
  listEnabledMcpServers(ids: string[]): Promise<McpServerConfig[]>;
  mcpSupervisor?: McpSupervisor;
  listConversationSummaries?(conversationId: string): Promise<ConversationSummary[]>;
  enqueueJob?(input: {
    workspaceId: string;
    kind: "memory_refresh_before_compact";
    payload: Record<string, unknown>;
  }): Promise<void>;
  createMemoryStore(workspaceId: string): Promise<MemoryStoreLike>;
  invokeProvider?(args: {
    profile: ProviderProfile;
    apiKey: string;
    input: ProviderInvocationInput;
  }): Promise<ProviderInvocationResult>;
}

export interface AgentTurnInput {
  profile: AgentProfile;
  userMessage: string;
  history: MessageRecord[];
  context: AgentRuntimeContext;
  streamReply?: {
    onPartial(text: string): Promise<void>;
  };
}

export interface AgentTurnResult {
  reply: string;
  turnId: string;
  stepCount: number;
  toolRuns: Array<{
    id: string;
    toolId: string;
    input: Record<string, unknown>;
    output: unknown;
    source: "plugin" | "mcp" | "builtin";
  }>;
  compacted: boolean;
  summary?: string | undefined;
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
  }
  return null;
}

function parsePlannerAction(text: string): PlannerAction {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    if ("type" in parsed) {
      return PlannerActionSchema.parse(parsed);
    }
    const legacy = parsed as {
      finalResponse?: string;
      toolCalls?: Array<{ toolId: string; input?: Record<string, unknown> }>;
    };
    if (legacy.toolCalls?.length) {
      return PlannerActionSchema.parse({
        type: "call_tool",
        toolId: legacy.toolCalls[0]?.toolId,
        input: legacy.toolCalls[0]?.input ?? {},
      });
    }
    if (legacy.finalResponse) {
      return PlannerActionSchema.parse({
        type: "final_response",
        content: legacy.finalResponse,
      });
    }
  }

  return {
    type: "final_response",
    content: text,
  };
}

function asTranscript(messages: MessageRecord[]): string[] {
  return messages.map((message) => `${message.role}: ${message.content}`);
}

function toolSourceFor(
  toolId: string,
  builtinToolIds: Set<string>,
  memoryToolIds: Set<string>,
): "plugin" | "mcp" | "builtin" {
  if (toolId.startsWith("mcp:")) {
    return "mcp";
  }
  if (memoryToolIds.has(toolId)) {
    return "builtin";
  }
  if (builtinToolIds.has(toolId)) {
    return "plugin";
  }
  return "builtin";
}

function supportsNativeToolCalling(provider: ProviderProfile): boolean {
  if (!provider.toolCallingEnabled) {
    return false;
  }
  return provider.kind === "openai" ||
    provider.kind === "anthropic" ||
    provider.kind === "gemini" ||
    provider.kind === "openrouter" ||
    provider.kind === "bailian";
}

function toProviderHistoryMessages(history: MessageRecord[]): ProviderMessage[] {
  return history.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function toProviderToolDefinitions(
  descriptors: ToolDescriptor[],
): ProviderToolDefinition[] {
  return descriptors.map((tool) => ({
    id: tool.id,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export class AgentRuntime {
  private readonly plugins: BuiltinPluginRegistry;
  private readonly mcp: McpSupervisor;

  public constructor(
    private readonly services: AgentExecutionServices,
    private readonly dataDir: string,
  ) {
    void this.dataDir;
    this.plugins = createBuiltinPluginRegistry();
    this.mcp = this.services.mcpSupervisor ?? createMcpSupervisor();
  }

  public async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const turnId = input.context.turnId ?? createId("turn");
    const turnDeadlineAt = Date.now() + input.profile.maxTurnDurationMs;
    const memory = await this.services.createMemoryStore(input.context.workspaceId);
    const existingSummary = await this.loadLatestConversationSummary(
      input.context.conversationId,
    );
    const startupMemory = await memory.getStartupContext(new Date(input.context.nowIso));
    const mcpServers = await this.services.listEnabledMcpServers(
      input.context.runtime.enabledMcpServers.map((server) => server.id),
    );
    const toolDescriptors = await this.resolveTools(
      input.profile,
      input.context,
      memory.listToolDescriptors(),
      mcpServers,
    );
    const skillPrompts = input.context.runtime.promptFragments;
    const builtinToolIds = new Set(
      input.context.runtime.enabledPlugins.map((plugin) => plugin.id),
    );
    const memoryToolIds = new Set(
      memory.listToolDescriptors().map((tool) => tool.id),
    );
    const providerInvoker = this.services.invokeProvider ?? invokeProvider;
    const primaryProvider = await this.services.resolveProviderProfile(
      input.profile.primaryModelProfileId,
    );
    const primaryApiKey = await this.services.resolveApiKey(primaryProvider.apiKeyRef);
    const backgroundProvider = await this.resolveBackgroundProvider(input.profile);
    const recentHistory = existingSummary
      ? input.history
          .filter((message) => Date.parse(message.createdAt) > Date.parse(existingSummary.createdAt))
          .slice(-8)
      : input.history.slice(-12);
    const history = recentHistory;
    const transcript = asTranscript(history);

    const snapshot = new TokenBudgetManager(
      input.profile.compactSoftThreshold,
      input.profile.compactHardThreshold,
    ).evaluate({
      texts: [
        input.profile.systemPrompt,
        input.userMessage,
        startupMemory.longterm,
        startupMemory.yesterday,
        startupMemory.today,
        existingSummary?.content ?? "",
        ...transcript,
      ],
      maxContextTokens: 32_000,
    });

    let compacted = false;
    let summary: string | undefined;
    let historySummary = existingSummary?.content ?? "";

    if (snapshot.softExceeded || snapshot.hardExceeded) {
      compacted = true;
      summary = await this.withOperationTimeout(
        () =>
          this.generateSummary({
            backgroundProvider,
            transcript: historySummary ? [historySummary, ...transcript] : transcript,
            memory,
            input,
            providerInvoker,
          }),
        this.operationTimeoutMs(input.profile.maxToolDurationMs, turnDeadlineAt),
        "AGENT_SUMMARY_TIMEOUT",
        "Conversation compaction timed out",
      );
      historySummary = summary;
      if (this.services.enqueueJob) {
        await this.services.enqueueJob({
          workspaceId: input.context.workspaceId,
          kind: "memory_refresh_before_compact",
          payload: {
            notes: summary,
          },
        });
      } else {
        await memory.executeTool("memory_refresh_before_compact", {
          notes: summary,
        });
      }
      await memory.writeSummarySnapshot(input.context.conversationId, summary);
    }

    const promptContext = [
      input.profile.systemPrompt,
      `Current time: ${input.context.nowIso} (${input.context.timezone})`,
      ...skillPrompts,
      "Available tools:",
      ...toolDescriptors.map((tool) => `- ${tool.id}: ${tool.description}`),
      "Long-term memory:",
      startupMemory.longterm || "(empty)",
      "Recent daily memory:",
      startupMemory.yesterday || "(empty)",
      startupMemory.today || "(empty)",
      historySummary ? `Compacted conversation summary:\n${historySummary}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const scratchpad: string[] = [];
    const toolRuns: AgentTurnResult["toolRuns"] = [];
    const toolMessages: Array<{ role: "tool"; content: string }> = [];
    let stepsUsed = 0;
    const useNativeToolCalling = supportsNativeToolCalling(primaryProvider);
    const nativeToolDefinitions = toProviderToolDefinitions(toolDescriptors);
    const nativePlanningMessages: ProviderMessage[] = useNativeToolCalling
      ? [
          {
            role: "system",
            content: `${promptContext}

You are operating inside a Telegram-native agent loop.
You may call tools when needed.
When enough information is available, respond directly with the user-facing answer.`,
          },
          ...toProviderHistoryMessages(history),
          {
            role: "user",
            content: input.userMessage,
          },
        ]
      : [];

    for (let step = 0; step < input.profile.maxPlanningSteps; step += 1) {
      stepsUsed = step + 1;
      if (useNativeToolCalling) {
        const providerResult = await this.withOperationTimeout(
          () =>
            providerInvoker({
              profile: primaryProvider,
              apiKey: primaryApiKey,
              input: {
                messages: nativePlanningMessages,
                tools: nativeToolDefinitions,
                toolChoice:
                  toolRuns.length >= input.profile.maxToolCalls ? "none" : "auto",
              },
            }),
          this.operationTimeoutMs(input.profile.maxToolDurationMs, turnDeadlineAt),
          "AGENT_PROVIDER_TIMEOUT",
          "Planner model timed out",
        );

        const providerToolCalls = providerResult.toolCalls ?? [];
        if (providerToolCalls.length === 0) {
          const directReply = providerResult.text.trim();
          if (directReply) {
            return {
              reply: directReply,
              turnId,
              stepCount: stepsUsed,
              toolRuns,
              compacted,
              summary,
            };
          }
          break;
        }

        nativePlanningMessages.push({
          role: "assistant",
          content: providerResult.text,
          toolCalls: providerToolCalls,
        });

        for (const toolCall of providerToolCalls) {
          if (toolRuns.length >= input.profile.maxToolCalls) {
            break;
          }
          const output = await this.withOperationTimeout(
            () =>
              this.executeTool({
                action: {
                  type: "call_tool",
                  toolId: toolCall.toolId,
                  input: toolCall.input,
                },
                input,
                memory,
                mcpServers,
                builtinToolIds,
                memoryToolIds,
              }),
            this.operationTimeoutMs(input.profile.maxToolDurationMs, turnDeadlineAt),
            "AGENT_TOOL_TIMEOUT",
            `Tool ${toolCall.toolId} timed out`,
          );
          const source = toolSourceFor(toolCall.toolId, builtinToolIds, memoryToolIds);
          const toolOutputText =
            typeof output === "string" ? output : JSON.stringify(output, null, 2);
          toolRuns.push({
            id: createId("tool"),
            toolId: toolCall.toolId,
            input: toolCall.input,
            output,
            source,
          });
          toolMessages.push({
            role: "tool",
            content: toolOutputText,
          });
          nativePlanningMessages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: toolOutputText,
          });
          scratchpad.push(`Tool ${toolCall.toolId} output:\n${toolOutputText}`);
        }
        continue;
      }

      const planningMessages = [
        {
          role: "system" as const,
          content: `${promptContext}

You are operating inside a Telegram-native agent loop.
Return strict JSON using one of these shapes only:
{"type":"final_response","content":"..."}
{"type":"call_tool","toolId":"...","input":{}}
{"type":"write_memory","target":"daily|longterm","content":"..."}
{"type":"compact_now"}
{"type":"abort","reason":"..."}

Rules:
- Use only one action per response.
- Prefer tools when they increase precision.
- If the user explicitly asks to remember something, write memory.
- If you already have enough information, produce final_response.`,
        },
        ...history.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        ...(scratchpad.length
          ? [
              {
                role: "assistant" as const,
                content: `Scratchpad:\n${scratchpad.join("\n\n")}`,
              },
            ]
          : []),
        {
          role: "user" as const,
          content: input.userMessage,
        },
      ];

      const action = parsePlannerAction(
        (
          await this.withOperationTimeout(
            () =>
              providerInvoker({
                profile: primaryProvider,
                apiKey: primaryApiKey,
                input: {
                  messages: planningMessages,
                  jsonMode: true,
                },
              }),
            this.operationTimeoutMs(input.profile.maxToolDurationMs, turnDeadlineAt),
            "AGENT_PROVIDER_TIMEOUT",
            "Planner model timed out",
          )
        ).text,
      );

      if (action.type === "final_response") {
        return {
          reply: action.content,
          turnId,
          stepCount: stepsUsed,
          toolRuns,
          compacted,
          summary,
        };
      }

      if (action.type === "abort") {
        return {
          reply: action.reason,
          turnId,
          stepCount: stepsUsed,
          toolRuns,
          compacted,
          summary,
        };
      }

      if (action.type === "compact_now") {
        compacted = true;
        summary = await this.withOperationTimeout(
          () =>
            this.generateSummary({
              backgroundProvider,
              transcript: [...transcript, ...scratchpad],
              memory,
              input,
              providerInvoker,
            }),
          this.operationTimeoutMs(input.profile.maxToolDurationMs, turnDeadlineAt),
          "AGENT_SUMMARY_TIMEOUT",
          "Conversation compaction timed out",
        );
        historySummary = summary;
        await memory.writeSummarySnapshot(input.context.conversationId, summary);
        scratchpad.push(`Compacted history:\n${summary}`);
        continue;
      }

      if (action.type === "write_memory") {
        if (action.target === "longterm") {
          await memory.upsertLongterm(action.content);
        } else {
          await memory.appendDaily(action.content, new Date(input.context.nowIso));
        }
        scratchpad.push(`Memory written to ${action.target}: ${action.content}`);
        continue;
      }

      if (toolRuns.length >= input.profile.maxToolCalls) {
        break;
      }

      const output = await this.withOperationTimeout(
        () =>
          this.executeTool({
            action,
            input,
            memory,
            mcpServers,
            builtinToolIds,
            memoryToolIds,
          }),
        this.operationTimeoutMs(input.profile.maxToolDurationMs, turnDeadlineAt),
        "AGENT_TOOL_TIMEOUT",
        `Tool ${action.toolId} timed out`,
      );

      const source = toolSourceFor(action.toolId, builtinToolIds, memoryToolIds);
      toolRuns.push({
        id: createId("tool"),
        toolId: action.toolId,
        input: action.input,
        output,
        source,
      });
      toolMessages.push({
        role: "tool",
        content: typeof output === "string" ? output : JSON.stringify(output, null, 2),
      });
      scratchpad.push(
        `Tool ${action.toolId} output:\n${typeof output === "string" ? output : JSON.stringify(output, null, 2)}`,
      );
    }

    if (useNativeToolCalling) {
      try {
        const finalProviderReply = await this.withOperationTimeout(
          () =>
            providerInvoker({
              profile: primaryProvider,
              apiKey: primaryApiKey,
              input: {
                messages: nativePlanningMessages,
                tools: nativeToolDefinitions,
                toolChoice: "none",
              },
            }),
          this.operationTimeoutMs(input.profile.maxToolDurationMs, turnDeadlineAt),
          "AGENT_PROVIDER_TIMEOUT",
          "Final response generation timed out",
        );
        const text = finalProviderReply.text.trim();
        if (text) {
          return {
            reply: text,
            turnId,
            stepCount: stepsUsed || input.profile.maxPlanningSteps,
            toolRuns,
            compacted,
            summary,
          };
        }
      } catch {
        // Fall through to legacy final-response path.
      }
    }

    const finalMessages = [
      {
        role: "system" as const,
        content: `${promptContext}

Produce the final user-facing answer for Telegram. Keep it concise and grounded in the scratchpad.`,
      },
      ...history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      ...toolMessages,
      {
        role: "assistant" as const,
        content: `Scratchpad:\n${scratchpad.join("\n\n")}`,
      },
      {
        role: "user" as const,
        content: input.userMessage,
      },
    ];

    return {
      reply: await this.resolveFinalReply({
        input,
        primaryProvider,
        primaryApiKey,
        providerInvoker,
        messages: finalMessages,
        turnDeadlineAt,
      }),
      turnId,
      stepCount: stepsUsed || input.profile.maxPlanningSteps,
      toolRuns,
      compacted,
      summary,
    };
  }

  private async resolveBackgroundProvider(profile: AgentProfile): Promise<{
    profile: ProviderProfile;
    apiKey: string;
  } | null> {
    const preferredProfileIds = [
      profile.backgroundModelProfileId,
      profile.primaryModelProfileId,
    ].filter((value): value is string => Boolean(value));

    if (preferredProfileIds.length === 0) {
      return null;
    }

    for (const providerProfileId of preferredProfileIds) {
      try {
        const provider = await this.services.resolveProviderProfile(providerProfileId);
        const apiKey = await this.services.resolveApiKey(provider.apiKeyRef);
        return { profile: provider, apiKey };
      } catch {
        continue;
      }
    }

    return null;
  }

  private async generateSummary(args: {
    backgroundProvider: { profile: ProviderProfile; apiKey: string } | null;
    transcript: string[];
    memory: MemoryStoreLike;
    input: AgentTurnInput;
    providerInvoker: NonNullable<AgentExecutionServices["invokeProvider"]> | typeof invokeProvider;
  }): Promise<string> {
    const compacted = args.memory.compactTranscript(args.transcript);
    if (!args.backgroundProvider) {
      return compacted;
    }

    try {
      const response = await args.providerInvoker({
        profile: args.backgroundProvider.profile,
        apiKey: args.backgroundProvider.apiKey,
        input: {
          messages: [
            {
              role: "system",
              content:
                "Summarize the conversation for future compacted context. Focus on user goals, constraints, unfinished tasks, remembered facts, and relevant tool outputs.",
            },
            {
              role: "user",
              content: args.transcript.join("\n"),
            },
          ],
          maxOutputTokens: 1024,
        },
      });
      return response.text || compacted;
    } catch {
      return compacted;
    }
  }

  private async executeTool(args: {
    action: Extract<PlannerAction, { type: "call_tool" }>;
    input: AgentTurnInput;
    memory: MemoryStoreLike;
    mcpServers: McpServerConfig[];
    builtinToolIds: Set<string>;
    memoryToolIds: Set<string>;
  }): Promise<unknown> {
    const payload = args.action.input ?? {};
    if (args.action.toolId === "search_web") {
      return this.executeSearchRouter({
        query: String(payload.query ?? payload.q ?? ""),
        input: args.input,
        mcpServers: args.mcpServers,
      });
    }
    if (args.builtinToolIds.has(args.action.toolId)) {
      return this.plugins.executeTool(args.action.toolId, payload, {
        workspaceId: args.input.context.workspaceId,
        timezone: args.input.context.timezone,
        searchSettings: args.input.context.searchSettings,
      });
    }
    if (args.memoryToolIds.has(args.action.toolId)) {
      return args.memory.executeTool(args.action.toolId, payload);
    }
    if (args.action.toolId.startsWith("mcp:")) {
      return this.mcp.invokeTool(args.action.toolId, payload, args.mcpServers);
    }
    return {
      error: `Unknown tool: ${args.action.toolId}`,
    };
  }

  private async resolveTools(
    profile: AgentProfile,
    context: AgentRuntimeContext,
    memoryTools: ToolDescriptor[],
    mcpServers: McpServerConfig[],
  ): Promise<ToolDescriptor[]> {
    const mcpTools = await this.mcp.listToolDescriptors(mcpServers);
    const enabledPluginIds = new Set(
      context.runtime.enabledPlugins.map((plugin) => plugin.id),
    );
    const searchProviders = new Set(context.searchSettings.providerPriority);
    const hasRoutableSearchProvider =
      (searchProviders.has("google_native") &&
        enabledPluginIds.has("native-google-search")) ||
      (searchProviders.has("bing_native") &&
        enabledPluginIds.has("native-bing-search")) ||
      (searchProviders.has("web_browse") &&
        enabledPluginIds.has("web-browse-fetcher")) ||
      (searchProviders.has("exa_mcp") &&
        mcpTools.some((tool) =>
          /exa/i.test(`${tool.id} ${tool.title} ${tool.description}`) &&
          /search/i.test(`${tool.id} ${tool.title} ${tool.description}`),
        ));
    const routedSearchTool: ToolDescriptor = {
      id: "search_web",
      title: "Search Web",
      description: `Search the web using the configured provider priority (${context.searchSettings.providerPriority.join(" -> ")}) and fallback strategy (${context.searchSettings.fallbackStrategy}).`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      permissionScopes: ["network:search"],
      source: "builtin",
    };
    const tools = [
      ...(context.searchSettings.allowNetwork && hasRoutableSearchProvider
        ? [routedSearchTool]
        : []),
      ...this.plugins.listTools(
        context.runtime.enabledPlugins.map((plugin) => plugin.id),
      ),
      ...memoryTools,
      ...mcpTools,
    ];
    return tools.filter((tool) => {
      if (tool.source === "mcp" && !profile.allowMcpTools) {
        return false;
      }
      const scopes = new Set(tool.permissionScopes);
      if (!profile.allowNetworkTools && [...scopes].some((scope) => scope.startsWith("network:"))) {
        return false;
      }
      if (!profile.allowWriteTools && [...scopes].some((scope) =>
        scope.startsWith("memory:write") || scope.includes("workspace:")
      )) {
        return false;
      }
      return true;
    });
  }

  private async resolveFinalReply(args: {
    input: AgentTurnInput;
    primaryProvider: ProviderProfile;
    primaryApiKey: string;
    providerInvoker: NonNullable<AgentExecutionServices["invokeProvider"]> | typeof invokeProvider;
    messages: ProviderInvocationInput["messages"];
    turnDeadlineAt: number;
  }): Promise<string> {
    if (
      !args.input.streamReply ||
      !args.primaryProvider.stream ||
      !supportsProviderTextStreaming(args.primaryProvider)
    ) {
      return (
        await this.withOperationTimeout(
          () =>
            args.providerInvoker({
              profile: args.primaryProvider,
              apiKey: args.primaryApiKey,
              input: {
                messages: args.messages,
              },
            }),
          this.operationTimeoutMs(
            args.input.profile.maxToolDurationMs,
            args.turnDeadlineAt,
          ),
          "AGENT_PROVIDER_TIMEOUT",
          "Final response generation timed out",
        )
      ).text;
    }

    try {
      let streamedText = "";
      const iterator = invokeProviderStream({
        profile: args.primaryProvider,
        apiKey: args.primaryApiKey,
        input: {
          messages: args.messages,
        },
      })[Symbol.asyncIterator]();
      while (true) {
        const next = await this.withOperationTimeout(
          () => iterator.next(),
          this.operationTimeoutMs(
            args.input.profile.maxToolDurationMs,
            args.turnDeadlineAt,
          ),
          "AGENT_PROVIDER_TIMEOUT",
          "Final response generation timed out",
        );
        if (next.done) {
          break;
        }
        streamedText = next.value.accumulated;
        await args.input.streamReply.onPartial(streamedText);
      }
      if (streamedText) {
        return streamedText;
      }
      return (
        await this.withOperationTimeout(
          () =>
            args.providerInvoker({
              profile: args.primaryProvider,
              apiKey: args.primaryApiKey,
              input: {
                messages: args.messages,
              },
            }),
          this.operationTimeoutMs(
            args.input.profile.maxToolDurationMs,
            args.turnDeadlineAt,
          ),
          "AGENT_PROVIDER_TIMEOUT",
          "Final response generation timed out",
        )
      ).text;
    } catch {
      return (
        await this.withOperationTimeout(
          () =>
            args.providerInvoker({
              profile: args.primaryProvider,
              apiKey: args.primaryApiKey,
              input: {
                messages: args.messages,
              },
            }),
          this.operationTimeoutMs(
            args.input.profile.maxToolDurationMs,
            args.turnDeadlineAt,
          ),
          "AGENT_PROVIDER_TIMEOUT",
          "Final response generation timed out",
        )
      ).text;
    }
  }

  private operationTimeoutMs(
    maxOperationMs: number,
    turnDeadlineAt: number,
  ): number {
    const remainingTurnMs = Math.max(0, turnDeadlineAt - Date.now());
    return Math.min(maxOperationMs, remainingTurnMs);
  }

  private async withOperationTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    code: string,
    message: string,
  ): Promise<T> {
    if (timeoutMs <= 0) {
      throw new AppError(code, message, 504);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new AppError(code, message, 504));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async executeSearchRouter(args: {
    query: string;
    input: AgentTurnInput;
    mcpServers: McpServerConfig[];
  }): Promise<unknown> {
    const query = args.query.trim();
    if (!query) {
      return {
        error: "Search query is required",
      };
    }

    const priority = args.input.context.searchSettings.providerPriority;
    const maxResults = args.input.context.searchSettings.maxResults;
    const failures: string[] = [];
    const enabledPluginIds = new Set(
      args.input.context.runtime.enabledPlugins.map((plugin) => plugin.id),
    );

    for (const provider of priority) {
      try {
        if (provider === "google_native" && enabledPluginIds.has("native-google-search")) {
          const result = await this.plugins.executeTool("google_search", { query, maxResults }, {
            workspaceId: args.input.context.workspaceId,
            timezone: args.input.context.timezone,
            searchSettings: args.input.context.searchSettings,
          });
          if (result && typeof result === "object" && Array.isArray((result as { results?: unknown[] }).results) && (result as { results?: unknown[] }).results?.length) {
            return result;
          }
        }

        if (provider === "bing_native" && enabledPluginIds.has("native-bing-search")) {
          const result = await this.plugins.executeTool("bing_search", { query, maxResults }, {
            workspaceId: args.input.context.workspaceId,
            timezone: args.input.context.timezone,
            searchSettings: args.input.context.searchSettings,
          });
          if (result && typeof result === "object" && Array.isArray((result as { results?: unknown[] }).results) && (result as { results?: unknown[] }).results?.length) {
            return result;
          }
        }

        if (provider === "exa_mcp") {
          const exaTool = (await this.mcp.listToolDescriptors(args.mcpServers)).find((tool) =>
            tool.id.startsWith("mcp:") &&
            /exa/i.test(tool.id) &&
            /search/i.test(`${tool.id} ${tool.title} ${tool.description}`),
          );
          if (exaTool) {
            const result = await this.mcp.invokeTool(
              exaTool.id,
              {
                query,
                limit: maxResults,
                numResults: maxResults,
              },
              args.mcpServers,
            );
            return result;
          }
        }

        if (provider === "web_browse" && /^https?:\/\//i.test(query) && enabledPluginIds.has("web-browse-fetcher")) {
          return this.plugins.executeTool("web_browse", { url: query }, {
            workspaceId: args.input.context.workspaceId,
            timezone: args.input.context.timezone,
            searchSettings: args.input.context.searchSettings,
          });
        }
      } catch (error) {
        failures.push(`${provider}: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }

    if (
      args.input.context.searchSettings.fallbackStrategy === "browse_only" &&
      enabledPluginIds.has("web-browse-fetcher") &&
      /^https?:\/\//i.test(query)
    ) {
      try {
        return await this.plugins.executeTool("web_browse", { url: query }, {
          workspaceId: args.input.context.workspaceId,
          timezone: args.input.context.timezone,
          searchSettings: args.input.context.searchSettings,
        });
      } catch (error) {
        failures.push(`web_browse: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }

    return {
      query,
      error: "No configured search provider returned results",
      failures,
    };
  }

  public async previewTools(args: {
    profile: AgentProfile;
    context: AgentRuntimeContext;
  }): Promise<ToolDescriptor[]> {
    const mcpServers = await this.services.listEnabledMcpServers(
      args.context.runtime.enabledMcpServers.map((server) => server.id),
    );
    return this.resolveTools(
      args.profile,
      args.context,
      listMemoryToolDescriptors(),
      mcpServers,
    );
  }

  private async loadLatestConversationSummary(
    conversationId: string,
  ): Promise<ConversationSummary | null> {
    const listConversationSummaries = this.services.listConversationSummaries;
    if (!listConversationSummaries) {
      return null;
    }
    const summaries = await listConversationSummaries(conversationId);
    return summaries
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }
}

export * from "./graph/index.js";
