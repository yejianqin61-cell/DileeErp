// HTTP 契约测试宿主。
//
// 改造背景（见 docs/test/00-recon-api-contract.md:268）：
//   旧实现在请求头里放 `Authorization: Bearer <token>`，但后端**完全不支持 Bearer**
//   （authentication.guard.ts:12 只读 request.cookies?.dilee_session），
//   所以任何"带 token"的调用其实仍是匿名请求 —— 鉴权用例会被静默跳过。
//   本实现统一改为 Cookie 会话，并提供真实登录与契约断言。
//
// 后端契约要点（全部有代码依据，见 00-recon-api-contract.md §1、§3、§4）：
//   - 成功：{ data, meta }；meta.request_id **恒为 undefined**（拦截器读的是请求头而非 middleware 写的响应头）。
//     唯一可靠的关联 id 是**响应头** `x-request-id`（request-id.middleware.ts:7）。
//   - 失败：{ error: { code, message, details }, meta: { path } }。
//   - POST 默认返回 **201**（含 /auth/login）；POST /auth/logout 返回 **204** 且无响应体。
//   - 没有 405：方法不匹配走 404（routes-resolver 的 not-found handler）。
//
// 用法：
//   const { apiClient, login, expectSuccessEnvelope, expectErrorEnvelope } = require(".../api-client.cjs");
//   const session = await login(baseUrl, { username, password });
//   const client = apiClient(baseUrl, { cookie: session.cookie });
//   const response = await client.request("/api/v1/customers");
//   expectSuccessEnvelope(response);
const assert = require("node:assert/strict");

/** request-id.middleware.ts:7 写入的响应头，是唯一可靠的请求关联 id。 */
const REQUEST_ID_HEADER = "x-request-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 建立 API 客户端。
 *
 * @param {string} baseUrl 例如 http://127.0.0.1:3001
 * @param {string|object} [options] 传字符串等价于传 { token }（兼容旧调用）
 * @param {string} [options.token]  会话 token，会自动包装成 Cookie
 * @param {string} [options.cookie] 完整 Cookie 值（优先于 token）
 * @param {object} [options.headers] 额外请求头
 */
function apiClient(baseUrl, options = {}) {
  const settings = typeof options === "string" ? { token: options } : options;
  const baseHeaders = { ...(settings.headers ?? {}) };
  if (settings.cookie) baseHeaders.cookie = settings.cookie;
  else if (settings.token) baseHeaders.cookie = `dilee_session=${settings.token}`;

  /**
   * 发起请求。返回 { status, body, headers, requestId }。
   * body 解析失败时回退为 {}（204 空体、二进制导出都会走到这里）。
   */
  async function request(path, requestOptions = {}) {
    const hasBody = requestOptions.body !== undefined && requestOptions.body !== null;
    const headers = { ...baseHeaders, ...(requestOptions.headers ?? {}) };
    if (hasBody && !headers["content-type"]) headers["content-type"] = "application/json";
    const response = await fetch(new URL(path, baseUrl), { ...requestOptions, headers });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : await response.text().catch(() => "");
    return { body, contentType, headers: response.headers, requestId: response.headers.get(REQUEST_ID_HEADER), status: response.status };
  }

  /** 以 JSON 体发 POST/PATCH/PUT/DELETE。 */
  const json = (path, method, payload) => request(path, { body: payload === undefined ? undefined : JSON.stringify(payload), method });

  return {
    // 注意：get 必须转发 options —— 否则 `client.get(path, { headers })` 会静默丢掉请求头
    get: (path, options) => request(path, options),
    patch: (path, payload) => json(path, "PATCH", payload),
    post: (path, payload) => json(path, "POST", payload),
    put: (path, payload) => json(path, "PUT", payload),
    del: (path, payload) => json(path, "DELETE", payload),
    raw: request,
    request,
  };
}

