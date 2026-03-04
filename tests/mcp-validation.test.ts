import { describe, expect, it } from "vitest";
import { createMcpSupervisor } from "../packages/mcp/src/index.js";

describe("MCP supervisor", () => {
  it("rejects invalid stdio configs", async () => {
    const supervisor = createMcpSupervisor();

    await expect(
      supervisor.validate({
        id: "mcp_1",
        label: "Broken stdio",
        description: "",
        transport: "stdio",
        args: [],
        envRefs: {},
        headers: {},
        enabled: false,
        source: "custom",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/requires a command/);
  });

  it("accepts streamable http configs", async () => {
    const supervisor = createMcpSupervisor();

    await expect(
      supervisor.validate({
        id: "mcp_2",
        label: "HTTP MCP",
        description: "",
        transport: "streamable_http",
        url: "https://example.com/mcp",
        args: [],
        envRefs: {},
        headers: {},
        enabled: true,
        source: "custom",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      id: "mcp_2",
      transport: "streamable_http",
    });
  });
});
