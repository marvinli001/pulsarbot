#!/usr/bin/env node
import http from "node:http";
import { McpServer } from "../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { SSEServerTransport } from "../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/sse.js";
import * as z from "../../packages/shared/node_modules/zod/v4/index.js";

function createServerInstance() {
  const server = new McpServer({
    name: "pulsarbot-echo-bailian-sse",
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

const port = Number(process.env.PORT ?? "3900");
const sessions = new Map();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/api/v1/mcps/tavily-ai/mcp") {
    res.statusCode = 400;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("current mcp not support streamableHttp");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/v1/mcps/tavily-ai/sse") {
    const server = createServerInstance();
    const transport = new SSEServerTransport("/api/v1/mcps/tavily-ai/messages", res);
    const sessionId = transport.sessionId;
    sessions.set(sessionId, { server, transport });
    transport.onclose = () => {
      sessions.delete(sessionId);
      void server.close();
    };

    try {
      await server.connect(transport);
      return;
    } catch (error) {
      sessions.delete(sessionId);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(error instanceof Error ? error.message : "SSE connect failed");
      }
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/v1/mcps/tavily-ai/messages") {
    const sessionId = url.searchParams.get("sessionId");
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) {
      res.statusCode = 404;
      res.end("Session not found");
      return;
    }

    try {
      await session.transport.handlePostMessage(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(error instanceof Error ? error.message : "Message handling failed");
      }
    }
    return;
  }

  res.statusCode = 404;
  res.end("Not found");
});

httpServer.listen(port, () => {
  console.error(`sse-fallback-ready:${port}`);
});

process.on("SIGTERM", () => {
  for (const session of sessions.values()) {
    void session.transport.close();
    void session.server.close();
  }
  sessions.clear();
  httpServer.close(() => process.exit(0));
});
