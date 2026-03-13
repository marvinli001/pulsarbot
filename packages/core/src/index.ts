import { createHash, hkdfSync, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pino, { type LoggerOptions } from "pino";
import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().default("/data"),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  CORS_ORIGIN: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  // Optional URL-ish values are normalized by the server runtime.
  TELEGRAM_WEBHOOK_URL: z.string().optional(),
  PUBLIC_BASE_URL: z.string().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  RAILWAY_STATIC_URL: z.string().optional(),
  PULSARBOT_ACCESS_TOKEN: z.string().min(1, "PULSARBOT_ACCESS_TOKEN is required"),
});

export type AppEnv = z.infer<typeof envSchema>;

const INTERNAL_LOG_LIMIT = 5_000;
const internalLogEntries: InternalLogEntry[] = [];
let internalLogSeq = 0;
let internalLogOverflow = 0;
let internalLogRemainder = "";

const levelLabels: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export interface InternalLogEntry {
  seq: number;
  raw: string;
  receivedAt: string;
  logger: string | null;
  level: string | null;
  message: string | null;
  parsed: Record<string, unknown> | null;
}

function parseInternalLogLine(line: string): InternalLogEntry {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(line);
    parsed = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    parsed = null;
  }
  const numericLevel = typeof parsed?.level === "number" ? parsed.level : null;
  const textualLevel = typeof parsed?.level === "string"
    ? parsed.level
    : numericLevel !== null
      ? levelLabels[numericLevel] ?? String(numericLevel)
      : null;
  return {
    seq: ++internalLogSeq,
    raw: line,
    receivedAt: nowIso(),
    logger: typeof parsed?.name === "string" ? parsed.name : null,
    level: textualLevel,
    message: typeof parsed?.msg === "string" ? parsed.msg : null,
    parsed,
  };
}

function pushInternalLogLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  internalLogEntries.push(parseInternalLogLine(trimmed));
  if (internalLogEntries.length > INTERNAL_LOG_LIMIT) {
    internalLogEntries.splice(0, internalLogEntries.length - INTERNAL_LOG_LIMIT);
    internalLogOverflow += 1;
  }
}

function ingestInternalLogChunk(chunk: string) {
  internalLogRemainder += chunk;
  let newlineIndex = internalLogRemainder.indexOf("\n");
  while (newlineIndex >= 0) {
    pushInternalLogLine(internalLogRemainder.slice(0, newlineIndex));
    internalLogRemainder = internalLogRemainder.slice(newlineIndex + 1);
    newlineIndex = internalLogRemainder.indexOf("\n");
  }
}

const internalLogStream = new Writable({
  write(chunk, _encoding, callback) {
    try {
      ingestInternalLogChunk(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  },
});

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(source);
}

export function createLogger(options: LoggerOptions = {}) {
  return pino({
    level: process.env.NODE_ENV === "development" ? "debug" : "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "headers.authorization",
        "headers.x-auth-key",
        "*.apiKey",
        "*.apiToken",
        "*.globalApiKey",
        "*.accessToken",
      ],
      remove: true,
    },
    ...options,
  }, pino.multistream([
    { stream: process.stdout },
    { stream: internalLogStream },
  ]));
}

export function getInternalLogSnapshot(limit?: number) {
  const entries = limit && Number.isFinite(limit) && limit > 0
    ? internalLogEntries.slice(-Math.trunc(limit))
    : [...internalLogEntries];
  return {
    totalEntries: internalLogSeq,
    retainedEntries: internalLogEntries.length,
    droppedEntries: internalLogOverflow,
    firstSeq: entries[0]?.seq ?? null,
    lastSeq: entries[entries.length - 1]?.seq ?? null,
    entries,
  };
}

export function formatInternalLogsAsText(limit?: number): string {
  const snapshot = getInternalLogSnapshot(limit);
  const header = [
    `generatedAt=${nowIso()}`,
    `totalEntries=${snapshot.totalEntries}`,
    `retainedEntries=${snapshot.retainedEntries}`,
    `droppedEntries=${snapshot.droppedEntries}`,
  ].join(" ");
  const lines = snapshot.entries.map((entry) => {
    const parsed = entry.parsed
      ? Object.fromEntries(
          Object.entries(entry.parsed).filter(([key]) =>
            !["time", "level", "pid", "hostname", "name", "msg"].includes(key)
          ),
        )
      : null;
    return [
      `[${entry.receivedAt}]`,
      entry.level ? `[${entry.level}]` : null,
      entry.logger ? `[${entry.logger}]` : null,
      entry.message ?? entry.raw,
      parsed && Object.keys(parsed).length > 0 ? JSON.stringify(parsed) : null,
    ]
      .filter(Boolean)
      .join(" ");
  });
  return [header, ...lines].join("\n");
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(code: string, message: string, statusCode = 500) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface TokenBudgetSnapshot {
  estimatedTokens: number;
  maxContextTokens: number;
  utilization: number;
  softExceeded: boolean;
  hardExceeded: boolean;
  remainingTokens: number;
}

export class TokenBudgetManager {
  public constructor(
    private readonly softThreshold = 0.7,
    private readonly hardThreshold = 0.85,
  ) {}

  public estimateTextTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  public evaluate(args: {
    texts: string[];
    maxContextTokens: number;
  }): TokenBudgetSnapshot {
    const estimatedTokens = args.texts.reduce(
      (total, text) => total + this.estimateTextTokens(text),
      0,
    );
    const utilization = estimatedTokens / args.maxContextTokens;
    return {
      estimatedTokens,
      maxContextTokens: args.maxContextTokens,
      utilization,
      softExceeded: utilization >= this.softThreshold,
      hardExceeded: utilization >= this.hardThreshold,
      remainingTokens: Math.max(0, args.maxContextTokens - estimatedTokens),
    };
  }
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function deriveHkdfKeyMaterial(args: {
  accessToken: string;
  workspaceId: string;
  info: string;
  length?: number;
}): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(args.accessToken, "utf8"),
      Buffer.from(args.workspaceId, "utf8"),
      Buffer.from(args.info, "utf8"),
      args.length ?? 32,
    ),
  );
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
