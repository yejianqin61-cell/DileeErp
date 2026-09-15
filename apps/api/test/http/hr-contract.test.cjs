// 迪礼 ERP —— HR 模块 HTTP 契约测试。
//
// 被测生产文件：apps/api/src/modules/hr/hr.controller.ts（9 GET + 17 POST + 4 PATCH + 3 DELETE = 33 路由）
// 关注点：员工考勤/绩效、工资台账、工资应付、工资支付四组路由的信封、状态码、鉴权、DTO 校验、
//         查询参数处理、资源不存在时的模块级精确错误码。
//
// 权限模型（实测 + 代码依据）：
//   本控制器只有**类级** `@RequireModules("hr")`（hr.controller.ts:30），33 个路由上**没有任何**
//   方法级 `@RequireModules` / `@RequireAnyModules`。因此 ModulePermissionGuard 的
//   "类级 AND 方法级" 组合路径（module-permission.guard.ts:26-27）在 HR 上不可达 —— 全部 33 路由
//   只要求 hr 模块；administrator 角色在守卫第 5 步短路（module-permission.guard.ts:22-23），
//   所以管理员对所有 HR 路由恒通。AND 语义由 apps/api/test/unit/module-permission-guard.test.cjs 覆盖。
//
// 测试纪律（遵守任务约定与 docs/test/02-test-environment-runbook.md §7.5）：
//   1. **只做只读探测**：本文件不创建/修改/删除任何业务数据 —— 多个 agent 同时在打同一个库；
//   2. 写端点（POST/PATCH/DELETE）只断言**鉴权层（401）与 DTO 校验层（400）**，绝不提交合法业务体；
//   3. 详情类 GET 用**随机 UUID** 断言 404（不存在的资源，不产生任何写入）；
//   4. **每个用例内部自行登录一次并立即使用**：AuthService.login() 会先删该用户的全部 session
//      （auth.service.ts:29），跨用例共享 cookie 会被并发登录踢掉；
//      adminClient() 另外对"中途 401"做重连重放（最多 6 次尝试；并发 agent 会互相踢会话，见其注释）；
//   5. 必须串行运行：node --test --test-concurrency=1 apps/api/test/http/hr-contract.test.cjs
//
// 运行：API_BASE_URL=http://127.0.0.1:3001 INITIAL_ADMIN_USERNAME=admin \
//       INITIAL_ADMIN_PASSWORD=... node --test --test-concurrency=1 apps/api/test/http/hr-contract.test.cjs
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
  expectValidationError,
  login,
} = require("../../../../tests/helpers/api-client.cjs");

const baseUrl = process.env.API_BASE_URL;
if (!baseUrl) throw new Error("TEST_BLOCKED: API_BASE_URL is required for HTTP API tests");

const HR = "/api/v1/hr";

/** 路由表中的占位 id：仅用于匿名 401 扫描，请求在守卫处即被拒绝，不会触达任何资源。 */
const PLACEHOLDER_ID = "0f8f7f9a-1c2d-4e3f-8a9b-0c1d2e3f4a5b";

/**
 * 每次调用生成一个新的随机 UUID 作为 "一定不存在" 的资源 id。
 * hr.controller.ts:42,51,60 的详情路由没有 ParseUUIDPipe，随机 v4 UUID 是唯一能同时
 * 保证 "格式合法" 与 "资源不存在" 的探测输入。
 */
const missingId = () => randomUUID();

