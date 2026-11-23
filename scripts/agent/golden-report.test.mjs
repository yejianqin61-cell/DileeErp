import { test } from "node:test";
import assert from "node:assert/strict";

import { renderMarkdown, summarize } from "./golden-report.mjs";

const row = (id, group, verdict, extra = {}) => ({ id, group, verdict, reasons: [], failureCodes: [], ...extra });

test("通过率分母排除基线缺失", () => {
  const summary = summarize([
    row("a", "entry", "pass"),
    row("b", "entry", "pass"),
    row("c", "entry", "pass"),
    row("d", "miss", "fail"),
    row("e", "miss", "baseline_missing"),
  ]);
  assert.equal(summary.total, 5);
  assert.equal(summary.pass, 3);
  assert.equal(summary.fail, 1);
  assert.equal(summary.baselineMissing, 1);
  assert.equal(summary.passRate, 0.75);
});

test("单组全通过时该组通过率为 1", () => {
  const summary = summarize([row("a", "entry", "pass"), row("b", "entry", "pass")]);
  assert.equal(summary.byGroup[0].passRate, 1);
});

test("单组全为基线缺失时该组通过率为 null", () => {
  const summary = summarize([row("a", "miss", "baseline_missing"), row("b", "miss", "baseline_missing")]);
  assert.equal(summary.byGroup[0].passRate, null);
});

test("失败码按次数降序、同次数按字典序", () => {
  const summary = summarize([
    row("a", "entry", "fail", { failureCodes: ["ORDER_NOT_FOUND", "AGENT_TOOL_UNKNOWN"] }),
    row("b", "entry", "fail", { failureCodes: ["AGENT_TOOL_UNKNOWN", "AGENT_TOOL_UNKNOWN"] }),
  ]);
  assert.equal(summary.failureCodes[0].code, "AGENT_TOOL_UNKNOWN");
  assert.equal(summary.failureCodes[0].count, 3);
  assert.equal(summary.failureCodes[1].code, "ORDER_NOT_FOUND");
});

test("同一输入渲染两次逐字相同", () => {
  const summary = summarize([
    row("a", "entry", "pass"),
    row("b", "entry", "fail", { reasons: ["终态期望 completed，实际 failed"], failureCodes: ["ORDER_NOT_FOUND"] }),
  ]);
  const meta = { runAt: "2026-11-22T15:00:00Z", apiBase: "http://127.0.0.1:3111/api/v1", model: "deepseek-chat", baselineNote: "MOCK 种子数据" };
  assert.equal(renderMarkdown(summary, meta), renderMarkdown(summary, meta));
});

test("未通过清单包含用例 id 与原因", () => {
  const summary = summarize([row("entry-sales-exact", "entry", "fail", { reasons: ["来源缺少 MOCK-ORD-001"] })]);
  const text = renderMarkdown(summary, {});
  assert.match(text, /entry-sales-exact/);
  assert.match(text, /来源缺少 MOCK-ORD-001/);
});

test("全部通过时渲染出「全部通过」", () => {
  const summary = summarize([row("a", "entry", "pass")]);
  assert.match(renderMarkdown(summary, {}), /全部通过/);
});

test("报告含数据基线、未覆盖、附录三节", () => {
  const text = renderMarkdown(summarize([row("a", "entry", "pass")]), {});
  assert.match(text, /## 5\. 数据基线/);
  assert.match(text, /## 6\. 未覆盖/);
  assert.match(text, /## 7\. 附录/);
});

test("过程失败率：出现过失败码的用例占全量，自纠单独计数", () => {
  const summary = summarize([
    row("a", "entry", "pass", { failureCodes: ["ORDER_REF_INVALID"] }),
    row("b", "entry", "pass"),
    row("c", "entry", "pass", { failureCodes: ["AGENT_TOOL_ARGUMENT_INVALID"] }),
    row("d", "entry", "baseline_missing"),
  ]);
  assert.equal(summary.processSignal.casesWithFailureCodes, 2);
  assert.equal(summary.processSignal.selfHealedCases, 2);
  assert.equal(summary.processSignal.toolCallFailureRate, 0.5);
  assert.deepEqual(summary.processSignal.selfHealedCaseIds, ["a", "c"]);
});

test("过程出现失败码但终局 fail 时不算自纠", () => {
  const summary = summarize([row("a", "entry", "fail", { failureCodes: ["ORDER_NOT_FOUND"] })]);
  assert.equal(summary.processSignal.casesWithFailureCodes, 1);
  assert.equal(summary.processSignal.selfHealedCases, 0);
});

test("渲染出 3.1 小节并同时报出过程失败率与自纠数", () => {
  const text = renderMarkdown(summarize([row("a", "entry", "pass", { failureCodes: ["ORDER_REF_INVALID"] })]), {});
  assert.match(text, /### 3\.1 工具调用失败率/);
  assert.match(text, /1 \/ 1 条用例（100\.0%）/);
});

test("meta.analysis 非空时渲染第 8 节，空或空白时不出该节", () => {
  const summary = summarize([row("a", "entry", "pass")]);
  assert.match(renderMarkdown(summary, { analysis: "**根因**：工具面缺口。" }), /## 8\. 缺陷分析/);
  assert.doesNotMatch(renderMarkdown(summary, {}), /## 8\. 缺陷分析/);
  assert.doesNotMatch(renderMarkdown(summary, { analysis: "   \n" }), /## 8\. 缺陷分析/);
});

test("meta.comparison 非空时渲染第 9 节，含两列与变化", () => {
  const summary = summarize([row("a", "entry", "pass", { failureCodes: ["X"] })]);
  const text = renderMarkdown(summary, {
    comparison: { label: "P0 基线", before: { total: 61, passRate: 1, toolCallFailureRate: 0.115, failureCodeCount: 7 } },
  });
  assert.match(text, /## 9\. P0 → P1 对比/);
  assert.match(text, /工具调用失败率/);
  assert.match(text, /11\.5%/);
  assert.doesNotMatch(renderMarkdown(summary, {}), /## 9\./);
});

test("对比节列出上一轮未解项的对账", () => {
  const summary = summarize([row("a", "entry", "pass")]);
  const text = renderMarkdown(summary, {
    comparison: { label: "P0", before: {}, unresolved: [{ item: "列表无入口", status: "已修" }] },
  });
  assert.match(text, /### 9\.1 上一轮未解项的对账/);
  assert.match(text, /列表无入口/);
});

test("模型步数中位数：奇数个取中间，全缺时为 null", () => {
  const withSteps = summarize([
    row("a", "entry", "pass", { modelSteps: 1 }),
    row("b", "entry", "pass", { modelSteps: 3 }),
    row("c", "entry", "pass", { modelSteps: 2 }),
  ]);
  assert.equal(withSteps.medianModelSteps, 2);
  assert.equal(summarize([row("a", "entry", "pass")]).medianModelSteps, null);
});