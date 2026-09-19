// 库存盘点（仓库）—— HTTP 契约测试（只读探测）。
//
// 被测生产文件：apps/api/src/modules/warehouse/stocktake.controller.ts
//   - 9 个路由；类级 @UseGuards(AuthenticationGuard, ModulePermissionGuard) + @RequireModules("warehouse")
//   - `GET import-template.xlsx` 必须排在 `GET :id` 之前：Nest 按声明顺序匹配，单段静态路径
//     会被 `:id` 当成一个 id 吃掉（`payable-entries/import-template.xlsx` 踩过同一个坑）。
//     本文件第 1 个用例专门守这件事。
//   - 列表/详情/动作都是 `{ data, meta: {} }`；导入是 @Post（默认 201）
//
// 运行（**必须串行**；本 API 是单会话的：登录会先删该用户全部 session，并发以 admin 登录会互相踢掉）：
//   node --test --test-concurrency=1 apps/api/test/http/stocktake-contract.test.cjs
//
// 测试纪律（本文件严格遵守）：
//   1. 只做只读探测：GET、匿名 401、随机 UUID 的 404、以及「必然在写库之前抛错」的写请求。
//   2. 不创建/修改/删除任何业务数据。已验证下面所有写请求要么被 ValidationPipe 拦下（400），
//      要么在 service 里于 create 之前抛 404/422（stocktake.service.ts 的 requireDraft /
//      notFound / invalid 分支），要么走到「解析失败 → 一行都不写」的失败返回。
//   3. 每个用例内部自己登录一次并立即使用，不跨用例共享 cookie（单会话约束）。

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const XLSX = require("xlsx");
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
const P = "/api/v1/stocktakes";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fileForm(field, fileName, mimeType, content) {
  const form = new FormData();
  form.append(field, new Blob([content], { type: mimeType }), fileName);
  return form;
}

/** harness 的 apiClient 只发 JSON；multipart 直连 fetch，但复用同一 Cookie 会话。 */
async function postMultipart(cookie, path, form) {
  const response = await fetch(new URL(path, baseUrl), { body: form, headers: { cookie }, method: "POST" });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : await response.text().catch(() => "");
  return { body, contentType, headers: response.headers, requestId: response.headers.get("x-request-id"), status: response.status };
}

/** 单会话 API 下，被并发登录踢掉时的重试次数与退避。 */
const SESSION_RETRY_ATTEMPTS = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function adminClient() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) throw new Error("TEST_BLOCKED: INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required");
  const session = await login(baseUrl, { password, username });
  assert.equal(session.status, 201, `登录应返回 201（所有 POST 的默认状态码），实际 ${session.status}：${JSON.stringify(session.body)}`);
  assert.ok(session.cookie, "登录必须下发 dilee_session Cookie");
  return { client: apiClient(baseUrl, { cookie: session.cookie }), cookie: session.cookie };
}

/** 抗「被并发登录踢掉」的 admin 会话（见 finished-goods-outbound-contract.test.cjs 的同一段说明）。 */
async function adminSession() {
  let { client, cookie } = await adminClient();
  const retry = async (run) => {
    let response = await run();
    for (let attempt = 1; attempt <= SESSION_RETRY_ATTEMPTS && response.status === 401; attempt += 1) {
      await sleep(200 + Math.floor(Math.random() * 200));
      ({ client, cookie } = await adminClient());
      response = await run();
    }
    if (response.status === 401) throw new Error("TEST_ENV_COLLISION: 已认证请求在多次重新登录后仍返回 401（单会话 API 被并发 admin 登录持续踢掉），请在无并发测试时重跑");
    return response;
  };
  return {
    get: (path) => retry(() => client.get(path)),
    patch: (path, body) => retry(() => client.patch(path, body)),
    post: (path, body) => retry(() => client.post(path, body)),
    del: (path) => retry(() => client.del(path)),
    // multipart 直连 fetch，用当前会话的 Cookie（apiClient 只发 JSON）
    multipart: (path, form) => retry(() => postMultipart(cookie, path, form)),
    raw: (method, path, body) => retry(() => client.raw(path, { body: body === undefined ? undefined : JSON.stringify(body), method })),
  };
}

