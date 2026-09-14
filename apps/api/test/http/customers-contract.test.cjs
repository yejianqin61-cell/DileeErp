// 迪礼 ERP —— 客户模块 HTTP 契约测试（打真实运行中的 API，**只读探测**）。
//
// 参照实现：apps/api/src/modules/sales/customers.controller.ts（9 个路由）
//   GET    /api/v1/customers                           列表（@Query() PaginationQueryDto —— 类，走白名单校验）
//   POST   /api/v1/customers                           新建（CustomerDto；POST 默认 201）
//   GET    /api/v1/customers/:id                       详情
//   PATCH  /api/v1/customers/:id                       更新（UpdateCustomerDto）
//   PATCH  /api/v1/customers/:id/active                启用/停用（ActiveDto）
//   DELETE /api/v1/customers/:id                       删除（软删除，返回 200）
//   POST   /api/v1/customers/:id/contacts              新建联系人（ContactDto）
//   PATCH  /api/v1/customers/:id/contacts/:contactId   更新联系人（UpdateContactDto）
//   DELETE /api/v1/customers/:id/contacts/:contactId   删除联系人（软删除，返回 200）
//
// 测试纪律（改本文件前先读）：
//   1. **不写任何业务数据**。写端点只打「鉴权层 / 校验层 / 不存在的随机 UUID」：
//      - 匿名 → 401（AuthenticationGuard 先于一切，authentication.guard.ts:12）；
//      - 非法 body → 400（ValidationPipe 白名单/类型）或 422（service 里的业务规则）；
//      - 合法 body + 随机 UUID → 404（service 每个写方法都先 await this.get(id)，
//        customers.service.ts:52/61/68/75/85/96 —— 抛在 prisma.create/update 之前，零副作用）。
//      没有任何用例会走到写操作的成功分支，也就拿不到 POST 的 201 成功体（见报告「未验证」）。
//   2. 每个用例**内部自己登录一次并立即使用**：AuthService.login 会先删该用户全部 session
//      （auth.service.ts:29），所以不能跨用例共享 Cookie，本文件内也不存在并发登录。
//   3. 但同一台 API 上有**其它测试进程**也在用 admin 登录，随时会把本用例的 Cookie 顶掉（实测高频）。
//      因此已认证请求统一走 `stickyClient`：**只在收到 401 时**重新登录并重试该次请求。
//      这样重试是安全的 —— 401 由 AuthenticationGuard 在进入 handler 之前抛出，第一次请求没有任何副作用。
//   4. 不使用 /api/v1/health（数据库竞争下 503 合法），本文件不需要它。
//
// 运行：node --test --test-concurrency=1 apps/api/test/http/customers-contract.test.cjs
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
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

const CUSTOMERS = "/api/v1/customers";

// env 优先；裸跑 `node --test ...`（不注入环境变量）时回落到任务书给定的本机地址与管理员凭据，
// 否则 baseUrl 为 undefined 会导致每次请求直接抛错。
const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:3001";
const adminUsername = process.env.INITIAL_ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.INITIAL_ADMIN_PASSWORD ?? "DileeAdmin2026Test";

/** 会话被并发登录顶掉后的最大重试次数（每次重试前重新登录）。 */
const MAX_SESSION_RETRIES = 5;

/**
 * 带「单会话抢占」自愈的客户端。
 *
 * 本 API 一个用户只有一个 session；其它测试进程用 admin 登录会立刻作废本 Cookie，
 * 表现为随机 401。401 一定来自 AuthenticationGuard（请求没进 handler），
 * 所以重新登录后重发同一个请求既安全又不会重复写入。
 */
