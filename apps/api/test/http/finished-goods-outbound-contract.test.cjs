// 成品出库 / 发货 / 签收 / 冲销 / 客户退货 —— HTTP 契约测试（只读探测）。
//
// 被测生产文件：apps/api/src/modules/warehouse/finished-goods-outbound.controller.ts
//   - 15 个路由；类级 @UseGuards(AuthenticationGuard, ModulePermissionGuard) + @RequireModules("warehouse")（:16-18）
//   - 列表端点手写 `{ data: [...], meta: {} }`（:22,:24,:33），详情/动作为 `{ data: row, meta: {} }`
//   - 写端点全部 @Post（默认 201），发货维护是 @Patch（200）
//
// 运行（**必须串行**；本 API 是单会话的：auth.service.ts:28-31 登录会先删该用户全部 session，
// 并发以 admin 登录会互相踢掉 → 随机 401）：
//   node --test --test-concurrency=1 apps/api/test/http/finished-goods-outbound-contract.test.cjs
//
// 测试纪律（本文件严格遵守）：
//   1. 只做只读探测：GET、匿名 401、随机 UUID 的 404、以及「必然在写库之前抛错」的写请求。
//   2. 不创建/修改/删除任何业务数据 —— 合法业务数据一律不提交。已验证：
//      下面所有写请求要么被 ValidationPipe 拦下（400），要么在 service 里于 create 之前抛 404/422
//      （finished-goods-outbound.service.ts:23/99/118/155/169/189/216/226/245/264）。
//   3. 每个用例内部自己登录一次并立即使用，不跨用例共享 cookie（单会话约束）。
//
// 期望值全部来自对运行中 API（http://127.0.0.1:3001，全局前缀 /api/v1）的实测。

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const {
  apiClient,
  login,
  expectBusinessRuleViolation,
  expectErrorEnvelope,
  expectNotFound,
  expectRequestIdHeader,
  expectSuccessEnvelope,
  expectUnauthenticated,
  expectValidationError,
} = require("../../../../tests/helpers/api-client.cjs");

const baseUrl = process.env.API_BASE_URL;

/** 真实登录一次，返回带 cookie 的客户端。凭据缺失时明确报 TEST_BLOCKED。 */
async function adminClient() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) throw new Error("TEST_BLOCKED: INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required");
  const session = await login(baseUrl, { password, username });
  assert.equal(session.status, 201, `登录应返回 201（所有 POST 的默认状态码），实际 ${session.status}：${JSON.stringify(session.body)}`);
  assert.ok(session.cookie, "登录必须下发 dilee_session Cookie");
  return apiClient(baseUrl, { cookie: session.cookie });
}

/** 单会话 API 下，被并发登录踢掉时的重试次数与退避（含抖动的固定延迟）。 */
const SESSION_RETRY_ATTEMPTS = 5;
const SESSION_RETRY_DELAY_MS = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 已认证会话（抗「被并发登录踢掉」）。
 *
 * 本 API 单会话：任何人以 admin 登录都会删除该用户全部 session（auth.service.ts:28-31）。
 * 多个测试进程并行以 admin 登录时，本进程刚拿到的 cookie 随时会失效 → 已认证请求偶发 401，
 * 这与被测契约无关（本文件对 401 的断言只出现在匿名 / 无效 cookie 用例里，走的是另一条路径）。
 * 因此已认证请求收到 401 时**重新登录并重试**（最多 SESSION_RETRY_ATTEMPTS 次，带退避）。
 * 用尽仍 401 时抛出显式的环境冲突错误，避免把它误读成契约缺陷。
 */
