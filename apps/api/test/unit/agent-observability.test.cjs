// 可观测性的单元测试（注入内存 logger，不碰全局配置）。
//
// 关键契约：事件类型里**没有** prompt/答案/参数/结果内容字段 —— 脱敏是形状（编译期），
// 这里再用运行时断言把「允许的键集合」钉死，防止有人给事件类型塞业务值。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AgentObservability } = require("../../dist/modules/business-query-agent/observability.js");

/** 内存 logger：捕获 log 输出。 */
function fakeSink() {
  const lines = [];
  return { lines, log: (message) => lines.push(message), warn: (message) => lines.push(message), error: (message) => lines.push(message) };
}
const RUN = "11111111-1111-4111-8111-111111111111";
const parse = (sink) => JSON.parse(sink.lines.at(-1));

test("tool_executed：run_id/user_id/operation/result_rows/duration_ms 齐全，无内容字段", () => {
  const sink = fakeSink();
  const observability = AgentObservability.withSink(sink);
  observability.record(RUN, { kind: "tool_executed", user_id: "u-1", access_level: "operational", operation: "search_orders", status: "completed", result_rows: 2, duration_ms: 42 });

  const row = parse(sink);
  assert.equal(row.run_id, RUN);
  assert.equal(row.kind, "tool_executed");
  assert.equal(row.operation, "search_orders");
  assert.equal(row.result_rows, 2);
  assert.equal(row.duration_ms, 42);
  const allowed = new Set(["run_id", "kind", "user_id", "access_level", "operation", "status", "result_rows", "duration_ms", "error_code"]);
  for (const key of Object.keys(row)) assert.ok(allowed.has(key), `出现未登记字段 ${key}（观测事件不得夹带业务内容）`);
});

test("model_step：带 model/step/tool_calls/duration_ms，无任何文本字段", () => {
  const sink = fakeSink();
  const observability = AgentObservability.withSink(sink);
  observability.record(RUN, { kind: "model_step", user_id: "u-1", access_level: "full", model: "deepseek-chat", step: 1, duration_ms: 900, tool_calls: 1 });

  const row = parse(sink);
  assert.equal(row.model, "deepseek-chat");
  assert.equal(row.tool_calls, 1);
  assert.ok(!("prompt" in row) && !("answer" in row) && !("messages" in row));
});

test("run_completed / run_failed / run_cancelled：state 语义由 kind 表达，usage 可聚合", () => {
  const sink = fakeSink();
  const observability = AgentObservability.withSink(sink);
  observability.record(RUN, { kind: "run_completed", user_id: "u-1", access_level: "operational", model: "deepseek-chat", duration_ms: 3200, usage: { input_tokens: 120, output_tokens: 80, tool_calls: 2, answer_chunks: 5 } });
  observability.record(RUN, { kind: "run_failed", user_id: "u-1", access_level: "operational", error_code: "AGENT_MODEL_TIMEOUT", duration_ms: 60000 });
  observability.record(RUN, { kind: "run_cancelled", user_id: "u-1", access_level: "operational" });

  const kinds = sink.lines.map((line) => JSON.parse(line).kind);
  assert.deepEqual(kinds, ["run_completed", "run_failed", "run_cancelled"]);
  const completed = JSON.parse(sink.lines[0]);
  assert.equal(completed.usage.tool_calls, 2);
  assert.equal(JSON.parse(sink.lines[1]).error_code, "AGENT_MODEL_TIMEOUT");
});

test("gate_denied / run_created / run_replayed：不含问题内容", () => {
  const sink = fakeSink();
  const observability = AgentObservability.withSink(sink);
  observability.record(RUN, { kind: "run_created", user_id: "u-1", access_level: "operational" });
  observability.record(RUN, { kind: "run_replayed", user_id: "u-1" });
  observability.record(RUN, { kind: "gate_denied", user_id: "u-2", active_runs: 4 });

  assert.ok(!JSON.stringify(sink.lines).includes("question"), "观测事件类型里不存在 question 字段");
  assert.equal(JSON.parse(sink.lines[2]).active_runs, 4);
});
