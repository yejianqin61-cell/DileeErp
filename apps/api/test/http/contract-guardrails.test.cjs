// S12 契约护栏：把已确认的契约行为与**已知缺陷**固化为回归护栏。
//
// 为什么需要：docs/test/00-recon-api-contract.md 记录的若干契约问题（D2/D7/D8/D9/D10）
// 目前仍在，但没有任何测试锁住它们 —— 既不能保证"缺陷不被悄悄扩大"，也不能在修复时
// 明确地看到"护栏翻转"。本文件因此区分两类断言：
//   1. 契约应当如此的部分 —— 直接断言正确行为；
//   2. **KNOWN_CONTRACT_DEFECT** —— 断言"当前（错误）行为"，一旦有人修好，这些用例会变红，
//      提示同步更新本文件与 recon 记录。这不是回归，是修复信号。
//
// 所有断言值均来自 2026-09-13 对运行中 API 的实测（探针见 docs/test/results/2026-09-13-w2-*.md）。
//
// 运行：API_BASE_URL=<已启动的 API> npm run test:api
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { apiClient, expectErrorEnvelope, expectSuccessEnvelope, login } = require("../../../../tests/helpers/api-client.cjs");

const baseUrl = process.env.API_BASE_URL;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 报表端点中 meta.total 语义为「本页行数」而非「总条数」的集合（D7，实测确认）。 */
const TOTAL_SEMANTICS_DEFECT_ENDPOINTS = ["inventory", "procurement-payables", "production-qc", "payroll"];
/** 语义正确的对照端点（reports.service.ts:11 用的是 count(where)）。 */
const TOTAL_SEMANTICS_CORRECT_ENDPOINTS = ["orders"];

async function adminSession() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) throw new Error("TEST_BLOCKED: INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required");
  const session = await login(baseUrl, { password, username });
  assert.equal(session.status, 201, `登录应返回 201（所有 POST 的默认状态码），实际 ${session.status}`);
  assert.ok(session.cookie, "登录必须下发 dilee_session Cookie");
  return session;
}

test("contract.envelope_success_always_wraps_data_and_meta", async () => {
  const session = await adminSession();
  const client = apiClient(baseUrl, { cookie: session.cookie });

  // /health 在数据库短暂不可用时返回 503 DEPENDENCY_UNAVAILABLE（health.controller.ts:16）。
  // node --test 会并行跑本目录下多个文件，数据库连接存在竞争，因此 503 是**合法且偶发**的。
  // 两种状态都必须是标准信封 —— 这样断言既不依赖环境，又同时覆盖了成功与失败两种形状。
  // （此前这里硬断言 200，在并行执行下约 1/4 概率偶发失败，属测试自身缺陷。）
  const health = await client.get("/api/v1/health");
  if (health.status === 200) expectSuccessEnvelope(health, { context: "health" });
  else expectErrorEnvelope(health, { code: "DEPENDENCY_UNAVAILABLE", context: "health", status: 503 });

  const customers = await client.get("/api/v1/customers?page_size=1");
  const body = expectSuccessEnvelope(customers, { context: "customers", paginated: true });
  assert.ok(Array.isArray(body.data), "列表端点的 data 必须是数组（分页信息在 meta 里）");
});

test("contract.unknown_route_and_wrong_method_both_return_404_never_405", async () => {
  const session = await adminSession();
  const client = apiClient(baseUrl, { cookie: session.cookie });

  const unknown = await client.get("/api/v1/does-not-exist");
  expectErrorEnvelope(unknown, { code: "NOT_FOUND", context: "unknown route", status: 404 });
  assert.match(unknown.body.error.message, /^Cannot GET/, "路由不存在的 message 由 Nest 生成，为英文");

  // 后端没有 405：方法不匹配同样走 404 handler
  const wrongMethod = await client.post("/api/v1/customers/00000000-0000-4000-8000-000000000000", {});
  assert.equal(wrongMethod.status, 404, `方法不匹配应为 404（无 405），实际 ${wrongMethod.status}`);
  expectErrorEnvelope(wrongMethod, { code: "NOT_FOUND", status: 404 });
});

