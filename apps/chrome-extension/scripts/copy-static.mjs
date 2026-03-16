import { cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const staticDir = path.join(rootDir, "static");

await mkdir(distDir, { recursive: true });
await cp(staticDir, distDir, { recursive: true });
await rm(path.join(distDir, "content-script.js"), { force: true });
await rename(
  path.join(distDir, "content-script.global.js"),
  path.join(distDir, "content-script.js"),
);
