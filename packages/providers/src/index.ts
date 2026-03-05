import { AppError, assertNever } from "@pulsarbot/core";
import {
  ProviderKindSchema,
  type ProviderKind,
  type LooseJsonValue,
  type ProviderProfile,
} from "@pulsarbot/shared";

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ProviderToolCall[];
  toolCallId?: string;
}

export interface ProviderToolCall {
  id: string;
  toolId: string;
  input: Record<string, LooseJsonValue>;
}

export interface ProviderToolDefinition {
  id: string;
  description: string;
  inputSchema: Record<string, LooseJsonValue>;
}

export type ProviderToolChoice =
  | "auto"
  | "none"
  | {
      type: "tool";
      toolId: string;
    };

export interface ProviderInvocationInput {
  model?: string;
  messages: ProviderMessage[];
  maxOutputTokens?: number;
  jsonMode?: boolean;
  tools?: ProviderToolDefinition[];
  toolChoice?: ProviderToolChoice;
}

export interface ProviderInvocationResult {
  text: string;
  raw: unknown;
  toolCalls?: ProviderToolCall[];
}

export interface ProviderRequestPreview {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ProviderStreamChunk {
  delta: string;
  accumulated: string;
}

export type ProviderMediaCapability = "vision" | "audio" | "document";
export type ProviderMediaInputKind = "image" | "audio" | "document";

export interface ProviderMediaInvocationInput {
  kind: ProviderMediaInputKind;
  prompt: string;
  rawBody: Uint8Array;
  mimeType: string;
  fileName?: string;
  maxOutputTokens?: number;
}

export interface ProviderMediaRequestPreview {
  url: string;
  headers: Record<string, string>;
  body: FormData | Record<string, unknown>;
}

export interface AgentProviderAdapter {
  kind: ProviderKind;
  buildRequest(
    profile: ProviderProfile,
    apiKey: string,
    input: ProviderInvocationInput,
  ): ProviderRequestPreview;
  parseResponse(payload: unknown): ProviderInvocationResult;
}

function defaultBaseUrl(kind: ProviderKind): string {
  switch (kind) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "bailian":
      return "https://dashscope.aliyuncs.com/compatible-mode/v1";
    case "openai_compatible_chat":
    case "openai_compatible_responses":
      return "https://api.openai.com/v1";
    default:
      return assertNever(kind);
  }
}

function compactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => Boolean(value)),
  );
}

function cloneJsonBody<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stripContentType(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type"),
  );
}

function mergeJsonHeaders(
  profile: ProviderProfile,
  headers: Record<string, string>,
): Record<string, string> {
  return compactHeaders({
    "content-type": "application/json",
    ...headers,
    ...profile.headers,
  });
}

function mergeFormHeaders(
  profile: ProviderProfile,
  headers: Record<string, string>,
): Record<string, string> {
  return compactHeaders({
    ...headers,
    ...stripContentType(profile.headers),
  });
}

function messageToOpenAiShape(message: ProviderMessage) {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.toolId,
          arguments: JSON.stringify(toolCall.input ?? {}),
        },
      })),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId ?? "",
    };
  }
  return {
    role: message.role,
    content: message.content,
  };
}

function parseToolInput(value: unknown): Record<string, LooseJsonValue> {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, LooseJsonValue>;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, LooseJsonValue>;
  }
  return {};
}

function normalizeOpenAiToolChoice(
  value: ProviderToolChoice | undefined,
): "auto" | "none" | { type: "function"; function: { name: string } } | undefined {
  if (!value || value === "auto" || value === "none") {
    return value;
  }
  return {
    type: "function",
    function: {
      name: value.toolId,
    },
  };
}

function normalizeAnthropicToolChoice(
  value: ProviderToolChoice | undefined,
): { type: "auto" | "any" | "tool"; name?: string } | undefined {
  if (!value || value === "auto") {
    return { type: "auto" };
  }
  if (value === "none") {
    return undefined;
  }
  return {
    type: "tool",
    name: value.toolId,
  };
}