/** 9 个路由（stocktake.controller.ts:48-75）。 */
const ROUTES = [
  { method: "GET", path: `${P}` },
  { method: "GET", path: `${P}/import-template.xlsx` },
  { method: "POST", body: { period_month: "2026-09" }, path: `${P}/import` },
  { method: "GET", path: `${P}/:id` },
  { method: "POST", path: `${P}/:id/confirm` },
  { method: "POST", body: { reason: "contract-probe" }, path: `${P}/:id/reverse` },
  { method: "DELETE", path: `${P}/:id` },
  { method: "PATCH", body: { actual_quantity: "1" }, path: `${P}/lines/:id` },
  { method: "DELETE", path: `${P}/lines/:id` },
];

test("stocktake.anonymous_requests_are_rejected_with_401_on_all_nine_routes", async () => {
  const anonymous = apiClient(baseUrl);
  assert.equal(ROUTES.length, 9, "控制器共 9 个路由，路由表必须与控制器保持一致");
  for (const route of ROUTES) {
    const path = route.path.replace(":id", randomUUID());
    const response = await anonymous.raw(path, { body: route.body === undefined ? undefined : JSON.stringify(route.body), method: route.method });
    expectUnauthenticated(response, `匿名 ${route.method} ${path}`);
    assert.equal(response.body.meta.path, path, `${path} 的 meta.path 必须回显实际请求路径`);
    expectRequestIdHeader(response, `匿名 ${route.method} ${path}`);
  }
});

test("stocktake.import_template_is_not_swallowed_by_the_id_route", async () => {
  // 这一条是本文件最要紧的守卫：`import-template.xlsx` 是单段静态路径，
  // 若声明在 `@Get(":id")` 之后，它会被当成 id 去查库并返回 404 STOCKTAKE_NOT_FOUND。
  const client = await adminSession();
  const response = await client.get(`${P}/import-template.xlsx`);

  assert.notEqual(response.status, 404, "模板路由被 :id 吃掉了：必须声明在 @Get(\":id\") 之前");
  assert.equal(response.status, 200);
  assert.equal(response.contentType.split(";")[0], XLSX_MIME);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const disposition = response.headers.get("content-disposition") ?? "";
  assert.match(disposition, /^attachment; filename\*=UTF-8''/);
  assert.ok(decodeURIComponent(disposition).includes("库存盘点导入模板.xlsx"), `模板文件名应可解码为中文：${disposition}`);
  assert.equal(typeof response.body, "string", "模板是二进制流，不是 {data,meta} 信封");
  assert.ok(response.body.startsWith("PK"), "xlsx 是 zip 容器，应以 PK 魔数开头");
  expectRequestIdHeader(response, "GET stocktakes/import-template.xlsx");

  // 模板必须能被自己的解析器读回（口径一致），且示例行合法
  const { parseStocktakeRows, STOCKTAKE_TEMPLATE_HEADERS } = require("../../dist/modules/warehouse/stocktake-import.js");
  const book = XLSX.read(Buffer.from(response.body, "latin1"), { type: "buffer" });
  assert.deepEqual(book.SheetNames, ["库存盘点导入", "填写说明"]);
  const rows = XLSX.utils.sheet_to_json(book.Sheets["库存盘点导入"], { header: 1, raw: true, defval: "" });
  assert.deepEqual(rows[0], [...STOCKTAKE_TEMPLATE_HEADERS], "模板表头必须与解析口径逐字一致");
  const parsed = parseStocktakeRows(rows);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.headerRow, 1);
  assert.deepEqual(parsed.errors, [], `模板自身的示例行必须合法：${JSON.stringify(parsed.errors)}`);
  assert.deepEqual(parsed.ignoredColumns, [], "模板列必须全部属于口径");
});

