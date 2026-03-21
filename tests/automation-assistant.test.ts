import { describe, expect, it } from "vitest";
import {
  describeTriggerSchedule,
  nextScheduledRunAt,
  planAutomationFromText,
} from "../apps/server/src/automation-assistant.js";

describe("automation assistant planning", () => {
  it("computes the next daily run in the configured timezone", () => {
    const nextRunAt = nextScheduledRunAt(
      {
        schedule: {
          mode: "daily",
          time: "08:30",
          timezone: "UTC",
        },
      },
      Date.parse("2026-03-19T07:15:00.000Z"),
      "UTC",
    );

    expect(nextRunAt).toBe("2026-03-19T08:30:00.000Z");
  });

  it("computes the next weekly run from ISO weekdays", () => {
    const nextRunAt = nextScheduledRunAt(
      {
        schedule: {
          mode: "weekly",
          time: "09:00",
          timezone: "UTC",
          weekdays: [1, 3, 5],
        },
      },
      Date.parse("2026-03-19T12:00:00.000Z"),
      "UTC",
    );

    expect(nextRunAt).toBe("2026-03-20T09:00:00.000Z");
  });

  it("computes the next cron run", () => {
    const nextRunAt = nextScheduledRunAt(
      {
        schedule: {
          mode: "cron",
          cron: "0 8 * * 1-5",
          timezone: "UTC",
        },
      },
      Date.parse("2026-03-20T08:01:00.000Z"),
      "UTC",
    );

    expect(nextRunAt).toBe("2026-03-23T08:00:00.000Z");
  });

  it("parses a Chinese natural-language schedule request into a task and trigger", () => {
    const plan = planAutomationFromText({
      text: "帮我每天早上8点监控 https://example.com/news 并推送给我",
      timezone: "UTC",
      existingTasks: [],
      latestTaskId: null,
      pendingPlan: null,
      chatId: 42,
      threadId: 7,
    });

    expect(plan.action).toBe("create_task");
    expect(plan.task?.templateKind).toBe("web_watch_report");
    expect(plan.task?.config?.url).toBe("https://example.com/news");
    expect(plan.trigger?.kind).toBe("schedule");
    expect(plan.trigger?.sessionTarget).toMatchObject({
      kind: "telegram_chat",
      telegramChatId: "42",
      telegramThreadId: 7,
    });
    expect(plan.trigger?.retryPolicy).toMatchObject({
      enabled: true,
      maxAttempts: 4,
    });
    expect(describeTriggerSchedule(plan.trigger?.config ?? {}, "UTC")).toContain("每天 08:00");
  });

  it("keeps partial context and asks for the missing cadence", () => {
    const plan = planAutomationFromText({
      text: "帮我监控 https://example.com/pricing",
      timezone: "UTC",
      existingTasks: [],
      latestTaskId: null,
      pendingPlan: null,
      chatId: 42,
    });

    expect(plan.action).toBe("clarify");
    expect(plan.task?.config?.url).toBe("https://example.com/pricing");
    expect(plan.clarificationQuestion).toContain("怎么触发");
  });

  it("can target an isolated automation session", () => {
    const plan = planAutomationFromText({
      text: "帮我在独立会话里每天 09:00 监控 https://example.com/ops",
      timezone: "UTC",
      existingTasks: [],
      latestTaskId: null,
      pendingPlan: null,
      chatId: 42,
      threadId: null,
    });

    expect(plan.trigger?.sessionTarget).toMatchObject({
      kind: "isolated_automation_session",
      telegramChatId: "42",
    });
  });
});
