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

try {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);

  await app.listen({
    host: "0.0.0.0",
    port,
  });
} catch (error) {
  printStartupError(error);
  process.exit(1);
}
