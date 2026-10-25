// 业务查询页前端状态机（lib/business-query-state.ts）的单元测试（node:test，与 lib 下其它纯函数一致）。
//
// 状态迁移必须与模块设计「SSE 与前后端状态机」对齐：idle → submitting → connecting → streaming → done，
// 另有 disconnected / error / cancelled；seq 去重；快照恢复不得与重放的 answer_delta 重复拼接。
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialBusinessQueryState, reduce } from "./business-query-state.ts";

const submit = reduce(initialBusinessQueryState, { type: "SUBMIT", question: "SO 开头有哪些订单？", sessionId: "s-1" });
const created = reduce(submit, { type: "RUN_CREATED", runId: "r-1" });
const connected = reduce(created, { type: "CONNECTED" });
const streaming = reduce(connected, { type: "EVENT", event: { seq: 1, type: "state", data: { state: "querying" } } });

test("SUBMIT → RUN_CREATED → CONNECTED：idle 推进到 connecting，输入被记住", () => {
  assert.equal(submit.phase, "submitting");
  assert.equal(submit.question, "SO 开头有哪些订单？");
  assert.equal(created.phase, "connecting");
  assert.equal(created.runId, "r-1");
  assert.equal(connected.phase, "connecting");
});

test("首条事件把 connecting 推进到 streaming；两个 answer_delta 按序拼接", () => {
  assert.equal(streaming.phase, "streaming");
  const withDelta = reduce(streaming, { type: "EVENT", event: { seq: 2, type: "answer_delta", data: { text: "找到 1 张订单：" } } });
  const withDelta2 = reduce(withDelta, { type: "EVENT", event: { seq: 3, type: "answer_delta", data: { text: "SO-001。" } } });
  assert.equal(withDelta2.answer, "找到 1 张订单：SO-001。");
});

test("seq 去重：已应用的 seq 再来一遍，状态与内容都不变", () => {
  const duplicated = reduce(streaming, { type: "EVENT", event: { seq: 1, type: "answer_delta", data: { text: "重复" } } });
  assert.equal(duplicated, streaming, "重复事件必须被整个忽略");
});

test("completed 收束为 done，答案与来源以后端为准；之后的事件不再改变状态", () => {
  const withSource = reduce(streaming, { type: "EVENT", event: { seq: 2, type: "source", data: { sources: [{ business_type: "sales_order", business_no: "SO-001" }] } } });
  const done = reduce(withSource, { type: "EVENT", event: { seq: 3, type: "completed", data: { answer: "最终答案", sources: [{ business_type: "sales_order", business_no: "SO-001" }], usage: { tool_calls: 1 } } } });
  assert.equal(done.phase, "done");
  assert.equal(done.answer, "最终答案");
  assert.deepEqual(done.sources.map((source) => source.business_no), ["SO-001"]);
  const ignored = reduce(done, { type: "EVENT", event: { seq: 4, type: "answer_delta", data: { text: "迟到" } } });
  assert.equal(ignored, done, "终态后事件被忽略");
});

test("断线 → disconnected；恢复时先套快照再续接，不重复拼接", () => {
  const withDelta = reduce(streaming, { type: "EVENT", event: { seq: 2, type: "answer_delta", data: { text: "回答的前半" } } });
  const disconnected = reduce(withDelta, { type: "DISCONNECTED" });
  assert.equal(disconnected.phase, "disconnected");

  // 快照来自服务端：答案以它为准，lastSeq 跳到 latest_seq，之后只拼新增量。
  const restored = reduce(disconnected, { type: "SNAPSHOT_RESTORED", snapshot: { runId: "r-1", state: "responding", question: "SO 开头有哪些订单？", answer: "回答的前半", sources: [], latestSeq: 5 } });
  assert.equal(restored.phase, "streaming");
  assert.equal(restored.answer, "回答的前半");
  assert.equal(restored.lastSeq, 5);

  const stale = reduce(restored, { type: "EVENT", event: { seq: 4, type: "answer_delta", data: { text: "已包含在快照里" } } });
  assert.equal(stale, restored, "seq <= latest_seq 的重放被去重");
  const fresh = reduce(restored, { type: "EVENT", event: { seq: 6, type: "answer_delta", data: { text: "＋后半" } } });
  assert.equal(fresh.answer, "回答的前半＋后半");
});

test("error 事件：进入 error，保留已收片段并标记未完成", () => {
  const withDelta = reduce(streaming, { type: "EVENT", event: { seq: 2, type: "answer_delta", data: { text: "已有片段" } } });
  const failed = reduce(withDelta, { type: "EVENT", event: { seq: 3, type: "error", data: { code: "AGENT_INTERNAL_ERROR", message: "查询执行出错，请稍后重试" } } });
  assert.equal(failed.phase, "error");
  assert.equal(failed.answer, "已有片段", "片段保留但页面要标记未完成");
  assert.equal(failed.error?.code, "AGENT_INTERNAL_ERROR");
});

test("cancelled 事件：进入 cancelled；done 状态的 run 不可再提交续接", () => {
  const cancelled = reduce(streaming, { type: "EVENT", event: { seq: 2, type: "cancelled", data: { state: "cancelled" } } });
  assert.equal(cancelled.phase, "cancelled");
});

test("RESET 回到 idle，清空问答内容", () => {
  const done = reduce(reduce(streaming, { type: "EVENT", event: { seq: 2, type: "completed", data: { answer: "答案", sources: [] } } }), { type: "RESET" });
  assert.equal(done.phase, "idle");
  assert.equal(done.answer, "");
  assert.equal(done.runId, null);
});

test("tool_status：同一工具的 running → completed 只留一条，失败带错误码", () => {
  const running = reduce(connected, { type: "EVENT", event: { seq: 1, type: "tool_status", data: { tool: "order_query", operation: "search_orders", status: "running" } } });
  assert.equal(running.phase, "streaming", "工具进度也是流中事件");
  const completed = reduce(running, { type: "EVENT", event: { seq: 2, type: "tool_status", data: { tool: "order_query", operation: "search_orders", status: "completed" } } });
  assert.deepEqual(completed.toolSteps.map((step) => step.status), ["completed"]);
  const failed = reduce(running, { type: "EVENT", event: { seq: 2, type: "tool_status", data: { tool: "order_query", operation: "search_orders", status: "failed", code: "AGENT_TOOL_ARGUMENT_INVALID" } } });
  assert.deepEqual(failed.toolSteps.map((step) => [step.status, step.code]), [["failed", "AGENT_TOOL_ARGUMENT_INVALID"]]);
});

test("SNAPSHOT_RESTORED 对终态快照：completed → done，cancelled → cancelled", () => {
  const doneSnapshot = reduce(initialBusinessQueryState, { type: "SNAPSHOT_RESTORED", snapshot: { runId: "r-2", state: "completed", question: "q", answer: "完整答案", sources: [{ business_type: "sales_order", business_no: "SO-002" }], latestSeq: 9 } });
  assert.equal(doneSnapshot.phase, "done");
  const cancelledSnapshot = reduce(initialBusinessQueryState, { type: "SNAPSHOT_RESTORED", snapshot: { runId: "r-3", state: "cancelled", question: "q", answer: "半截", sources: [], latestSeq: 4 } });
  assert.equal(cancelledSnapshot.phase, "cancelled");
});
