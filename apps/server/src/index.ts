import { createApp } from "./app.js";

function printStartupError(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray((error as { issues?: unknown[] }).issues)
  ) {
    const issues = (error as { issues: Array<{ path?: unknown[]; message?: unknown }> }).issues;
    const details = issues
      .map((issue) => {
        const key = Array.isArray(issue.path) && issue.path.length
          ? issue.path.join(".")
          : "unknown";
        const message = typeof issue.message === "string" ? issue.message : "invalid value";
        return `  - ${key}: ${message}`;
      })
      .join("\n");
    console.error("Server failed to start due to invalid environment variables:\n" + details);
    return;
  }
  console.error("Server failed to start:", error);
}

function installShutdownHandlers(app: Awaited<ReturnType<typeof createApp>>) {
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.warn(`[server] Received ${signal}, shutting down gracefully...`);
    try {
      await app.close();
      console.warn("[server] Shutdown complete.");
      process.exit(0);
    } catch (error) {
      console.error("[server] Shutdown failed:", error);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

try {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  installShutdownHandlers(app);

  await app.listen({
    host: "0.0.0.0",
    port,
  });
} catch (error) {
  printStartupError(error);
  process.exit(1);
}