function openAiToolDefinitions(input: ProviderInvocationInput) {
  if (!input.tools?.length) {
    return undefined;
  }
  return input.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.id,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function anthropicToolDefinitions(input: ProviderInvocationInput) {
  if (!input.tools?.length) {
    return undefined;
  }
  return input.tools.map((tool) => ({
    name: tool.id,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function geminiToolDeclarations(input: ProviderInvocationInput) {
  if (!input.tools?.length) {
    return undefined;
  }
  return input.tools.map((tool) => ({
    name: tool.id,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

function normalizeGeminiToolConfig(
  value: ProviderToolChoice | undefined,
):
  | {
      functionCallingConfig: {
        mode: "AUTO" | "NONE" | "ANY";
        allowedFunctionNames?: string[];
      };
    }
  | undefined {
  if (!value || value === "auto") {
    return {
      functionCallingConfig: {
        mode: "AUTO",
      },
    };
  }
  if (value === "none") {
    return {
      functionCallingConfig: {
        mode: "NONE",
      },
    };
  }
  return {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: [value.toolId],
    },
  };
}

function responsesToolDefinitions(input: ProviderInvocationInput) {
  if (!input.tools?.length) {
    return undefined;
  }
  return input.tools.map((tool) => ({
    type: "function",
    name: tool.id,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

function normalizeOpenRouterResponsesToolChoice(
  value: ProviderToolChoice | undefined,
): "auto" | "none" | { type: "function"; name: string } | undefined {
  if (!value || value === "auto" || value === "none") {
    return value;
  }
  return {
    type: "function",
    name: value.toolId,
  };
}

function normalizeBailianResponsesToolChoice(
  value: ProviderToolChoice | undefined,
):
  | "auto"
  | "none"
  | {
      type: "allowed_tools";
      mode: "required";
      tools: Array<{ type: "function"; name: string }>;
    }
  | undefined {
  if (!value || value === "auto" || value === "none") {
    return value;
  }
  return {
    type: "allowed_tools",
    mode: "required",
    tools: [
      {
        type: "function",
        name: value.toolId,
      },
    ],
  };
}

function messageToResponsesShape(message: ProviderMessage): Array<Record<string, unknown>> {
  if (message.role === "system") {
    return [];
  }
  if (message.role === "tool") {
    if (!message.toolCallId) {
      return message.content.trim()
        ? [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: message.content }],
            },
          ]
        : [];
    }
    return [
      {
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      },
    ];
  }

  const items: Array<Record<string, unknown>> = [];
  if (message.content.trim()) {
    items.push({
      type: "message",
      role: message.role,
      content: [
        {
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: message.content,
        },
      ],
    });
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    items.push(
      ...message.toolCalls.map((toolCall, index) => ({
        type: "function_call",
        id: `fc_${toolCall.id || index + 1}`,
        call_id: toolCall.id,
        name: toolCall.toolId,
        arguments: JSON.stringify(toolCall.input ?? {}),
      })),
    );
  }

  return items;
}

function responsesSystemInstructions(messages: ProviderMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
}

function responsesInputMessages(messages: ProviderMessage[]): Array<Record<string, unknown>> {
  return messages.flatMap((message) => messageToResponsesShape(message));
}

function parseTextFromUnknown(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload && typeof payload === "object") {
    const maybeText = (payload as Record<string, unknown>).text;
    if (typeof maybeText === "string") {
      return maybeText;
    }
  }

  return JSON.stringify(payload);
}

function extractTextBlocks(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextBlocks(item));
  }

  const record = value as Record<string, unknown>;
  const blocks: string[] = [];

  if (typeof record.text === "string") {
    blocks.push(record.text);
  }
  if (typeof record.content === "string") {
    blocks.push(record.content);
  }
  if (Array.isArray(record.content)) {
    blocks.push(...record.content.flatMap((item) => extractTextBlocks(item)));
  }
  if (Array.isArray(record.parts)) {
    blocks.push(...record.parts.flatMap((item) => extractTextBlocks(item)));
  }
  if (record.message && typeof record.message === "object") {
    blocks.push(...extractTextBlocks(record.message));
  }
  if (record.output && typeof record.output === "object") {
    blocks.push(...extractTextBlocks(record.output));
  }

  return blocks;
}

export function parseProviderTextPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string") {
    return record.output_text;
  }
  if (Array.isArray(record.output)) {
    const text = extractTextBlocks(record.output).join("\n\n").trim();
    if (text) {
      return text;
    }
  }
  if (record.output && typeof record.output === "object") {
    const text = extractTextBlocks(record.output).join("\n\n").trim();
    if (text) {
      return text;
    }
  }
  if (Array.isArray(record.choices)) {
    const text = extractTextBlocks(record.choices[0]).join("\n\n").trim();
    if (text) {
      return text;
    }
  }
  if (Array.isArray(record.content)) {
    const text = extractTextBlocks(record.content).join("\n\n").trim();
    if (text) {
      return text;
    }
  }
  if (Array.isArray(record.candidates)) {
    const text = extractTextBlocks(record.candidates[0]).join("\n\n").trim();
    if (text) {
      return text;
    }
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  return "";
}

function parseOpenAiChatToolCalls(payload: Record<string, unknown>): ProviderToolCall[] {
  const choice = Array.isArray(payload.choices)
    ? payload.choices[0] as Record<string, unknown> | undefined
    : undefined;
  const message = choice?.message;
  if (!message || typeof message !== "object") {
    return [];
  }
  const toolCalls = (message as Record<string, unknown>).tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const fn = record.function;
    if (!fn || typeof fn !== "object") {
      return [];
    }
    const fnRecord = fn as Record<string, unknown>;
    const toolId = typeof fnRecord.name === "string" ? fnRecord.name : "";
    if (!toolId) {
      return [];
    }
    const id = typeof record.id === "string" && record.id
      ? record.id
      : `call_${index + 1}`;
    return [{
      id,
      toolId,
      input: parseToolInput(fnRecord.arguments),
    }];
  });
}

function parseOpenAiChatText(payload: Record<string, unknown>): string {
  const choice = Array.isArray(payload.choices)
    ? payload.choices[0] as Record<string, unknown> | undefined
    : undefined;
  const message = choice?.message;
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .flatMap((item) => {
        if (!item || typeof item !== "object") {
          return [];
        }
        const text = (item as Record<string, unknown>).text;
        return typeof text === "string" ? [text] : [];
      })
      .join("\n\n")
      .trim();
  }
  return "";
}

function parseResponsesToolCalls(payload: Record<string, unknown>): ProviderToolCall[] {
  const output = payload.output;
  if (!Array.isArray(output)) {
    return [];
  }

  return output.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "function_call") {
      return [];
    }
    const toolId = typeof record.name === "string" ? record.name : "";
    if (!toolId) {
      return [];
    }
    const callId =
      (typeof record.call_id === "string" && record.call_id) ||
      (typeof record.id === "string" && record.id) ||
      `call_${index + 1}`;
    return [
      {
        id: callId,
        toolId,
        input: parseToolInput(record.arguments),
      },
    ];
  });
}

function parseAnthropicToolCalls(payload: Record<string, unknown>): ProviderToolCall[] {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (record.type !== "tool_use") {
      return [];
    }
    const toolId = typeof record.name === "string" ? record.name : "";
    if (!toolId) {
      return [];
    }
    const id = typeof record.id === "string" && record.id
      ? record.id
      : `tool_use_${index + 1}`;
    return [{
      id,
      toolId,
      input: parseToolInput(record.input),
    }];
  });
}

function parseAnthropicText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const record = item as Record<string, unknown>;
      if (record.type !== "text" || typeof record.text !== "string") {
        return [];
      }
      return [record.text];
    })
    .join("\n\n")
    .trim();
}

function parseGeminiToolCalls(payload: Record<string, unknown>): ProviderToolCall[] {
  const candidates = payload.candidates;
  if (!Array.isArray(candidates)) {
    return [];
  }
  const firstCandidate = candidates[0];
  if (!firstCandidate || typeof firstCandidate !== "object") {
    return [];
  }
  const content = (firstCandidate as Record<string, unknown>).content;
  if (!content || typeof content !== "object") {
    return [];
  }
  const parts = (content as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) {
    return [];
  }

  return parts.flatMap((part, index) => {
    if (!part || typeof part !== "object") {
      return [];
    }
    const functionCall = (part as Record<string, unknown>).functionCall;
    if (!functionCall || typeof functionCall !== "object") {
      return [];
    }
    const callRecord = functionCall as Record<string, unknown>;
    const toolId = typeof callRecord.name === "string" ? callRecord.name : "";
    if (!toolId) {
      return [];
    }
    const callId = (
      (typeof callRecord.id === "string" && callRecord.id) ||
      (typeof callRecord.callId === "string" && callRecord.callId) ||
      `call_${index + 1}`
    );
    return [
      {
        id: callId,
        toolId,
        input: parseToolInput(callRecord.args),
      },
    ];
  });
}

