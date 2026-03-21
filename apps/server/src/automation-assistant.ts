import type {
  ApprovalPolicy,
  AutomationSessionTarget,
  LooseJsonValue,
  MemoryPolicy,
  Task,
  TaskRetryPolicy,
  WorkflowTemplateKind,
} from "@pulsarbot/shared";

export type RecurringSchedule =
  | {
      mode: "interval";
      intervalMinutes: number;
    }
  | {
      mode: "daily";
      time: string;
      timezone: string;
    }
  | {
      mode: "weekly";
      time: string;
      timezone: string;
      weekdays: number[];
    }
  | {
      mode: "cron";
      cron: string;
      timezone: string;
    };

export interface AutomationTaskDraft {
  title?: string | null;
  goal?: string | null;
  description?: string | null;
  templateKind?: WorkflowTemplateKind | null;
  status?: Task["status"] | null;
  config?: Record<string, LooseJsonValue> | null;
  approvalPolicy?: ApprovalPolicy | null;
  approvalCheckpoints?: string[] | null;
  memoryPolicy?: MemoryPolicy | null;
}

export interface AutomationTriggerDraft {
  kind: "schedule" | "webhook" | "telegram_shortcut";
  label?: string | null;
  enabled?: boolean;
  config?: Record<string, LooseJsonValue>;
  webhookPath?: string | null;
  sessionTarget?: AutomationSessionTarget | null;
  retryPolicy?: TaskRetryPolicy | null;
}

export interface AutomationPlanningResult {
  action: "none" | "clarify" | "create_task" | "update_task" | "pause_task" | "run_task";
  confidence: number;
  explanation: string;
  clarificationQuestion?: string | null;
  taskId?: string | null;
  task?: AutomationTaskDraft | null;
  trigger?: AutomationTriggerDraft | null;
}

