const test = require("node:test");
const assert = require("node:assert/strict");
const { Prisma } = require("@prisma/client");
const {
  productionSourceAmount,
  payrollBaseAmount,
  payrollBasicSalaryAmount,
  payrollOtherAdjustmentAmount,
  payrollPayableAmount,
  allocationRemaining,
  paymentRemaining,
  payrollStatus,
  canReopenPayroll,
  monthRange,
} = require("../../dist/modules/hr/hr-payroll.domain.js");

/** 13 个类目金额的全量夹具：默认 0，只改关心的那几项。 */
function categories(overrides = {}) {
  const zero = "0";
  return {
    base_salary: zero,
    production_source_amount: zero,
    overtime_amount: zero,
    attendance_deduction: zero,
    late_deduction: zero,
    absence_deduction: zero,
    early_leave_deduction: zero,
    performance_amount: zero,
    allowance_amount: zero,
    housing_allowance: zero,
    social_insurance: zero,
    individual_tax: zero,
    other_adjustment: zero,
    ...overrides,
  };
}

test("F1 attendance and performance remain outside automatic payroll calculation", () => {
  assert.equal(payrollBaseAmount(categories({ base_salary: "1000", production_source_amount: "200" })).toString(), "1200");
});

// 2026-09-15 新增类目：房补加钱，迟到/旷工/早退三种扣款各自扣钱。
// 这条用例同时是「三个扣款不能只改一个」的回归网：曾经应发公式散落在五个文件里。
test("房补与迟到/旷工/早退扣款都参与应发，且各自独立", () => {
  const fields = categories({
    base_salary: "5000",
    production_source_amount: "1200",
    performance_amount: "300",
    housing_allowance: "400",
    late_deduction: "50",
    absence_deduction: "200",
    early_leave_deduction: "30",
  });
  assert.equal(payrollBaseAmount(fields).toString(), "6620");
  // 逐个验证：少扣任何一项都会让结果偏大，说明这一项确实进了公式。
  assert.equal(payrollBaseAmount({ ...fields, late_deduction: "0" }).toString(), "6670");
  assert.equal(payrollBaseAmount({ ...fields, absence_deduction: "0" }).toString(), "6820");
  assert.equal(payrollBaseAmount({ ...fields, early_leave_deduction: "0" }).toString(), "6650");
  assert.equal(payrollBaseAmount({ ...fields, housing_allowance: "0" }).toString(), "6220");
});

test("老类目（加班/考勤扣款/补贴/社保/个税/其他调整）仍然参与应发，不被新类目挤掉", () => {
  const fields = categories({ base_salary: "1000", overtime_amount: "100", attendance_deduction: "50", allowance_amount: "200", social_insurance: "300", individual_tax: "80", other_adjustment: "10" });
  assert.equal(payrollBaseAmount(fields).toString(), "880");
});

test("「基本工资」格 = 基本工资 + 生产来源（车间的生产工资就落在这里）", () => {
  assert.equal(payrollBasicSalaryAmount({ base_salary: "0", production_source_amount: "1234.5" }).toString(), "1234.5");
  assert.equal(payrollBasicSalaryAmount({ base_salary: "5000", production_source_amount: "0" }).toString(), "5000");
});

test("「其他增减」格 = 老类目净额，保证 应发 = 六个可编辑类目 + 其他增减", () => {
  const fields = categories({ base_salary: "5000", production_source_amount: "1200", performance_amount: "300", housing_allowance: "400", late_deduction: "50", absence_deduction: "200", early_leave_deduction: "30", overtime_amount: "100", attendance_deduction: "20", allowance_amount: "200", social_insurance: "300", individual_tax: "80", other_adjustment: "10" });
  const editable = new Prisma.Decimal("5000").plus("1200").plus("300").plus("400").minus("50").minus("200").minus("30");
  assert.equal(payrollOtherAdjustmentAmount(fields).toString(), "-90");
  assert.equal(editable.plus(payrollOtherAdjustmentAmount(fields)).toString(), payrollBaseAmount(fields).toString(), "表上可见列之和必须等于应发，否则就是有金额藏在表外");
});

test("金额字段接受 Prisma.Decimal 与字符串混合（列表行与 DTO 两种来源）", () => {
  assert.equal(payrollBaseAmount(categories({ base_salary: new Prisma.Decimal("10.5"), housing_allowance: "0.25" })).toString(), "10.75");
});

test("F2 aggregates D5 sources and does not use time-report quantity as pay", () => {
  assert.equal(productionSourceAmount([
    { wage_mode: "piece", quantity: "10", duration_minutes: "0", amount: "35.50" },
    { wage_mode: "time", quantity: "999", duration_minutes: "60", amount: "20" },
  ]), "55.5");
});

test("F2 applies independent payroll adjustments with exact decimals", () => {
  assert.equal(payrollPayableAmount("100.125", [{ effect: "increase", amount: "10.25" }, { effect: "decrease", amount: "2.375" }]), "108");
});

test("F3 blocks ledger and payment over-allocation", () => {
  assert.equal(allocationRemaining("100", "20", "30"), "50");
  assert.equal(paymentRemaining("100", "20", "30"), "50");
  assert.throws(() => allocationRemaining("100", "90", "11"), /ledger balance/);
  assert.throws(() => paymentRemaining("100", "90", "11"), /payment balance/);
});

test("F3 derives payment status and recalculates the balance after a reversal", () => {
  assert.equal(payrollStatus("100", "0"), "confirmed");
  assert.equal(payrollStatus("100", "40"), "partially_paid");
  assert.equal(payrollStatus("100", "100"), "paid");
  assert.equal(allocationRemaining("100", "0", "40"), "60");
});

test("F4 only confirmed or expired payroll ledgers can return to draft", () => {
  assert.equal(canReopenPayroll("confirmed"), true);
  assert.equal(canReopenPayroll("expired"), true);
  assert.equal(canReopenPayroll("partially_paid"), false);
  assert.equal(canReopenPayroll("paid"), false);
  assert.equal(canReopenPayroll("closed"), false);
});

// 工资台账与工资付款都要按月筛，月份解析只留一份实现（两处各写一遍就会出现 1..30 / 1..31 的安静错位）。
test("月份区间含首尾日，非法月份 422", () => {
  const range = monthRange("2026-02");
  assert.equal(range.from.toISOString(), "2026-02-01T00:00:00.000Z");
  assert.equal(range.to.toISOString(), "2026-02-28T00:00:00.000Z", "2026-02 只有 28 天");
  assert.equal(monthRange("2026-09").to.toISOString(), "2026-09-30T00:00:00.000Z");
  for (const bad of ["2026/09", "2026-9", "2026-13", "", "202609"]) {
    assert.throws(() => monthRange(bad), (error) => error.getResponse().code === "INVALID_MONTH", `月份「${bad}」必须被拒绝`);
  }
});
