// 生产单模块 HTTP 契约测试（13 个路由）。
//
// 生产文件：apps/api/src/modules/production/production-orders.controller.ts
// 路由清单（全部挂在 /api/v1/production/orders，类级 @UseGuards(AuthenticationGuard, ModulePermissionGuard)
// + @RequireModules("production")，controller.ts:18-21）：
//   1. GET    /                               列表（裸数组，meta {}，非分页）
//   2. GET    /:id                            详情
//   3. POST   /                               建单
//   4. PATCH  /:id                            改单
//   5. DELETE /:id                            删单
//   6. POST   /:id/operations                 添加工序
//   7. POST   /:id/operations/batch           批量添加工序
//   8. POST   /:id/packaging-operation        补建包装（收尾）工序
//   9. PATCH  /:id/operations/:operationId    改工序
//  10. POST   /:id/operations/:operationId/cancel  取消工序
//  11. POST   /:id/transition                状态流转
//  12. GET    /:id/impact-preview            影响预览
//  13. GET    /:id/audit-events              审计事件
//
// 纪律（本文件严格遵守，因为多个 agent 同时打同一个库）：
//   - 只做只读探测：全部 GET 用真实数据；写路由（POST/PATCH/DELETE）只断言 **鉴权层 / 校验层 / 存在性层**，
//     并且刻意让请求在**任何写入之前**就失败（随机 UUID、非法体、缺必填），不提交任何合法业务数据。
//   - 每个用例内部各自登录一次并立即使用：AuthService.login() 先删该用户全部 session 再建新的
//     （auth.service.ts:29），同一用户名并发登录会互相踢掉。
//   - 运行必须串行：node --test --test-concurrency=1 apps/api/test/http/production-orders-contract.test.cjs
//
// 已知契约缺陷（KNOWN_DEFECT，见文件末尾用例）：非 UUID 的路径参数落到 500 REQUEST_ERROR。
//
// 所有断言值均为 2026-09-13 对运行中 API（http://127.0.0.1:3001）的实测结果。

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  apiClient,
  expectBusinessRuleViolation,
  expectErrorEnvelope,
  expectNotFound,
  expectRequestIdHeader,
  expectSuccessEnvelope,
  expectUnauthenticated,
  expectValidationError,
  login,
} = require("../../../../tests/helpers/api-client.cjs");

const baseUrl = process.env.API_BASE_URL;
if (!baseUrl) throw new Error("TEST_BLOCKED: API_BASE_URL is required for HTTP contract tests");

/** controller.ts:18 的 @Controller("production/orders") + main.ts:14 的全局前缀。 */
const ORDERS = "/api/v1/production/orders";
/** 必然不存在的 id：随机 UUID 的探测等价物，且保证所有写路由在写入前失败。 */
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

/** 每个用例内部登录（单会话约束），并立即用于紧随其后的请求。 */
async function adminClient() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) throw new Error("TEST_BLOCKED: INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required");
  const session = await login(baseUrl, { password, username });
  assert.equal(session.status, 201, `登录应返回 201（POST 默认状态码），实际 ${session.status}：${JSON.stringify(session.body)}`);
  assert.ok(session.cookie, "登录必须下发 dilee_session Cookie");
  return apiClient(baseUrl, { cookie: session.cookie });
}

/**
 * 执行一次「已认证探测」。
 *
 * 为什么需要重试：本 API 是单会话的（auth.service.ts:29 登录即清空该用户全部 session），
 * 而多个 agent / 测试文件会在同一个库上并行以 admin 登录，本进程的 Cookie 会被别的进程顶掉，
 * 表现为无关的 401。这里在收到 401 时**重新登录并重试一次**，隔离这类环境噪声；
 * 真正的鉴权契约（匿名必须 401）由不使用本助手的用例独立断言，不受影响。
 */
async function asAdmin(probe) {
  const first = await probe(await adminClient());
  if (first.status !== 401) return first;
  return probe(await adminClient());
}

