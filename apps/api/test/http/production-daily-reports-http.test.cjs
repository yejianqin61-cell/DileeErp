const assert = require("node:assert/strict");
const { test } = require("node:test");
const { apiClient } = require("../../../../tests/helpers/api-client.cjs");

const baseUrl = process.env.API_BASE_URL;

test("d5.daily-report-routes.reject_anonymous_requests_with_standard_envelope", async () => {
  const client = apiClient(baseUrl);
  for (const path of ["/api/v1/production/operation-reports", "/api/v1/production/employee-reports", "/api/v1/production/daily-alerts", "/api/v1/production/payroll-sources"]) {
    const response = await client.request(path);
    assert.equal(response.status, 401);
    assert.equal(typeof response.body.error.code, "string");
    assert.ok(response.requestId);
  }
});

test("d5.daily-report-write-routes_reject_anonymous_mutations", async () => {
  const client = apiClient(baseUrl);
  for (const [path, body] of [["/api/v1/production/operation-reports", {}], ["/api/v1/production/employee-reports", {}], ["/api/v1/production/daily-alerts/not-a-uuid/confirm", { remark: "x" }]]) {
    const response = await client.request(path, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 401);
    assert.ok(response.body.error);
  }
});
