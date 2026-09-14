// 生产模块「主数据」HTTP 契约测试：35 条路由
// （部门 6 / 岗位 6 / 员工 8（含导入导出）/ 地点 6 / 工序 6 / 工序单价 3）。
//
// 被测源文件：apps/api/src/modules/production/production-master-data.controller.ts
// 参考契约：docs/design/global-api-contract.md（成功 {data,meta} / 失败 {error,meta.path} / POST=201 / 无 405）
//
// 环境约束（否则会得到随机失败的用例）：
//   1. 本 API 是**单会话**的（auth.service.ts:28-31 登录先删该用户全部 session），因此：
//        - 每个用例内部自己登录一次并立即使用，不跨用例共享 cookie；
//        - 一个文件里绝不并发登录；
//        - 别处（其它 agent / 其它测试进程）用同一用户名登录会作废本会话，
//          所以本文件的请求封装在遇到意外 401 时会重新登录并**原样重试一次**（见 sessionApi）。
//   2. 运行必须串行：node --test --test-concurrency=1 <本文件>
//   3. 不对 /api/v1/health 硬断言 200（数据库竞争下会 503 DEPENDENCY_UNAVAILABLE）。
//
// 数据纪律（多个 agent 同时在打同一个库）：
//   - 只做只读探测：GET、匿名 401、带随机 UUID 的 404、以及**不会落库**的 400/422/404 写请求。
//   - 写路由（POST/PATCH/DELETE）只断言「鉴权 / 校验 / 未找到」层：
//       * 400：DTO 校验失败，ValidationPipe 在进入服务前拦截；
//       * 404：随机 UUID 找不到目标行，服务在写之前抛 NotFound（生产代码路径已逐条确认）；
//       * 422：服务在开启事务/写库**之前**做的取值断言（wage_mode / unit_price / 日期区间 / location_type）；
//     **从不提交合法创建体**（POST /production/departments 的合法体确实会 201 落库）。
//   - 员工导入只覆盖「上传前被拒绝」的路径（缺文件 / 非 Excel 扩展名 / 字段名错误 / 超 10MiB），
//     这些都在 controller 之前或服务抛异常之前结束，不写业务数据。
//
// 已知契约缺陷（本文件用 KNOWN_CONTRACT_DEFECT 标注，断言"当前行为"）：
//   - 非法 UUID 过滤参数在字面量型 @Query 端点上逃逸成 500（见文件末尾用例）。
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

const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:3001";
const P = "/api/v1/production";
/** 环境里不存在的 UUID：用于 404 探测，保证不会触碰真实数据。 */
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function jsonInit(method, payload) {
  if (payload === undefined) return { method };
  return { body: JSON.stringify(payload), headers: { "content-type": "application/json" }, method };
}

/** harness 的 apiClient 只发 JSON；multipart 直连 fetch，但复用同一 Cookie 会话。 */
async function postMultipart(cookie, path, form) {
  const response = await fetch(new URL(path, baseUrl), { body: form, headers: { cookie }, method: "POST" });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : await response.text().catch(() => "");
  return { body, contentType, headers: response.headers, requestId: response.headers.get("x-request-id"), status: response.status };
}

function fileForm(field, fileName, mimeType, content) {
  const form = new FormData();
  form.append(field, new Blob([content], { type: mimeType }), fileName);
  return form;
}

/**
 * 建立并**自我修复**的 admin 会话。
 *
 * 单会话约束下，本进程之外的任何一次 admin 登录都会让当前 Cookie 立刻失效（返回 401）。
 * 因此封装在收到意外 401 时重新登录并原样重试一次请求；真实的鉴权回归（永远 401）依然会失败。
 * 本文件所有带鉴权的探测都只用只读或不落库的请求，重试是幂等安全的。
 */
