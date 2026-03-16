import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3310"}`;

async function bootstrapWorkspace(page: Page) {
  await page.goto(`${baseURL}/miniapp/`);
  await page.evaluate(async () => {
    await fetch("/api/session/telegram", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "dev-owner",
        username: "dev",
      }),
    });
    await fetch("/api/bootstrap/verify-access-token", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        accessToken: "dev-access-token",
      }),
    });
    await fetch("/api/bootstrap/cloudflare/connect", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        accessToken: "dev-access-token",
        accountId: "acct",
        apiToken: "token",
        r2AccessKeyId: "local-key",
        r2SecretAccessKey: "local-secret",
      }),
    });
    await fetch("/api/bootstrap/cloudflare/init-resources", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        label: "Chrome Extension Workspace",
        timezone: "UTC",
      }),
    });
  });
  await page.reload();
}

async function openSection(page: Page, section: string, heading: string) {
  await page.getByRole("button", { name: section }).click();
  await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
}

function panelByTitle(page: Page, title: string) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: title }),
  }).first();
}

async function cardByTitle(page: Page, title: string) {
  const card = page.locator("div.rounded-2xl").filter({ hasText: title }).first();
  await card.scrollIntoViewIfNeeded();
  return card;
}

async function getTaskRun(page: Page, taskTitle: string) {
  return page.evaluate(async ({ title }) => {
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
    return runs.find((run) => String(run.taskId ?? "") === String(taskId)) ?? null;
  }, { title: taskTitle });
}

async function waitForTaskRunStatus(page: Page, taskTitle: string, status: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const run = await getTaskRun(page, taskTitle);
    const currentStatus = String(run?.status ?? "");
    if (currentStatus === status) {
      return run;
    }
    if (currentStatus && currentStatus !== "queued" && currentStatus !== "running") {
      throw new Error(`Task "${taskTitle}" ended in unexpected status: ${JSON.stringify(run, null, 2)}`);
    }
    await page.waitForTimeout(500);
  }
  const run = await getTaskRun(page, taskTitle);
  throw new Error(`Task "${taskTitle}" did not reach status "${status}": ${JSON.stringify(run, null, 2)}`);
}

async function getExecutorId(page: Page, label: string) {
  return page.evaluate(async (executorLabel) => {
    const response = await fetch("/api/executors", { credentials: "include" });
    const executors = await response.json() as Array<Record<string, unknown>>;
    return executors.find((executor) => String(executor.label ?? "") === executorLabel)?.id ?? null;
  }, label);
}

async function getTaskId(page: Page, title: string) {
  return page.evaluate(async (taskTitle) => {
    const response = await fetch("/api/tasks", { credentials: "include" });
    const tasks = await response.json() as Array<Record<string, unknown>>;
    return tasks.find((task) => String(task.title ?? "") === taskTitle)?.id ?? null;
  }, title);
}

async function getExtensionId(context: BrowserContext) {
  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker");
  }
  const extensionUrl = serviceWorker.url();
  const [, , extensionId] = extensionUrl.split("/");
  if (!extensionId) {
    throw new Error(`Could not resolve extension id from ${extensionUrl}`);
  }
  return extensionId;
}