/** 取运行库中第一张生产单的 id；没有数据时返回 null（相关用例跳过而不是假绿）。 */
async function firstOrderId() {
  const response = await asAdmin((client) => client.get(ORDERS));
  expectSuccessEnvelope(response, { context: "list" });
  const rows = response.body.data;
  return Array.isArray(rows) && rows.length > 0 ? rows[0].id : null;
}

/** 400 的 details 里的字段名集合（校验失败的字段定位契约）。 */
const detailFields = (response) => response.body.error.details.map((detail) => detail.field);
/** 某个字段命中的校验规则名。 */
const ruleFor = (response, field) => response.body.error.details.find((detail) => detail.field === field)?.rule;

// ---------------------------------------------------------------------------
// 信封 / 列表（路由 1）
// ---------------------------------------------------------------------------

test("production_orders.list_returns_bare_array_envelope_with_non_paginated_meta", async () => {
  const response = await asAdmin((client) => client.get(ORDERS));
  const body = expectSuccessEnvelope(response, { context: "GET /production/orders" });

  // 列表端点的 data 是**裸数组**，不是 { items: [...] }
  assert.ok(Array.isArray(body.data), `列表 data 必须是裸数组，实际 ${typeof body.data}`);
  // 该端点没有分页 DTO（controller.ts:23 只有一个 order_no 参数），meta 恒为 {}
  assert.ok(!("page" in body.meta) && !("page_size" in body.meta) && !("total" in body.meta), `未分页端点的 meta 不应含分页字段，实际 ${JSON.stringify(body.meta)}`);
  // 关联数据在行内展开（service.ts:19 的 include）
  for (const row of body.data) {
    assert.equal(typeof row.id, "string");
    assert.equal(typeof row.productionOrderNo, "string");
    assert.equal(typeof row.status, "string");
    assert.ok(Array.isArray(row.operations), "列表行内应内联 operations 数组");
  }
  // 成功响应同样带可关联的响应头 x-request-id（唯一可靠的关联手段）
  expectRequestIdHeader(response, "GET /production/orders");
});

test("production_orders.list_query_contract_filters_by_order_no_and_silently_ignores_unknown_params", async () => {
  // order_no 过滤命中为空时返回 200 + 空数组，而不是 404
  const filtered = await asAdmin((client) => client.get(`${ORDERS}?order_no=NO-SUCH-ORDER-9999`));
  const filteredBody = expectSuccessEnvelope(filtered, { context: "?order_no=不存在" });
  assert.deepEqual(filteredBody.data, [], "不存在的 order_no 应返回空数组");

  // 未知 query 参数被**静默忽略**：controller.ts:23 是 `@Query("order_no") orderNo?: string`，
  // metatype 是 String（原始类型），ValidationPipe 直接跳过校验（对比走 DTO 类的端点会 400 whitelistValidation）。
  const bogus = await asAdmin((client) => client.get(`${ORDERS}?bogus=1`));
  expectSuccessEnvelope(bogus, { context: "?bogus=1（原始类型 query → 静默忽略）" });

  // 该端点没有分页，因此 page_size 的 1..200 边界在这里**不适用**：page_size=201 依旧 200。
  const oversized = await asAdmin((client) => client.get(`${ORDERS}?page_size=201`));
  const oversizedBody = expectSuccessEnvelope(oversized, { context: "?page_size=201（本端点无分页）" });
  assert.ok(Array.isArray(oversizedBody.data), "无分页端点应忽略 page_size 并返回完整裸数组");
});

// ---------------------------------------------------------------------------
// 详情 / 影响预览 / 审计事件（路由 2、12、13）
// ---------------------------------------------------------------------------

