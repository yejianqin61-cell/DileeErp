// 业务查询 Agent 的 HTTP 契约测试（需要运行中的 API：API_BASE_URL + INITIAL_ADMIN_*）。
//
// 覆盖：鉴权（匿名 401）、信封（201/202/400/404/409）、幂等键语义、SSE 响应头与终态事件、
// 快照恢复、以及（可选凭据下的）跨用户隔离。遵循本目录纪律：**只读探测，不写业务数据** ——
// agent_* 表的写入是模块自身的状态，不属于业务数据。
//
// 环境约束与 sales-orders-contract.test.cjs 相同：AuthService 单会话，每用例自己登录；
// 其他 agent 并发登录会踢掉 Cookie，已认证调用带换会话重试。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { apiClient, expectErrorEnvelope, expectSuccessEnvelope, expectUnauthenticated, login } = require("../../../../tests/helpers/api-client.cjs");

const baseUrl = process.env.API_BASE_URL;
if (!baseUrl) throw new Error("TEST_BLOCKED: API_BASE_URL is required（例如 http://127.0.0.1:3001）");

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const MAX_ATTEMPTS = 5;

async function adminSession() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) throw new Error("TEST_BLOCKED: INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required");
  const session = await login(baseUrl, { username, password });
  assert.equal(session.status, 201, `登录应返回 201：${JSON.stringify(session.body)}`);
  return session;
}

/** 已认证调用：401 时换新会话重试（同目录既有纪律，真正的 401 契约由匿名用例断言）。 */
async function authedCall(method, path, payload, cookie) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const client = apiClient(baseUrl, { cookie });
    const response = await client.request(path, { method, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
    if (response.status !== 401) return response;
    const fresh = await adminSession();
    cookie = fresh.cookie;
    if (attempt === MAX_ATTEMPTS) return response;
  }
}

test("匿名访问全部 6 条路由：401 JSON 错误信封（SSE 路由也不泄露事件流）", async () => {
  const anonymous = apiClient(baseUrl);
  const probes = [
    { method: "post", path: "/api/v1/business-query/sessions" },
    { method: "get", path: "/api/v1/business-query/sessions" },
    { method: "get", path: `/api/v1/business-query/sessions/${UNKNOWN_ID}` },
    { method: "post", path: `/api/v1/business-query/sessions/${UNKNOWN_ID}/runs`, body: { question: "q", client_message_id: randomUUID() } },
    { method: "get", path: `/api/v1/business-query/runs/${UNKNOWN_ID}/events` },
    { method: "post", path: `/api/v1/business-query/runs/${UNKNOWN_ID}/cancel` },
  ];
  for (const probe of probes) {
    const response = await anonymous.request(probe.path, { method: probe.method, ...(probe.body ? { body: JSON.stringify(probe.body) } : {}) });
    expectUnauthenticated(response, `${probe.method} ${probe.path}`);
  }
});

test("建会话/列会话/快照的信封契约；快照 404 不泄露他人会话存在性", async () => {
  const session = await adminSession();
  const created = await authedCall("post", "/api/v1/business-query/sessions", undefined, session.cookie);
  expectSuccessEnvelope(created, { status: 201 });
  const sessionId = created.body.data.session_id;
  assert.match(sessionId, /^[0-9a-f-]{36}$/i);

  const list = await authedCall("get", "/api/v1/business-query/sessions", undefined, session.cookie);
  expectSuccessEnvelope(list, 200);
  assert.ok(list.body.data.sessions.some((item) => item.session_id === sessionId), "本人会话列表必须包含刚建的会话");

  const snapshot = await authedCall("get", `/api/v1/business-query/sessions/${sessionId}`, undefined, session.cookie);
  expectSuccessEnvelope(snapshot, 200);
  assert.deepEqual(snapshot.body.data.runs, [], "新会话没有 run");

  const missing = await authedCall("get", `/api/v1/business-query/sessions/${UNKNOWN_ID}`, undefined, session.cookie);
  expectErrorEnvelope(missing, { status: 404 });
});