async function adminSession() {
  let client = await adminClient();
  const raw = async (method, path, body) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let response = await client.raw(path, { body: payload, method });
    for (let attempt = 1; attempt <= SESSION_RETRY_ATTEMPTS && response.status === 401; attempt += 1) {
      await sleep(SESSION_RETRY_DELAY_MS + Math.floor(Math.random() * SESSION_RETRY_DELAY_MS));
      client = await adminClient();
      response = await client.raw(path, { body: payload, method });
    }
    if (response.status === 401) {
      throw new Error(`TEST_ENV_COLLISION: 已认证 ${method} ${path} 在 ${SESSION_RETRY_ATTEMPTS} 次重新登录后仍返回 401 —— 单会话 API（auth.service.ts:28-31）被其它测试进程的并发 admin 登录持续踢掉，请在无并发测试时重跑`);
    }
    return response;
  };
  return {
    get: (path) => raw("GET", path),
    patch: (path, body) => raw("PATCH", path, body),
    post: (path, body) => raw("POST", path, body),
    raw,
  };
}

/** 15 个路由（finished-goods-outbound.controller.ts:22-37）。 */
const ROUTES = [
  { method: "GET", path: "/api/v1/finished-goods/outbound-notices" },
  { method: "POST", path: "/api/v1/finished-goods/outbound-notices/:id/create-outbound" },
  { method: "GET", path: "/api/v1/finished-goods/outbounds" },
  { method: "GET", path: "/api/v1/finished-goods/outbounds/:id" },
  { method: "POST", body: { quantity: "1", production_order_id: randomUUID(), sales_order_id: randomUUID() }, path: "/api/v1/finished-goods/outbounds" },
  { method: "POST", path: "/api/v1/finished-goods/outbounds/:id/post" },
  { method: "POST", body: { reason: "contract-probe" }, path: "/api/v1/finished-goods/outbounds/:id/cancel" },
  { method: "PATCH", body: {}, path: "/api/v1/finished-goods/outbounds/:id/shipping" },
  { method: "POST", body: { signed_at: "2026-01-01T00:00:00.000Z" }, path: "/api/v1/finished-goods/outbounds/:id/sign" },
  { method: "POST", body: { reason: "contract-probe" }, path: "/api/v1/finished-goods/outbounds/:id/reverse" },
  { method: "GET", path: "/api/v1/finished-goods/customer-returns" },
  { method: "GET", path: "/api/v1/finished-goods/customer-returns/:id" },
  { method: "POST", body: { destination: "finished_goods", production_order_id: randomUUID(), quantity: "1", reason: "contract-probe", return_date: "2026-01-01", sales_order_id: randomUUID() }, path: "/api/v1/finished-goods/customer-returns" },
  { method: "POST", path: "/api/v1/finished-goods/customer-returns/:id/post" },
  { method: "POST", body: { reason: "contract-probe" }, path: "/api/v1/finished-goods/customer-returns/:id/reverse" },
];

/** 校验错误 details 的字段名集合（details 形状：{ field, rule, message }，global-api-contract.md:55）。 */
const detailFields = (response) => response.body.error.details.map((detail) => detail.field);

/** 找到某个字段的校验项，用于断言 rule（如 isUuid / whitelistValidation）。 */
function detailFor(response, field) {
  const detail = response.body.error.details.find((item) => item.field === field);
  assert.ok(detail, `details 中应包含字段 ${field}；实际 ${JSON.stringify(response.body.error.details)}`);
  assert.equal(typeof detail.rule, "string", `details[${field}].rule 必须是字符串`);
  assert.equal(typeof detail.message, "string", `details[${field}].message 必须是字符串`);
  return detail;
}

test("finished-goods-outbound.anonymous_requests_are_rejected_with_401_on_all_15_routes", async () => {
  // 匿名请求在 guard 阶段就被拒（authentication.guard.ts:12 + auth.service.ts:36-40 抛 UnauthorizedException），
  // 因此即使 body 非法也不会变成 400。本用例不登录（也就不受单会话约束影响）。
  const anonymous = apiClient(baseUrl);
  assert.equal(ROUTES.length, 15, "控制器共 15 个路由，路由表必须与控制器保持一致");
  for (const route of ROUTES) {
    const path = route.path.replace(":id", randomUUID());
    const response = await anonymous.raw(path, { body: route.body === undefined ? undefined : JSON.stringify(route.body), method: route.method });
    expectUnauthenticated(response, `匿名 ${route.method} ${path}`);
    assert.equal(response.body.meta.path, path, `${path} 的 meta.path 必须回显实际请求路径`);
    expectRequestIdHeader(response, `匿名 ${route.method} ${path}`);
  }
});

