// 业务查询恢复体验 E2E：真实浏览器经 Next 代理访问本地 API；fake provider 的延迟保留活动窗口，
// 以便验证刷新只续接 SSE、取消能稳定收束。此文件不建测试账号，也不写业务数据。
import { expect, test } from "playwright/test";

const username = process.env.INITIAL_ADMIN_USERNAME;
const password = process.env.INITIAL_ADMIN_PASSWORD;
const fakeDelayMs = Number(process.env.AGENT_FAKE_DELAY_MS ?? 0);

test.skip(!username || !password, "TEST_BLOCKED: INITIAL_ADMIN_USERNAME/INITIAL_ADMIN_PASSWORD are required");
test.skip(fakeDelayMs < 500, "TEST_BLOCKED: AGENT_FAKE_DELAY_MS must be at least 500 to make the active-run browser window deterministic");

test.setTimeout(45_000);

async function openBusinessQuery(page) {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  await page.goto("/business-query");
  await expect(page.getByTestId("page-business-query")).toBeVisible({ timeout: 15_000 });
}

async function submitQuestion(page, question) {
  await page.getByLabel("业务问题").fill(question);
  await page.getByLabel("业务问题").press("Enter");
  await expect(page.getByTestId("business-query-cancel")).toBeVisible({ timeout: 10_000 });
}

test("business-query.refresh_resumes_the_active_run_without_second_post", async ({ page }) => {
  let createRunPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/v1\/business-query\/sessions\/[^/]+\/runs(?:\?|$)/.test(new URL(request.url()).pathname)) createRunPosts += 1;
  });

  await openBusinessQuery(page);
  await submitQuestion(page, `E2E 刷新恢复 ${Date.now()} 有哪些订单？`);

  await page.reload();

  await expect(page.getByTestId("business-query-answer")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("business-query-phase")).toHaveText("已完成", { timeout: 30_000 });
  expect(createRunPosts).toBe(1);
});

test("business-query.cancel_reaches_the_user_visible_terminal_state", async ({ page }) => {
  await openBusinessQuery(page);
  await submitQuestion(page, `E2E 取消 ${Date.now()} 有哪些订单？`);

  await page.getByTestId("business-query-cancel").click();

  await expect(page.getByTestId("business-query-phase")).toHaveText("已取消", { timeout: 15_000 });
});
