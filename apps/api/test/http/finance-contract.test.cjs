// finance 模块 HTTP 契约测试（只读探测）。
//
// 目标控制器：apps/api/src/modules/finance/finance.controller.ts —— 42 个路由，全项目最大控制器。
//   - 类级 @UseGuards(AuthenticationGuard, ModulePermissionGuard) + @RequireModules("finance")（:63-64）。
//   - **本题目标描述里假设的"方法级 RequireAnyModules / RequireAdministrator 差异"在当前代码中不存在**：
//     42 个路由上没有任何方法级权限装饰器，权限要求完全一致（都只要求 finance 模块）。
//     方法级放宽之所以不可行，控制器 :93-95 的注释已说明（类级 @RequireModules 先于方法级 ANY 校验），
//     相关接口已迁到 PayableNotificationController（payable-notification.controller.ts:31）。
//     因此 403 维度只能由「有会话但无 finance 权限的用户」覆盖 —— 见文件末尾的环境门控用例。
//
// 三条环境约束（源实现 + docs/test/02-test-environment-runbook.md §7.5）：
//   1. 单会话：AuthService.login() 先删该用户全部 session 再建新的（auth.service.ts:28-31）。
//      在跑的其他 agent 也用 admin 登录时，本会话会被作废 → 403/401 抖动。
//      这里既遵守「每个用例内部自己登录」，又在收到 401 时重新登录并重放该请求（见 adminAgent）。
//   2. 必须串行执行：node --test --test-concurrency=1 apps/api/test/http/finance-contract.test.cjs
//   3. /health 在数据库竞争下会返回 503，本文件完全不使用 /health。
//
// 只读纪律：只发 GET（列表 / 详情 / 影响预览）、匿名请求（断言 401）、随机 UUID 的详情与动作请求
// （断言 404）、以及**非法请求体**的 POST/PATCH（断言 400 —— ValidationPipe 在抵达 service 之前拒绝）。
// 不创建 / 修改 / 删除任何业务数据。三个"无 body DTO"的动作端点（confirm / post）会真正进入 service，
// 已逐一核对代码：它们都在任何 update 之前抛 notFound（见 BODYLESS_ACTIONS 注释），因此同样是只读的。
//
// 断言依据：2026 年对运行中 API（http://127.0.0.1:3001）的实测，以及各 service 的 notFound/invalid 抛点。
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const {
  apiClient,
  expectErrorEnvelope,
  expectForbidden,
  expectNotFound,
  expectRequestIdHeader,
  expectSuccessEnvelope,
  expectUnauthenticated,
  expectValidationError,
  login,
} = require("../../../../tests/helpers/api-client.cjs");

const baseUrl = process.env.API_BASE_URL;
const FINANCE = "/api/v1/finance";

/** 保证不存在的 id：随机 UUID，避免与任何真实/其他 agent 写入的数据撞车。 */
const UNKNOWN_ID = randomUUID();

/** FinanceController 的 18 个 GET 路由（读取型探测）。 */
const READ_ROUTES = [
  `${FINANCE}/receivable-sources`,
  `${FINANCE}/receivable-sources/${UNKNOWN_ID}`,
  `${FINANCE}/receivable-sources/${UNKNOWN_ID}/impact-preview`,
  `${FINANCE}/customer-payments`,
  `${FINANCE}/customer-payments/${UNKNOWN_ID}`,
  `${FINANCE}/order-summary`,
  `${FINANCE}/receivable-order-summary`,
  `${FINANCE}/receivable-adjustments`,
  `${FINANCE}/receivable-adjustments/${UNKNOWN_ID}`,
  `${FINANCE}/reconciliations`,
  `${FINANCE}/reconciliations/${UNKNOWN_ID}`,
  `${FINANCE}/order-close-preview`,
  `${FINANCE}/payable-entries/${UNKNOWN_ID}`,
  `${FINANCE}/supplier-payments`,
  `${FINANCE}/supplier-payments/${UNKNOWN_ID}`,
  `${FINANCE}/payable-order-summary`,
  `${FINANCE}/supplier-payable-reconciliations`,
  `${FINANCE}/supplier-payable-reconciliations/${UNKNOWN_ID}`,
];

