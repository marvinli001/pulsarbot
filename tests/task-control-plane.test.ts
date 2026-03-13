import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CloudflareCredentials } from "../packages/shared/src/index.js";

class FakeCloudflareClient {
  private static objects = new Map<string, string>();

  public constructor(public readonly credentials: CloudflareCredentials) {}

  public async verifyCredentials() {
    return true;
  }

  public async executeD1() {
    return { success: true };
  }

  public async queryD1() {
    return [];
  }

  public async initializeWorkspaceResources(args: {
    selection?: Record<string, string>;
    workspaceId: string;
  }) {
    return {
      d1DatabaseId: args.selection?.d1DatabaseId ?? `${args.workspaceId}-d1`,
      r2BucketName: args.selection?.r2BucketName ?? `${args.workspaceId}-r2`,
      vectorizeIndexName:
        args.selection?.vectorizeIndexName ?? `${args.workspaceId}-vector`,
      aiSearchIndexName: args.selection?.aiSearchIndexName,
    };
  }

  public async listD1Databases() {
    return [{ uuid: "existing-d1", name: "existing-d1" }];
  }

  public async listR2Buckets() {
    return [{ name: "existing-r2" }];
  }

  public async listVectorizeIndexes() {
    return [{ name: "existing-vector" }];
  }

  public async listAiSearchIndexes() {
    return [{ name: "existing-ai-search" }];
  }

  public async putR2Object(args: {
    bucketName: string;
    key: string;
    body: string | Uint8Array;
  }) {
    FakeCloudflareClient.objects.set(
      `${args.bucketName}:${args.key}`,
      typeof args.body === "string" ? args.body : Buffer.from(args.body).toString("utf8"),
    );
  }

  public async getR2Object(args: { bucketName: string; key: string }) {
    return FakeCloudflareClient.objects.get(`${args.bucketName}:${args.key}`) ?? null;
  }

  public async getR2ObjectRaw(args: { bucketName: string; key: string }) {
    const body = FakeCloudflareClient.objects.get(`${args.bucketName}:${args.key}`);
    if (!body) {
      return null;
    }
    return {
      body: Uint8Array.from(Buffer.from(body, "utf8")),
      contentType: "text/plain",
    };
  }
}

function fakeTelegramFactory(messages: Array<{ chatId: number; text: string; options?: Record<string, unknown> }>) {
  return {
    bot: {
      api: {
        async sendMessage(
          chatId: number,
          text: string,
          options?: Record<string, unknown>,
        ) {
          messages.push({ chatId, text, options });
          return { message_id: messages.length };
        },
      },
    },
    handler: async (_request: unknown, reply: { send: (payload: unknown) => unknown }) =>
      reply.send({ ok: true }),
    describeWebhookState: () => ({
      updatedAt: new Date().toISOString(),
      status: "ready" as const,
      lastUpdateType: null,
      lastChatId: null,
      lastThreadId: null,
    }),
  };
}

function getCookie(response: { headers: Record<string, string | string[]> }) {
  const header = response.headers["set-cookie"];
  if (Array.isArray(header)) {
    return header[0]?.split(";")[0] ?? "";
  }
  return header?.split(";")[0] ?? "";
}

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function bootstrapApp(backgroundPollMs = 25) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pulsarbot-task-"));
  cleanupDirs.push(dataDir);
  const telegramMessages: Array<{ chatId: number; text: string; options?: Record<string, unknown> }> = [];

  const { createApp } = await import("../apps/server/src/app.js");
  const app = await createApp({
    env: {
      NODE_ENV: "test",
      TELEGRAM_BOT_TOKEN: "123456:TESTTOKEN",
      PULSARBOT_ACCESS_TOKEN: "dev-access-token",
      DATA_DIR: dataDir,
      PORT: 3001,
    },
    cloudflareClientFactory: (credentials) =>
      new FakeCloudflareClient(credentials) as never,
    backgroundPollMs,
    telegramFactory: (() => fakeTelegramFactory(telegramMessages)) as never,
  });

  const session = await app.inject({
    method: "POST",
    url: "/api/session/telegram",
    payload: {
      userId: "42",
      username: "owner",
    },
  });
  const cookie = getCookie(session);

  await app.inject({
    method: "POST",
    url: "/api/bootstrap/verify-access-token",
    payload: {
      accessToken: "dev-access-token",
    },
  });
  await app.inject({
    method: "POST",
    url: "/api/bootstrap/cloudflare/connect",
    headers: { cookie },
    payload: {
      accessToken: "dev-access-token",
      accountId: "acct",
      apiToken: "token",
      r2AccessKeyId: "r2-key",
      r2SecretAccessKey: "r2-secret",
    },
  });
  await app.inject({
    method: "POST",
    url: "/api/bootstrap/cloudflare/init-resources",
    headers: { cookie },
    payload: {
      label: "Task Test Workspace",
      timezone: "UTC",
    },
  });

  const refreshedSession = await app.inject({
    method: "POST",
    url: "/api/session/telegram",
    payload: {
      userId: "42",
      username: "owner",
    },
  });

  return {
    app,
    cookie: getCookie(refreshedSession),
    telegramMessages,
  };
}