async function sessionApi() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) throw new Error("TEST_BLOCKED: INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required");
  const state = { client: null, cookie: null };
  async function loginOnce(context) {
    const session = await login(baseUrl, { password, username });
    assert.equal(session.status, 201, `${context} 登录应返回 201（所有 POST 的默认状态码），实际 ${session.status}：${JSON.stringify(session.body)}`);
    assert.ok(session.cookie, `${context} 登录必须下发 dilee_session Cookie`);
    state.cookie = session.cookie;
    state.client = apiClient(baseUrl, { cookie: session.cookie });
  }
  await loginOnce("初始");
  // 立刻用一次只读请求确认会话可用（被别处并发登录抢占时再登录一次）
  if ((await state.client.get(`${P}/departments`)).status === 401) await loginOnce("重试");

  // 实测：其它 agent 会用同一 admin 反复登录（单会话 → 本会话随时被作废），
  // 因此对意外 401 做有限次「重登 + 原样重试」。真正的鉴权回归（永远 401）依然失败。
  const REQUEST_ATTEMPTS = 5;
  async function withRetry(run) {
    let response = await run();
    for (let attempt = 1; response.status === 401 && attempt < REQUEST_ATTEMPTS; attempt += 1) {
      await loginOnce(`会话被抢占后第 ${attempt} 次重登`);
      response = await run();
    }
    return response;
  }
  return {
    call: (method, path, payload) => withRetry(() => state.client.raw(path, jsonInit(method, payload))),
    cookie: () => state.cookie,
    del: (path) => withRetry(() => state.client.del(path)),
    get: (path) => withRetry(() => state.client.get(path)),
    multipart: (path, form) => withRetry(() => postMultipart(state.cookie, path, form)),
    patch: (path, payload) => withRetry(() => state.client.patch(path, payload)),
    post: (path, payload) => withRetry(() => state.client.post(path, payload)),
  };
}

/** 业务级 404 使用精确的大写下划线码，因此只固定状态码 + 信封形状，再单独断言该模块码。 */
function expectBusinessNotFound(response, code, context) {
  expectErrorEnvelope(response, { context, status: 404 });
  assert.equal(response.body.error.code, code, `${context} 的业务 404 码`);
}

/**
 * 控制器上全部 35 条路由（方法 + 路径 + 是否存在请求体）。
 * 写路由的 body 只用非法/空体：鉴权用例里根本不会到达校验层（guard 先执行）。
 */
const ROUTES = [
  ["GET", `${P}/departments`, false],
  ["POST", `${P}/departments`, true],
  ["PATCH", `${P}/departments/${UNKNOWN_ID}`, true],
  ["PATCH", `${P}/departments/${UNKNOWN_ID}/active`, true],
  ["DELETE", `${P}/departments/${UNKNOWN_ID}`, false],
  ["POST", `${P}/departments/${UNKNOWN_ID}/restore`, false],
  ["GET", `${P}/positions`, false],
  ["POST", `${P}/positions`, true],
  ["PATCH", `${P}/positions/${UNKNOWN_ID}`, true],
  ["PATCH", `${P}/positions/${UNKNOWN_ID}/active`, true],
  ["DELETE", `${P}/positions/${UNKNOWN_ID}`, false],
  ["POST", `${P}/positions/${UNKNOWN_ID}/restore`, false],
  ["GET", `${P}/employees/export.xlsx`, false],
  ["GET", `${P}/employees/import-template.xlsx`, false],
  ["POST", `${P}/employees/import`, true],
  ["GET", `${P}/employees`, false],
  ["POST", `${P}/employees`, true],
  ["PATCH", `${P}/employees/${UNKNOWN_ID}`, true],
  ["PATCH", `${P}/employees/${UNKNOWN_ID}/active`, true],
  ["PATCH", `${P}/employees/${UNKNOWN_ID}/leave`, true],
  ["GET", `${P}/locations`, false],
  ["POST", `${P}/locations`, true],
  ["PATCH", `${P}/locations/${UNKNOWN_ID}`, true],
  ["PATCH", `${P}/locations/${UNKNOWN_ID}/active`, true],
  ["DELETE", `${P}/locations/${UNKNOWN_ID}`, false],
  ["POST", `${P}/locations/${UNKNOWN_ID}/restore`, false],
  ["GET", `${P}/operations`, false],
  ["POST", `${P}/operations`, true],
  ["PATCH", `${P}/operations/${UNKNOWN_ID}`, true],
  ["PATCH", `${P}/operations/${UNKNOWN_ID}/active`, true],
  ["DELETE", `${P}/operations/${UNKNOWN_ID}`, false],
  ["POST", `${P}/operations/${UNKNOWN_ID}/restore`, false],
  ["GET", `${P}/operation-rates`, false],
  ["POST", `${P}/operation-rates`, true],
  ["PATCH", `${P}/operation-rates/${UNKNOWN_ID}`, true],
];