export interface AutomationPlanningInput {
  text: string;
  timezone: string;
  existingTasks: Array<Pick<Task, "id" | "title" | "goal" | "status" | "templateKind">>;
  latestTaskId?: string | null;
  pendingPlan?: AutomationPlanningResult | null;
  chatId?: number | null;
  threadId?: number | null;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

export function isAutomationAuthoringMessage(text: string, hasPendingPlan = false): boolean {
  if (hasPendingPlan) {
    return true;
  }
  return /自动化|定时|定期|每隔|每天|每周|星期|工作日|周末|webhook|\/digest|digest|schedule|cron|run every|weekly|daily|monitor|watch|trigger|提醒|监控|抓取|汇总|暂停这个|这个自动化|运行这个/u.test(
    text,
  );
}

export function cloneLooseRecord(
  value: Record<string, LooseJsonValue> | null | undefined,
): Record<string, LooseJsonValue> {
  if (!value) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, LooseJsonValue>;
}

export function mergeLooseRecords(
  base: Record<string, LooseJsonValue> | null | undefined,
  patch: Record<string, LooseJsonValue> | null | undefined,
): Record<string, LooseJsonValue> {
  const next = cloneLooseRecord(base);
  if (!patch) {
    return next;
  }

  for (const [key, rawValue] of Object.entries(patch)) {
    if (
      rawValue &&
      typeof rawValue === "object" &&
      !Array.isArray(rawValue) &&
      next[key] &&
      typeof next[key] === "object" &&
      !Array.isArray(next[key])
    ) {
      next[key] = mergeLooseRecords(
        next[key] as Record<string, LooseJsonValue>,
        rawValue as Record<string, LooseJsonValue>,
      );
      continue;
    }
    next[key] = JSON.parse(JSON.stringify(rawValue)) as LooseJsonValue;
  }

  return next;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function normalizedTimeZone(timeZone: string | null | undefined, fallback: string): string {
  if (typeof timeZone === "string" && timeZone.trim() && isValidTimeZone(timeZone.trim())) {
    return timeZone.trim();
  }
  return isValidTimeZone(fallback) ? fallback : "UTC";
}

function readLocalDateParts(epochMs: number, timeZone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(epochMs));
  const lookup = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;

  return {
    year: lookup.year ?? 1970,
    month: lookup.month ?? 1,
    day: lookup.day ?? 1,
    hour: lookup.hour ?? 0,
    minute: lookup.minute ?? 0,
    second: lookup.second ?? 0,
  };
}

function shiftCivilDate(
  date: Pick<LocalDateParts, "year" | "month" | "day">,
  days: number,
): Pick<LocalDateParts, "year" | "month" | "day"> {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function isoWeekday(date: Pick<LocalDateParts, "year" | "month" | "day">): number {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function desiredLocalToUtcMs(args: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): number {
  let guess = Date.UTC(args.year, args.month - 1, args.day, args.hour, args.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readLocalDateParts(guess, args.timeZone);
    const desiredStamp = Date.UTC(args.year, args.month - 1, args.day, args.hour, args.minute, 0, 0);
    const actualStamp = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      0,
      0,
    );
    const deltaMs = desiredStamp - actualStamp;
    if (deltaMs === 0) {
      return guess;
    }
    guess += deltaMs;
  }

  return guess;
}

function formatClockTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseClockTime(text: string): string | null {
  const normalized = text.trim().toLowerCase();
  const colonMatch = normalized.match(/(上午|下午|晚上|中午|早上|am|pm)?\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/u);
  const halfMatch = normalized.match(/(上午|下午|晚上|中午|早上|am|pm)?\s*(\d{1,2})\s*点半/u);
  const hourMatch = normalized.match(/(上午|下午|晚上|中午|早上|am|pm)?\s*(\d{1,2})\s*(?:点|时)\s*(\d{1,2})?\s*分?/u);

  const match = colonMatch ?? halfMatch ?? hourMatch;
  if (!match) {
    return null;
  }

  const marker = match[1] ?? "";
  let hour = Number(match[2] ?? NaN);
  let minute = 0;
  if (colonMatch?.[3]) {
    minute = Number(colonMatch[3]);
  } else if (halfMatch) {
    minute = 30;
  } else if (hourMatch?.[3]) {
    minute = Number(hourMatch[3]);
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }

  if (/下午|晚上|pm/u.test(marker) && hour < 12) {
    hour += 12;
  }
  if (/中午/u.test(marker) && hour < 11) {
    hour += 12;
  }
  if (/(早上|上午|am)/u.test(marker) && hour === 12) {
    hour = 0;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return formatClockTime(hour, minute);
}

function parseIntervalSchedule(text: string): RecurringSchedule | null {
  const match = text.match(/每(?:隔)?\s*(\d+(?:\.\d+)?)\s*(分钟|小时|天|minutes?|hours?|days?)/iu);
  if (!match) {
    return null;
  }
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  const unit = match[2]?.toLowerCase() ?? "分钟";
  let intervalMinutes = numeric;
  if (unit.startsWith("小时") || unit.startsWith("hour")) {
    intervalMinutes *= 60;
  } else if (unit.startsWith("天") || unit.startsWith("day")) {
    intervalMinutes *= 60 * 24;
  }
  return {
    mode: "interval",
    intervalMinutes: Math.max(Math.round(intervalMinutes * 100) / 100, 0.01),
  };
}

interface ParsedCronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
}

const CRON_MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const CRON_WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function rangeValues(start: number, end: number, step: number, max: number): number[] {
  const values: number[] = [];
  if (start <= end) {
    for (let current = start; current <= end; current += step) {
      values.push(current);
    }
    return values;
  }
  for (let current = start; current <= max; current += step) {
    values.push(current);
  }
  for (let current = 0; current <= end; current += step) {
    values.push(current);
  }
  return values;
}

function parseCronNumber(
  token: string,
  names: Record<string, number> | undefined,
): number | null {
  const normalized = token.trim().toLowerCase();
  if (names?.[normalized] !== undefined) {
    return names[normalized] ?? null;
  }
  const numeric = Number(normalized);
  return Number.isInteger(numeric) ? numeric : null;
}

function parseCronField(args: {
  expression: string;
  min: number;
  max: number;
  names?: Record<string, number>;
  normalize?: (value: number) => number;
}): { values: Set<number>; wildcard: boolean } | null {
  const output = new Set<number>();
  const expression = args.expression.trim();
  if (!expression) {
    return null;
  }
  const wildcard = expression === "*";

  for (const rawSegment of expression.split(",")) {
    const segment = rawSegment.trim();
    if (!segment) {
      return null;
    }
    const [rangePart, stepPart] = segment.split("/");
    const normalizedRangePart = rangePart ?? "*";
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      return null;
    }

    const addValue = (rawValue: number) => {
      const normalized = args.normalize ? args.normalize(rawValue) : rawValue;
      if (normalized < args.min || normalized > args.max) {
        throw new Error("Cron value is out of bounds");
      }
      output.add(normalized);
    };

    if (normalizedRangePart === "*") {
      for (let value = args.min; value <= args.max; value += step) {
        addValue(value);
      }
      continue;
    }

    if (normalizedRangePart.includes("-")) {
      const [rawStart, rawEnd] = normalizedRangePart.split("-");
      const start = parseCronNumber(rawStart ?? "", args.names);
      const end = parseCronNumber(rawEnd ?? "", args.names);
      if (start === null || end === null) {
        return null;
      }
      for (const value of rangeValues(start, end, step, args.max)) {
        addValue(value);
      }
      continue;
    }

    const value = parseCronNumber(normalizedRangePart, args.names);
    if (value === null) {
      return null;
    }
    addValue(value);
  }

  return {
    values: output,
    wildcard,
  };
}

function parseCronExpression(expression: string): ParsedCronSchedule | null {
  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== 5) {
    return null;
  }

