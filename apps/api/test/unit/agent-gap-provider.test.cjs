const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MockLanguageModelV4 } = require("ai/test");
const { DeepSeekLlmProvider } = require("../../dist/modules/business-query-agent/deepseek-llm-provider.js");
const { buildSystemPrompt, buildBaseSystemPrompt } = require("../../dist/modules/business-query-agent/tools/system-prompt.js");

const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const SIGNAL = new AbortController().signal;
const TOOLS = ["order_query", "procurement_query"];

async function planWith(content) {
  const model = new MockLanguageModelV4({ doGenerate: { content, finishReason: { unified: content.length ? "tool-calls" : "stop", raw: "x" }, usage: USAGE } });
  const plan = await new DeepSeekLlmProvider({ apiKey: "test-key", timeoutMs: 0, modelOverride: model }).plan([{ role: "user", content: "问" }], TOOLS, SIGNAL);
  return { plan, declared: model.doGenerateCalls[0].tools };
}

test("声明 report_gap，位于领域工具之后、目录工具之前，没有 operation 参数", async () => {
  const { declared } = await planWith([]);
  assert.deepEqual(declared.map((tool) => tool.name), ["order_query", "procurement_query", "report_gap", "catalog_query"]);
  const gap = declared[2].inputSchema;
  assert.deepEqual(gap.required, ["nearest_operation", "missing", "missing_detail"]);
  assert.equal("operation" in gap.properties, false);
  assert.deepEqual(gap.properties.missing.enum, ["group_by", "filter", "metric", "time_series", "object"]);
  assert.deepEqual(gap.properties.missing_param.enum, ["q", "status", "customer_q", "product_q", "from", "to"]);
});

test("最近邻枚举只含所传工具的 operation，描述写明判据与字段格式", async () => {
  const gap = (await planWith([])).declared[2];
  const operations = gap.inputSchema.properties.nearest_operation.enum;
  assert.equal(operations.length, 13);
  assert.ok(operations.includes("list_overdue_arrivals"));
  assert.equal(operations.includes("get_receivables"), false);
  assert.ok(gap.description.includes("查到 0 行，都不是缺口"));
  assert.ok(gap.description.includes("SalesOrder.orderNo"));
});

test("plan：report_gap 调用的 operation 固定为 declare_gap，args 原样", async () => {
  const input = { nearest_operation: "list_documents", missing: "group_by", missing_detail: "按客户计数" };
  const { plan } = await planWith([{ type: "tool-call", toolCallId: "g1", toolName: "report_gap", input: JSON.stringify(input) }]);
  assert.deepEqual(plan.toolCalls, [{ id: "g1", tool: "report_gap", operation: "declare_gap", args: input }]);
});

test("系统指令在原内容后追加两段缺口提示", () => {
  const full = buildSystemPrompt("full");
  const base = buildBaseSystemPrompt("full");
  assert.ok(full.startsWith(`${base}\n\n`));
  for (const sentence of ["调用 report_gap 说明缺口", "先在上面的模块里找最接近用户问题的 operation"]) {
    assert.ok(full.includes(sentence), sentence);
    assert.equal(base.includes(sentence), false, sentence);
  }
});

test("普通档位系统指令说清没有权限，财务档位没有这一段", () => {
  const hint = "当前账号没有财务权限";
  const operational = buildSystemPrompt("operational");
  assert.ok(operational.includes(hint));
  assert.ok(operational.includes("不要调用 report_gap"));
  assert.equal(buildSystemPrompt("full").includes(hint), false);
  assert.equal(operational.includes("get_payables"), false);
});