function stickyClient(initialCookie) {
  let cookie = initialCookie;

  async function send(method, path, payload, options) {
    for (let attempt = 0; ; attempt += 1) {
      const client = apiClient(baseUrl, { cookie });
      const response = payload === undefined
        ? await client.raw(path, { ...(options ?? {}), method })
        : await client.raw(path, { ...(options ?? {}), body: JSON.stringify(payload), headers: { "content-type": "application/json", ...(options?.headers ?? {}) }, method });
      if (response.status !== 401) return response;
      if (attempt >= MAX_SESSION_RETRIES) {
        assert.fail(`会话连续 ${MAX_SESSION_RETRIES + 1} 次被并发登录顶掉（单会话 API，auth.service.ts:29）：${method} ${path}`);
      }
      const session = await login(baseUrl, { password: adminPassword, username: adminUsername });
      assert.equal(session.status, 201, `重登录应返回 201，实际 ${session.status}`);
      cookie = session.cookie;
    }
  }

  return {
    get: (path, options) => send("GET", path, undefined, options),
    post: (path, payload) => send("POST", path, payload),
    patch: (path, payload) => send("PATCH", path, payload),
    del: (path) => send("DELETE", path, undefined),
    put: (path, payload) => send("PUT", path, payload),
    // 与 api-client 的 raw(path, { method }) 同形，供「方法不匹配」探针使用。
    raw: (path, options = {}) => send(options.method ?? "GET", path, options.body === undefined ? undefined : JSON.parse(options.body), options),
  };
}

/** 每个用例内部登录一次（POST 默认 201），返回带自愈能力的客户端。 */
async function adminClient() {
  const session = await login(baseUrl, { password: adminPassword, username: adminUsername });
  assert.equal(session.status, 201, `登录应返回 201（所有 POST 的默认状态码），实际 ${session.status}：${JSON.stringify(session.body)}`);
  assert.ok(session.cookie, "登录必须下发 dilee_session Cookie");
  return stickyClient(session.cookie);
}

/** 断言 400 的 details 是字段级、可定位的（main.ts:23-27 的 exceptionFactory 形状）。 */
function expectFieldDetails(response, fields, context) {
  const details = response.body.error.details;
  assert.ok(details.length > 0, `${context} 400 必须给出字段级 details`);
  for (const detail of details) {
    assert.equal(typeof detail.field, "string", `${context} detail.field 必须是字符串`);
    assert.equal(typeof detail.rule, "string", `${context} detail.rule 必须是字符串`);
    assert.equal(typeof detail.message, "string", `${context} detail.message 必须是字符串`);
  }
  const reported = details.map((detail) => detail.field);
  for (const field of fields) assert.ok(reported.includes(field), `${context} details 应包含字段 ${field}，实际 ${JSON.stringify(reported)}`);
  return details;
}

// ---------------------------------------------------------------------------
// 信封 / 列表 / 分页
// ---------------------------------------------------------------------------

test("customers.list_returns_success_envelope_with_literal_array_and_paginated_meta", async () => {
  const client = await adminClient();

  const response = await client.get(`${CUSTOMERS}?page_size=1`);
  const body = expectSuccessEnvelope(response, { context: "GET /customers", paginated: true });
  expectRequestIdHeader(response, "GET /customers");

  // 列表端点的 data 是**裸数组**，分页信息只在 meta（分页唯一真相在 meta）。
  assert.ok(Array.isArray(body.data), "列表端点 data 必须是数组");
  assert.equal(body.meta.page, 1, "meta.page 应回显请求的页码");
  assert.equal(body.meta.page_size, 1, "meta.page_size 应回显请求的 page_size");
  assert.equal(typeof body.meta.total, "number", "meta.total 必须是数字");
  // 反例护栏：reports 的 4 个端点 total 语义是本页行数（D7）。customers 用的是 count(where)，
  // customers.service.ts:19 —— total 是真实总条数，不会小于本页行数。
  assert.ok(body.meta.total >= body.data.length, `meta.total(${body.meta.total}) 不应小于本页行数(${body.data.length})`);
  assert.ok(body.data.length <= 1, "page_size=1 时本页最多 1 行");

  for (const row of body.data) {
    assert.equal(typeof row.id, "string", "客户行必须有 id");
    assert.equal(typeof row.name, "string", "客户行必须有 name");
    assert.equal(typeof row.customerCode, "string", "客户行必须有 customer_code（服务端生成或手填）");
    assert.equal(typeof row.isActive, "boolean", "客户行必须有 is_active");
    // 没有 GET /customers/:id/contacts 子路由，联系人内嵌在客户行里（customers.service.ts:19 include）。
    assert.ok(Array.isArray(row.contacts), "客户行的 contacts 必须是数组");
  }
});

