// 销售单 HTTP 契约测试 —— sales-orders.controller.ts（12 个路由）。
//
// 覆盖维度：成功/失败信封、状态码（200/201/204 不可写路径 → 401/400/404/422/500）、
//   鉴权（匿名 401）、DTO 校验（body 与 query）、404（不存在的 id / 路由方法不匹配无 405）、
//   只读成功路径（详情 / 影响预览 / 成品出入库情况）、x-request-id 响应头、error.meta.path。
//
// 不覆盖（避免重复或受只读约束）：
//   - 分页边界与 page_size 转换：已由 sales-orders-pagination-http.test.cjs 覆盖；
//   - 写操作成功路径（POST/PATCH 返回 201/200 并落库）：多 agent 共用同一个库，禁止写入，
//     因此写端点只断言鉴权 / 校验 / 404 层。
//
// 环境约束（必须遵守，否则随机失败）：
//   1) 本 API 单会话：AuthService.login() 先删该用户全部 session 再建新的（auth.service.ts:29），
//      同一用户名并发登录会互相踢掉 → 每个用例**自己登录一次并立即使用**，禁止跨用例共享 Cookie，
//      运行必须串行：node --test --test-concurrency=1 apps/api/test/http/sales-orders-contract.test.cjs
//   2) 其他 agent 会在同一实例上并发以 admin 登录，可能在本用例中途作废 Cookie（实测发生过）。
//      因此 sessionClient() 在每个请求前确保持有最新会话，并在收到 401 时换新会话重试
//      （最多 MAX_ATTEMPTS 次）—— 真正的 401 契约由**匿名客户端**断言，不会被重试掩盖；
//      若鉴权真的坏了，重试到上限后同样会失败。
//   3) 只读探测：本文件不创建/修改/删除任何业务数据。

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  apiClient,
  expectBusinessRuleViolation,
  expectErrorEnvelope,
  expectRequestIdHeader,
  expectSuccessEnvelope,
  expectUnauthenticated,
  expectValidationError,
  login,
} = require("../../../../tests/helpers/api-client.cjs");

const baseUrl = process.env.API_BASE_URL;
if (!baseUrl) throw new Error("TEST_BLOCKED: API_BASE_URL is required（例如 http://127.0.0.1:3001）");

/** 规范 UUID 但库中必然不存在（nil uuid）—— 用于 404 探测，不做任何写入。 */
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
/** 非 UUID 的 id 段：验证 id 参数是否被 UUID 校验拦下（见文件末尾 KNOWN_CONTRACT_DEFECT 用例）。 */
const NON_UUID_ID = "not-a-uuid";

/** sales-orders.controller.ts 的全部 12 个路由。 */
const ROUTES = [
  { label: "GET /", method: "get", path: "/api/v1/sales-orders" },
  { label: "POST /", method: "post", path: "/api/v1/sales-orders", payload: {} },
  { label: "GET /finished-goods-summary", method: "get", path: "/api/v1/sales-orders/finished-goods-summary" },
  { label: "GET /:id/impact-preview", method: "get", path: `/api/v1/sales-orders/${UNKNOWN_ID}/impact-preview` },
  { label: "GET /:id/finished-goods", method: "get", path: `/api/v1/sales-orders/${UNKNOWN_ID}/finished-goods` },
  { label: "POST /:id/outbound-notices", method: "post", path: `/api/v1/sales-orders/${UNKNOWN_ID}/outbound-notices`, payload: {} },
  { label: "POST /:id/outbound-notices/:noticeId/cancel", method: "post", path: `/api/v1/sales-orders/${UNKNOWN_ID}/outbound-notices/${UNKNOWN_ID}/cancel`, payload: { reason: "contract-probe" } },
  { label: "GET /:id", method: "get", path: `/api/v1/sales-orders/${UNKNOWN_ID}` },
  { label: "PATCH /:id", method: "patch", path: `/api/v1/sales-orders/${UNKNOWN_ID}`, payload: {} },
  { label: "POST /:id/confirm", method: "post", path: `/api/v1/sales-orders/${UNKNOWN_ID}/confirm`, payload: {} },
  { label: "POST /:id/revert-draft", method: "post", path: `/api/v1/sales-orders/${UNKNOWN_ID}/revert-draft`, payload: { reason: "contract-probe" } },
  { label: "POST /:id/close", method: "post", path: `/api/v1/sales-orders/${UNKNOWN_ID}/close`, payload: {} },
];

