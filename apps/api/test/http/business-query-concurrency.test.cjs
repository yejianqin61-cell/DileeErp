// 五用户并发证据（需要运行中的 API：API_BASE_URL + INITIAL_ADMIN_* + AGENT_FAKE_DELAY_MS≥1000）。
//
// R-8 的可运行检查：5 个不同用户同时提问时，恰好 4 个进入运行（202）、1 个拿到
// 429 AGENT_BUSY + Retry-After；运行结束后许可归零（第 6 次请求不再 429，无泄漏）。
// 延迟由 AGENT_FAKE_DELAY_MS 注入 fake provider（生产无意义），把并发窗口拉到秒级。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { apiClient, login } = require("../../../../tests/helpers/api-client.cjs");

const baseUrl = process.env.API_BASE_URL;
if (!baseUrl) throw new Error("TEST_BLOCKED: API_BASE_URL is required（例如 http://127.0.0.1:3011）");
const fakeDelayMs = Number(process.env.AGENT_FAKE_DELAY_MS ?? 0);
if (fakeDelayMs < 1000) throw new Error("TEST_BLOCKED: 本文件需要 AGENT_FAKE_DELAY_MS≥1000（fake provider 延迟，占住并发窗口）");

const WORKERS = ["bq-worker-a", "bq-worker-b", "bq-worker-c", "bq-worker-d"];
const WAIT_MS = Math.max(fakeDelayMs * 8, 20_000);

async function adminSession() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) throw new Error("TEST_BLOCKED: INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required");
  return login(baseUrl, { username, password });
}

/** 确保存在 4 个 qita 角色的员工账号（已存在则跳过建号），返回 username。 */
async function ensureWorkers(admin) {
  const client = apiClient(baseUrl, { cookie: admin.cookie });
  for (const username of WORKERS) {
    const created = await client.request("/api/v1/admin/users", { method: "post", body: JSON.stringify({ username, password: `${username}-pass-123`, display_name: username, role_keys: ["qita"] }) });
    assert.ok([201, 409].includes(created.status), `建号 ${username} 应成功或已存在，实际 ${created.status}：${JSON.stringify(created.body)}`);
  }
}

test("五个不同用户同时提问：恰 4 个 202、1 个 429 AGENT_BUSY + Retry-After；结束后许可归零", async () => {
  const admin = await adminSession();
  await ensureWorkers(admin);
  const usernames = [process.env.INITIAL_ADMIN_USERNAME, ...WORKERS];
  const passwords = [process.env.INITIAL_ADMIN_PASSWORD, ...WORKERS.map((username) => `${username}-pass-123`)];

  // 每人一个会话（互不踢会话：login 只删本人 session）。
  const sessions = [];
  for (const [index, username] of usernames.entries()) {
    const session = await login(baseUrl, { username, password: passwords[index] });
    const client = apiClient(baseUrl, { cookie: session.cookie });
    const sessionId = (await client.request("/api/v1/business-query/sessions", { method: "post", body: JSON.stringify({}) })).body.data.session_id;
    sessions.push({ client, sessionId, username });
  }

  // 五人同时提问：闸门是同步计数，恰好放 4 个。
  const attempts = sessions.map((session, index) => session.client.request(`/api/v1/business-query/sessions/${session.sessionId}/runs`, {
    method: "post",
    body: JSON.stringify({ question: `并发探测 ${index}：SO 有哪些订单？`, client_message_id: randomUUID() }),
  }));
  const results = await Promise.allSettled(attempts);
  const statuses = results.map((result) => result.value.status);
  const bodies = results.map((result) => result.value.body);
  assert.equal(statuses.filter((status) => status === 202).length, 4, `应恰好 4 个 202，实际 ${JSON.stringify(statuses)}`);
  const busy = bodies.find((body) => body?.error?.code === "AGENT_BUSY");
  assert.ok(busy, "必须有且只有一个 AGENT_BUSY");

  // 并发测试里登录互不干扰，但 429 的那个请求要能从结果里拿到 Retry-After 头。
  const busyHeaders = results[statuses.indexOf(429)].value.headers;
  assert.equal(busyHeaders?.get?.("retry-after") ?? busyHeaders?.["retry-after"], "3", "429 必须带 Retry-After: 3");

  // 等全部 run 完成（fake provider 延迟），再发一个新请求：许可应已归零。
  const deadline = Date.now() + WAIT_MS;
  for (const session of sessions) {
    for (;;) {
      const snapshot = await session.client.request(`/api/v1/business-query/sessions/${session.sessionId}`);
      const runs = snapshot.body.data?.runs ?? [];
      if (runs.every((run) => ["completed", "failed", "cancelled"].includes(run.state))) break;
      if (Date.now() > deadline) throw new Error(`等待 run 完成超时：${session.username}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const retry = await sessions[0].client.request(`/api/v1/business-query/sessions/${sessions[0].sessionId}/runs`, {
    method: "post",
    body: JSON.stringify({ question: "许可释放后的新问题：SO 有哪些订单？", client_message_id: randomUUID() }),
  });
  assert.equal(retry.status, 202, `许可释放后再请求应 202，实际 ${retry.status}：${JSON.stringify(retry.body)}`);
}, { timeout: WAIT_MS + 30_000 });