test("finished-goods-outbound.authenticated_request_with_invalid_session_cookie_is_401", async () => {
  // 会话无效 → 401（auth.service.ts:38-39）；403 只用于「已认证但无模块权限」
  // （module-permission.guard.ts:26）。403 维度本文件**未覆盖**：环境只提供 admin 凭据，
  // 造一个「无 warehouse 权限的登录用户」属于写数据，超出只读探测范围。
  const stale = apiClient(baseUrl, { token: "not-a-real-session-token" });
  expectUnauthenticated(await stale.get("/api/v1/finished-goods/outbounds"), "无效 cookie");
});

test("finished-goods-outbound.list_routes_return_success_envelope_with_bare_array_data", async () => {
  const client = await adminSession();
  const lists = ["/api/v1/finished-goods/outbound-notices", "/api/v1/finished-goods/outbounds", "/api/v1/finished-goods/customer-returns"];
  for (const path of lists) {
    const response = await client.get(path);
    const body = expectSuccessEnvelope(response, { context: `GET ${path}`, status: 200 });
    assert.ok(Array.isArray(body.data), `${path} 的 data 必须是裸数组（列表数据不放 meta）`);
    // 现状：这三个列表端点**不分页**，meta 是硬编码的空对象（controller:22,24,33），
    // 因此 meta 里没有 page / page_size / total（与 global-api-contract.md:35 的差别见下一个用例）。
    assert.equal(typeof body.meta, "object");
    for (const field of ["page", "page_size", "total"]) assert.equal(field in body.meta, false, `${path} 当前不分页，meta 不应出现 ${field}`);
    expectRequestIdHeader(response, `GET ${path}`);
  }
});

test("KNOWN_DEFECT I7/I9: pagination params are silently ignored instead of validated", async () => {
  // 期望（docs/design/global-api-contract.md:19,35）：
  //   列表查询使用 page / page_size，page_size 范围 1-200，分页校验失败 → 400 VALIDATION_ERROR；
  //   列表响应的 meta 应包含 page / page_size / total。
  // 实际：controller 用的是逐个参数提取 `@Query("order_no")`（controller:22,24,33），
  //   没有任何 DTO 类，ValidationPipe 完全不介入 → page_size=201 / page=0 / 未知参数一律 **静默忽略并返回 200**，
  //   meta 恒为 {}。已在 docs/test/00-recon-api-contract.md §6.4/§6.5（I7、I9）记录为已知不一致。
  // 若哪天这些端点接上 PaginationQueryDto，本用例会变红 —— 那是修复信号，请同步更新 recon 与文档。
  const client = await adminSession();
  for (const query of ["page_size=201", "page_size=0", "page=0", "page_size=abc", "bogus=1"]) {
    const response = await client.get(`/api/v1/finished-goods/outbounds?${query}`);
    expectSuccessEnvelope(response, { context: `GET outbounds?${query}`, status: 200 });
    assert.equal("page" in response.body.meta, false, `?${query} 被静默忽略（当前行为）`);
  }
  // 过滤参数本身被接受但**不做枚举校验**：status 直接进 Prisma where（service.ts:39），未知值静默返回空集。
  const rawStatus = await client.get("/api/v1/finished-goods/outbound-notices?status=not-a-real-status");
  expectSuccessEnvelope(rawStatus, { context: "outbound-notices?status=not-a-real-status", status: 200 });
  assert.ok(Array.isArray(rawStatus.body.data), "未知 status 不会 400，而是静默返回数组（当前行为）");
  const orderNo = await client.get("/api/v1/finished-goods/customer-returns?order_no=CONTRACT-PROBE-NO-SUCH-ORDER");
  expectSuccessEnvelope(orderNo, { context: "customer-returns?order_no=...", status: 200 });
  assert.ok(Array.isArray(orderNo.body.data), "order_no 过滤被接受（不存在时返回空数组）");
});

