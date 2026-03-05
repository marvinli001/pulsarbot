import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramStreamController } from "../packages/telegram/src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Telegram streaming controller", () => {
  it("streams into a single bot message and finalizes with one edit", async () => {
    vi.useFakeTimers();
    const reply = vi.fn(async () => ({ message_id: 7 }));
    const editMessageText = vi.fn(async () => undefined);
    const controller = createTelegramStreamController({
      ctx: {
        chat: { id: 42 },
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
    expect(reply).toHaveBeenLastCalledWith("he", undefined);
    expect(editMessageText).toHaveBeenCalledTimes(0);

    await controller.emit("hel");
    await controller.finalize("hello");

    expect(reply).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenLastCalledWith(42, 7, "hello");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(editMessageText).toHaveBeenCalledTimes(1);
  });
});
