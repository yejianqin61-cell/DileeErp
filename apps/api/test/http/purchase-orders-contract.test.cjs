// 采购模块（purchase-orders）HTTP 契约测试 —— 针对**运行中的真实 API**。
//
// 覆盖 14 个路由（apps/api/src/modules/procurement/purchase-orders.controller.ts:22-35）：
//   1. GET    /api/v1/purchase-orders                       列表（order_no 过滤，无分页）
//   2. POST   /api/v1/purchase-orders                       新建（201）
//   3. POST   /api/v1/purchase-orders/split                 按供应商拆分成多张采购单
//   4. PATCH  /api/v1/purchase-orders/:id                   修改
//   5. GET    /api/v1/purchase-orders/:id                   详情
//   6. GET    /api/v1/purchase-orders/:id/impact-preview    变更影响预览
//   7. POST   /api/v1/purchase-orders/:id/order             下单
//   8. POST   /api/v1/purchase-orders/:id/revert-draft      退回草稿（需 reason）
//   9. POST   /api/v1/purchase-orders/:id/cancel            取消
//  10. POST   /api/v1/purchase-orders/:id/revert-arrivals   到货回退（需 reason）
//  11. POST   /api/v1/purchase-orders/:id/close-arrivals    关闭到货
//  12. POST   /api/v1/purchase-orders/:id/items/:itemId/receipts   登记分批到货
//  13. PATCH  /api/v1/purchase-orders/receipts/:receiptId          修改到货批次（子资源在顶层，不在 :id 下）
//  14. POST   /api/v1/purchase-orders/receipts/:receiptId/cancel   撤销到货批次
//
// 环境约束（违反会得到随机失败，见 tests/helpers/api-client.cjs:73-82）：
//   - 本 API 是**单会话**的：AuthService.login() 先删该用户全部 session 再建新的
//     （auth.service.ts:28-31），所以同一用户名并发登录会互相踢掉。
//     → 每个用例内部自己登录一次并立即使用，绝不跨用例共享 cookie，也绝不并发登录。
//   - 必须串行执行：node --test --test-concurrency=1 apps/api/test/http/purchase-orders-contract.test.cjs
//
// 只读纪律：本文件不产生任何业务写操作。
//   - GET 全部放行；
//   - POST/PATCH 只打**鉴权层（401）与校验层（400）**，或使用「一定不存在」的随机 UUID，
//     让 service 在其事务真正写入之前抛错（每个用例都标注了抛错位置）；
//   - 不使用 /health（数据库竞争下会 503，见 contract-guardrails.test.cjs:39-45）。
//
// 实测基准：2026-09-13 对 http://127.0.0.1:3001 的探针结果（本文件断言值全部来自实测）。
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const {
  apiClient,
  expectErrorEnvelope,
  expectNotFound,
  expectRequestIdHeader,
  expectSuccessEnvelope,
  expectUnauthenticated,
  login,
} = require("../../../../tests/helpers/api-client.cjs");

const baseUrl = process.env.API_BASE_URL;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 全部使用随机 UUID：保证「一定不存在」，同时避免撞上任何 agent 正在写入的真实数据。
const UNKNOWN_ORDER_ID = randomUUID();
const UNKNOWN_ITEM_ID = randomUUID();
const UNKNOWN_RECEIPT_ID = randomUUID();

/**
 * 每个用例内部自建会话：单会话 API 不允许跨用例复用 cookie（见文件头）。
 *
 * 额外加固：本 API 同一用户名只有一条有效 session（auth.service.ts:28-31），而多个 agent
 * 会**同时**以 admin 打同一个库。因此客户端在收到 401 时会重新登录并**原样重试**——
 * 这不是放宽断言，而是把「会话被别人顶掉」这一环境噪声与「契约真的返回 401」区分开：
 * 鉴权契约本身由下面不使用本包装器的匿名/伪造 cookie 用例独立断言。
 * 重试是**零副作用**的：401 只可能来自 AuthenticationGuard（authentication.guard.ts:12 →
 * auth.service.ts:37），它在任何 handler/service 之前就抛出，请求体从未被业务逻辑消费。
 */