  try {
    const minute = parseCronField({
      expression: parts[0] ?? "",
      min: 0,
      max: 59,
    });
    const hour = parseCronField({
      expression: parts[1] ?? "",
      min: 0,
      max: 23,
    });
    const dayOfMonth = parseCronField({
      expression: parts[2] ?? "",
      min: 1,
      max: 31,
    });
    const month = parseCronField({
      expression: parts[3] ?? "",
      min: 1,
      max: 12,
      names: CRON_MONTH_NAMES,
    });
    const dayOfWeek = parseCronField({
      expression: parts[4] ?? "",
      min: 0,
      max: 6,
      names: CRON_WEEKDAY_NAMES,
      normalize: (value) => (value === 7 ? 0 : value),
    });

    if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
      return null;
    }

    return {
      minute: minute.values,
      hour: hour.values,
      dayOfMonth: dayOfMonth.values,
      month: month.values,
      dayOfWeek: dayOfWeek.values,
      dayOfMonthWildcard: dayOfMonth.wildcard,
      dayOfWeekWildcard: dayOfWeek.wildcard,
    };
  } catch {
    return null;
  }
}

function cronMatches(args: {
  parsed: ParsedCronSchedule;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): boolean {
  if (!args.parsed.minute.has(args.minute) || !args.parsed.hour.has(args.hour)) {
    return false;
  }
  if (!args.parsed.month.has(args.month)) {
    return false;
  }

  const weekday = new Date(Date.UTC(args.year, args.month - 1, args.day)).getUTCDay();
  const dayOfMonthMatch = args.parsed.dayOfMonth.has(args.day);
  const dayOfWeekMatch = args.parsed.dayOfWeek.has(weekday);

  if (args.parsed.dayOfMonthWildcard && args.parsed.dayOfWeekWildcard) {
    return true;
  }
  if (args.parsed.dayOfMonthWildcard) {
    return dayOfWeekMatch;
  }
  if (args.parsed.dayOfWeekWildcard) {
    return dayOfMonthMatch;
  }
  return dayOfMonthMatch || dayOfWeekMatch;
}

function parseCronSchedule(text: string, defaultTimeZone: string): RecurringSchedule | null {
  const match = text.match(
    /(?:^|\s)(?:cron|CRON)\s+((?:[^\s]+\s+){4}[^\s]+)(?:\s+(?:tz|timezone)\s+([A-Za-z_\/+-]+))?/u,
  );
  if (!match) {
    return null;
  }
  const cron = (match[1] ?? "").trim();
  if (!parseCronExpression(cron)) {
    return null;
  }
  return {
    mode: "cron",
    cron,
    timezone: normalizedTimeZone(match[2] ?? undefined, defaultTimeZone),
  };
}

function expandWeekdayRange(start: number, end: number): number[] {
  const output: number[] = [start];
  let cursor = start;
  while (cursor !== end) {
    cursor = cursor === 7 ? 1 : cursor + 1;
    output.push(cursor);
    if (output.length > 7) {
      break;
    }
  }
  return output;
}

function weekdayTokenToNumber(token: string): number | null {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "日" || normalized === "天" || normalized === "sun" || normalized === "sunday") {
    return 7;
  }
  if (normalized === "一" || normalized === "mon" || normalized === "monday") {
    return 1;
  }
  if (normalized === "二" || normalized === "tue" || normalized === "tues" || normalized === "tuesday") {
    return 2;
  }
  if (normalized === "三" || normalized === "wed" || normalized === "wednesday") {
    return 3;
  }
  if (normalized === "四" || normalized === "thu" || normalized === "thursday") {
    return 4;
  }
  if (normalized === "五" || normalized === "fri" || normalized === "friday") {
    return 5;
  }
  if (normalized === "六" || normalized === "sat" || normalized === "saturday") {
    return 6;
  }
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 7) {
    return numeric;
  }
  return null;
}