/** 每用例独立登录（约束 1）。登录本身顺带覆盖「POST 默认 201」。 */
async function adminSession() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) throw new Error("TEST_BLOCKED: INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required");
  const session = await login(baseUrl, { password, username });
  assert.equal(session.status, 201, `登录应返回 201（所有 POST 的默认状态码），实际 ${session.status}：${JSON.stringify(session.body)}`);
  assert.ok(session.cookie, "登录必须下发 dilee_session Cookie");
  return session;
}

/**
 * 已认证客户端：每个请求前确保持有最新会话；收到 401（被其他 agent 的并发登录踢掉，约束 2）
 * 就换一个新会话重试，最多 MAX_ATTEMPTS 次。
 *
 * 为什么需要：本 API 单会话，登录一次就作废该用户此前所有会话。同目录下其他 agent 也在以
 * admin 登录，实测一个用例中途 Cookie 就会失效；只重试一次仍会输给更密的登录竞争。
 * 这不掩盖缺陷：真正的 401 契约由**匿名客户端**断言（anonymous_access 用例），
 * 若鉴权真的坏了，5 次重试后仍会失败。
 */
const MAX_ATTEMPTS = 5;
function sessionClient() {
  let cookie;
  async function call(method, path, payload) {
    let response;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (!cookie) cookie = (await adminSession()).cookie;
      response = await apiClient(baseUrl, { cookie })[method](path, payload);
      if (response.status !== 401) return response;
      cookie = undefined;
    }
    return response;
  }
  return {
    get: (path) => call("get", path),
    patch: (path, payload) => call("patch", path, payload),
    post: (path, payload) => call("post", path, payload),
    put: (path, payload) => call("put", path, payload),
    del: (path, payload) => call("del", path, payload),
  };
}

/** 断言 400 校验错误并按字段定位（前端只需依赖 code，字段名用于可定位性）。 */
function expectFieldValidation(response, field, context) {
  const body = expectValidationError(response, { code: "VALIDATION_ERROR", context });
  assert.ok(body.error.details.length > 0, `${context} 应给出字段级 details`);
  assert.ok(
    body.error.details.some((detail) => detail.field === field),
    `${context} details 应包含字段 ${field}，实际 ${JSON.stringify(body.error.details)}`,
  );
  return body;
}

/**
 * 断言 404 并显式校验业务码。
 * 注意：404 与 409/422 一样**不保证**使用通用码 NOT_FOUND —— 业务模块用更精确的大写下划线码
 * （global-api-contract.md:69），本模块会抛 SALES_ORDER_NOT_FOUND / CUSTOMER_NOT_FOUND /
 * OUTBOUND_NOTICE_NOT_FOUND，所以这里不能用 expectNotFound（它固定断言 NOT_FOUND）。
 */
function expectNotFoundWithCode(response, code, context) {
  const body = expectErrorEnvelope(response, { code, context, status: 404 });
  assert.ok(body.error.message.length > 0, `${context} error.message 不应为空`);
  return body;
}

// ---------------------------------------------------------------------------
// 鉴权：匿名访问 12 个路由必须全部 401 UNAUTHENTICATED
// ---------------------------------------------------------------------------
test("sales_orders.anonymous_access_is_rejected_on_all_twelve_routes", async () => {
  const anonymous = apiClient(baseUrl); // 无 Cookie
  for (const route of ROUTES) {
    const response = route.method === "get" ? await anonymous.get(route.path) : await anonymous[route.method](route.path, route.payload);
    expectUnauthenticated(response, `匿名 ${route.label}`);
  }
});

// ---------------------------------------------------------------------------
// 列表 query DTO：本控制器用的是 DTO 类（非 TS 字面量），未知参数必须被白名单拦下
// （对照 contract-guardrails.test.cjs 的 D9：字面量型 query 会静默忽略 —— 本模块不属于那一类）
// ---------------------------------------------------------------------------
test("sales_orders.list_query_dto_rejects_unknown_params_with_field_details", async () => {
  const client = sessionClient();
  const response = await client.get("/api/v1/sales-orders?bogus=1");
  const body = expectValidationError(response, { code: "VALIDATION_ERROR", context: "GET /?bogus=1" });
  assert.equal(body.error.details[0].field, "bogus");
  assert.equal(body.error.details[0].rule, "whitelistValidation");
  // 分页边界（page_size 1..200 / page>=1）由 sales-orders-pagination-http.test.cjs 覆盖，此处不重复。
});