const AUTH_RETRY_ATTEMPTS = 5;

async function adminClient() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) throw new Error("TEST_BLOCKED: INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required");

  async function freshClient() {
    const session = await login(baseUrl, { password, username });
    assert.equal(session.status, 201, `登录应返回 201（POST 默认状态码），实际 ${session.status}`);
    assert.ok(session.cookie, "登录必须下发 dilee_session Cookie");
    return apiClient(baseUrl, { cookie: session.cookie });
  }

  let client = await freshClient();
  async function request(path, options = {}) {
    for (let attempt = 1; ; attempt += 1) {
      const response = await client.request(path, options);
      if (response.status !== 401 || attempt >= AUTH_RETRY_ATTEMPTS) return response;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      client = await freshClient();
    }
  }

  return {
    get: (path) => request(path),
    patch: (path, payload) => request(path, { body: JSON.stringify(payload), method: "PATCH" }),
    post: (path, payload) => request(path, { body: JSON.stringify(payload), method: "POST" }),
    request,
  };
}

/**
 * 取某字段的字段级校验详情。
 * 形状由 main.ts:23-27 的 exceptionFactory 决定：{ field, rule, message }。
 */
function detailFor(body, field) {
  const detail = body.error.details.find((item) => item.field === field);
  assert.ok(detail, `details 中应存在 field=${field} 的条目；实际 ${JSON.stringify(body.error.details)}`);
  assert.equal(typeof detail.rule, "string", `${field} 的 detail.rule 必须是字符串`);
  assert.equal(typeof detail.message, "string", `${field} 的 detail.message 必须是字符串`);
  return detail;
}

/** 14 个路由的清单，用于逐条打鉴权（route.name 与控制器方法名一一对应）。 */
const ROUTES = [
  { body: undefined, method: "GET", name: "list", path: "/api/v1/purchase-orders" },
  { body: {}, method: "POST", name: "create", path: "/api/v1/purchase-orders" },
  { body: {}, method: "POST", name: "split", path: "/api/v1/purchase-orders/split" },
  { body: {}, method: "PATCH", name: "update", path: `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}` },
  { body: undefined, method: "GET", name: "get", path: `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}` },
  { body: undefined, method: "GET", name: "impact", path: `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/impact-preview` },
  { body: undefined, method: "POST", name: "order", path: `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/order` },
  { body: { reason: "probe" }, method: "POST", name: "revertDraft", path: `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/revert-draft` },
  { body: undefined, method: "POST", name: "cancel", path: `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/cancel` },
  { body: { reason: "probe" }, method: "POST", name: "revertArrivals", path: `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/revert-arrivals` },
  { body: undefined, method: "POST", name: "closeArrivals", path: `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/close-arrivals` },
  { body: { quantity: "1", received_date: "2026-01-01" }, method: "POST", name: "receipt", path: `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/items/${UNKNOWN_ITEM_ID}/receipts` },
  { body: { quantity: "1", reason: "probe" }, method: "PATCH", name: "updateReceipt", path: `/api/v1/purchase-orders/receipts/${UNKNOWN_RECEIPT_ID}` },
  { body: { reason: "probe" }, method: "POST", name: "cancelReceipt", path: `/api/v1/purchase-orders/receipts/${UNKNOWN_RECEIPT_ID}/cancel` },
];

/** 按 route.method 派发到 apiClient 的对应方法。 */
function send(client, route) {
  if (route.method === "GET") return client.get(route.path);
  if (route.method === "POST") return client.post(route.path, route.body);
  if (route.method === "PATCH") return client.patch(route.path, route.body);
  throw new Error(`unsupported method ${route.method}`);
}

