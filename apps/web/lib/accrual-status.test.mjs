// 挂账状态标签的守卫（2026-11-09 R3-13）：
//   - 四个取值各有固定中文，界面词只从这里出；
//   - 缺失/历史响应按 none（未挂账）处理，永远不渲染 undefined；
//   - 只有 reversed 才算「需要处理」的异常状态（决定行内是否给「按来源重算」）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCRUAL_STATUS_LABELS, accrualStatusLabel, accrualStatusOf, isAccrualReversed } from "./accrual-status.ts";

test("四态 → 中文：posted=已挂账 / draft=草稿挂账 / reversed=挂账已红冲 / none=未挂账", () => {
  assert.equal(accrualStatusLabel("posted"), "已挂账");
  assert.equal(accrualStatusLabel("draft"), "草稿挂账");
  assert.equal(accrualStatusLabel("reversed"), "挂账已红冲");
  assert.equal(accrualStatusLabel("none"), "未挂账");
  assert.deepEqual(Object.keys(ACCRUAL_STATUS_LABELS).sort(), ["draft", "none", "posted", "reversed"]);
});

test("旧响应没有 accrual_status / 值为 null 或无法识别 → 按 none（未挂账）处理", () => {
  for (const value of [undefined, null, "", "unknown", "POSTED"]) {
    assert.equal(accrualStatusOf(value), "none");
    assert.equal(accrualStatusLabel(value), "未挂账");
  }
});

test("只有 reversed 是警示状态（行内给「按来源重算」的门槛）", () => {
  assert.equal(isAccrualReversed("reversed"), true);
  for (const value of ["posted", "draft", "none", undefined, null, "unknown"]) assert.equal(isAccrualReversed(value), false);
});