// ---------------------------------------------------------------------------
// 404：不存在的销售单 id（规范 UUID）在所有读/写路由上都走同一业务码
// ---------------------------------------------------------------------------
test("sales_orders.unknown_id_returns_not_found_on_every_id_route", async () => {
  const client = sessionClient();

  // 查询类：get(id) 先抛 SALES_ORDER_NOT_FOUND（sales-orders.service.ts:22）
  for (const path of [`/api/v1/sales-orders/${UNKNOWN_ID}`, `/api/v1/sales-orders/${UNKNOWN_ID}/impact-preview`, `/api/v1/sales-orders/${UNKNOWN_ID}/finished-goods`]) {
    expectNotFoundWithCode(await client.get(path), "SALES_ORDER_NOT_FOUND", `GET ${path}`);
  }

  // 状态流转与更新类：同样先 get(id)
  expectNotFoundWithCode(await client.patch(`/api/v1/sales-orders/${UNKNOWN_ID}`, {}), "SALES_ORDER_NOT_FOUND", "PATCH /:id");

  for (const [method, path, payload] of [
    ["post", `/api/v1/sales-orders/${UNKNOWN_ID}/confirm`, {}],
    ["post", `/api/v1/sales-orders/${UNKNOWN_ID}/revert-draft`, { reason: "contract-probe" }],
    ["post", `/api/v1/sales-orders/${UNKNOWN_ID}/close`, {}],
    ["post", `/api/v1/sales-orders/${UNKNOWN_ID}/outbound-notices`, {}],
  ]) {
    expectNotFoundWithCode(await client[method](path, payload), "SALES_ORDER_NOT_FOUND", `${method.toUpperCase()} ${path}`);
  }

  // 取消通知不走 requireOrder：查不到通知时给的是通知级业务码（finished-goods-outbound-notice.service.ts:140）
  expectNotFoundWithCode(await client.post(`/api/v1/sales-orders/${UNKNOWN_ID}/outbound-notices/${UNKNOWN_ID}/cancel`, { reason: "contract-probe" }), "OUTBOUND_NOTICE_NOT_FOUND", "POST /:id/outbound-notices/:noticeId/cancel");
});