test("customers.list_meta_echoes_page_and_search_filters_without_400", async () => {
  const client = await adminClient();

  const secondPage = await client.get(`${CUSTOMERS}?page=2&page_size=5`);
  const body = expectSuccessEnvelope(secondPage, { context: "GET /customers?page=2&page_size=5", paginated: true });
  assert.equal(body.meta.page, 2);
  assert.equal(body.meta.page_size, 5);
  assert.ok(body.data.length <= 5, "本页行数不得超过 page_size");

  // search 命中 0 行时仍是成功信封：data 是空数组、total 是 0（不是 404）。
  const noMatch = await client.get(`${CUSTOMERS}?search=zzz-no-such-customer-${randomUUID()}`);
  const noMatchBody = expectSuccessEnvelope(noMatch, { context: "GET /customers?search=...", paginated: true });
  assert.deepEqual(noMatchBody.data, [], "无匹配的 search 应返回空数组");
  assert.equal(noMatchBody.meta.total, 0);

  // 空字符串的 search/page_size 行为**分裂**，这是现状而不是笔误：
  //   search=""  → 通过校验（IsString 允许空串），service 里 `search ? ... : {}` 当作没有过滤（customers.service.ts:18）；
  //   page_size="" → class-transformer 转成 0 → 撞 @Min(1) → 400（见下一个用例）。
  const emptySearch = await client.get(`${CUSTOMERS}?search=`);
  expectSuccessEnvelope(emptySearch, { context: "GET /customers?search=", paginated: true });
});

test("customers.list_rejects_unknown_query_params_because_the_query_dto_is_a_class", async () => {
  const client = await adminClient();

  const response = await client.get(`${CUSTOMERS}?bogus=1`);
  expectValidationError(response, { code: "VALIDATION_ERROR", context: "GET /customers?bogus=1" });
  const details = expectFieldDetails(response, ["bogus"], "GET /customers?bogus=1");
  assert.equal(details[0].rule, "whitelistValidation", "未知参数由 forbidNonWhitelisted 拦下（main.ts:22）");
  // 对照：`@Query() q: { ... }`（TS 字面量，运行时 metatype 是 Object）的端点会**静默忽略**未知参数（recon D9）。
  // customers 用的是 PaginationQueryDto 类，所以这里是 400 —— 两者不要一刀切。
  assert.equal(response.body.meta.path, "/api/v1/customers?bogus=1", "错误信封 meta.path 必须带查询串");
});

test("customers.list_pagination_bounds_reject_400_with_field_level_details", async () => {
  const client = await adminClient();

  // 上界合法值：200 通过（PaginationQueryDto @Max(200)，pagination-query.dto.ts:15）。
  const upper = await client.get(`${CUSTOMERS}?page_size=200`);
  const upperBody = expectSuccessEnvelope(upper, { context: "GET /customers?page_size=200", paginated: true });
  assert.equal(upperBody.meta.page_size, 200);

  const invalid = [
    ["page_size=201", "page_size"],
    ["page_size=0", "page_size"],
    ["page_size=abc", "page_size"],
    ["page_size=1.5", "page_size"],
    ["page_size=", "page_size"],
    ["page=0", "page"],
    ["page=abc", "page"],
  ];
  for (const [query, field] of invalid) {
    const response = await client.get(`${CUSTOMERS}?${query}`);
    const body = expectValidationError(response, { code: "VALIDATION_ERROR", context: `GET /customers?${query}` });
    expectFieldDetails(response, [field], `GET /customers?${query}`);
    assert.equal(body.meta.path, `/api/v1/customers?${query}`, "错误信封 meta.path 必须回显完整路径");
  }
});

// ---------------------------------------------------------------------------
// 详情 / 路由与方法匹配
// ---------------------------------------------------------------------------

test("customers.detail_of_unknown_uuid_returns_404_with_module_specific_code", async () => {
  const client = await adminClient();
  const id = randomUUID();

  const response = await client.get(`${CUSTOMERS}/${id}`);
  // 该 404 由 service 显式抛出（customers.service.ts:25），因此 code 是 CUSTOMER_NOT_FOUND 而非通用 NOT_FOUND。
  expectErrorEnvelope(response, { code: "CUSTOMER_NOT_FOUND", context: "GET /customers/:id", status: 404 });
  assert.deepEqual(response.body.error.details, [], "CUSTOMER_NOT_FOUND 不带字段级 details");
  assert.equal(response.body.meta.path, `/api/v1/customers/${id}`);
});

