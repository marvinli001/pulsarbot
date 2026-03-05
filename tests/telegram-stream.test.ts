import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildForumTopicNameFromReply,
  createTelegramBot,
  createTelegramStreamController,
  getImplicitForumTopicThreadId,
  isForumTopicServiceMessage,
} from "../packages/telegram/src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Telegram streaming controller", () => {
  it("streams with sendMessageDraft and finalizes with one reply", async () => {
    vi.useFakeTimers();
    const reply = vi.fn(async () => ({ message_id: 7 }));
    const sendMessageDraft = vi.fn(async () => true);
    const controller = createTelegramStreamController({
      ctx: {
        chat: { id: 42 },
        msg: { message_id: 99 },
        reply,
        api: {
          sendMessageDraft,
        },
      } as never,
    });

    await controller.emit("h");
    await controller.emit("he");
    await vi.advanceTimersByTimeAsync(300);

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    expect(sendMessageDraft).toHaveBeenLastCalledWith(42, 99, "he", undefined);
    expect(reply).toHaveBeenCalledTimes(0);

    await controller.emit("hel");
    await controller.finalize("hello");

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenLastCalledWith("hello", undefined);
    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
    expect(sendMessageDraft).toHaveBeenLastCalledWith(42, 99, "hello", undefined);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
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
    expect(buildForumTopicNameFromReply("  hello\n\nworld  ")).toBe("hello world");
    expect(buildForumTopicNameFromReply("   ")).toBeNull();
    expect(buildForumTopicNameFromReply("a".repeat(140))).toHaveLength(128);
  });

  it("renames implicit forum topic after the first threaded user message", async () => {
    const onMessage = vi.fn(async () => "  Topic   Name\nFrom Agent  ");
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
    vi.spyOn(bot.api, "sendChatAction").mockResolvedValue(true as never);
    vi
      .spyOn(bot.api, "sendMessageDraft")
      .mockResolvedValue(true as never);
    vi
      .spyOn(bot.api, "sendMessage")
      .mockResolvedValue({ message_id: 901 } as never);
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
    expect(editForumTopicSpy).toHaveBeenCalledTimes(1);
    expect(editForumTopicSpy).toHaveBeenCalledWith(42, 777, {
      name: "Topic Name From Agent",
    });
  });
});
