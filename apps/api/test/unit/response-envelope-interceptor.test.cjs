// ResponseEnvelopeInterceptor 单元测试。
//
// recon 指出它定义了**整个 API 的成功响应形状**，却零测试（docs/test/00-recon-backend-coverage.md）。
// 它同时是 D2 缺陷的成因：拦截器读的是**请求头** `x-request-id`（:9），
// 而 RequestIdMiddleware 只把 id 写到响应头与 request.id（request-id.middleware.ts:7-8），
// 因此 meta.request_id 在客户端不带请求头时恒为 undefined（HTTP 层已由
// contract-guardrails.test.cjs 固化，这里在单元层再钉一次，便于定位）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { of, lastValueFrom } = require("rxjs");
const { ResponseEnvelopeInterceptor } = require("../../dist/platform/http/response-envelope.interceptor.js");

/** 假 ExecutionContext：只需要 switchToHttp().getRequest().header()。 */
const contextWith = (requestId) => ({
  switchToHttp: () => ({ getRequest: () => ({ header: (name) => (name === "x-request-id" ? requestId : undefined) }) }),
});

/** 跑一遍拦截器，返回最终响应体。 */
const run = async (handlerResult, requestId) => {
  const interceptor = new ResponseEnvelopeInterceptor();
  const stream = interceptor.intercept(contextWith(requestId), { handle: () => of(handlerResult) });
  return lastValueFrom(stream);
};

test("response envelope: wraps an object return value and preserves its data", async () => {
  const result = await run({ id: "c-1", name: "客户" }, "req-1");
  assert.deepEqual(result, { data: { id: "c-1", name: "客户" }, meta: { request_id: "req-1" } });
});

test("response envelope: passes through a handler that already built { data, meta }", async () => {
  const result = await run({ data: [{ id: "1" }], meta: { page: 1, page_size: 20, total: 1 } }, "req-2");
  assert.deepEqual(result, { data: [{ id: "1" }], meta: { page: 1, page_size: 20, total: 1, request_id: "req-2" } });
});

test("response envelope: undefined and null become data: null", async () => {
  assert.deepEqual(await run(undefined, "req-3"), { data: null, meta: { request_id: "req-3" } });
  assert.deepEqual(await run(null, "req-4"), { data: null, meta: { request_id: "req-4" } });
});

test("response envelope: falsy primitives are preserved rather than nulled", async () => {
  // 只有 null/undefined 归零；0 / "" / false 是合法返回值，不能被 ?? 吞掉
  assert.equal((await run(0, "req-5")).data, 0);
  assert.equal((await run(false, "req-6")).data, false);
  assert.equal((await run("", "req-7")).data, "");
});

test("KNOWN_CONTRACT_DEFECT D2: request_id comes from the REQUEST header, so it is absent unless the client sends one", async () => {
  const absent = await run({ ok: true }, undefined);
  // meta 里仍有 request_id 这个**键**，值为 undefined —— JSON 序列化时会被丢掉，
  // 这正是线上看到的 meta: {} 。
  assert.ok("request_id" in absent.meta, "拦截器总是写入该键");
  assert.equal(absent.meta.request_id, undefined);
  assert.equal(JSON.stringify(absent.meta), "{}", "序列化后 meta 变成空对象，与实测一致");
});

test("KNOWN_CONTRACT_DEFECT: sibling keys of a { data } handler result are silently dropped", async () => {
  // 陷阱：handler 返回 { data, extra } 时，只有 data 与 meta 被保留，extra 会被丢弃。
  // 当前没有接口命中（recon 已核对全部 controller），但新增接口极易踩 —— 固化为护栏。
  const result = await run({ data: { id: "1" }, extra: "should-be-dropped" }, "req-8");
  assert.deepEqual(Object.keys(result).sort(), ["data", "meta"]);
  assert.equal(result.extra, undefined);
});

test("response envelope: an array return value is wrapped as data without being spread", async () => {
  const result = await run([{ id: "1" }, { id: "2" }], "req-9");
  assert.deepEqual(result, { data: [{ id: "1" }, { id: "2" }], meta: { request_id: "req-9" } });
});