/** 20 个 POST 路由。 */
const POST_ROUTES = [
  `${FINANCE}/receivable-sources/from-outbound/${UNKNOWN_ID}`,
  `${FINANCE}/receivable-sources/${UNKNOWN_ID}/confirm`,
  `${FINANCE}/receivable-sources/${UNKNOWN_ID}/reopen`,
  `${FINANCE}/receivable-sources/${UNKNOWN_ID}/cancel`,
  `${FINANCE}/customer-payments`,
  `${FINANCE}/customer-payments/${UNKNOWN_ID}/post`,
  `${FINANCE}/customer-payments/${UNKNOWN_ID}/reverse`,
  `${FINANCE}/receivable-adjustments`,
  `${FINANCE}/receivable-adjustments/${UNKNOWN_ID}/post`,
  `${FINANCE}/receivable-adjustments/${UNKNOWN_ID}/reverse`,
  `${FINANCE}/reconciliations`,
  `${FINANCE}/reconciliations/${UNKNOWN_ID}/resolve`,
  `${FINANCE}/payable-entries/${UNKNOWN_ID}/confirm`,
  `${FINANCE}/payable-entries/${UNKNOWN_ID}/reopen`,
  `${FINANCE}/payable-entries/${UNKNOWN_ID}/reverse`,
  `${FINANCE}/supplier-payments`,
  `${FINANCE}/supplier-payments/${UNKNOWN_ID}/post`,
  `${FINANCE}/supplier-payments/${UNKNOWN_ID}/reverse`,
  `${FINANCE}/supplier-payable-reconciliations`,
  `${FINANCE}/supplier-payable-reconciliations/${UNKNOWN_ID}/resolve`,
];

/** 4 个 PATCH 路由。 */
const PATCH_ROUTES = [
  `${FINANCE}/receivable-sources/${UNKNOWN_ID}`,
  `${FINANCE}/customer-payments/${UNKNOWN_ID}`,
  `${FINANCE}/payable-entries/${UNKNOWN_ID}`,
  `${FINANCE}/supplier-payments/${UNKNOWN_ID}`,
];

/** 6 个真正返回业务列表（其余数组端点是无参筛选的摘要端点）。 */
const LIST_ROUTES = [
  `${FINANCE}/receivable-sources`,
  `${FINANCE}/customer-payments`,
  `${FINANCE}/receivable-adjustments`,
  `${FINANCE}/reconciliations`,
  `${FINANCE}/supplier-payments`,
  `${FINANCE}/supplier-payable-reconciliations`,
];

/** 6 个"无 order_no 即返回空数组"的摘要端点（finance.controller.ts:81-82、92、107 的三元表达式）。 */
const SUMMARY_ROUTES = [
  `${FINANCE}/order-summary`,
  `${FINANCE}/receivable-order-summary`,
  `${FINANCE}/payable-order-summary`,
  `${FINANCE}/order-close-preview`,
];

/**
 * 8 个"按 id 取详情"的 GET 路由及其 404 精确错误码。
 * 码来自各 service 的 notFound 抛点（不是全局默认的 NOT_FOUND）：
 *   receivable.service.ts:33 / :105 / :133（RECEIVABLE_SOURCE_NOT_FOUND，impact-preview 复用 get()）
 *   customer-payment.service.ts:17、receivable-adjustment.service.ts:38、
 *   reconciliation.service.ts:21、supplier-payable.service.ts:26、
 *   supplier-payment.service.ts:22、supplier-payable-reconciliation.service.ts:15
 */