function parseWeeklyDays(text: string): number[] {
  const normalized = text.toLowerCase();
  if (/工作日/u.test(normalized)) {
    return [1, 2, 3, 4, 5];
  }
  if (/周末/u.test(normalized)) {
    return [6, 7];
  }

  const rangeMatch = normalized.match(
    /(?:周|星期)?([一二三四五六日天1-7])\s*(?:到|至|-|~)\s*(?:周|星期)?([一二三四五六日天1-7])/u,
  );
  if (rangeMatch) {
    const start = weekdayTokenToNumber(rangeMatch[1] ?? "");
    const end = weekdayTokenToNumber(rangeMatch[2] ?? "");
    if (start && end) {
      return expandWeekdayRange(start, end);
    }
  }

  const tokens = normalized.match(
    /(?:周|星期)?([一二三四五六日天])|\b(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|sun|sunday)\b/gu,
  ) ?? [];
  const values = tokens
    .map((token) => token.replace(/^(周|星期)/u, ""))
    .map((token) => weekdayTokenToNumber(token))
    .filter((value): value is number => value !== null);

  return [...new Set(values)].sort((left, right) => left - right);
}

function parseRecurringSchedule(text: string, defaultTimeZone: string): RecurringSchedule | null {
  const cron = parseCronSchedule(text, defaultTimeZone);
  if (cron) {
    return cron;
  }

  const interval = parseIntervalSchedule(text);
  if (interval) {
    return interval;
  }

  const time = parseClockTime(text);
  if (!time) {
    return null;
  }

  if (/每(?:周|星期)|工作日|周末/u.test(text)) {
    const weekdays = parseWeeklyDays(text);
    if (weekdays.length === 0) {
      return null;
    }
    return {
      mode: "weekly",
      time,
      timezone: normalizedTimeZone(undefined, defaultTimeZone),
      weekdays,
    };
  }

  if (/每天|每日|daily|every day/u.test(text)) {
    return {
      mode: "daily",
      time,
      timezone: normalizedTimeZone(undefined, defaultTimeZone),
    };
  }

  return null;
}

function scheduleToTriggerConfig(schedule: RecurringSchedule): Record<string, LooseJsonValue> {
  if (schedule.mode === "interval") {
    return {
      intervalMinutes: schedule.intervalMinutes,
    };
  }

  return {
    schedule: {
      mode: schedule.mode,
      timezone: schedule.timezone,
      ...(schedule.mode === "cron"
        ? {
            cron: schedule.cron,
          }
        : {
            time: schedule.time,
          }),
      ...(schedule.mode === "weekly"
        ? {
            weekdays: schedule.weekdays,
          }
        : {}),
    },
  };
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s)]+/iu);
  return match?.[0] ?? null;
}

function extractDocumentId(text: string): string | null {
  const match = text.match(/\bdoc_[a-z0-9_-]+\b/iu);
  return match?.[0] ?? null;
}

function extractQuotedTitle(text: string): string | null {
  const match = text.match(/[“"]([^"”]{2,48})[”"]/u);
  return match?.[1]?.trim() ?? null;
}

function deriveTitle(text: string, url: string | null, templateKind: WorkflowTemplateKind | null): string | null {
  const explicit = extractQuotedTitle(text);
  if (explicit) {
    return explicit;
  }

  if (url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./u, "");
      if (templateKind === "browser_workflow") {
        return `浏览器流程 ${host}`;
      }
      return `监控 ${host}`;
    } catch {
      // Ignore invalid URL and fall through.
    }
  }

  const normalized = text
    .replace(/https?:\/\/[^\s)]+/giu, "")
    .replace(/(帮我|请|设置|创建|新建|一个|把这个|这个自动化|自动化|定时|任务|每天|每周|每隔|webhook|digest)/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, 24) : null;
}