test("production-master-data.anonymous_requests_are_rejected_on_all_35_routes", async () => {
  // 控制器级 @UseGuards(AuthenticationGuard, ModulePermissionGuard) + @RequireModules("production")
  // 对所有路由生效；AuthenticationGuard 的 currentUser() 在无 Cookie 时抛 401（auth.service.ts:37）。
  assert.equal(ROUTES.length, 35, "本用例应覆盖控制器上全部 35 条路由");
  const anonymous = apiClient(baseUrl);
  for (const [method, path, hasBody] of ROUTES) {
    const response = await anonymous.raw(path, jsonInit(method, hasBody ? {} : undefined));
    expectUnauthenticated(response, `${method} ${path}`);
    expectRequestIdHeader(response, `${method} ${path}`);
  }
});

test("production-master-data.list_routes_return_bare_arrays_and_no_pagination_meta", async () => {
  const api = await sessionApi();
  for (const path of [`${P}/departments`, `${P}/positions`, `${P}/employees`, `${P}/locations`, `${P}/operations`, `${P}/operation-rates`]) {
    const response = await api.get(path);
    const body = expectSuccessEnvelope(response, { context: path });
    assert.ok(Array.isArray(body.data), `${path} 的 data 必须是裸数组（列表信息不进 data 包装）`);
    // 主数据端点**没有分页**：meta 恒为 {}（service 各 list* 直接 findMany，控制器 ok() 固定 meta:{}）
    for (const field of ["page", "page_size", "total"]) {
      assert.equal(field in body.meta, false, `${path} 未实现分页，meta 里不应出现 ${field}；实际 ${JSON.stringify(body.meta)}`);
    }
  }
  // include_deleted 是字符串开关（=== "true"），其它取值一律当 false 处理（宽松但确定）
  for (const path of [`${P}/departments`, `${P}/locations`, `${P}/operations`]) {
    expectSuccessEnvelope(await api.get(`${path}?include_deleted=true`), { context: `${path}?include_deleted=true` });
    expectSuccessEnvelope(await api.get(`${path}?include_deleted=maybe`), { context: `${path}?include_deleted=maybe` });
  }
  // positions / operation-rates 的过滤参数是可选字符串，不存在的 UUID 返回空数组而不是 404
  expectSuccessEnvelope(await api.get(`${P}/positions?department_id=${UNKNOWN_ID}`));
  expectSuccessEnvelope(await api.get(`${P}/operation-rates?employee_id=${UNKNOWN_ID}&operation_id=${UNKNOWN_ID}`));
});

