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

function readMessageThreadId(message: unknown): number | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  return parseThreadId((message as Record<string, unknown>).message_thread_id);
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

  const threadId = readMessageThreadId(ctx.msg);
  const placeholder = await ctx.reply(
    "Thinking…",
    threadId !== null ? { message_thread_id: threadId } : undefined,
  );
  const controller = createTelegramStreamController({
    ctx,
    placeholderMessageId: placeholder.message_id,
  });
  const reply = await onMessage(
    {
      chatId: ctx.chat!.id,
      threadId,
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
}): TelegramResponseStreamController {
  let latestText = "";
  let lastRenderedText = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;
  let editCount = 0;
  let closed = false;
  const maxEdits = 30;
  const throttleMs = 800;

  const flush = async (force = false) => {
    if (closed || !latestText || latestText === lastRenderedText) {
      return;
    }
    if (!force && editCount >= maxEdits) {
      return;
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
    } catch (error) {
      const message = normalizeTelegramError(error);
      if (!/message is not modified/i.test(message)) {
        return;
      }
      lastRenderedText = latestText;
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
      await flush(true);
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

  bot.command("start", async (ctx) => {
    markUpdate("message:start", ctx.chat?.id ?? null, readMessageThreadId(ctx.msg));
    await ctx.reply(
      "Pulsarbot is online. Open the Telegram Mini App to configure providers, skills, and MCP servers.",
    );
  });

  bot.on("message:text", async (ctx) => {
    markUpdate("message:text", ctx.chat?.id ?? null, readMessageThreadId(ctx.msg));
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
    markUpdate("message:voice", ctx.chat?.id ?? null, readMessageThreadId(ctx.msg));
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
    markUpdate("message:photo", ctx.chat?.id ?? null, readMessageThreadId(ctx.msg));
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
    markUpdate("message:document", ctx.chat?.id ?? null, readMessageThreadId(ctx.msg));
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
    markUpdate("message:audio", ctx.chat?.id ?? null, readMessageThreadId(ctx.msg));
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
    markUpdate(
      "edited_message:text",
      ctx.chat?.id ?? null,
      readMessageThreadId(ctx.editedMessage),
    );
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
    const threadId = readMessageThreadId(ctx.callbackQuery.message);
    markUpdate("callback_query:data", ctx.chat?.id ?? null, threadId);
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
        threadId,
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
    await ctx.reply(
      reply,
      threadId !== null ? { message_thread_id: threadId } : undefined,
    );
  });

  bot.on("my_chat_member", async (ctx) => {
    markUpdate("my_chat_member", ctx.chat?.id ?? null, null);
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
