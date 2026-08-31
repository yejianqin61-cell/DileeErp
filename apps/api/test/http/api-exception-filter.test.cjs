const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ApiExceptionFilter } = require("../../dist/platform/http/api-exception.filter.js");

test("unique constraint errors identify the conflicting business field", () => {
  const filter = new ApiExceptionFilter();
  const response = { statusCode: 0, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
  filter.catch({ code: "P2002", meta: { target: ["idempotency_key"] } }, { switchToHttp: () => ({ getRequest: () => ({ method: "POST", url: "/production/employee-reports", header: () => "req-1" }), getResponse: () => response }) });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error.code, "UNIQUE_VALUE_CONFLICT");
  assert.match(response.body.error.message, /工序员工日报/);
  assert.equal(response.body.error.details[0].field, "idempotency_key");
});

test("composite production alert conflicts use a business label", () => {
  const filter = new ApiExceptionFilter();
  const response = { statusCode: 0, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
  filter.catch({ code: "P2002", meta: { target: ["production_order_operation_id", "report_date", "alert_type"] } }, { switchToHttp: () => ({ getRequest: () => ({ method: "POST", url: "/production/employee-reports", header: () => "req-2" }), getResponse: () => response }) });
  assert.match(response.body.error.message, /工序与日期组合/);
});
