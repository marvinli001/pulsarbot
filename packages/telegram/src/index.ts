import { Bot, webhookCallback, type Context } from "grammy";
import { nowIso } from "@pulsarbot/core";
import type { TelegramInboundContent } from "@pulsarbot/shared";

export interface TelegramUpdatePayload {
  updateId: number | null;
  chatId: number;
  threadId: number | null;
  userId: number;
  username?: string | undefined;
  messageId: number | null;
  content: TelegramInboundContent;
}

export interface TelegramResponseStreamController {
  enabled: boolean;
  emit(partialText: string): Promise<void>;
  finalize(finalText: string): Promise<void>;
}

export interface TelegramUpdateHandler {
  (
    payload: TelegramUpdatePayload,
    stream: TelegramResponseStreamController,
  ): Promise<string>;
}

export interface TelegramCommandContext {
  chatId: number;
  threadId: number | null;
  userId: number;
  username?: string | undefined;
  rawText: string;
  args: string[];
  messageId: number | null;
}

export interface TelegramCommandHandlers {
  onTasks?(context: TelegramCommandContext): Promise<string | null> | string | null;
  onApprove?(context: TelegramCommandContext): Promise<string | null> | string | null;
  onPause?(context: TelegramCommandContext): Promise<string | null> | string | null;
  onDigest?(context: TelegramCommandContext): Promise<string | null> | string | null;
}

export interface TelegramCallbackQueryContext {
  chatId: number;
  threadId: number | null;
  userId: number;
  username?: string | undefined;
  data: string;
  messageId: number | null;
}

export interface TelegramCallbackQueryResult {
  replyText?: string | null;
  answerText?: string | null;
  showAlert?: boolean;
}

export type TelegramCallbackQueryHandler = (
  context: TelegramCallbackQueryContext,
) => Promise<TelegramCallbackQueryResult | null> | TelegramCallbackQueryResult | null;

function createDisabledTelegramStreamController(): TelegramResponseStreamController {
  return {
    enabled: false,
    async emit() {},
    async finalize() {},
  };
}

function parseCommandArgs(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .slice(1)
    .filter(Boolean);
}

async function resolveFileMetadata(
  ctx: Context,
  botToken: string,
  fileId: string,
): Promise<Record<string, unknown>> {
  try {
    const file = await ctx.api.getFile(fileId);
    return {
      fileId,
      filePath: file.file_path ?? null,
      fileUrl: file.file_path
        ? `https://api.telegram.org/file/bot${botToken}/${file.file_path}`
        : null,
      fileSize: file.file_size ?? null,
    };
  } catch {
    return {
      fileId,
      filePath: null,
      fileUrl: null,
      fileSize: null,
    };
  }
}

function ensurePrivate(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

type ThreadReplyOptions = {
  message_thread_id?: number;
  direct_messages_topic_id?: number;
};

type FinalizedReplyContext = {
  chatId: number;
  threadId: number | null;
  requestText: string;
  replyText: string;
};

type TelegramWebhookOptions = {
  onTimeout?: "throw" | "return" | ((...args: unknown[]) => unknown);
  timeoutMilliseconds?: number;
  secretToken?: string;
};

type TelegramFormattedText = {
  text: string;
  parse_mode: "HTML";
};

const TELEGRAM_TEXT_LIMIT = 4096;
const DEFAULT_WEBHOOK_OPTIONS: Required<Pick<TelegramWebhookOptions, "onTimeout" | "timeoutMilliseconds">> = {
  // Return 200 before Telegram's webhook deadline and let the bot finish in the background.
  onTimeout: "return",
  timeoutMilliseconds: 9_000,
};
const TELEGRAM_RICH_TEXT_PLACEHOLDER = "\u0007tg";

function escapeTelegramHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stashTelegramRichTextSegment(segments: string[], html: string) {
  const index = segments.push(html) - 1;
  return `${TELEGRAM_RICH_TEXT_PLACEHOLDER}${index}${TELEGRAM_RICH_TEXT_PLACEHOLDER}`;
}

function restoreTelegramRichTextSegments(value: string, segments: string[]) {
  const pattern = new RegExp(
    `${TELEGRAM_RICH_TEXT_PLACEHOLDER}(\\d+)${TELEGRAM_RICH_TEXT_PLACEHOLDER}`,
    "gu",
  );
  return value.replace(pattern, (_match, rawIndex: string) => {
    const index = Number(rawIndex);
    return Number.isInteger(index) ? (segments[index] ?? "") : "";
  });
}

function isSafeTelegramHref(rawHref: string) {
  try {
    const href = new URL(rawHref);
    return href.protocol === "http:" ||
      href.protocol === "https:" ||
      href.protocol === "mailto:" ||
      href.protocol === "tg:";
  } catch {
    return false;
  }
}

function isMarkdownTableSeparator(line: string) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/u.test(line);
}

function isMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return false;
  }
  const normalized = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const candidate = normalized.endsWith("|") ? normalized.slice(0, -1) : normalized;
  return candidate.split("|").length >= 2;
}

function splitMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  const normalized = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const candidate = normalized.endsWith("|") ? normalized.slice(0, -1) : normalized;
  return candidate.split("|").map((cell) => cell.trim());
}

function downgradeMarkdownTables(text: string) {
  const lines = text.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index] ?? "";
    const separator = lines[index + 1] ?? "";
    if (!isMarkdownTableRow(header) || !isMarkdownTableSeparator(separator)) {
      output.push(header);
      continue;
    }

    const headerCells = splitMarkdownTableRow(header);
    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length && isMarkdownTableRow(lines[cursor] ?? "")) {
      rows.push(splitMarkdownTableRow(lines[cursor] ?? ""));
      cursor += 1;
    }

    if (rows.length === 0) {
      output.push(header);
      continue;
    }

    const downgradedRows = rows.map((cells) => {
      if (cells.length === 2) {
        return `- ${cells[0]}: ${cells[1]}`;
      }
      return `- ${cells.map((cell, cellIndex) => {
        const headerLabel = headerCells[cellIndex] ?? `Column ${cellIndex + 1}`;
        return `${headerLabel}: ${cell}`;
      }).join(" | ")}`;
    });
    output.push(...downgradedRows);
    index = cursor - 1;
  }

  return output.join("\n");
}

function formatTelegramDisplayLine(line: string) {
  const listItem = line.match(/^(\s*)((?:\d+\.)|[-*+])\s+(.+)$/u);
  if (!listItem) {
    return line;
  }
  const [, rawIndent = "", marker = "", content = ""] = listItem;
  const indent = rawIndent.replace(/\t/g, "  ");
  const depth = Math.max(0, Math.floor(indent.length / 2));
  const prefix = "&nbsp;".repeat(depth * 4);
  return `${prefix}${marker} ${content}`;
}

function renderTelegramDisplayLines(text: string) {
  const lines = text.split("\n");
  const output: string[] = [];
  let quoteBuffer: string[] = [];

  const flushQuoteBuffer = () => {
    if (quoteBuffer.length === 0) {
      return;
    }
    output.push(`<blockquote>${quoteBuffer.join("\n")}</blockquote>`);
    quoteBuffer = [];
  };

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/u);
    const quote = line.match(/^\s*&gt;\s?(.*)$/u);
    if (quote) {
      const [, quoteContent = ""] = quote;
      quoteBuffer.push(quoteContent);
      continue;
    }

    flushQuoteBuffer();

    if (heading) {
      const [, headingContent = ""] = heading;
      output.push(`<b>${headingContent.trim()}</b>`);
      continue;
    }

    output.push(formatTelegramDisplayLine(line));
  }

  flushQuoteBuffer();
  return output.join("\n");
}