// ---------------------------------------------------------------------------
// 只读成功路径：真实销售单的详情 / 影响预览 / 成品情况（顺带证明路由顺序正确）
// ---------------------------------------------------------------------------
test("sales_orders.detail_routes_return_success_envelopes_for_an_existing_order", async (t) => {
  const client = sessionClient();
  const list = await client.get("/api/v1/sales-orders?page_size=1");
  const listBody = expectSuccessEnvelope(list, { context: "sales-orders list", paginated: true });
  const existing = Array.isArray(listBody.data) ? listBody.data[0] : undefined;
  if (!existing) {
    t.skip("库中暂无销售单，详情成功路径无法只读验证");
    return;
  }

  const detail = await client.get(`/api/v1/sales-orders/${existing.id}`);
  if (detail.status === 404) {
    // 多 agent 共用同一个库：列表与详情之间被并发删除（软删）时不把环境竞争算成契约失败
    t.skip("销售单在列表与详情之间被并发删除，成功路径无法只读验证");
    return;
  }
  const detailBody = expectSuccessEnvelope(detail, { context: "GET /:id" });
  assert.equal(detailBody.data.id, existing.id);
  assert.equal(Array.isArray(detailBody.data), false, "详情端点的 data 是对象而不是分页数组");
  assert.equal(typeof detailBody.data.orderNo, "string", "详情返回销售单本体（含 orderNo）");
  assert.equal(typeof detailBody.data.status, "string");
  assert.ok(Array.isArray(detailBody.data.boms), "详情 include 了 boms 数组（sales-orders.service.ts:21）");

  // 路由顺序护栏：若 @Get(":id") 被注册在 @Get(":id/impact-preview") 之前，这里会返回销售单本体
  const preview = await client.get(`/api/v1/sales-orders/${existing.id}/impact-preview`);
  const previewBody = expectSuccessEnvelope(preview, { context: "GET /:id/impact-preview" });
  assert.equal(previewBody.data.sales_order_id, existing.id);
  assert.equal("id" in previewBody.data, false, "impact-preview 必须命中预览处理器而不是 GET /:id");
  for (const key of ["order_no", "current_version", "status", "bom_count", "warning"]) {
    assert.ok(key in previewBody.data, `impact-preview.data 缺少 ${key}`);
  }
  assert.ok(Number.isInteger(previewBody.data.bom_count) && previewBody.data.bom_count >= 0, "bom_count 应为非负整数");
  // 非分页端点：meta 里不应出现分页字段（本项目多数端点不分页，meta 常为 {}）
  for (const field of ["page", "page_size", "total"]) {
    assert.equal(field in previewBody.meta, false, `非分页端点 ${field} 不应出现在 meta 里；实际 ${JSON.stringify(previewBody.meta)}`);
  }

  const finished = await client.get(`/api/v1/sales-orders/${existing.id}/finished-goods`);
  const finishedBody = expectSuccessEnvelope(finished, { context: "GET /:id/finished-goods" });
  assert.equal(finishedBody.data.sales_order_id, existing.id);
  assert.equal(typeof finishedBody.data.order_quantity, "string", "Decimal 一律序列化为字符串");
  assert.ok(Array.isArray(finishedBody.data.production_orders), "production_orders 必须是数组（不传 production_order_id 时为全部生产单）");
  for (const row of finishedBody.data.production_orders) {
    for (const key of ["production_order_id", "production_order_no", "planned_quantity", "inbound_quantity", "outbound_quantity", "pending_notice_quantity", "available_quantity", "notices"]) {
      assert.ok(key in row, `production_orders[] 缺少 ${key}`);
    }
    assert.ok(Array.isArray(row.notices), "notices 必须是数组");
  }
});

// ---------------------------------------------------------------------------
// 成品出库总览：路由顺序护栏 —— 单段静态路径必须命中自己的处理器，不能被 @Get(":id") 吃掉
// ---------------------------------------------------------------------------
test("sales_orders.finished_goods_summary_hits_its_own_handler_not_the_id_route", async () => {
  const client = sessionClient();
  const response = await client.get("/api/v1/sales-orders/finished-goods-summary");
  // 若被 :id 吃掉，这里会是 404 SALES_ORDER_NOT_FOUND（"finished-goods-summary" 不是 UUID）
  const body = expectSuccessEnvelope(response, { context: "GET /finished-goods-summary" });
  assert.ok(Array.isArray(body.data.groups), "总览必须返回按「产品+单位」分行的 groups 数组");
  assert.equal(typeof body.data.production_order_count, "number");
  for (const group of body.data.groups) {
    for (const key of ["product_name", "unit", "inbound_quantity", "outbound_quantity", "unshipped_quantity", "production_order_count"]) {
      assert.ok(key in group, `groups[] 缺少 ${key}`);
    }
    // 三个数字都是 Decimal 序列化后的字符串（前端不做浮点累加）
    for (const key of ["inbound_quantity", "outbound_quantity", "unshipped_quantity"]) {
      assert.equal(typeof group[key], "string", `${key} 必须是字符串`);
    }
    assert.equal(Number(group.unshipped_quantity) >= 0, true, "未出库数不应为负数");
  }
});

