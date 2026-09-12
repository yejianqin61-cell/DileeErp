// 完成率展示口径：比率 → 百分数（保留 1 位小数）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { formatCompletionRate } from "./format-rate.ts";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (...parts) => readFileSync(join(webRoot, ...parts), "utf8");

test("比率转百分数并保留 1 位小数", () => {
  assert.equal(formatCompletionRate("0.857"), "85.7%");
  assert.equal(formatCompletionRate(1), "100.0%");
  assert.equal(formatCompletionRate("1.0030303030303030303"), "100.3%", "接口返回的长小数必须先四舍五入到 1 位小数");
  assert.equal(formatCompletionRate("0.6666666666666666"), "66.7%");
  assert.equal(formatCompletionRate("0"), "0.0%");
  assert.equal(formatCompletionRate("1.25"), "125.0%");
});

test("空值与非数字显示为 -（避免出现 NaN%）", () => {
  assert.equal(formatCompletionRate(null), "-");
  assert.equal(formatCompletionRate(undefined), "-");
  assert.equal(formatCompletionRate(""), "-");
  assert.equal(formatCompletionRate("not-a-number"), "-");
  assert.equal(formatCompletionRate(Number.NaN), "-");
  assert.equal(formatCompletionRate(Number.POSITIVE_INFINITY), "-");
  assert.equal(formatCompletionRate(null, "—"), "—", "允许调用方自定义占位符");
});

test("结果始终是 1 位小数 + % 后缀", () => {
  for (const value of ["0", "0.004", "0.005", "0.9949", "2", "10"]) {
    assert.match(formatCompletionRate(value), /^\d+(\.\d)?%$/, `${value} 的展示必须是 1 位小数百分数`);
  }
});

test("工序完成率的展示位置都必须走统一格式化（不能再直接渲染比率原值）", () => {
  const detail = read("components", "production", "production-order-detail-page.tsx");
  const workbench = read("app", "workbench.tsx");
  assert.match(detail, /formatCompletionRate\(row\.completion_rate\)/, "生产单详情的完成率列必须格式化");
  assert.equal(/\{row\.completion_rate \?\? "-"\}/.test(detail), false, "不得再直接渲染比率原值");
  assert.match(workbench, /accessor\("completion_rate", \{ header: "完成率", cell: \(info\) => formatCompletionRate\(info\.getValue\(\)\) \}\)/, "工作台生产计量表要有格式化后的完成率列");
});