test("purchase_orders.list_returns_bare_array_and_declares_no_pagination", async () => {
  const client = await adminClient();

  const list = await client.get("/api/v1/purchase-orders");
  const body = expectSuccessEnvelope(list, { context: "GET /purchase-orders" });
  expectRequestIdHeader(list, "GET /purchase-orders");
  // 列表端点的 data 是裸数组；本端点**没有分页 DTO**（控制器签名是 @Query("order_no")，无 page/page_size），
  // 所以 meta 恒为 {}，绝不能按分页端点断言 page/page_size/total。
  assert.ok(Array.isArray(body.data), `列表 data 必须是裸数组，实际 ${typeof body.data}`);
  assert.deepEqual(body.meta, {}, "本端点无分页，meta 必须是空对象");
  for (const field of ["page", "page_size", "total"]) {
    assert.equal(field in body.meta, false, `无分页端点不应出现 meta.${field}`);
  }
  for (const row of body.data) {
    assert.match(row.id ?? "", UUID_PATTERN, "列表行必须带 UUID 主键");
    assert.equal(typeof row.orderNo, "string", "列表行必须带 orderNo");
    assert.equal(typeof row.purchaseOrderNo, "string", "列表行必须带 purchaseOrderNo");
    assert.ok(Array.isArray(row.items), "列表行必须内联 items 数组");
  }

  // order_no 是精确匹配（service 用 where: { orderNo }），不是模糊搜索：随机值必须得到空数组。
  const filtered = await client.get(`/api/v1/purchase-orders?order_no=${randomUUID()}`);
  const filteredBody = expectSuccessEnvelope(filtered, { context: "GET /purchase-orders?order_no=<unknown>" });
  assert.deepEqual(filteredBody.data, [], "order_no 未知时必须返回空数组（精确匹配）");

  // KNOWN_CONTRACT_DEFECT（D9 同源，成因不同）：@Query("order_no") 的参数元类型是原始类型 String，
  // ValidationPipe 的 toValidate 对原始类型直接返回 false（whitelist/forbidNonWhitelisted 完全跳过），
  // 因此未知 query 参数被**静默忽略**而不是 400。同理分页边界校验在本端点根本不适用：
  // page=0 / page_size=201 都不会 400 —— 这是「无分页 DTO」的现状，不是 pagination 缺陷。
  const ignored = await client.get("/api/v1/purchase-orders?bogus=1&page=0&page_size=201");
  const ignoredBody = expectSuccessEnvelope(ignored, { context: "GET /purchase-orders?bogus=1&page=0&page_size=201" });
  assert.ok(Array.isArray(ignoredBody.data), "未知 query 参数被静默忽略后仍应返回正常列表");
  assert.deepEqual(ignoredBody.meta, {}, "被忽略的分页参数不应产生 meta 分页字段");
});

test("purchase_orders.detail_and_impact_preview_use_business_not_found_code", async () => {
  const client = await adminClient();

  // 注意：这两个端点抛的是业务码 PURCHASE_ORDER_NOT_FOUND（purchase-orders.service.ts:18），
  // **不是**全局兜底的 NOT_FOUND，所以这里不能用 expectNotFound（它硬断言 code === "NOT_FOUND"），
  // 否则会把一个正确的实现判红。前端依赖的是 code，因此必须精确断言业务码。
  const detail = await client.get(`/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}`);
  expectErrorEnvelope(detail, { code: "PURCHASE_ORDER_NOT_FOUND", context: "GET /purchase-orders/:id", status: 404 });
  expectRequestIdHeader(detail, "GET /purchase-orders/:id");
  assert.equal(detail.body.error.details.length, 0, "业务 404 的 details 当前为空数组");
  assert.equal(detail.body.meta.path, `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}`, "失败信封的 meta.path 必须是请求路径");

  const impact = await client.get(`/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/impact-preview`);
  expectErrorEnvelope(impact, { code: "PURCHASE_ORDER_NOT_FOUND", context: "GET /purchase-orders/:id/impact-preview", status: 404 });
  assert.equal(impact.body.meta.path, `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/impact-preview`);
});