// ---------------------------------------------------------------------------
// 创建（POST /）请求体校验：只提交必然校验失败的载荷，因此不会落库
// ---------------------------------------------------------------------------
test("sales_orders.create_body_validation_rejects_invalid_payloads", async () => {
  const client = sessionClient();

  // 空体：必填字段全部报错
  const empty = expectValidationError(await client.post("/api/v1/sales-orders", {}), { code: "VALIDATION_ERROR", context: "POST / {}" });
  const emptyFields = new Set(empty.error.details.map((detail) => detail.field));
  for (const field of ["order_no", "customer_id", "order_date", "product_name", "quantity", "unit", "currency"]) {
    assert.ok(emptyFields.has(field), `POST / {} 的 details 应包含必填字段 ${field}，实际 ${JSON.stringify([...emptyFields])}`);
  }

  // 只读探测下最容易踩到的几个规则
  expectFieldValidation(await client.post("/api/v1/sales-orders", { order_no: "   ", customer_id: UNKNOWN_ID, order_date: "2026-01-01", product_name: "P", quantity: "1", unit: "pcs", currency: "CNY" }), "order_no", "空白 order_no");
  expectFieldValidation(await client.post("/api/v1/sales-orders", { order_no: "PROBE", customer_id: UNKNOWN_ID, order_date: "not-a-date", product_name: "P", quantity: "1", unit: "pcs", currency: "CNY" }), "order_date", "非法日期");
  expectFieldValidation(await client.post("/api/v1/sales-orders", { order_no: "PROBE", customer_id: UNKNOWN_ID, order_date: "2026-01-01", product_name: "P", quantity: "1", unit: "pcs", currency: "CNY", settlement_method: "bogus" }), "settlement_method", "非法结算方式");
  expectFieldValidation(await client.post("/api/v1/sales-orders", { order_no: "PROBE", customer_id: UNKNOWN_ID, order_date: "2026-01-01", product_name: "P", quantity: "1", unit: "pcs", currency: "CNY", total_amount: "-10" }), "total_amount", "负金额");

  const unknown = await client.post("/api/v1/sales-orders", { order_no: "PROBE", customer_id: UNKNOWN_ID, order_date: "2026-01-01", product_name: "P", quantity: "1", unit: "pcs", currency: "CNY", bogus: 1 });
  const unknownBody = expectValidationError(unknown, { code: "VALIDATION_ERROR", context: "POST / 未知字段" });
  assert.equal(unknownBody.error.details[0].field, "bogus");
  assert.equal(unknownBody.error.details[0].rule, "whitelistValidation");
});

// ---------------------------------------------------------------------------
// 创建（POST /）引用校验：客户/联系人不存在时在**写事务之前**抛 404
// ---------------------------------------------------------------------------
test("sales_orders.create_reports_missing_references_without_creating_data", async () => {
  const client = sessionClient();
  const payload = { order_date: "2026-01-01", product_name: "契约探测-不落库", quantity: "1", unit: "pcs" };

  // 客户不存在（resolveReferences 在事务之前，sales-orders.service.ts:27）：不会写库
  expectNotFoundWithCode(await client.post("/api/v1/sales-orders", { ...payload, currency: "CNY", customer_id: UNKNOWN_ID, order_no: "PROBE-CUSTOMER-MISS" }), "CUSTOMER_NOT_FOUND", "POST / 客户不存在");

  // 客户存在但联系人不存在：同样在写事务之前抛 404（需要库里已有客户，否则跳过这一半断言）
  const customers = await client.get("/api/v1/customers?page_size=1");
  const customersBody = expectSuccessEnvelope(customers, { context: "customers list", paginated: true });
  const customer = Array.isArray(customersBody.data) ? customersBody.data[0] : undefined;
  if (customer) {
    expectNotFoundWithCode(await client.post("/api/v1/sales-orders", { ...payload, contact_id: UNKNOWN_ID, currency: "CNY", customer_id: customer.id, order_no: "PROBE-CONTACT-MISS" }), "CUSTOMER_CONTACT_NOT_FOUND", "POST / 联系人不存在");
  }
});

// ---------------------------------------------------------------------------
// 更新（PATCH /:id）请求体校验：DTO 面比创建窄（order_no / customer_id 只读）
// ---------------------------------------------------------------------------
test("sales_orders.update_body_validation_rejects_create_only_and_invalid_fields", async () => {
  const client = sessionClient();

  const createOnly = expectValidationError(await client.patch(`/api/v1/sales-orders/${UNKNOWN_ID}`, { order_no: "X" }), { code: "VALIDATION_ERROR", context: "PATCH order_no" });
  assert.equal(createOnly.error.details[0].field, "order_no");
  assert.equal(createOnly.error.details[0].rule, "whitelistValidation");

  expectFieldValidation(await client.patch(`/api/v1/sales-orders/${UNKNOWN_ID}`, { quantity: "-5" }), "quantity", "PATCH 负数量");
  expectFieldValidation(await client.patch(`/api/v1/sales-orders/${UNKNOWN_ID}`, { bogus: 1 }), "bogus", "PATCH 未知字段");
});