test("production-master-data.unknown_query_params_split_between_dto_and_literal_signatures", async () => {
  const api = await sessionApi();
  // @Query() query: EmployeeQueryDto（类）→ ValidationPipe whitelist + forbidNonWhitelisted → 400
  for (const path of [`${P}/employees?bogus=1`, `${P}/employees/export.xlsx?bogus=1`]) {
    const response = await api.get(path);
    expectValidationError(response, { code: "VALIDATION_ERROR", context: path });
    assert.equal(response.body.error.details[0].field, "bogus", `${path} 应给出字段级 details`);
    assert.equal(response.body.error.details[0].rule, "whitelistValidation");
  }
  // @Query("include_deleted") 这类字面量参数：metatype 是 String/Object，ValidationPipe 跳过 → 静默忽略
  for (const path of [`${P}/departments?bogus=1`, `${P}/positions?bogus=1`, `${P}/locations?bogus=1`, `${P}/operations?bogus=1`, `${P}/operation-rates?bogus=1`]) {
    expectSuccessEnvelope(await api.get(path), { context: path });
  }
  // 同一分裂也体现在「分页参数」上：字面量型端点连 page_size=abc 都当空气
  expectSuccessEnvelope(await api.get(`${P}/departments?page_size=abc`));
});

test("production-master-data.employee_query_dto_validates_field_types_and_rejects_pagination", async () => {
  const api = await sessionApi();
  const invalid = [
    ["department_id", "isUuid", "not-a-uuid"],
    ["position_id", "isUuid", "not-a-uuid"],
    ["hired_from", "isDateString", "not-a-date"],
    ["left_to", "isDateString", "not-a-date"],
  ];
  for (const [field, rule, value] of invalid) {
    const response = await api.get(`${P}/employees?${field}=${value}`);
    expectValidationError(response, { code: "VALIDATION_ERROR", context: field });
    assert.equal(response.body.error.details[0].field, field);
    assert.equal(response.body.error.details[0].rule, rule);
  }
  // EmployeeQueryDto 里没有分页字段 → 该端点不分页，传 page_size 直接 400
  const paginated = await api.get(`${P}/employees?page_size=5`);
  expectValidationError(paginated, { code: "VALIDATION_ERROR", context: "page_size" });
  assert.equal(paginated.body.error.details[0].field, "page_size");
  // 合法过滤条件（含宽松的 has_user 字符串）：全部 200
  for (const query of ["query=abc", "employment_status=active", "employee_type=workshop", `department_id=${UNKNOWN_ID}`, `position_id=${UNKNOWN_ID}`, "has_user=true", "has_user=false", "has_user=maybe", "hired_from=2026-01-01&hired_to=2026-12-31", "left_from=2026-01-01&left_to=2026-12-31"]) {
    expectSuccessEnvelope(await api.get(`${P}/employees?${query}`), { context: query });
  }
});

test("production-master-data.create_routes_whitelist_and_validate_bodies_with_400", async () => {
  const api = await sessionApi();
  const required = [
    [`${P}/departments`, {}, ["code", "name"]],
    [`${P}/positions`, {}, ["department_id", "code", "name"]],
    [`${P}/employees`, {}, ["employee_no", "name", "department_id", "position_id", "employee_type"]],
    [`${P}/locations`, {}, ["name", "location_type"]],
    [`${P}/operations`, {}, ["operation_name"]],
    [`${P}/operation-rates`, {}, ["employee_id", "operation_id", "wage_mode", "unit_price", "effective_from"]],
  ];
  for (const [path, payload, fields] of required) {
    const response = await api.post(path, payload);
    expectValidationError(response, { code: "VALIDATION_ERROR", context: path });
    for (const field of fields) {
      assert.ok(response.body.error.details.some((detail) => detail.field === field), `${path} 的 400 details 应包含必填字段 ${field}；实际 ${JSON.stringify(response.body.error.details)}`);
    }
  }
  // 未知字段一律 whitelistValidation 拒绝（防止夹带状态/审计列）
  for (const path of [`${P}/departments`, `${P}/positions`, `${P}/employees`, `${P}/locations`, `${P}/operations`, `${P}/operation-rates`]) {
    const response = await api.post(path, { bogus: 1 });
    expectValidationError(response, { code: "VALIDATION_ERROR", context: `${path} bogus` });
    assert.ok(response.body.error.details.some((detail) => detail.field === "bogus" && detail.rule === "whitelistValidation"), `${path} 应拒绝未知字段`);
  }
});

