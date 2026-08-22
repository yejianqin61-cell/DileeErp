const assert = require("node:assert/strict");
const { test } = require("node:test");
const { apiClient } = require("../../../../tests/helpers/api-client.cjs");

test("d7.progress-routes.reject_anonymous_requests_with_standard_envelope", async () => {
  const client = apiClient(process.env.API_BASE_URL);
  for (const path of ["/api/v1/production-progress/measurements", "/api/v1/production-progress/order-statuses", "/api/v1/production-progress/order-statuses/unknown/timeline", "/api/v1/production-progress/rebuild"]) {
    const response = await client.request(path, { method: path.endsWith("rebuild") ? "POST" : "GET" });
    assert.equal(response.status, 401);
    assert.equal(typeof response.body.error.code, "string");
    assert.ok(response.requestId);
  }
});
