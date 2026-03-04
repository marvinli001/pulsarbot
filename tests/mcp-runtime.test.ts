import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpSupervisor } from "../packages/mcp/src/index.js";

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  pattern: RegExp,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${pattern}: ${stderr}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (pattern.test(stderr)) {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        resolve();
      }
    };

    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited early with code ${code}: ${stderr}`));
    });
  });
}

async function killChild(child: ChildProcessWithoutNullStreams) {
  if (child.killed || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

const children: ChildProcessWithoutNullStreams[] = [];
const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => killChild(child)));
  await Promise.all(
    createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("MCP supervisor", () => {
  it("discovers and invokes tools from a stdio MCP server", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "pulsarbot-mcp-logs-"));
    createdDirs.push(logDir);
    const supervisor = createMcpSupervisor({ logDir });
    const fixture = path.resolve(process.cwd(), "tests/fixtures/mcp-echo-stdio.mjs");
    const config = {
      id: "stdio-echo",
      label: "stdio echo",
      description: "",
      transport: "stdio" as const,
      command: process.execPath,
      args: [fixture],
      envRefs: {},
      headers: {},
      enabled: true,
      source: "custom" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const health = await supervisor.healthcheck(config);
    expect(health.status).toBe("ok");
    expect(health.toolCount).toBeGreaterThanOrEqual(1);

    const tools = await supervisor.listToolDescriptors([config]);
    expect(tools.map((tool) => tool.id)).toContain("mcp:stdio-echo:echo");

    const result = await supervisor.invokeTool(
      "mcp:stdio-echo:echo",
      { text: "hello" },
      [config],
    );

    expect(result).toMatchObject({
      text: "echo:hello",
    });

    const logs = await supervisor.readServerLogs("stdio-echo");
    expect(logs.some((line) => line.includes("connected transport=stdio"))).toBe(true);

    const persisted = await readFile(path.join(logDir, "stdio-echo.log"), "utf8");
    expect(persisted).toContain("connected transport=stdio");

    await supervisor.closeAll();
  });

  it("discovers and invokes tools from a streamable HTTP MCP server", async () => {
    const supervisor = createMcpSupervisor();
    const fixture = path.resolve(process.cwd(), "tests/fixtures/mcp-echo-http.mjs");
    const port = 3899;
    const child = spawn(process.execPath, [fixture], {
      env: {
        ...process.env,
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await waitForOutput(child, /http-ready:3899/);

    const config = {
      id: "http-echo",
      label: "http echo",
      description: "",
      transport: "streamable_http" as const,
      url: `http://127.0.0.1:${port}/mcp`,
      args: [],
      envRefs: {},
      headers: {},
      enabled: true,
      source: "custom" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const health = await supervisor.healthcheck(config);
    expect(health.status).toBe("ok");
    expect(health.toolCount).toBeGreaterThanOrEqual(1);

    const tools = await supervisor.listToolDescriptors([config]);
    expect(tools.map((tool) => tool.id)).toContain("mcp:http-echo:echo");

    const result = await supervisor.invokeTool(
      "mcp:http-echo:echo",
      { text: "world" },
      [config],
    );

    expect(result).toMatchObject({
      text: "echo:world",
    });

    await supervisor.closeAll();
  });
});
