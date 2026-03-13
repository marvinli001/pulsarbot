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

async function waitForTaskRunStatus(page: Page, taskTitle: string, status: string) {
  return expect
    .poll(async () => page.evaluate(async ({ title }) => {
      const [tasksResponse, runsResponse] = await Promise.all([
        fetch("/api/tasks", { credentials: "include" }),
        fetch("/api/task-runs", { credentials: "include" }),
      ]);
      const tasks = await tasksResponse.json() as Array<Record<string, unknown>>;
      const runs = await runsResponse.json() as Array<Record<string, unknown>>;
      const taskId = tasks.find((task) => String(task.title ?? "") === title)?.id;
      if (!taskId) {
        return null;
      }
      return runs.find((run) => String(run.taskId ?? "") === String(taskId))?.status ?? null;
    }, { title: taskTitle }), {
      message: `Expected task "${taskTitle}" to reach status "${status}"`,
    })
    .toBe(status);
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

async function ensureMarketItemEnabled(page: Page, title: string) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const enabled = await page.evaluate((targetTitle) => {
      const cards = [...document.querySelectorAll("div.rounded-2xl")];
      const card = cards.find((element) => element.textContent?.includes(targetTitle));
      if (!card) {
        return false;
      }
      return [...card.querySelectorAll("*")]
        .some((element) => element.textContent?.trim() === "Enabled");
    }, title);
    if (enabled) {
      return;
    }
    await page.evaluate((targetTitle) => {
      const cards = [...document.querySelectorAll("div.rounded-2xl")];
      const card = cards.find((element) => element.textContent?.includes(targetTitle));
      if (!card) {
        return;
      }
      const button = [...card.querySelectorAll("button")].find((element) => {
        const label = element.textContent?.trim();
        return label === "Install" || label === "Enable";
      }) as HTMLButtonElement | undefined;
      button?.click();
    }, title);
    await page.waitForTimeout(150);
  }
  await expect.poll(async () => page.evaluate((targetTitle) => {
    const cards = [...document.querySelectorAll("div.rounded-2xl")];
    const card = cards.find((element) => element.textContent?.includes(targetTitle));
    if (!card) {
      return false;
    }
    return [...card.querySelectorAll("*")]
      .some((element) => element.textContent?.trim() === "Enabled");
  }, title)).toBe(true);
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
      .getByRole("textbox", { name: "API key", exact: true })
      .fill("test-provider-key");
    await page
      .getByPlaceholder("Access token confirmation for saving new API key")
      .fill("dev-access-token");
    await page.getByRole("button", { name: "Test Draft Connection" }).click();
    await expect(page.getByText("Draft validated")).toBeVisible();
    await page.getByRole("button", { name: "Create Provider" }).click();
    await expect(page.getByText("Provider Saved")).toBeVisible();
    await expect(page.getByRole("button", { name: "Text" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Text" }).first().click();
    await expect(page.getByText("All Passed")).toBeVisible();

    await openSection(page, "Skills", "Skills Market");
    await ensureMarketItemEnabled(page, "Core Agent");
    await ensureMarketItemEnabled(page, "Memory Core");
    await expect(await cardByTitle(page, "Web Browse")).toBeVisible();

    await openSection(page, "Plugins", "Plugins Market");
    await ensureMarketItemEnabled(page, "Time Context");
    await ensureMarketItemEnabled(page, "Google Search");
    await ensureMarketItemEnabled(page, "Bing Search");
    await ensureMarketItemEnabled(page, "Web Browse Fetcher");
    await ensureMarketItemEnabled(page, "Document Processor");
    await expect(await cardByTitle(page, "Export / Import")).toBeVisible();

    await page.getByRole("button", { name: "Profiles" }).click();
    await expect(page.getByRole("heading", { name: "Agent Profiles" })).toBeVisible();
    await page.getByRole("button", { name: "Create Profile" }).click();
    await expect(page.getByText("Profile Saved")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Runtime Preview", exact: true })).toBeVisible();
    await expect(page.getByText("Enabled Tool Snapshot").first()).toBeVisible();
    await expect(page.getByText("Blocked Capabilities").first()).toBeVisible();
    await expect(page.getByText("No blocked capabilities.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Runtime Preview (Raw JSON)" })).toBeVisible();

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
    await expect(page.getByRole("heading", { name: "MCP Wizard" })).toBeVisible();

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
        derivedTextObjectKey: `workspace/${String(exportedBundle.workspace?.id ?? "main")}/documents/${documentId}/derived/content.md`,
        previewText: "Playwright seeded note",
        fileId: null,
        sizeBytes: 24,
        mimeType: "text/plain",
        extractionStatus: "completed",
        extractionMethod: "decode_text",
        extractionProviderProfileId: null,
        lastExtractionError: null,
        lastExtractedAt: now,
        lastIndexedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ];
    exportedBundle.memories = [
      ...(Array.isArray(exportedBundle.memories) ? exportedBundle.memories : []),
      {
        id: "memorydoc-playwright",
        workspaceId: String(exportedBundle.workspace?.id ?? "main"),
        kind: "longterm",
        path: "memory/MEMORY.md",
        title: "MEMORY.md",
        content: "# MEMORY\n- imported by playwright",
        contentHash: "playwright",
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
      {
        documentId,
        path: `documents/${documentId}/derived/content.md`,
        contentBase64: Buffer.from("Playwright seeded note", "utf8").toString("base64"),
        contentType: "text/markdown",
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
    await expect(page.getByText("Derived Text")).toBeVisible();
    await expect(page.locator("textarea").nth(1)).toHaveValue(/Playwright seeded note/);

    await openSection(page, "Memory", "Memory Layer");
    await expect(page.getByRole("heading", { name: "Memory Documents" })).toBeVisible();
    await page.getByText("MEMORY.md").first().click();
    const memoryEditor = page.locator("textarea").first();
    await memoryEditor.fill("# MEMORY\n- playwright updated");
    await page.getByRole("button", { name: "Save Memory Content" }).click();
    await expect(page.getByText("Saved")).toBeVisible();

    const executorLabel = "Playwright Executor";
    await openSection(page, "Executors", "Executors");
    await page.getByPlaceholder("Executor label").fill(executorLabel);
    await page.getByRole("button", { name: "Create Executor" }).click();
    await expect(page.getByText("Executor Saved")).toBeVisible();
    const executorCard = await cardByTitle(page, executorLabel);
    await executorCard.getByRole("button", { name: "Pair" }).click();
    await expect(page.locator("textarea").first()).toHaveValue(/pair\./);

    const taskTitle = "Playwright Digest Task";
    await openSection(page, "Tasks", "Tasks");
    await page.getByPlaceholder("Task title").fill(taskTitle);
    await page
      .getByPlaceholder("What should this task accomplish?")
      .fill("Summarize the imported E2E document and surface it in Sessions.");
    const taskEditor = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Create Task" }),
    }).first();
    await taskEditor.locator("select").nth(0).selectOption("document_digest_memory");
    await expect(page.getByPlaceholder("doc_xxx")).toBeVisible();
    await page.getByPlaceholder("doc_xxx").fill(documentId);
    await taskEditor.locator("select").nth(3).selectOption("active");
    await page.getByRole("button", { name: "Create Task" }).click();
    await expect(page.getByText("Task Saved")).toBeVisible();
    const taskCard = await cardByTitle(page, taskTitle);
    await taskCard.getByRole("button", { name: "Run" }).click();
    await expect(page.getByRole("heading", { name: "Last Manual Run" })).toBeVisible();
    await waitForTaskRunStatus(page, taskTitle, "completed");

    const triggerLabel = "Playwright Schedule";
    await openSection(page, "Automations", "Automations");
    const triggerEditor = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Create Trigger" }),
    }).first();
    await triggerEditor.locator("select").nth(0).selectOption(`${taskTitle} · active`);
    await page.getByPlaceholder("Trigger label").fill(triggerLabel);
    await page.getByRole("button", { name: "Create Trigger" }).click();
    await expect(page.getByText("Trigger Saved")).toBeVisible();
    await expect(page.getByText(triggerLabel)).toBeVisible();

    await openSection(page, "Sessions", "Sessions");
    const taskId = await page.evaluate(async (title) => {
      const response = await fetch("/api/tasks", { credentials: "include" });
      const tasks = await response.json() as Array<Record<string, unknown>>;
      return tasks.find((task) => String(task.title ?? "") === title)?.id ?? null;
    }, taskTitle);
    await expect(taskId).toBeTruthy();
    await page.getByRole("button", { name: new RegExp(`${String(taskId)}.*completed`) }).click();
    await expect(page.getByRole("heading", { name: "Selected Session" })).toBeVisible();
    await expect(page.getByText("task_run_completed")).toBeVisible();

    await openSection(page, "Logs", "Logs Overview");
    await expect(page.getByRole("heading", { name: "Recent Jobs" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent Provider Tests" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "System Logs (Raw JSON)" })).toBeVisible();

    await openSection(page, "Health", "System Health Overview");
    await expect(page.getByRole("heading", { name: "Document Extraction" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent MCP Health" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Cloudflare Dependencies" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Telegram Webhook" })).toBeVisible();
    const healthJson = page.locator("section").filter({
      has: page.getByRole("heading", { name: "System Health (Raw JSON)" }),
    }).locator("pre");
    await expect(healthJson).toContainText("\"providerProfiles\": 1");
  });
});