test("stocktake.import_requires_an_excel_file_and_validates_the_period_month", async () => {
  const client = await adminSession();

  // 没有文件（JSON 体）→ 服务层 422；HTTP 状态码由 @Post 决定（201/200 都可能，
  // 这里只断言信封与业务码，避免把「POST 的默认状态码」写进契约）。
  const noFile = await client.post(`${P}/import`, { period_month: "2026-09" });
  expectBusinessRuleViolation(noFile, { code: "STOCKTAKE_IMPORT_FILE_REQUIRED", context: "JSON 体没有文件" });

  // 非 Excel 被 Multer 白名单挡下（cb(null, false)）→ 落到同一个「没有文件」的 422
  const wrongType = await client.multipart(`${P}/import`, fileForm("file", "probe.txt", "text/plain", "not an excel"));
  expectBusinessRuleViolation(wrongType, { code: "STOCKTAKE_IMPORT_FILE_REQUIRED", context: "上传 .txt" });

  // 盘点月份格式在 DTO 层拦下（400），且发生在文件检查之前
  const badMonth = await client.multipart(`${P}/import`, fileForm("file", "probe.xlsx", XLSX_MIME, "PK"));
  assert.equal(badMonth.status, 400, `缺少 period_month 必须是 400，实际 ${badMonth.status}：${JSON.stringify(badMonth.body)}`);
  expectValidationError(badMonth, { context: "multipart 缺少 period_month" });
  for (const period_month of ["2026-9", "2026-13", "202609"]) {
    const form = fileForm("file", "probe.xlsx", XLSX_MIME, "PK");
    form.append("period_month", period_month);
    expectValidationError(await client.multipart(`${P}/import`, form), { context: `period_month=${period_month}` });
  }
});