const DETAIL_404_ROUTES = [
  { code: "RECEIVABLE_SOURCE_NOT_FOUND", path: `${FINANCE}/receivable-sources/${UNKNOWN_ID}` },
  { code: "RECEIVABLE_SOURCE_NOT_FOUND", path: `${FINANCE}/receivable-sources/${UNKNOWN_ID}/impact-preview` },
  { code: "CUSTOMER_PAYMENT_NOT_FOUND", path: `${FINANCE}/customer-payments/${UNKNOWN_ID}` },
  { code: "RECEIVABLE_ADJUSTMENT_NOT_FOUND", path: `${FINANCE}/receivable-adjustments/${UNKNOWN_ID}` },
  { code: "RECONCILIATION_NOT_FOUND", path: `${FINANCE}/reconciliations/${UNKNOWN_ID}` },
  { code: "SUPPLIER_PAYABLE_NOT_FOUND", path: `${FINANCE}/payable-entries/${UNKNOWN_ID}` },
  { code: "SUPPLIER_PAYMENT_NOT_FOUND", path: `${FINANCE}/supplier-payments/${UNKNOWN_ID}` },
  { code: "RECONCILIATION_NOT_FOUND", path: `${FINANCE}/supplier-payable-reconciliations/${UNKNOWN_ID}` },
];

/**
 * 17 个带 body DTO 的 POST 路由 + 4 个 PATCH 路由的校验层探测。
 * 全部使用**非法请求体**：ValidationPipe（main.ts:19-28，whitelist + forbidNonWhitelisted）在
 * service 之前就拒绝，因此不会触碰任何业务数据。
 * 用 `{ amount: 123 }` 而不是 `{}` 的原因：SourceDto / DraftFinanceUpdateDto 的字段全是 @IsOptional，
 * 空对象会通过校验并进入 service；改成类型错误才能停在管道层。
 */
const VALIDATION_PROBES = [
  { body: { amount: 123 }, method: "POST", path: `${FINANCE}/receivable-sources/from-outbound/${UNKNOWN_ID}` },
  { body: {}, method: "POST", path: `${FINANCE}/receivable-sources/${UNKNOWN_ID}/reopen` },
  { body: {}, method: "POST", path: `${FINANCE}/receivable-sources/${UNKNOWN_ID}/cancel` },
  { body: {}, method: "POST", path: `${FINANCE}/customer-payments` },
  { body: { allocations: "not-an-array" }, method: "POST", path: `${FINANCE}/customer-payments/${UNKNOWN_ID}/post` },
  { body: {}, method: "POST", path: `${FINANCE}/customer-payments/${UNKNOWN_ID}/reverse` },
  { body: {}, method: "POST", path: `${FINANCE}/receivable-adjustments` },
  { body: {}, method: "POST", path: `${FINANCE}/receivable-adjustments/${UNKNOWN_ID}/reverse` },
  { body: {}, method: "POST", path: `${FINANCE}/reconciliations` },
  { body: {}, method: "POST", path: `${FINANCE}/reconciliations/${UNKNOWN_ID}/resolve` },
  { body: {}, method: "POST", path: `${FINANCE}/payable-entries/${UNKNOWN_ID}/reopen` },
  { body: {}, method: "POST", path: `${FINANCE}/payable-entries/${UNKNOWN_ID}/reverse` },
  { body: {}, method: "POST", path: `${FINANCE}/supplier-payments` },
  { body: { allocations: "not-an-array" }, method: "POST", path: `${FINANCE}/supplier-payments/${UNKNOWN_ID}/post` },
  { body: {}, method: "POST", path: `${FINANCE}/supplier-payments/${UNKNOWN_ID}/reverse` },
  { body: {}, method: "POST", path: `${FINANCE}/supplier-payable-reconciliations` },
  { body: {}, method: "POST", path: `${FINANCE}/supplier-payable-reconciliations/${UNKNOWN_ID}/resolve` },
  { body: { amount: 123 }, method: "PATCH", path: `${FINANCE}/receivable-sources/${UNKNOWN_ID}` },
  { body: { amount: 123 }, method: "PATCH", path: `${FINANCE}/customer-payments/${UNKNOWN_ID}` },
  { body: { amount: 123 }, method: "PATCH", path: `${FINANCE}/payable-entries/${UNKNOWN_ID}` },
  { body: { amount: 123 }, method: "PATCH", path: `${FINANCE}/supplier-payments/${UNKNOWN_ID}` },
];