export function formatTelegramRichText(text: string): TelegramFormattedText {
  const segments: string[] = [];
  let rendered = downgradeMarkdownTables(text.replace(/\r\n/g, "\n"));

  rendered = rendered.replace(/```([^\n`]*)\n([\s\S]*?)```/gu, (_match, _language: string, code: string) =>
    stashTelegramRichTextSegment(
      segments,
      `<pre><code>${escapeTelegramHtml(code.replace(/\n+$/u, ""))}</code></pre>`,
    ));

  rendered = rendered.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (match, label: string, href: string) => {
    if (!isSafeTelegramHref(href)) {
      return match;
    }
    return stashTelegramRichTextSegment(
      segments,
      `<a href="${escapeTelegramHtml(href)}">${escapeTelegramHtml(label)}</a>`,
    );
  });

  rendered = rendered.replace(/`([^`\n]+)`/gu, (_match, code: string) =>
    stashTelegramRichTextSegment(segments, `<code>${escapeTelegramHtml(code)}</code>`));

  rendered = escapeTelegramHtml(rendered);
  rendered = renderTelegramDisplayLines(rendered);

  rendered = rendered.replace(/\*\*([^*\n][^*\n]*?)\*\*/gu, "<b>$1</b>");
  rendered = rendered.replace(/~~([^~\n][^~\n]*?)~~/gu, "<s>$1</s>");

  return {
    text: restoreTelegramRichTextSegments(rendered, segments),
    parse_mode: "HTML",
  };
}

function trimLeadingWhitespace(value: string) {
  return value.replace(/^\s+/u, "");
}

export function splitTelegramMessageText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const characters = Array.from(normalized);
  if (characters.length <= limit) {
    return normalized.trim().length > 0 ? [normalized] : [];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < characters.length) {
    let end = Math.min(cursor + limit, characters.length);
    if (end < characters.length) {
      const candidate = characters.slice(cursor, end).join("");
      const breakpoints = [
        candidate.lastIndexOf("\n\n"),
        candidate.lastIndexOf("\n"),
        candidate.lastIndexOf(" "),
      ].filter((index) => index >= Math.floor(limit * 0.6));
      if (breakpoints.length > 0) {
        end = cursor + Math.max(...breakpoints) + 1;
      }
    }

    const chunk = characters.slice(cursor, end).join("");
    if (chunk.trim().length > 0) {
      chunks.push(chunk);
    }
    cursor = end;
  }

  return chunks.length > 0 ? chunks : [normalized];
}

function previewTelegramStreamText(text: string) {
  const chunks = splitTelegramMessageText(text);
  const firstChunk = chunks[0] ?? "";
  if (chunks.length <= 1) {
    return firstChunk;
  }
  const previewCharacters = Array.from(firstChunk);
  if (previewCharacters.length >= TELEGRAM_TEXT_LIMIT) {
    return `${previewCharacters.slice(0, TELEGRAM_TEXT_LIMIT - 1).join("")}…`;
  }
  return `${trimLeadingWhitespace(firstChunk)}\n…`;
}

async function replyWithTelegramText(
  ctx: Context,
  text: string,
  replyOptions?: ThreadReplyOptions,
) {
  const messages: Array<{ message_id: number }> = [];
  for (const chunk of splitTelegramMessageText(text)) {
    const formatted = formatTelegramRichText(chunk);
    messages.push(await ctx.reply(formatted.text, {
      ...replyOptions,
      parse_mode: formatted.parse_mode,
    }));
  }
  return messages;
}

type ForumTopicNameResolver = (
  context: FinalizedReplyContext,
) => Promise<string | null> | string | null;

const IMPLICIT_FORUM_TOPIC_RENAME_MESSAGE_THRESHOLD = 1;

function parseThreadId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

function parseChatId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

function parseUpdateId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

function readThreadContext(message: unknown): {
  threadId: number | null;
  replyOptions: ThreadReplyOptions | undefined;
} {
  if (!message || typeof message !== "object") {
    return {
      threadId: null,
      replyOptions: undefined,
    };
  }

  const record = message as Record<string, unknown>;
  const directMessagesTopicId = parseThreadId(record.direct_messages_topic_id);
  if (directMessagesTopicId !== null) {
    return {
      threadId: directMessagesTopicId,
      replyOptions: {
        direct_messages_topic_id: directMessagesTopicId,
      },
    };
  }

  const messageThreadId = parseThreadId(record.message_thread_id);
  return {
    threadId: messageThreadId,
    replyOptions: messageThreadId !== null
      ? {
          message_thread_id: messageThreadId,
        }
      : undefined,
  };
}

