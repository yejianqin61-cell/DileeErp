const test = require("node:test");
const assert = require("node:assert/strict");
const { productionSourceAmount, payrollBaseAmount, payrollPayableAmount, allocationRemaining, paymentRemaining, payrollStatus, canReopenPayroll } = require("../../dist/modules/hr/hr-payroll.domain.js");

test("F1 attendance and performance remain outside automatic payroll calculation", () => {
  assert.equal(payrollBaseAmount({ base_salary: "1000", production_source_amount: "200", overtime_amount: "0", attendance_deduction: "0", performance_amount: "0", allowance_amount: "0", social_insurance: "0", individual_tax: "0", other_adjustment: "0" }), "1200");
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
