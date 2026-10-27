// 执行步骤文案（lib/agent-tool-labels.ts）的单元测试。
//
// 关键一条：后端 tool-registry.ts 里的 32 个 operation 必须**全部**有中文标签。
// 后端新增能力而前端没补标签时，这里会红 —— 否则界面上会冒出 get_finished_goods_inbounds 这种英文。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  AGENT_OPERATION_LABELS,
  AGENT_TOOL_LABELS,
  normalizeToolStatus,
  toolErrorReason,
  toolOperationLabel,
  toolStepStatusLabel,
  toolStepSummary,
} from "./agent-tool-labels.ts";

function backendOperations() {
  const registry = fileURLToPath(new URL("../../api/src/modules/business-query-agent/tools/tool-registry.ts", import.meta.url));
  const source = readFileSync(registry, "utf8");
  return [...source.matchAll(/row\("([a-z_]+)",\s*"([a-z_]+)"/g)].map((match) => ({ tool: match[1], operation: match[2] }));
}

test("后端 32 项 operation 全部有中文标签，工具名也全部覆盖", () => {
  const operations = backendOperations();
  assert.equal(operations.length, 32, "后端 operation 数量变了：先确认是否新增了能力");
  assert.equal(AGENT_OPERATION_LABELS.search_documents, "单号检索", "三类单号的统一入口要叫「单号检索」，不能叫「销售订单」");

  const missing = operations.filter(({ operation }) => !AGENT_OPERATION_LABELS[operation]);
  assert.deepEqual(missing, [], `缺少中文标签的 operation：${missing.map((item) => item.operation).join("、")}`);

  const missingTools = [...new Set(operations.map((item) => item.tool))].filter((tool) => !AGENT_TOOL_LABELS[tool]);
  assert.deepEqual(missingTools, []);

  for (const { tool, operation } of operations) {
    const label = toolOperationLabel(tool, operation);
    assert.ok(label.length > 0);
    assert.equal(/[a-z_]{4,}/.test(label), false, `${operation} 的标签不应是英文标识：${label}`);
  }
});

test("认不出的名称不暴露英文：operation 用数据域兜底，工具也不认识时说「业务数据」", () => {
  assert.equal(toolOperationLabel("order_query", "search_orders"), "销售订单");
  assert.equal(toolOperationLabel("order_query", "brand_new_operation"), "订单");
  assert.equal(toolOperationLabel("unknown_tool", "brand_new_operation"), "业务数据");
});

test("状态归一：后端 running/completed/failed 映射到四态；未知状态算 pending", () => {
  assert.equal(normalizeToolStatus("running"), "running");
  assert.equal(normalizeToolStatus("completed"), "success");
  assert.equal(normalizeToolStatus("failed"), "error");
  assert.equal(normalizeToolStatus("queued"), "pending");
  assert.equal(toolStepStatusLabel("completed"), "已完成");
  assert.equal(toolStepStatusLabel("failed"), "失败");
});

test("步骤摘要：默认一行就看懂在查什么、成没成", () => {
  assert.equal(toolStepSummary("order_query", "search_orders", "running"), "正在查询销售订单");
  assert.equal(toolStepSummary("warehouse_query", "get_raw_material_balance", "completed"), "已查询原料库存");
  assert.equal(toolStepSummary("finance_query", "get_receivables", "failed"), "未能查询应收账款");
  assert.equal(toolStepSummary("order_query", "search_orders", "queued"), "等待查询销售订单");
});

test("失败原因翻成人话；认不出的错误码不把内部细节甩给业务用户", () => {
  assert.equal(toolErrorReason("AGENT_TOOL_FORBIDDEN"), "当前数据档位不包含这类查询");
  assert.equal(toolErrorReason("AGENT_OPERATION_NOT_IMPLEMENTED"), "该查询能力尚未开放");
  assert.equal(toolErrorReason(undefined), "查询没有完成");
  assert.equal(toolErrorReason("SOME_INTERNAL_STACK_CODE"), "查询没有完成");
  assert.equal(toolErrorReason("AGENT_INTERNAL_ERROR").includes("AGENT"), false);
});