test("production_orders.read_routes_return_success_envelope_for_an_existing_order", async (t) => {
  const id = await firstOrderId();
  if (!id) return t.skip("运行库中没有生产单，跳过真实数据形状断言");

  const detail = await asAdmin((client) => client.get(`${ORDERS}/${id}`));
  const detailBody = expectSuccessEnvelope(detail, { context: "GET /:id" });
  assert.equal(detailBody.data.id, id);
  assert.equal(typeof detailBody.data.productionOrderNo, "string");
  assert.equal(typeof detailBody.data.status, "string");
  assert.equal(typeof detailBody.data.bomVersion, "number");
  assert.ok(Array.isArray(detailBody.data.operations), "详情应内联 operations（service.ts:20）");
  assert.ok(detailBody.data.bom && detailBody.data.unit, "详情应内联 bom / unit（service.ts:20 的 include）");

  // order_no 过滤的正向语义：用真实单号回查，必须命中该生产单（只读）
  const orderNo = detailBody.data.orderNo;
  const byOrderNo = await asAdmin((client) => client.get(`${ORDERS}?order_no=${encodeURIComponent(orderNo)}`));
  const byOrderNoBody = expectSuccessEnvelope(byOrderNo, { context: `?order_no=${orderNo}` });
  assert.ok(byOrderNoBody.data.length > 0, `order_no=${orderNo} 应至少命中 1 张生产单`);
  for (const row of byOrderNoBody.data) assert.equal(row.orderNo, orderNo, "过滤结果必须全部匹配 order_no");

  const preview = await asAdmin((client) => client.get(`${ORDERS}/${id}/impact-preview`));
  const previewBody = expectSuccessEnvelope(preview, { context: "GET /:id/impact-preview" });
  // 影响预览的固定形状（service.ts:300）
  for (const key of ["order_no", "production_order_no", "status", "bom_id", "bom_version", "operations", "downstream", "audit_event_count", "warning"]) {
    assert.ok(key in previewBody.data, `影响预览缺少字段 ${key}；实际键：${Object.keys(previewBody.data).join(",")}`);
  }
  assert.ok(Array.isArray(previewBody.data.operations));
  assert.ok(Array.isArray(previewBody.data.downstream.purchase_orders));
  assert.equal(previewBody.data.audit_event_count >= 0, true);

  const audit = await asAdmin((client) => client.get(`${ORDERS}/${id}/audit-events`));
  const auditBody = expectSuccessEnvelope(audit, { context: "GET /:id/audit-events" });
  assert.ok(Array.isArray(auditBody.data), "审计事件是裸数组（service.ts:301）");
  assert.ok(!("page" in auditBody.meta), "审计事件端点不分页，meta 为 {}");
});

test("production_orders.unknown_id_returns_precise_business_not_found_code", async () => {
  for (const path of [`${ORDERS}/${UNKNOWN_ID}`, `${ORDERS}/${UNKNOWN_ID}/impact-preview`, `${ORDERS}/${UNKNOWN_ID}/audit-events`]) {
    const response = await asAdmin((client) => client.get(path));
    // 业务模块用更精确的大写下划线码（service.ts:20），不是通用 NOT_FOUND
    const body = expectErrorEnvelope(response, { code: "PRODUCTION_ORDER_NOT_FOUND", context: `GET ${path}`, status: 404 });
    assert.equal(body.meta.path, path, "失败信封的 meta.path 必须是请求路径");
  }
});

// ---------------------------------------------------------------------------
// KNOWN_DEFECT：路径参数没有 UUID 校验
// ---------------------------------------------------------------------------