test("contract.anonymous_requests_are_rejected_with_unauthenticated", async () => {
  const anonymous = apiClient(baseUrl);
  expectErrorEnvelope(await anonymous.get("/api/v1/customers"), { code: "UNAUTHENTICATED", status: 401 });
  expectErrorEnvelope(await anonymous.post("/api/v1/customers", {}), { code: "UNAUTHENTICATED", status: 401 });
});

test("KNOWN_CONTRACT_DEFECT D2: meta.request_id is absent unless the client sends the request header", async () => {
  // 成因：RequestIdMiddleware 只把 id 写到响应头与 request.id（request-id.middleware.ts:7-8），
  // 而拦截器/过滤器读的是**请求头** request.header("x-request-id")
  // （response-envelope.interceptor.ts:9、api-exception.filter.ts:24）。全仓库无人把响应头写回请求头。
  // 后果：docs/design/global-api-contract.md:31 要求的 meta.request_id 实际恒缺，追踪只能靠响应头。
  //
  // 用**已认证的 GET**做双向验证，而不是匿名的 /health —— 后者在数据库竞争时会返回 503，
  // 会让"成功响应里没有 request_id"的断言偶发失效（本文件曾因此不稳定）。
  const session = await adminSession();
  const client = apiClient(baseUrl, { cookie: session.cookie });

  const withoutHeader = await client.get("/api/v1/customers?page_size=1");
  expectSuccessEnvelope(withoutHeader, { paginated: true });
  assert.equal("request_id" in withoutHeader.body.meta, false, "未发送请求头时 meta 里不应出现 request_id");
  assert.equal(withoutHeader.body.meta.request_id, undefined);
  // 客户端未指定时，响应头由中间件生成，必须是 UUID
  assert.match(withoutHeader.requestId ?? "", UUID_PATTERN, "响应头 x-request-id 必须是 UUID");

  const withHeader = await client.get("/api/v1/customers?page_size=1", { headers: { "x-request-id": "fixed-probe-id" } });
  expectSuccessEnvelope(withHeader, { paginated: true });
  assert.equal(withHeader.body.meta.request_id, "fixed-probe-id", "只有客户端自带请求头时 meta.request_id 才会出现");
  assert.equal(withHeader.requestId, "fixed-probe-id", "响应头会回显客户端提供的 id");
});

test("KNOWN_CONTRACT_DEFECT D9: unknown query params are rejected on DTO endpoints but silently ignored on literal-typed ones", async () => {
  const session = await adminSession();
  const client = apiClient(baseUrl, { cookie: session.cookie });

  // 走 DTO 类校验的端点：未知参数 → 400 whitelistValidation
  const rejected = await client.get("/api/v1/customers?bogus=1");
  expectErrorEnvelope(rejected, { code: "VALIDATION_ERROR", status: 400 });
  assert.equal(rejected.body.error.details[0].rule, "whitelistValidation");
  assert.equal(rejected.body.error.details[0].field, "bogus");

  // @Query() q: { ... } 这类 TS 字面量的 metatype 是 Object，ValidationPipe 完全跳过 → 静默忽略
  const ignored = await client.get("/api/v1/production/employee-reports?bogus=1");
  assert.equal(ignored.status, 200, "字面量型 query 的端点应静默忽略未知参数（当前行为，属 D9 缺陷）");
  expectSuccessEnvelope(ignored);
});

