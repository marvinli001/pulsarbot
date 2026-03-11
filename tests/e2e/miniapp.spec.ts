import {
  expect,
  test,
  type Page,
} from "@playwright/test";

async function readBootstrapState(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/workspace", {
      credentials: "include",
    });
    return response.json();
  });
}

async function enableDefaultRuntimeDependencies(page: Page) {
  return page.evaluate(async () => {
    const targets = [
      ["skills", "core-agent"],
      ["skills", "memory-core"],
      ["plugins", "time-context"],
      ["plugins", "native-google-search"],
      ["plugins", "native-bing-search"],
      ["plugins", "web-browse-fetcher"],
      ["plugins", "document-processor"],
    ] as const;

    return Promise.all(targets.map(async ([kind, manifestId]) => {
      const response = await fetch(`/api/market/${kind}/${manifestId}/enable`, {
        method: "POST",
        credentials: "include",
      });
      return response.status;
    }));
  });
}

test.describe("Mini App", () => {
  test("bootstraps the workspace and previews the runtime on mobile", async ({ page }) => {
    await page.goto("/miniapp/");

    await expect(
      page.getByRole("heading", { name: "Workspace Bootstrap" }),
    ).toBeVisible();

    await page.getByPlaceholder("PULSARBOT_ACCESS_TOKEN").fill("dev-access-token");
    await page.getByRole("button", { name: "Verify Access Token" }).click();
    await expect
      .poll(async () => {
        const workspace = await readBootstrapState(page);
        return Boolean(workspace.bootstrapState?.verified);
      })
      .toBe(true);

    await page.getByRole("button", { name: "Bind Current Telegram User as Owner" }).click();
    await expect
      .poll(async () => {
        const workspace = await readBootstrapState(page);
        return Boolean(workspace.bootstrapState?.ownerBound);
      })
      .toBe(true);

    await page.getByRole("button", { name: "API Token" }).click();
    await page.getByPlaceholder("Cloudflare Account ID").fill("test-account");
    await page.getByPlaceholder("Cloudflare API Token").fill("test-token");
    await page.getByPlaceholder("R2 Access Key ID (recommended)").fill("local-key");
    await page
      .getByPlaceholder("R2 Secret Access Key (recommended)")
      .fill("local-secret");
    await page.getByRole("button", { name: "Connect Cloudflare" }).click();
    await expect
      .poll(async () => {
        const workspace = await readBootstrapState(page);
        return Boolean(workspace.bootstrapState?.cloudflareConnected);
      })
      .toBe(true);
    await expect(page.getByText("Resources synced")).toBeVisible();

    await page.getByRole("button", { name: "Initialize New Workspace" }).click();
    await expect
      .poll(async () => {
        const workspace = await readBootstrapState(page);
        return Boolean(workspace.bootstrapState?.resourcesInitialized);
      })
      .toBe(true);

    await page.getByRole("button", { name: "Providers" }).click();
    await expect(
      page.getByRole("heading", { name: "Configured Providers" }),
    ).toBeVisible();
    await page
      .getByPlaceholder("API key")
      .fill("test-provider-key");
    await page
      .getByPlaceholder("Access token confirmation")
      .fill("dev-access-token");
    await page.getByRole("button", { name: "Create Provider" }).click();
    await expect(page.getByText("Provider Saved")).toBeVisible();
    await expect(page.getByRole("button", { name: "Text" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Text" }).first().click();
    await expect(page.getByText("All Passed")).toBeVisible();

    expect(await enableDefaultRuntimeDependencies(page)).toEqual([
      200,
      200,
      200,
      200,
      200,
      200,
      200,
    ]);

    await page.getByRole("button", { name: "Profiles" }).click();
    await expect(page.getByRole("heading", { name: "Agent Profiles" })).toBeVisible();
    await page.getByRole("button", { name: "Create Profile" }).click();
    await expect(page.getByText("Profile Saved")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Runtime Preview" })).toBeVisible();
    await expect(page.locator("pre").last()).toContainText("generatedAt");
  });
});