test("KNOWN_DEFECT production_orders.non_uuid_path_param_escalates_to_500_request_error", async () => {
  // 期望：非法路径参数应是 400（VALIDATION_ERROR，可定位字段）或 404（路由/资源不存在）。
  // 实际：controller.ts:24 的 `@Param("id") id: string` 没有任何 ParseUUIDPipe（全仓库 src 下无一处
  // ParseUUIDPipe），"not-a-uuid" 被直接丢给 Prisma 的 uuid 列，抛出 P2023（inconsistent column data），
  // 被 api-exception.filter.ts:15,21,43 的兜底分支映射为 500 REQUEST_ERROR。
  // 影响：客户端把「参数写错了」当成「服务器故障」，无法自愈重试。
  // 修复后（补 ParseUUIDPipe 或前置校验）本用例应变红，请同步更新本条与 docs/test/00-recon-api-contract.md。
  const response = await asAdmin((client) => client.get(`${ORDERS}/not-a-uuid`));
  expectErrorEnvelope(response, { code: "REQUEST_ERROR", context: "GET /production/orders/not-a-uuid", status: 500 });
  assert.equal(response.body.error.message, "服务器内部错误");
  // 同样的输入在写路由上同样是 500 —— 说明这是路径参数层的系统性问题，而非单个 handler
  const patched = await asAdmin((client) => client.patch(`${ORDERS}/not-a-uuid`, {}));
  expectErrorEnvelope(patched, { code: "REQUEST_ERROR", context: "PATCH /production/orders/not-a-uuid", status: 500 });
});

// ---------------------------------------------------------------------------
// 鉴权（全部 13 个路由）
// ---------------------------------------------------------------------------