test("customers.detail_of_listed_row_returns_envelope_with_empty_meta", async (t) => {
  const client = await adminClient();

  const list = await client.get(`${CUSTOMERS}?page_size=5`);
  const listBody = expectSuccessEnvelope(list, { context: "GET /customers", paginated: true });
  const row = listBody.data[0];
  if (!row) {
    t.skip("库中暂时没有可用客户行（其它测试进程正在增删），详情成功分支本次不覆盖");
    return;
  }

  const detail = await client.get(`${CUSTOMERS}/${row.id}`);
  if (detail.status === 404) {
    // 其它进程可能在这一瞬间软删除了该行 —— 这仍是合法契约（404 + 信封），不算失败。
    expectErrorEnvelope(detail, { code: "CUSTOMER_NOT_FOUND", context: "GET /customers/:id (race)", status: 404 });
    return;
  }

  const body = expectSuccessEnvelope(detail, { context: "GET /customers/:id" });
  assert.deepEqual(body.meta, {}, "详情端点没有分页，meta 为空对象（现状）");
  assert.equal(body.data.id, row.id, "详情应回显请求的 id");
  assert.ok(Array.isArray(body.data.contacts), "详情同样内嵌 contacts 数组");
  for (const contact of body.data.contacts) {
    assert.equal(contact.customerId, row.id, "联系人必须属于该客户");
    assert.equal(typeof contact.name, "string");
    assert.equal(typeof contact.isDefault, "boolean");
    assert.equal(typeof contact.isActive, "boolean");
  }
});

test("customers.route_and_method_mismatches_return_404_never_405", async () => {
  const client = await adminClient();
  const id = randomUUID();

  // 方法不匹配（PUT 未注册）→ 404，message 是英文的 Nest 兜底文案，不是 405。
  const putCollection = await client.raw(`${CUSTOMERS}`, { method: "PUT" });
  expectNotFound(putCollection, "PUT /customers");
  assert.match(putCollection.body.error.message, /^Cannot PUT/, "方法不匹配的 message 形如 Cannot PUT ...");

  // POST /customers/:id 未注册（只有 PATCH/DELETE）→ 404，而不是 405。
  const postDetail = await client.post(`${CUSTOMERS}/${id}`, {});
  expectNotFound(postDetail, "POST /customers/:id");
  assert.match(postDetail.body.error.message, /^Cannot POST/);

  // 联系人没有 GET 集合路由：列表/详情通过客户行内嵌 contacts 暴露（customers.controller.ts:58-66）。
  const getContacts = await client.get(`${CUSTOMERS}/${id}/contacts`);
  expectNotFound(getContacts, "GET /customers/:id/contacts");
  assert.match(getContacts.body.error.message, /^Cannot GET/);
});

// ---------------------------------------------------------------------------
// 鉴权（401）与权限（403）
// ---------------------------------------------------------------------------

test("customers.all_nine_routes_reject_anonymous_requests_with_401", async () => {
  const anonymous = apiClient(baseUrl);
  const id = randomUUID();
  const contactId = randomUUID();

  // 9 个路由逐个匿名探测（customers.controller.ts:58-66）。匿名请求在 guard 就被拦下，
  // body 里的这些假值永远不会进入 service，因此不会写任何数据。
  const probes = [
    ["GET", `${CUSTOMERS}`, undefined],
    ["POST", `${CUSTOMERS}`, { code_mode: "auto", name: "PROBE-ANON" }],
    ["GET", `${CUSTOMERS}/${id}`, undefined],
    ["PATCH", `${CUSTOMERS}/${id}`, { name: "PROBE-ANON" }],
    ["PATCH", `${CUSTOMERS}/${id}/active`, { is_active: false }],
    ["DELETE", `${CUSTOMERS}/${id}`, undefined],
    ["POST", `${CUSTOMERS}/${id}/contacts`, { name: "PROBE-ANON" }],
    ["PATCH", `${CUSTOMERS}/${id}/contacts/${contactId}`, { name: "PROBE-ANON" }],
    ["DELETE", `${CUSTOMERS}/${id}/contacts/${contactId}`, undefined],
  ];
  assert.equal(probes.length, 9, "客户控制器共 9 个路由（5 个客户 + 1 个启停 + 3 个联系人）");

  for (const [method, path, payload] of probes) {
    const response = payload === undefined
      ? await anonymous.raw(path, { method })
      : await anonymous.raw(path, { body: JSON.stringify(payload), headers: { "content-type": "application/json" }, method });
    expectUnauthenticated(response, `${method} ${path}（匿名）`);
  }

  // 无效/伪造的 Cookie 也是 401 UNAUTHENTICATED（AuthenticationGuard 读不到有效 session 就抛 401，
  // authentication.guard.ts:12 + auth.service.ts:36-40）——不是 403。
  const forged = apiClient(baseUrl, { cookie: `dilee_session=${randomUUID()}` });
  expectUnauthenticated(await forged.get(CUSTOMERS), "伪造 Cookie");
  expectUnauthenticated(await forged.patch(`${CUSTOMERS}/${id}/active`, { is_active: true }), "伪造 Cookie + 写端点");
});

