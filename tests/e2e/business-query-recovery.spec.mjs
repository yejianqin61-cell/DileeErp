// 业务查询恢复体验 E2E：真实浏览器经 Next 代理访问本地 API；fake provider 的延迟保留活动窗口。
// 这里覆盖刷新、断线、取消、429、409 与运行中撤权；临时账号只存在于专用测试库。
import { expect, test } from "playwright/test";

const username = process.env.INITIAL_ADMIN_USERNAME;
const password = process.env.INITIAL_ADMIN_PASSWORD;
const fakeDelayMs = Number(process.env.AGENT_FAKE_DELAY_MS ?? 0);

test.skip(!username || !password, "TEST_BLOCKED: INITIAL_ADMIN_USERNAME/INITIAL_ADMIN_PASSWORD are required");
test.skip(fakeDelayMs < 500, "TEST_BLOCKED: AGENT_FAKE_DELAY_MS must be at least 500 to make the active-run browser window deterministic");

test.setTimeout(90_000);

async function login(page, credentials = { username, password }) {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(credentials.username);
  await page.getByTestId("login-password").fill(credentials.password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
}

async function openBusinessQuery(page, credentials) {
  await login(page, credentials);
  await page.goto("/business-query");
  await expect(page.getByTestId("page-business-query")).toBeVisible({ timeout: 15_000 });
}

async function submitQuestion(page, question) {
  await page.getByLabel("业务问题").fill(question);
  await page.getByLabel("业务问题").press("Enter");
  await expect(page.getByTestId("business-query-cancel")).toBeVisible({ timeout: 10_000 });
}

async function api(page, path, { method = "GET", body } = {}) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
}

async function createUser(adminPage, roleKey, label) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const credential = { username: `phase5-${label}-${suffix}`, password: `Phase5-${suffix}-Pass9` };
  const response = await api(adminPage, "/api/v1/admin/users", {
    method: "POST",
    body: { username: credential.username, password: credential.password, display_name: `Phase 5 ${label}`, role_keys: [roleKey] },
  });
  expect(response.status).toBe(201);
  return { credential, userId: response.body.data.id };
}

async function createActiveRun(page, question) {
  const session = await api(page, "/api/v1/business-query/sessions", { method: "POST", body: {} });
  expect(session.status).toBe(201);
  const created = await api(page, `/api/v1/business-query/sessions/${session.body.data.session_id}/runs`, {
    method: "POST",
    body: { question, client_message_id: crypto.randomUUID() },
  });
  expect(created.status).toBe(202);
  return created.body.data.run_id;
}

async function cancelRun(page, runId) {
  const response = await api(page, `/api/v1/business-query/runs/${runId}/cancel`, { method: "POST", body: {} });
  expect([201, 202]).toContain(response.status);
}

async function deactivateUser(adminPage, userId) {
  const response = await api(adminPage, `/api/v1/admin/users/${userId}/active`, { method: "PATCH", body: { is_active: false } });
  expect(response.status).toBe(200);
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

test("business-query.disconnect_reconnects_the_same_run_without_second_post", async ({ page }) => {
  let createRunPosts = 0;
  let streamRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && /\/api\/v1\/business-query\/sessions\/[^/]+\/runs$/.test(path)) createRunPosts += 1;
    if (request.method() === "GET" && /\/api\/v1\/business-query\/runs\/[^/]+\/events$/.test(path)) streamRequests += 1;
  });

  await openBusinessQuery(page);
  await submitQuestion(page, `E2E 断线重连 ${Date.now()} 有哪些订单？`);
  await expect.poll(() => streamRequests).toBeGreaterThan(0);

  // Chromium 的 offline 模拟不会断开已建立的 HTTP 流；停止当前页面加载会中止这个真实 fetch 流，
  // 后续请求仍由页面自己的重试逻辑发起。
  await page.evaluate(() => window.stop());
  await expect(page.getByTestId("business-query-phase")).toHaveText("连接中断，正在恢复…", { timeout: 10_000 });

  await expect(page.getByTestId("business-query-phase")).toHaveText("已完成", { timeout: 30_000 });
  expect(createRunPosts).toBe(1);
  expect(streamRequests).toBeGreaterThanOrEqual(2);
});

test("business-query.409_keeps_the_draft_when_another_run_is_active", async ({ page }) => {
  await openBusinessQuery(page);
  const backgroundRun = await createActiveRun(page, `E2E 后台活动 run ${Date.now()}`);
  const question = "界面提问必须保留的 409 草稿";

  try {
    await page.getByLabel("业务问题").fill(question);
    await page.getByLabel("业务问题").press("Enter");

    await expect(page.getByText("你已有一个正在进行的查询，请等待完成或取消后再提问", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel("业务问题")).toHaveValue(question);
  } finally {
    await cancelRun(page, backgroundRun);
  }
});

test("business-query.429_keeps_the_draft_when_the_real_gate_is_full", async ({ browser, page }) => {
  await openBusinessQuery(page);
  const workerContexts = [];
  const workers = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      const worker = await createUser(page, "qita", `gate-${index}`);
      const context = await browser.newContext();
      const workerPage = await context.newPage();
      workerContexts.push(context);
      await login(workerPage, worker.credential);
      const runId = await createActiveRun(workerPage, `E2E 429 占位 ${index} ${Date.now()}`);
      workers.push({ ...worker, page: workerPage, runId });
    }

    const question = "429 后必须保留的提问草稿";
    await page.getByLabel("业务问题").fill(question);
    await page.getByLabel("业务问题").press("Enter");

    await expect(page.getByText("当前使用业务查询的人较多，请稍后重试", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel("业务问题")).toHaveValue(question);
  } finally {
    for (const worker of workers) {
      await cancelRun(worker.page, worker.runId);
      await deactivateUser(page, worker.userId);
    }
    await Promise.all(workerContexts.map((context) => context.close()));
  }
});

test("business-query.access_revocation_clears_the_live_stream", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  let subject;
  let subjectContext;
  try {
    await login(adminPage);
    subject = await createUser(adminPage, "caiwu", "revoke");
    subjectContext = await browser.newContext();
    const subjectPage = await subjectContext.newPage();
    await openBusinessQuery(subjectPage, subject.credential);
    await submitQuestion(subjectPage, `E2E 运行中撤权 ${Date.now()} 有哪些订单？`);

    const downgraded = await api(adminPage, `/api/v1/admin/users/${subject.userId}/roles`, { method: "POST", body: { role_keys: ["qita"] } });
    expect(downgraded.status).toBe(201);

    await expect(subjectPage.getByTestId("business-query-error")).toContainText("当前档位已无法读取该回答", { timeout: 10_000 });
    await expect(subjectPage.getByTestId("business-query-answer")).toHaveCount(0);
  } finally {
    if (subject) await deactivateUser(adminPage, subject.userId);
    await subjectContext?.close();
    await adminContext.close();
  }
});
