import { Bot, webhookCallback, type Context } from "grammy";
import { nowIso } from "@pulsarbot/core";
import type { TelegramInboundContent } from "@pulsarbot/shared";

export interface TelegramUpdatePayload {
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

function createDisabledTelegramStreamController(): TelegramResponseStreamController {
  return {
    enabled: false,
    async emit() {},
    async finalize() {},
  };
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
}) {
  const { ctx, content, onMessage, token } = args;
  if (!ensurePrivate(ctx)) {
    await ctx.reply("This version only supports private chats.");
    return;
  }

  const updateRecord = ctx.update as unknown as Record<string, unknown>;
  const threadContext = readThreadContext(updateRecord.message ?? ctx.msg);
  let placeholder;
  try {
    placeholder = await ctx.reply("Thinking…", threadContext.replyOptions);
  } catch {
    placeholder = await ctx.reply("Thinking…");
  }
  const controller = createTelegramStreamController({
    ctx,
    placeholderMessageId: placeholder.message_id,
    ...(threadContext.replyOptions
      ? { replyOptions: threadContext.replyOptions }
      : {}),
  });
  const reply = await onMessage(
    {
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

  if (content.kind !== "text") {
    void token;
  }
}

function normalizeTelegramError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTelegramStreamController(args: {
  ctx: Context;
  placeholderMessageId: number;
  replyOptions?: ThreadReplyOptions;
}): TelegramResponseStreamController {
  let latestText = "";
  let lastRenderedText = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;
  let editCount = 0;
  let closed = false;
  const maxEdits = 30;
  const throttleMs = 800;

  const flush = async (force = false): Promise<boolean> => {
    if (closed || !latestText || latestText === lastRenderedText) {
      return true;
    }
    if (!force && editCount >= maxEdits) {
      return false;
    }

    try {
      await args.ctx.api.editMessageText(
        args.ctx.chat!.id,
        args.placeholderMessageId,
        latestText,
      );
      lastRenderedText = latestText;
      lastFlushAt = Date.now();
      editCount += 1;
      return true;
    } catch (error) {
      const message = normalizeTelegramError(error);
      if (!/message is not modified/i.test(message)) {
        return false;
      }
      lastRenderedText = latestText;
      return true;
    }
  };

  const scheduleFlush = () => {
    if (closed || timer || editCount >= maxEdits) {
      return;
    }
    const delay = Math.max(0, throttleMs - (Date.now() - lastFlushAt));
    timer = setTimeout(() => {
      timer = null;
      void flush(false).then(() => {
        if (latestText !== lastRenderedText) {
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
      const rendered = await flush(true);
      if (!rendered && latestText) {
        try {
          await args.ctx.reply(latestText, args.replyOptions);
          lastRenderedText = latestText;
        } catch {
          // Do not throw from finalize if Telegram rejects fallback send.
        }
      }
      closed = true;
    },
  };
}

export function createTelegramBot(args: {
  token: string;
  onMessage: TelegramUpdateHandler;
}) {
  const bot = new Bot(args.token);
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
    await ctx.reply(
      "Pulsarbot is online. Open the Telegram Mini App to configure providers, skills, and MCP servers.",
    );
  });

  bot.on("message:text", async (ctx) => {
    await dispatchMessage({
      ctx,
      token: args.token,
      onMessage: args.onMessage,
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
    await dispatchMessage({
      ctx,
      token: args.token,
      onMessage: args.onMessage,
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
    const reply = await args.onMessage(
      {
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
    await ctx.reply(reply, threadContext.replyOptions);
  });

  bot.on("my_chat_member", async (ctx) => {
    void ctx;
  });

  return {
    bot,
    handler: webhookCallback(bot, "fastify"),
    describeWebhookState() {
      return { ...webhookState };
    },
  };
}
