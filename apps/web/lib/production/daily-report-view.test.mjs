// 工序员工日报查看契约测试（apps/web/lib/production/daily-report-view.ts）。
// 运行：npm run test:unit --workspace=@dilee/web （Node >= 22.18 直接以 type stripping 加载 .ts）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeEmployeeDateTotals,
  employeeDateTotalKey,
  resolveBatchReportDate,
  resolveEntryDate,
  selectVisibleReports,
  viewDateLabel,
} from "./daily-report-view.ts";

const row = (overrides = {}) => ({
  employeeId: "emp-1",
  reportDate: "2026-02-03",
  calculatedAmount: "100",
  productionOrderOperation: { id: "op-1" },
  ...overrides,
});

test("selectVisibleReports: 未选查看日期时展示当前工序所有日期、所有员工的每日条目", () => {
  const reports = [
    row({ reportDate: "2026-02-03", employeeId: "emp-1" }),
    row({ reportDate: "2026-02-04", employeeId: "emp-2" }),
    row({ reportDate: "2026-02-05", employeeId: "emp-1" }),
    row({ reportDate: "2026-02-03", productionOrderOperation: { id: "op-2" } }),
  ];
  const visible = selectVisibleReports(reports, "op-1", "");
  assert.equal(visible.length, 3, "其它工序的条目不应出现，本工序所有日期都应出现");
  assert.deepEqual([...new Set(visible.map((item) => item.reportDate.slice(0, 10)))].sort(), ["2026-02-03", "2026-02-04", "2026-02-05"]);
  assert.deepEqual([...new Set(visible.map((item) => item.employeeId))].sort(), ["emp-1", "emp-2"]);
});

test("selectVisibleReports: 选择日期后才按日期过滤（回归保护）", () => {
  const reports = [
    row({ reportDate: "2026-02-03T08:00:00.000Z" }),
    row({ reportDate: "2026-02-04T08:00:00.000Z" }),
    row({ reportDate: "2026-02-03T08:00:00.000Z", productionOrderOperation: { id: "op-2" } }),
  ];
  const visible = selectVisibleReports(reports, "op-1", "2026-02-03");
  assert.equal(visible.length, 1);
  assert.equal(visible[0].reportDate.slice(0, 10), "2026-02-03");
  assert.equal(visible[0].productionOrderOperation.id, "op-1");
  // 未打开工序对话框（operationId 为空）时没有任何可见条目，与历史行为一致。
  assert.equal(selectVisibleReports(reports, null, "").length, 0);
  assert.equal(selectVisibleReports(reports, null, "2026-02-03").length, 0);
});

test("computeEmployeeDateTotals: 按 员工+日期 聚合，跨工序合计", () => {
  const reports = [
    row({ employeeId: "emp-1", reportDate: "2026-02-03", calculatedAmount: "100" }),
    row({ employeeId: "emp-1", reportDate: "2026-02-03", calculatedAmount: "40.5", productionOrderOperation: { id: "op-2" } }),
    row({ employeeId: "emp-1", reportDate: "2026-02-04", calculatedAmount: "7" }),
    row({ employeeId: "emp-2", reportDate: "2026-02-03", calculatedAmount: "9" }),
  ];
  const totals = computeEmployeeDateTotals(reports);
  assert.equal(totals.size, 3);
  assert.equal(totals.get(employeeDateTotalKey("emp-1", "2026-02-03")), 140.5);
  assert.equal(totals.get(employeeDateTotalKey("emp-1", "2026-02-04")), 7);
  assert.equal(totals.get(employeeDateTotalKey("emp-2", "2026-02-03")), 9);
});

test("选中日期时行内“当日该员工总薪资”与历史口径一致（回归保护）", () => {
  // 历史行为：选中 2026-02-03 时，总计 = 该员工当日所有工序（不限于当前工序）的合计。
  // 新实现按行的自身日期取键；过滤态下可见行日期都等于查看日期，两者必须相等。
  const reports = [
    row({ employeeId: "emp-1", reportDate: "2026-02-03", calculatedAmount: "100" }),
    row({ employeeId: "emp-1", reportDate: "2026-02-03", calculatedAmount: "40.5", productionOrderOperation: { id: "op-2" } }),
    row({ employeeId: "emp-1", reportDate: "2026-02-04", calculatedAmount: "7" }),
  ];
  const totals = computeEmployeeDateTotals(reports);
  const legacySelectedDateTotal = reports
    .filter((item) => item.reportDate.slice(0, 10) === "2026-02-03" && item.employeeId === "emp-1")
    .reduce((sum, item) => sum + Number(item.calculatedAmount), 0);
  assert.equal(totals.get(employeeDateTotalKey("emp-1", "2026-02-03")), legacySelectedDateTotal);
  // 未选日期（全日期视图）：每行取该行自身日期的合计。
  assert.equal(totals.get(employeeDateTotalKey("emp-1", "2026-02-04")), 7);
});

test("resolveEntryDate: 新草稿默认当天，选择查看日期后用查看日期", () => {
  assert.equal(resolveEntryDate("", "2026-02-03"), "2026-02-03");
  assert.equal(resolveEntryDate("2026-02-05", "2026-02-03"), "2026-02-05");
});

test("resolveBatchReportDate: 查看日期优先，其次草稿行日期，最后当天", () => {
  assert.equal(resolveBatchReportDate("2026-02-05", ["2026-02-03"], "2026-02-03"), "2026-02-05");
  assert.equal(resolveBatchReportDate("", ["2026-02-03", "2026-02-04"], "2026-02-01"), "2026-02-03");
  assert.equal(resolveBatchReportDate("", [], "2026-02-01"), "2026-02-01");
  assert.equal(resolveBatchReportDate("", [""], "2026-02-01"), "2026-02-01");
});

test("viewDateLabel: 未选日期展示“全部日期”", () => {
  assert.equal(viewDateLabel(""), "全部日期");
  assert.equal(viewDateLabel("2026-02-03"), "2026-02-03");
});
