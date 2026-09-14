// ApiExceptionFilter 错误信封映射测试。
//
// recon 指出「状态码矩阵」几乎全无测试（docs/test/00-recon-api-contract.md §4 的"是否已有测试"列
// 基本是 ❌）。这个过滤器定义了**每一个失败响应**的形状与机器码，是前端唯一可依赖的错误契约面，
// 因此在单元层把整张映射表钉死；HTTP 层的实测护栏见 apps/api/test/http/contract-guardrails.test.cjs。
//
// 另回答 recon 的未验证项 U2：P2025（记录不存在）与 P2003（外键冲突）都不是 HttpException，
// 过滤器只对 P2002 特判，因此它们会落到 **500 REQUEST_ERROR**（正确语义应分别是 404 / 409）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BadRequestException, ConflictException, ForbiddenException, HttpException, Logger, NotFoundException, UnauthorizedException, UnprocessableEntityException } = require("@nestjs/common");
const { ApiExceptionFilter } = require("../../dist/platform/http/api-exception.filter.js");

// 5xx 分支会写 Logger.error，测试输出会被堆栈刷屏；本文件只关心响应体，故静音 logger。
Logger.overrideLogger(false);

/** 假 host：只需要 switchToHttp 的 request/response。 */
function host({ method = "GET", requestId, url = "/api/v1/customers" } = {}) {
  const response = {
    body: null,
    statusCode: 0,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
  const request = { header: (name) => (name === "x-request-id" ? requestId : undefined), method, url };
  return { host: { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }) }, response };
}

/** 跑一遍过滤器，返回 { status, body }。 */
function run(exception, options) {
  const { host: fakeHost, response } = host(options);
  new ApiExceptionFilter().catch(exception, fakeHost);
  return { body: response.body, status: response.statusCode };
}

test("error envelope: Nest HTTP exceptions keep their status and machine code", () => {
  const cases = [
    [new BadRequestException("请求参数校验失败"), 400, "VALIDATION_ERROR"],
    [new UnauthorizedException(), 401, "UNAUTHENTICATED"],
    [new ForbiddenException("无模块访问权限"), 403, "FORBIDDEN"],
    [new NotFoundException("客户不存在"), 404, "NOT_FOUND"],
    [new ConflictException("重复"), 409, "CONFLICT"],
    [new UnprocessableEntityException("库存不足"), 422, "BUSINESS_RULE_VIOLATION"],
  ];
  for (const [exception, expectedStatus, expectedCode] of cases) {
    const { body, status } = run(exception, { requestId: "req-1" });
    assert.equal(status, expectedStatus, `${exception.constructor.name} 状态码`);
    assert.equal(body.error.code, expectedCode, `${exception.constructor.name} 机器码`);
    assert.equal(typeof body.error.message, "string");
    assert.ok(Array.isArray(body.error.details));
    assert.equal(body.meta.path, "/api/v1/customers");
    assert.equal(body.meta.request_id, "req-1");
  }
});

test("error envelope: business exceptions keep their explicit code, message and details", () => {
  const exception = new UnprocessableEntityException({ code: "INSUFFICIENT_INVENTORY", details: [{ available: "3" }], message: "库存不足" });
  const { body, status } = run(exception, { requestId: "req-2" });
  assert.equal(status, 422);
  assert.deepEqual(body.error, { code: "INSUFFICIENT_INVENTORY", details: [{ available: "3" }], message: "库存不足" });
});

test("error envelope: a string payload is forced onto the status's generic code", () => {
  // attachments.service.ts 会抛 BadRequestException("未提供文件") 这类字符串异常；
  // 字符串没有业务码，于是统一落到该状态码的通用码。
  const { body } = run(new BadRequestException("未提供文件"), { requestId: "req-3" });
  assert.deepEqual(body.error, { code: "VALIDATION_ERROR", details: [], message: "未提供文件" });
});