/** hr.controller.ts 的 33 个路由（方法, 路径, 请求体）。顺序与控制器声明一致。 */
const ROUTES = [
  ["GET", `${HR}/attendance-records`],
  ["POST", `${HR}/attendance-records`, {}],
  ["PATCH", `${HR}/attendance-records/${PLACEHOLDER_ID}`, {}],
  ["DELETE", `${HR}/attendance-records/${PLACEHOLDER_ID}`, {}],
  ["GET", `${HR}/performance-records`],
  ["POST", `${HR}/performance-records`, {}],
  ["PATCH", `${HR}/performance-records/${PLACEHOLDER_ID}`, {}],
  ["DELETE", `${HR}/performance-records/${PLACEHOLDER_ID}`, {}],
  ["GET", `${HR}/payroll-ledgers`],
  ["GET", `${HR}/payroll-ledgers/${PLACEHOLDER_ID}`],
  ["POST", `${HR}/payroll-ledgers/generate`, {}],
  // 按月导入全部员工（2026-09-15）：幂等批量创建草稿台账，车间员工同时汇总生产日报金额。
  ["POST", `${HR}/payroll-ledgers/import-month`, { month: "2026-09" }],
  ["PATCH", `${HR}/payroll-ledgers/${PLACEHOLDER_ID}`, {}],
  ["DELETE", `${HR}/payroll-ledgers/${PLACEHOLDER_ID}`, {}],
  ["POST", `${HR}/payroll-ledgers/${PLACEHOLDER_ID}/reopen`, {}],
  ["POST", `${HR}/payroll-ledgers/${PLACEHOLDER_ID}/confirm`],
  ["POST", `${HR}/payroll-ledgers/${PLACEHOLDER_ID}/close`],
  ["GET", `${HR}/payroll-ledgers/${PLACEHOLDER_ID}/summary`],
  ["GET", `${HR}/payroll-payables`],
  ["GET", `${HR}/payroll-payables/${PLACEHOLDER_ID}`],
  ["POST", `${HR}/payroll-ledgers/${PLACEHOLDER_ID}/payable`, {}],
  ["POST", `${HR}/payroll-payables/${PLACEHOLDER_ID}/confirm`],
  ["POST", `${HR}/payroll-payables/${PLACEHOLDER_ID}/reopen`, {}],
  ["POST", `${HR}/payroll-payables/${PLACEHOLDER_ID}/reverse`, {}],
  ["POST", `${HR}/payroll-ledgers/${PLACEHOLDER_ID}/adjustments`, {}],
  ["POST", `${HR}/payroll-adjustments/${PLACEHOLDER_ID}/post`],
  ["POST", `${HR}/payroll-adjustments/${PLACEHOLDER_ID}/reverse`, {}],
  ["GET", `${HR}/salary-payments`],
  ["GET", `${HR}/salary-payments/${PLACEHOLDER_ID}`],
  ["POST", `${HR}/salary-payments`, {}],
  ["PATCH", `${HR}/salary-payments/${PLACEHOLDER_ID}`, {}],
  ["POST", `${HR}/salary-payments/${PLACEHOLDER_ID}/post`, {}],
  ["POST", `${HR}/salary-payments/${PLACEHOLDER_ID}/reverse`, {}],
];

/** 方法名 → apiClient 的调用名（DELETE 是 `del`，不是 `delete`）。 */
const VERB = { DELETE: "del", GET: "get", PATCH: "patch", POST: "post" };

/** 无分页的列表端点（返回裸数组 + `meta: {}`）。 */
const LIST_ENDPOINTS = [`${HR}/attendance-records`, `${HR}/performance-records`, `${HR}/payroll-ledgers`, `${HR}/payroll-payables`, `${HR}/salary-payments`];

/**
 * 管理员客户端。**每个用例内部调用一次并立即使用**（不要缓存或跨用例共享）。
 * 单会话语义见 auth.service.ts:29。
 *
 * 唯一附加的能力是 "401 → 重新登录并原样重放"（最多 6 次尝试）：
 * 本 API 单会话，且多个测试进程会同时以 admin 登录，任何一次**他人**登录都会立刻作废本进程的
 * cookie，表现为用例跑到一半突然 401（实测：并发环境下单次会话常在 100ms 内被踢，约 40% 的请求
 * 会命中 401，重连后立刻重放仍有约 20% 会再次被踢）。重放对断言是**中性的**：
 *   * 本文件所有已认证请求要么是只读 GET，要么是必然被 DTO 拒绝的非法写请求（400），重放不产生业务副作用；
 *   * 真正的鉴权回归（端点恒 401）在重放后依然是 401，断言照常失败。
 */
const SESSION_ATTEMPTS = 6;

async function adminClient() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) throw new Error("TEST_BLOCKED: INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required");

  async function connect() {
    const session = await login(baseUrl, { password, username });
    assert.equal(session.status, 201, `登录应返回 201（所有 POST 的默认状态码），实际 ${session.status}`);
    assert.ok(session.cookie, "登录必须下发 dilee_session Cookie");
    return apiClient(baseUrl, { cookie: session.cookie });
  }

  let client = await connect();
  const send = async (method, path, body) => {
    const invoke = (target) => target[VERB[method]](path, body);
    let response = await invoke(client);
    for (let attempt = 1; attempt < SESSION_ATTEMPTS && response.status === 401; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25)); // 让开并发登录的瞬时冲击
      client = await connect();
      response = await invoke(client);
    }
    return response;
  };

  return {
    del: (path, body) => send("DELETE", path, body),
    get: (path) => send("GET", path),
    patch: (path, body) => send("PATCH", path, body),
    post: (path, body) => send("POST", path, body),
  };
}