function classifyMessageEventType(prefix: string, message: unknown): string {
  if (!message || typeof message !== "object") {
    return prefix;
  }

  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") {
    return `${prefix}:text`;
  }
  if ("voice" in record) {
    return `${prefix}:voice`;
  }
  if ("photo" in record) {
    return `${prefix}:photo`;
  }
  if ("document" in record) {
    return `${prefix}:document`;
  }
  if ("audio" in record) {
    return `${prefix}:audio`;
  }
  return prefix;
}

function readUpdateContext(update: unknown): {
  eventType: string;
  chatId: number | null;
  threadId: number | null;
} {
  if (!update || typeof update !== "object") {
    return {
      eventType: "unknown",
      chatId: null,
      threadId: null,
    };
  }

  const record = update as Record<string, unknown>;
  const extractFromMessage = (eventType: string, message: unknown) => {
    const messageRecord =
      message && typeof message === "object"
        ? (message as Record<string, unknown>)
        : null;
    const chatId = messageRecord && typeof messageRecord.chat === "object"
      ? parseChatId((messageRecord.chat as Record<string, unknown>).id)
      : null;
    const { threadId } = readThreadContext(message);
    return {
      eventType,
      chatId,
      threadId,
    };
  };

  if ("message" in record) {
    return extractFromMessage(
      classifyMessageEventType("message", record.message),
      record.message,
    );
  }

  if ("edited_message" in record) {
    return extractFromMessage(
      classifyMessageEventType("edited_message", record.edited_message),
      record.edited_message,
    );
  }

  if ("callback_query" in record && record.callback_query && typeof record.callback_query === "object") {
    const callbackQuery = record.callback_query as Record<string, unknown>;
    return extractFromMessage(
      typeof callbackQuery.data === "string" ? "callback_query:data" : "callback_query",
      callbackQuery.message,
    );
  }

  const fallbackType = Object.keys(record).find((key) => key !== "update_id") ?? "unknown";
  return {
    eventType: fallbackType,
    chatId: null,
    threadId: null,
  };
}

async function dispatchMessage(args: {
  ctx: Context;
  token: string;
  content: TelegramInboundContent;
  onMessage: TelegramUpdateHandler;
  onFinalizedReply?: ((context: FinalizedReplyContext) => Promise<void> | void) | undefined;
}) {
  const { ctx, content, onMessage, token, onFinalizedReply } = args;
  if (!ensurePrivate(ctx)) {
    await replyWithTelegramText(ctx, "This version only supports private chats.");
    return;
  }

  const updateRecord = ctx.update as unknown as Record<string, unknown>;
  const updateId = parseUpdateId(updateRecord.update_id);
  const threadContext = readThreadContext(updateRecord.message ?? ctx.msg);
  const sendTypingIndicator = async () => {
    try {
      await ctx.api.sendChatAction(
        ctx.chat!.id,
        "typing",
        threadContext.replyOptions,
      );
    } catch {
      // Ignore typing indicator errors to keep webhook processing resilient.
    }
  };
  await sendTypingIndicator();
  const requestText = buildForumTopicRequestText(content);
  const typingTimer = setInterval(() => {
    void sendTypingIndicator();
  }, 5_000);
  const controller = createTelegramStreamController({
    ctx,
    ...(threadContext.replyOptions
      ? { replyOptions: threadContext.replyOptions }
      : {}),
  });
  try {
    const reply = await onMessage(
      {
        updateId,
        chatId: ctx.chat!.id,
        threadId: threadContext.threadId,
        userId: ctx.from!.id,
        username: ctx.from?.username ?? undefined,
        messageId: ctx.msg?.message_id ?? null,
        content,
      },
      controller,
    );

    await controller.finalize(reply);
    if (onFinalizedReply) {
      try {
        await onFinalizedReply({
          chatId: ctx.chat!.id,
          threadId: threadContext.threadId,
          requestText,
          replyText: reply,
        });
      } catch {
        // Ignore topic-renaming failures so the webhook response remains resilient.
      }
    }
  } finally {
    clearInterval(typingTimer);
  }

  if (content.kind !== "text") {
    void token;
  }
}

export function isForumTopicServiceMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message as Record<string, unknown>;
  return (
    "forum_topic_created" in record ||
    "forum_topic_edited" in record ||
    "forum_topic_closed" in record ||
    "forum_topic_reopened" in record ||
    "general_forum_topic_hidden" in record ||
    "general_forum_topic_unhidden" in record
  );
}