test("KNOWN_CONTRACT_DEFECT D10: nested DTO validation failures lose their details", async () => {
  const session = await adminSession();
  const client = apiClient(baseUrl, { cookie: session.cookie });

  // 顶层字段的错误能给出可定位的 details
  const topLevel = await client.post("/api/v1/customers", { bogus_field: 1, name: "PROBE" });
  assert.equal(topLevel.status, 400);
  assert.equal(topLevel.body.error.details[0].field, "bogus_field");

  // 嵌套数组里的错误则丢掉全部 details：exceptionFactory 只读顶层 error.constraints，
  // 不递归 error.children（api-exception.filter.ts:26）
  const nested = await client.post("/api/v1/purchase-orders", { items: [{ quantity: "not-a-decimal" }], order_no: "PROBE-NESTED", supplier_id: "00000000-0000-4000-8000-000000000000" });
  assert.equal(nested.status, 400, "嵌套校验失败仍应是 400");
  expectErrorEnvelope(nested, { code: "VALIDATION_ERROR", status: 400 });
  assert.deepEqual(nested.body.error.details, [], "当前实现会丢掉嵌套字段错误 —— 修复后此断言应变红，请同步更新");
});

test("KNOWN_CONTRACT_DEFECT D7: report meta.total reports the page length for four endpoints", async () => {
  const session = await adminSession();
  const client = apiClient(baseUrl, { cookie: session.cookie });

  // 契约要求 meta.total 是总条数，与 page_size 无关。以下 4 个端点返回的是本页行数
  // （reports.service.ts:12-15 用 rows.length），导致客户端分页器以为只有一页。
  for (const report of TOTAL_SEMANTICS_DEFECT_ENDPOINTS) {
    const response = await client.get(`/api/v1/reports/${report}?page_size=2`);
    const body = expectSuccessEnvelope(response, { context: `reports/${report}`, paginated: true });
    assert.equal(
      body.meta.total,
      body.data.length,
      `reports/${report} 的 meta.total 当前等于本页行数（D7 缺陷）。若此处失败说明语义已修正，请把它移入 CORRECT 集合并更新 recon 记录`,
    );
  }

  // 对照：orders 用的是 count(where)，total 是真实总条数（可以大于本页行数）
  for (const report of TOTAL_SEMANTICS_CORRECT_ENDPOINTS) {
    const response = await client.get(`/api/v1/reports/${report}?page_size=1`);
    const body = expectSuccessEnvelope(response, { context: `reports/${report}`, paginated: true });
    assert.ok(body.meta.total >= body.data.length, `reports/${report} 的 meta.total 不应小于本页行数`);
  }
});

test("KNOWN_CONTRACT_DEFECT D8: the sort query param is accepted everywhere but implemented nowhere", async () => {
  const session = await adminSession();
  const client = apiClient(baseUrl, { cookie: session.cookie });

  const asc = await client.get("/api/v1/customers?page_size=5&sort=name");
  const desc = await client.get("/api/v1/customers?page_size=5&sort=-name");
  const plain = await client.get("/api/v1/customers?page_size=5");

  expectSuccessEnvelope(asc);
  const ids = (response) => response.body.data.map((row) => row.id);
  assert.deepEqual(ids(asc), ids(plain), "sort=name 与不传 sort 的顺序相同 —— sort 被静默忽略（D8）");
  assert.deepEqual(ids(desc), ids(plain), "sort=-name 同样被忽略（D8）。若此处失败说明 sort 已实现，请更新本用例与 recon 记录");
});

test("contract.pagination_bounds_are_enforced", async () => {
  const session = await adminSession();
  const client = apiClient(baseUrl, { cookie: session.cookie });

  expectSuccessEnvelope(await client.get("/api/v1/customers?page_size=200"), { paginated: true, status: 200 });
  for (const query of ["page_size=201", "page_size=0", "page_size=abc", "page=0"]) {
    const response = await client.get(`/api/v1/customers?${query}`);
    expectErrorEnvelope(response, { code: "VALIDATION_ERROR", status: 400 });
    assert.ok(response.body.error.details.length > 0, `?${query} 应给出可定位的字段级 details`);
  }
});
