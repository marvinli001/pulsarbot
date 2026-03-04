import { describe, expect, it } from "vitest";
import { TokenBudgetManager } from "../packages/core/src/index.js";

describe("TokenBudgetManager", () => {
  it("flags soft and hard thresholds", () => {
    const budget = new TokenBudgetManager(0.7, 0.85);
    const snapshot = budget.evaluate({
      texts: ["a".repeat(4000)],
      maxContextTokens: 1000,
    });

    expect(snapshot.softExceeded).toBe(true);
    expect(snapshot.hardExceeded).toBe(true);
    expect(snapshot.utilization).toBeGreaterThan(0.85);
  });

  it("keeps room when usage is low", () => {
    const budget = new TokenBudgetManager();
    const snapshot = budget.evaluate({
      texts: ["hello world"],
      maxContextTokens: 1000,
    });

    expect(snapshot.softExceeded).toBe(false);
    expect(snapshot.hardExceeded).toBe(false);
    expect(snapshot.remainingTokens).toBeGreaterThan(0);
  });
});