test("stocktake.import_with_an_unreadable_sheet_writes_nothing_and_reports_per_row", async () => {
  // 这是本文件唯一会真正进到 service 的导入请求：内容不是盘点表 → 解析整批失败 → 一行都不写。
  // 因此它是**只读安全**的，同时覆盖了「找不到表头」的返回形状。
  const client = await adminSession();
  const sheet = XLSX.utils.aoa_to_sheet([["产品名称", "仓位"], ["涤纶布", "A区"]]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "随便一张表");
  const form = fileForm("file", "不是盘点表.xlsx", XLSX_MIME, XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
  form.append("period_month", "2026-09");

  const response = await client.multipart(`${P}/import`, form);
  const body = expectSuccessEnvelope(response, { context: "POST /stocktakes/import", status: 201 });

  assert.equal(body.data.status, "failed");
  assert.equal(body.data.stocktakeId, null, "解析失败时不得建单");
  assert.equal(body.data.imported, 0);
  assert.ok(body.data.errors.length >= 1, "失败原因必须逐条回给操作员");
  assert.ok(body.data.missingColumns.includes("产品代码") || body.data.missingColumns.includes("实际数量"),
    `缺少的必需列要如实上报：${JSON.stringify(body.data.missingColumns)}`);
});

test("stocktake.unknown_ids_are_module_specific_404_and_never_write", async () => {
  const client = await adminSession();
  const id = randomUUID();
  const cases = [
    { method: "GET", path: `${P}/${id}` },
    { method: "DELETE", path: `${P}/${id}` },
    { method: "POST", path: `${P}/${id}/confirm` },
    { method: "PATCH", body: { actual_quantity: "1" }, path: `${P}/lines/${id}` },
    { method: "DELETE", path: `${P}/lines/${id}` },
  ];
  for (const item of cases) {
    const response = await client.raw(item.method, item.path, item.body);
    expectErrorEnvelope(response, { context: `${item.method} ${item.path}`, status: 404 });
    assert.equal(response.body.meta.path, item.path, "错误信封的 meta.path 必须回显请求路径");
    expectRequestIdHeader(response, `${item.method} ${item.path}`);
  }
  assert.equal((await client.get(`${P}/${id}`)).body.error.code, "STOCKTAKE_NOT_FOUND");
  assert.equal((await client.patch(`${P}/lines/${id}`, { actual_quantity: "1" })).body.error.code, "STOCKTAKE_LINE_NOT_FOUND");
});

test("stocktake.reverse_validates_the_reason_before_looking_up_the_stocktake", async () => {
  // 空原因必须是 422 STOCKTAKE_REVERSAL_REASON_REQUIRED，而不是 404：
  // 顺序反了会把「忘记填原因」误导成「单号错了」（与成品出库冲销同一约定）。
  const client = await adminSession();
  const id = randomUUID();
  for (const reason of ["", "   "]) {
    const response = await client.post(`${P}/${id}/reverse`, { reason });
    expectBusinessRuleViolation(response, { code: "STOCKTAKE_REVERSAL_REASON_REQUIRED", context: `reverse reason=${JSON.stringify(reason)}` });
  }
  // 原因缺失（字段都没有）由 DTO 拦下 → 400
  const missing = await client.post(`${P}/${id}/reverse`, {});
  expectValidationError(missing, { context: "reverse 没有 reason 字段" });
});

test("stocktake.line_update_validates_actual_quantity_at_the_guard_layer", async () => {
  const client = await adminSession();
  const id = randomUUID();

  // 实盘数可以填 0（盘没了），但负数 / 科学计数 / 非数字都在校验层被拒
  for (const actual_quantity of ["-1", "1e3", "abc"]) {
    const response = await client.patch(`${P}/lines/${id}`, { actual_quantity });
    expectValidationError(response, { context: `PATCH lines actual_quantity=${actual_quantity}` });
    assert.equal(response.body.error.details[0].field, "actual_quantity");
    assert.equal(response.body.error.details[0].rule, "matches");
  }
  // 0 通过校验层（随后因行不存在而 404，说明它没有被 400 拦下）
  const zero = await client.patch(`${P}/lines/${id}`, { actual_quantity: "0" });
  expectErrorEnvelope(zero, { code: "STOCKTAKE_LINE_NOT_FOUND", context: "actual_quantity=0 应通过校验层", status: 404 });

  const tooLong = await client.patch(`${P}/lines/${id}`, { difference_reason: "x".repeat(1001) });
  expectValidationError(tooLong, { context: "差异原因超长" });
  assert.equal(tooLong.body.error.details[0].rule, "maxLength");
});

test("stocktake.wrong_method_and_unknown_subpath_are_404_never_405", async () => {
  const client = await adminSession();
  const id = randomUUID();
  const cases = [
    { method: "POST", path: `${P}` },
    { method: "PATCH", path: `${P}/${id}` },
    { method: "GET", path: `${P}/${id}/confirm` },
    // 两段路径，不会命中 `@Get(":id")`（单段非 UUID 会被 `:id` 吃掉并落到 Prisma，
    // 那是全站 :id 路由的既有行为，不在本文件的口径内）
    { method: "GET", path: `${P}/no-such/extra` },
  ];
  for (const item of cases) {
    const response = await client.raw(item.method, item.path);
    expectNotFound(response, `${item.method} ${item.path}`);
    assert.match(response.body.error.message, new RegExp(`^Cannot ${item.method}`), `${item.method} ${item.path} 的 message 应由 Nest 生成（英文 Cannot ...）`);
  }
});

test("stocktake.request_id_header_is_present_on_success_and_failure", async () => {
  expectRequestIdHeader(await apiClient(baseUrl).get(`${P}`), "匿名 401");

  const client = await adminSession();
  expectRequestIdHeader(await client.get(`${P}`), "已认证 200");
  expectRequestIdHeader(await client.get(`${P}/${randomUUID()}`), "已认证 404");
  expectRequestIdHeader(await client.post(`${P}/${randomUUID()}/reverse`, { reason: "x" }), "已认证 404");
});