test("production-master-data.create_routes_resolve_unknown_relations_to_404_without_writing", async () => {
  const api = await sessionApi();
  // 请求体**合法**但引用了不存在的行：服务在写库前抛 NotFound（production-master-data.service.ts:398,429,404）
  const cases = [
    [`${P}/positions`, { code: "NO-WRITE", department_id: UNKNOWN_ID, name: "NO-WRITE" }, "DEPARTMENT_NOT_FOUND"],
    [`${P}/employees`, { department_id: UNKNOWN_ID, employee_no: "NO-WRITE", employee_type: "workshop", name: "NO-WRITE", position_id: UNKNOWN_ID }, "ORGANIZATION_NOT_FOUND"],
    // createRate 在事务内先锁 employee 行再 requireActiveEmployeeIn → 未找到即回滚，无写入
    [`${P}/operation-rates`, { effective_from: "2026-01-01", employee_id: UNKNOWN_ID, operation_id: UNKNOWN_ID, unit_price: "1.0000", wage_mode: "piece_rate" }, "EMPLOYEE_NOT_FOUND"],
  ];
  for (const [path, payload, code] of cases) {
    expectBusinessNotFound(await api.post(path, payload), code, `POST ${path}`);
  }
});

test("production-master-data.value_assertions_return_422_before_any_write", async () => {
  const api = await sessionApi();
  const rate = { effective_from: "2026-01-01", employee_id: UNKNOWN_ID, operation_id: UNKNOWN_ID, unit_price: "1", wage_mode: "piece_rate" };
  const cases = [
    [{ ...rate, wage_mode: "bogus" }, "INVALID_WAGE_MODE"],
    [{ ...rate, unit_price: "-1" }, "INVALID_RATE_UNIT_PRICE"],
    [{ ...rate, unit_price: "1.23456" }, "INVALID_RATE_UNIT_PRICE"],
    [{ ...rate, unit_price: "1e3" }, "INVALID_RATE_UNIT_PRICE"],
    [{ ...rate, effective_from: "2026-05-01", effective_to: "2026-01-01" }, "INVALID_RATE_DATE_RANGE"],
  ];
  for (const [payload, code] of cases) {
    // 这些断言在服务开启事务之前执行（service:350-353），因此不会写任何数据
    expectBusinessRuleViolation(await api.post(`${P}/operation-rates`, payload), { code, context: JSON.stringify(payload) });
  }
  expectBusinessRuleViolation(await api.post(`${P}/locations`, { location_type: "bogus", name: "NO-WRITE" }), { code: "INVALID_LOCATION_TYPE" });
});