// ---------------------------------------------------------------------------
// 写端点的校验层（不落库）
// ---------------------------------------------------------------------------

test("customers.create_validation_layer_rejects_bad_body_before_any_write", async () => {
  const client = await adminClient();

  // 缺 name：CustomerDto.name 是唯一的必填字段（customers.controller.ts:17）。
  const missingName = await client.post(`${CUSTOMERS}`, {});
  expectValidationError(missingName, { code: "VALIDATION_ERROR", context: "POST /customers {}" });
  expectFieldDetails(missingName, ["name"], "POST /customers {}");

  // 未知字段 → whitelistValidation（DTO 类的现状，见 D9 对照）。
  const unknownField = await client.post(`${CUSTOMERS}`, { code_mode: "auto", name: "PROBE-CONTRACT", zzz: 1 });
  const unknownDetails = expectFieldDetails(unknownField, ["zzz"], "POST /customers 未知字段");
  assert.equal(unknownDetails[0].rule, "whitelistValidation");
  expectValidationError(unknownField, { code: "VALIDATION_ERROR", context: "POST /customers 未知字段" });

  // code_mode 只允许 auto|manual（@IsIn，customers.controller.ts:16）。
  const badMode = await client.post(`${CUSTOMERS}`, { code_mode: "bogus", name: "PROBE-CONTRACT" });
  expectFieldDetails(badMode, ["code_mode"], "POST /customers code_mode");
  expectValidationError(badMode, { code: "VALIDATION_ERROR", context: "POST /customers code_mode" });

  // 类型 / 长度：name 必须是字符串且 ≤200。
  const wrongType = await client.post(`${CUSTOMERS}`, { code_mode: "auto", name: 123 });
  expectFieldDetails(wrongType, ["name"], "POST /customers name 类型");
  const tooLong = await client.post(`${CUSTOMERS}`, { code_mode: "auto", name: "x".repeat(201) });
  const longDetails = expectFieldDetails(tooLong, ["name"], "POST /customers name 长度");
  assert.equal(longDetails[0].rule, "maxLength");

  // 以上全部在 ValidationPipe 阶段失败，没有任何请求到达 service → 未创建任何客户。
});

test("customers.create_without_code_mode_returns_422_CUSTOMER_CODE_REQUIRED", async () => {
  const client = await adminClient();

  // 契约要点：DTO 通过了校验（customer_code / code_mode 都是 @IsOptional），
  // 但 service 判断「非 auto 必须有手工编码」并抛 422（customers.service.ts:34）——
  // 这是业务规则，不是 DTO 校验，所以状态码是 422 且 code 是精确的 CUSTOMER_CODE_REQUIRED。
  const response = await client.post(`${CUSTOMERS}`, { name: `PROBE-CONTRACT-${randomUUID()}` });
  expectBusinessRuleViolation(response, { code: "CUSTOMER_CODE_REQUIRED", context: "POST /customers 无 code_mode" });
  // 该分支在 prisma.customer.create 之前抛出，不会落库。
  assert.deepEqual(response.body.error.details, []);
});