test("error envelope: ValidationPipe's message array becomes a readable message plus field details", () => {
  const exception = new BadRequestException({ message: ["name should not be empty", "page_size must not be greater than 200"] });
  const { body, status } = run(exception, { requestId: "req-4" });
  assert.equal(status, 400);
  assert.equal(body.error.code, "VALIDATION_ERROR");
  assert.equal(body.error.message, "请求参数校验失败");
  assert.deepEqual(body.error.details, [{ message: "name should not be empty" }, { message: "page_size must not be greater than 200" }]);
});

test("error envelope: an unexpected error becomes 500 REQUEST_ERROR without leaking internals", () => {
  const { body, status } = run(new TypeError("Cannot read properties of undefined (reading 'id')"), { requestId: "req-5" });
  assert.equal(status, 500);
  assert.equal(body.error.code, "REQUEST_ERROR");
  assert.equal(body.error.message, "服务器内部错误");
  assert.deepEqual(body.error.details, []);
  assert.equal(JSON.stringify(body).includes("Cannot read properties"), false, "内部异常细节不得出现在响应里");
});

test("error envelope: a non-http status is normalised to REQUEST_ERROR", () => {
  const { body, status } = run(new HttpException("teapot", 418), { requestId: "req-6" });
  assert.equal(status, 418);
  assert.equal(body.error.code, "REQUEST_ERROR", "未在映射表里的状态码统一 REQUEST_ERROR");
  assert.equal(body.error.message, "teapot");
});

test("KNOWN_CONTRACT_DEFECT U2: unmapped Prisma errors (P2025 / P2003) become 500 REQUEST_ERROR", () => {
  // 只有 P2002 被特判（api-exception.filter.ts:14）。P2025 语义是"记录不存在"（应为 404），
  // P2003 是外键冲突（应为 409），但当前都会落到 500 —— 这正是 recon U2 的答案。
  for (const code of ["P2025", "P2003", "P2034"]) {
    const { body, status } = run(Object.assign(new Error(`Prisma ${code}`), { code }), { requestId: "req-7" });
    assert.equal(status, 500, `${code} 当前应落 500；若此处失败说明已做映射，请更新本用例与 recon U2`);
    assert.equal(body.error.code, "REQUEST_ERROR");
  }
});

test("unique violations are mapped to 409 with a business label", () => {
  const withField = run({ code: "P2002", meta: { target: ["material_code"] } }, { requestId: "req-8" });
  assert.equal(withField.status, 409);
  assert.equal(withField.body.error.code, "UNIQUE_VALUE_CONFLICT");
  assert.match(withField.body.error.message, /物料编码/);
  assert.equal(withField.body.error.details[0].field, "material_code");

  // 没有 target 信息时给出兜底文案，而不是 undefined
  const withoutTarget = run({ code: "P2002", meta: {} }, { requestId: "req-9" });
  assert.equal(withoutTarget.body.error.details[0].field, null);
  assert.match(withoutTarget.body.error.message, /业务唯一字段/);

  // 未登记 label 的字段直接回显字段名，避免显示成"undefined已存在"
  const unknownField = run({ code: "P2002", meta: { target: ["some_new_field"] } }, { requestId: "req-10" });
  assert.equal(unknownField.body.error.details[0].field_label, "some_new_field");
});

test("KNOWN_CONTRACT_DEFECT D2: error meta.request_id also comes from the request header", () => {
  const absent = run(new NotFoundException("客户不存在"), {});
  assert.equal(absent.body.meta.request_id, undefined, "客户端不带 x-request-id 时错误响应里也取不到 request_id");
  assert.ok("request_id" in absent.body.meta, "键始终存在，只是值为 undefined，序列化后消失");
  assert.equal(JSON.stringify(absent.body.meta), '{"path":"/api/v1/customers"}');
});

test("error envelope: meta.path reflects the actual request URL including the query string", () => {
  const { body } = run(new BadRequestException("请求参数校验失败"), { url: "/api/v1/customers?page_size=201", requestId: "req-11" });
  assert.equal(body.meta.path, "/api/v1/customers?page_size=201");
});
