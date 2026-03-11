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

async function openSection(page: Page, section: string, heading: string) {
  await page.getByRole("button", { name: section }).click();
  await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
}

async function cardByTitle(page: Page, title: string) {
  const card = page.locator("div.rounded-2xl").filter({ hasText: title }).first();
  await card.scrollIntoViewIfNeeded();
  return card;
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

    await openSection(page, "Skills", "Skills Market");
    await expect(await cardByTitle(page, "Core Agent")).toContainText("Installed");
    await expect(await cardByTitle(page, "Web Browse")).toBeVisible();

    await openSection(page, "Plugins", "Plugins Market");
    await expect(await cardByTitle(page, "Time Context")).toContainText("Installed");
    await expect(await cardByTitle(page, "Export / Import")).toBeVisible();

    await openSection(page, "MCP Market", "MCP Market");
    const genericMcpCard = await cardByTitle(page, "Generic stdio Template");
    await expect(genericMcpCard.getByText(/^Installed$/)).toBeVisible();
    await expect(genericMcpCard.getByText(/^Disabled$/)).toBeVisible();
    await genericMcpCard.getByRole("button", { name: "Enable" }).click();
    await expect(genericMcpCard.getByText(/^Installed$/)).toBeVisible();
    await expect(genericMcpCard.getByText(/^Enabled$/)).toBeVisible();

    await openSection(page, "MCP Servers", "Configured MCP Servers");
    await expect(page.getByText("Generic stdio Template")).toBeVisible();
    await page.getByRole("button", { name: "Load" }).first().click();
    await expect(page.getByRole("heading", { name: "Edit MCP Server" })).toBeVisible();

    await openSection(page, "Import/Export", "Import / Export");
    await page.getByPlaceholder("Current access token").fill("dev-access-token");
    await page.getByPlaceholder("Export passphrase").fill("bundle-passphrase");
    await page.getByRole("button", { name: "Export Bundle" }).click();
    await expect(page.getByText("Bundle Exported")).toBeVisible();

    const bundleArea = page.locator("textarea").first();
    const exportedBundle = JSON.parse(await bundleArea.inputValue()) as Record<string, any>;
    const now = new Date().toISOString();
    const documentId = "doc-e2e-note";
    const sourcePath = `documents/${documentId}/source/notes.txt`;
    exportedBundle.documents = [
      ...(Array.isArray(exportedBundle.documents) ? exportedBundle.documents : []),
      {
        id: documentId,
        workspaceId: String(exportedBundle.workspace?.id ?? "main"),
        sourceType: "import",
        kind: "text",
        title: "notes.txt",
        path: sourcePath,
        derivedTextPath: `documents/${documentId}/derived/content.md`,
        sourceObjectKey: null,
        derivedTextObjectKey: null,
        previewText: "Playwright seeded note",
        fileId: null,
        sizeBytes: 24,
        mimeType: "text/plain",
        extractionStatus: "completed",
        extractionProviderProfileId: null,
        lastExtractionError: null,
        lastIndexedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ];
    exportedBundle.documentArtifacts = [
      ...(Array.isArray(exportedBundle.documentArtifacts) ? exportedBundle.documentArtifacts : []),
      {
        documentId,
        path: sourcePath,
        contentBase64: Buffer.from("Playwright seeded note", "utf8").toString("base64"),
        contentType: "text/plain",
      },
    ];
    await bundleArea.fill(JSON.stringify(exportedBundle, null, 2));
    await page.getByPlaceholder("Import passphrase").fill("bundle-passphrase");
    await page.getByRole("button", { name: "Import Bundle" }).click();
    await expect(page.getByText("Bundle Imported")).toBeVisible();

    await openSection(page, "Providers", "Configured Providers");
    await page.getByRole("button", { name: "Text" }).first().click();
    await expect(page.getByText("All Passed")).toBeVisible();

    await openSection(page, "Documents", "Documents");
    await expect(page.getByText("notes.txt")).toBeVisible();
    await page.getByRole("button", { name: "Inspect" }).first().click();
    await expect(page.getByRole("heading", { name: "Selected Document" })).toBeVisible();
    await expect(page.locator("pre").last()).toContainText("doc-e2e-note");
    await page.getByRole("button", { name: "Reindex" }).first().click();
    await expect(page.getByText("Reindexed")).toBeVisible();

    await openSection(page, "Logs", "Logs Overview");
    await expect(page.getByRole("heading", { name: "Recent Jobs" })).toBeVisible();
    await expect(page.getByText(/memory_reindex_document · /).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent Provider Tests" })).toBeVisible();

    await openSection(page, "Health", "System Health Overview");
    await expect(page.getByRole("heading", { name: "Cloudflare Dependencies" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Telegram Webhook" })).toBeVisible();
    await expect(page.locator("pre").last()).toContainText("\"providerProfiles\": 1");
  });
});