describe("task control plane", () => {
  it("pairs executors and drives approval, webhook, and schedule runs", async () => {
    const { app, cookie, telegramMessages } = await bootstrapApp();

    const createdExecutor = await app.inject({
      method: "POST",
      url: "/api/executors",
      headers: { cookie },
      payload: {
        label: "Owner Companion",
        capabilities: ["browser", "http"],
        scopes: {
          allowedHosts: ["example.com"],
          allowedPaths: ["/tmp"],
          allowedCommands: ["echo"],
          fsRequiresApproval: true,
          shellRequiresApproval: true,
        },
      },
    });
    expect(createdExecutor.statusCode).toBe(200);
    const executor = createdExecutor.json<Record<string, any>>();

    const pair = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/pair`,
      headers: { cookie },
    });
    expect(pair.statusCode).toBe(200);
    const pairing = pair.json<Record<string, any>>();
    expect(String(pairing.pairingCode)).toContain(`pair.${executor.id}.`);

    const firstHeartbeat = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: {
        pairingCode: pairing.pairingCode,
        version: "0.1.0",
        platform: "test",
        capabilities: ["browser", "http"],
      },
    });
    expect(firstHeartbeat.statusCode).toBe(200);
    const heartbeat = firstHeartbeat.json<Record<string, any>>();
    const executorToken = String(heartbeat.executorToken ?? "");
    expect(executorToken).toContain(`exec.${executor.id}.`);

    const createdTask = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie },
      payload: {
        title: "Browser Flow",
        goal: "Open a page and capture its result.",
        templateKind: "browser_workflow",
        status: "active",
        defaultExecutorId: executor.id,
        approvalPolicy: "approval_required",
        memoryPolicy: "task_context",
      },
    });
    const task = createdTask.json<Record<string, any>>();

    const createdRun = await app.inject({
      method: "POST",
      url: "/api/task-runs",
      headers: { cookie },
      payload: {
        taskId: task.id,
      },
    });
    expect(createdRun.statusCode).toBe(200);
    const runPayload = createdRun.json<Record<string, any>>();
    expect(runPayload.taskRun.status).toBe("waiting_approval");
    expect(runPayload.approval.status).toBe("pending");

    const eventsBeforeApprove = await app.inject({
      method: "GET",
      url: `/api/system/turns/${encodeURIComponent(String(runPayload.taskRun.sessionId))}/events`,
      headers: { cookie },
    });
    expect(eventsBeforeApprove.statusCode).toBe(200);
    expect(eventsBeforeApprove.json<Array<Record<string, any>>>().some((event) =>
      event.eventType === "task_run_waiting_approval"
    )).toBe(true);

    const approved = await app.inject({
      method: "POST",
      url: "/api/approvals",
      headers: { cookie },
      payload: {
        approvalId: runPayload.approval.id,
        decision: "approved",
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json<Record<string, any>>().taskRun.status).toBe("queued");

    const assignmentHeartbeat = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: {
        executorToken,
      },
    });
    const assignments = assignmentHeartbeat.json<Record<string, any>>().assignments as Array<Record<string, any>>;
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.status).toBe("running");

    const completeHeartbeat = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: {
        executorToken,
        completedRuns: [
          {
            taskRunId: assignments[0]?.id,
            status: "completed",
            outputSummary: "Browser flow completed",
          },
        ],
      },
    });
    expect(completeHeartbeat.statusCode).toBe(200);

    await expect
      .poll(async () => {
        const response = await app.inject({
          method: "GET",
          url: "/api/task-runs",
          headers: { cookie },
        });
        const rows = response.json<Array<Record<string, any>>>();
        return rows.find((row) => row.id === assignments[0]?.id)?.status ?? null;
      })
      .toBe("completed");

    const webhookTask = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie },
      payload: {
        title: "Webhook Digest",
        goal: "Process webhook payloads.",
        templateKind: "webhook_fetch_analyze_push",
        status: "active",
        defaultExecutorId: executor.id,
        approvalPolicy: "auto_approve_safe",
        memoryPolicy: "task_context_writeback",
      },
    });
    const webhookTaskRecord = webhookTask.json<Record<string, any>>();

    const webhookTrigger = await app.inject({
      method: "POST",
      url: "/api/triggers",
      headers: { cookie },
      payload: {
        taskId: webhookTaskRecord.id,
        label: "Webhook Inbound",
        kind: "webhook",
        enabled: true,
        webhookPath: "inbound-report",
        webhookSecret: "top-secret",
      },
    });
    expect(webhookTrigger.statusCode).toBe(200);

    const webhookDelivery = await app.inject({
      method: "POST",
      url: "/api/triggers/webhook/inbound-report",
      headers: {
        "x-pulsarbot-webhook-secret": "top-secret",
      },
      payload: {
        source: "integration-test",
      },
    });
    expect(webhookDelivery.statusCode).toBe(200);
    const webhookRun = webhookDelivery.json<Record<string, any>>();
    expect(webhookRun.taskRun.status).toBe("waiting_approval");
    expect(webhookRun.approval?.status).toBe("pending");

    const webhookApproved = await app.inject({
      method: "POST",
      url: "/api/approvals",
      headers: { cookie },
      payload: {
        approvalId: webhookRun.approval.id,
        decision: "approved",
      },
    });
    expect(webhookApproved.statusCode).toBe(200);
    expect(webhookApproved.json<Record<string, any>>().taskRun.status).toBe("queued");

    const scheduleTrigger = await app.inject({
      method: "POST",
      url: "/api/triggers",
      headers: { cookie },
      payload: {
        taskId: webhookTaskRecord.id,
        label: "Fast Schedule",
        kind: "schedule",
        enabled: true,
        config: {
          intervalMinutes: 0.01,
        },
      },
    });
    expect(scheduleTrigger.statusCode).toBe(200);

    const baselineRuns = await app.inject({
      method: "GET",
      url: "/api/task-runs",
      headers: { cookie },
    });
    const baselineCount = baselineRuns.json<Array<Record<string, any>>>().length;

    await expect
      .poll(async () => {
        const response = await app.inject({
          method: "GET",
          url: "/api/task-runs",
          headers: { cookie },
        });
        return response.json<Array<Record<string, any>>>().length;
      }, { timeout: 3000 })
      .toBeGreaterThan(baselineCount);

    expect(telegramMessages.some((message) => message.text.includes("Waiting Approval"))).toBe(true);
    expect(telegramMessages.some((message) => message.text.includes("Running"))).toBe(true);
    expect(telegramMessages.some((message) => message.text.includes("Completed"))).toBe(true);

    await app.close();
  });

  it("previews and executes internal document workflows", async () => {
    const { app, cookie, telegramMessages } = await bootstrapApp();
    const appState = app as typeof app & {
      __pulsarbot?: {
        state?: {
          repository: {
            saveDocument: (document: Record<string, unknown>) => Promise<void>;
          };
          cloudflare?: {
            client: FakeCloudflareClient;
            credentials: {
              r2BucketName?: string | null;
            };
          } | null;
        };
      };
    };
    const state = appState.__pulsarbot?.state;
    expect(state?.cloudflare?.credentials.r2BucketName).toBeTruthy();
    const workspaceId = "main";
    const documentId = "doc-internal-summary";
    const derivedKey = `workspace/${workspaceId}/documents/${documentId}/derived/content.md`;
    await state!.repository.saveDocument({
      id: documentId,
      workspaceId,
      sourceType: "import",
      kind: "text",
      title: "briefing.md",
      path: `documents/${documentId}/source/briefing.md`,
      derivedTextPath: `documents/${documentId}/derived/content.md`,
      sourceObjectKey: null,
      derivedTextObjectKey: derivedKey,
      previewText: "Preview text",
      fileId: null,
      sizeBytes: 120,
      mimeType: "text/markdown",
      extractionStatus: "completed",
      extractionMethod: "decode_text",
      extractionProviderProfileId: null,
      lastExtractionError: null,
      lastExtractedAt: "2026-03-13T00:00:00.000Z",
      lastIndexedAt: "2026-03-13T00:00:00.000Z",
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
    });
    await state!.cloudflare!.client.putR2Object({
      bucketName: state!.cloudflare!.credentials.r2BucketName!,
      key: derivedKey,
      body: "Pulsarbot can summarize documents.\n\nThis is a second paragraph with more detail.\n\nAnd a third paragraph.",
    });

    const preview = await app.inject({
      method: "POST",
      url: "/api/workflow/preview",
      headers: { cookie },
      payload: {
        templateKind: "document_digest_memory",
        config: {
          documentId,
          maxParagraphs: 2,
          writebackSummary: true,
          telegramTarget: {
            chatId: 42,
          },
        },
        approvalPolicy: "approval_required",
        approvalCheckpoints: [],
        memoryPolicy: "task_context_writeback",
        relatedDocumentIds: [documentId],
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json<Record<string, any>>().ready).toBe(true);
    expect(preview.json<Record<string, any>>().approvalRequired).toBe(true);
    expect(preview.json<Record<string, any>>().taskRunStatus).toBe("waiting_approval");

    const createdTask = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie },
      payload: {
        title: "Document Digest",
        goal: "Summarize this imported document.",
        templateKind: "document_digest_memory",
        status: "active",
        approvalCheckpoints: [],
        memoryPolicy: "task_context_writeback",
        config: {
          documentId,
          maxParagraphs: 2,
          writebackSummary: true,
          telegramTarget: {
            chatId: 42,
          },
        },
        relatedDocumentIds: [documentId],
      },
    });
    const task = createdTask.json<Record<string, any>>();

    const createdRun = await app.inject({
      method: "POST",
      url: "/api/task-runs",
      headers: { cookie },
      payload: {
        taskId: task.id,
      },
    });
    expect(createdRun.statusCode).toBe(200);

    await expect
      .poll(async () => {
        const response = await app.inject({
          method: "GET",
          url: "/api/task-runs",
          headers: { cookie },
        });
        const runs = response.json<Array<Record<string, any>>>();
        return runs.find((run) => run.taskId === task.id)?.status ?? null;
      })
      .toBe("completed");

    const runsResponse = await app.inject({
      method: "GET",
      url: "/api/task-runs",
      headers: { cookie },
    });
    const internalRun = runsResponse.json<Array<Record<string, any>>>()
      .find((run) => run.taskId === task.id);
    expect(String(internalRun?.outputSummary ?? "")).toContain("Pulsarbot can summarize documents.");
    expect((internalRun?.relatedMemoryDocumentIds ?? []).length).toBeGreaterThan(0);
    expect(telegramMessages.some((message) =>
      message.text.includes("Document Digest") && message.text.includes("Completed")
    )).toBe(true);

    await app.close();
  });

  it("invalidates stale executor tokens after re-pairing", async () => {
    const { app, cookie } = await bootstrapApp();

    const createdExecutor = await app.inject({
      method: "POST",
      url: "/api/executors",
      headers: { cookie },
      payload: {
        label: "Rotating Companion",
        capabilities: ["http"],
      },
    });
    const executor = createdExecutor.json<Record<string, any>>();

    const firstPair = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/pair`,
      headers: { cookie },
    });
    const firstPairing = firstPair.json<Record<string, any>>();
    const firstHeartbeat = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: {
        pairingCode: firstPairing.pairingCode,
        version: "0.1.0",
        platform: "test",
        capabilities: ["http"],
      },
    });
    expect(firstHeartbeat.statusCode).toBe(200);
    const firstToken = String(firstHeartbeat.json<Record<string, any>>().executorToken ?? "");

    const secondPair = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/pair`,
      headers: { cookie },
    });
    expect(secondPair.statusCode).toBe(200);
    const secondPairing = secondPair.json<Record<string, any>>();

    const staleTokenHeartbeat = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: {
        executorToken: firstToken,
      },
    });
    expect(staleTokenHeartbeat.statusCode).toBe(401);

    const freshHeartbeat = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: {
        pairingCode: secondPairing.pairingCode,
        version: "0.1.0",
        platform: "test",
        capabilities: ["http"],
      },
    });
    expect(freshHeartbeat.statusCode).toBe(200);
    const secondToken = String(freshHeartbeat.json<Record<string, any>>().executorToken ?? "");
    expect(secondToken).toContain(`exec.${executor.id}.`);
    expect(secondToken).not.toBe(firstToken);

    await app.close();
  });

  it("rejects expired pairing codes", async () => {
    const { app, cookie } = await bootstrapApp();
    const appState = app as typeof app & {
      __pulsarbot?: {
        state?: {
          repository: {
            getExecutorNode: (id: string) => Promise<Record<string, any> | null>;
            saveExecutorNode: (executor: Record<string, any>) => Promise<void>;
          };
        };
      };
    };

    const createdExecutor = await app.inject({
      method: "POST",
      url: "/api/executors",
      headers: { cookie },
      payload: {
        label: "Expiring Companion",
        capabilities: ["http"],
      },
    });
    const executor = createdExecutor.json<Record<string, any>>();

    const pair = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/pair`,
      headers: { cookie },
    });
    const pairing = pair.json<Record<string, any>>();

    const executorRecord = await appState.__pulsarbot?.state?.repository.getExecutorNode(String(executor.id));
    expect(executorRecord).toBeTruthy();
    await appState.__pulsarbot!.state!.repository.saveExecutorNode({
      ...executorRecord,
      pairingIssuedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    });

    const expiredHeartbeat = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: {
        pairingCode: pairing.pairingCode,
        version: "0.1.0",
        platform: "test",
        capabilities: ["http"],
      },
    });
    expect(expiredHeartbeat.statusCode).toBe(401);
    expect(expiredHeartbeat.json<Record<string, any>>().error).toContain("expired");

    const updatedExecutor = await appState.__pulsarbot?.state?.repository.getExecutorNode(String(executor.id));
    expect(String(updatedExecutor?.status ?? "")).toBe("offline");
    expect(updatedExecutor?.pairingCodeHash).toBeNull();

    await app.close();
  });

  it("expires stale approvals and aborts waiting runs", async () => {
    const { app, cookie } = await bootstrapApp();
    const appState = app as typeof app & {
      __pulsarbot?: {
        state?: {
          repository: {
            getApprovalRequest: (id: string) => Promise<Record<string, any> | null>;
            saveApprovalRequest: (approval: Record<string, any>) => Promise<void>;
          };
        };
      };
    };

    const createdTask = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie },
      payload: {
        title: "Expiring Approval Task",
        goal: "Wait for approval and then expire.",
        templateKind: "document_digest_memory",
        status: "active",
        approvalPolicy: "approval_required",
        approvalCheckpoints: [],
        config: {
          documentId: "doc-nonexistent",
        },
      },
    });
    const task = createdTask.json<Record<string, any>>();

    const createdRun = await app.inject({
      method: "POST",
      url: "/api/task-runs",
      headers: { cookie },
      payload: {
        taskId: task.id,
      },
    });
    expect(createdRun.statusCode).toBe(200);
    const runPayload = createdRun.json<Record<string, any>>();
    expect(runPayload.taskRun.status).toBe("waiting_approval");
    expect(runPayload.approval.expiresAt).toMatch(/T/);

    const approvalRecord = await appState.__pulsarbot?.state?.repository.getApprovalRequest(
      String(runPayload.approval.id),
    );
    expect(approvalRecord).toBeTruthy();
    await appState.__pulsarbot!.state!.repository.saveApprovalRequest({
      ...approvalRecord,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await expect
      .poll(async () => {
        const response = await app.inject({
          method: "GET",
          url: `/api/approvals?taskRunId=${encodeURIComponent(String(runPayload.taskRun.id))}`,
          headers: { cookie },
        });
        const approvals = response.json<Array<Record<string, any>>>();
        return approvals[0]?.status ?? null;
      })
      .toBe("expired");

    await expect
      .poll(async () => {
        const response = await app.inject({
          method: "GET",
          url: "/api/task-runs",
          headers: { cookie },
        });
        return response
          .json<Array<Record<string, any>>>()
          .find((run) => run.id === runPayload.taskRun.id)?.status ?? null;
      })
      .toBe("aborted");

    const resolveExpired = await app.inject({
      method: "POST",
      url: "/api/approvals",
      headers: { cookie },
      payload: {
        approvalId: runPayload.approval.id,
        decision: "approved",
      },
    });
    expect(resolveExpired.statusCode).toBe(409);

    await app.close();
  });

  it("deduplicates repeated executor completion updates", async () => {
    const { app, cookie, telegramMessages } = await bootstrapApp();

    const createdExecutor = await app.inject({
      method: "POST",
      url: "/api/executors",
      headers: { cookie },
      payload: {
        label: "Idempotent Companion",
        capabilities: ["http"],
      },
    });
    const executor = createdExecutor.json<Record<string, any>>();

    const pair = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/pair`,
      headers: { cookie },
    });
    const pairing = pair.json<Record<string, any>>();
    const firstHeartbeat = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: {
        pairingCode: pairing.pairingCode,
        version: "0.1.0",
        platform: "test",
        capabilities: ["http"],
      },
    });
    const executorToken = String(firstHeartbeat.json<Record<string, any>>().executorToken ?? "");

    const createdTask = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie },
      payload: {
        title: "Idempotent Run",
        goal: "Complete once even when the companion retries.",
        templateKind: "web_watch_report",
        status: "active",
        defaultExecutorId: executor.id,
        approvalCheckpoints: [],
      },
    });
    const task = createdTask.json<Record<string, any>>();

    const createdRun = await app.inject({
      method: "POST",
      url: "/api/task-runs",
      headers: { cookie },
      payload: {
        taskId: task.id,
      },
    });
    expect(createdRun.statusCode).toBe(200);
    const taskRun = createdRun.json<Record<string, any>>().taskRun as Record<string, any>;

    const assignmentHeartbeat = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: {
        executorToken,
      },
    });
    const assignments = assignmentHeartbeat.json<Record<string, any>>().assignments as Array<Record<string, any>>;
    expect(assignments).toHaveLength(1);

    const completedPayload = {
      executorToken,
      completedRuns: [
        {
          taskRunId: assignments[0]?.id,
          status: "completed",
          outputSummary: "Only once",
        },
      ],
    };
    const firstCompletion = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: completedPayload,
    });
    expect(firstCompletion.statusCode).toBe(200);

    const duplicateCompletion = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: completedPayload,
    });
    expect(duplicateCompletion.statusCode).toBe(200);

    const events = await app.inject({
      method: "GET",
      url: `/api/system/turns/${encodeURIComponent(String(taskRun.sessionId))}/events`,
      headers: { cookie },
    });
    const completedEvents = events.json<Array<Record<string, any>>>().filter((event) =>
      event.eventType === "task_run_completed"
    );
    expect(completedEvents).toHaveLength(1);

    const completionMessages = telegramMessages.filter((message) =>
      message.text.includes(`Run: ${String(taskRun.id)}`) &&
      message.text.includes("Status: Completed")
    );
    expect(completionMessages).toHaveLength(1);

    await app.close();
  });

  it("reports waiting_retry runs instead of pretending they started", async () => {
    const { app, cookie, telegramMessages } = await bootstrapApp();

    const createdExecutor = await app.inject({
      method: "POST",
      url: "/api/executors",
      headers: { cookie },
      payload: {
        label: "Offline Companion",
        capabilities: ["http"],
      },
    });
    const executor = createdExecutor.json<Record<string, any>>();

    const createdTask = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie },
      payload: {
        title: "Offline Task",
        goal: "Needs an executor that is still offline.",
        templateKind: "web_watch_report",
        status: "active",
        defaultExecutorId: executor.id,
        approvalCheckpoints: [],
      },
    });
    const task = createdTask.json<Record<string, any>>();

    const createdRun = await app.inject({
      method: "POST",
      url: "/api/task-runs",
      headers: { cookie },
      payload: {
        taskId: task.id,
      },
    });
    expect(createdRun.statusCode).toBe(200);
    const taskRun = createdRun.json<Record<string, any>>().taskRun as Record<string, any>;
    expect(taskRun.status).toBe("waiting_retry");

    const events = await app.inject({
      method: "GET",
      url: `/api/system/turns/${encodeURIComponent(String(taskRun.sessionId))}/events`,
      headers: { cookie },
    });
    expect(events.statusCode).toBe(200);
    expect(events.json<Array<Record<string, any>>>().some((event) =>
      event.eventType === "task_run_waiting_retry"
    )).toBe(true);

    const runMessages = telegramMessages.filter((message) =>
      message.text.includes(`Run: ${String(taskRun.id)}`)
    );
    expect(runMessages.some((message) => message.text.includes("Status: Waiting Retry"))).toBe(true);
    expect(runMessages.some((message) => message.text.includes("Status: Started"))).toBe(false);

    await app.close();
  });

  it("exports webhook triggers without leaking plaintext secrets", async () => {
    const { app, cookie } = await bootstrapApp();

    const createdTask = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie },
      payload: {
        title: "Exported Webhook Task",
        goal: "Used to verify webhook secret export behavior.",
        templateKind: "web_watch_report",
        status: "active",
      },
    });
    const task = createdTask.json<Record<string, any>>();

    const createdTrigger = await app.inject({
      method: "POST",
      url: "/api/triggers",
      headers: { cookie },
      payload: {
        taskId: task.id,
        label: "Exported Webhook",
        kind: "webhook",
        enabled: true,
        webhookPath: "exported-webhook",
        webhookSecret: "top-secret-export",
      },
    });
    expect(createdTrigger.statusCode).toBe(200);
    const trigger = createdTrigger.json<Record<string, any>>();
    expect(trigger.webhookSecret).toBeNull();
    expect(String(trigger.webhookSecretRef ?? "")).toContain(`trigger:${String(trigger.id)}:webhook-secret`);

    const exported = await app.inject({
      method: "POST",
      url: "/api/settings/export",
      headers: { cookie },
      payload: {
        accessToken: "dev-access-token",
        exportPassphrase: "bundle-passphrase",
      },
    });
    expect(exported.statusCode).toBe(200);
    const bundle = exported.json<Record<string, any>>();
    const exportedTrigger = (bundle.triggers as Array<Record<string, any>>).find((item) =>
      item.id === trigger.id
    );
    expect(exportedTrigger?.webhookSecret).toBeNull();
    expect(String(exportedTrigger?.webhookSecretRef ?? "")).toContain(`trigger:${String(trigger.id)}:webhook-secret`);
    expect(JSON.stringify(bundle)).not.toContain("top-secret-export");
    expect((bundle.encryptedSecrets as Array<Record<string, any>>).some((secret) =>
      String(secret.scope ?? "") === String(exportedTrigger?.webhookSecretRef ?? "")
    )).toBe(true);

    await app.close();
  });

  it("validates trigger inputs for schedule and telegram shortcut automations", async () => {
    const { app, cookie } = await bootstrapApp();

    const createdTask = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie },
      payload: {
        title: "Trigger Host Task",
        goal: "Used for trigger validation.",
        templateKind: "web_watch_report",
        status: "active",
      },
    });
    const task = createdTask.json<Record<string, any>>();

    const missingTask = await app.inject({
      method: "POST",
      url: "/api/triggers",
      headers: { cookie },
      payload: {
        label: "No Task",
        kind: "schedule",
        enabled: true,
        config: {
          intervalMinutes: 5,
        },
      },
    });
    expect(missingTask.statusCode).toBe(400);

    const invalidSchedule = await app.inject({
      method: "POST",
      url: "/api/triggers",
      headers: { cookie },
      payload: {
        taskId: task.id,
        label: "Bad Schedule",
        kind: "schedule",
        enabled: true,
        config: {
          intervalMinutes: 0,
        },
      },
    });
    expect(invalidSchedule.statusCode).toBe(400);

    const invalidShortcut = await app.inject({
      method: "POST",
      url: "/api/triggers",
      headers: { cookie },
      payload: {
        taskId: task.id,
        label: "Bad Shortcut",
        kind: "telegram_shortcut",
        enabled: true,
        config: {
          command: "/weekly",
        },
      },
    });
    expect(invalidShortcut.statusCode).toBe(400);

    const digestShortcut = await app.inject({
      method: "POST",
      url: "/api/triggers",
      headers: { cookie },
      payload: {
        taskId: task.id,
        label: "Digest Shortcut",
        kind: "telegram_shortcut",
        enabled: true,
        config: {
          command: "/digest",
        },
      },
    });
    expect(digestShortcut.statusCode).toBe(200);
    expect(digestShortcut.json<Record<string, any>>().config.command).toBe("/digest");

    const firstWebhook = await app.inject({
      method: "POST",
      url: "/api/triggers",
      headers: { cookie },
      payload: {
        taskId: task.id,
        label: "Webhook A",
        kind: "webhook",
        enabled: true,
        webhookPath: "duplicate-path",
        webhookSecret: "secret-a",
      },
    });
    expect(firstWebhook.statusCode).toBe(200);

    const duplicateWebhook = await app.inject({
      method: "POST",
      url: "/api/triggers",
      headers: { cookie },
      payload: {
        taskId: task.id,
        label: "Webhook B",
        kind: "webhook",
        enabled: true,
        webhookPath: "duplicate-path",
        webhookSecret: "secret-b",
      },
    });
    expect(duplicateWebhook.statusCode).toBe(409);

    await app.close();
  });

  it("exports internal logs in json and text formats", async () => {
    const { app, cookie } = await bootstrapApp();

    const createdTask = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie },
      payload: {
        title: "Log Probe Task",
        goal: "Generate internal logs for export.",
        templateKind: "web_watch_report",
        status: "active",
      },
    });
    const task = createdTask.json<Record<string, any>>();

    const createdRun = await app.inject({
      method: "POST",
      url: "/api/task-runs",
      headers: { cookie },
      payload: {
        taskId: task.id,
      },
    });
    expect(createdRun.statusCode).toBe(200);

    const jsonLogs = await app.inject({
      method: "GET",
      url: "/api/system/internal-logs?format=json&limit=200",
      headers: { cookie },
    });
    expect(jsonLogs.statusCode).toBe(200);
    const jsonPayload = jsonLogs.json<Record<string, any>>();
    expect(Number(jsonPayload.retainedEntries ?? 0)).toBeGreaterThan(0);
    expect(
      (jsonPayload.entries as Array<Record<string, any>>).some((entry) =>
        String(entry.message ?? "").includes("task_run_staged")
      ),
    ).toBe(true);

    const textLogs = await app.inject({
      method: "GET",
      url: "/api/system/internal-logs?format=text&limit=200",
      headers: { cookie },
    });
    expect(textLogs.statusCode).toBe(200);
    expect(textLogs.headers["content-type"]).toContain("text/plain");
    expect(textLogs.body).toContain("task_run_staged");

    await app.close();
  });

  it("ingests companion execution logs through heartbeat", async () => {
    const { app, cookie } = await bootstrapApp();

    const createdExecutor = await app.inject({
      method: "POST",
      url: "/api/executors",
      headers: { cookie },
      payload: {
        label: "Logged Companion",
        capabilities: ["http"],
      },
    });
    const executor = createdExecutor.json<Record<string, any>>();

    const pair = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/pair`,
      headers: { cookie },
    });
    const pairing = pair.json<Record<string, any>>();

    const firstHeartbeat = await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: {
        pairingCode: pairing.pairingCode,
        version: "0.1.0",
        platform: "test",
        capabilities: ["http"],
      },
    });
    const executorToken = String(firstHeartbeat.json<Record<string, any>>().executorToken ?? "");

    const createdTask = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie },
      payload: {
        title: "Companion Log Probe",
        goal: "Receive companion log entries.",
        templateKind: "web_watch_report",
        status: "active",
        defaultExecutorId: executor.id,
        approvalCheckpoints: [],
      },
    });
    const task = createdTask.json<Record<string, any>>();

    const createdRun = await app.inject({
      method: "POST",
      url: "/api/task-runs",
      headers: { cookie },
      payload: {
        taskId: task.id,
      },
    });
    const taskRun = createdRun.json<Record<string, any>>().taskRun as Record<string, any>;

    await app.inject({
      method: "POST",
      url: `/api/executors/${executor.id}/heartbeat`,
      payload: {
        executorToken,
        completedRuns: [
          {
            taskRunId: taskRun.id,
            status: "completed",
            outputSummary: "done",
            logs: [
              {
                taskRunId: taskRun.id,
                scope: "assignment",
                level: "info",
                event: "http_request_started",
                message: "HTTP GET https://example.com",
                detail: {
                  method: "GET",
                  url: "https://example.com",
                },
                occurredAt: "2026-03-13T00:00:00.000Z",
              },
            ],
          },
        ],
      },
    });

    const events = await app.inject({
      method: "GET",
      url: `/api/system/turns/${encodeURIComponent(String(taskRun.sessionId))}/events`,
      headers: { cookie },
    });
    expect(events.statusCode).toBe(200);
    expect(events.json<Array<Record<string, any>>>().some((event) =>
      event.eventType === "executor_log" &&
      String((event.payload ?? {}).event ?? "") === "http_request_started"
    )).toBe(true);

    const internalLogs = await app.inject({
      method: "GET",
      url: "/api/system/internal-logs?format=text&limit=300",
      headers: { cookie },
    });
    expect(internalLogs.statusCode).toBe(200);
    expect(internalLogs.body).toContain("HTTP GET https://example.com");

    await app.close();
  });
});