/**
 * 3 个**没有 body DTO** 的动作端点，校验层不存在，请求会真正抵达 service 并以 404 结束。
 * 逐一核对过代码，确认它们在 update 之前抛 notFound，因此对随机 UUID 的探测是只读的：
 *   receivable.service.ts:62-64（confirm）、receivable-adjustment.service.ts:78-80（post）、
 *   supplier-payable.service.ts:61-63（confirm）。
 */
const BODYLESS_ACTIONS = [
  { code: "RECEIVABLE_SOURCE_NOT_FOUND", path: `${FINANCE}/receivable-sources/${UNKNOWN_ID}/confirm` },
  { code: "RECEIVABLE_ADJUSTMENT_NOT_FOUND", path: `${FINANCE}/receivable-adjustments/${UNKNOWN_ID}/post` },
  { code: "SUPPLIER_PAYABLE_NOT_FOUND", path: `${FINANCE}/payable-entries/${UNKNOWN_ID}/confirm` },
];

/** 方法不匹配探测：后端没有 405，全部落到全局 not-found handler（NOT_FOUND + Cannot XXX 英文消息）。 */
const METHOD_MISMATCHES = [
  { method: "PUT", path: `${FINANCE}/customer-payments/${UNKNOWN_ID}` },
  { method: "DELETE", path: `${FINANCE}/receivable-sources/${UNKNOWN_ID}` },
  { method: "GET", path: `${FINANCE}/customer-payments/${UNKNOWN_ID}/post` },
];

/**
 * 每个用例内部建立自己的 admin 会话（约束 1），并抵御「其他 agent 同时以 admin 登录」造成的会话作废：
 * 收到 401 时丢弃 Cookie、重新登录后重放请求（最多 8 次，带退避）。
 * 只重放"已认证后本应返回 200/400/404"的请求：本文件所有已认证请求都不该出现 401，
 * 因此 401 只可能是并发登录踢人，而不是真实契约行为。
 */
function adminAgent() {
  let cookie = null;

  async function signIn() {
    const username = process.env.INITIAL_ADMIN_USERNAME;
    const password = process.env.INITIAL_ADMIN_PASSWORD;
    if (!username || !password) throw new Error("TEST_BLOCKED: INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required");
    const session = await login(baseUrl, { password, username });
    assert.equal(session.status, 201, `登录应返回 201（所有 POST 的默认状态码），实际 ${session.status}`);
    assert.ok(session.cookie, "登录必须下发 dilee_session Cookie");
    cookie = session.cookie;
    return session;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function request(path, options = {}) {
    let response;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!cookie) await signIn();
      response = await apiClient(baseUrl, { cookie }).request(path, options);
      if (response.status !== 401) return response;
      cookie = null; // 会话已被同库其他 agent 的登录删除（auth.service.ts:29），下一轮重新登录
      await sleep(25 * (attempt + 1));
    }
    return response;
  }

  const json = (path, method, payload) => request(path, { body: payload === undefined ? undefined : JSON.stringify(payload), method });

  return {
    get: (path, options) => request(path, options),
    patch: (path, payload) => json(path, "PATCH", payload),
    post: (path, payload) => json(path, "POST", payload),
    request,
  };
}

test("finance.route_table_matches_the_controller_size", () => {
  // 42 个路由 = 18 GET + 20 POST + 4 PATCH，与 finance.controller.ts:67-111 一一对应。
  // 控制器新增/删除路由时本用例会变红，提示同步更新上面的路由表与覆盖统计。
  assert.equal(READ_ROUTES.length, 18, "GET 路由数应为 18");
  assert.equal(POST_ROUTES.length, 20, "POST 路由数应为 20");
  assert.equal(PATCH_ROUTES.length, 4, "PATCH 路由数应为 4");
  assert.equal(READ_ROUTES.length + POST_ROUTES.length + PATCH_ROUTES.length, 42, "FinanceController 共 42 个路由");
});