export function getImplicitForumTopicThreadId(message: unknown): number | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const record = message as Record<string, unknown>;
  if (!("forum_topic_created" in record)) {
    return null;
  }
  const forumTopicCreated = record.forum_topic_created;
  if (!forumTopicCreated || typeof forumTopicCreated !== "object") {
    return null;
  }
  const createdRecord = forumTopicCreated as Record<string, unknown>;
  if (createdRecord.is_name_implicit !== true) {
    return null;
  }
  const { threadId } = readThreadContext(message);
  return threadId;
}

export function buildForumTopicNameFromReply(replyText: string): string | null {
  const normalized = Array.from(replyText.normalize("NFKC"))
    .map((character) => (/[\p{L}\p{N}\s]/u.test(character) ? character : " "))
    .join("")
    .replace(/\s+/gu, "")
    .trim();
  if (!normalized) {
    return null;
  }
  return Array.from(normalized).slice(0, 10).join("");
}

function buildForumTopicRequestText(content: TelegramInboundContent): string {
  if (content.kind === "text") {
    return content.text?.trim() ?? "";
  }

  const metadata = content.metadata ?? {};
  const parts = [
    content.caption?.trim() ?? "",
    typeof metadata.fileName === "string" ? metadata.fileName : "",
    typeof metadata.title === "string" ? metadata.title : "",
    typeof metadata.performer === "string" ? metadata.performer : "",
  ].filter(Boolean);

  if (parts.length > 0) {
    return parts.join("\n");
  }

  switch (content.kind) {
    case "image":
      return "image message";
    case "voice":
      return "voice message";
    case "audio":
      return "audio message";
    case "document":
      return "document message";
    default:
      return "";
  }
}

function isMeaningfulForumTopicMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text.trim().length > 0;
  }
  return "voice" in record || "photo" in record || "document" in record || "audio" in record;
}

