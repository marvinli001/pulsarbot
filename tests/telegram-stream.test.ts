import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildForumTopicNameFromReply,
  createTelegramBot,
  createTelegramStreamController,
  formatTelegramRichText,
  getImplicitForumTopicThreadId,
  isForumTopicServiceMessage,
  splitTelegramMessageText,
} from "../packages/telegram/src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Telegram streaming controller", () => {
  it("creates a streamed reply, throttles edits, and finalizes with the last edit", async () => {
    vi.useFakeTimers();
    const reply = vi.fn(async (_text: string, _options?: unknown) => ({ message_id: 7 }));
    const editMessageText = vi.fn(async () => true);
    const controller = createTelegramStreamController({
      ctx: {
        chat: { id: 42 },
        msg: { message_id: 99 },
        reply,
        api: {
          editMessageText,
        },
      } as never,
    });

    await controller.emit("h");
    await controller.emit("he");
    await vi.advanceTimersByTimeAsync(800);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenLastCalledWith("he", {
      parse_mode: "HTML",
    });
    expect(editMessageText).toHaveBeenCalledTimes(0);

    await controller.emit("hel");
    await controller.finalize("hello");

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenLastCalledWith(42, 7, "hello", {
      parse_mode: "HTML",
    });
    expect(reply).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(editMessageText).toHaveBeenCalledTimes(1);
  });

  it("falls back to sending a fresh reply when editMessageText is rejected", async () => {
    vi.useFakeTimers();
    const reply = vi.fn(async (_text: string, _options?: unknown) => ({ message_id: 7 }));
    const editMessageText = vi.fn(async () => {
      throw new Error("send failed");
    });
    const controller = createTelegramStreamController({
      ctx: {
        chat: { id: 42 },
        msg: { message_id: 99 },
        reply,
        api: {
          editMessageText,
        },
      } as never,
    });

    await controller.emit("hel");
    await vi.advanceTimersByTimeAsync(800);
    await controller.finalize("hello");

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenLastCalledWith("hello", {
      parse_mode: "HTML",
    });
  });

  it("splits oversized final replies into multiple Telegram messages", async () => {
    vi.useFakeTimers();
    const reply = vi.fn(async (_text: string, _options?: unknown) => ({ message_id: 7 }));
    const editMessageText = vi.fn(async () => true);
    const controller = createTelegramStreamController({
      ctx: {
        chat: { id: 42 },
        msg: { message_id: 99 },
        reply,
        api: {
          editMessageText,
        },
      } as never,
    });

    const longReply = Array.from({ length: 120 }, (_, index) => `Line ${index + 1}: ${"x".repeat(48)}`).join("\n");

    await controller.emit("working");
    await vi.advanceTimersByTimeAsync(800);
    await controller.finalize(longReply);

    const expectedChunks = splitTelegramMessageText(longReply);
    expect(expectedChunks.length).toBeGreaterThan(1);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenLastCalledWith(42, 7, expectedChunks[0], {
      parse_mode: "HTML",
    });
    expect(reply).toHaveBeenCalledTimes(expectedChunks.length);
    expect(reply.mock.calls.slice(1).map((call) => call[0])).toEqual(expectedChunks.slice(1));
    expect(expectedChunks.every((chunk) => Array.from(chunk).length <= 4096)).toBe(true);
  });
});