test("finance.anonymous_requests_are_rejected_with_401_on_every_route", async () => {
  // 匿名探测是零风险的：AuthenticationGuard 在管道与 handler 之前抛 401（authentication.guard.ts:12 →
  // auth.service.ts:36-40），请求体根本不会被解析到 DTO。这里一次性覆盖全部 42 个路由的鉴权维度。
  const anonymous = apiClient(baseUrl);
  const probes = [
    ...READ_ROUTES.map((path) => ({ method: "GET", path })),
    ...POST_ROUTES.map((path) => ({ body: "{}", method: "POST", path })),
    ...PATCH_ROUTES.map((path) => ({ body: "{}", method: "PATCH", path })),
  ];
  assert.equal(probes.length, 42, "匿名探测必须覆盖全部 42 个路由");

  for (const { body, method, path } of probes) {
    const response = await anonymous.request(path, { body, method });
    expectUnauthenticated(response, `${method} ${path}`);
    expectRequestIdHeader(response, `${method} ${path}`);
  }
});

test("finance.list_and_summary_endpoints_return_bare_arrays_in_the_success_envelope", async () => {
  const agent = adminAgent();

  // 契约要点：列表端点的 data 是裸数组，不是 { items, total }；财务端点的 meta 当前恒为 {}。
  for (const path of [...LIST_ROUTES, ...SUMMARY_ROUTES]) {
    const response = await agent.get(path);
    const body = expectSuccessEnvelope(response, { context: path, status: 200 });
    assert.ok(Array.isArray(body.data), `${path} 的 data 必须是裸数组`);
    assert.deepEqual(body.meta, {}, `${path} 的 meta 当前为空对象（未发送 x-request-id 时 request_id 为 undefined 会被 JSON 丢弃）`);
    expectRequestIdHeader(response, path);
  }

  // 无 order_no 时四个摘要端点直接返回 []（控制器三元表达式，不查库）—— 与库中数据无关的确定性断言。
  for (const path of SUMMARY_ROUTES) {
    const body = expectSuccessEnvelope(await agent.get(path), { context: path });
    assert.deepEqual(body.data, [], `${path} 在缺少 order_no 时应返回空数组`);
  }
});

test("finance.detail_endpoints_return_404_with_their_resource_specific_code", async () => {
  const agent = adminAgent();

  for (const { code, path } of DETAIL_404_ROUTES) {
    const response = await agent.get(path);
    const body = expectErrorEnvelope(response, { context: path, code, status: 404 });
    assert.deepEqual(body.error.details, [], `${path} 的 notFound 抛点 details 固定为 []`);
    assert.equal(body.meta.path, path, "错误信封的 meta.path 是请求 URL");
    expectRequestIdHeader(response, path);
  }
});

test("finance.write_endpoints_reject_malformed_payloads_at_the_validation_layer", async () => {
  const agent = adminAgent();

  for (const { body: payload, method, path } of VALIDATION_PROBES) {
    const response = await agent.request(path, { body: JSON.stringify(payload), method });
    // 400 不保证通用码，但这批全部来自全局 ValidationPipe 的 exceptionFactory（main.ts:23-27）→ VALIDATION_ERROR。
    const body = expectValidationError(response, { code: "VALIDATION_ERROR", context: `${method} ${path}` });
    assert.ok(body.error.details.length > 0, `${method} ${path} 必须给出字段级 details`);
    for (const detail of body.error.details) {
      assert.equal(typeof detail.field, "string", `${method} ${path} 的 details 项应含 field`);
      assert.equal(typeof detail.rule, "string", `${method} ${path} 的 details 项应含 rule`);
      assert.equal(typeof detail.message, "string", `${method} ${path} 的 details 项应含 message`);
    }
  }

  // forbidNonWhitelisted（main.ts:22）：未知字段单独构成一条 whitelistValidation 明细。
  // 注意这**只对顶层字段成立** —— 嵌套数组元素不会被校验（见下一个用例）。
  for (const [method, path] of [["POST", `${FINANCE}/customer-payments`], ["POST", `${FINANCE}/payable-entries/${UNKNOWN_ID}/reverse`]]) {
    const body = expectValidationError(await agent.request(path, { body: JSON.stringify({ bogus_field: 1 }), method }), { context: `${method} ${path} (whitelist)` });
    assert.ok(
      body.error.details.some((detail) => detail.field === "bogus_field" && detail.rule === "whitelistValidation"),
      `${method} ${path} 应对未知字段给出 whitelistValidation 明细，实际 ${JSON.stringify(body.error.details)}`,
    );
  }
});

