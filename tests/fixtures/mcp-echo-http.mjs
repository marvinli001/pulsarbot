#!/usr/bin/env node
import http from "node:http";
import { McpServer } from "../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { StreamableHTTPServerTransport } from "../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js";
import * as z from "../../packages/shared/node_modules/zod/v4/index.js";

function createServerInstance() {
  const server = new McpServer({
    name: "pulsarbot-echo-http",
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

  return server;
}

const port = Number(process.env.PORT ?? "3899");

const httpServer = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/mcp")) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      }),
    );
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }

  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    raw += chunk;
  });

  req.on("end", async () => {
    const mcpServer = createServerInstance();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : "Internal error",
            },
            id: null,
          }),
        );
      }
    } finally {
      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
    }
  });
});

httpServer.listen(port, () => {
  console.error(`http-ready:${port}`);
});

process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});