test("purchase_orders.detail_and_impact_preview_success_shape_for_existing_order", async (t) => {
  const client = await adminClient();

  const list = await client.get("/api/v1/purchase-orders");
  const rows = expectSuccessEnvelope(list, { context: "GET /purchase-orders" }).data;
  if (!rows.length) {
    t.skip("库里当前没有采购单，跳过成功路径形状校验（只读探测，不创建数据）");
    return;
  }
  const id = rows[0].id;

  const detail = await client.get(`/api/v1/purchase-orders/${id}`);
  const detailBody = expectSuccessEnvelope(detail, { context: "GET /purchase-orders/:id" });
  assert.equal(detailBody.data.id, id, "详情必须返回请求的采购单");
  assert.equal(typeof detailBody.data.status, "string", "详情必须带 status");
  assert.ok(Array.isArray(detailBody.data.items), "详情必须带 items 数组");
  for (const item of detailBody.data.items) {
    // get() 会为每个明细补齐 receipts 与 batchWorkflows（purchase-orders.service.ts:18）
    assert.ok(Array.isArray(item.receipts), "明细必须带 receipts 数组");
    assert.ok(Array.isArray(item.batchWorkflows), "明细必须带 batchWorkflows 数组（分批到货视图）");
    item.batchWorkflows.forEach((workflow, index) => {
      assert.equal(workflow.receiptId, item.receipts[index].id, "batchWorkflows 与 receipts 必须一一对应");
      assert.ok(Number.isInteger(workflow.batchSequence) && workflow.batchSequence > 0, "batchSequence 必须是正整数");
    });
  }

  const impact = await client.get(`/api/v1/purchase-orders/${id}/impact-preview`);
  const impactBody = expectSuccessEnvelope(impact, { context: "GET /purchase-orders/:id/impact-preview" });
  for (const field of ["order_no", "status", "purchase_order_no", "planned_quantity", "received_quantity", "over_order", "items"]) {
    assert.ok(field in impactBody.data, `影响预览必须含 ${field}（purchase-orders.service.ts:130）`);
  }
  assert.match(impactBody.data.planned_quantity, /^\d+\.\d{4}$/, "planned_quantity 是 4 位小数的十进制字符串");
  assert.match(impactBody.data.received_quantity, /^\d+\.\d{4}$/, "received_quantity 是 4 位小数的十进制字符串");
  assert.equal(typeof impactBody.data.over_order, "boolean", "over_order 必须是布尔值");
  assert.ok(Array.isArray(impactBody.data.items), "影响预览必须内联 items 数组");
});

test("purchase_orders.anonymous_requests_are_401_on_every_route", async () => {
  // 守卫链是 AuthenticationGuard → ModulePermissionGuard（控制器 :18）。
  // 无 cookie 时 AuthenticationGuard 先抛 UnauthorizedException（auth.service.ts:37），
  // 所以匿名访问**所有**受保护路由都是 401，而不是 ModulePermissionGuard 的 403。
  assert.equal(ROUTES.length, 14, "本文件必须覆盖控制器的全部 14 个路由");
  assert.equal(new Set(ROUTES.map((route) => route.name)).size, 14, "路由名不可重复");

  const anonymous = apiClient(baseUrl);
  for (const route of ROUTES) {
    const response = await send(anonymous, route);
    expectUnauthenticated(response, `${route.method} ${route.path}（匿名）`);
    assert.equal(response.body.meta.path, route.path, `${route.name} 的失败信封 meta.path 必须是请求路径`);
  }
});

test("purchase_orders.invalid_session_cookie_is_401_not_403", async () => {
  // 契约：会话无效/过期 → 401 UNAUTHENTICATED；403 只在「有有效会话但缺 procurement 模块权限」时出现。
  // 这里顺带锁住一个易错点：伪造 cookie 不能被降级成 403（ModulePermissionGuard:20 的 403 分支不可达，
  // 因为 AuthenticationGuard 先抛 401）。
  const forged = apiClient(baseUrl, { cookie: "dilee_session=forged-but-well-formed-token" });
  for (const route of [ROUTES[0], ROUTES[3], ROUTES[4], ROUTES[12]]) {
    const response = await send(forged, route);
    expectUnauthenticated(response, `${route.method} ${route.path}（伪造 cookie）`);
  }
});