test("production-master-data.patch_bodies_enforce_whitelist_and_field_types", async () => {
  const api = await sessionApi();
  // PATCH DTO 只声明可改字段：审计/状态列（is_active/deleted_at/createdBy/employeeNo/effectiveTo）必须被拒
  const smuggled = [
    [`${P}/departments/${UNKNOWN_ID}`, { is_active: false }, "is_active"],
    [`${P}/departments/${UNKNOWN_ID}`, { deleted_at: null }, "deleted_at"],
    [`${P}/departments/${UNKNOWN_ID}`, { createdBy: UNKNOWN_ID }, "createdBy"],
    [`${P}/employees/${UNKNOWN_ID}`, { employeeNo: "NO-WRITE" }, "employeeNo"],
    [`${P}/operation-rates/${UNKNOWN_ID}`, { effectiveTo: "2026-01-01" }, "effectiveTo"],
    [`${P}/operations/${UNKNOWN_ID}`, { isActive: false }, "isActive"],
  ];
  for (const [path, payload, field] of smuggled) {
    const response = await api.patch(path, payload);
    expectValidationError(response, { code: "VALIDATION_ERROR", context: `${path} ${field}` });
    assert.ok(response.body.error.details.some((detail) => detail.field === field && detail.rule === "whitelistValidation"), `${path} 应拒绝 ${field}；实际 ${JSON.stringify(response.body.error.details)}`);
  }
  // ActiveDto / LeaveDto 是必填强类型：缺字段或类型不对 → 400（在服务之前）
  const noActive = await api.patch(`${P}/departments/${UNKNOWN_ID}/active`, {});
  expectValidationError(noActive, { code: "VALIDATION_ERROR", context: "active {}" });
  assert.equal(noActive.body.error.details[0].field, "is_active");
  assert.equal(noActive.body.error.details[0].rule, "isBoolean");
  const badActive = await api.patch(`${P}/positions/${UNKNOWN_ID}/active`, { is_active: "yes" });
  expectValidationError(badActive, { code: "VALIDATION_ERROR", context: "active string" });
  assert.equal(badActive.body.error.details[0].rule, "isBoolean");
  const noLeave = await api.patch(`${P}/employees/${UNKNOWN_ID}/leave`, {});
  expectValidationError(noLeave, { code: "VALIDATION_ERROR", context: "leave {}" });
  assert.equal(noLeave.body.error.details[0].field, "left_on");
  assert.equal(noLeave.body.error.details[0].rule, "isDateString");
  const badLeave = await api.patch(`${P}/employees/${UNKNOWN_ID}/leave`, { left_on: "not-a-date" });
  expectValidationError(badLeave, { code: "VALIDATION_ERROR", context: "leave bad date" });
  assert.equal(badLeave.body.error.details[0].rule, "isDateString");
});

test("production-master-data.mutations_on_unknown_ids_return_404_before_writing", async () => {
  const api = await sessionApi();
  // 随机 UUID + 合法（或空）请求体：服务先 require* 再写，因此只读探测且必须 404。
  const cases = [
    ["PATCH", `${P}/departments/${UNKNOWN_ID}`, {}, "DEPARTMENT_NOT_FOUND"],
    ["DELETE", `${P}/departments/${UNKNOWN_ID}`, undefined, "DEPARTMENT_NOT_FOUND"],
    ["POST", `${P}/departments/${UNKNOWN_ID}/restore`, undefined, "DEPARTMENT_NOT_DELETED"],
    ["PATCH", `${P}/positions/${UNKNOWN_ID}`, {}, "POSITION_NOT_FOUND"],
    ["PATCH", `${P}/positions/${UNKNOWN_ID}/active`, { is_active: true }, "POSITION_NOT_FOUND"],
    ["DELETE", `${P}/positions/${UNKNOWN_ID}`, undefined, "POSITION_NOT_FOUND"],
    ["POST", `${P}/positions/${UNKNOWN_ID}/restore`, undefined, "POSITION_NOT_DELETED"],
    ["PATCH", `${P}/employees/${UNKNOWN_ID}`, {}, "EMPLOYEE_NOT_FOUND"],
    ["PATCH", `${P}/employees/${UNKNOWN_ID}/active`, { is_active: true }, "EMPLOYEE_NOT_FOUND"],
    ["PATCH", `${P}/employees/${UNKNOWN_ID}/leave`, { left_on: "2026-01-01" }, "EMPLOYEE_NOT_FOUND"],
    ["PATCH", `${P}/locations/${UNKNOWN_ID}`, {}, "PRODUCTION_LOCATION_NOT_FOUND"],
    ["PATCH", `${P}/locations/${UNKNOWN_ID}/active`, { is_active: false }, "PRODUCTION_LOCATION_NOT_FOUND"],
    ["DELETE", `${P}/locations/${UNKNOWN_ID}`, undefined, "PRODUCTION_LOCATION_NOT_FOUND"],
    ["POST", `${P}/locations/${UNKNOWN_ID}/restore`, undefined, "PRODUCTION_LOCATION_NOT_DELETED"],
    ["PATCH", `${P}/operations/${UNKNOWN_ID}`, {}, "OPERATION_NOT_FOUND"],
    ["PATCH", `${P}/operations/${UNKNOWN_ID}/active`, { is_active: false }, "OPERATION_NOT_FOUND"],
    ["DELETE", `${P}/operations/${UNKNOWN_ID}`, undefined, "OPERATION_NOT_FOUND"],
    ["POST", `${P}/operations/${UNKNOWN_ID}/restore`, undefined, "OPERATION_NOT_DELETED"],
    ["PATCH", `${P}/operation-rates/${UNKNOWN_ID}`, {}, "OPERATION_RATE_NOT_FOUND"],
  ];
  for (const [method, path, payload, code] of cases) {
    expectBusinessNotFound(await api.call(method, path, payload), code, `${method} ${path}`);
  }
});