test("KNOWN_CONTRACT_DEFECT finance.nested_allocation_constraints_are_not_enforced_by_the_validation_pipe", async () => {
  // 期望：AllocationDto（finance.controller.ts:19）的 @IsUUID() receivable_source_id 与 @IsString() amount
  //   应当在 HTTP 边界被 ValidationPipe 拦下（400 VALIDATION_ERROR）。
  // 实际：PostPaymentDto.allocations 声明为 `@IsArray() allocations!: AllocationDto[]`（:20），
  //   但**没有 @ValidateNested({ each: true }) + @Type(() => AllocationDto)**，class-validator 只校验数组本身，
  //   元素级约束是死代码 —— `{ allocations: [{ amount: 1, receivable_source_id: "not-a-uuid" }] }`
  //   通过校验并抵达 service，最终由 service 的查找兜底返回 404。
  // 同类问题：SupplierAllocationDto / SupplierPostPaymentDto（:57-58）。
  // 影响有限（service 会二次校验存在性与金额），但 DTO 层的契约实际未被执行。
  // 修复（补 @ValidateNested）后本用例应变红：届时会返回 400 VALIDATION_ERROR。
  //
  // 只读安全性：customer-payment.service.ts:21-23 在任何事务/写入之前先查收款，随机 UUID 必然抛 notFound。
  const agent = adminAgent();
  const response = await agent.post(`${FINANCE}/customer-payments/${UNKNOWN_ID}/post`, {
    allocations: [{ amount: 1, receivable_source_id: "not-a-uuid" }],
  });

  assert.notEqual(response.status, 400, "嵌套元素约束当前不会触发 400（缺陷护栏）");
  expectErrorEnvelope(response, { code: "CUSTOMER_PAYMENT_NOT_FOUND", context: "nested allocation probe", status: 404 });
});

test("finance.bodyless_action_endpoints_have_no_validation_layer_and_fail_lookup_before_mutating", async () => {
  const agent = adminAgent();

  for (const { code, path } of BODYLESS_ACTIONS) {
    // 这三个路由没有 @Body 参数（finance.controller.ts:70、86、97），任何请求体都被忽略，
    // 请求直达 service；随机 UUID 命中 notFound，update 永不执行（抛点见 BODYLESS_ACTIONS 注释）。
    const body = expectErrorEnvelope(await agent.request(path, { method: "POST" }), { context: `POST ${path}`, code, status: 404 });
    assert.deepEqual(body.error.details, []);
  }
});

test("finance.unknown_query_params_are_silently_ignored", async () => {
  const agent = adminAgent();

  // 分裂行为（D9 家族）：FinanceController 的查询参数是 `@Query("order_no") orderNo?: string` 这类
  // 字符串字面量参数（finance.controller.ts:67、75、83…），运行时 metatype 是 String，
  // ValidationPipe 直接跳过 —— 未知参数与非法分页参数都被静默忽略，而不是像 DTO 型端点那样 400。
  for (const path of LIST_ROUTES) {
    const response = await agent.get(`${path}?bogus=1&page=0&page_size=201&sort=-created_at`);
    const body = expectSuccessEnvelope(response, { context: `${path} (unknown query)`, status: 200 });
    assert.ok(Array.isArray(body.data), `${path} 仍应返回裸数组`);
  }

  // 详情路由同样忽略未知参数，结果不变：仍然是同一个资源级 404。
  const detail = await agent.get(`${FINANCE}/customer-payments/${UNKNOWN_ID}?bogus=1`);
  expectErrorEnvelope(detail, { code: "CUSTOMER_PAYMENT_NOT_FOUND", context: "detail with unknown query", status: 404 });
});