test("finished-goods-outbound.detail_routes_return_module_specific_404_codes", async () => {
  const client = await adminSession();
  const cases = [
    { code: "FINISHED_GOODS_OUTBOUND_NOT_FOUND", path: (id) => `/api/v1/finished-goods/outbounds/${id}` },
    { code: "CUSTOMER_RETURN_NOT_FOUND", path: (id) => `/api/v1/finished-goods/customer-returns/${id}` },
  ];
  for (const item of cases) {
    const path = item.path(randomUUID());
    const response = await client.get(path);
    expectErrorEnvelope(response, { code: item.code, context: `GET ${path}`, status: 404 });
    // 404 的 code 由业务模块给出（service.ts:19,20），不是通用 NOT_FOUND；details 为空数组。
    assert.deepEqual(response.body.error.details, [], `${path} 的 404 details 应为空数组`);
    assert.equal(response.body.meta.path, path, "错误信封的 meta.path 必须回显请求路径");
    expectRequestIdHeader(response, `GET ${path}`);
  }
});

test("finished-goods-outbound.post_actions_on_unknown_ids_fail_before_mutating_state", async () => {
  // 这些 POST/PATCH 都是写操作，但随机 UUID 让 service 在 **create/update 之前**就抛 404
  // （service.ts:56 通知不存在、:118 出库单不存在、:100-101 cancel 前置查询、:155/:169 前置查询、
  //  :226/:245 退货单不存在），因此不会写入任何数据。
  const client = await adminSession();
  const cases = [
    { code: "FINISHED_GOODS_OUTBOUND_NOT_FOUND", method: "POST", path: (id) => `/api/v1/finished-goods/outbounds/${id}/post` },
    { code: "FINISHED_GOODS_OUTBOUND_NOT_FOUND", body: { reason: "contract-probe" }, method: "POST", path: (id) => `/api/v1/finished-goods/outbounds/${id}/cancel` },
    { code: "FINISHED_GOODS_OUTBOUND_NOT_FOUND", body: {}, method: "PATCH", path: (id) => `/api/v1/finished-goods/outbounds/${id}/shipping` },
    { code: "FINISHED_GOODS_OUTBOUND_NOT_FOUND", body: { signed_at: "2026-01-01T00:00:00.000Z" }, method: "POST", path: (id) => `/api/v1/finished-goods/outbounds/${id}/sign` },
    { code: "FINISHED_GOODS_OUTBOUND_NOT_FOUND", body: { reason: "contract-probe" }, method: "POST", path: (id) => `/api/v1/finished-goods/outbounds/${id}/reverse` },
    { code: "OUTBOUND_NOTICE_NOT_FOUND", method: "POST", path: (id) => `/api/v1/finished-goods/outbound-notices/${id}/create-outbound` },
    { code: "CUSTOMER_RETURN_NOT_FOUND", method: "POST", path: (id) => `/api/v1/finished-goods/customer-returns/${id}/post` },
    { code: "CUSTOMER_RETURN_NOT_FOUND", body: { reason: "contract-probe" }, method: "POST", path: (id) => `/api/v1/finished-goods/customer-returns/${id}/reverse` },
  ];
  for (const item of cases) {
    const path = item.path(randomUUID());
    const response = await client.raw(item.method, path, item.body);
    expectErrorEnvelope(response, { code: item.code, context: `${item.method} ${path}`, status: 404 });
  }
});