test("purchase_orders.create_validates_body_before_touching_the_database", async () => {
  const client = await adminClient();

  // 空体：order_no 缺失 → 400，details 定位到 order_no
  const empty = await client.post("/api/v1/purchase-orders", {});
  expectErrorEnvelope(empty, { code: "VALIDATION_ERROR", context: "POST /purchase-orders {}", status: 400 });
  assert.equal(detailFor(empty.body, "order_no").rule, "isString", "order_no 缺失时 rule 应为 isString");

  // 未知字段：forbidNonWhitelisted（main.ts:22）→ 400 whitelistValidation，字段级可定位
  const unknownField = await client.post("/api/v1/purchase-orders", { bogus_field: 1, order_no: "PROBE-NOT-EXIST" });
  expectErrorEnvelope(unknownField, { code: "VALIDATION_ERROR", context: "POST /purchase-orders（未知字段）", status: 400 });
  assert.equal(detailFor(unknownField.body, "bogus_field").rule, "whitelistValidation");

  // KNOWN_CONTRACT_DEFECT（D10，责任文件 apps/api/src/platform/http/api-exception.filter.ts:26）：
  // 嵌套数组（items[]）里的校验错误只读顶层 error.constraints，不递归 error.children，
  // 因此 details 被丢空 —— 客户端拿不到任何字段级定位。修复后此断言应变红。
  const nested = await client.post("/api/v1/purchase-orders", {
    items: [{ quantity: "not-a-decimal" }],
    order_no: "PROBE-NESTED",
    supplier_id: UNKNOWN_ORDER_ID,
  });
  expectErrorEnvelope(nested, { code: "VALIDATION_ERROR", context: "POST /purchase-orders（嵌套 items 非法）", status: 400 });
  assert.deepEqual(nested.body.error.details, [], "当前实现会丢掉嵌套字段错误（D10）");

  // DTO 合法但业务前置条件不满足：refs() 在**任何事务之前**抛错（purchase-orders.service.ts:135-136），
  // 因此这条探测不会写入任何数据，却覆盖了「业务 404」这一层。
  const missingSalesOrder = await client.post("/api/v1/purchase-orders", { order_no: `PROBE-${randomUUID()}` });
  expectErrorEnvelope(missingSalesOrder, { code: "SALES_ORDER_NOT_CONFIRMED", context: "POST /purchase-orders（销售单不存在）", status: 404 });
});

test("purchase_orders.update_validates_body_before_looking_up_the_order", async () => {
  const client = await adminClient();

  // 关键契约：即使 :id 不存在（甚至不是 UUID），请求体校验也先失败 → 400，而不是 404/500。
  // 依据：ValidationPipe 是参数级管道，在 handler 之前执行；而 update() 才去 get(id)。
  const empty = await client.patch(`/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}`, {});
  expectErrorEnvelope(empty, { code: "VALIDATION_ERROR", context: "PATCH /purchase-orders/:id {}", status: 400 });
  assert.equal(detailFor(empty.body, "order_no").rule, "isString");

  const unknownField = await client.patch(`/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}`, { bogus_field: 1, order_no: "PROBE-NOT-EXIST" });
  expectErrorEnvelope(unknownField, { code: "VALIDATION_ERROR", context: "PATCH /purchase-orders/:id（未知字段）", status: 400 });
  assert.equal(detailFor(unknownField.body, "bogus_field").rule, "whitelistValidation");

  // 非 UUID 的 :id 也要先走校验层（@Param("id") 是 string，无 ParseUUIDPipe）
  const nonUuid = await client.patch("/api/v1/purchase-orders/not-a-uuid", {});
  expectErrorEnvelope(nonUuid, { code: "VALIDATION_ERROR", context: "PATCH /purchase-orders/not-a-uuid", status: 400 });
});

