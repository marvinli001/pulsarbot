import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramStreamController } from "../packages/telegram/src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Telegram streaming controller", () => {
  it("throttles partial edits and finalizes with one last deterministic update", async () => {
    vi.useFakeTimers();
    const editMessageText = vi.fn(async () => undefined);
    const controller = createTelegramStreamController({
      ctx: {
        chat: { id: 42 },
        api: {
          editMessageText,
        },
      } as never,
      placeholderMessageId: 7,
    });

    await controller.emit("h");
    await controller.emit("he");
    await vi.advanceTimersByTimeAsync(800);

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenLastCalledWith(42, 7, "he");

    await controller.emit("hel");
    await controller.finalize("hello");

    expect(editMessageText).toHaveBeenCalledTimes(2);
    expect(editMessageText).toHaveBeenLastCalledWith(42, 7, "hello");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(editMessageText).toHaveBeenCalledTimes(2);
  });
});