function findMatchingTask(
  text: string,
  tasks: AutomationPlanningInput["existingTasks"],
  latestTaskId: string | null | undefined,
): AutomationPlanningInput["existingTasks"][number] | null {
  const normalized = text.toLowerCase();
  if (latestTaskId && /这个自动化|这个任务|this automation|this task|it\b/u.test(normalized)) {
    return tasks.find((task) => task.id === latestTaskId) ?? null;
  }

  const explicitId = normalized.match(/\btask_[a-z0-9_-]+\b/u)?.[0] ?? null;
  if (explicitId) {
    return tasks.find((task) => task.id.toLowerCase() === explicitId) ?? null;
  }

  return tasks
    .slice()
    .sort((left, right) => right.title.length - left.title.length)
    .find((task) => normalized.includes(task.title.toLowerCase())) ?? null;
}

function inferTemplateKind(args: {
  text: string;
  url: string | null;
  existingTask: AutomationPlanningInput["existingTasks"][number] | null;
  pendingPlan: AutomationPlanningResult | null | undefined;
}): WorkflowTemplateKind | null {
  if (args.pendingPlan?.task?.templateKind) {
    return args.pendingPlan.task.templateKind;
  }
  if (args.existingTask?.templateKind) {
    return args.existingTask.templateKind;
  }
  if (/webhook/u.test(args.text)) {
    return "webhook_fetch_analyze_push";
  }
  if (/浏览器|browser|登录|click|selector|页面流程/u.test(args.text)) {
    return "browser_workflow";
  }
  if (/文档|pdf|docx|摘要|总结文档/u.test(args.text)) {
    return "document_digest_memory";
  }
  if (/跟进|follow up/u.test(args.text)) {
    return "telegram_followup";
  }
  if (args.url || /网页|网站|监控|抓取|watch|digest|rss/u.test(args.text)) {
    return "web_watch_report";
  }
  return null;
}

function buildTaskDraft(args: {
  text: string;
  templateKind: WorkflowTemplateKind | null;
  url: string | null;
  documentId: string | null;
  chatId: number | null | undefined;
  existingTask: AutomationPlanningInput["existingTasks"][number] | null;
  pendingPlan: AutomationPlanningResult | null | undefined;
}): AutomationTaskDraft | null {
  const templateKind = args.templateKind;
  if (!templateKind) {
    return null;
  }

  const explicitTitle = extractQuotedTitle(args.text);
  const title =
    explicitTitle ??
    args.pendingPlan?.task?.title ??
    args.existingTask?.title ??
    deriveTitle(args.text, args.url, templateKind);
  const goal = args.pendingPlan?.task?.goal ?? args.existingTask?.goal ?? args.text;
  const description = args.pendingPlan?.task?.description ?? args.text;
  const baseConfig = cloneLooseRecord(args.pendingPlan?.task?.config ?? undefined);
  const chatId = args.chatId ? String(args.chatId) : null;

  let config = baseConfig;
  switch (templateKind) {
    case "web_watch_report":
      config = mergeLooseRecords(config, {
        ...(args.url ? { url: args.url } : {}),
        ...(chatId
          ? {
              telegramTarget: {
                chatId,
              },
            }
          : {}),
      });
      break;
    case "browser_workflow":
      config = mergeLooseRecords(config, {
        ...(args.url ? { startUrl: args.url } : {}),
        captureScreenshot: true,
      });
      break;
    case "document_digest_memory":
      config = mergeLooseRecords(config, {
        ...(args.documentId ? { documentId: args.documentId } : {}),
        maxParagraphs: 3,
        writebackSummary: true,
        ...(chatId
          ? {
              telegramTarget: {
                chatId,
              },
            }
          : {}),
      });
      break;
    case "telegram_followup":
      config = mergeLooseRecords(config, {
        ...(args.url ? { url: args.url } : {}),
        followupNote: args.text,
        ...(chatId
          ? {
              telegramTarget: {
                chatId,
              },
            }
          : {}),
      });
      break;
    case "webhook_fetch_analyze_push":
      config = mergeLooseRecords(config, {
        ...(typeof args.url === "string" ? { url: args.url } : {}),
        method: "GET",
        includeWebhookHeaders: true,
        ...(chatId
          ? {
              telegramTarget: {
                chatId,
              },
            }
          : {}),
      });
      break;
    default:
      break;
  }

  return {
    title,
    goal,
    description,
    templateKind,
    status: "active",
    config,
    approvalPolicy: args.pendingPlan?.task?.approvalPolicy ?? null,
    approvalCheckpoints: args.pendingPlan?.task?.approvalCheckpoints ?? null,
    memoryPolicy:
      args.pendingPlan?.task?.memoryPolicy ??
      (templateKind === "document_digest_memory" ? "task_context_writeback" : "task_context"),
  };
}