test("finished-goods-outbound.missing_reason_is_a_422_business_rule_violation", async () => {
  // 原因必填在 service 里、且在单据存在性查询**之前**校验（service.ts:99 / :188 / :243），
  // 所以这些断言不依赖库里有没有数据，也不会碰到任何业务单据。
  const client = await adminSession();
  const id = randomUUID();

  const cancel = await client.post(`/api/v1/finished-goods/outbounds/${id}/cancel`, { reason: "   " });
  expectBusinessRuleViolation(cancel, { code: "CANCELLATION_REASON_REQUIRED", context: "cancel 空原因" });
  assert.deepEqual(cancel.body.error.details, [], "422 的 details 在这里是空数组");

  const reverseOutbound = await client.post(`/api/v1/finished-goods/outbounds/${id}/reverse`, { reason: "" });
  expectBusinessRuleViolation(reverseOutbound, { code: "REVERSAL_REASON_REQUIRED", context: "出库冲销空原因" });

  const reverseReturn = await client.post(`/api/v1/finished-goods/customer-returns/${id}/reverse`, { reason: "  " });
  expectBusinessRuleViolation(reverseReturn, { code: "REVERSAL_REASON_REQUIRED", context: "退货冲销空原因" });
  // 422 使用业务模块自己的大写码（global-api-contract.md:69），不是通用 BUSINESS_RULE_VIOLATION。
  for (const response of [cancel, reverseOutbound, reverseReturn]) assert.notEqual(response.body.error.code, "BUSINESS_RULE_VIOLATION");
});

test("finished-goods-outbound.create_outbound_validates_dto_at_the_guard_layer", async () => {
  const client = await adminSession();

  const empty = await client.post("/api/v1/finished-goods/outbounds", {});
  expectValidationError(empty, { code: "VALIDATION_ERROR", context: "POST outbounds {}" });
  for (const field of ["sales_order_id", "production_order_id", "quantity"]) detailFor(empty, field);
  assert.equal(detailFor(empty, "sales_order_id").rule, "isUuid");
  assert.equal(detailFor(empty, "quantity").rule, "isString", "数量以十进制字符串传输，不是 number（global-api-contract.md:18）");

  // 未知字段被 whitelist 拒绝（main.ts:19-22 开了 whitelist + forbidNonWhitelisted）。
  const unknownField = await client.post("/api/v1/finished-goods/outbounds", { bogus: 1 });
  expectValidationError(unknownField, { context: "POST outbounds 未知字段" });
  assert.equal(detailFor(unknownField, "bogus").rule, "whitelistValidation");

  // 类型错误：quantity 传 number → 400 isString（校验层拦下，不会进业务层）。
  const wrongType = await client.post("/api/v1/finished-goods/outbounds", { production_order_id: randomUUID(), quantity: 5, sales_order_id: randomUUID() });
  expectValidationError(wrongType, { context: "POST outbounds quantity=number" });
  assert.deepEqual(detailFields(wrongType), ["quantity"]);
});

test("finished-goods-outbound.create_customer_return_validates_dto_at_the_guard_layer", async () => {
  const client = await adminSession();

  const empty = await client.post("/api/v1/finished-goods/customer-returns", {});
  expectValidationError(empty, { code: "VALIDATION_ERROR", context: "POST customer-returns {}" });
  for (const field of ["sales_order_id", "production_order_id", "quantity", "return_date", "destination", "reason"]) detailFor(empty, field);

  const badDestination = await client.post("/api/v1/finished-goods/customer-returns", {
    destination: "bogus-destination", production_order_id: randomUUID(), quantity: "1", reason: "probe", return_date: "2026-01-01", sales_order_id: randomUUID(),
  });
  expectValidationError(badDestination, { context: "POST customer-returns 非法 destination" });
  assert.equal(detailFor(badDestination, "destination").rule, "isIn");

  // 长度边界：reason 有 @MaxLength(1000) → 1001 字符是 400（不是 422）。
  const tooLong = await client.post("/api/v1/finished-goods/customer-returns", {
    destination: "finished_goods", production_order_id: randomUUID(), quantity: "1", reason: "x".repeat(1001), return_date: "2026-01-01", sales_order_id: randomUUID(),
  });
  expectValidationError(tooLong, { context: "POST customer-returns reason 超长" });
  assert.equal(detailFor(tooLong, "reason").rule, "maxLength");
});

