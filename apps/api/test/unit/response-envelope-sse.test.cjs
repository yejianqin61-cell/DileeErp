// 全局信封拦截器与异常过滤器对 SSE 的放行守卫（require 编译产物）。
//
// SSE 路由自己写 text/event-stream 响应：全局 ResponseEnvelopeInterceptor 若再包一层
// {data,meta} 并 res.json，会在响应已提交后写头直接报错（Cannot set headers after they are sent）。
// 契约：**响应已提交（headersSent）就原样放行**；异常过滤器同理 —— 已提交后只终止，不再写 JSON。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { lastValueFrom, of } = require("rxjs");
const { ResponseEnvelopeInterceptor } = require("../../dist/platform/http/response-envelope.interceptor.js");
const { ApiExceptionFilter } = require("../../dist/platform/http/api-exception.filter.js");

function fakeContext(response, requestId = "req-1") {
  return { switchToHttp: () => ({ getRequest: () => ({ header: () => requestId, url: "/api/v1/business-query/runs/x/events" }), getResponse: () => response }) };
}

test("信封拦截器：普通 JSON 响应仍包 {data, meta} 信封（回归）", async () => {
  const interceptor = new ResponseEnvelopeInterceptor();
  const response = { headersSent: false };
  const result = await lastValueFrom(interceptor.intercept(fakeContext(response), { handle: () => of({ orders: [] }) }));
  assert.deepEqual(result, { data: { orders: [] }, meta: { request_id: "req-1" } });
});

test("信封拦截器：SSE 等已提交响应原样放行，不再 res.json", async () => {
  const interceptor = new ResponseEnvelopeInterceptor();
  const response = { headersSent: true };
  const payload = { sse: true };
  const result = await lastValueFrom(interceptor.intercept(fakeContext(response), { handle: () => of(payload) }));
  assert.equal(result, payload, "headersSent=true 时不得改写或包裹载荷");
});

test("异常过滤器：响应已提交（SSE 中途出错）只终止响应，不再写 JSON", () => {
  const calls = [];
  const response = { headersSent: true, end: () => calls.push("end"), status: () => { throw new Error("不得再写状态"); }, json: () => { throw new Error("不得再写 JSON"); } };
  const filter = new ApiExceptionFilter();
  filter.catch(new Error("stream broken"), fakeContext(response));
  assert.deepEqual(calls, ["end"]);
});

test("异常过滤器：普通路径的 JSON 错误信封不回归（401 未登录）", () => {
  const calls = [];
  const response = { headersSent: false, status: (code) => { calls.push(["status", code]); return response; }, json: (body) => calls.push(["json", body]) };
  const filter = new ApiExceptionFilter();
  const { UnauthorizedException } = require("@nestjs/common");
  filter.catch(new UnauthorizedException(), fakeContext(response));
  assert.deepEqual(calls[0], ["status", 401]);
  assert.equal(calls[1][1].error.code, "UNAUTHENTICATED");
});