// ---------------------------------------------------------------------------
// 状态流转 / 出库通知：校验层与业务前置校验（均在写库之前，只读安全）
// ---------------------------------------------------------------------------
test("sales_orders.state_and_notice_routes_validate_before_touching_data", async () => {
  const client = sessionClient();
  const cancelPath = `/api/v1/sales-orders/${UNKNOWN_ID}/outbound-notices/${UNKNOWN_ID}/cancel`;

  // 原因为空串：DTO 通过（@IsString 不拦空串），业务层抛 422（sales-orders.service.ts:81）
  const blankReason = await client.post(`/api/v1/sales-orders/${UNKNOWN_ID}/revert-draft`, { reason: "   " });
  const blankBody = expectBusinessRuleViolation(blankReason, { code: "CORRECTION_REASON_REQUIRED", context: "revert-draft 空原因" });
  assert.deepEqual(blankBody.error.details, []);

  // 原因完全缺失：DTO 层 400，且 details 指向 reason
  expectFieldValidation(await client.post(`/api/v1/sales-orders/${UNKNOWN_ID}/revert-draft`, {}), "reason", "revert-draft 缺 reason");
  expectFieldValidation(await client.post(cancelPath, {}), "reason", "cancel 缺 reason");
  expectFieldValidation(await client.post(cancelPath, { reason: 123 }), "reason", "cancel reason 非字符串");

  // 取消通知的业务前置校验先于查库（finished-goods-outbound-notice.service.ts:138）
  const blankCancel = await client.post(cancelPath, { reason: "   " });
  expectBusinessRuleViolation(blankCancel, { code: "CANCELLATION_REASON_REQUIRED", context: "cancel 空原因" });

  // 出库通知 body 校验：production_order_id 必须是 UUID、remark 上限 1000
  expectFieldValidation(await client.post(`/api/v1/sales-orders/${UNKNOWN_ID}/outbound-notices`, { production_order_id: NON_UUID_ID }), "production_order_id", "outbound-notices 非 UUID 生产单");
  expectFieldValidation(await client.post(`/api/v1/sales-orders/${UNKNOWN_ID}/outbound-notices`, { remark: "x".repeat(1001) }), "remark", "outbound-notices 超长备注");
  // 分批通知的数量：DTO 层拦下非十进制（业务层再拦 NaN/0/指数/超 4 位小数）
  expectFieldValidation(await client.post(`/api/v1/sales-orders/${UNKNOWN_ID}/outbound-notices`, { notice_quantity: "abc" }), "notice_quantity", "outbound-notices 非数字通知数量");
  expectFieldValidation(await client.post(`/api/v1/sales-orders/${UNKNOWN_ID}/outbound-notices`, { notice_quantity: "-1" }), "notice_quantity", "outbound-notices 负数通知数量");
  expectFieldValidation(await client.post(`/api/v1/sales-orders/${UNKNOWN_ID}/outbound-notices`, { notice_quantity: "1e3" }), "notice_quantity", "outbound-notices 指数写法通知数量");
});

// ---------------------------------------------------------------------------
// 方法不匹配 → 404（本服务没有 405），message 为 Nest 生成的英文
// ---------------------------------------------------------------------------
test("sales_orders.method_mismatch_returns_404_never_405", async () => {
  const client = sessionClient();

  const cases = [
    ["del", `/api/v1/sales-orders/${UNKNOWN_ID}`, "DELETE"],
    ["put", `/api/v1/sales-orders/${UNKNOWN_ID}`, "PUT"],
    ["del", "/api/v1/sales-orders", "DELETE"],
    ["patch", "/api/v1/sales-orders", "PATCH"],
    ["post", `/api/v1/sales-orders/${UNKNOWN_ID}`, "POST"],
  ];
  for (const [method, path, verb] of cases) {
    const response = await client[method](path, {});
    assert.notEqual(response.status, 405, `${verb} ${path} 不应返回 405（本服务没有 405）`);
    expectErrorEnvelope(response, { code: "NOT_FOUND", context: `${verb} ${path}`, status: 404 });
    assert.match(response.body.error.message, new RegExp(`^Cannot ${verb}`), `${verb} ${path} 的 message 由 Nest 生成`);
  }
});