function createTopicKey(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

export function createTelegramStreamController(args: {
  ctx: Context;
  replyOptions?: ThreadReplyOptions;
}): TelegramResponseStreamController {
  let latestText = "";
  let lastRenderedText = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;
  let closed = false;
  let streamedMessageId: number | null = null;
  let editCount = 0;
  const throttleMs = 800;
  const maxEdits = 30;

  const flush = async (force = false): Promise<boolean> => {
    if (closed || !latestText) {
      return true;
    }
    const nextRenderedText = previewTelegramStreamText(latestText);
    if (!nextRenderedText) {
      return true;
    }
    if (streamedMessageId !== null && nextRenderedText === lastRenderedText) {
      return true;
    }

    try {
      const formatted = formatTelegramRichText(nextRenderedText);
      if (streamedMessageId === null) {
        const message = await args.ctx.reply(formatted.text, {
          ...args.replyOptions,
          parse_mode: formatted.parse_mode,
        });
        streamedMessageId = message.message_id;
        lastRenderedText = nextRenderedText;
        lastFlushAt = Date.now();
        return true;
      }
      if (!force && editCount >= maxEdits) {
        return true;
      }
      await args.ctx.api.editMessageText(
        args.ctx.chat!.id,
        streamedMessageId,
        formatted.text,
        { parse_mode: formatted.parse_mode },
      );
      lastRenderedText = nextRenderedText;
      lastFlushAt = Date.now();
      editCount += 1;
      return true;
    } catch {
      return false;
    }
  };

  const scheduleFlush = () => {
    if (closed || timer) {
      return;
    }
    const delay = Math.max(0, throttleMs - (Date.now() - lastFlushAt));
      timer = setTimeout(() => {
        timer = null;
        void flush().then(() => {
          if (latestText !== lastRenderedText && editCount < maxEdits) {
            scheduleFlush();
          }
        });
      }, delay);
  };

  return {
    enabled: true,
    async emit(partialText: string) {
      if (!partialText || closed) {
        return;
      }
      latestText = partialText;
      if (streamedMessageId !== null && editCount >= maxEdits) {
        return;
      }
      scheduleFlush();
    },
    async finalize(finalText: string) {
      if (closed) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      latestText = finalText || latestText;
      if (!latestText) {
        closed = true;
        return;
      }
      const finalChunks = splitTelegramMessageText(latestText);
      if (finalChunks.length > 1) {
        const firstChunk = finalChunks[0] ?? "";
        try {
          const formattedFirstChunk = formatTelegramRichText(firstChunk);
          if (streamedMessageId === null) {
            const message = await args.ctx.reply(formattedFirstChunk.text, {
              ...args.replyOptions,
              parse_mode: formattedFirstChunk.parse_mode,
            });
            streamedMessageId = message.message_id;
          } else {
            await args.ctx.api.editMessageText(
              args.ctx.chat!.id,
              streamedMessageId,
              formattedFirstChunk.text,
              { parse_mode: formattedFirstChunk.parse_mode },
            );
          }
          lastRenderedText = firstChunk;
          for (const chunk of finalChunks.slice(1)) {
            const formattedChunk = formatTelegramRichText(chunk);
            await args.ctx.reply(formattedChunk.text, {
              ...args.replyOptions,
              parse_mode: formattedChunk.parse_mode,
            });
          }
        } catch {
          try {
            await replyWithTelegramText(args.ctx, latestText, args.replyOptions);
          } catch {
            // Do not throw from finalize if Telegram rejects fallback send.
          }
        }
        closed = true;
        return;
      }
      try {
        const flushed = await flush(true);
        if (!flushed || latestText !== lastRenderedText) {
          const formatted = formatTelegramRichText(latestText);
          const message = await args.ctx.reply(formatted.text, {
            ...args.replyOptions,
            parse_mode: formatted.parse_mode,
          });
          streamedMessageId = streamedMessageId ?? message.message_id;
          lastRenderedText = latestText;
        }
      } catch {
        lastRenderedText = latestText;
        if (streamedMessageId === null) {
          try {
            const formatted = formatTelegramRichText(latestText);
            const message = await args.ctx.reply(formatted.text, {
              ...args.replyOptions,
              parse_mode: formatted.parse_mode,
            });
            streamedMessageId = message.message_id;
          } catch {
            // Do not throw from finalize if Telegram rejects fallback send.
          }
        }
      }
      closed = true;
    },
  };
}

export function createTelegramBot(args: {
  token: string;
  onMessage: TelegramUpdateHandler;
  resolveForumTopicName?: ForumTopicNameResolver;
  commandHandlers?: TelegramCommandHandlers;
  onCallbackQuery?: TelegramCallbackQueryHandler;
  webhook?: TelegramWebhookOptions;
}) {
  const bot = new Bot(args.token);
  const implicitTopicNames = new Map<string, { effectiveMessageCount: number }>();
  const webhookState: {
    updatedAt: string;
    status: "ready";
    lastUpdateType: string | null;
    lastChatId: number | null;
    lastThreadId: number | null;
  } = {
    updatedAt: nowIso(),
    status: "ready",
    lastUpdateType: null,
    lastChatId: null,
    lastThreadId: null,
  };

  const markUpdate = (
    eventType: string,
    chatId: number | null,
    threadId: number | null,
  ) => {
    webhookState.updatedAt = nowIso();
    webhookState.lastUpdateType = eventType;
    webhookState.lastChatId = chatId;
    webhookState.lastThreadId = threadId;
  };

  bot.use(async (ctx, next) => {
    const context = readUpdateContext(ctx.update);
    markUpdate(context.eventType, context.chatId, context.threadId);
    await next();
  });

  bot.command("start", async (ctx) => {
    await replyWithTelegramText(
      ctx,
      "Pulsarbot is online. Open the Telegram Mini App to configure providers, skills, and MCP servers.",
    );
  });

  const dispatchCommand = async (
    ctx: Context,
    handler: ((context: TelegramCommandContext) => Promise<string | null> | string | null) | undefined,
  ) => {
    if (!handler || !ensurePrivate(ctx)) {
      return;
    }
    const message = "message" in ctx && ctx.message && "text" in ctx.message
      ? ctx.message.text
      : "";
    const { threadId, replyOptions } = readThreadContext(ctx.message);
    try {
      const response = await handler({
        chatId: ctx.chat!.id,
        threadId,
        userId: ctx.from!.id,
        username: ctx.from?.username ?? undefined,
        rawText: message,
        args: parseCommandArgs(message),
        messageId: ctx.message?.message_id ?? null,
      });
      if (response) {
        await replyWithTelegramText(ctx, response, replyOptions);
      }
    } catch (error) {
      await replyWithTelegramText(
        ctx,
        error instanceof Error ? error.message : "Command failed.",
        replyOptions,
      );
    }
  };

  bot.command("tasks", async (ctx) => {
    await dispatchCommand(ctx, args.commandHandlers?.onTasks);
  });
  bot.command("approve", async (ctx) => {
    await dispatchCommand(ctx, args.commandHandlers?.onApprove);
  });
  bot.command("pause", async (ctx) => {
    await dispatchCommand(ctx, args.commandHandlers?.onPause);
  });
  bot.command("digest", async (ctx) => {
    await dispatchCommand(ctx, args.commandHandlers?.onDigest);
  });

  bot.on("message", async (ctx, next) => {
    if (ctx.message.from?.is_bot) {
      return;
    }
    const implicitThreadId = getImplicitForumTopicThreadId(ctx.message);
    if (implicitThreadId !== null) {
      implicitTopicNames.set(createTopicKey(ctx.chat!.id, implicitThreadId), {
        effectiveMessageCount: 0,
      });
    }
    if (isForumTopicServiceMessage(ctx.message)) {
      return;
    }
    const { threadId } = readThreadContext(ctx.message);
    if (threadId !== null) {
      const topicState = implicitTopicNames.get(createTopicKey(ctx.chat!.id, threadId));
      if (topicState && isMeaningfulForumTopicMessage(ctx.message)) {
        topicState.effectiveMessageCount += 1;
      }
    }
    await next();
  });

  const maybeRenameImplicitTopic = async (context: FinalizedReplyContext) => {
    if (context.threadId === null) {
      return;
    }
    const key = createTopicKey(context.chatId, context.threadId);
    const topicState = implicitTopicNames.get(key);
    if (!topicState || topicState.effectiveMessageCount < IMPLICIT_FORUM_TOPIC_RENAME_MESSAGE_THRESHOLD) {
      return;
    }
    const nextName = await args.resolveForumTopicName?.(context) ||
      buildForumTopicNameFromReply(context.replyText);
    if (!nextName) {
      return;
    }
    try {
      await bot.api.editForumTopic(context.chatId, context.threadId, { name: nextName });
      implicitTopicNames.delete(key);
    } catch {
      // Ignore topic-editing errors because this is a post-reply enhancement.
    }
  };

  bot.on("message:text", async (ctx) => {
    await dispatchMessage({
      ctx,
      token: args.token,
      onMessage: args.onMessage,
      onFinalizedReply: maybeRenameImplicitTopic,
      content: {
        kind: "text",
        text: ctx.message.text,
        metadata: {},
      },
    });
  });

  bot.on("message:voice", async (ctx) => {
    const metadata = await resolveFileMetadata(ctx, args.token, ctx.message.voice.file_id);
    await dispatchMessage({
      ctx,
      token: args.token,
      onMessage: args.onMessage,
      onFinalizedReply: maybeRenameImplicitTopic,
      content: {
        kind: "voice",
        fileId: ctx.message.voice.file_id,
        mimeType: ctx.message.voice.mime_type,
        metadata: {
          ...metadata,
          duration: ctx.message.voice.duration,
        },
      },
    });
  });

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    if (!photo) {
      return;
    }
    const metadata = await resolveFileMetadata(ctx, args.token, photo.file_id);
    await dispatchMessage({
      ctx,
      token: args.token,
      onMessage: args.onMessage,
      onFinalizedReply: maybeRenameImplicitTopic,
      content: {
        kind: "image",
        fileId: photo.file_id,
        caption: "caption" in ctx.message ? ctx.message.caption ?? undefined : undefined,
        metadata: {
          ...metadata,
          width: photo.width,
          height: photo.height,
        },
      },
    });
  });

  bot.on("message:document", async (ctx) => {
    const document = ctx.message.document;
    const metadata = await resolveFileMetadata(ctx, args.token, document.file_id);
    await dispatchMessage({
      ctx,
      token: args.token,
      onMessage: args.onMessage,
      onFinalizedReply: maybeRenameImplicitTopic,
      content: {
        kind: "document",
        fileId: document.file_id,
        mimeType: document.mime_type,
        caption: ctx.message.caption ?? undefined,
        metadata: {
          ...metadata,
          fileName: document.file_name ?? null,
        },
      },
    });
  });

  bot.on("message:audio", async (ctx) => {
    const audio = ctx.message.audio;
    const metadata = await resolveFileMetadata(ctx, args.token, audio.file_id);
    await dispatchMessage({
      ctx,
      token: args.token,
      onMessage: args.onMessage,
      onFinalizedReply: maybeRenameImplicitTopic,
      content: {
        kind: "audio",
        fileId: audio.file_id,
        mimeType: audio.mime_type,
        caption: ctx.message.caption ?? undefined,
        metadata: {
          ...metadata,
          title: audio.title ?? null,
          performer: audio.performer ?? null,
          duration: audio.duration,
          fileName: audio.file_name ?? null,
        },
      },
    });
  });

  bot.on("edited_message:text", async (ctx) => {
    if (ctx.editedMessage.from?.is_bot) {
      return;
    }
    await dispatchMessage({
      ctx,
      token: args.token,
      onMessage: args.onMessage,
      onFinalizedReply: maybeRenameImplicitTopic,
      content: {
        kind: "text",
        text: ctx.editedMessage.text,
        metadata: {
          edited: true,
        },
      },
    });
  });

  bot.on("callback_query:data", async (ctx) => {
    const updateRecord = ctx.update as unknown as Record<string, unknown>;
    const callbackQuery =
      updateRecord.callback_query && typeof updateRecord.callback_query === "object"
        ? updateRecord.callback_query as Record<string, unknown>
        : null;
    const threadContext = readThreadContext(callbackQuery?.message ?? ctx.callbackQuery.message);
    if (!ensurePrivate(ctx)) {
      await ctx.answerCallbackQuery({
        text: "Private chat only.",
        show_alert: true,
      });
      return;
    }
    if (args.onCallbackQuery) {
      try {
        const handled = await args.onCallbackQuery({
          chatId: ctx.chat!.id,
          threadId: threadContext.threadId,
          userId: ctx.from.id,
          username: ctx.from.username ?? undefined,
          data: ctx.callbackQuery.data,
          messageId: ctx.callbackQuery.message?.message_id ?? null,
        });
        if (handled) {
          await ctx.answerCallbackQuery({
            show_alert: handled.showAlert ?? false,
            ...(handled.answerText ? { text: handled.answerText } : {}),
          });
          if (handled.replyText) {
            await replyWithTelegramText(ctx, handled.replyText, threadContext.replyOptions);
          }
          return;
        }
      } catch (error) {
        await ctx.answerCallbackQuery({
          text: error instanceof Error ? error.message : "Callback failed",
          show_alert: true,
        });
        return;
      }
    }
    const reply = await args.onMessage(
      {
        updateId: parseUpdateId((ctx.update as Record<string, unknown>).update_id),
        chatId: ctx.chat!.id,
        threadId: threadContext.threadId,
        userId: ctx.from.id,
        username: ctx.from.username ?? undefined,
        messageId: ctx.callbackQuery.message?.message_id ?? null,
        content: {
          kind: "text",
          text: `Callback query: ${ctx.callbackQuery.data}`,
          metadata: {
            callbackData: ctx.callbackQuery.data,
          },
        },
      },
      createDisabledTelegramStreamController(),
    );
    await ctx.answerCallbackQuery();
    await replyWithTelegramText(ctx, reply, threadContext.replyOptions);
  });

  bot.on("my_chat_member", async (ctx) => {
    void ctx;
  });

  return {
    bot,
    handler: webhookCallback(bot, "fastify", {
      ...DEFAULT_WEBHOOK_OPTIONS,
      ...args.webhook,
    }),
    describeWebhookState() {
      return { ...webhookState };
    },
  };
}
