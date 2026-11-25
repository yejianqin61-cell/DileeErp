import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { buildGroup } from "./groups.mjs";

const require = createRequire(import.meta.url);
const { buildSystemPrompt } = require("../../../apps/api/dist/modules/business-query-agent/tools/system-prompt.js");

const GAP_HINT = "如果现有工具确实答不了用户的问题，调用 report_gap 说明缺口，然后告诉用户目前无法回答；能答的就直接查。";
const RULE = "只在确认现有工具都答不了用户的问题时调用；换个问法就能答、或查到 0 行，都不是缺口。";
const NEAREST_HINT = "先在上面的模块里找最接近用户问题的 operation";
const AXIS_TITLE = "可用查询模块的轴声明：";
const MODULES = ["order_query", "sales_query", "procurement_query", "production_query", "warehouse_query", "finance_query"];

test("三组系统指令共用底座与 GAP_HINT，只有各自的追加段不同", () => {
  const systems = ["A", "B", "C"].map((name) => buildGroup(name).system);
  for (const system of systems) {
    assert.ok(system.startsWith(`${buildSystemPrompt("full")}\n\n${GAP_HINT}`));
  }
  assert.deepEqual(systems.map((system) => system.includes(NEAREST_HINT)), [false, false, true]);
  assert.deepEqual(systems.map((system) => system.includes(AXIS_TITLE)), [false, true, false]);
});

test("三组 report_gap 描述以判据句开头，各接一句", () => {
  const [a, b, c] = ["A", "B", "C"].map((name) => buildGroup(name).gapTool.description);
  for (const description of [a, b, c]) assert.ok(description.startsWith(RULE));
  assert.ok(a.endsWith("说明原因。"));
  assert.match(b, /四轴/);
  assert.match(c, /最接近/);
});

test("三组 report_gap 参数", () => {
  const properties = (name) => buildGroup(name).gapTool.inputSchema.properties;
  assert.deepEqual(Object.keys(properties("A")), ["reason"]);
  assert.deepEqual(Object.keys(properties("B")), ["object", "metric", "granularity", "time_basis"]);
  assert.deepEqual(Object.keys(properties("C")), ["nearest_operation", "missing", "missing_detail", "needed_fields"]);
  assert.equal(properties("C").nearest_operation.enum.length, 35);
  assert.deepEqual(properties("C").missing.enum, ["group_by", "filter", "metric", "time_series", "object"]);
  assert.deepEqual(buildGroup("C").gapTool.inputSchema.required, ["nearest_operation", "missing", "missing_detail"]);
});

test("假 report_gap 只记录，按序保存并固定返回已记录", () => {
  const records = [];
  const group = buildGroup("C", records);
  assert.equal(group.record({ missing: "group_by" }), "已记录");
  assert.equal(group.record({ missing: "object" }), "已记录");
  assert.deepEqual(records, [{ missing: "group_by" }, { missing: "object" }]);
});

test("B 组含六行轴声明与轴枚举", () => {
  const group = buildGroup("B");
  const lines = group.system.split(`${AXIS_TITLE}\n`)[1].split("\n");
  assert.deepEqual(lines.map((line) => line.split(" ")[0]), MODULES);
  assert.ok(lines[4].includes("不支持：金额、趋势、按仓库"));
  assert.equal(group.gapTool.inputSchema.properties.object.enum.length, 6);
  assert.equal(group.gapTool.inputSchema.properties.granularity.enum.length, 4);
});

test("未知组名直接抛错", () => {
  assert.throws(() => buildGroup("D"), /未知实验组/);
});