/** 400 且 code 固定为 VALIDATION_ERROR（ValidationPipe 的 exceptionFactory，main.ts:23-27）。 */
function expectDtoValidation(response, context) {
  const body = expectValidationError(response, { context });
  assert.equal(body.error.code, "VALIDATION_ERROR", `${context} DTO 校验失败必须使用 VALIDATION_ERROR`);
  assert.ok(body.error.details.length > 0, `${context} 校验失败必须给出可定位的字段级 details`);
  return body;
}

/** 断言 details 中存在某个字段的某条规则（用于锁定 allowlist 与必填校验）。 */
function expectDetail(body, field, rule, context) {
  const hit = body.error.details.some((item) => item.field === field && item.rule === rule);
  assert.ok(hit, `${context} details 应包含 ${field}/${rule}，实际 ${JSON.stringify(body.error.details)}`);
}

// ---------------------------------------------------------------------------
// 1. 鉴权：33 个路由全部拒绝匿名请求（不需要登录，因此不受单会话竞争影响）
// ---------------------------------------------------------------------------

test("hr.anonymous_requests_to_all_33_routes_are_rejected_with_401_unauthenticated", async () => {
  assert.equal(ROUTES.length, 33, "路由表必须与 hr.controller.ts 的 33 个路由一一对应（9 GET + 17 POST + 4 PATCH + 3 DELETE）");
  const anonymous = apiClient(baseUrl);

  for (const [method, path, body] of ROUTES) {
    // AuthenticationGuard 与 ModulePermissionGuard 在 ValidationPipe 之前运行，
    // 所以即使请求体非法，匿名请求也必须是 401 而不是 400。
    const response = await anonymous[VERB[method]](path, body);
    expectUnauthenticated(response, `${method} ${path}`);
    expectRequestIdHeader(response, `${method} ${path}`);
  }
});

// ---------------------------------------------------------------------------
// 2. 成功信封：列表端点返回裸数组，meta 为空对象（HR 全部列表无分页，recon I9）
// ---------------------------------------------------------------------------