function buildTriggerDraft(args: {
  text: string;
  taskTitle: string | null | undefined;
  defaultTimeZone: string;
  pendingPlan: AutomationPlanningResult | null | undefined;
  chatId: number | null | undefined;
  threadId: number | null | undefined;
}): AutomationTriggerDraft | null {
  const wantsIsolatedSession = /独立会话|单独会话|isolated session|separate session/u.test(args.text);
  const sessionTarget: AutomationSessionTarget | null = wantsIsolatedSession
    ? {
        kind: "isolated_automation_session",
        telegramChatId: args.chatId ? String(args.chatId) : null,
        telegramThreadId: typeof args.threadId === "number" ? args.threadId : null,
        conversationId: null,
        automationSessionKey: null,
      }
    : args.chatId
    ? {
        kind: "telegram_chat",
        telegramChatId: String(args.chatId),
        telegramThreadId: typeof args.threadId === "number" ? args.threadId : null,
        conversationId: null,
        automationSessionKey: null,
      }
    : {
        kind: "owner_chat",
        telegramChatId: null,
        telegramThreadId: null,
        conversationId: null,
        automationSessionKey: null,
      };

  if (/\/digest|digest shortcut/u.test(args.text)) {
    return {
      kind: "telegram_shortcut",
      label: args.taskTitle ? `${args.taskTitle} Shortcut` : "Digest Shortcut",
      enabled: true,
      config: {
        command: "/digest",
      },
      sessionTarget,
      retryPolicy: {
        enabled: false,
        maxAttempts: 1,
        backoffSeconds: [],
        retryOn: ["executor_unavailable"],
      },
    };
  }

  if (/webhook/u.test(args.text)) {
    return {
      kind: "webhook",
      label: args.taskTitle ? `${args.taskTitle} Webhook` : "Webhook Trigger",
      enabled: true,
      config: cloneLooseRecord(args.pendingPlan?.trigger?.config ?? undefined),
      sessionTarget,
      retryPolicy: {
        enabled: true,
        maxAttempts: 3,
        backoffSeconds: [60, 300, 900],
        retryOn: ["executor_unavailable", "task_failed"],
      },
    };
  }

  const recurring = parseRecurringSchedule(args.text, args.defaultTimeZone);
  if (!recurring) {
    return args.pendingPlan?.trigger ?? null;
  }

  return {
    kind: "schedule",
    label: args.taskTitle ? `${args.taskTitle} Schedule` : "Schedule Trigger",
    enabled: true,
    config: scheduleToTriggerConfig(recurring),
    sessionTarget,
    retryPolicy: {
      enabled: true,
      maxAttempts: 4,
      backoffSeconds: [300, 900, 3600],
      retryOn: ["executor_unavailable", "task_failed"],
    },
  };
}

export function normalizeTriggerScheduleConfig(
  config: Record<string, unknown> | null | undefined,
  defaultTimeZone: string,
): RecurringSchedule | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }

  const directInterval = Number(
    (config.intervalMinutes ?? config.everyMinutes ?? config.minutes) ?? Number.NaN,
  );
  if (Number.isFinite(directInterval) && directInterval > 0) {
    return {
      mode: "interval",
      intervalMinutes: Math.max(Math.round(directInterval * 100) / 100, 0.01),
    };
  }

  const nested = config.schedule;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    return null;
  }

  const mode = String((nested as Record<string, unknown>).mode ?? "").toLowerCase();
  const cron = typeof (nested as Record<string, unknown>).cron === "string"
    ? String((nested as Record<string, unknown>).cron).trim()
    : null;
  const time = typeof (nested as Record<string, unknown>).time === "string"
    ? parseClockTime(String((nested as Record<string, unknown>).time))
    : null;
  const timezone = normalizedTimeZone(
    typeof (nested as Record<string, unknown>).timezone === "string"
      ? String((nested as Record<string, unknown>).timezone)
      : undefined,
    defaultTimeZone,
  );

  if (mode === "cron" && cron && parseCronExpression(cron)) {
    return {
      mode: "cron",
      cron,
      timezone,
    };
  }

  if (mode === "daily" && time) {
    return {
      mode: "daily",
      time,
      timezone,
    };
  }

  if (mode === "weekly" && time) {
    const weekdaysRaw = (nested as Record<string, unknown>).weekdays;
    const weekdays = Array.isArray(weekdaysRaw)
      ? weekdaysRaw
        .map((item) => Number(item))
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 7)
      : [];
    if (weekdays.length > 0) {
      return {
        mode: "weekly",
        time,
        timezone,
        weekdays: [...new Set(weekdays)].sort((left, right) => left - right),
      };
    }
  }

  return null;
}

