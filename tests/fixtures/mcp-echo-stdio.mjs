#!/usr/bin/env node
import { McpServer } from "../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { StdioServerTransport } from "../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
import * as z from "../../packages/shared/node_modules/zod/v4/index.js";

const server = new McpServer({
  name: "pulsarbot-echo-stdio",
  version: "1.0.0",
});

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Return the provided text.",
    inputSchema: {
      text: z.string(),
    },
  },
  async ({ text }) => ({
    content: [
      {
        type: "text",
        text: `echo:${text}`,
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("stdio-ready");