test("KNOWN_CONTRACT_DEFECT purchase_orders.malformed_uuid_path_param_returns_500_instead_of_400", async () => {
  // 期望：路径参数不是 UUID 时返回 400（参数不合法）或 404（资源不存在），且前端能拿到稳定错误码。
  // 实际：**500 REQUEST_ERROR**（服务器内部错误）。成因链：
  //   controller:25 `@Param("id") id: string` 没有 ParseUUIDPipe → "not-a-uuid" 原样进入 service.get(id)
  //   （purchase-orders.service.ts:18）→ prisma.purchaseOrder.findFirst({ where: { id } }) 对 uuid 列
  //   传入非 UUID 字符串，Prisma 抛 P2023（inconsistent column data），无人捕获 →
  //   apps/api/src/platform/http/api-exception.filter.ts:15 落到 500，:55 映射为 REQUEST_ERROR。
  // 影响：这不是业务错误而是**未处理异常**，客户端无法区分「id 写错」与「服务端故障」，且每次请求都会打 error 日志。
  // 修复方向（请勿在本测试里改）：给 :id/:itemId/:receiptId 加 ParseUUIDPipe 并映射为 400/404。
  // 只读性：GET 请求，且在 findFirst 阶段即失败，无任何写入。
  const client = await adminClient();

  const detail = await client.get("/api/v1/purchase-orders/not-a-uuid");
  expectErrorEnvelope(detail, { code: "REQUEST_ERROR", context: "GET /purchase-orders/not-a-uuid", status: 500 });
  assert.equal(detail.body.meta.path, "/api/v1/purchase-orders/not-a-uuid", "500 仍必须带完整失败信封");

  const impact = await client.get("/api/v1/purchase-orders/not-a-uuid/impact-preview");
  expectErrorEnvelope(impact, { code: "REQUEST_ERROR", context: "GET /purchase-orders/not-a-uuid/impact-preview", status: 500 });

  // 对照：参数校验失败（DTO 层）永远是 400，与上面的 500 形成鲜明对比 —— 所以同一个控制器里
  // 「非 UUID 的 id」在 PATCH 上是 400（body 先失败，见上一个用例），在 GET 上却是 500。
  const patched = await client.patch("/api/v1/purchase-orders/not-a-uuid", {});
  expectErrorEnvelope(patched, { code: "VALIDATION_ERROR", context: "PATCH /purchase-orders/not-a-uuid", status: 400 });
});

test("purchase_orders.status_actions_return_404_for_unknown_order", async () => {
  const client = await adminClient();

  // 三个无 body 的状态动作都先 get(id)（service:37/39/45-49），不存在的单子 → 业务 404，且**无写操作**。
  for (const action of ["order", "cancel", "close-arrivals"]) {
    const response = await client.post(`/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/${action}`);
    expectErrorEnvelope(response, { code: "PURCHASE_ORDER_NOT_FOUND", context: `POST /purchase-orders/:id/${action}`, status: 404 });
  }
});

test("purchase_orders.reason_actions_split_validation_400_and_business_422", async () => {
  const client = await adminClient();

  // 第一层：ReasonDto.reason 是必填 string（controller:15）→ 缺字段时 400，请求根本到不了 service。
  // 注意 reason 同时挂了 @IsString 与 @MaxLength(1000)，class-validator 会为同一个值生成多条约束，
  // details 的顺序不保证 → 只断言「存在 reason 的字段级错误，且规则来自这两个装饰器之一」。
  for (const action of ["revert-draft", "revert-arrivals"]) {
    const missing = await client.post(`/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/${action}`, {});
    expectErrorEnvelope(missing, { code: "VALIDATION_ERROR", context: `POST /:id/${action} {}`, status: 400 });
    const rule = detailFor(missing.body, "reason").rule;
    assert.ok(["isString", "maxLength"].includes(rule), `reason 的校验规则应来自 IsString/MaxLength，实际 ${rule}`);
  }

  // 第二层：reason 是空白串（通过 IsString，但业务要求 trim 后非空）→ 422 精确业务码。
  // 两个动作都在**任何数据库操作之前**校验 reason（service:38、service:113），因此这条探测零写入。
  const blankDraft = await client.post(`/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/revert-draft`, { reason: "   " });
  expectErrorEnvelope(blankDraft, { code: "CORRECTION_REASON_REQUIRED", context: "revert-draft 空白 reason", status: 422 });
  const blankArrivals = await client.post(`/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/revert-arrivals`, { reason: "   " });
  expectErrorEnvelope(blankArrivals, { code: "PURCHASE_ARRIVAL_REVERSAL_REASON_REQUIRED", context: "revert-arrivals 空白 reason", status: 422 });

  // 第三层：reason 合法但单子不存在 → 业务 404。
  // revert-draft 在 get(id) 处抛错、revert-arrivals 在事务内 findFirst 返回 null 处抛错（service:117），
  // 两者都在 update 之前，故不产生任何写入。
  const draft = await client.post(`/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/revert-draft`, { reason: "probe" });
  expectErrorEnvelope(draft, { code: "PURCHASE_ORDER_NOT_FOUND", context: "revert-draft 合法 reason", status: 404 });
  const arrivals = await client.post(`/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/revert-arrivals`, { reason: "probe" });
  expectErrorEnvelope(arrivals, { code: "PURCHASE_ORDER_NOT_FOUND", context: "revert-arrivals 合法 reason", status: 404 });
});