test("finance.unsupported_methods_return_404_never_405", async () => {
  const agent = adminAgent();

  for (const { method, path } of METHOD_MISMATCHES) {
    const response = await agent.request(path, { method });
    // 全局 not-found handler 用的是默认码 NOT_FOUND（与业务模块自抛的 404 不同，见下一个用例）。
    const body = expectNotFound(response, `${method} ${path}`);
    assert.match(body.error.message, new RegExp(`^Cannot ${method} `), "方法不匹配的 message 是 Nest 生成的英文");
    assert.equal(body.meta.path, path);
  }

  const unknown = await agent.get(`${FINANCE}/does-not-exist`);
  expectNotFound(unknown, "unknown finance route");
});

test("KNOWN_CONTRACT_DEFECT finance.404_carries_resource_specific_codes_instead_of_the_global_NOT_FOUND", async () => {
  // 期望（docs/design/global-api-contract.md:59-69）：404 的默认码是 NOT_FOUND，
  //   且"更精确的大写下划线码"只被允许用于 409 / 422。
  // 实际：finance 的 8 个按 id 取详情的路由全部抛 NotFoundException({ code: "XXX_NOT_FOUND" }),
  //   返回 404 + 业务码；因此 harness 的 expectNotFound（固定 NOT_FOUND）在这些路由上**不成立**，
  //   而全局路由/方法不匹配仍然返回 NOT_FOUND —— 同一个 404 状态码出现两套码，前端无法只按状态码分发。
  // 责任文件：apps/api/src/modules/finance/receivable.service.ts:33（RECEIVABLE_SOURCE_NOT_FOUND）、
  //   customer-payment.service.ts:17、receivable-adjustment.service.ts:38、reconciliation.service.ts:21、
  //   supplier-payable.service.ts:26、supplier-payment.service.ts:22、supplier-payable-reconciliation.service.ts:15。
  // 修复（改为 NOT_FOUND 或把业务码下沉到 details）后本用例应变红，请同步更新本文件与 recon 记录。
  const agent = adminAgent();

  for (const { code, path } of DETAIL_404_ROUTES) {
    const response = await agent.get(path);
    assert.equal(response.status, 404, `${path} 期望 404，实际 ${response.status}`);
    assert.notEqual(response.body.error.code, "NOT_FOUND", `${path} 当前不使用全局 NOT_FOUND（缺陷护栏）`);
    assert.equal(response.body.error.code, code);
  }
});

test("KNOWN_CONTRACT_DEFECT finance.list_meta_omits_page_and_total", async () => {
  // 期望（docs/design/global-api-contract.md:35）：列表端点的 meta 必须包含 page / page_size / total。
  // 实际：FinanceController 的每个列表方法都硬编码 `meta: {}`（finance.controller.ts:67、75、83、88、101、108），
  //   且查询参数里没有任何分页 DTO，客户端只能一次拿到全量数据、无法翻页。
  // 修复（补 PaginationQueryDto + total）后本用例应变红，请同步更新。
  const agent = adminAgent();

  for (const path of LIST_ROUTES) {
    const body = expectSuccessEnvelope(await agent.get(path), { context: path });
    for (const field of ["page", "page_size", "total"]) {
      assert.equal(field in body.meta, false, `${path} 的 meta 当前缺少分页字段 ${field}（缺陷护栏）`);
    }
  }
});