export function nextScheduledRunAt(
  config: Record<string, unknown> | null | undefined,
  baseMs: number,
  defaultTimeZone: string,
): string | null {
  const schedule = normalizeTriggerScheduleConfig(config, defaultTimeZone);
  if (!schedule) {
    return null;
  }

  if (schedule.mode === "interval") {
    return new Date(baseMs + schedule.intervalMinutes * 60_000).toISOString();
  }

  if (schedule.mode === "cron") {
    const parsed = parseCronExpression(schedule.cron);
    if (!parsed) {
      return null;
    }
    const thresholdMs = baseMs + 1_000;
    let candidateMs = Math.floor(thresholdMs / 60_000) * 60_000;
    if (candidateMs < thresholdMs) {
      candidateMs += 60_000;
    }
    const maxIterations = 366 * 24 * 60;
    for (let index = 0; index < maxIterations; index += 1) {
      const parts = readLocalDateParts(candidateMs, schedule.timezone);
      if (cronMatches({
        parsed,
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour,
        minute: parts.minute,
      })) {
        return new Date(candidateMs).toISOString();
      }
      candidateMs += 60_000;
    }
    return null;
  }

  const nowLocal = readLocalDateParts(baseMs, schedule.timezone);
  const timeParts = schedule.time.split(":").map((value) => Number(value));
  const hour = timeParts[0] ?? 0;
  const minute = timeParts[1] ?? 0;
  const baseDate = {
    year: nowLocal.year,
    month: nowLocal.month,
    day: nowLocal.day,
  };
  const thresholdMs = baseMs + 1_000;

  if (schedule.mode === "daily") {
    for (let offset = 0; offset <= 2; offset += 1) {
      const targetDate = shiftCivilDate(baseDate, offset);
      const candidateMs = desiredLocalToUtcMs({
        ...targetDate,
        hour,
        minute,
        timeZone: schedule.timezone,
      });
      if (candidateMs > thresholdMs) {
        return new Date(candidateMs).toISOString();
      }
    }
    return null;
  }

  for (let offset = 0; offset <= 8; offset += 1) {
    const targetDate = shiftCivilDate(baseDate, offset);
    if (!schedule.weekdays.includes(isoWeekday(targetDate))) {
      continue;
    }
    const candidateMs = desiredLocalToUtcMs({
      ...targetDate,
      hour,
      minute,
      timeZone: schedule.timezone,
    });
    if (candidateMs > thresholdMs) {
      return new Date(candidateMs).toISOString();
    }
  }

  return null;
}

export function describeTriggerSchedule(
  config: Record<string, unknown> | null | undefined,
  defaultTimeZone: string,
): string {
  const schedule = normalizeTriggerScheduleConfig(config, defaultTimeZone);
  if (!schedule) {
    return "未配置有效定时";
  }
  if (schedule.mode === "interval") {
    return `每 ${schedule.intervalMinutes} 分钟`;
  }
  if (schedule.mode === "daily") {
    return `每天 ${schedule.time} (${schedule.timezone})`;
  }
  if (schedule.mode === "cron") {
    return `Cron ${schedule.cron} (${schedule.timezone})`;
  }
  return `每${schedule.weekdays.map((weekday) => WEEKDAY_LABELS[weekday - 1]).join("、")} ${schedule.time} (${schedule.timezone})`;
}

function clarifyResult(
  question: string,
  pendingPlan: AutomationPlanningResult | null | undefined,
  patch: Partial<AutomationPlanningResult> = {},
): AutomationPlanningResult {
  return {
    action: "clarify",
    confidence: 0.92,
    explanation: "需要补全自动化配置",
    clarificationQuestion: question,
    taskId: patch.taskId ?? pendingPlan?.taskId ?? null,
    task: patch.task ?? pendingPlan?.task ?? null,
    trigger: patch.trigger ?? pendingPlan?.trigger ?? null,
  };
}