function parseGeminiToolResult(content: string): Record<string, LooseJsonValue> {
  const text = content.trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, LooseJsonValue>;
    }
    return {
      result: parsed as LooseJsonValue,
    };
  } catch {
    return {
      text,
    };
  }
}

function messageToGeminiShape(
  message: ProviderMessage,
  toolNameByCallId: Map<string, string>,
): { role: "user" | "model"; parts: Array<Record<string, unknown>> } | null {
  if (message.role === "system") {
    return null;
  }
  if (message.role === "user") {
    return {
      role: "user",
      parts: [{ text: message.content }],
    };
  }
  if (message.role === "tool") {
    const toolName = message.toolCallId
      ? toolNameByCallId.get(message.toolCallId)
      : undefined;
    if (!toolName) {
      return message.content.trim()
        ? {
            role: "user",
            parts: [{ text: message.content }],
          }
        : null;
    }
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: toolName,
            response: parseGeminiToolResult(message.content),
          },
        },
      ],
    };
  }

  const parts: Array<Record<string, unknown>> = [];
  if (message.content.trim()) {
    parts.push({ text: message.content });
  }
  if (message.toolCalls?.length) {
    for (const toolCall of message.toolCalls) {
      toolNameByCallId.set(toolCall.id, toolCall.toolId);
      parts.push({
        functionCall: {
          name: toolCall.toolId,
          args: toolCall.input ?? {},
        },
      });
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return {
    role: "model",
    parts,
  };
}

function buildSamplingOptions(profile: ProviderProfile) {
  return {
    temperature: profile.temperature,
    ...(profile.topP !== null ? { top_p: profile.topP } : {}),
  };
}

function wantsJsonMode(
  profile: ProviderProfile,
  input: ProviderInvocationInput,
): boolean {
  return profile.jsonModeEnabled && Boolean(input.jsonMode);
}

function buildReasoningEffort(profile: ProviderProfile) {
  if (!profile.reasoningEnabled || profile.reasoningLevel === "off") {
    return undefined;
  }
  return { effort: profile.reasoningLevel };
}

function buildChatReasoningEffort(profile: ProviderProfile) {
  if (!profile.reasoningEnabled || profile.reasoningLevel === "off") {
    return undefined;
  }
  return profile.reasoningLevel;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function dataUrlForBytes(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${toBase64(bytes)}`;
}

function normalizedMimeType(mimeType?: string | null): string {
  return (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function fileExtension(fileName?: string | null): string {
  if (!fileName) {
    return "";
  }
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot === -1) {
    return "";
  }
  return fileName.slice(lastDot + 1).toLowerCase();
}

function isPdfInput(mimeType?: string | null, fileName?: string | null): boolean {
  return normalizedMimeType(mimeType) === "application/pdf" || fileExtension(fileName) === "pdf";
}

function isWordInput(mimeType?: string | null, fileName?: string | null): boolean {
  const mime = normalizedMimeType(mimeType);
  return mime === "application/msword" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    fileExtension(fileName) === "doc" ||
    fileExtension(fileName) === "docx";
}

function isTextDocumentInput(mimeType?: string | null, fileName?: string | null): boolean {
  const mime = normalizedMimeType(mimeType);
  return mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "text/markdown" ||
    fileExtension(fileName) === "txt" ||
    fileExtension(fileName) === "md" ||
    fileExtension(fileName) === "markdown";
}

function inferAudioFormat(mimeType: string, fileName?: string): string {
  const mime = normalizedMimeType(mimeType);
  const extension = fileExtension(fileName);

  switch (mime) {
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/flac":
      return "flac";
    case "audio/ogg":
    case "audio/ogg; codecs=opus":
    case "audio/opus":
      return "ogg";
    case "audio/aac":
      return "aac";
    case "audio/aiff":
    case "audio/x-aiff":
      return "aiff";
    default:
      break;
  }

  switch (extension) {
    case "wav":
    case "mp3":
    case "m4a":
    case "flac":
    case "ogg":
    case "aac":
    case "aiff":
      return extension;
    case "oga":
    case "opus":
      return "ogg";
    default:
      return "wav";
  }
}

function appendLooseRecordToFormData(
  form: FormData,
  values: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      form.set(key, String(value));
      continue;
    }
    form.set(key, JSON.stringify(value));
  }
}

function toBlob(bytes: Uint8Array, mimeType: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type: mimeType });
}

function rootOrigin(url: string): string {
  return new URL(url).origin;
}

function dashscopeOrigin(profile: ProviderProfile): string {
  return rootOrigin(profile.apiBaseUrl || defaultBaseUrl("bailian"));
}

function dashscopeCompatibleBaseUrl(profile: ProviderProfile): string {
  const configured = (profile.apiBaseUrl || defaultBaseUrl("bailian")).replace(/\/+$/, "");
  if (configured.endsWith("/compatible-mode/v1")) {
    return configured;
  }
  return `${dashscopeOrigin(profile)}/compatible-mode/v1`;
}

function resolveTaskModel(
  profile: ProviderProfile,
  task: "chat" | ProviderMediaCapability,
): string {
  if (task === "chat") {
    return profile.defaultModel;
  }

  switch (task) {
    case "vision":
      return profile.visionModel ?? profile.defaultModel;
    case "audio":
      return profile.audioModel ??
        (profile.kind === "openai" ||
            profile.kind === "openai_compatible_chat" ||
            profile.kind === "openai_compatible_responses"
          ? "gpt-4o-mini-transcribe"
          : profile.kind === "bailian"
          ? "qwen3-asr-flash"
          : profile.defaultModel);
    case "document":
      return profile.documentModel ??
        (profile.kind === "bailian" ? "qwen-doc-turbo" : profile.defaultModel);
    default:
      return assertNever(task);
  }
}

function readResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const lines = rawEvent
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean);
      if (lines.length === 0) {
        continue;
      }

      let event: string | null = null;
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (dataLines.length > 0) {
        yield {
          event,
          data: dataLines.join("\n"),
        };
      }
    }
  }

  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    yield {
      event: null,
      data: tail.slice(5).trimStart(),
    };
  }
}

function extractOpenAiChatDelta(payload: Record<string, unknown>): string {
  const choice = Array.isArray(payload.choices)
    ? payload.choices[0] as Record<string, unknown> | undefined
    : undefined;
  const delta = choice?.delta;
  if (typeof delta === "string") {
    return delta;
  }
  if (delta && typeof delta === "object") {
    const content = (delta as Record<string, unknown>).content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((item) =>
          item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string"
            ? String((item as Record<string, unknown>).text)
            : "",
        )
        .join("");
    }
  }
  return "";
}

function extractOpenAiResponsesDelta(payload: Record<string, unknown>): string {
  if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
    return payload.delta;
  }
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }
  return "";
}

function extractAnthropicDelta(payload: Record<string, unknown>): string {
  if (payload.type === "content_block_delta") {
    const delta = payload.delta;
    if (delta && typeof delta === "object" && typeof (delta as Record<string, unknown>).text === "string") {
      return String((delta as Record<string, unknown>).text);
    }
  }
  return "";
}

function streamDeltaForProvider(
  kind: ProviderKind,
  payload: Record<string, unknown>,
): string {
  switch (kind) {
    case "openai":
    case "openai_compatible_responses":
      return extractOpenAiResponsesDelta(payload);
    case "openrouter":
      return extractOpenAiChatDelta(payload) || extractOpenAiResponsesDelta(payload);
    case "openai_compatible_chat":
      return extractOpenAiChatDelta(payload);
    case "anthropic":
      return extractAnthropicDelta(payload);
    case "bailian":
      return extractOpenAiChatDelta(payload);
    case "gemini":
      return "";
    default:
      return assertNever(kind);
  }
}

function withStreamingEnabled(args: {
  profile: ProviderProfile;
  preview: ProviderRequestPreview;
}): ProviderRequestPreview {
  const body = cloneJsonBody(args.preview.body);

  switch (args.profile.kind) {
    case "openai":
    case "openai_compatible_responses":
      return {
        ...args.preview,
        body: {
          ...body,
          stream: true,
        },
      };
    case "openrouter":
    case "openai_compatible_chat":
    case "bailian":
      return {
        ...args.preview,
        body: {
          ...body,
          stream: true,
        },
      };
    case "anthropic":
      return {
        ...args.preview,
        body: {
          ...body,
          stream: true,
        },
      };
    case "gemini":
      return args.preview;
    default:
      return assertNever(args.profile.kind);
  }
}

function buildMediaResponse(payload: unknown): ProviderInvocationResult {
  return {
    text: parseProviderTextPayload(payload) || parseTextFromUnknown(payload),
    raw: payload,
  };
}

function providerSupportsDocumentInput(args: {
  profile: ProviderProfile;
  mimeType?: string | null | undefined;
  fileName?: string | null | undefined;
}): boolean {
  switch (args.profile.kind) {
    case "anthropic":
    case "gemini":
      return isPdfInput(args.mimeType, args.fileName);
    case "openrouter":
      return true;
    case "bailian":
      return isPdfInput(args.mimeType, args.fileName) ||
        isWordInput(args.mimeType, args.fileName) ||
        isTextDocumentInput(args.mimeType, args.fileName);
    case "openai":
    case "openai_compatible_chat":
    case "openai_compatible_responses":
      return false;
    default:
      return assertNever(args.profile.kind);
  }
}

export function supportsProviderCapability(
  profile: ProviderProfile,
  capability: ProviderMediaCapability,
  options?: {
    mimeType?: string | null | undefined;
    fileName?: string | null | undefined;
  },
): boolean {
  switch (capability) {
    case "vision":
      return profile.kind !== "anthropic"
        ? [
            "openai",
            "gemini",
            "openrouter",
            "bailian",
            "openai_compatible_chat",
            "openai_compatible_responses",
          ].includes(profile.kind)
        : true;
    case "audio":
      return [
        "openai",
        "gemini",
        "openrouter",
        "bailian",
        "openai_compatible_chat",
        "openai_compatible_responses",
      ].includes(profile.kind);
    case "document":
      return providerSupportsDocumentInput({
        profile,
        mimeType: options?.mimeType,
        fileName: options?.fileName,
      });
    default:
      return assertNever(capability);
  }
}

function buildOpenAiMediaRequest(
  profile: ProviderProfile,
  apiKey: string,
  input: ProviderMediaInvocationInput,
): ProviderMediaRequestPreview | null {
  const baseUrl = profile.apiBaseUrl || defaultBaseUrl(profile.kind);

  switch (input.kind) {
    case "image":
      return {
        url: `${baseUrl}/responses`,
        headers: mergeJsonHeaders(profile, {
          Authorization: `Bearer ${apiKey}`,
        }),
        body: {
          model: resolveTaskModel(profile, "vision"),
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: input.prompt },
                {
                  type: "input_image",
                  image_url: dataUrlForBytes(input.rawBody, input.mimeType),
                },
              ],
            },
          ],
          max_output_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
          ...profile.extraBody,
        },
      };
    case "audio": {
      const form = new FormData();
      form.set("file", toBlob(input.rawBody, input.mimeType), input.fileName ?? "audio");
      form.set("model", resolveTaskModel(profile, "audio"));
      form.set("response_format", "json");
      if (input.prompt) {
        form.set("prompt", input.prompt);
      }
      appendLooseRecordToFormData(form, profile.extraBody);
      return {
        url: `${baseUrl}/audio/transcriptions`,
        headers: mergeFormHeaders(profile, {
          Authorization: `Bearer ${apiKey}`,
        }),
        body: form,
      };
    }
    case "document":
      return null;
    default:
      return assertNever(input.kind);
  }
}

function buildOpenAiCompatibleChatMediaRequest(
  profile: ProviderProfile,
  apiKey: string,
  input: ProviderMediaInvocationInput,
): ProviderMediaRequestPreview | null {
  const baseUrl = profile.apiBaseUrl || defaultBaseUrl(profile.kind);

  switch (input.kind) {
    case "image":
      return {
        url: `${baseUrl}/chat/completions`,
        headers: mergeJsonHeaders(profile, {
          Authorization: `Bearer ${apiKey}`,
        }),
        body: {
          model: resolveTaskModel(profile, "vision"),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: input.prompt,
                },
                {
                  type: "image_url",
                  image_url: {
                    url: dataUrlForBytes(input.rawBody, input.mimeType),
                  },
                },
              ],
            },
          ],
          max_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
          stream: false,
          ...profile.extraBody,
        },
      };
    case "audio": {
      const form = new FormData();
      form.set("file", toBlob(input.rawBody, input.mimeType), input.fileName ?? "audio");
      form.set("model", resolveTaskModel(profile, "audio"));
      form.set("response_format", "json");
      if (input.prompt) {
        form.set("prompt", input.prompt);
      }
      appendLooseRecordToFormData(form, profile.extraBody);
      return {
        url: `${baseUrl}/audio/transcriptions`,
        headers: mergeFormHeaders(profile, {
          Authorization: `Bearer ${apiKey}`,
        }),
        body: form,
      };
    }
    case "document":
      return null;
    default:
      return assertNever(input.kind);
  }
}

function buildAnthropicMediaRequest(
  profile: ProviderProfile,
  apiKey: string,
  input: ProviderMediaInvocationInput,
): ProviderMediaRequestPreview | null {
  const baseUrl = profile.apiBaseUrl || defaultBaseUrl(profile.kind);
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };

  switch (input.kind) {
    case "image":
      return {
        url: `${baseUrl}/messages`,
        headers: mergeJsonHeaders(profile, headers),
        body: {
          model: resolveTaskModel(profile, "vision"),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: input.prompt },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: input.mimeType,
                    data: toBase64(input.rawBody),
                  },
                },
              ],
            },
          ],
          max_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
          ...profile.extraBody,
        },
      };
    case "document":
      if (!isPdfInput(input.mimeType, input.fileName)) {
        return null;
      }
      return {
        url: `${baseUrl}/messages`,
        headers: mergeJsonHeaders(profile, {
          ...headers,
          "anthropic-beta": "pdfs-2024-09-25",
        }),
        body: {
          model: resolveTaskModel(profile, "document"),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: toBase64(input.rawBody),
                  },
                },
                { type: "text", text: input.prompt },
              ],
            },
          ],
          max_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
          ...profile.extraBody,
        },
      };
    case "audio":
      return null;
    default:
      return assertNever(input.kind);
  }
}

function buildGeminiMediaRequest(
  profile: ProviderProfile,
  apiKey: string,
  input: ProviderMediaInvocationInput,
): ProviderMediaRequestPreview {
  const model = resolveTaskModel(
    profile,
    input.kind === "image" ? "vision" : input.kind,
  );
  return {
    url: `${profile.apiBaseUrl || defaultBaseUrl(profile.kind)}/models/${model}:generateContent`,
    headers: mergeJsonHeaders(profile, {
      "x-goog-api-key": apiKey,
    }),
    body: {
      contents: [
        {
          role: "user",
          parts: [
            { text: input.prompt },
            {
              inlineData: {
                mimeType: input.mimeType,
                data: toBase64(input.rawBody),
              },
            },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: input.maxOutputTokens ?? profile.maxOutputTokens,
        temperature: profile.temperature,
        topP: profile.topP ?? undefined,
      },
      ...profile.extraBody,
    },
  };
}

function buildOpenRouterMediaRequest(
  profile: ProviderProfile,
  apiKey: string,
  input: ProviderMediaInvocationInput,
): ProviderMediaRequestPreview {
  const content = [{ type: "text", text: input.prompt }] as Array<Record<string, unknown>>;

  if (input.kind === "image") {
    content.push({
      type: "image_url",
      image_url: {
        url: dataUrlForBytes(input.rawBody, input.mimeType),
      },
    });
  } else if (input.kind === "audio") {
    content.push({
      type: "input_audio",
      input_audio: {
        data: toBase64(input.rawBody),
        format: inferAudioFormat(input.mimeType, input.fileName),
      },
    });
  } else {
    content.push({
      type: "file",
      file: {
        filename: input.fileName ?? "document",
        file_data: dataUrlForBytes(input.rawBody, input.mimeType),
      },
    });
  }

  return {
    url: `${profile.apiBaseUrl || defaultBaseUrl(profile.kind)}/chat/completions`,
    headers: mergeJsonHeaders(profile, {
      Authorization: `Bearer ${apiKey}`,
    }),
    body: {
      model: resolveTaskModel(
        profile,
        input.kind === "image" ? "vision" : input.kind,
      ),
      messages: [
        {
          role: "user",
          content,
        },
      ],
      max_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
      stream: false,
      ...profile.extraBody,
    },
  };
}

function buildBailianMediaRequest(
  profile: ProviderProfile,
  apiKey: string,
  input: ProviderMediaInvocationInput,
): ProviderMediaRequestPreview | null {
  const compatibleBaseUrl = dashscopeCompatibleBaseUrl(profile);

  switch (input.kind) {
    case "image":
      return {
        url: `${dashscopeOrigin(profile)}/api/v1/services/aigc/multimodal-generation/generation`,
        headers: mergeJsonHeaders(profile, {
          Authorization: `Bearer ${apiKey}`,
        }),
        body: {
          model: resolveTaskModel(profile, "vision"),
          input: {
            messages: [
              {
                role: "user",
                content: [
                  {
                    image: dataUrlForBytes(input.rawBody, input.mimeType),
                  },
                  {
                    text: input.prompt,
                  },
                ],
              },
            ],
          },
          parameters: {
            result_format: "message",
            // qwen3.5-plus multimodal generation requires incremental_output=true.
            incremental_output: true,
          },
          ...profile.extraBody,
        },
      };
    case "audio":
      return {
        url: `${compatibleBaseUrl}/chat/completions`,
        headers: mergeJsonHeaders(profile, {
          Authorization: `Bearer ${apiKey}`,
        }),
        body: {
          model: resolveTaskModel(profile, "audio"),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: input.prompt,
                },
                {
                  type: "input_audio",
                  input_audio: {
                    data: dataUrlForBytes(input.rawBody, input.mimeType),
                    format: inferAudioFormat(input.mimeType, input.fileName),
                  },
                },
              ],
            },
          ],
          stream: false,
          ...profile.extraBody,
        },
      };
    case "document":
      if (!providerSupportsDocumentInput({
        profile,
        mimeType: input.mimeType,
        fileName: input.fileName,
      })) {
        return null;
      }
      return {
        url: `${compatibleBaseUrl}/chat/completions`,
        headers: mergeJsonHeaders(profile, {
          Authorization: `Bearer ${apiKey}`,
        }),
        body: {
          model: resolveTaskModel(profile, "document"),
          messages: [
            {
              role: "system",
              content: "fileid://<uploaded-file-id>",
            },
            {
              role: "user",
              content: input.prompt,
            },
          ],
          max_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
          stream: false,
          ...profile.extraBody,
        },
      };
    default:
      return assertNever(input.kind);
  }
}

function messageToAnthropicShape(
  message: ProviderMessage,
): { role: "user" | "assistant"; content: string | Array<Record<string, unknown>> } | null {
  if (message.role === "system") {
    return null;
  }
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content,
    };
  }
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content: message.content,
        },
      ],
    };
  }

  const blocks: Array<Record<string, unknown>> = [];
  if (message.content.trim()) {
    blocks.push({
      type: "text",
      text: message.content,
    });
  }
  if (message.toolCalls?.length) {
    blocks.push(
      ...message.toolCalls.map((toolCall) => ({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.toolId,
        input: toolCall.input,
      })),
    );
  }

  if (blocks.length === 0) {
    return {
      role: "assistant",
      content: "",
    };
  }

  return {
    role: "assistant",
    content: blocks.length === 1 && blocks[0]?.type === "text"
      ? String(blocks[0].text ?? "")
      : blocks,
  };
}

export const adapters: Record<ProviderKind, AgentProviderAdapter> = {
  openai: {
    kind: "openai",
    buildRequest(profile, apiKey, input) {
      if (input.tools?.length && profile.toolCallingEnabled) {
        return {
          url: `${profile.apiBaseUrl || defaultBaseUrl(profile.kind)}/chat/completions`,
          headers: mergeJsonHeaders(profile, {
            Authorization: `Bearer ${apiKey}`,
          }),
          body: {
            model: input.model ?? profile.defaultModel,
            messages: input.messages.map(messageToOpenAiShape),
            tools: openAiToolDefinitions(input),
            tool_choice: normalizeOpenAiToolChoice(input.toolChoice),
            reasoning_effort: buildChatReasoningEffort(profile),
            max_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
            stream: false,
            ...buildSamplingOptions(profile),
            ...profile.extraBody,
          },
        };
      }
      return {
        url: `${profile.apiBaseUrl || defaultBaseUrl(profile.kind)}/responses`,
        headers: mergeJsonHeaders(profile, {
          Authorization: `Bearer ${apiKey}`,
        }),
        body: {
          model: input.model ?? profile.defaultModel,
          input: input.messages.map((message) => ({
            role: message.role,
            content: [{ type: "input_text", text: message.content }],
          })),
          max_output_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
          reasoning: buildReasoningEffort(profile),
          text: wantsJsonMode(profile, input)
            ? { format: { type: "json_object" } }
            : undefined,
          ...buildSamplingOptions(profile),
          ...profile.extraBody,
        },
      };
    },
    parseResponse(payload) {
      if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        if (Array.isArray(record.choices)) {
          return {
            text: parseOpenAiChatText(record) || parseProviderTextPayload(record),
            raw: payload,
            toolCalls: parseOpenAiChatToolCalls(record),
          };
        }
        if (Array.isArray(record.output)) {
          return {
            text: parseProviderTextPayload(record),
            raw: payload,
            toolCalls: parseResponsesToolCalls(record),
          };
        }
      }
      return buildMediaResponse(payload);
    },
  },
  anthropic: {
    kind: "anthropic",
    buildRequest(profile, apiKey, input) {
      return {
        url: `${profile.apiBaseUrl || defaultBaseUrl(profile.kind)}/messages`,
        headers: mergeJsonHeaders(profile, {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        }),
        body: {
          model: input.model ?? profile.defaultModel,
          system: input.messages
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n\n"),
          messages: input.messages
            .map(messageToAnthropicShape)
            .filter((
              message,
            ): message is { role: "user" | "assistant"; content: string | Array<Record<string, unknown>> } =>
              Boolean(message)
            ),
          tools:
            input.tools?.length && profile.toolCallingEnabled
              ? anthropicToolDefinitions(input)
              : undefined,
          tool_choice:
            input.tools?.length && profile.toolCallingEnabled
              ? normalizeAnthropicToolChoice(input.toolChoice)
              : undefined,
          max_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
          thinking:
            profile.reasoningEnabled && profile.reasoningLevel !== "off"
              ? {
                  type: "enabled",
                  budget_tokens: profile.thinkingBudget ??
                    (profile.reasoningLevel === "high"
                      ? 2048
                      : profile.reasoningLevel === "medium"
                      ? 1024
                      : 512),
                }
              : undefined,
          ...buildSamplingOptions(profile),
          ...profile.extraBody,
        },
      };
    },
    parseResponse(payload) {
      if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        return {
          text: parseAnthropicText(record) || parseProviderTextPayload(record),
          raw: payload,
          toolCalls: parseAnthropicToolCalls(record),
        };
      }
      return buildMediaResponse(payload);
    },
  },
  gemini: {
    kind: "gemini",
    buildRequest(profile, apiKey, input) {
      const model = input.model ?? profile.defaultModel;
      const toolNameByCallId = new Map<string, string>();
      return {
        url: `${profile.apiBaseUrl || defaultBaseUrl(profile.kind)}/models/${model}:generateContent`,
        headers: mergeJsonHeaders(profile, {
          "x-goog-api-key": apiKey,
        }),
        body: {
          contents: input.messages
            .map((message) => messageToGeminiShape(message, toolNameByCallId))
            .filter((
              message,
            ): message is { role: "user" | "model"; parts: Array<Record<string, unknown>> } =>
              Boolean(message)
            ),
          systemInstruction: {
            parts: input.messages
              .filter((message) => message.role === "system")
              .map((message) => ({ text: message.content })),
          },
          tools:
            input.tools?.length && profile.toolCallingEnabled
              ? [
                  {
                    functionDeclarations: geminiToolDeclarations(input),
                  },
                ]
              : undefined,
          toolConfig:
            input.tools?.length && profile.toolCallingEnabled
              ? normalizeGeminiToolConfig(input.toolChoice)
              : undefined,
          generationConfig: {
            maxOutputTokens: input.maxOutputTokens ?? profile.maxOutputTokens,
            responseMimeType: wantsJsonMode(profile, input)
              ? "application/json"
              : undefined,
            temperature: profile.temperature,
            topP: profile.topP ?? undefined,
          },
          thinkingConfig:
            profile.reasoningEnabled && profile.reasoningLevel !== "off"
              ? {
                  thinkingBudget: profile.thinkingBudget ??
                    (profile.reasoningLevel === "high"
                      ? 2048
                      : profile.reasoningLevel === "medium"
                      ? 1024
                      : 512),
                }
              : undefined,
          ...profile.extraBody,
        },
      };
    },
    parseResponse(payload) {
      if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        return {
          text: parseProviderTextPayload(record) || parseTextFromUnknown(payload),
          raw: payload,
          toolCalls: parseGeminiToolCalls(record),
        };
      }
      return buildMediaResponse(payload);
    },
  },
  openrouter: {
    kind: "openrouter",
    buildRequest(profile, apiKey, input) {
      if (input.tools?.length && profile.toolCallingEnabled) {
        return {
          url: `${profile.apiBaseUrl || defaultBaseUrl(profile.kind)}/responses`,
          headers: mergeJsonHeaders(profile, {
            Authorization: `Bearer ${apiKey}`,
          }),
          body: {
            model: input.model ?? profile.defaultModel,
            instructions: responsesSystemInstructions(input.messages) || undefined,
            input: responsesInputMessages(input.messages),
            tools: responsesToolDefinitions(input),
            tool_choice: normalizeOpenRouterResponsesToolChoice(input.toolChoice),
            max_output_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
            reasoning: buildReasoningEffort(profile),
            text: wantsJsonMode(profile, input)
              ? { format: { type: "json_object" } }
              : undefined,
            ...buildSamplingOptions(profile),
            ...profile.extraBody,
          },
        };
      }
      return {
        url: `${profile.apiBaseUrl || defaultBaseUrl(profile.kind)}/chat/completions`,
        headers: mergeJsonHeaders(profile, {
          Authorization: `Bearer ${apiKey}`,
        }),
        body: {
          model: input.model ?? profile.defaultModel,
          messages: input.messages.map(messageToOpenAiShape),
          max_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
          response_format: wantsJsonMode(profile, input)
            ? { type: "json_object" }
            : undefined,
          reasoning: buildReasoningEffort(profile),
          stream: false,
          ...buildSamplingOptions(profile),
          ...profile.extraBody,
        },
      };
    },
    parseResponse(payload) {
      if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        if (Array.isArray(record.output)) {
          return {
            text: parseProviderTextPayload(record),
            raw: payload,
            toolCalls: parseResponsesToolCalls(record),
          };
        }
      }
      return buildMediaResponse(payload);
    },
  },
  bailian: {
    kind: "bailian",
    buildRequest(profile, apiKey, input) {
      const compatibleBaseUrl = dashscopeCompatibleBaseUrl(profile);
      const jsonMode = wantsJsonMode(profile, input);
      const enableThinking =
        profile.reasoningEnabled &&
        profile.reasoningLevel !== "off" &&
        !jsonMode;
      return {
        url: `${compatibleBaseUrl}/chat/completions`,
        headers: mergeJsonHeaders(profile, {
          Authorization: `Bearer ${apiKey}`,
        }),
        body: {
          model: input.model ?? profile.defaultModel,
          messages: input.messages.map(messageToOpenAiShape),
          tools:
            input.tools?.length && profile.toolCallingEnabled
              ? openAiToolDefinitions(input)
              : undefined,
          tool_choice:
            input.tools?.length && profile.toolCallingEnabled
              ? normalizeOpenAiToolChoice(input.toolChoice)
              : undefined,
          enable_thinking: enableThinking,
          thinking_budget: enableThinking ? profile.thinkingBudget ?? undefined : undefined,
          max_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
          response_format: jsonMode
            ? { type: "json_object" }
            : undefined,
          stream: false,
          ...buildSamplingOptions(profile),
          ...profile.extraBody,
        },
      };
    },
    parseResponse(payload) {
      if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        if (Array.isArray(record.choices)) {
          return {
            text: parseOpenAiChatText(record) || parseProviderTextPayload(record),
            raw: payload,
            toolCalls: parseOpenAiChatToolCalls(record),
          };
        }
        if (Array.isArray(record.output)) {
          return {
            text: parseProviderTextPayload(record),
            raw: payload,
            toolCalls: parseResponsesToolCalls(record),
          };
        }
      }
      return buildMediaResponse(payload);
    },
  },
  openai_compatible_chat: {
    kind: "openai_compatible_chat",
    buildRequest(profile, apiKey, input) {
      return {
        url: `${profile.apiBaseUrl || defaultBaseUrl(profile.kind)}/chat/completions`,
        headers: mergeJsonHeaders(profile, {
          Authorization: `Bearer ${apiKey}`,
        }),
        body: {
          model: input.model ?? profile.defaultModel,
          messages: input.messages.map(messageToOpenAiShape),
          max_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
          response_format: wantsJsonMode(profile, input)
            ? { type: "json_object" }
            : undefined,
          stream: false,
          ...buildSamplingOptions(profile),
          ...profile.extraBody,
        },
      };
    },
    parseResponse(payload) {
      return buildMediaResponse(payload);
    },
  },
  openai_compatible_responses: {
    kind: "openai_compatible_responses",
    buildRequest(profile, apiKey, input) {
      return {
        url: `${profile.apiBaseUrl || defaultBaseUrl(profile.kind)}/responses`,
        headers: mergeJsonHeaders(profile, {
          Authorization: `Bearer ${apiKey}`,
        }),
        body: {
          model: input.model ?? profile.defaultModel,
          input: input.messages.map((message) => ({
            role: message.role,
            content: [{ type: "input_text", text: message.content }],
          })),
          max_output_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
          text: wantsJsonMode(profile, input)
            ? { format: { type: "json_object" } }
            : undefined,
          ...buildSamplingOptions(profile),
          ...profile.extraBody,
        },
      };
    },
    parseResponse(payload) {
      return buildMediaResponse(payload);
    },
  },
};

export function getProviderAdapter(kind: string): AgentProviderAdapter {
  const parsedKind = ProviderKindSchema.parse(kind);
  return adapters[parsedKind];
}

export function createProviderRequestPreview(args: {
  profile: ProviderProfile;
  apiKey: string;
  input: ProviderInvocationInput;
}): ProviderRequestPreview {
  return getProviderAdapter(args.profile.kind).buildRequest(
    args.profile,
    args.apiKey,
    args.input,
  );
}

export function supportsProviderTextStreaming(profile: ProviderProfile): boolean {
  switch (profile.kind) {
    case "openai":
    case "anthropic":
    case "openrouter":
    case "bailian":
    case "openai_compatible_chat":
    case "openai_compatible_responses":
      return true;
    case "gemini":
      return false;
    default:
      return assertNever(profile.kind);
  }
}

export async function invokeProvider(args: {
  profile: ProviderProfile;
  apiKey: string;
  input: ProviderInvocationInput;
}): Promise<ProviderInvocationResult> {
  const adapter = getProviderAdapter(args.profile.kind);
  const preview = adapter.buildRequest(args.profile, args.apiKey, args.input);
  const response = await fetch(preview.url, {
    method: "POST",
    headers: preview.headers,
    body: JSON.stringify(preview.body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new AppError(
      "PROVIDER_REQUEST_FAILED",
      `Provider request failed: ${response.status} ${text}`,
      response.status,
    );
  }

  const payload = await readResponsePayload(response);
  return adapter.parseResponse(payload);
}

export async function* invokeProviderStream(args: {
  profile: ProviderProfile;
  apiKey: string;
  input: ProviderInvocationInput;
}): AsyncGenerator<ProviderStreamChunk> {
  if (!supportsProviderTextStreaming(args.profile)) {
    throw new AppError(
      "PROVIDER_STREAM_UNSUPPORTED",
      `Provider ${args.profile.kind} does not support streaming`,
      400,
    );
  }

  const preview = withStreamingEnabled({
    profile: args.profile,
    preview: createProviderRequestPreview(args),
  });
  const response = await fetch(preview.url, {
    method: "POST",
    headers: preview.headers,
    body: JSON.stringify(preview.body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new AppError(
      "PROVIDER_REQUEST_FAILED",
      `Provider request failed: ${response.status} ${text}`,
      response.status,
    );
  }

  if (!response.body) {
    throw new AppError(
      "PROVIDER_STREAM_UNAVAILABLE",
      "Provider streaming response body is unavailable",
      500,
    );
  }

  let accumulated = "";
  for await (const event of readSseEvents(response.body)) {
    if (event.data === "[DONE]") {
      break;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const delta = streamDeltaForProvider(args.profile.kind, payload);
    if (!delta) {
      continue;
    }
    accumulated += delta;
    yield {
      delta,
      accumulated,
    };
  }
}

export function createProviderMediaRequestPreview(args: {
  profile: ProviderProfile;
  apiKey: string;
  input: ProviderMediaInvocationInput;
}): ProviderMediaRequestPreview | null {
  switch (args.profile.kind) {
    case "openai":
      return buildOpenAiMediaRequest(args.profile, args.apiKey, args.input);
    case "openai_compatible_chat":
      return buildOpenAiCompatibleChatMediaRequest(
        args.profile,
        args.apiKey,
        args.input,
      );
    case "openai_compatible_responses":
      return buildOpenAiMediaRequest(args.profile, args.apiKey, args.input);
    case "anthropic":
      return buildAnthropicMediaRequest(args.profile, args.apiKey, args.input);
    case "gemini":
      return buildGeminiMediaRequest(args.profile, args.apiKey, args.input);
    case "openrouter":
      return buildOpenRouterMediaRequest(args.profile, args.apiKey, args.input);
    case "bailian":
      return buildBailianMediaRequest(args.profile, args.apiKey, args.input);
    default:
      return assertNever(args.profile.kind);
  }
}

function parseBailianUploadedFileId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.id === "string" && record.id) {
    return record.id;
  }
  if (record.data && typeof record.data === "object") {
    const dataRecord = record.data as Record<string, unknown>;
    if (typeof dataRecord.id === "string" && dataRecord.id) {
      return dataRecord.id;
    }
  }
  return null;
}

async function invokeBailianDocumentMedia(args: {
  profile: ProviderProfile;
  apiKey: string;
  input: ProviderMediaInvocationInput;
}): Promise<ProviderInvocationResult> {
  const { profile, apiKey, input } = args;
  const compatibleBaseUrl = dashscopeCompatibleBaseUrl(profile);
  const form = new FormData();
  form.set("purpose", "file-extract");
  form.set("file", toBlob(input.rawBody, input.mimeType), input.fileName ?? "document");

  const uploadResponse = await fetch(`${compatibleBaseUrl}/files`, {
    method: "POST",
    headers: mergeFormHeaders(profile, {
      Authorization: `Bearer ${apiKey}`,
    }),
    body: form,
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new AppError(
      "PROVIDER_REQUEST_FAILED",
      `Provider media request failed: ${uploadResponse.status} ${text}`,
      uploadResponse.status,
    );
  }

  const uploadPayload = await readResponsePayload(uploadResponse);
  const fileId = parseBailianUploadedFileId(uploadPayload);
  if (!fileId) {
    throw new AppError(
      "PROVIDER_REQUEST_FAILED",
      `Provider media request failed: uploaded file id missing (${parseTextFromUnknown(uploadPayload)})`,
      502,
    );
  }

  try {
    const response = await fetch(`${compatibleBaseUrl}/chat/completions`, {
      method: "POST",
      headers: mergeJsonHeaders(profile, {
        Authorization: `Bearer ${apiKey}`,
      }),
      body: JSON.stringify({
        model: resolveTaskModel(profile, "document"),
        messages: [
          {
            role: "system",
            content: `fileid://${fileId}`,
          },
          {
            role: "user",
            content: input.prompt,
          },
        ],
        max_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
        stream: false,
        ...profile.extraBody,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new AppError(
        "PROVIDER_REQUEST_FAILED",
        `Provider media request failed: ${response.status} ${text}`,
        response.status,
      );
    }

    const payload = await readResponsePayload(response);
    return buildMediaResponse(payload);
  } finally {
    void fetch(`${compatibleBaseUrl}/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: compactHeaders({
        Authorization: `Bearer ${apiKey}`,
        ...profile.headers,
      }),
    }).catch(() => undefined);
  }
}

export async function invokeProviderMedia(args: {
  profile: ProviderProfile;
  apiKey: string;
  input: ProviderMediaInvocationInput;
}): Promise<ProviderInvocationResult | null> {
  if (args.profile.kind === "bailian" && args.input.kind === "document") {
    if (!providerSupportsDocumentInput({
      profile: args.profile,
      mimeType: args.input.mimeType,
      fileName: args.input.fileName,
    })) {
      return null;
    }
    return invokeBailianDocumentMedia(args);
  }

  const preview = createProviderMediaRequestPreview(args);
  if (!preview) {
    return null;
  }

  const response = await fetch(preview.url, {
    method: "POST",
    headers: preview.headers,
    body: preview.body instanceof FormData ? preview.body : JSON.stringify(preview.body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new AppError(
      "PROVIDER_REQUEST_FAILED",
      `Provider media request failed: ${response.status} ${text}`,
      response.status,
    );
  }

  const payload = await readResponsePayload(response);
  return buildMediaResponse(payload);
}