test("customers.update_validation_layer_then_404_on_unknown_id", async () => {
  const client = await adminClient();
  const id = randomUUID();

  // 未知字段 → 400，在 service 之前拦下。
  const unknownField = await client.patch(`${CUSTOMERS}/${id}`, { zzz: 1 });
  expectValidationError(unknownField, { code: "VALIDATION_ERROR", context: "PATCH /customers/:id 未知字段" });
  assert.equal(expectFieldDetails(unknownField, ["zzz"], "PATCH /customers/:id 未知字段")[0].rule, "whitelistValidation");

  // 类型错误 → 400。
  const wrongType = await client.patch(`${CUSTOMERS}/${id}`, { name: 5 });
  expectFieldDetails(wrongType, ["name"], "PATCH /customers/:id name 类型");

  // 空 body 是合法的（UpdateCustomerDto 全可选），于是走到 service —— 用随机 UUID，
  // service.update 先 await this.get(id) 抛 404（customers.service.ts:52），不会产生写入。
  const noSuchCustomer = await client.patch(`${CUSTOMERS}/${id}`, {});
  expectErrorEnvelope(noSuchCustomer, { code: "CUSTOMER_NOT_FOUND", context: "PATCH /customers/:id 不存在", status: 404 });
});

test("customers.set_active_validation_layer_then_404_on_unknown_id", async () => {
  const client = await adminClient();
  const id = randomUUID();

  // is_active 必填且必须布尔（ActiveDto，customers.controller.ts:33）。
  const empty = await client.patch(`${CUSTOMERS}/${id}/active`, {});
  expectValidationError(empty, { code: "VALIDATION_ERROR", context: "PATCH /customers/:id/active {}" });
  assert.equal(expectFieldDetails(empty, ["is_active"], "PATCH active {}")[0].rule, "isBoolean");

  // 字符串 "yes" 不做隐式转换（没有 @Transform）→ 400。
  const notBoolean = await client.patch(`${CUSTOMERS}/${id}/active`, { is_active: "yes" });
  assert.equal(expectFieldDetails(notBoolean, ["is_active"], "PATCH active 字符串")[0].rule, "isBoolean");

  // 未知字段一并拒绝。
  const unknownField = await client.patch(`${CUSTOMERS}/${id}/active`, { is_active: true, zzz: 1 });
  expectFieldDetails(unknownField, ["zzz"], "PATCH active 未知字段");

  // 合法 body + 不存在的 UUID → 404（get() 先于 update，customers.service.ts:61），客户不会被启用/停用。
  const noSuchCustomer = await client.patch(`${CUSTOMERS}/${id}/active`, { is_active: false });
  expectErrorEnvelope(noSuchCustomer, { code: "CUSTOMER_NOT_FOUND", context: "PATCH active 不存在", status: 404 });
});

test("customers.contacts_create_validation_layer_then_404_on_unknown_customer", async () => {
  const client = await adminClient();
  const id = randomUUID();

  // ContactDto.name 必填（customers.controller.ts:35）。
  const missingName = await client.post(`${CUSTOMERS}/${id}/contacts`, {});
  expectValidationError(missingName, { code: "VALIDATION_ERROR", context: "POST contacts {}" });
  expectFieldDetails(missingName, ["name"], "POST contacts {}");

  // 未知字段 → whitelistValidation。
  const unknownField = await client.post(`${CUSTOMERS}/${id}/contacts`, { name: "PROBE-CONTACT", zzz: 1 });
  assert.equal(expectFieldDetails(unknownField, ["zzz"], "POST contacts 未知字段")[0].rule, "whitelistValidation");

  // 布尔字段不做隐式转换。
  const badBoolean = await client.post(`${CUSTOMERS}/${id}/contacts`, { is_default: "yes", name: "PROBE-CONTACT" });
  assert.equal(expectFieldDetails(badBoolean, ["is_default"], "POST contacts is_default")[0].rule, "isBoolean");
  const badActive = await client.post(`${CUSTOMERS}/${id}/contacts`, { is_active: 1, name: "PROBE-CONTACT" });
  assert.equal(expectFieldDetails(badActive, ["is_active"], "POST contacts is_active")[0].rule, "isBoolean");

  // 合法 body + 不存在的客户 → 404（createContact 先 await this.get，customers.service.ts:75）→ 不落库。
  const noSuchCustomer = await client.post(`${CUSTOMERS}/${id}/contacts`, { name: "PROBE-CONTACT" });
  expectErrorEnvelope(noSuchCustomer, { code: "CUSTOMER_NOT_FOUND", context: "POST contacts 客户不存在", status: 404 });
});