/** 13 个路由的匿名探测清单（与 controller.ts:23-36 一一对应）。 */
const ALL_ROUTES = [
  { call: (client) => client.get(ORDERS), label: "GET /", path: ORDERS },
  { call: (client) => client.get(`${ORDERS}/${UNKNOWN_ID}`), label: "GET /:id", path: `${ORDERS}/${UNKNOWN_ID}` },
  { call: (client) => client.post(ORDERS, {}), label: "POST /", path: ORDERS },
  { call: (client) => client.patch(`${ORDERS}/${UNKNOWN_ID}`, {}), label: "PATCH /:id", path: `${ORDERS}/${UNKNOWN_ID}` },
  { call: (client) => client.del(`${ORDERS}/${UNKNOWN_ID}`), label: "DELETE /:id", path: `${ORDERS}/${UNKNOWN_ID}` },
  { call: (client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations`, {}), label: "POST /:id/operations", path: `${ORDERS}/${UNKNOWN_ID}/operations` },
  { call: (client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations/batch`, {}), label: "POST /:id/operations/batch", path: `${ORDERS}/${UNKNOWN_ID}/operations/batch` },
  { call: (client) => client.post(`${ORDERS}/${UNKNOWN_ID}/packaging-operation`), label: "POST /:id/packaging-operation", path: `${ORDERS}/${UNKNOWN_ID}/packaging-operation` },
  { call: (client) => client.patch(`${ORDERS}/${UNKNOWN_ID}/operations/${UNKNOWN_ID}`, {}), label: "PATCH /:id/operations/:operationId", path: `${ORDERS}/${UNKNOWN_ID}/operations/${UNKNOWN_ID}` },
  { call: (client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations/${UNKNOWN_ID}/cancel`, {}), label: "POST /:id/operations/:operationId/cancel", path: `${ORDERS}/${UNKNOWN_ID}/operations/${UNKNOWN_ID}/cancel` },
  { call: (client) => client.post(`${ORDERS}/${UNKNOWN_ID}/transition`, {}), label: "POST /:id/transition", path: `${ORDERS}/${UNKNOWN_ID}/transition` },
  { call: (client) => client.get(`${ORDERS}/${UNKNOWN_ID}/impact-preview`), label: "GET /:id/impact-preview", path: `${ORDERS}/${UNKNOWN_ID}/impact-preview` },
  { call: (client) => client.get(`${ORDERS}/${UNKNOWN_ID}/audit-events`), label: "GET /:id/audit-events", path: `${ORDERS}/${UNKNOWN_ID}/audit-events` },
];

test("production_orders.all_thirteen_routes_require_authentication", async () => {
  assert.equal(ALL_ROUTES.length, 13, "路由清单必须覆盖 controller 的全部 13 个路由");
  const anonymous = apiClient(baseUrl);
  for (const route of ALL_ROUTES) {
    const response = await route.call(anonymous);
    // 403 与 401 的优先级：AuthenticationGuard 先于 ModulePermissionGuard，匿名一律 401 而不是 403
    const body = expectUnauthenticated(response, `匿名 ${route.label}`);
    assert.equal(body.meta.path, route.path, `匿名 ${route.label} 的 meta.path 应为请求路径`);
    expectRequestIdHeader(response, `匿名 ${route.label}`);
    // 守卫先于管道：即使请求体完全非法（{}），匿名仍在校验之前被拒
  }
});

test("production_orders.administrator_role_short_circuits_the_module_permission_guard", async () => {
  // ModulePermissionGuard 对 role.key === "administrator" 直接放行（module-permission.guard.ts:22-23）。
  // 因此 admin 既不会被 403 拦住，也不需要 production 模块权限行。
  const response = await asAdmin((client) => client.get(ORDERS));
  assert.notEqual(response.status, 403, "administrator 不应被模块权限守卫拒绝");
  expectSuccessEnvelope(response, { context: "admin GET /production/orders" });
  // 未验证：非管理员且无 production 权限 → 403 FORBIDDEN。运行库中没有这样的测试账号
  // （tests/fixtures/seed-users.cjs 的 noModule 用户需要跑种子脚本创建，而本次任务禁止写入数据），
  // 详见交付报告「未验证」一节。
});

// ---------------------------------------------------------------------------
// 路由/方法匹配（无 405）
// ---------------------------------------------------------------------------

test("production_orders.wrong_method_returns_404_never_405", async () => {
  const cases = [
    { call: (client) => client.put(ORDERS, {}), method: "PUT", path: ORDERS },
    { call: (client) => client.put(`${ORDERS}/${UNKNOWN_ID}`, {}), method: "PUT", path: `${ORDERS}/${UNKNOWN_ID}` },
    { call: (client) => client.get(`${ORDERS}/${UNKNOWN_ID}/operations`), method: "GET", path: `${ORDERS}/${UNKNOWN_ID}/operations` },
    { call: (client) => client.del(`${ORDERS}/${UNKNOWN_ID}/transition`), method: "DELETE", path: `${ORDERS}/${UNKNOWN_ID}/transition` },
  ];
  for (const item of cases) {
    const response = await asAdmin(item.call);
    assert.notEqual(response.status, 405, "后端没有 405：方法不匹配也走 404");
    const body = expectNotFound(response, `${item.method} ${item.path}`);
    assert.match(body.error.message, new RegExp(`^Cannot ${item.method}`), `路由不匹配的 message 由 Nest 生成（英文 Cannot <METHOD> ...），实际 ${body.error.message}`);
    assert.equal(body.meta.path, item.path);
  }
});

// ---------------------------------------------------------------------------
// 校验层（400）：POST / PATCH / 工序与批量工序 / 取消 / 流转
// ---------------------------------------------------------------------------

test("production_orders.create_missing_required_fields_yields_field_level_400", async () => {
  const response = await asAdmin((client) => client.post(ORDERS, {}));
  const body = expectValidationError(response, { code: "VALIDATION_ERROR", context: "POST /production/orders {}" });
  // 必填字段（controller.ts:10）逐个被定位
  const expected = ["order_no", "bom_id", "bom_version", "execution_mode", "execution_location_id", "planned_quantity", "unit_id"];
  for (const field of expected) assert.ok(detailFields(response).includes(field), `details 应包含必填字段 ${field}；实际 ${JSON.stringify(body.error.details)}`);
  for (const detail of body.error.details) {
    assert.equal(typeof detail.field, "string");
    assert.equal(typeof detail.rule, "string");
    assert.equal(typeof detail.message, "string");
  }
});

test("production_orders.create_rejects_unknown_fields_and_bad_formats", async () => {
  // whitelist + forbidNonWhitelisted（main.ts:20-22）
  const whitelist = await asAdmin((client) =>
    client.post(ORDERS, { bom_id: UNKNOWN_ID, bom_version: 1, execution_mode: "in_house", execution_location_id: UNKNOWN_ID, order_no: "PROBE", planned_quantity: "1", unit_id: UNKNOWN_ID, bogus: 1 }));
  expectValidationError(whitelist, { code: "VALIDATION_ERROR", context: "未白名单字段" });
  assert.equal(ruleFor(whitelist, "bogus"), "whitelistValidation");

  // 类型/格式：UUID 与 ISO 日期（controller.ts:10 的 @IsUUID / @IsDateString）
  const formats = await asAdmin((client) =>
    client.post(ORDERS, { bom_id: "x", bom_version: 1, execution_mode: "in_house", execution_location_id: UNKNOWN_ID, order_no: "PROBE", planned_quantity: "1", planned_started_on: "not-a-date", unit_id: UNKNOWN_ID }));
  expectValidationError(formats, { code: "VALIDATION_ERROR", context: "非法 UUID / 日期" });
  assert.equal(ruleFor(formats, "bom_id"), "isUuid");
  assert.equal(ruleFor(formats, "planned_started_on"), "isDateString");

  // @IsInt 的 bom_version 传字符串
  const intField = await asAdmin((client) =>
    client.post(ORDERS, { bom_id: UNKNOWN_ID, bom_version: "1", execution_mode: "in_house", execution_location_id: UNKNOWN_ID, order_no: "PROBE", planned_quantity: "1", unit_id: UNKNOWN_ID }));
  expectValidationError(intField, { code: "VALIDATION_ERROR", context: "bom_version 非整数" });
  assert.equal(ruleFor(intField, "bom_version"), "isInt");

  // @MaxLength(1000) 的 remark
  const tooLong = await asAdmin((client) =>
    client.post(ORDERS, { bom_id: UNKNOWN_ID, bom_version: 1, execution_mode: "in_house", execution_location_id: UNKNOWN_ID, order_no: "PROBE", planned_quantity: "1", remark: "x".repeat(1001), unit_id: UNKNOWN_ID }));
  expectValidationError(tooLong, { code: "VALIDATION_ERROR", context: "remark 超长" });
  assert.equal(ruleFor(tooLong, "remark"), "maxLength");
});

test("production_orders.patch_validates_the_dto_before_the_existence_check", async () => {
  // 校验层先于存在性层：未知 id + 非法字段 → 400 而不是 404
  const badUuid = await asAdmin((client) => client.patch(`${ORDERS}/${UNKNOWN_ID}`, { execution_location_id: "x" }));
  expectValidationError(badUuid, { code: "VALIDATION_ERROR", context: "PATCH 非法 UUID" });
  assert.equal(ruleFor(badUuid, "execution_location_id"), "isUuid");

  const whitelist = await asAdmin((client) => client.patch(`${ORDERS}/${UNKNOWN_ID}`, { bogus: 1 }));
  expectValidationError(whitelist, { code: "VALIDATION_ERROR", context: "PATCH 未白名单字段" });
  assert.equal(ruleFor(whitelist, "bogus"), "whitelistValidation");
});

test("production_orders.operations_routes_validate_their_bodies", async () => {
  // 单道工序（controller.ts:12）：operation_id / sequence_no / target_quantity 全必填
  const single = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations`, {}));
  expectValidationError(single, { code: "VALIDATION_ERROR", context: "POST /:id/operations {}" });
  for (const field of ["operation_id", "sequence_no", "target_quantity"]) {
    assert.ok(detailFields(single).includes(field), `details 应包含 ${field}`);
  }

  // 批量工序（controller.ts:14）：@ArrayNotEmpty
  const empty = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations/batch`, { operations: [] }));
  expectValidationError(empty, { code: "VALIDATION_ERROR", context: "batch 空数组" });
  assert.equal(ruleFor(empty, "operations"), "arrayNotEmpty");

  // @ArrayMaxSize(50)
  const tooMany = await asAdmin((client) =>
    client.post(`${ORDERS}/${UNKNOWN_ID}/operations/batch`, { operations: Array.from({ length: 51 }, () => ({ operation_id: UNKNOWN_ID, target_quantity: "1" })) }));
  expectValidationError(tooMany, { code: "VALIDATION_ERROR", context: "batch 51 项" });
  assert.equal(ruleFor(tooMany, "operations"), "arrayMaxSize");

  // KNOWN_DEFECT（已记录为 recon 的 D10 / nested_dto_validation_loses_details）：嵌套数组元素的
  // 校验错误全部落空 —— exceptionFactory 只读顶层 error.constraints，不递归 error.children
  // （api-exception.filter.ts:26），因此 details 是空数组，客户端拿不到字段定位。
  const nested = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations/batch`, { operations: [{ operation_id: "not-a-uuid", target_quantity: 1 }] }));
  expectValidationError(nested, { code: "VALIDATION_ERROR", context: "batch 嵌套字段非法" });
  assert.deepEqual(nested.body.error.details, [], "嵌套元素错误丢失 details（D10）；修复后此断言应变红");

  // 取消工序（controller.ts:17）：reason 必填
  const cancel = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations/${UNKNOWN_ID}/cancel`, {}));
  expectValidationError(cancel, { code: "VALIDATION_ERROR", context: "cancel {}" });
  assert.equal(ruleFor(cancel, "reason"), "isString");

  // 状态流转（controller.ts:16）：target 必填
  const transition = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/transition`, {}));
  expectValidationError(transition, { code: "VALIDATION_ERROR", context: "transition {}" });
  assert.equal(ruleFor(transition, "target"), "isString");
});

