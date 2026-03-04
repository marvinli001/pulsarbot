import { defineConfig } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? "3310");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    viewport: {
      width: 390,
      height: 844,
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `tsx tests/e2e/server.ts`,
    url: `${baseURL}/miniapp/`,
    reuseExistingServer: !process.env.CI,
    timeout: 45_000,
    env: {
      PLAYWRIGHT_PORT: String(port),
    },
  },
});