test("purchase_orders.receipt_endpoint_validates_then_reports_invalid_state", async () => {
  const client = await adminClient();
  const path = `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}/items/${UNKNOWN_ITEM_ID}/receipts`;

  // 校验层：ReceiptDto 要求 quantity / received_date（controller:13）→ 400 且字段级可定位
  const empty = await client.post(path, {});
  expectErrorEnvelope(empty, { code: "VALIDATION_ERROR", context: "POST .../receipts {}", status: 400 });
  assert.equal(detailFor(empty.body, "quantity").rule, "isString");
  assert.equal(detailFor(empty.body, "received_date").rule, "isDateString");

  // 业务层（service:87，在任何事务之前）：数量必须 > 0 → 422 INVALID_RECEIPT
  const zero = await client.post(path, { quantity: "0", received_date: "2026-01-01" });
  expectErrorEnvelope(zero, { code: "INVALID_RECEIPT", context: "POST .../receipts quantity=0", status: 422 });
  const nan = await client.post(path, { quantity: "abc", received_date: "2026-01-01" });
  expectErrorEnvelope(nan, { code: "INVALID_RECEIPT", context: "POST .../receipts quantity=abc", status: 422 });

  // KNOWN_CONTRACT_DEFECT：采购单**不存在**时，本端点返回 422 INVALID_PURCHASE_STATE，
  // 而同一控制器的其它所有以采购单为目标的端点都返回 404 PURCHASE_ORDER_NOT_FOUND。
  // 期望：404 PURCHASE_ORDER_NOT_FOUND（资源不存在 ≠ 状态非法）。
  // 实际：422 INVALID_PURCHASE_STATE（purchase-orders.service.ts:91 把 !po 与状态检查合并成一条断言）。
  // 只读性说明：该分支在事务内 findFirst 为 null 时抛出，事务回滚，无任何写入。
  const unknownOrder = await client.post(path, { quantity: "1", received_date: "2026-01-01" });
  expectErrorEnvelope(unknownOrder, { code: "INVALID_PURCHASE_STATE", context: "POST .../receipts（采购单不存在）", status: 422 });
});

test("purchase_orders.receipt_update_validates_body_then_404s", async () => {
  const client = await adminClient();
  const path = `/api/v1/purchase-orders/receipts/${UNKNOWN_RECEIPT_ID}`;

  // ReceiptUpdateDto 要求 quantity 与 reason 都是 string（controller:14）
  const empty = await client.patch(path, {});
  expectErrorEnvelope(empty, { code: "VALIDATION_ERROR", context: "PATCH /purchase-orders/receipts/:receiptId {}", status: 400 });
  assert.equal(detailFor(empty.body, "quantity").rule, "isString");
  assert.equal(detailFor(empty.body, "reason").rule, "isString");

  // 只缺 reason：仍必须 400，而不是先跑到 service 的业务 422（证明 DTO 层优先于 service:41 的 reason 检查）
  const missingReason = await client.patch(path, { quantity: "1" });
  expectErrorEnvelope(missingReason, { code: "VALIDATION_ERROR", context: "PATCH .../receipts (无 reason)", status: 400 });
  assert.equal(detailFor(missingReason.body, "reason").rule, "isString");

  // 校验通过 → 业务 404，业务码是 RECEIPT_NOT_FOUND（service:41），不是全局 NOT_FOUND
  // 只读性：updateReceiptV2 先 findFirst（null）跳过 arrival_closed 检查，再进入事务，
  // 事务内 findFirst 仍为 null → 抛 404 并回滚，未写入任何行。
  const notFound = await client.patch(path, { quantity: "1", reason: "probe" });
  expectErrorEnvelope(notFound, { code: "RECEIPT_NOT_FOUND", context: "PATCH .../receipts（不存在）", status: 404 });
  assert.equal(notFound.body.meta.path, path);
});