test("hr.list_endpoints_return_bare_arrays_with_empty_meta_and_no_pagination", async () => {
  const client = await adminClient();

  for (const path of LIST_ENDPOINTS) {
    const body = expectSuccessEnvelope(await client.get(path), { context: path, status: 200 });
    assert.ok(Array.isArray(body.data), `${path} 的 data 必须是裸数组（分页信息只在 meta 里，而这里没有分页）`);
    assert.deepEqual(body.meta, {}, `${path} 的 meta 当前恒为 {}：Wrapper 只写 meta: {}（hr.controller.ts:65），无分页字段`);
    for (const field of ["page", "page_size", "total"]) {
      assert.equal(field in body.meta, false, `${path} 不应声明分页字段 ${field}（recon I9：HR 列表全量返回裸数组）`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. 查询参数：HR 全部为 `@Query("name")` 字面量形态 → 未知参数静默忽略
// ---------------------------------------------------------------------------

test("hr.unknown_and_out_of_range_query_params_are_silently_ignored", async () => {
  // hr.controller.ts:33,37,41,50,59 全部使用 `@Query("employee_id") employeeId?: string` 这类
  // **基本类型**参数，metatype 为 String → ValidationPipe 跳过校验（main.ts:19-28 的
  // whitelist/forbidNonWhitelisted 只对 DTO 类生效），未知参数被静默丢弃。
  // 这与 `?bogus=1` 会 400 whitelistValidation 的 DTO 端点不同（recon D9 的"分裂"行为）。
  const client = await adminClient();

  for (const path of LIST_ENDPOINTS) {
    expectSuccessEnvelope(await client.get(`${path}?bogus=1`), { context: `${path}?bogus=1`, status: 200 });
    // 分页参数同理：HR 列表没有分页 DTO，201/0/abc 都不会被拒绝（对比 contract-guardrails 的 400）
    expectSuccessEnvelope(await client.get(`${path}?page_size=201&page=0`), { context: `${path}?page_size=201&page=0`, status: 200 });
  }
  // 未实现的过滤参数（status 未命中枚举）同样不报错
  expectSuccessEnvelope(await client.get(`${HR}/salary-payments?status=bogus`), { context: "salary-payments?status=bogus", status: 200 });
});

// ---------------------------------------------------------------------------
// 4. 404：资源不存在时使用模块级精确错误码（自定义 code 覆盖全局默认 NOT_FOUND）
// ---------------------------------------------------------------------------

test("hr.detail_endpoints_with_random_uuid_return_404_with_module_specific_codes", async () => {
  // 各 service 的 notFound() 抛 NotFoundException({ code, message, details: [] })，
  // ApiExceptionFilter 保留 payload 里的 code（api-exception.filter.ts:43-45），
  // 因此 404 的 code 不是全局默认的 NOT_FOUND，而是模块自己的大写下划线码。
  const client = await adminClient();
  const cases = [
    [`${HR}/payroll-ledgers/${missingId()}`, "PAYROLL_LEDGER_NOT_FOUND"],
    [`${HR}/payroll-ledgers/${missingId()}/summary`, "PAYROLL_LEDGER_NOT_FOUND"],
    [`${HR}/payroll-payables/${missingId()}`, "PAYROLL_PAYABLE_NOT_FOUND"],
    [`${HR}/salary-payments/${missingId()}`, "SALARY_PAYMENT_NOT_FOUND"],
  ];

  for (const [path, code] of cases) {
    const response = await client.get(path);
    const body = expectErrorEnvelope(response, { context: path, status: 404 });
    assert.equal(body.error.code, code, `${path} 应返回模块级精确错误码`);
    assert.notEqual(body.error.code, "NOT_FOUND", `${path} 不应退化为全局默认码 NOT_FOUND`);
    assert.deepEqual(body.error.details, [], `${path} 的 details 由 service 显式置空`);
    assert.equal(body.meta.path, path, "错误信封的 meta.path 必须等于请求路径");
  }
});

// ---------------------------------------------------------------------------
// 5. 查询参数取值校验：无 DTO → 由 service 抛 422 而不是框架抛 400
// ---------------------------------------------------------------------------

test("KNOWN_DEFECT hr.invalid_query_values_yield_422_invalid_date_instead_of_400", async () => {
  // 期望（docs/design/global-api-contract.md:61）：请求格式校验失败 → 400 VALIDATION_ERROR。
  // 实际：查询参数没有 DTO，service 的 date() 抛 UnprocessableEntityException
  //      （attendance-performance.service.ts:21、payroll-ledger.service.ts:109）→ 422 INVALID_DATE。
  // 同一形态在 production/employee-daily-reports 已记录（recon §6.3 第 403 行），属系统性偏差；
  // 若未来改为 DTO 校验（400），本用例应变红并同步更新。
  const client = await adminClient();
  const cases = [
    [`${HR}/attendance-records?from=abc`, "attendance-records?from=abc"],
    [`${HR}/performance-records?period_start=not-a-date`, "performance-records?period_start=not-a-date"],
    [`${HR}/payroll-ledgers?period_start=2026-13-45`, "payroll-ledgers?period_start=2026-13-45"],
  ];

  for (const [path, context] of cases) {
    const body = expectErrorEnvelope(await client.get(path), { context, status: 422 });
    assert.equal(body.error.code, "INVALID_DATE", `${context} 当前使用 service 级业务码（应为 400 VALIDATION_ERROR —— 见文件头 KNOWN_DEFECT 说明）`);
  }

  // 合法日期区间不报错（读取路径正常）
  expectSuccessEnvelope(await client.get(`${HR}/payroll-ledgers?from=2026-01-01&to=2026-12-31`), { context: "payroll-ledgers?from&to", status: 200 });
});

test("hr.payroll_month_query_filter_rejects_a_malformed_month_with_422", async () => {
  // 2026-09-15 新增 month 过滤（工资台账与工资付款都用它）。它与 from/to 一样是**查询参数**，
  // 没有 DTO：service 的 monthRange（hr-payroll.domain.ts）抛 422 INVALID_MONTH。
  // 与上一个用例记录的是同一处系统性偏差（查询参数的格式校验不在 DTO 层）。
  const client = await adminClient();
  for (const path of [`${HR}/payroll-ledgers?month=2026/09`, `${HR}/payroll-ledgers?month=2026-13`, `${HR}/salary-payments?month=2026/09`]) {
    const body = expectErrorEnvelope(await client.get(path), { context: path, status: 422 });
    assert.equal(body.error.code, "INVALID_MONTH", `${path} 当前使用 service 级业务码（应为 400 VALIDATION_ERROR —— 见文件头 KNOWN_DEFECT 说明）`);
  }
  // 合法的 YYYY-MM 正常返回
  expectSuccessEnvelope(await client.get(`${HR}/payroll-ledgers?month=2026-09`), { context: "payroll-ledgers?month=2026-09", status: 200 });
  expectSuccessEnvelope(await client.get(`${HR}/salary-payments?month=2026-09`), { context: "salary-payments?month=2026-09", status: 200 });
});

// ---------------------------------------------------------------------------
// 6-8. 写端点的 DTO 校验层：只断言 400，不提交任何合法业务数据
// ---------------------------------------------------------------------------

test("hr.attendance_and_performance_write_bodies_are_rejected_before_the_service_layer", async () => {
  const client = await adminClient();
  const id = missingId();

  // 空体：必填字段全部缺失
  expectDetail(expectDtoValidation(await client.post(`${HR}/attendance-records`, {}), "POST attendance-records {}"), "employee_id", "isUuid", "POST attendance-records {}");
  expectDetail(expectDtoValidation(await client.post(`${HR}/performance-records`, {}), "POST performance-records {}"), "period_start", "isDateString", "POST performance-records {}");

  // 未知字段：whitelist + forbidNonWhitelisted（main.ts:20-22）
  expectDetail(expectDtoValidation(await client.post(`${HR}/attendance-records`, { bogus: 1 }), "POST attendance-records bogus"), "bogus", "whitelistValidation", "POST attendance-records bogus");
  expectDetail(expectDtoValidation(await client.patch(`${HR}/attendance-records/${id}`, { bogus: 1 }), "PATCH attendance-records bogus"), "bogus", "whitelistValidation", "PATCH attendance-records bogus");
  expectDetail(expectDtoValidation(await client.patch(`${HR}/performance-records/${id}`, { bogus: 1 }), "PATCH performance-records bogus"), "bogus", "whitelistValidation", "PATCH performance-records bogus");

  // DELETE 要求请求体（recon I12）：reason 为必填字符串且 ≤1000 字符
  expectDetail(expectDtoValidation(await client.del(`${HR}/attendance-records/${id}`, {}), "DELETE attendance-records {}"), "reason", "isString", "DELETE attendance-records {}");
  expectDetail(expectDtoValidation(await client.del(`${HR}/performance-records/${id}`, { reason: 123 }), "DELETE performance-records reason=123"), "reason", "isString", "DELETE performance-records reason=123");
});

test("hr.payroll_ledger_write_bodies_are_rejected_before_the_service_layer", async () => {
  const client = await adminClient();
  const id = missingId();

  // POST /payroll-ledgers/generate：period_start/period_end/currency 必填
  const generate = expectDtoValidation(await client.post(`${HR}/payroll-ledgers/generate`, {}), "POST payroll-ledgers/generate {}");
  expectDetail(generate, "period_start", "isDateString", "POST payroll-ledgers/generate {}");
  expectDetail(generate, "currency", "isString", "POST payroll-ledgers/generate {}");
  expectDetail(expectDtoValidation(await client.post(`${HR}/payroll-ledgers/generate`, { bogus: 1 }), "POST payroll-ledgers/generate bogus"), "bogus", "whitelistValidation", "POST payroll-ledgers/generate bogus");

  // POST /payroll-ledgers/import-month：month 必填且形如 YYYY-MM（2026-09-15 新增的批量导入）
  const importMonth = expectDtoValidation(await client.post(`${HR}/payroll-ledgers/import-month`, {}), "POST import-month {}");
  expectDetail(importMonth, "month", "matches", "POST import-month {}");
  expectDetail(expectDtoValidation(await client.post(`${HR}/payroll-ledgers/import-month`, { month: "2026/09" }), "POST import-month bad month"), "month", "matches", "POST import-month bad month");
  // 未知字段仍被 whitelist 拒绝；部门/岗位必须是 UUID
  expectDetail(expectDtoValidation(await client.post(`${HR}/payroll-ledgers/import-month`, { month: "2026-09", bogus: 1 }), "POST import-month bogus"), "bogus", "whitelistValidation", "POST import-month bogus");
  expectDetail(expectDtoValidation(await client.post(`${HR}/payroll-ledgers/import-month`, { month: "2026-09", department_id: "dep-1" }), "POST import-month bad department"), "department_id", "isUuid", "POST import-month bad department");

  // PATCH /payroll-ledgers/:id：字段全可选，但类型仍受约束
  expectDetail(expectDtoValidation(await client.patch(`${HR}/payroll-ledgers/${id}`, { employee_id: "not-a-uuid" }), "PATCH payroll-ledgers employee_id"), "employee_id", "isUuid", "PATCH payroll-ledgers employee_id");

  // POST /payroll-ledgers/:id/reopen：reason 必填、≤1000
  expectDetail(expectDtoValidation(await client.post(`${HR}/payroll-ledgers/${id}/reopen`, {}), "POST reopen {}"), "reason", "isString", "POST reopen {}");
  const tooLong = expectDtoValidation(await client.post(`${HR}/payroll-ledgers/${id}/reopen`, { reason: "x".repeat(1001) }), "POST reopen 1001 chars");
  expectDetail(tooLong, "reason", "maxLength", "POST reopen 1001 chars");

  // POST /payroll-ledgers/:id/adjustments：adjustment_type/effect/amount/reason 必填，effect 限枚举
  const adjustment = expectDtoValidation(await client.post(`${HR}/payroll-ledgers/${id}/adjustments`, {}), "POST adjustments {}");
  expectDetail(adjustment, "effect", "isIn", "POST adjustments {}");
  expectDetail(adjustment, "amount", "isString", "POST adjustments {}");
  const badEffect = expectDtoValidation(await client.post(`${HR}/payroll-ledgers/${id}/adjustments`, { adjustment_type: "bonus", effect: "sideways", amount: "1", reason: "x" }), "POST adjustments bad effect");
  expectDetail(badEffect, "effect", "isIn", "POST adjustments bad effect");

  // POST /payroll-adjustments/:id/reverse：reason 必填
  expectDetail(expectDtoValidation(await client.post(`${HR}/payroll-adjustments/${id}/reverse`, {}), "POST payroll-adjustments reverse {}"), "reason", "isString", "POST payroll-adjustments reverse {}");
});

test("hr.payroll_payable_and_salary_payment_write_bodies_are_rejected_before_the_service_layer", async () => {
  const client = await adminClient();
  const id = missingId();

  // POST /payroll-ledgers/:id/payable：DTO 字段全可选 → 空体能通过校验，只有未知字段能触发 400
  // （因此该端点的 400 只能来自 whitelist，业务层的 404/422 属写路径，本文件不触碰）
  expectDetail(expectDtoValidation(await client.post(`${HR}/payroll-ledgers/${id}/payable`, { bogus: 1 }), "POST payable bogus"), "bogus", "whitelistValidation", "POST payable bogus");

  // POST /payroll-payables/:id/reopen | /reverse：reason 必填
  expectDetail(expectDtoValidation(await client.post(`${HR}/payroll-payables/${id}/reopen`, {}), "POST payables reopen {}"), "reason", "isString", "POST payables reopen {}");
  expectDetail(expectDtoValidation(await client.post(`${HR}/payroll-payables/${id}/reverse`, {}), "POST payables reverse {}"), "reason", "isString", "POST payables reverse {}");

  // POST /salary-payments：payment_date/amount/currency/payment_method 必填
  const payment = expectDtoValidation(await client.post(`${HR}/salary-payments`, {}), "POST salary-payments {}");
  expectDetail(payment, "payment_date", "isDateString", "POST salary-payments {}");
  expectDetail(payment, "payment_method", "isString", "POST salary-payments {}");

  // PATCH /salary-payments/:id：未知字段拒绝
  expectDetail(expectDtoValidation(await client.patch(`${HR}/salary-payments/${id}`, { bogus: 1 }), "PATCH salary-payments bogus"), "bogus", "whitelistValidation", "PATCH salary-payments bogus");

  // POST /salary-payments/:id/post：allocations 必须是数组（嵌套 DTO 校验，见 recon D10）
  expectDetail(expectDtoValidation(await client.post(`${HR}/salary-payments/${id}/post`, {}), "POST salary-payments post {}"), "allocations", "isArray", "POST salary-payments post {}");

  // POST /salary-payments/:id/reverse：reason 必填
  expectDetail(expectDtoValidation(await client.post(`${HR}/salary-payments/${id}/reverse`, {}), "POST salary-payments reverse {}"), "reason", "isString", "POST salary-payments reverse {}");
});

// ---------------------------------------------------------------------------
// 9. 路由层：方法不匹配与未知路径都走 404，后端没有 405
// ---------------------------------------------------------------------------

test("hr.wrong_method_and_unknown_route_return_404_never_405", async () => {
  // 路由解析在守卫之前完成：未注册的方法/路径不会被鉴权拦成 401（实测匿名即 404）。
  const anonymous = apiClient(baseUrl);
  const cases = [
    ["put", `${HR}/salary-payments`, "PUT"], // 集合只支持 GET/POST
    ["del", `${HR}/salary-payments`, "DELETE"], // 集合没有 DELETE（删除只存在于 /:id，且需 body）
    ["del", `${HR}/attendance-records`, "DELETE"],
    ["patch", `${HR}/attendance-records`, "PATCH"],
    ["post", `${HR}/payroll-ledgers`, "POST"], // 集合只支持 GET（生成走 /generate）
    ["post", `${HR}/salary-payments/${PLACEHOLDER_ID}`, "POST"],
  ];

  for (const [verb, path, label] of cases) {
    const response = await anonymous[verb](path, {});
    assert.notEqual(response.status, 405, `${label} ${path} 不应返回 405（Nest 未启用 405）`);
    expectNotFound(response, `${label} ${path}`);
    assert.match(response.body.error.message, new RegExp(`^Cannot ${label} `), `${label} ${path} 的 message 由 Nest 生成，为英文 Cannot <METHOD> ...`);
  }

  expectNotFound(await anonymous.get(`${HR}/does-not-exist`), "GET unknown route");
});

// ---------------------------------------------------------------------------
// 10. KNOWN_DEFECT：非法 UUID 的路径/查询参数落到 500，而不是 400
// ---------------------------------------------------------------------------

test("KNOWN_DEFECT hr.malformed_uuid_params_yield_500_request_error_instead_of_400", async () => {
  // 期望（docs/design/global-api-contract.md:61）：请求格式校验失败 → 400 VALIDATION_ERROR。
  // 实际：hr.controller.ts 的路径参数与查询参数都是裸 string，没有 ParseUUIDPipe / DTO 校验，
  //      非法 UUID 被原样传给 Prisma → Postgres 22P02 / Prisma P2023 → 非 HttpException
  //      → ApiExceptionFilter 兜底 500（api-exception.filter.ts:15）。
  //      责任文件：
  //        - apps/api/src/modules/hr/hr.controller.ts:42（GET payroll-ledgers/:id，无 ParseUUIDPipe）
  //          同 :51（payroll-payables/:id）、:60（salary-payments/:id）、:33,:41,:50（@Query("employee_id")）
  //        - apps/api/src/modules/hr/payroll-ledger.service.ts:13（get() 直接把字符串交给 findFirst）
  //          、salary-payment.service.ts:17、payroll-payable.service.ts:23
  //      附带影响：GET /hr/payroll-ledgers/generate（对 POST-only 路由发 GET）被 :42 的
  //      `GET payroll-ledgers/:id` 抢先匹配 → 500，而不是路由级 404。
  //      修复（加 ParseUUIDPipe 或 DTO）后本用例应变红，请同步更新本文件与 recon 记录。
  const client = await adminClient();
  const cases = [
    [`${HR}/payroll-ledgers/abc`, "path param"],
    [`${HR}/payroll-ledgers/abc/summary`, "path param + /summary"],
    [`${HR}/payroll-payables/abc`, "path param"],
    [`${HR}/salary-payments/abc`, "path param"],
    [`${HR}/attendance-records?employee_id=abc`, "query param"],
    [`${HR}/payroll-ledgers?employee_id=abc`, "query param"],
    [`${HR}/payroll-payables?employee_id=abc`, "query param"],
    [`${HR}/payroll-ledgers/generate`, "GET on POST-only path shadowed by :id"],
  ];

  for (const [path, label] of cases) {
    const body = expectErrorEnvelope(await client.get(path), { context: `${path} (${label})`, status: 500 });
    // 500 的机器码由 api-exception.filter.ts:55 固定为 REQUEST_ERROR；
    // 注意 docs/design/global-api-contract.md:67 声明 500 应为 INTERNAL_ERROR —— 文档与实现不一致（recon 已记录为 REQUEST_ERROR）。
    assert.equal(body.error.code, "REQUEST_ERROR", `${path} 当前把非法 UUID 归为 500 REQUEST_ERROR`);
  }
});