test("customers.contacts_update_and_delete_reject_unknown_customer_with_404", async () => {
  const client = await adminClient();
  const id = randomUUID();
  const contactId = randomUUID();

  // 未知字段 → 400（UpdateContactDto 全可选，因此空 body 会走到 service）。
  const unknownField = await client.patch(`${CUSTOMERS}/${id}/contacts/${contactId}`, { zzz: 1 });
  expectValidationError(unknownField, { code: "VALIDATION_ERROR", context: "PATCH contacts/:contactId 未知字段" });
  assert.equal(expectFieldDetails(unknownField, ["zzz"], "PATCH contacts/:contactId 未知字段")[0].rule, "whitelistValidation");

  // 空 body + 不存在的客户 → 404 CUSTOMER_NOT_FOUND（先查客户，customers.service.ts:85）。
  const patchNoCustomer = await client.patch(`${CUSTOMERS}/${id}/contacts/${contactId}`, {});
  expectErrorEnvelope(patchNoCustomer, { code: "CUSTOMER_NOT_FOUND", context: "PATCH contacts 客户不存在", status: 404 });

  // 删除同理：先 get(customerId) 再 requireContact（customers.service.ts:96-97）→ 404，不软删任何东西。
  const deleteNoCustomer = await client.del(`${CUSTOMERS}/${id}/contacts/${contactId}`);
  expectErrorEnvelope(deleteNoCustomer, { code: "CUSTOMER_NOT_FOUND", context: "DELETE contacts 客户不存在", status: 404 });

  // 客户 DELETE 也是同一形状：软删除，但 404 分支不会执行 update。
  const deleteCustomer = await client.del(`${CUSTOMERS}/${id}`);
  expectErrorEnvelope(deleteCustomer, { code: "CUSTOMER_NOT_FOUND", context: "DELETE /customers/:id 不存在", status: 404 });
});

// ---------------------------------------------------------------------------
// KNOWN_DEFECT：:id 没有 UUID 校验，脏路径落成 500
// ---------------------------------------------------------------------------

test("KNOWN_DEFECT customers.non_uuid_id_reaches_prisma_and_returns_500", async () => {
  const client = await adminClient();

  // 期望：:id 不是 UUID 时应由管道/控制器拒绝（400 VALIDATION_ERROR，或规范化成 404）。
  // 实际：@Param("id") 只是 string（customers.controller.ts:60-66，没有 ParseUUIDPipe），
  // 原样传进 prisma.customer.findFirst 的 @db.Uuid 列（customers.service.ts:24），
  // PostgreSQL 抛类型错误 → 未被识别为 P2002 → 全局兜底 500 REQUEST_ERROR（api-exception.filter.ts:15,55）。
  // 后果：前端把「客户端传错 id」当成服务端故障，500 还会打 ERROR 级日志。
  // 修复后本用例应变红，请同步更新 docs 与报告。
  const dirtyIds = ["not-a-uuid", "123", "1 OR 1=1"];
  for (const dirty of dirtyIds) {
    const detail = await client.get(`${CUSTOMERS}/${encodeURIComponent(dirty)}`);
    expectErrorEnvelope(detail, { code: "REQUEST_ERROR", context: `GET /customers/${dirty}`, status: 500 });

    const update = await client.patch(`${CUSTOMERS}/${encodeURIComponent(dirty)}`, {});
    expectErrorEnvelope(update, { code: "REQUEST_ERROR", context: `PATCH /customers/${dirty}`, status: 500 });

    const remove = await client.del(`${CUSTOMERS}/${encodeURIComponent(dirty)}`);
    expectErrorEnvelope(remove, { code: "REQUEST_ERROR", context: `DELETE /customers/${dirty}`, status: 500 });

    const contact = await client.post(`${CUSTOMERS}/${encodeURIComponent(dirty)}/contacts`, { name: "PROBE-DIRTY-ID" });
    expectErrorEnvelope(contact, { code: "REQUEST_ERROR", context: `POST /customers/${dirty}/contacts`, status: 500 });
  }
});
