import { afterEach, describe, expect, it, vi } from "vitest";
import { IndependentJobRunner } from "../apps/server/src/job-runner.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("IndependentJobRunner", () => {
  it("runs jobs serially and stops cleanly", async () => {
    vi.useFakeTimers();
    const runner = new IndependentJobRunner();
    const started: number[] = [];
    const finished: number[] = [];
    let counter = 0;

    runner.register({
      name: "test",
      intervalMs: 100,
      run: async () => {
        const current = ++counter;
        started.push(current);
        await new Promise((resolve) => setTimeout(resolve, 50));
        finished.push(current);
      },
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(260);
    runner.stop();
    await vi.advanceTimersByTimeAsync(500);

    expect(started.length).toBeGreaterThanOrEqual(2);
    expect(started).toEqual(finished);
  });
});