test("pairs and runs a chrome extension executor end to end", async () => {
  const extensionPath = path.resolve(process.cwd(), "apps/chrome-extension/dist");
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "pulsarbot-chrome-ext-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const extensionId = await getExtensionId(context);
    const appPage = await context.newPage();
    await bootstrapWorkspace(appPage);

    const executorLabel = "Playwright Chrome Executor";
    await openSection(appPage, "Executors", "Executors");
    const executorEditor = appPage.locator("section").filter({
      has: appPage.getByRole("heading", { name: "Create Executor" }),
    }).first();
    await appPage.getByPlaceholder("Executor label").fill(executorLabel);
    await executorEditor.getByLabel("Executor kind").selectOption("chrome_extension");
    await appPage.getByPlaceholder("Allowed hosts (comma separated)").fill("127.0.0.1");
    await appPage.getByRole("button", { name: "Create Executor" }).click();
    await expect(appPage.getByText("Executor Saved")).toBeVisible();

    const executorCard = await cardByTitle(appPage, executorLabel);
    await executorCard.getByRole("button", { name: "Pair" }).click();
    const pairingPanel = panelByTitle(appPage, "Pairing Code");
    await expect(pairingPanel.getByRole("button", { name: "Refresh Pair Code" })).toBeVisible();
    await expect
      .poll(async () => pairingPanel.locator("textarea").inputValue())
      .toContain("pair.");
    const pairingCode = await pairingPanel.locator("textarea").inputValue();

    const executorId = await getExecutorId(appPage, executorLabel);
    expect(executorId).toBeTruthy();

    const targetPage = await context.newPage();
    await targetPage.goto(`${baseURL}/e2e/browser-target`);
    await targetPage.waitForLoadState("load");
    await targetPage.bringToFront();

    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await popupPage.getByLabel("Server URL").fill(baseURL);
    await popupPage.getByLabel("Executor ID").fill(String(executorId));
    await popupPage.getByLabel("Pairing Code").fill(pairingCode);
    await popupPage.getByLabel("Profile Label").fill("Playwright Profile");
    await popupPage.getByRole("button", { name: "Pair" }).click();
    await expect(popupPage.getByText("Paired")).toBeVisible();

    await targetPage.bringToFront();
    await popupPage.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({
        type: "attach_current_window",
      });
      if (!response?.ok) {
        throw new Error(typeof response?.error === "string" ? response.error : "Attach failed");
      }
    });
    await popupPage.reload();
    await expect(popupPage.locator("#stateView")).toContainText("\"attachState\": \"attached\"");

    await appPage.bringToFront();
    await openSection(appPage, "Executors", "Executors");
    await expect(appPage.getByText("Attached")).toBeVisible();
    await expect(appPage.getByText("http://127.0.0.1:3310")).toBeVisible();

    const taskTitle = "Chrome Browser Flow";
    await openSection(appPage, "Tasks", "Tasks");
    await appPage.getByPlaceholder("Task title").fill(taskTitle);
    await appPage
      .getByPlaceholder("What should this task accomplish?")
      .fill("Use the attached Chrome window to interact with a logged-in tab.");
    const taskEditor = panelByTitle(appPage, "Create Task");
    await taskEditor.getByLabel("Task template").selectOption("browser_workflow");
    await taskEditor.getByLabel("Task default executor").selectOption(String(executorId));
    await taskEditor.getByLabel("Start URL").fill(`${baseURL}/e2e/browser-target`);
    await taskEditor.getByLabel("Browser Steps").fill(JSON.stringify([
      { type: "type", selector: "#name-input", text: "Pulsarbot" },
      { type: "click", selector: "#primary-action" },
      { type: "wait_for_selector", selector: "#result[data-state='submitted']", timeoutMs: 5000 },
      { type: "extract_text", selector: "#result", label: "Result" },
    ], null, 2));
    await taskEditor.getByLabel("Before executor").uncheck();
    await taskEditor.getByLabel("Task status").selectOption("active");
    await appPage.getByRole("button", { name: "Create Task" }).click();
    await expect(appPage.getByText("Task Saved")).toBeVisible();

    const taskCard = await cardByTitle(appPage, taskTitle);
    await taskCard.getByRole("button", { name: "Run" }).click();
    await expect(appPage.getByRole("heading", { name: "Last Manual Run" })).toBeVisible();

    const heartbeatPromise = popupPage.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({
        type: "heartbeat_now",
      });
      if (!response?.ok) {
        throw new Error(typeof response?.error === "string" ? response.error : "Heartbeat failed");
      }
      return response.result;
    });
    await targetPage.bringToFront();
    await heartbeatPromise;

    await appPage.bringToFront();
    await waitForTaskRunStatus(appPage, taskTitle, "completed");
    await expect(targetPage.locator("#result")).toHaveText("Hello Pulsarbot");

    const taskId = await getTaskId(appPage, taskTitle);
    expect(taskId).toBeTruthy();
    await openSection(appPage, "Sessions", "Sessions");
    await appPage.getByRole("button", { name: new RegExp(`${String(taskId)}.*completed`) }).click();
    await expect(appPage.getByRole("heading", { name: "Selected Session" })).toBeVisible();
    await expect(appPage.getByText("task_run_completed")).toBeVisible();
    await expect(appPage.getByText("DOM Snapshot")).toBeVisible();
    await expect(appPage.getByText("Screenshot").first()).toBeVisible();
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
