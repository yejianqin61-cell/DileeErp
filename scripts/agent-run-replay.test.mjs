// run 回放脚本的纯函数测试：只校验输出格式，不连数据库。
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeRunEvents } from "./agent-run-replay.mjs";

const event = (seq, type, payload) => ({ seq, type, payload });

test("按 seq 升序输出，入参与完成各一行", () => {
  const lines = summarizeRunEvents([
    event(1, "tool_args", { operation: "search_orders", args: { q: "DL260" } }),
    event(2, "tool_status", { operation: "search_orders", status: "completed" }),
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^#1 tool_args search_orders/);
  assert.match(lines[1], /^#2 tool_status search_orders completed/);
});

test("没有入参事件时降级提示，而不是报错", () => {
  const lines = summarizeRunEvents([event(1, "tool_status", { operation: "search_orders", status: "completed" })]);
  assert.ok(lines[0].includes("没有入参记录"));
});

test("入参里的 q 与 order_no 都打印在同一行", () => {
  const lines = summarizeRunEvents([event(3, "tool_args", { operation: "get_purchase_orders", args: { order_no: "DL260170-4H 伞头", q: "DL260", page: 2 } })]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("order_no=DL260170-4H 伞头"));
  assert.ok(lines[0].includes("q=DL260"));
  assert.ok(!lines[0].includes("\n"));
});

test("payload 缺字段时用占位符，不抛错", () => {
  const lines = summarizeRunEvents([event(1, "tool_args", {}), event(2, undefined, undefined)]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("tool_args"));
  assert.ok(lines[1].startsWith("#2"));
});