test("purchase_orders.receipt_cancel_requires_reason_then_404s", async () => {
  const client = await adminClient();
  const path = `/api/v1/purchase-orders/receipts/${UNKNOWN_RECEIPT_ID}/cancel`;

  // 注意：这是 @Body("reason") 原始类型参数（controller:34），没有 DTO 类 → ValidationPipe 跳过校验，
  // 因此**不会**有 400：reason 缺失直接落到 service 的业务校验（service:42）→ 422。
  const noReason = await client.post(path, {});
  expectErrorEnvelope(noReason, { code: "CORRECTION_REASON_REQUIRED", context: "POST .../receipts/:id/cancel {}", status: 422 });

  const blankReason = await client.post(path, { reason: "  " });
  expectErrorEnvelope(blankReason, { code: "CORRECTION_REASON_REQUIRED", context: "POST .../receipts/:id/cancel 空白 reason", status: 422 });

  // 同一根因（D9 家族）：原始类型参数的端点会**静默忽略**未知 body 字段。
  // 对照 ReceiptUpdateDto（上面的 PATCH）会因 forbidNonWhitelisted 报 400。
  const ignoredExtra = await client.post(path, { bogus_field: 1, reason: "probe" });
  expectErrorEnvelope(ignoredExtra, { code: "RECEIPT_NOT_FOUND", context: "POST .../receipts/:id/cancel 未知字段", status: 404 });

  // 合法 reason + 不存在的批次 → 业务 404（service:42），事务回滚，无写入。
  const notFound = await client.post(path, { reason: "probe" });
  expectErrorEnvelope(notFound, { code: "RECEIPT_NOT_FOUND", context: "POST .../receipts/:id/cancel（不存在）", status: 404 });
  assert.equal(notFound.body.meta.path, path);
});

test("purchase_orders.method_mismatch_is_404_with_english_message_never_405", async () => {
  const client = await adminClient();

  // 后端没有 405：方法不匹配走 not-found handler，message 为 Nest 生成的英文 "Cannot XXX <url>"。
  const cases = [
    { method: "DELETE", path: `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}` },
    { method: "PUT", path: `/api/v1/purchase-orders/${UNKNOWN_ORDER_ID}` },
    // receipts 子资源在框架里是顶层路径（controller:33-34），只注册了 PATCH 与 POST .../cancel，
    // 因此对 receipts/:receiptId 发 POST / GET / DELETE 都不匹配任何路由 → 404。
    { method: "POST", path: `/api/v1/purchase-orders/receipts/${UNKNOWN_RECEIPT_ID}` },
    { method: "GET", path: `/api/v1/purchase-orders/receipts/${UNKNOWN_RECEIPT_ID}` },
    { method: "DELETE", path: `/api/v1/purchase-orders/receipts/${UNKNOWN_RECEIPT_ID}/cancel` },
  ];

  for (const item of cases) {
    const response = await client.request(item.path, { method: item.method });
    expectNotFound(response, `${item.method} ${item.path}`);
    assert.equal(response.status === 405, false, "后端永远不返回 405");
    assert.match(
      response.body.error.message,
      new RegExp(`^Cannot ${item.method} `),
      `${item.method} 不匹配的 message 应为英文 "Cannot ${item.method} ..."`,
    );
  }
});
