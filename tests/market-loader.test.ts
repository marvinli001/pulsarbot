import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefaultInstallRecords,
  loadMarketCatalog,
} from "../packages/market/src/index.js";

describe("market catalog", () => {
  it("loads official manifests from the repository", async () => {
    const catalog = await loadMarketCatalog(path.resolve(process.cwd(), "market"));

    expect(catalog.skills.length).toBeGreaterThanOrEqual(6);
    expect(catalog.plugins.length).toBeGreaterThanOrEqual(6);
    expect(catalog.mcp.length).toBeGreaterThanOrEqual(7);
  });

  it("creates default install states", async () => {
    const catalog = await loadMarketCatalog(path.resolve(process.cwd(), "market"));
    const installs = createDefaultInstallRecords(catalog);

    expect(installs.some((item) => item.manifestId === "core-agent" && item.enabled)).toBe(true);
    expect(installs.some((item) => item.manifestId === "time-context" && item.enabled)).toBe(true);
  });
});
