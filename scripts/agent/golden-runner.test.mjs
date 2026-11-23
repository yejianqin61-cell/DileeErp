import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEvent, collectDocNumbers, emptyRunOutcome, followRun, login, mergeOutcomes, parseFrame, runCase, splitFrames } from "./golden-runner.mjs";

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function sseResponse(chunks) {
  return { ok: true, status: 200, body: streamOf(chunks) };
}

const frame = (seq, type, data) => `id: run:${seq}\ndata: ${JSON.stringify({ v: 1, run_id: "run", seq, type, at: "2026-11-22T00:00:00.000Z", data })}\n\n`;

test("一帧被拆成三个 chunk 时不丢不重", async () => {
  const full = frame(1, "answer_delta", { text: "你好" });
  const chunks = [full.slice(0, 7), full.slice(7, 25), full.slice(25), frame(2, "completed", { answer: "你好", sources: [] })];
  const fetchImpl = async () => sseResponse(chunks);
  const outcome = await followRun({ fetchImpl, apiBase: "http://x/api/v1", cookie: "c=1", runId: "run", signal: new AbortController().signal });
  assert.equal(outcome.answer, "你好");
  assert.equal(outcome.terminal, "completed");
});

test("心跳注释不进事件列表", async () => {
  const fetchImpl = async () => sseResponse([": ping\n\n", frame(1, "completed", { answer: "", sources: [] })]);
  const outcome = await followRun({ fetchImpl, apiBase: "http://x/api/v1", cookie: "c=1", runId: "run", signal: new AbortController().signal });
  assert.equal(outcome.terminal, "completed");
  assert.equal(outcome.answerChunks, 0);
});

test("tool_status failed 的 code 进 failureCodes", () => {
  const outcome = applyEvent(emptyRunOutcome("run"), {
    seq: 1,
    type: "tool_status",
    data: { operation: "search_documents", status: "failed", code: "ORDER_NOT_FOUND" },
  });
  assert.deepEqual(outcome.failureCodes, ["ORDER_NOT_FOUND"]);
});

test("两条 source 事件各一条来源时合并为两条", () => {
  const first = applyEvent(emptyRunOutcome("run"), {
    seq: 1,
    type: "source",
    data: { sources: [{ business_type: "sales_order", business_no: "MOCK-ORD-001", queried_at: "t" }] },
  });
  const second = applyEvent(first, {
    seq: 2,
    type: "source",
    data: { sources: [{ business_type: "purchase_order", business_no: "MOCK-PO-001", queried_at: "t" }] },
  });
  assert.equal(second.sources.length, 2);
  assert.equal(second.sources[1].business_no, "MOCK-PO-001");
});

test("多轮用例只建一个 session、每轮一个 run", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/business-query/sessions")) return jsonResponse({ data: { session_id: "s1" }, meta: {} });
    if (url.endsWith("/runs")) return jsonResponse({ data: { run_id: `r${calls.length}`, state: "planning" }, meta: {} });
    return sseResponse([frame(1, "completed", { answer: "ok", sources: [] })]);
  };
  const outcome = await runCase({
    fetchImpl,
    apiBase: "http://x/api/v1",
    cookie: "c=1",
    caseDef: { id: "multi", group: "followup", turns: ["第一问", "第二问"], expect: { terminal: "completed" } },
    signal: new AbortController().signal,
  });
  assert.equal(calls.filter((call) => call.endsWith("/business-query/sessions")).length, 1);
  assert.equal(calls.filter((call) => call.endsWith("/runs")).length, 2);
  assert.equal(outcome.turns.length, 2);
  assert.equal(outcome.terminal, "completed");
});

test("set-cookie 里取出 dilee_session", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 201,
    headers: { getSetCookie: () => ["dilee_session=abc123; Path=/; HttpOnly", "other=1; Path=/"] },
  });
  const cookie = await login({ fetchImpl, apiBase: "http://x/api/v1", username: "admin", password: "p" });
  assert.equal(cookie, "dilee_session=abc123");
});

test("splitFrames 保留半帧", () => {
  const split = splitFrames("data: {\"type\":\"a\"}\n\ndata: {\"ty");
  assert.equal(split.frames.length, 1);
  assert.equal(split.rest, "data: {\"ty");
});

test("parseFrame 忽略坏 JSON 但保留好帧", () => {
  const events = parseFrame("data: not-json\ndata: {\"type\":\"completed\",\"seq\":3,\"data\":{}}");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "completed");
});

test("mergeOutcomes 汇总多轮的工具次数与失败码", () => {
  const merged = mergeOutcomes([
    { terminal: "completed", errorCode: null, ops: ["search_documents"], failureCodes: [], sources: [], answer: "一", toolCalls: 2, answerChunks: 1 },
    { terminal: "completed", errorCode: null, ops: ["get_order_status"], failureCodes: ["ORDER_REF_REQUIRED"], sources: [], answer: "二", toolCalls: 3, answerChunks: 2 },
  ]);
  assert.equal(merged.toolCalls, 5);
  assert.deepEqual(merged.ops, ["search_documents", "get_order_status"]);
  assert.deepEqual(merged.failureCodes, ["ORDER_REF_REQUIRED"]);
  assert.equal(merged.answer, "二");
});

test("collectDocNumbers 兼容 snake_case 与接口返回的 camelCase", () => {
  const docs = collectDocNumbers([
    { rows: [{ order_no: "MOCK-ORD-001" }] },
    [{ purchaseOrderNo: "MOCK-PO-001", orderNo: "MOCK-ORD-001" }],
    [{ productionOrderNo: "MOCK-PROD-001" }],
  ]);
  assert.deepEqual([...docs].sort(), ["MOCK-ORD-001", "MOCK-PO-001", "MOCK-PROD-001"]);
});

test("completed 事件的 model_steps 被采集", () => {
  const outcome = applyEvent(emptyRunOutcome("run"), { seq: 1, type: "completed", data: { answer: "", sources: [], usage: { tool_calls: 2, answer_chunks: 5, model_steps: 2 } } });
  assert.equal(outcome.modelSteps, 2);
  assert.equal(outcome.toolCalls, 2);
});

test("mergeOutcomes 汇总模型步数", () => {
  const merged = mergeOutcomes([
    { terminal: "completed", errorCode: null, ops: [], failureCodes: [], sources: [], answer: "一", toolCalls: 1, answerChunks: 1, modelSteps: 2 },
    { terminal: "completed", errorCode: null, ops: [], failureCodes: [], sources: [], answer: "二", toolCalls: 1, answerChunks: 1, modelSteps: 1 },
  ]);
  assert.equal(merged.modelSteps, 3);
});

test("run 404 时抛错而不是静默空结果", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  await assert.rejects(
    () => followRun({ fetchImpl, apiBase: "http://x/api/v1", cookie: "c=1", runId: "nope", signal: new AbortController().signal }),
    /不存在/,
  );
});