test("finished-goods-outbound.shipping_and_sign_reject_malformed_dates", async () => {
  const client = await adminSession();
  const id = randomUUID();

  // PATCH /shipping：@IsDateString() shipment_date（controller:11）
  const badShipment = await client.patch(`/api/v1/finished-goods/outbounds/${id}/shipping`, { shipment_date: "not-a-date" });
  expectValidationError(badShipment, { context: "PATCH shipping shipment_date 非法" });
  assert.equal(detailFor(badShipment, "shipment_date").rule, "isDateString");

  // POST /sign：@IsDateString() signed_at（controller:12）；非法日期在校验层就 400，
  // 不会走到 service.ts:172 的 INVALID_SIGNED_AT（那个分支只在 signedAt 为 NaN 时可达，属防御性代码）。
  const badSignedAt = await client.post(`/api/v1/finished-goods/outbounds/${id}/sign`, { signed_at: "2026-13-45" });
  expectValidationError(badSignedAt, { context: "POST sign signed_at 非法" });
  assert.equal(detailFor(badSignedAt, "signed_at").rule, "isDateString");
});

test("finished-goods-outbound.well_formed_writes_with_unknown_references_are_404_not_500", async () => {
  // 引用校验先于任何写库（service.ts:264 throw OUTBOUND_REFERENCE_NOT_FOUND），
  // 所以这里提交「形状完全合法但引用不存在」的请求是安全的：不会创建任何单据。
  const salesOrderId = randomUUID();
  const productionOrderId = randomUUID();
  const client = await adminSession();

  const outbound = await client.post("/api/v1/finished-goods/outbounds", { production_order_id: productionOrderId, quantity: "1", sales_order_id: salesOrderId });
  expectErrorEnvelope(outbound, { code: "OUTBOUND_REFERENCE_NOT_FOUND", context: "POST outbounds 引用不存在", status: 404 });

  const customerReturn = await client.post("/api/v1/finished-goods/customer-returns", {
    destination: "finished_goods", production_order_id: productionOrderId, quantity: "1", reason: "contract-probe", return_date: "2026-01-01", sales_order_id: salesOrderId,
  });
  expectErrorEnvelope(customerReturn, { code: "OUTBOUND_REFERENCE_NOT_FOUND", context: "POST customer-returns 引用不存在", status: 404 });
});

test("finished-goods-outbound.wrong_method_and_unknown_subpath_are_404_never_405", async () => {
  // 后端没有 405：方法不匹配落到 Nest 的 not-found handler（message 为英文 Cannot XXX ...）。
  const client = await adminSession();
  const id = randomUUID();
  const cases = [
    { method: "DELETE", message: /^Cannot DELETE/, path: "/api/v1/finished-goods/outbounds" },
    { body: {}, method: "PUT", message: /^Cannot PUT/, path: "/api/v1/finished-goods/outbound-notices" },
    { method: "PATCH", message: /^Cannot PATCH/, path: "/api/v1/finished-goods/customer-returns" },
    { method: "GET", message: /^Cannot GET/, path: `/api/v1/finished-goods/outbounds/${id}/post` },
    { method: "GET", message: /^Cannot GET/, path: "/api/v1/finished-goods/no-such-subpath" },
  ];
  for (const item of cases) {
    const response = await client.raw(item.method, item.path, item.body);
    expectNotFound(response, `${item.method} ${item.path}`);
    assert.match(response.body.error.message, item.message, `${item.method} ${item.path} 的 message 应由 Nest 生成（英文 Cannot ...）`);
  }
});

test("finished-goods-outbound.request_id_header_is_present_on_success_and_failure", async () => {
  // meta.request_id 恒缺（拦截器读请求头，见 contract-guardrails 的 D2），
  // 唯一可靠的关联 id 是响应头 x-request-id（request-id.middleware.ts:7）。
  expectRequestIdHeader(await apiClient(baseUrl).get("/api/v1/finished-goods/outbounds"), "匿名 401");

  const client = await adminSession();
  expectRequestIdHeader(await client.get("/api/v1/finished-goods/outbounds"), "已认证 200");
  expectRequestIdHeader(await client.get(`/api/v1/finished-goods/outbounds/${randomUUID()}`), "已认证 404");
  expectRequestIdHeader(await client.post("/api/v1/finished-goods/outbounds", {}), "已认证 400");
});