test("production-master-data.export_routes_bypass_the_json_envelope", async () => {
  const api = await sessionApi();
  // @Res() 旁路 ResponseEnvelopeInterceptor：直接写二进制流（控制器:66-67）
  const exported = await api.get(`${P}/employees/export.xlsx`);
  assert.equal(exported.status, 200);
  assert.equal(exported.contentType.split(";")[0], XLSX_MIME);
  assert.match(exported.headers.get("content-disposition") ?? "", /^attachment; filename="DileeERP-employees-\d{14}\.xlsx"$/);
  assert.equal(exported.headers.get("cache-control"), "no-store");
  expectRequestIdHeader(exported, "employees/export.xlsx");
  assert.equal(typeof exported.body, "string", "导出是二进制流，不是 {data,meta} 信封（harness 会以文本回退）");
  assert.ok(exported.body.startsWith("PK"), "xlsx 是 zip 容器，应以 PK 魔数开头");
  assert.throws(() => JSON.parse(exported.body), "导出响应体不应是 JSON");

  const template = await api.get(`${P}/employees/import-template.xlsx`);
  assert.equal(template.status, 200);
  assert.equal(template.contentType.split(";")[0], XLSX_MIME);
  const disposition = template.headers.get("content-disposition") ?? "";
  assert.match(disposition, /^attachment; filename\*=UTF-8''/);
  assert.ok(decodeURIComponent(disposition).includes("员工导入模板.xlsx"), `模板文件名应可解码为中文：${disposition}`);
  assert.equal(template.headers.get("cache-control"), "no-store");
  assert.ok(template.body.length > 0);

  // 旁路信封的端点仍然受全局 ValidationPipe 与全局异常过滤器约束 → 校验失败仍是标准失败信封
  expectValidationError(await api.get(`${P}/employees/export.xlsx?bogus=1`), { code: "VALIDATION_ERROR", context: "export?bogus=1" });
  expectValidationError(await api.get(`${P}/employees/export.xlsx?hired_from=not-a-date`), { code: "VALIDATION_ERROR", context: "export bad date" });
  // 模板端点连 @Query 都没有（控制器:67），因此未知参数静默忽略 —— 与 export.xlsx 的 DTO 校验形成对照
  const templateWithBogus = await api.get(`${P}/employees/import-template.xlsx?bogus=1`);
  assert.equal(templateWithBogus.status, 200, "模板端点没有 @Query，未知参数被静默忽略");
  assert.equal(templateWithBogus.contentType.split(";")[0], XLSX_MIME);
});