test("finance.request_id_is_only_present_when_the_client_sends_the_header", async () => {
  const agent = adminAgent();

  // D2 在 finance 上的表现：RequestIdMiddleware 只写响应头（request-id.middleware.ts:7），
  // 而拦截器读的是请求头（response-envelope.interceptor.ts:9），所以 meta.request_id 只有在
  // 客户端自带 x-request-id 时才出现。追踪一律以响应头为准。
  const without = await agent.get(LIST_ROUTES[0]);
  expectSuccessEnvelope(without, { status: 200 });
  assert.equal("request_id" in without.body.meta, false, "未发送请求头时 meta 里不应出现 request_id");
  expectRequestIdHeader(without, "list without request id header");

  const withHeader = await agent.get(LIST_ROUTES[0], { headers: { "x-request-id": "finance-contract-probe" } });
  expectSuccessEnvelope(withHeader, { status: 200 });
  assert.equal(withHeader.body.meta.request_id, "finance-contract-probe", "客户端自带请求头时 meta.request_id 会回显");
  assert.equal(withHeader.requestId, "finance-contract-probe", "响应头同样回显客户端提供的 id");

  // 失败信封也一样：meta.request_id 由请求头决定，响应头原样回显（客户端提供了 id 时就不再是服务端生成的 UUID，
  // 因此这里不能用 expectRequestIdHeader 校验 UUID 形状）。
  const error = await agent.get(`${FINANCE}/receivable-sources/${UNKNOWN_ID}`, { headers: { "x-request-id": "finance-contract-error-probe" } });
  expectErrorEnvelope(error, { code: "RECEIVABLE_SOURCE_NOT_FOUND", status: 404 });
  assert.equal(error.body.meta.request_id, "finance-contract-error-probe");
  assert.equal(error.requestId, "finance-contract-error-probe");

  // 客户端不带请求头时，失败响应头仍由中间件生成 UUID。
  const generated = await agent.get(`${FINANCE}/receivable-sources/${UNKNOWN_ID}`);
  expectErrorEnvelope(generated, { code: "RECEIVABLE_SOURCE_NOT_FOUND", status: 404 });
  expectRequestIdHeader(generated, "detail 404 without request id header");
});

test("finance.non_administrators_without_the_finance_module_get_403", async (t) => {
  // 403 需要「会话有效但缺少 finance 模块权限」的用户，而 dev 库里只有 admin
  // （apps/api/prisma/seed.ts 只建 INITIAL_ADMIN_*；tests/fixtures/seed-users.cjs 的
  //  finance/noModule 操作员由测试自己种入，本文件被要求只读、不得创建数据）。
  // 因此这里显式环境门控：提供无 finance 权限的账号时断言 403 FORBIDDEN，否则跳过并如实标记未覆盖。
  const username = process.env.FINANCE_DENIED_USERNAME;
  const password = process.env.FINANCE_DENIED_PASSWORD;
  if (!username || !password) {
    t.skip("需要无 finance 权限的账号：设置 FINANCE_DENIED_USERNAME / FINANCE_DENIED_PASSWORD 后即可覆盖 403 维度");
    return;
  }

  const session = await login(baseUrl, { password, username });
  assert.equal(session.status, 201, `登录应返回 201，实际 ${session.status}`);
  const denied = apiClient(baseUrl, { cookie: session.cookie });

  // 类级 @RequireModules("finance") 对 GET / POST / PATCH 一视同仁（模块守卫在 handler 之前，module-permission.guard.ts:26）。
  expectForbidden(await denied.get(`${FINANCE}/receivable-sources`), "GET list without finance module");
  expectForbidden(await denied.request(`${FINANCE}/receivable-sources/${UNKNOWN_ID}/confirm`, { method: "POST" }), "POST action without finance module");
  expectForbidden(await denied.request(`${FINANCE}/receivable-sources/${UNKNOWN_ID}`, { body: JSON.stringify({ amount: 123 }), method: "PATCH" }), "PATCH without finance module");
});