// ---------------------------------------------------------------------------
// 业务规则层（422）：全部在写库之前抛错，因此不产生任何业务数据
// ---------------------------------------------------------------------------

test("production_orders.transition_and_cancel_require_a_reason_422", async () => {
  // transition 的第一行就校验 reason（service.ts:285），尚未触碰数据库
  const missingReason = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/transition`, { target: "in_progress" }));
  expectBusinessRuleViolation(missingReason, { code: "TRANSITION_REASON_REQUIRED", context: "transition 无 reason" });

  // 空白 reason 同样被拒（service.ts:241 的 !reason?.trim()）
  const blankReason = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations/${UNKNOWN_ID}/cancel`, { reason: "   " }));
  expectBusinessRuleViolation(blankReason, { code: "CANCELLATION_REASON_REQUIRED", context: "cancel 空白 reason" });
});

test("production_orders.operation_quantity_and_sequence_must_be_positive_422", async () => {
  // parseDecimal 在读取任何行之前执行（service.ts:150,220）
  const zeroQuantity = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations`, { operation_id: UNKNOWN_ID, sequence_no: 1, target_quantity: "0" }));
  expectBusinessRuleViolation(zeroQuantity, { code: "INVALID_OPERATION_TARGET", context: "target_quantity=0" });

  const negativeQuantity = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations`, { operation_id: UNKNOWN_ID, sequence_no: 1, target_quantity: "-1" }));
  expectBusinessRuleViolation(negativeQuantity, { code: "INVALID_OPERATION_TARGET", context: "target_quantity=-1" });

  // sequence_no 是 @IsInt 但业务要求正整数（service.ts:151）
  const zeroSequence = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations`, { operation_id: UNKNOWN_ID, sequence_no: 0, target_quantity: "1" }));
  expectBusinessRuleViolation(zeroSequence, { code: "INVALID_OPERATION_TARGET", context: "sequence_no=0" });

  // 改工序同样是 422（service.ts:221）
  const patchSequence = await asAdmin((client) => client.patch(`${ORDERS}/${UNKNOWN_ID}/operations/${UNKNOWN_ID}`, { sequence_no: 0 }));
  expectBusinessRuleViolation(patchSequence, { code: "INVALID_OPERATION_TARGET", context: "PATCH sequence_no=0" });
});

test("production_orders.batch_rejects_duplicate_operation_in_one_submission_422", async () => {
  // 同一提交内重复 operation_id（service.ts:185），在查询工序主数据之前判定
  const response = await asAdmin((client) =>
    client.post(`${ORDERS}/${UNKNOWN_ID}/operations/batch`, { operations: [{ operation_id: UNKNOWN_ID, target_quantity: "1" }, { operation_id: UNKNOWN_ID, target_quantity: "2" }] }));
  const body = expectBusinessRuleViolation(response, { code: "PRODUCTION_OPERATION_BATCH_DUPLICATE", context: "batch 重复工序" });
  assert.equal(body.error.details[0].operation_id, UNKNOWN_ID, "details 应指出重复的 operation_id");
});

// ---------------------------------------------------------------------------
// 存在性层（404）：写路由全部在写入前失败
// ---------------------------------------------------------------------------

test("production_orders.write_routes_with_unknown_ids_fail_at_the_existence_layer_404", async () => {
  // PATCH / DELETE / 补建包装：service 先 get(id)（service.ts:122,136,66）→ 404，未发生写入
  const patch = await asAdmin((client) => client.patch(`${ORDERS}/${UNKNOWN_ID}`, {}));
  expectErrorEnvelope(patch, { code: "PRODUCTION_ORDER_NOT_FOUND", context: "PATCH /:id 未知 id", status: 404 });

  const remove = await asAdmin((client) => client.del(`${ORDERS}/${UNKNOWN_ID}`));
  expectErrorEnvelope(remove, { code: "PRODUCTION_ORDER_NOT_FOUND", context: "DELETE /:id 未知 id", status: 404 });

  const packaging = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/packaging-operation`));
  expectErrorEnvelope(packaging, { code: "PRODUCTION_ORDER_NOT_FOUND", context: "POST /:id/packaging-operation 未知 id", status: 404 });

  // 添加工序：先查工序主数据（service.ts:152）→ 404，未发生写入
  const addOperation = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations`, { operation_id: UNKNOWN_ID, sequence_no: 1, target_quantity: "1" }));
  expectErrorEnvelope(addOperation, { code: "OPERATION_NOT_FOUND", context: "POST /:id/operations 未知工序", status: 404 });

  // 批量添加工序：主数据缺失逐个回报（service.ts:189）
  const addOperations = await asAdmin((client) => client.post(`${ORDERS}/${UNKNOWN_ID}/operations/batch`, { operations: [{ operation_id: UNKNOWN_ID, target_quantity: "1" }] }));
  const batchBody = expectErrorEnvelope(addOperations, { code: "OPERATION_NOT_FOUND", context: "POST /:id/operations/batch 未知工序", status: 404 });
  assert.deepEqual(batchBody.error.details, [{ operation_id: UNKNOWN_ID }]);

  // 改工序：事务内查生产单（service.ts:227）→ 404 且事务回滚，未发生写入
  const updateOperation = await asAdmin((client) => client.patch(`${ORDERS}/${UNKNOWN_ID}/operations/${UNKNOWN_ID}`, { sequence_no: 1 }));
  expectErrorEnvelope(updateOperation, { code: "PRODUCTION_ORDER_NOT_FOUND", context: "PATCH /:id/operations/:operationId 未知 id", status: 404 });
});

test("production_orders.create_with_unknown_sales_order_returns_404_without_writing", async () => {
  // refs() 在建单事务之前校验销售单（service.ts:303-304）→ 404，不落任何数据
  const response = await asAdmin((client) =>
    client.post(ORDERS, { bom_id: UNKNOWN_ID, bom_version: 1, execution_mode: "in_house", execution_location_id: UNKNOWN_ID, order_no: "NO-SUCH-ORDER-9999", planned_quantity: "1", unit_id: UNKNOWN_ID }));
  const body = expectErrorEnvelope(response, { code: "SALES_ORDER_NOT_CONFIRMED", context: "POST / 未知销售单", status: 404 });
  assert.equal(body.meta.path, ORDERS);
});
