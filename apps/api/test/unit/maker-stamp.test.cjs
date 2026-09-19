// 导出文件表尾落款（apps/api/src/platform/audit/maker-stamp.ts）。
//
// 为什么单独一组：财务（8 张报表）与人事（工资付款表）两个导出都落这一行，
// **措辞必须一致**——各写一遍迟早出现「制表人」和「导出人」两种叫法，读文件的人会当成两回事。
// 另外报表类导出是期间聚合口径，一行给不出操作人，所以这类文件回答的是
// 「这份文件是谁、什么时候生成的」，而不是每行的操作人。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { makerStamp } = require("../../dist/platform/audit/maker-stamp.js");
const { buildPayrollPaymentSheetTable } = require("../../dist/modules/hr/payroll-payment-sheet.js");

test("落款包含姓名、北京时间到秒与明确的时区说明", () => {
  const stamp = makerStamp({ id: "u-1", username: "caiwu", display_name: "财务小李" }, new Date("2026-09-16T06:30:05.000Z"));
  // 2026-09-16T06:30:05Z → 北京时间 14:30:05
  assert.equal(stamp, "制表人：财务小李；制表时间：2026-09-16 14:30:05（北京时间）");
});

test("取不到姓名时留空，绝不回落成 id / username", () => {
  const stamp = makerStamp({ id: "user-1", username: "caiwu" }, new Date("2026-09-16T06:30:05.000Z"));
  assert.match(stamp, /^制表人：；制表时间：/);
  assert.equal(stamp.includes("user-1"), false);
  assert.equal(stamp.includes("caiwu"), false);
});

test("没有当前用户（或字段缺失）也不抛错：导出不能因为落款失败", () => {
  for (const actor of [null, undefined, {}]) {
    assert.match(makerStamp(actor, new Date("2026-09-16T06:30:05.000Z")), /^制表人：；制表时间：2026-09-16 14:30:05（北京时间）$/);
  }
});

test("工资付款表把落款放在表尾最后一行（列序是用户固定要求，不往表里插列）", () => {
  const stamp = makerStamp({ display_name: "人事小王" }, new Date("2026-09-16T06:30:05.000Z"));
  const table = buildPayrollPaymentSheetTable([], { footnotes: [stamp] });

  assert.equal(table.footnotes[table.footnotes.length - 1], stamp, "落款必须是最后一条");
  assert.ok(table.footnotes.some((note) => note.includes("不是银行对账单")), "原有的口径说明不能被落款顶掉");
  // 列定义不受影响（用户明确要求固定列名列序）
  assert.equal(table.columns.some((column) => ["创建人", "最后修改人", "制表人"].includes(column.header)), false);
});