// ---------------------------------------------------------------------------
// 信封细节：x-request-id 响应头、error.meta.path（含 query string 的回显）
// 非分页端点的 meta 形状断言放在 detail 用例里（meta 不含 page/page_size/total）。
// ---------------------------------------------------------------------------
test("sales_orders.responses_carry_request_id_header_and_error_path", async () => {
  const client = sessionClient();

  const notFound = await client.get(`/api/v1/sales-orders/${UNKNOWN_ID}/impact-preview`);
  expectNotFoundWithCode(notFound, "SALES_ORDER_NOT_FOUND", "GET /:id/impact-preview");
  expectRequestIdHeader(notFound, "错误响应");
  assert.equal(notFound.body.meta.path, `/api/v1/sales-orders/${UNKNOWN_ID}/impact-preview`, "error.meta.path 必须是被请求的路径（含 query 时也含 query）");
  // 注意：meta.request_id 恒缺（已知缺陷 D2，见 contract-guardrails.test.cjs），这里不做断言。

  const list = await client.get("/api/v1/sales-orders?page_size=1");
  expectSuccessEnvelope(list, { context: "list", paginated: true });
  expectRequestIdHeader(list, "成功响应");

  const listWithQuery = await client.get("/api/v1/sales-orders?bogus=1");
  expectValidationError(listWithQuery, { code: "VALIDATION_ERROR", context: "query 校验失败" });
  assert.equal(listWithQuery.body.meta.path, "/api/v1/sales-orders?bogus=1", "错误 path 应保留 query string");
});

// ---------------------------------------------------------------------------
// KNOWN_CONTRACT_DEFECT：非 UUID 的 id 段没有参数校验 → Prisma 报错 → 500 REQUEST_ERROR
//
// 期望：GET /:id 这类路径参数应按 UUID 校验，返回 400 VALIDATION_ERROR（参数格式错）或
//       至少 404 SALES_ORDER_NOT_FOUND（资源不存在），前端不应看到 5xx。
// 实际：控制器只用 @Param("id") id: string（sales-orders.controller.ts:81-90），没有 ParseUUIDPipe；
//       service 直接把字符串交给 Prisma 的 uuid 列，Prisma 抛 "Inconsistent column data" 非 HttpException，
//       被 ApiExceptionFilter 兜底为 500（api-exception.filter.ts:15,21,48-55 → errorCode(500)="REQUEST_ERROR"）。
// 影响：9 个带 :id 的路由全部如此（实测）。前端拿到 500 会走「服务器内部错误」而不是「参数错误」。
// 本用例断言**当前（错误）行为**：修复后此处会变红，属修复信号，请同步更新本文件与 recon 记录。
// ---------------------------------------------------------------------------
test("KNOWN_CONTRACT_DEFECT: non_uuid_id_params_return_500_not_400", async () => {
  const client = sessionClient();

  const cases = [
    ["get", `/api/v1/sales-orders/${NON_UUID_ID}`, undefined],
    ["get", `/api/v1/sales-orders/${NON_UUID_ID}/impact-preview`, undefined],
    ["get", `/api/v1/sales-orders/${NON_UUID_ID}/finished-goods`, undefined],
    ["patch", `/api/v1/sales-orders/${NON_UUID_ID}`, {}],
    ["post", `/api/v1/sales-orders/${NON_UUID_ID}/confirm`, {}],
    ["post", `/api/v1/sales-orders/${NON_UUID_ID}/revert-draft`, { reason: "contract-probe" }],
    ["post", `/api/v1/sales-orders/${NON_UUID_ID}/close`, {}],
    ["post", `/api/v1/sales-orders/${NON_UUID_ID}/outbound-notices`, {}],
    ["post", `/api/v1/sales-orders/${NON_UUID_ID}/outbound-notices/${NON_UUID_ID}/cancel`, { reason: "contract-probe" }],
  ];
  for (const [method, path, payload] of cases) {
    const response = await client[method](path, payload);
    const label = `${method.toUpperCase()} ${path}`;
    // 修复后应为 400；这里固定当前行为，避免缺陷被悄悄扩大或悄悄修好
    assert.equal(response.status, 500, `${label} 当前实测为 500（非 UUID 参数未被校验）。若已是 400/404 说明缺陷已修复，请更新本用例`);
    const body = expectErrorEnvelope(response, { code: "REQUEST_ERROR", context: label, status: 500 });
    assert.deepEqual(body.error.details, [], `${label} 的 500 没有可定位的详情`);
  }
});