test("创建 run：202 信封、DTO 校验、幂等键语义（同键同问/同键异问）", async () => {
  const session = await adminSession();
  const sessionId = (await authedCall("post", "/api/v1/business-query/sessions", undefined, session.cookie)).body.data.session_id;

  const invalid = await authedCall("post", `/api/v1/business-query/sessions/${sessionId}/runs`, { question: "" }, session.cookie);
  expectErrorEnvelope(invalid, { status: 400, code: "VALIDATION_ERROR", context: "空问题必须被 DTO 校验拦下" });

  const key = randomUUID();
  const question = `契约探测 ${key} 有哪些订单？`;
  const created = await authedCall("post", `/api/v1/business-query/sessions/${sessionId}/runs`, { question, client_message_id: key }, session.cookie);
  expectSuccessEnvelope(created, { status: 202 });
  assert.equal(created.body.data.state, "planning");
  const runId = created.body.data.run_id;

  // 同键同问：返回原 run（不新建、不重跑模型）。
  const replay = await authedCall("post", `/api/v1/business-query/sessions/${sessionId}/runs`, { question, client_message_id: key }, session.cookie);
  expectSuccessEnvelope(replay, { status: 202 });
  assert.equal(replay.body.data.run_id, runId);

  // 同键异问：409 IDEMPOTENCY_CONFLICT。
  const conflict = await authedCall("post", `/api/v1/business-query/sessions/${sessionId}/runs`, { question: "另一个问题", client_message_id: key }, session.cookie);
  expectErrorEnvelope(conflict, { status: 409, code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");

  // 等编排完成（假 provider 应当秒级完成）：快照出现 completed + 非空答案。
  let snapshot;
  for (let waited = 0; waited < 10_000; waited += 300) {
    snapshot = (await authedCall("get", `/api/v1/business-query/sessions/${sessionId}`, undefined, session.cookie)).body.data.runs.find((run) => run.run_id === runId);
    if (snapshot?.state === "completed" || snapshot?.state === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(snapshot.state, "completed", `run 应完成，实际 ${snapshot?.state}`);
  assert.ok(snapshot.answer.length > 0, "完成时答案非空");
  assert.ok(snapshot.latest_seq >= 1, "latest_seq 供断线续接");

  // SSE：内容类型正确，重放里能看到 completed 终态事件，服务端在终态后关闭。
  const client = apiClient(baseUrl, { cookie: session.cookie });
  const stream = await client.request(`/api/v1/business-query/runs/${runId}/events`, { headers: { accept: "text/event-stream" } });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  const bodyText = typeof stream.body === "string" ? stream.body : JSON.stringify(stream.body);
  assert.ok(bodyText.includes(`"completed"`), "重放必须包含 completed 终态事件");
  assert.ok(/id: <runId>:\d+/.test(bodyText.replace(/<runId>/g, runId)) || bodyText.includes(`id: ${runId}:`), "事件必须带 id: <runId>:<seq>");

  // Last-Event-ID 与当前 run 不匹配 → 400（模块设计：只决定重放起点，不能冒充归属）。
  const mismatched = await client.request(`/api/v1/business-query/runs/${runId}/events`, { headers: { accept: "text/event-stream", "last-event-id": `some-other-run:3` } });
  expectErrorEnvelope(mismatched, { status: 400, code: "AGENT_LAST_EVENT_ID_INVALID" });
  assert.equal(mismatched.body.error.code, "AGENT_LAST_EVENT_ID_INVALID");
});

test("跨用户隔离：第二个账号读不到第一个账号的会话与 run（需 SECONDARY_* 凭据）", async (t) => {
  const secondaryUsername = process.env.SECONDARY_USERNAME;
  const secondaryPassword = process.env.SECONDARY_PASSWORD;
  if (!secondaryUsername || !secondaryPassword) {
    t.skip("未提供 SECONDARY_USERNAME/SECONDARY_PASSWORD，跨用户隔离由集成测试与单测覆盖");
    return;
  }
  const ownerSession = await adminSession();
  const sessionId = (await authedCall("post", "/api/v1/business-query/sessions", undefined, ownerSession.cookie)).body.data.session_id;
  const other = await login(baseUrl, { username: secondaryUsername, password: secondaryPassword });
  const otherClient = apiClient(baseUrl, { cookie: other.cookie });
  const peekSession = await otherClient.request(`/api/v1/business-query/sessions/${sessionId}`);
  expectErrorEnvelope(peekSession, { status: 404, context: "他人会话必须 404，不泄露存在性" });
  const peekRuns = await otherClient.request("/api/v1/business-query/sessions");
  assert.ok(!JSON.stringify(peekRuns.body).includes(sessionId), "他人会话列表不得出现本会话");
});
