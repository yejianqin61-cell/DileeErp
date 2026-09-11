// api-client 变更类请求的超时保证。
//
// 背景：ActionDialog 在 submitting 期间拒绝关闭（onOpenChange 门禁）。若变更请求没有超时，
// 一次悬挂的 POST 会让弹窗永久关不掉 —— 这正是“关闭按钮点了没反应”的另一种成因。
import test from "node:test";
import assert from "node:assert/strict";
import { ApiClientError, apiRequest } from "./api-client.ts";

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test("POST/PATCH 请求带上超时信号", async () => {
  const calls = [];
  const restore = stubFetch(async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ data: {}, meta: {} }), { status: 200, headers: { "content-type": "application/json" } }); });
  try {
    await apiRequest("/units", { method: "POST", body: "{}" });
    await apiRequest("/units/1", { method: "PATCH", body: "{}" });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].options.signal, "POST 必须带超时信号");
    assert.ok(calls[1].options.signal, "PATCH 必须带超时信号");
  } finally { restore(); }
});

test("GET 不额外注入超时信号（apiGet 自带），且调用方传入的信号优先", async () => {
  const calls = [];
  const restore = stubFetch(async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ data: {}, meta: {} }), { status: 200, headers: { "content-type": "application/json" } }); });
  try {
    await apiRequest("/units");
    assert.equal(calls[0].options.signal, undefined);
    const controller = new AbortController();
    await apiRequest("/units/1", { method: "DELETE", signal: controller.signal });
    assert.equal(calls[1].options.signal, controller.signal, "调用方信号不应被覆盖");
  } finally { restore(); }
});

test("超时被转换为可读的 ApiClientError（而不是裸 DOMException）", async () => {
  const restore = stubFetch(async () => { throw new DOMException("The operation timed out", "TimeoutError"); });
  try {
    await assert.rejects(() => apiRequest("/units", { method: "POST", body: "{}" }), (error) => error instanceof ApiClientError && error.code === "REQUEST_TIMEOUT");
  } finally { restore(); }
});

test("其它网络错误原样抛出，不被误报为超时", async () => {
  const failure = new TypeError("Failed to fetch");
  const restore = stubFetch(async () => { throw failure; });
  try {
    await assert.rejects(() => apiRequest("/units", { method: "POST", body: "{}" }), (error) => error === failure);
  } finally { restore(); }
});
