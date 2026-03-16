import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CloudflareCredentials, ProviderProfile } from "../../packages/shared/src/index.js";
import type {
  ProviderInvocationInput,
  ProviderInvocationResult,
  ProviderMediaInvocationInput,
} from "../../packages/providers/src/index.js";
import { createApp } from "../../apps/server/src/app.js";

const fakeObjects = new Map<string, Uint8Array>();
const fakeVectors = new Map<
  string,
  Map<string, { values: number[]; metadata?: Record<string, unknown> }>
>();

function keyForObject(bucketName: string, objectKey: string) {
  return `${bucketName}:${objectKey}`;
}

function toStoredBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === "string"
    ? Uint8Array.from(Buffer.from(body, "utf8"))
    : body;
}

function scoreVectors(a: number[], b: number[]) {
  const size = Math.min(a.length, b.length);
  let total = 0;
  for (let index = 0; index < size; index += 1) {
    total += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return total;
}

class FakeCloudflareClient {
  public constructor(public readonly credentials: CloudflareCredentials) {}

  public async verifyCredentials() {
    return true;
  }

  public async listD1Databases() {
    return [{ uuid: "existing-d1", name: "pulsarbot-existing" }];
  }

  public async listR2Buckets() {
    return [{ name: "pulsarbot-existing-r2" }];
  }

  public async listVectorizeIndexes() {
    return [{ name: "pulsarbot-existing-vectorize" }];
  }

  public async listAiSearchIndexes() {
    return [{ name: "pulsarbot-existing-ai-search" }];
  }

  public async initializeWorkspaceResources(args: {
    selection?: Record<string, string>;
    workspaceId: string;
  }) {
    return {
      d1DatabaseId: args.selection?.d1DatabaseId ?? `${args.workspaceId}-d1`,
      r2BucketName: args.selection?.r2BucketName ?? `${args.workspaceId}-r2`,
      vectorizeIndexName:
        args.selection?.vectorizeIndexName ?? `${args.workspaceId}-vectorize`,
      aiSearchIndexName:
        args.selection?.aiSearchIndexName ?? `${args.workspaceId}-ai-search`,
    };
  }

  public async executeD1() {
    return { success: true };
  }

  public async queryD1() {
    return [];
  }

  public async putR2Object(args: {
    bucketName: string;
    key: string;
    body: string | Uint8Array;
  }) {
    fakeObjects.set(keyForObject(args.bucketName, args.key), toStoredBytes(args.body));
  }

  public async getR2Object(args: { bucketName: string; key: string }) {
    const body = fakeObjects.get(keyForObject(args.bucketName, args.key));
    return body ? Buffer.from(body).toString("utf8") : null;
  }

  public async getR2ObjectRaw(args: { bucketName: string; key: string }) {
    const body = fakeObjects.get(keyForObject(args.bucketName, args.key));
    if (!body) {
      return null;
    }
    return {
      body,
      contentType: "application/octet-stream",
    };
  }

  public async listR2Objects(args: { bucketName: string; prefix?: string }) {
    const prefix = keyForObject(args.bucketName, args.prefix ?? "");
    return [...fakeObjects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({
        key: key.replace(`${args.bucketName}:`, ""),
      }));
  }

  public async deleteR2Objects(args: { bucketName: string; keys: string[] }) {
    for (const key of args.keys) {
      fakeObjects.delete(keyForObject(args.bucketName, key));
    }
  }

  public async upsertVectors(args: {
    indexName: string;
    vectors: Array<{
      id: string;
      values: number[];
      metadata?: Record<string, unknown>;
    }>;
  }) {
    const index = fakeVectors.get(args.indexName) ?? new Map();
    for (const vector of args.vectors) {
      index.set(vector.id, {
        values: vector.values,
        metadata: vector.metadata,
      });
    }
    fakeVectors.set(args.indexName, index);
  }

  public async queryVectors(args: {
    indexName: string;
    vector: number[];
    topK?: number;
    returnMetadata?: boolean;
  }) {
    const index = fakeVectors.get(args.indexName) ?? new Map();
    return [...index.entries()]
      .map(([id, entry]) => ({
        id,
        score: scoreVectors(args.vector, entry.values),
        metadata: args.returnMetadata ? entry.metadata : undefined,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, args.topK ?? 5);
  }

  public async deleteVectors(args: { indexName: string; ids: string[] }) {
    const index = fakeVectors.get(args.indexName);
    if (!index) {
      return;
    }
    for (const id of args.ids) {
      index.delete(id);
    }
  }

  public async searchAiSearch() {
    return [];
  }
}

async function fakeProviderInvoker(args: {
  profile: ProviderProfile;
  apiKey: string;
  input: ProviderInvocationInput;
}): Promise<ProviderInvocationResult> {
  void args.profile;
  void args.apiKey;
  const system = args.input.messages.find((message) => message.role === "system")?.content ?? "";
  const user = args.input.messages.find((message) => message.role === "user")?.content ?? "";

  if (system.includes("Return strict JSON")) {
    return {
      text: JSON.stringify({
        finalResponse: user ? `Echo: ${user}` : "OK",
        toolCalls: [],
      }),
      raw: {},
    };
  }

  return {
    text: user ? `Echo: ${user}` : "OK",
    raw: {},
  };
}

async function fakeProviderMediaInvoker(args: {
  profile: ProviderProfile;
  apiKey: string;
  input: ProviderMediaInvocationInput;
}): Promise<ProviderInvocationResult | null> {
  void args.profile;
  void args.apiKey;
  return {
    text: `${args.input.kind.toUpperCase()} OK`,
    raw: {},
  };
}

function fakeTelegramFactory() {
  return {
    handler: async (_request: unknown, reply: { send: (payload: unknown) => unknown }) =>
      reply.send({ ok: true }),
    describeWebhookState: () => ({
      updatedAt: new Date().toISOString(),
      status: "ready" as const,
      lastUpdateType: null,
      lastChatId: null,
    }),
  };
}

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pulsarbot-e2e-"));
  const port = Number(process.env.PLAYWRIGHT_PORT ?? "3310");

  process.env.NODE_ENV = "test";
  process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
  process.env.PULSARBOT_ACCESS_TOKEN = "dev-access-token";
  process.env.DATA_DIR = dataDir;
  process.env.PORT = String(port);

  const app = await createApp({
    env: {
      NODE_ENV: "test",
      TELEGRAM_BOT_TOKEN: "123456:TESTTOKEN",
      PULSARBOT_ACCESS_TOKEN: "dev-access-token",
      DATA_DIR: dataDir,
      PORT: port,
    },
    cloudflareClientFactory: (credentials) =>
      new FakeCloudflareClient(credentials) as never,
    providerInvoker: fakeProviderInvoker,
    providerMediaInvoker: fakeProviderMediaInvoker,
    telegramFactory: fakeTelegramFactory as never,
  });

  app.get("/e2e/browser-target", async (_request, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Pulsarbot Browser Target</title>
    <style>
      body { font-family: sans-serif; margin: 24px; }
      main { display: grid; gap: 12px; max-width: 520px; }
      button, input { font: inherit; padding: 10px 12px; }
      button { cursor: pointer; }
      .card { border: 1px solid #cbd5e1; border-radius: 16px; padding: 16px; }
      .spacer { height: 1200px; }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <h1 id="headline">Pulsarbot Browser Target</h1>
        <p id="status-text">Idle</p>
        <form id="name-form">
          <input id="name-input" placeholder="Type here" />
          <button id="primary-action" type="submit">Submit via form</button>
        </form>
        <div id="result" data-state="waiting">Waiting</div>
      </div>
      <div class="spacer"></div>
      <div class="card">
        <p id="pointer-status">Idle</p>
        <button id="pointer-action" type="button">Pointer Action</button>
        <div id="pointer-result" data-state="waiting">Waiting</div>
      </div>
    </main>
    <script>
      const statusText = document.getElementById("status-text");
      const input = document.getElementById("name-input");
      const result = document.getElementById("result");
      const form = document.getElementById("name-form");
      const pointerStatus = document.getElementById("pointer-status");
      const pointerResult = document.getElementById("pointer-result");
      const pointerAction = document.getElementById("pointer-action");
      let sawPointerDown = false;
      let sawMouseDown = false;
      let sawPointerUp = false;
      let sawMouseUp = false;

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        statusText.textContent = "Submitted";
        result.dataset.state = "submitted";
        result.textContent = "Hello " + (input.value || "anonymous");
      });

      pointerAction.addEventListener("pointerdown", () => {
        sawPointerDown = true;
      });
      pointerAction.addEventListener("mousedown", () => {
        sawMouseDown = true;
      });
      pointerAction.addEventListener("pointerup", () => {
        sawPointerUp = true;
      });
      pointerAction.addEventListener("mouseup", () => {
        sawMouseUp = true;
      });
      pointerAction.addEventListener("click", () => {
        const pointerReady = sawMouseDown && sawMouseUp;
        pointerStatus.textContent = pointerReady
          ? "Pointer ready"
          : "Missing pointer sequence";
        pointerResult.dataset.state = pointerReady ? "clicked" : "missing-pointer";
        pointerResult.textContent = pointerReady
          ? "Pointer click completed"
          : "Pointer sequence missing";
      });
    </script>
  </body>
</html>`),
  );

  const closeServer = async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  };

  process.once("SIGINT", () => {
    void closeServer().finally(() => process.exit(0));
  });

  process.once("SIGTERM", () => {
    void closeServer().finally(() => process.exit(0));
  });

  await app.listen({
    port,
    host: "127.0.0.1",
  });

  console.log(`Playwright E2E server ready at http://127.0.0.1:${port}/miniapp/`);
}

void main();
