import { expect, test } from "playwright/test";

const username = process.env.INITIAL_ADMIN_USERNAME;
const password = process.env.INITIAL_ADMIN_PASSWORD;

test.skip(!username || !password, "TEST_BLOCKED: INITIAL_ADMIN_USERNAME/INITIAL_ADMIN_PASSWORD are required");
test.setTimeout(90_000);
test.use({ colorScheme: "light" });

const created = [];

async function openAdvisor(page) {
  page.on("response", async (response) => {
    if (response.request().method() !== "POST" || response.status() !== 201 || !/\/business-query\/sessions$/.test(new URL(response.url()).pathname)) return;
    created.push((await response.json()).data.session_id);
  });
  await page.goto("/login");
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  await page.goto("/agent");
  await expect(page.getByTestId("page-agent")).toBeVisible({ timeout: 15_000 });
}

async function startNewConversation(page) {
  await expect(page.getByTestId("agent-input")).toBeVisible();
  await page.getByTestId("agent-new-conversation").click();
  await expect(page.getByTestId("agent-welcome")).toBeVisible();
}

async function ask(page, question) {
  await page.getByTestId("agent-input").fill(question);
  await expect(page.getByTestId("business-query-submit")).toBeEnabled();
  await page.getByTestId("agent-input").press("Enter");
  await expect(page.getByTestId("agent-question").last()).toHaveText(question);
  await expect(page.getByTestId("business-query-phase")).toHaveText("已完成", { timeout: 30_000 });
}

test.afterEach(async ({ page }) => {
  for (const sessionId of created.splice(0)) {
    await page.evaluate((id) => fetch(`/api/v1/business-query/sessions/${id}`, { method: "DELETE" }).then((response) => response.status), sessionId);
  }
});

test("agent-session.draft_survives_a_reload", async ({ page }) => {
  await openAdvisor(page);
  await startNewConversation(page);
  await ask(page, `E2E 草稿底稿 ${Date.now()} 有哪些订单？`);

  await page.getByTestId("agent-input").fill("打到一半的草稿");
  await page.waitForTimeout(500);
  await page.reload();

  await expect(page.getByTestId("agent-input")).toHaveValue("打到一半的草稿", { timeout: 15_000 });
  await page.getByTestId("agent-input").fill("");
});

test("agent-session.edit_resend_branches_survive_a_reload", async ({ page }) => {
  const stamp = Date.now();
  const first = `E2E 分支一 ${stamp} 有哪些订单？`;
  const second = `E2E 分支二 ${stamp} 到哪一步了？`;
  await openAdvisor(page);
  await startNewConversation(page);
  await ask(page, first);
  await ask(page, second);

  await page.getByTestId("agent-message-user").nth(1).getByRole("button", { name: "编辑" }).click();
  await page.getByLabel("编辑问题").fill(`${second}（改）`);
  const resent = page.waitForRequest((request) => request.method() === "POST" && /\/sessions\/[^/]+\/runs$/.test(new URL(request.url()).pathname));
  await page.getByRole("button", { name: "重新发送" }).click();
  expect((await resent).postDataJSON().context_run_ids).toHaveLength(1);
  await expect(page.getByText("2/2")).toBeVisible();
  await expect(page.getByTestId("business-query-phase")).toHaveText("已完成", { timeout: 30_000 });

  await page.getByRole("button", { name: "上一个版本" }).click();
  await expect(page.getByText("1/2")).toBeVisible();
  await page.waitForTimeout(500);
  await page.reload();

  await expect(page.getByText("1/2")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-question")).toHaveText([first, second]);
});

test("agent-session.rename_and_delete_persist_on_the_server", async ({ page }) => {
  const stamp = Date.now();
  const name = `E2E 改名 ${stamp}`;
  await openAdvisor(page);
  await startNewConversation(page);
  await ask(page, `E2E 待改名 ${stamp} 有哪些订单？`);

  await page.getByTestId("agent-history-open").click();
  const row = () => page.getByTestId("agent-history-row").filter({ hasText: `E2E 待改名 ${stamp}` });
  await row().getByRole("button", { name: "改名", exact: true }).click();
  await page.getByLabel("会话名称").fill(name);
  const renamed = page.waitForResponse((response) => response.request().method() === "PATCH" && response.status() === 200);
  await page.getByLabel("会话名称").press("Enter");
  await renamed;
  await page.reload();
  await page.getByTestId("agent-history-open").click();
  const named = page.getByTestId("agent-history-row").filter({ hasText: name });
  await expect(named).toBeVisible({ timeout: 15_000 });

  await named.getByRole("button", { name: "删除", exact: true }).click();
  const removed = page.waitForResponse((response) => response.request().method() === "DELETE" && response.status() === 200);
  await page.getByRole("button", { name: "确认删除" }).click();
  await removed;
  await page.reload();
  await page.getByTestId("agent-history-open").click();
  await expect(page.getByTestId("agent-history-list").or(page.getByTestId("agent-history-empty"))).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-history-row").filter({ hasText: name })).toHaveCount(0);
});

test("agent-session.theme_and_language_persist", async ({ page }, testInfo) => {
  await openAdvisor(page);
  await startNewConversation(page);
  await ask(page, `E2E 深色 ${Date.now()} 有哪些订单？`);

  await page.getByTestId("agent-settings-open").click();
  await page.getByRole("radio", { name: "深色" }).check();
  await page.getByRole("radio", { name: "English" }).check();
  await page.reload();

  await expect(page.getByTestId("page-agent")).toHaveAttribute("data-agent-theme", "dark", { timeout: 15_000 });
  await expect(page.getByTestId("agent-new-conversation")).toHaveText("New chat");
  await expect(page.getByTestId("business-query-answer").last()).toBeVisible();
  await testInfo.attach("dark-conversation", { body: await page.screenshot(), contentType: "image/png" });
  await page.screenshot({ path: testInfo.outputPath("dark-conversation.png") });

  await page.getByTestId("agent-history-open").click();
  await expect(page.getByTestId("agent-history-item").first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("dark-history.png") });
});