test("production-master-data.import_route_enforces_file_presence_type_field_and_size", async () => {
  const api = await sessionApi();
  const path = `${P}/employees/import`;
  // 无文件（JSON 体 / 空 multipart）→ 服务层 422，不是 400
  expectBusinessRuleViolation(await api.post(path, {}), { code: "EMPLOYEE_IMPORT_FILE_REQUIRED", context: "json body" });
  expectBusinessRuleViolation(await api.multipart(path, new FormData()), { code: "EMPLOYEE_IMPORT_FILE_REQUIRED", context: "empty multipart" });
  // fileFilter（控制器:43-47）按扩展名/MIME 白名单拒绝 .txt：cb(null,false) → 没有文件 → 同一个 422
  const text = await api.multipart(path, fileForm("file", "probe.txt", "text/plain", "not an excel"));
  expectBusinessRuleViolation(text, { code: "EMPLOYEE_IMPORT_FILE_REQUIRED", context: ".txt" });
  expectRequestIdHeader(text, "import .txt");
  // multer 字段名必须是 file：其它字段名由 multer 抛错，被 Nest 归一为 400 VALIDATION_ERROR
  const wrongField = await api.multipart(path, fileForm("upload", "a.xls", "application/vnd.ms-excel", "x"));
  expectValidationError(wrongField, { code: "VALIDATION_ERROR", context: "wrong field" });
  assert.match(wrongField.body.error.message, /Unexpected field/);
  // limits.fileSize = 10MiB（控制器:68）→ 超限为 413，仍是标准失败信封
  const oversized = await api.multipart(path, fileForm("file", "big.xlsx", XLSX_MIME, new Uint8Array(10 * 1024 * 1024 + 1)));
  assert.equal(oversized.status, 413, `超限上传应为 413，实际 ${oversized.status}`);
  expectErrorEnvelope(oversized, { code: "REQUEST_ERROR", context: "oversize", status: 413 });
  expectRequestIdHeader(oversized, "oversize");
});

test("production-master-data.method_mismatches_and_unknown_routes_return_404_never_405", async () => {
  const api = await sessionApi();
  // 后端没有 405：方法不匹配同样由 not-found handler 兜底，message 为英文 Cannot XXX
  const cases = [
    ["PUT", `${P}/departments/${UNKNOWN_ID}`, {}],
    ["DELETE", `${P}/employees/${UNKNOWN_ID}`, undefined],
    ["POST", `${P}/employees/export.xlsx`, {}],
    ["GET", `${P}/employees/import-template.xlsx/extra`, undefined],
    ["GET", `${P}/roles`, undefined],
    ["GET", `${P}/departments/${UNKNOWN_ID}`, undefined],
  ];
  for (const [method, path, payload] of cases) {
    const response = await api.call(method, path, payload);
    expectNotFound(response, `${method} ${path}`);
    assert.equal(response.body.error.code, "NOT_FOUND");
    assert.match(response.body.error.message, new RegExp(`^Cannot ${method} `), `${method} ${path} 的路由级 404 由 Nest 生成`);
    assert.equal(response.status === 405, false, "后端不存在 405");
  }
});

test("KNOWN_CONTRACT_DEFECT production-master-data.malformed_uuid_filters_escape_as_500", async () => {
  const api = await sessionApi();
  // 期望：与 /production/employees?department_id=not-a-uuid 一致，返回 400 VALIDATION_ERROR + 字段级 details
  //      （客户端输入格式错误，属请求错误而非服务器故障）。
  // 实际：字面量型 @Query 参数不做 UUID 校验，原样进入 Prisma 的 uuid 列过滤，Prisma 抛错被兜底为 500。
  // 责任：production-master-data.controller.ts:60（@Query("department_id") departmentId?: string）
  //      → production-master-data.service.ts:58（where.departmentId 原样透传）；
  //      production-master-data.controller.ts:86（@Query("employee_id") / ("operation_id")）
  //      → production-master-data.service.ts:342。
  // 修复后此用例会变红：请同步改为断言 400 + VALIDATION_ERROR。
  for (const path of [`${P}/positions?department_id=not-a-uuid`, `${P}/operation-rates?employee_id=not-a-uuid`, `${P}/operation-rates?operation_id=not-a-uuid`]) {
    const response = await api.get(path);
    assert.equal(response.status, 500, `${path} 当前以 500 逃逸（KNOWN_CONTRACT_DEFECT），若为 400 说明缺陷已修复`);
    expectErrorEnvelope(response, { code: "REQUEST_ERROR", context: path, status: 500 });
  }
});