/**
 * 真实登录。返回 { cookie, status, body, requestId }。
 * 注意 status 预期为 **201**（所有 POST 的默认状态码），不是 200。
 *
 * ⚠️ 本 API 是「单会话」的：AuthService.login() 会先删该用户的全部 session 再建新的
 * （auth.service.ts:29），因此**同一用户名不能并发登录** —— 后一次登录会作废前一次的 Cookie。
 * 多个测试文件并行以 admin 登录时会互相 401。
 * 写 HTTP 契约测试请用 `--test-concurrency=1` 串行执行
 * （见 docs/test/02-test-environment-runbook.md §7.5），或为每个文件使用不同用户。
 */
async function login(baseUrl, { username, password }) {
  const response = await fetch(new URL("/api/v1/auth/login", baseUrl), {
    body: JSON.stringify({ password, username }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await response.json().catch(() => ({}));
  const setCookie = response.headers.get("set-cookie") ?? "";
  // Set-Cookie 是 "dilee_session=xxx; Path=/; HttpOnly; SameSite=Lax"，后续请求只需要键值对。
  const cookie = setCookie.split(";")[0].trim();
  return { body, cookie, requestId: response.headers.get(REQUEST_ID_HEADER), status: response.status };
}

/** 按角色登录已种子用户（配合 tests/fixtures/seed-users.cjs 使用）。 */
async function loginAs(baseUrl, seeded, userName) {
  const credential = seeded.credentials[userName];
  if (!credential) throw new Error(`unknown seeded user "${userName}"; available: ${Object.keys(seeded.credentials).join(", ")}`);
  const session = await login(baseUrl, { password: credential.password, username: credential.username });
  assert.equal(session.status, 201, `login for ${userName} should return 201, got ${session.status}: ${JSON.stringify(session.body)}`);
  return session;
}

// ---------- 契约断言 ----------

/** 断言响应头带 UUID 形式的 x-request-id —— 唯一可靠的请求关联手段。 */
function expectRequestIdHeader(response, context = "") {
  const requestId = response.requestId;
  assert.ok(requestId, `${context} 响应缺少 ${REQUEST_ID_HEADER} 响应头`);
  assert.match(requestId, UUID_PATTERN, `${context} ${REQUEST_ID_HEADER} 应为 UUID，实际为 ${requestId}`);
  return requestId;
}

/**
 * 断言成功信封 { data, meta }。
 * @param {object} response
 * @param {object} [options]
 * @param {number} [options.status=200] 期望状态码（POST 请显式传 201）
 * @param {boolean} [options.paginated] 为 true 时额外断言 meta 含 page/page_size/total
 */
function expectSuccessEnvelope(response, { status = 200, paginated = false, context = "" } = {}) {
  assert.equal(response.status, status, `${context} 期望状态码 ${status}，实际 ${response.status}：${JSON.stringify(response.body)}`);
  const body = response.body;
  assert.ok(body && typeof body === "object", `${context} 响应体应为对象`);
  assert.ok("data" in body, `${context} 成功响应必须含 data 字段；实际键：${Object.keys(body).join(",")}`);
  assert.ok("meta" in body && body.meta !== null && typeof body.meta === "object", `${context} 成功响应必须含对象型 meta 字段`);
  assert.ok(!("error" in body), `${context} 成功响应不应含 error 字段`);
  if (paginated) {
    for (const field of ["page", "page_size", "total"]) {
      assert.ok(field in body.meta, `${context} 分页 meta 缺少 ${field}；实际 meta：${JSON.stringify(body.meta)}`);
    }
  }
  return body;
}

/**
 * 断言失败信封 { error: { code, message, details }, meta }。
 * 前端逻辑只应依赖稳定的 code，不解析 message（global-api-contract.md:55）。
 *
 * 注意：`code` 只在明确给出时做精确断言。400/409/422 允许业务模块使用更精确的大写下划线码
 * （global-api-contract.md:69），例如 409 的 ORDER_NO_CONFLICT、422 的 INSUFFICIENT_INVENTORY，
 * 因此这些状态码的封装只固定**状态码 + 形状**，不固定默认码。
 */
function expectErrorEnvelope(response, { status, code, codeIn, context = "" } = {}) {
  if (status !== undefined) assert.equal(response.status, status, `${context} 期望错误状态码 ${status}，实际 ${response.status}：${JSON.stringify(response.body)}`);
  const body = response.body;
  assert.ok(body && typeof body === "object", `${context} 错误响应体应为对象`);
  assert.ok(body.error && typeof body.error === "object", `${context} 错误响应必须含 error 对象；实际键：${Object.keys(body).join(",")}`);
  assert.equal(typeof body.error.code, "string", `${context} error.code 必须是字符串`);
  // 机器错误码必须是稳定的大写下划线形式：这是前端唯一可以依赖的东西
  assert.match(body.error.code, /^[A-Z][A-Z0-9_]*$/, `${context} error.code 必须是稳定的大写下划线码，实际 ${body.error.code}`);
  assert.equal(typeof body.error.message, "string", `${context} error.message 必须是字符串`);
  assert.ok(Array.isArray(body.error.details), `${context} error.details 必须是数组`);
  if (code !== undefined) assert.equal(body.error.code, code, `${context} 期望错误码 ${code}，实际 ${body.error.code}`);
  if (codeIn !== undefined) assert.ok(codeIn.includes(body.error.code), `${context} 期望错误码属于 ${codeIn.join("|")}，实际 ${body.error.code}`);
  assert.ok(body.meta && typeof body.meta.path === "string", `${context} 错误 meta.path 必须存在`);
  return body;
}

/** 断言 401（未认证）。401 的 code 由过滤器固定为 UNAUTHENTICATED。 */
function expectUnauthenticated(response, context = "") {
  return expectErrorEnvelope(response, { code: "UNAUTHENTICATED", context, status: 401 });
}

/** 断言 403（无权限）。403 的 code 由过滤器固定为 FORBIDDEN。 */
function expectForbidden(response, context = "") {
  return expectErrorEnvelope(response, { code: "FORBIDDEN", context, status: 403 });
}

/** 断言 404（资源不存在或路由/方法不匹配；后端没有 405）。 */
function expectNotFound(response, context = "") {
  return expectErrorEnvelope(response, { code: "NOT_FOUND", context, status: 404 });
}

/**
 * 断言 422（业务规则阻止）。
 * 不固定 code：模块可用更精确的码（如 INSUFFICIENT_INVENTORY、INVALID_STATE_TRANSITION）。
 * 需要精确匹配时传入 `{ code }`。
 */
function expectBusinessRuleViolation(response, { context = "", ...rest } = {}) {
  return expectErrorEnvelope(response, { context, status: 422, ...rest });
}

/**
 * 断言 409（唯一性/版本冲突）。
 * 不固定 code：模块可用 ORDER_NO_CONFLICT、VERSION_CONFLICT 等精确码，
 * 未捕获的 Prisma P2002 则由全局兜底为 UNIQUE_VALUE_CONFLICT。
 */
function expectConflict(response, { context = "", ...rest } = {}) {
  return expectErrorEnvelope(response, { context, status: 409, ...rest });
}

/**
 * 断言 400（DTO/请求格式校验失败）。
 * 不固定 code：DTO 校验走 VALIDATION_ERROR，字符串异常与业务码也可能落在 400。
 */
function expectValidationError(response, { context = "", ...rest } = {}) {
  return expectErrorEnvelope(response, { context, status: 400, ...rest });
}

/** 断言 204 空体（POST /auth/logout 是唯一一处）。 */
function expectNoContent(response, context = "") {
  assert.equal(response.status, 204, `${context} 期望 204，实际 ${response.status}`);
  assert.ok(response.body === "" || response.body === null || (typeof response.body === "object" && Object.keys(response.body).length === 0), `${context} 204 必须无响应体`);
}

module.exports = {
  REQUEST_ID_HEADER,
  UUID_PATTERN,
  apiClient,
  expectBusinessRuleViolation,
  expectConflict,
  expectErrorEnvelope,
  expectForbidden,
  expectNoContent,
  expectNotFound,
  expectRequestIdHeader,
  expectSuccessEnvelope,
  expectUnauthenticated,
  expectValidationError,
  login,
  loginAs,
};
