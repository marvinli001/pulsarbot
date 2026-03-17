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
  type ProviderToolCall,
  type ProviderToolDefinition,
} from "@pulsarbot/providers";
import {
  AgentActionSchema,
  type AgentAction,
  type AgentGraphState,
  type AgentMemoryLedger,
  type AgentSpecialistKind,
  type AgentSubgraph,
  type AgentToolLedger,
  type LooseJsonValue,
  PlannerActionSchema,
  type ConversationSummary,
  type AgentProfile,
  type McpServerConfig,
  type MessageRecord,
  type ProviderProfile,
  type ResolvedRuntimeSnapshot,
  type SearchSettings,
  type ToolDescriptor,
} from "@pulsarbot/shared";
import { runGraph } from "./graph/index.js";

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
    timeoutMs?: number | undefined;
  }): Promise<ProviderInvocationResult>;
}

export interface AgentTurnInput {
  profile: AgentProfile;
  userMessage: string;
  history: MessageRecord[];
  context: AgentRuntimeContext;
  resumeState?: AgentGraphState | undefined;
  observer?: AgentGraphObserver | undefined;
  streamReply?: {
    onPartial(text: string): Promise<void>;
  };
}

export interface AgentGraphObserver {
  onNodeStarted?(args: {
    nodeId: string;
    subgraph: AgentSubgraph;
    state: AgentGraphState;
    attempt: number;
  }): Promise<void> | void;
  onNodeSucceeded?(args: {
    nodeId: string;
    subgraph: AgentSubgraph;
    state: AgentGraphState;
    attempt: number;
  }): Promise<void> | void;
  onNodeFailed?(args: {
    nodeId: string;
    subgraph: AgentSubgraph;
    state: AgentGraphState;
    attempt: number;
    error: unknown;
  }): Promise<void> | void;
  onActionPlanned?(args: {
    action: AgentAction;
    state: AgentGraphState;
  }): Promise<void> | void;
  onToolUpdated?(args: {
    tool: AgentToolLedger;
    previous: AgentToolLedger | null;
    state: AgentGraphState;
  }): Promise<void> | void;
  onStatePatched?(args: {
    state: AgentGraphState;
  }): Promise<void> | void;
  onSubgraphEntered?(args: {
    subgraph: AgentSpecialistKind;
    state: AgentGraphState;
  }): Promise<void> | void;
  onSubgraphExited?(args: {
    subgraph: AgentSpecialistKind;
    state: AgentGraphState;
    status: "succeeded" | "failed";
  }): Promise<void> | void;
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
  agentState: AgentGraphState;
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

function parsePlannerAction(text: string): AgentAction {
  const parsed = extractJson(text);
  if (parsed && typeof parsed === "object") {
    if ("type" in parsed) {
      return AgentActionSchema.parse(parsed);
    }
    const legacy = parsed as {
      finalResponse?: string;
      toolCalls?: Array<{ toolId: string; input?: Record<string, unknown> }>;
    };
    if (legacy.toolCalls?.length) {
      return AgentActionSchema.parse({
        type: "call_tool",
        toolId: legacy.toolCalls[0]?.toolId,
        input: legacy.toolCalls[0]?.input ?? {},
      });
    }
    if (legacy.finalResponse) {
      return AgentActionSchema.parse({
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

function defaultAgentGraphState(existingSummary = ""): AgentGraphState {
  return {
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
      existing: existingSummary,
      working: existingSummary,
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
  };
}

function inputAgentState(
  resumeState: AgentGraphState | undefined,
  existingSummary: string,
): AgentGraphState {
  if (!resumeState) {
    return defaultAgentGraphState(existingSummary);
  }
  const state = snapshotAgentState(resumeState);
  state.summary.existing ||= existingSummary;
  state.summary.working ||= existingSummary;
  return state;
}

function snapshotAgentState(state: AgentGraphState): AgentGraphState {
  return JSON.parse(JSON.stringify(state)) as AgentGraphState;
}

function attachActionMetadata(action: AgentAction): AgentAction {
  if (action.type === "call_tool") {
    return {
      ...action,
      input: {
        ...action.input,
        __pulsar_callId: typeof action.input.__pulsar_callId === "string"
          ? action.input.__pulsar_callId
          : createId("tool"),
      },
    };
  }
  return action;
}

function stripPlannerMetadata(input: Record<string, unknown>): Record<string, LooseJsonValue> {
  const next = { ...input };
  delete next.__pulsar_callId;
  delete next.__pulsar_memoryId;
  return JSON.parse(JSON.stringify(next)) as Record<string, LooseJsonValue>;
}

function inferSubgraphForNode(
  nodeId: string,
  state: AgentGraphState,
): AgentSubgraph {
  if (nodeId.startsWith("research_")) {
    return "research";
  }
  if (nodeId.startsWith("memory_")) {
    return "memory";
  }
  if (nodeId.startsWith("document_")) {
    return "document";
  }
  return state.currentSubgraph ?? "main";
}

function toolOutputText(output: unknown): string {
  return typeof output === "string"
    ? output
    : JSON.stringify(output, null, 2);
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

function resultItemsFromSearchOutput(output: unknown): unknown[] | null {
  if (!output || typeof output !== "object") {
    return null;
  }
  const results = (output as { results?: unknown }).results;
  return Array.isArray(results) ? results : null;
}

function resolveBrowseTarget(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/\s/.test(trimmed)) {
    return null;
  }

  try {
    const url = new URL(`https://${trimmed}`);
    if (!url.hostname.includes(".")) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
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
    const effectiveMaxTurnDurationMs = this.effectiveMaxTurnDurationMs(input.profile);
    const effectiveMaxPlannerDurationMs = this.effectiveMaxPlannerDurationMs(input.profile);
    const effectiveMaxToolDurationMs = this.effectiveMaxToolDurationMs(input.profile);
    const turnDeadlineAt = Date.now() + effectiveMaxTurnDurationMs;
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
    return this.runTurnV2({
      input,
      turnId,
      history,
      transcript,
      existingSummary: existingSummary?.content ?? "",
      startupMemory,
      memory,
      mcpServers,
      toolDescriptors,
      builtinToolIds,
      memoryToolIds,
      providerInvoker,
      primaryProvider,
      primaryApiKey,
      backgroundProvider,
      effectiveMaxPlannerDurationMs,
      effectiveMaxToolDurationMs,
      turnDeadlineAt,
      skillPrompts,
    });
  }

  private async runTurnV2(args: {
    input: AgentTurnInput;
    turnId: string;
    history: MessageRecord[];
    transcript: string[];
    existingSummary: string;
    startupMemory: {
      longterm: string;
      today: string;
      yesterday: string;
    };
    memory: MemoryStoreLike;
    mcpServers: McpServerConfig[];
    toolDescriptors: ToolDescriptor[];
    builtinToolIds: Set<string>;
    memoryToolIds: Set<string>;
    providerInvoker: NonNullable<AgentExecutionServices["invokeProvider"]> | typeof invokeProvider;
    primaryProvider: ProviderProfile;
    primaryApiKey: string;
    backgroundProvider: { profile: ProviderProfile; apiKey: string } | null;
    effectiveMaxPlannerDurationMs: number;
    effectiveMaxToolDurationMs: number;
    turnDeadlineAt: number;
    skillPrompts: string[];
  }): Promise<AgentTurnResult> {
    const useNativeToolCalling = supportsNativeToolCalling(args.primaryProvider);
    const agentState = inputAgentState(args.input.resumeState, args.existingSummary);
    const toolMessages: Array<{ role: "tool"; content: string }> = [];
    const toolRuns: AgentTurnResult["toolRuns"] = [];
    let compacted = Boolean(args.input.resumeState?.summary.working);
    let summary: string | undefined = agentState.summary.working || undefined;
    let specialistResultText = "";
    let lastExecutedToolCallId: string | null = null;
    let lastExecutedMemoryId: string | null = null;

    const observeState = async () => {
      await args.input.observer?.onStatePatched?.({
        state: snapshotAgentState(agentState),
      });
    };

    const currentSummary = () => agentState.summary.working || agentState.summary.existing;
    const scratchpadTexts = () => agentState.scratchpad.map((entry) => entry.text);
    const telegramReplyStyleGuide = [
      "Telegram reply formatting rules:",
      "- Use only this formatting subset when styling helps: ### headings, **bold**, > blockquotes, numbered or hyphen lists, `inline code`, fenced code blocks, [label](https://url), and ~~strikethrough~~.",
      "- Never output markdown tables. Rewrite them as bullets or 'Label: value' lines.",
      "- Keep list nesting shallow: at most two levels.",
      "- Do not output raw HTML.",
      "- Prefer short paragraphs and flat bullets when formatting is optional.",
    ].join("\n");
    const promptContext = () =>
      [
        args.input.profile.systemPrompt,
        `Current time: ${args.input.context.nowIso} (${args.input.context.timezone})`,
        ...args.skillPrompts,
        telegramReplyStyleGuide,
        this.buildRuntimeCapabilitySummary(args.input.context, args.toolDescriptors),
        "Available tools:",
        ...args.toolDescriptors.map((tool) => `- ${tool.id}: ${tool.description}`),
        "Long-term memory:",
        args.startupMemory.longterm || "(empty)",
        "Recent daily memory:",
        args.startupMemory.yesterday || "(empty)",
        args.startupMemory.today || "(empty)",
        currentSummary() ? `Compacted conversation summary:\n${currentSummary()}` : "",
      ]
        .filter(Boolean)
        .join("\n");

    const planningMessages = () => [
      {
        role: "system" as const,
        content: `${promptContext()}

You are operating inside a Telegram-native agent graph.
Return strict JSON using one of these shapes only:
{"type":"final_response","content":"..."}
{"type":"call_tool","toolId":"...","input":{}}
{"type":"write_memory","target":"daily|longterm","content":"..."}
{"type":"compact_now"}
{"type":"delegate_specialist","specialist":"research|memory|document","goal":"...","input":{}}
{"type":"abort","reason":"..."}

Rules:
- Use only one action per response.
- Prefer delegate_specialist when a task is clearly about research, memory, or document handling.
- If tool budget is exhausted, return final_response.
- If the user explicitly asks to remember something, use write_memory or delegate_specialist(memory).`,
      },
      ...args.history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      ...(agentState.scratchpad.length
        ? [
            {
              role: "assistant" as const,
              content: `Scratchpad:\n${scratchpadTexts().join("\n\n")}`,
            },
          ]
        : []),
      {
        role: "user" as const,
        content: args.input.userMessage,
      },
    ];

    const nativeToolReplayMessages = (): ProviderMessage[] =>
      agentState.toolLedger.flatMap((tool) => {
        const messages: ProviderMessage[] = [{
          role: "assistant",
          content: "",
          toolCalls: [{
            id: tool.callId,
            toolId: tool.toolId,
            input: tool.input,
          } satisfies ProviderToolCall],
        }];
        if (tool.status !== "pending") {
          messages.push({
            role: "tool",
            content: toolOutputText(tool.output),
            toolCallId: tool.callId,
          });
        }
        return messages;
      });

    const nativeMessages = (mode: "planner" | "final"): ProviderMessage[] => [
      {
        role: "system",
        content: mode === "planner"
          ? `${promptContext()}

You are operating inside a Telegram-native agent graph.
You may call tools when needed. When enough information is available, respond directly with the user-facing answer.`
          : `${promptContext()}

Produce the final user-facing answer for Telegram. Keep it concise and grounded in the scratchpad and tool results. Do not call more tools.`,
      },
      ...toProviderHistoryMessages(args.history),
      ...(agentState.scratchpad.length
        ? [{
            role: "assistant" as const,
            content: `Scratchpad:\n${scratchpadTexts().join("\n\n")}`,
          }]
        : []),
      {
        role: "user",
        content: args.input.userMessage,
      },
      ...nativeToolReplayMessages(),
    ];

    const syncToolRuns = () => {
      toolRuns.splice(0, toolRuns.length, ...agentState.toolLedger
        .filter((tool) => tool.status !== "pending")
        .map((tool) => ({
          id: tool.callId,
          toolId: tool.toolId,
          input: stripPlannerMetadata(tool.input),
          output: tool.output,
          source: toolSourceFor(tool.toolId, args.builtinToolIds, args.memoryToolIds),
        })));
    };

    const refreshMemoryFromSummary = async (notes: string) => {
      if (this.services.enqueueJob) {
        await this.services.enqueueJob({
          workspaceId: args.input.context.workspaceId,
          kind: "memory_refresh_before_compact",
          payload: {
            notes,
          },
        });
        return;
      }
      await args.memory.executeTool("memory_refresh_before_compact", {
        notes,
      });
    };

    const appendScratchpad = async (entry: {
      kind: "observation" | "tool_result" | "memory_result" | "specialist_result" | "summary" | "decision";
      nodeId: string;
      subgraph: AgentSubgraph;
      text: string;
      id?: string;
    }) => {
      if (!entry.text.trim()) {
        return;
      }
      const id = entry.id ?? createId("scratch");
      if (agentState.scratchpad.some((item) => item.id === id)) {
        return;
      }
      agentState.scratchpad.push({
        id,
        kind: entry.kind,
        nodeId: entry.nodeId,
        subgraph: entry.subgraph,
        text: entry.text,
        createdAt: args.input.context.nowIso,
      });
      await observeState();
    };

    const registerAction = async (action: AgentAction) => {
      const nextAction = attachActionMetadata(action);
      agentState.lastAction = nextAction;
      agentState.pendingActions = [nextAction];
      if (nextAction.type === "final_response") {
        agentState.reply.draft = nextAction.content;
      }
      if (nextAction.type === "abort") {
        agentState.reply.draft = nextAction.reason;
      }
      await args.input.observer?.onActionPlanned?.({
        action: nextAction,
        state: snapshotAgentState(agentState),
      });
      await observeState();
      return nextAction;
    };

    const updateToolLedger = async (next: AgentToolLedger) => {
      const index = agentState.toolLedger.findIndex((tool) => tool.callId === next.callId);
      const previous = index >= 0 ? agentState.toolLedger[index] ?? null : null;
      if (index >= 0) {
        agentState.toolLedger[index] = next;
      } else {
        agentState.toolLedger.push(next);
      }
      syncToolRuns();
      await args.input.observer?.onToolUpdated?.({
        tool: next,
        previous,
        state: snapshotAgentState(agentState),
      });
      await observeState();
    };

    const updateMemoryLedger = async (next: AgentMemoryLedger) => {
      const index = agentState.memoryLedger.findIndex((item) => item.id === next.id);
      if (index >= 0) {
        agentState.memoryLedger[index] = next;
      } else {
        agentState.memoryLedger.push(next);
      }
      await observeState();
    };

    const findTool = (toolId: string) =>
      args.toolDescriptors.find((tool) => tool.id === toolId) ?? null;

    const executeToolLedger = async (toolId: string, input: Record<string, unknown>, subgraph: AgentSubgraph) => {
      const existingCallId = typeof input.__pulsar_callId === "string" ? input.__pulsar_callId : createId("tool");
      const cleanInput = stripPlannerMetadata(input);
      const startedAt = new Date().toISOString();
      await updateToolLedger({
        callId: existingCallId,
        toolId,
        subgraph,
        input: cleanInput,
        output: null,
        status: "pending",
        idempotencyKey: `tool:${args.turnId}:${existingCallId}`,
        attempt: 1,
        startedAt,
        finishedAt: null,
        error: null,
      });
      const output = await this.withOperationTimeout(
        () =>
          this.executeTool({
            action: {
              type: "call_tool",
              toolId,
              input: cleanInput,
            },
            input: args.input,
            memory: args.memory,
            mcpServers: args.mcpServers,
            builtinToolIds: args.builtinToolIds,
            memoryToolIds: args.memoryToolIds,
          }),
        this.operationTimeoutMs(args.effectiveMaxToolDurationMs, args.turnDeadlineAt),
        "AGENT_TOOL_TIMEOUT",
        `Tool ${toolId} timed out`,
      );
      agentState.counters.toolCallsUsed += 1;
      agentState.checkpoints.lastToolAt = new Date().toISOString();
      await updateToolLedger({
        callId: existingCallId,
        toolId,
        subgraph,
        input: cleanInput,
        output: JSON.parse(JSON.stringify(output ?? null)) as LooseJsonValue,
        status: "completed",
        idempotencyKey: `tool:${args.turnId}:${existingCallId}`,
        attempt: 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: null,
      });
      lastExecutedToolCallId = existingCallId;
      return output;
    };

    const buildFinalMessages = () => [
      {
        role: "system" as const,
        content: `${promptContext()}

Produce the final user-facing answer for Telegram. Keep it concise and grounded in the scratchpad.`,
      },
      ...args.history.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      ...toolMessages,
      ...(agentState.scratchpad.length
        ? [
            {
              role: "assistant" as const,
              content: `Scratchpad:\n${scratchpadTexts().join("\n\n")}`,
            },
          ]
        : []),
      {
        role: "user" as const,
        content: args.input.userMessage,
      },
    ];

    const snapshot = new TokenBudgetManager(
      args.input.profile.compactSoftThreshold,
      args.input.profile.compactHardThreshold,
    ).evaluate({
      texts: [
        args.input.profile.systemPrompt,
        args.input.userMessage,
        args.startupMemory.longterm,
        args.startupMemory.yesterday,
        args.startupMemory.today,
        args.existingSummary,
        ...args.transcript,
      ],
      maxContextTokens: 32_000,
    });

    const specialistStartNode = (specialist: AgentSpecialistKind) => {
      switch (specialist) {
        case "research":
          return "research_plan";
        case "memory":
          return "memory_plan";
        case "document":
          return "document_plan";
      }
    };

    const nodes = {
      bootstrap: {
        id: "bootstrap",
        run: async () => {
          agentState.status = "running";
          agentState.currentSubgraph = agentState.currentSubgraph ?? "main";
          agentState.summary.existing ||= args.existingSummary;
          agentState.summary.working ||= args.existingSummary;
          agentState.flags.needsCompaction ||= snapshot.softExceeded || snapshot.hardExceeded;
          await observeState();
        },
      },
      maybe_compact_history: {
        id: "maybe_compact_history",
        run: async () => {
          if (!agentState.flags.needsCompaction) {
            return;
          }
          compacted = true;
          summary = await this.withOperationTimeout(
            () =>
              this.generateSummary({
                backgroundProvider: args.backgroundProvider,
                transcript: currentSummary()
                  ? [currentSummary(), ...args.transcript, ...scratchpadTexts()]
                  : [...args.transcript, ...scratchpadTexts()],
                memory: args.memory,
                input: args.input,
                providerInvoker: args.providerInvoker,
                timeoutMs: this.operationTimeoutMs(args.effectiveMaxToolDurationMs, args.turnDeadlineAt),
              }),
            this.operationTimeoutMs(args.effectiveMaxToolDurationMs, args.turnDeadlineAt),
            "AGENT_SUMMARY_TIMEOUT",
            "Conversation compaction timed out",
          );
          agentState.summary.working = summary;
          agentState.summary.refreshedAt = new Date().toISOString();
          agentState.flags.needsCompaction = false;
          agentState.flags.summaryDirty = false;
          await refreshMemoryFromSummary(summary);
          await args.memory.writeSummarySnapshot(args.input.context.conversationId, summary);
          await appendScratchpad({
            id: "summary:initial",
            kind: "summary",
            nodeId: "maybe_compact_history",
            subgraph: "main",
            text: `Compacted history:\n${summary}`,
          });
        },
      },
      load_memory_context: {
        id: "load_memory_context",
        run: async () => {
          await observeState();
        },
      },
      load_tool_catalog: {
        id: "load_tool_catalog",
        run: async () => {
          await observeState();
        },
      },
      select_planner_mode: {
        id: "select_planner_mode",
        run: async () => {
          agentState.plannerMode = useNativeToolCalling ? "native_tools" : "json_action";
          await observeState();
        },
      },
      plan_step: {
        id: "plan_step",
        run: async () => {
          if (agentState.pendingActions.length > 0) {
            return "route_action";
          }
          if (agentState.counters.planningStepsUsed >= args.input.profile.maxPlanningSteps) {
            await observeState();
            return "generate_final_response";
          }
          agentState.counters.planningStepsUsed += 1;
          agentState.iteration += 1;
          agentState.checkpoints.lastPlannerAt = new Date().toISOString();
          if (agentState.plannerMode === "native_tools") {
            const result = await this.withOperationTimeout(
              () =>
                args.providerInvoker({
                  profile: args.primaryProvider,
                  apiKey: args.primaryApiKey,
                  input: {
                    messages: nativeMessages("planner"),
                    tools: toProviderToolDefinitions(args.toolDescriptors),
                    toolChoice: agentState.counters.toolCallsUsed >= args.input.profile.maxToolCalls
                      ? "none"
                      : "auto",
                  },
                  timeoutMs: this.operationTimeoutMs(
                    args.effectiveMaxPlannerDurationMs,
                    args.turnDeadlineAt,
                  ),
                }),
              this.operationTimeoutMs(args.effectiveMaxPlannerDurationMs, args.turnDeadlineAt),
              "AGENT_PROVIDER_TIMEOUT",
              "Planner model timed out",
            );
            if (result.toolCalls?.length) {
              agentState.pendingActions = result.toolCalls.map((toolCall) =>
                attachActionMetadata({
                  type: "call_tool",
                  toolId: toolCall.toolId,
                  input: {
                    ...toolCall.input,
                    __pulsar_callId: toolCall.id || createId("tool"),
                  },
                })
              );
              agentState.lastAction = agentState.pendingActions[0] ?? null;
              await args.input.observer?.onActionPlanned?.({
                action: agentState.lastAction!,
                state: snapshotAgentState(agentState),
              });
              await observeState();
              return "route_action";
            }
            const content = result.text.trim();
            agentState.reply.draft = content || agentState.reply.draft;
            await observeState();
            return "generate_final_response";
          }

          const action = parsePlannerAction(
            (
              await this.withOperationTimeout(
                () =>
                  args.providerInvoker({
                    profile: args.primaryProvider,
                    apiKey: args.primaryApiKey,
                    input: {
                      messages: planningMessages(),
                      jsonMode: true,
                    },
                    timeoutMs: this.operationTimeoutMs(
                      args.effectiveMaxPlannerDurationMs,
                      args.turnDeadlineAt,
                    ),
                  }),
                this.operationTimeoutMs(args.effectiveMaxPlannerDurationMs, args.turnDeadlineAt),
                "AGENT_PROVIDER_TIMEOUT",
                "Planner model timed out",
              )
            ).text,
          );
          await registerAction(action);
          return "route_action";
        },
      },
      route_action: {
        id: "route_action",
        run: async () => {
          const action = agentState.pendingActions[0] ?? agentState.lastAction;
          if (!action) {
            return "generate_final_response";
          }
          switch (action.type) {
            case "final_response":
              return "generate_final_response";
            case "call_tool":
              return "execute_tool";
            case "write_memory":
              return "execute_memory_write";
            case "compact_now":
              return "refresh_summary";
            case "delegate_specialist":
              return "enter_specialist_subgraph";
            case "abort":
              return "abort_reply";
          }
        },
      },
      execute_tool: {
        id: "execute_tool",
        run: async () => {
          const action = agentState.pendingActions[0];
          if (!action || action.type !== "call_tool") {
            return "plan_step";
          }
          if (agentState.counters.toolCallsUsed >= args.input.profile.maxToolCalls) {
            agentState.pendingActions = [];
            agentState.lastAction = null;
            await observeState();
            return "generate_final_response";
          }
          await executeToolLedger(action.toolId, action.input, agentState.currentSubgraph ?? "main");
        },
      },
      record_tool_result: {
        id: "record_tool_result",
        run: async () => {
          const action = agentState.pendingActions[0];
          if (!action || action.type !== "call_tool") {
            return "plan_step";
          }
          const callId = typeof action.input.__pulsar_callId === "string"
            ? action.input.__pulsar_callId
            : lastExecutedToolCallId;
          const ledger = callId
            ? agentState.toolLedger.find((tool) => tool.callId === callId)
            : null;
          if (ledger) {
            const outputText = toolOutputText(ledger.output);
            toolMessages.push({
              role: "tool",
              content: outputText,
            });
            await appendScratchpad({
              id: `tool:${ledger.callId}`,
              kind: "tool_result",
              nodeId: "record_tool_result",
              subgraph: ledger.subgraph,
              text: `[tool:${ledger.callId}] ${ledger.toolId}\n${outputText}`,
            });
          }
          agentState.pendingActions = agentState.pendingActions.slice(1);
          agentState.lastAction = agentState.pendingActions[0] ?? null;
          await observeState();
          return agentState.pendingActions.length > 0 ? "route_action" : "plan_step";
        },
      },
      execute_memory_write: {
        id: "execute_memory_write",
        run: async () => {
          const action = agentState.pendingActions[0];
          if (!action || action.type !== "write_memory") {
            return "plan_step";
          }
          const memoryId = typeof action.content === "string"
            ? `mem:${args.turnId}:${agentState.memoryLedger.length + 1}`
            : createId("mem");
          const startedAt = new Date().toISOString();
          await updateMemoryLedger({
            id: memoryId,
            target: action.target,
            content: action.content,
            status: "pending",
            startedAt,
            finishedAt: null,
            error: null,
          });
          if (action.target === "longterm") {
            await args.memory.upsertLongterm(action.content);
          } else {
            await args.memory.appendDaily(action.content, new Date(args.input.context.nowIso));
          }
          await updateMemoryLedger({
            id: memoryId,
            target: action.target,
            content: action.content,
            status: "completed",
            startedAt,
            finishedAt: new Date().toISOString(),
            error: null,
          });
          lastExecutedMemoryId = memoryId;
        },
      },
      record_memory_result: {
        id: "record_memory_result",
        run: async () => {
          const action = agentState.pendingActions[0];
          const ledger = lastExecutedMemoryId
            ? agentState.memoryLedger.find((entry) => entry.id === lastExecutedMemoryId)
            : null;
          if (action?.type === "write_memory" && ledger) {
            await appendScratchpad({
              id: `memory:${ledger.id}`,
              kind: "memory_result",
              nodeId: "record_memory_result",
              subgraph: agentState.currentSubgraph ?? "main",
              text: `Memory written to ${ledger.target}: ${ledger.content}`,
            });
          }
          agentState.pendingActions = agentState.pendingActions.slice(1);
          agentState.lastAction = agentState.pendingActions[0] ?? null;
          await observeState();
          return "plan_step";
        },
      },
      refresh_summary: {
        id: "refresh_summary",
        run: async () => {
          compacted = true;
          summary = await this.withOperationTimeout(
            () =>
              this.generateSummary({
                backgroundProvider: args.backgroundProvider,
                transcript: [...args.transcript, ...scratchpadTexts()],
                memory: args.memory,
                input: args.input,
                providerInvoker: args.providerInvoker,
                timeoutMs: this.operationTimeoutMs(args.effectiveMaxToolDurationMs, args.turnDeadlineAt),
              }),
            this.operationTimeoutMs(args.effectiveMaxToolDurationMs, args.turnDeadlineAt),
            "AGENT_SUMMARY_TIMEOUT",
            "Conversation compaction timed out",
          );
          agentState.summary.working = summary;
          agentState.summary.refreshedAt = new Date().toISOString();
          agentState.flags.needsCompaction = false;
          agentState.flags.summaryDirty = false;
          await refreshMemoryFromSummary(summary);
          await args.memory.writeSummarySnapshot(args.input.context.conversationId, summary);
          await appendScratchpad({
            id: `summary:${agentState.iteration}`,
            kind: "summary",
            nodeId: "refresh_summary",
            subgraph: "main",
            text: `Compacted history:\n${summary}`,
          });
          if (agentState.pendingActions[0]?.type === "compact_now") {
            agentState.pendingActions = agentState.pendingActions.slice(1);
            agentState.lastAction = agentState.pendingActions[0] ?? null;
          }
          await observeState();
        },
      },
      enter_specialist_subgraph: {
        id: "enter_specialist_subgraph",
        run: async () => {
          const action = agentState.pendingActions[0];
          if (!action || action.type !== "delegate_specialist") {
            return "plan_step";
          }
          agentState.counters.specialistCallsUsed += 1;
          agentState.currentSubgraph = action.specialist;
          agentState.subgraphStack.push({
            id: createId("sub"),
            kind: action.specialist,
            entryNode: specialistStartNode(action.specialist),
            returnNode: "merge_specialist_result",
            goal: action.goal,
            status: "running",
            startedAt: new Date().toISOString(),
            finishedAt: null,
          });
          await args.input.observer?.onSubgraphEntered?.({
            subgraph: action.specialist,
            state: snapshotAgentState(agentState),
          });
          await observeState();
          return specialistStartNode(action.specialist);
        },
      },
      research_plan: {
        id: "research_plan",
        run: async () => {
          const action = agentState.pendingActions[0];
          if (action?.type !== "delegate_specialist") {
            return "merge_specialist_result";
          }
          specialistResultText = `Research goal: ${action.goal}`;
        },
      },
      research_search: {
        id: "research_search",
        run: async () => {
          const action = agentState.pendingActions[0];
          if (action?.type !== "delegate_specialist") {
            return "merge_specialist_result";
          }
          if (!findTool("search_web")) {
            specialistResultText = `${specialistResultText}\nSearch tool unavailable.`;
            return;
          }
          const query = String(action.input.query ?? action.goal);
          const output = await executeToolLedger("search_web", { query }, "research");
          specialistResultText = `${specialistResultText}\nSearch completed.`;
          if (output && typeof output === "object") {
            await observeState();
          }
        },
      },
      research_browse_optional: {
        id: "research_browse_optional",
        run: async () => {
          if (!findTool("web_browse")) {
            return;
          }
          const searchLedger = [...agentState.toolLedger]
            .reverse()
            .find((tool) => tool.subgraph === "research" && tool.toolId === "search_web");
          const firstResult = searchLedger && typeof searchLedger.output === "object" && searchLedger.output
            ? (searchLedger.output as { results?: Array<{ url?: string }> }).results?.[0]
            : undefined;
          const url = firstResult?.url;
          if (!url) {
            return;
          }
          await executeToolLedger("web_browse", { url }, "research");
          specialistResultText = `${specialistResultText}\nPrimary source fetched.`;
        },
      },
      research_summarize: {
        id: "research_summarize",
        run: async () => {
          const recentResearch = agentState.toolLedger
            .filter((tool) => tool.subgraph === "research" && tool.status === "completed")
            .map((tool) => `${tool.toolId}: ${typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2)}`)
            .join("\n\n");
          specialistResultText = [specialistResultText, recentResearch].filter(Boolean).join("\n\n");
        },
      },
      memory_plan: {
        id: "memory_plan",
        run: async () => {
          const action = agentState.pendingActions[0];
          if (action?.type !== "delegate_specialist") {
            return "merge_specialist_result";
          }
          specialistResultText = `Memory goal: ${action.goal}`;
        },
      },
      memory_read_optional: {
        id: "memory_read_optional",
        run: async () => {
          const action = agentState.pendingActions[0];
          if (action?.type !== "delegate_specialist" || !findTool("memory_search")) {
            return;
          }
          const query = typeof action.input.query === "string" ? action.input.query : action.goal;
          await executeToolLedger("memory_search", { query, limit: 5 }, "memory");
        },
      },
      memory_write_optional: {
        id: "memory_write_optional",
        run: async () => {
          const action = agentState.pendingActions[0];
          if (action?.type !== "delegate_specialist") {
            return;
          }
          const content = typeof action.input.content === "string"
            ? action.input.content
            : null;
          if (!content) {
            return;
          }
          const target = action.input.target === "longterm" ? "memory_upsert_longterm" : "memory_append_daily";
          if (findTool(target)) {
            await executeToolLedger(target, target === "memory_upsert_longterm"
              ? { content }
              : { text: content }, "memory");
          }
        },
      },
      memory_summarize: {
        id: "memory_summarize",
        run: async () => {
          const recentMemory = agentState.toolLedger
            .filter((tool) => tool.subgraph === "memory" && tool.status === "completed")
            .map((tool) => `${tool.toolId}: ${typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2)}`)
            .join("\n\n");
          specialistResultText = [specialistResultText, recentMemory].filter(Boolean).join("\n\n");
        },
      },
      document_plan: {
        id: "document_plan",
        run: async () => {
          const action = agentState.pendingActions[0];
          if (action?.type !== "delegate_specialist") {
            return "merge_specialist_result";
          }
          specialistResultText = `Document goal: ${action.goal}`;
        },
      },
      document_extract_optional: {
        id: "document_extract_optional",
        run: async () => {
          const action = agentState.pendingActions[0];
          if (action?.type !== "delegate_specialist" || !findTool("document_extract_text")) {
            return;
          }
          const text = typeof action.input.text === "string"
            ? action.input.text
            : args.input.userMessage;
          await executeToolLedger("document_extract_text", { text }, "document");
        },
      },
      document_query_optional: {
        id: "document_query_optional",
        run: async () => {
          const action = agentState.pendingActions[0];
          if (action?.type !== "delegate_specialist" || !findTool("memory_search")) {
            return;
          }
          const query = typeof action.input.query === "string" ? action.input.query : action.goal;
          await executeToolLedger("memory_search", { query, limit: 3 }, "document");
        },
      },
      document_summarize: {
        id: "document_summarize",
        run: async () => {
          const recentDocument = agentState.toolLedger
            .filter((tool) => tool.subgraph === "document" && tool.status === "completed")
            .map((tool) => `${tool.toolId}: ${typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2)}`)
            .join("\n\n");
          specialistResultText = [specialistResultText, recentDocument].filter(Boolean).join("\n\n");
        },
      },
      merge_specialist_result: {
        id: "merge_specialist_result",
        run: async () => {
          const frame = agentState.subgraphStack[agentState.subgraphStack.length - 1] ?? null;
          if (frame) {
            frame.status = "succeeded";
            frame.finishedAt = new Date().toISOString();
            await args.input.observer?.onSubgraphExited?.({
              subgraph: frame.kind,
              state: snapshotAgentState(agentState),
              status: "succeeded",
            });
          }
          await appendScratchpad({
            id: `specialist:${agentState.iteration}:${frame?.kind ?? "main"}`,
            kind: "specialist_result",
            nodeId: "merge_specialist_result",
            subgraph: agentState.currentSubgraph ?? "main",
            text: specialistResultText || "Specialist finished with no additional result.",
          });
          specialistResultText = "";
          agentState.subgraphStack = agentState.subgraphStack.slice(0, -1);
          agentState.currentSubgraph = "main";
          agentState.pendingActions = agentState.pendingActions.slice(1);
          agentState.lastAction = agentState.pendingActions[0] ?? null;
          await observeState();
        },
      },
      generate_final_response: {
        id: "generate_final_response",
        run: async () => {
          if (!agentState.reply.final) {
            const shouldUseNativeFinal =
              agentState.plannerMode === "native_tools" &&
              (Boolean(args.input.streamReply) || !agentState.reply.draft.trim());
            if (shouldUseNativeFinal) {
              agentState.reply.final = await this.resolveFinalReply({
                input: args.input,
                primaryProvider: args.primaryProvider,
                primaryApiKey: args.primaryApiKey,
                providerInvoker: args.providerInvoker,
                requestInput: {
                  messages: nativeMessages("final"),
                  tools: toProviderToolDefinitions(args.toolDescriptors),
                  toolChoice: "none",
                },
                maxOperationMs: args.effectiveMaxToolDurationMs,
                turnDeadlineAt: args.turnDeadlineAt,
              });
            } else {
              const text = agentState.reply.draft.trim();
              if (text) {
                agentState.reply.final = text;
              } else {
                agentState.reply.final = await this.resolveFinalReply({
                  input: args.input,
                  primaryProvider: args.primaryProvider,
                  primaryApiKey: args.primaryApiKey,
                  providerInvoker: args.providerInvoker,
                  requestInput: {
                    messages: buildFinalMessages(),
                  },
                  maxOperationMs: args.effectiveMaxToolDurationMs,
                  turnDeadlineAt: args.turnDeadlineAt,
                });
              }
            }
          }
          agentState.flags.finalReplyReady = true;
          agentState.reply.streamedChars = agentState.reply.final.length;
          await observeState();
          return "done";
        },
      },
      abort_reply: {
        id: "abort_reply",
        run: async () => {
          const action = agentState.pendingActions[0] ?? agentState.lastAction;
          agentState.reply.final = action?.type === "abort"
            ? action.reason
            : agentState.reply.draft || "The request was aborted.";
          agentState.status = "aborted";
          await observeState();
          return "done";
        },
      },
      done: {
        id: "done",
        run: async () => {
          agentState.status = agentState.status === "aborted" ? "aborted" : "succeeded";
          await observeState();
          return null;
        },
      },
    } satisfies Parameters<typeof runGraph<AgentGraphState, Record<string, never>>>[0]["nodes"];

    const nextNodeFor = (nodeId: string): string | null => {
      switch (nodeId) {
        case "bootstrap":
          return "maybe_compact_history";
        case "maybe_compact_history":
          return "load_memory_context";
        case "load_memory_context":
          return "load_tool_catalog";
        case "load_tool_catalog":
          return "select_planner_mode";
        case "select_planner_mode":
          return "plan_step";
        case "plan_step":
          return "route_action";
        case "route_action":
          return "plan_step";
        case "execute_tool":
          return "record_tool_result";
        case "record_tool_result":
          return agentState.pendingActions.length > 0 ? "route_action" : "plan_step";
        case "execute_memory_write":
          return "record_memory_result";
        case "record_memory_result":
          return "plan_step";
        case "refresh_summary":
          return "plan_step";
        case "enter_specialist_subgraph": {
          const action = agentState.pendingActions[0];
          return action?.type === "delegate_specialist"
            ? specialistStartNode(action.specialist)
            : "plan_step";
        }
        case "research_plan":
          return "research_search";
        case "research_search":
          return "research_browse_optional";
        case "research_browse_optional":
          return "research_summarize";
        case "research_summarize":
          return "merge_specialist_result";
        case "memory_plan":
          return "memory_read_optional";
        case "memory_read_optional":
          return "memory_write_optional";
        case "memory_write_optional":
          return "memory_summarize";
        case "memory_summarize":
          return "merge_specialist_result";
        case "document_plan":
          return "document_extract_optional";
        case "document_extract_optional":
          return "document_query_optional";
        case "document_query_optional":
          return "document_summarize";
        case "document_summarize":
          return "merge_specialist_result";
        case "merge_specialist_result":
          return "plan_step";
        case "generate_final_response":
        case "abort_reply":
          return "done";
        case "done":
          return null;
        default:
          return null;
      }
    };

    await runGraph({
      state: agentState,
      context: {},
      startNode: args.input.resumeState?.currentNode ?? "bootstrap",
      resolveNext: ({ nodeId }) => nextNodeFor(nodeId),
      hooks: {
        onNodeStarted: async ({ nodeId, attempt }) => {
          agentState.currentNode = nodeId;
          agentState.currentSubgraph = inferSubgraphForNode(nodeId, agentState);
          await args.input.observer?.onNodeStarted?.({
            nodeId,
            subgraph: agentState.currentSubgraph ?? "main",
            state: snapshotAgentState(agentState),
            attempt,
          });
          await observeState();
        },
        onNodeSucceeded: async ({ nodeId, attempt }) => {
          await args.input.observer?.onNodeSucceeded?.({
            nodeId,
            subgraph: inferSubgraphForNode(nodeId, agentState),
            state: snapshotAgentState(agentState),
            attempt,
          });
          await observeState();
        },
        onNodeFailed: async ({ nodeId, attempt, error }) => {
          agentState.status = "failed";
          await args.input.observer?.onNodeFailed?.({
            nodeId,
            subgraph: inferSubgraphForNode(nodeId, agentState),
            state: snapshotAgentState(agentState),
            attempt,
            error,
          });
          await observeState();
        },
      },
      nodes,
    });

    syncToolRuns();

    return {
      reply: agentState.reply.final || agentState.reply.draft || "done",
      turnId: args.turnId,
      stepCount: agentState.counters.planningStepsUsed,
      toolRuns,
      compacted,
      summary,
      agentState: snapshotAgentState(agentState),
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
    timeoutMs: number;
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
        timeoutMs: args.timeoutMs,
      });
      return response.text || compacted;
    } catch {
      return compacted;
    }
  }

  private async executeTool(args: {
    action: Extract<AgentAction, { type: "call_tool" }>;
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
    const allowedToolIds = new Set(context.runtime.allowedToolIds);
    const routedSearchAllowed = allowedToolIds.has("search_web") ||
      allowedToolIds.has("google_search") ||
      allowedToolIds.has("bing_search") ||
      allowedToolIds.has("web_browse") ||
      [...allowedToolIds].some((toolId) =>
        toolId.startsWith("mcp:") &&
        /exa/i.test(toolId) &&
        /search/i.test(toolId)
      );
    return tools.filter((tool) => {
      const isAllowedByBindings = allowedToolIds.size === 0 ||
        allowedToolIds.has(tool.id) ||
        (tool.id === "search_web" && routedSearchAllowed);
      if (!isAllowedByBindings) {
        return false;
      }
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

  private canStreamFinalReply(
    input: AgentTurnInput,
    provider: ProviderProfile,
  ): boolean {
    return Boolean(input.streamReply) &&
      provider.stream &&
      supportsProviderTextStreaming(provider);
  }

  private async resolveFinalReply(args: {
    input: AgentTurnInput;
    primaryProvider: ProviderProfile;
    primaryApiKey: string;
    providerInvoker: NonNullable<AgentExecutionServices["invokeProvider"]> | typeof invokeProvider;
    requestInput: ProviderInvocationInput;
    maxOperationMs: number;
    turnDeadlineAt: number;
  }): Promise<string> {
    const operationTimeoutMs = () =>
      this.operationTimeoutMs(args.maxOperationMs, args.turnDeadlineAt);
    if (
      !args.input.streamReply ||
      !args.primaryProvider.stream ||
      !supportsProviderTextStreaming(args.primaryProvider)
    ) {
      const timeoutMs = operationTimeoutMs();
      return (
        await this.withOperationTimeout(
          () =>
            args.providerInvoker({
              profile: args.primaryProvider,
              apiKey: args.primaryApiKey,
              input: args.requestInput,
              timeoutMs,
            }),
          timeoutMs,
          "AGENT_PROVIDER_TIMEOUT",
          "Final response generation timed out",
        )
      ).text;
    }

    try {
      let streamedText = "";
      const streamTimeoutMs = operationTimeoutMs();
      const iterator = invokeProviderStream({
        profile: args.primaryProvider,
        apiKey: args.primaryApiKey,
        input: args.requestInput,
        timeoutMs: streamTimeoutMs,
      })[Symbol.asyncIterator]();
      while (true) {
        const next = await this.withOperationTimeout(
          () => iterator.next(),
          operationTimeoutMs(),
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
      const timeoutMs = operationTimeoutMs();
      return (
        await this.withOperationTimeout(
          () =>
            args.providerInvoker({
              profile: args.primaryProvider,
              apiKey: args.primaryApiKey,
              input: args.requestInput,
              timeoutMs,
            }),
          timeoutMs,
          "AGENT_PROVIDER_TIMEOUT",
          "Final response generation timed out",
        )
      ).text;
    } catch {
      const timeoutMs = operationTimeoutMs();
      return (
        await this.withOperationTimeout(
          () =>
            args.providerInvoker({
              profile: args.primaryProvider,
              apiKey: args.primaryApiKey,
              input: args.requestInput,
              timeoutMs,
            }),
          timeoutMs,
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

  private effectiveMaxTurnDurationMs(profile: AgentProfile): number {
    return Math.max(profile.maxTurnDurationMs, 60_000);
  }

  private effectiveMaxToolDurationMs(profile: AgentProfile): number {
    return Math.max(profile.maxToolDurationMs, 30_000);
  }

  private effectiveMaxPlannerDurationMs(profile: AgentProfile): number {
    return Math.min(
      this.effectiveMaxTurnDurationMs(profile),
      Math.max(profile.maxToolDurationMs, 45_000),
    );
  }

  private buildRuntimeCapabilitySummary(
    context: AgentRuntimeContext,
    toolDescriptors: ToolDescriptor[],
  ): string {
    const enabledSkills = context.runtime.enabledSkills.map((skill) => skill.id);
    const enabledPlugins = context.runtime.enabledPlugins.map((plugin) => plugin.id);
    const enabledMcpServers = context.runtime.enabledMcpServers.map((server) => server.label);
    const blocked = context.runtime.blocked.map((item) =>
      `${item.scope}:${item.id} (${item.reason})`
    );

    return [
      "Runtime capability snapshot:",
      `- Enabled skills: ${enabledSkills.join(", ") || "(none)"}`,
      `- Enabled plugins: ${enabledPlugins.join(", ") || "(none)"}`,
      `- Enabled MCP servers: ${enabledMcpServers.join(", ") || "(none)"}`,
      `- Available tool ids right now: ${
        toolDescriptors.map((tool) => tool.id).join(", ") || "(none)"
      }`,
      `- Blocked runtime references: ${blocked.join("; ") || "(none)"}`,
      "If the user asks what you can do, answer from this runtime snapshot and do not claim disabled or missing tools.",
    ].join("\n");
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
    const browseTarget = resolveBrowseTarget(query);

    for (const provider of priority) {
      try {
        if (provider === "google_native" && enabledPluginIds.has("native-google-search")) {
          const result = await this.plugins.executeTool("google_search", { query, maxResults }, {
            workspaceId: args.input.context.workspaceId,
            timezone: args.input.context.timezone,
            searchSettings: args.input.context.searchSettings,
          });
          const results = resultItemsFromSearchOutput(result);
          if (results?.length) {
            return result;
          }
          failures.push("google_native: empty results");
        }

        if (provider === "bing_native" && enabledPluginIds.has("native-bing-search")) {
          const result = await this.plugins.executeTool("bing_search", { query, maxResults }, {
            workspaceId: args.input.context.workspaceId,
            timezone: args.input.context.timezone,
            searchSettings: args.input.context.searchSettings,
          });
          const results = resultItemsFromSearchOutput(result);
          if (results?.length) {
            return result;
          }
          failures.push("bing_native: empty results");
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

        if (provider === "web_browse" && browseTarget && enabledPluginIds.has("web-browse-fetcher")) {
          return this.plugins.executeTool("web_browse", { url: browseTarget }, {
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
      browseTarget
    ) {
      try {
        return await this.plugins.executeTool("web_browse", { url: browseTarget }, {
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
export * from "./task-runtime.js";
