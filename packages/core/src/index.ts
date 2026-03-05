import { createHash, hkdfSync, randomUUID } from "node:crypto";
import pino, { type LoggerOptions } from "pino";
import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().default("/data"),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  CORS_ORIGIN: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().min(1).optional(),
  RAILWAY_STATIC_URL: z.string().url().optional(),
  PULSARBOT_ACCESS_TOKEN: z.string().min(1, "PULSARBOT_ACCESS_TOKEN is required"),
});

export type AppEnv = z.infer<typeof envSchema>;

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
  });
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