describe("Telegram service message filters", () => {
  it("recognizes forum topic service messages", () => {
    expect(
      isForumTopicServiceMessage({
        forum_topic_created: {
          name: "New Topic",
        },
      }),
    ).toBe(true);
    expect(
      isForumTopicServiceMessage({
        general_forum_topic_hidden: true,
      }),
    ).toBe(true);
    expect(
      isForumTopicServiceMessage({
        text: "hello",
      }),
    ).toBe(false);
  });

  it("extracts implicit forum topic thread id", () => {
    expect(
      getImplicitForumTopicThreadId({
        message_thread_id: 123,
        forum_topic_created: {
          name: "new",
          is_name_implicit: true,
        },
      }),
    ).toBe(123);
    expect(
      getImplicitForumTopicThreadId({
        message_thread_id: 123,
        forum_topic_created: {
          name: "new",
        },
      }),
    ).toBeNull();
  });

  it("builds forum topic name from assistant reply", () => {
    expect(buildForumTopicNameFromReply("  hello\n\nworld  ")).toBe("helloworld");
    expect(buildForumTopicNameFromReply("   ")).toBeNull();
    expect(buildForumTopicNameFromReply("a".repeat(140))).toHaveLength(10);
  });

  it("formats markdown-style reply text into Telegram HTML", () => {
    expect(formatTelegramRichText([
      "### Summary",
      "",
      "1. **Bold point**",
      "  - Child detail",
      "",
      "| Item | Value |",
      "| --- | --- |",
      "| Product | 5G MAX |",
      "| Price | $70 |",
      "",
      "> quoted",
      "> continuation",
      "[Example](https://example.com)",
      "`code`",
      "```ts",
      "const x = 1 < 2;",
      "```",
      "~~done~~",
    ].join("\n"))).toEqual({
      parse_mode: "HTML",
      text: [
        "<b>Summary</b>",
        "",
        "1. <b>Bold point</b>",
        "&nbsp;&nbsp;&nbsp;&nbsp;- Child detail",
        "",
        "- Product: 5G MAX",
        "- Price: $70",
        "",
        "<blockquote>quoted\ncontinuation</blockquote>",
        "<a href=\"https://example.com\">Example</a>",
        "<code>code</code>",
        "<pre><code>const x = 1 &lt; 2;</code></pre>",
        "<s>done</s>",
      ].join("\n"),
    });
  });

  it("splits long Telegram text on natural boundaries", () => {
    const chunks = splitTelegramMessageText([
      "第一段".repeat(400),
      "Second paragraph ".repeat(200),
      "tail",
    ].join("\n\n"));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 4096)).toBe(true);
    expect(chunks.join("\n")).toContain("tail");
  });

  it("renames implicit forum topic after enough threaded messages accumulate", async () => {
    const onMessage = vi.fn(async () => "  Topic   Name\nFrom Agent  ");
    const resolveForumTopicName = vi.fn(async () => "会话感知");
    const { bot } = createTelegramBot({
      token: "123456:TESTTOKEN",
      onMessage,
      resolveForumTopicName,
    });
    bot.botInfo = {
      id: 999001,
      is_bot: true,
      first_name: "PulsarBot",
      username: "pulsarbot_test",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    } as never;
    vi.spyOn(bot.api, "sendChatAction").mockResolvedValue(true as never);
    const sentMessages: Array<Record<string, unknown>> = [];
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === "sendMessage") {
        sentMessages.push(payload as Record<string, unknown>);
        return {
          ok: true,
          result: { message_id: 901 },
        } as never;
      }
      return prev(method, payload, signal);
    });
    const editForumTopicSpy = vi
      .spyOn(bot.api, "editForumTopic")
      .mockResolvedValue(true as never);

    await bot.handleUpdate({
      update_id: 1001,
      message: {
        message_id: 10,
        date: 1,
        chat: { id: 42, type: "private" },
        from: { id: 77, is_bot: false, first_name: "Owner" },
        message_thread_id: 777,
        forum_topic_created: {
          name: "New Topic",
          icon_color: 0x6fb9f0,
          is_name_implicit: true,
        },
      },
    } as never);

    expect(onMessage).toHaveBeenCalledTimes(0);

    await bot.handleUpdate({
      update_id: 1002,
      message: {
        message_id: 11,
        date: 2,
        chat: { id: 42, type: "private" },
        from: { id: 77, is_bot: false, first_name: "Owner" },
        message_thread_id: 777,
        text: "hello",
      },
    } as never);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(resolveForumTopicName).toHaveBeenCalledTimes(0);
    expect(editForumTopicSpy).toHaveBeenCalledTimes(0);

    await bot.handleUpdate({
      update_id: 1003,
      message: {
        message_id: 12,
        date: 3,
        chat: { id: 42, type: "private" },
        from: { id: 77, is_bot: false, first_name: "Owner" },
        message_thread_id: 777,
        text: "still need help",
      },
    } as never);

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1]).toMatchObject({
      chat_id: 42,
      message_thread_id: 777,
      parse_mode: "HTML",
      text: "  Topic   Name\nFrom Agent  ",
    });
    expect(resolveForumTopicName).toHaveBeenCalledTimes(1);
    expect(resolveForumTopicName).toHaveBeenCalledWith({
      chatId: 42,
      threadId: 777,
      requestText: "still need help",
      replyText: "  Topic   Name\nFrom Agent  ",
    });
    expect(editForumTopicSpy).toHaveBeenCalledTimes(1);
    expect(editForumTopicSpy).toHaveBeenCalledWith(42, 777, {
      name: "会话感知",
    });
  });

  it("ignores edited text updates authored by the bot itself", async () => {
    const onMessage = vi.fn(async () => "ignored");
    const { bot } = createTelegramBot({
      token: "123456:TESTTOKEN",
      onMessage,
    });
    bot.botInfo = {
      id: 999001,
      is_bot: true,
      first_name: "PulsarBot",
      username: "pulsarbot_test",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    } as never;

    await bot.handleUpdate({
      update_id: 2001,
      edited_message: {
        message_id: 501,
        date: 2,
        edit_date: 3,
        chat: { id: 42, type: "private" },
        from: { id: 999001, is_bot: true, first_name: "PulsarBot" },
        text: "bot draft change",
      },
    } as never);

    expect(onMessage).toHaveBeenCalledTimes(0);
  });

  it("returns from the webhook without throwing when processing exceeds the timeout", async () => {
    const sentMessages: Array<Record<string, unknown>> = [];
    const { bot, handler } = createTelegramBot({
      token: "123456:TESTTOKEN",
      webhook: {
        onTimeout: "return",
        timeoutMilliseconds: 5,
      },
      onMessage: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "slow reply";
      },
    });
    bot.botInfo = {
      id: 999001,
      is_bot: true,
      first_name: "PulsarBot",
      username: "pulsarbot_test",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    } as never;
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === "sendChatAction") {
        return true as never;
      }
      if (method === "sendMessage") {
        sentMessages.push(payload as Record<string, unknown>);
        return {
          ok: true,
          result: { message_id: 901 },
        } as never;
      }
      if (method === "editMessageText") {
        return true as never;
      }
      throw new Error(`Unexpected Telegram API method in test: ${method}`);
    });

    const reply = {
      payload: null as unknown,
      statusCode: 200,
      code(statusCode: number) {
        this.statusCode = statusCode;
        return this;
      },
      headers(_headers: Record<string, string>) {
        return this;
      },
      send(payload: unknown) {
        this.payload = payload;
        return payload;
      },
    };

    await expect(handler({
      body: {
        update_id: 3001,
        message: {
          message_id: 601,
          date: 4,
          chat: { id: 42, type: "private" },
          from: { id: 77, is_bot: false, first_name: "Owner" },
          text: "slow webhook",
        },
      },
      headers: {},
    } as never, reply as never)).resolves.toBeUndefined();

    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toBe("");
    expect(sentMessages).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      chat_id: 42,
      parse_mode: "HTML",
      text: "slow reply",
    });
  });
});