export function planAutomationFromText(input: AutomationPlanningInput): AutomationPlanningResult {
  const text = input.text.trim();
  if (!text) {
    return {
      action: "none",
      confidence: 0,
      explanation: "empty_input",
    };
  }

  const existingTask = findMatchingTask(text, input.existingTasks, input.latestTaskId);
  const url = extractFirstUrl(text);
  const documentId = extractDocumentId(text);
  const templateKind = inferTemplateKind({
    text,
    url,
    existingTask,
    pendingPlan: input.pendingPlan,
  });

  const wantsPause = /暂停|停掉|关闭这个|pause/u.test(text);
  const wantsRun = /立即执行|现在执行|马上运行|run now|run this/u.test(text);
  const wantsUpdate = /改成|改为|调整为|更新成|change to|switch to|update/u.test(text);
  const wantsCreate =
    Boolean(input.pendingPlan) ||
    /创建|新建|设置|帮我做个|帮我设个|自动化|定时|监控|webhook|\/digest|digest|schedule|cron/u.test(text);

  if (wantsPause) {
    if (!existingTask) {
      return clarifyResult("要暂停哪个自动化？请直接说任务标题，或者先创建一个。", input.pendingPlan);
    }
    return {
      action: "pause_task",
      confidence: 0.98,
      explanation: `暂停任务 ${existingTask.title}`,
      taskId: existingTask.id,
    };
  }

  if (wantsRun) {
    if (!existingTask) {
      return clarifyResult("要运行哪个自动化？请直接说任务标题，或者先创建一个。", input.pendingPlan);
    }
    return {
      action: "run_task",
      confidence: 0.98,
      explanation: `立即运行任务 ${existingTask.title}`,
      taskId: existingTask.id,
    };
  }

  if (!wantsCreate && !wantsUpdate) {
    return {
      action: "none",
      confidence: 0.1,
      explanation: "message_is_not_automation_authoring",
    };
  }

  const taskDraft = buildTaskDraft({
    text,
    templateKind,
    url,
    documentId,
    chatId: input.chatId,
    existingTask,
    pendingPlan: input.pendingPlan,
  });
  const triggerDraft = buildTriggerDraft({
    text,
    taskTitle: taskDraft?.title ?? existingTask?.title ?? null,
    defaultTimeZone: input.timezone,
    pendingPlan: input.pendingPlan,
    chatId: input.chatId,
    threadId: input.threadId,
  });
  const action = existingTask && wantsUpdate ? "update_task" : existingTask && !wantsCreate
    ? "update_task"
    : input.pendingPlan?.action === "create_task"
      ? "create_task"
      : existingTask && /这个自动化|这个任务|this automation|this task/u.test(text)
        ? "update_task"
        : "create_task";

  if (!taskDraft?.templateKind) {
    return clarifyResult(
      "你要创建哪类自动化？当前比较适合的有：网页监控、浏览器流程、文档摘要或 webhook 触发。",
      input.pendingPlan,
      {
        task: taskDraft,
        trigger: triggerDraft,
      },
    );
  }

  if (
    action === "create_task" &&
    (taskDraft.templateKind === "web_watch_report" ||
      taskDraft.templateKind === "browser_workflow" ||
      taskDraft.templateKind === "telegram_followup") &&
    !url &&
    !input.pendingPlan?.task?.config?.url &&
    !input.pendingPlan?.task?.config?.startUrl
  ) {
    return clarifyResult("要处理哪个 URL？直接发完整链接即可。", input.pendingPlan, {
      task: taskDraft,
      trigger: triggerDraft,
    });
  }

  if (
    taskDraft.templateKind === "document_digest_memory" &&
    !documentId &&
    !input.pendingPlan?.task?.config?.documentId
  ) {
    return clarifyResult("要处理哪个文档？请发 document ID，例如 `doc_xxx`。", input.pendingPlan, {
      task: taskDraft,
      trigger: triggerDraft,
    });
  }

  if (action === "create_task" && !triggerDraft) {
    return clarifyResult(
      "要怎么触发它？例如“每天 08:00”、“每周一 09:00”、“每隔 30 分钟”，或者说要用 webhook。",
      input.pendingPlan,
      {
        task: taskDraft,
      },
    );
  }

  if (action === "update_task" && !existingTask && !input.pendingPlan?.taskId) {
    return clarifyResult("要修改哪个自动化？请直接说任务标题。", input.pendingPlan, {
      task: taskDraft,
      trigger: triggerDraft,
    });
  }

  return {
    action,
    confidence: 0.95,
    explanation: action === "create_task" ? "创建自动化任务" : "更新自动化任务",
    taskId: existingTask?.id ?? input.pendingPlan?.taskId ?? null,
    task: taskDraft,
    trigger: triggerDraft,
  };
}
