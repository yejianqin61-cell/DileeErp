const assert = require("node:assert/strict");
const { test } = require("node:test");
const { apiClient } = require("../../../../tests/helpers/api-client.cjs");

const baseUrl = process.env.API_BASE_URL;

test("platform.health.returns_the_standard_json_envelope", async () => {
  const response = await apiClient(baseUrl).request("/api/v1/health");
  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, "ok");
  assert.equal(response.body.data.database, "ok");
  assert.deepEqual(response.body.meta, {});
  assert.ok(response.requestId);
});

test("platform.protected_routes.reject_anonymous_requests_with_standard_error", async () => {
  const response = await apiClient(baseUrl).request("/api/v1/customers");
  assert.equal(response.status, 401);
  assert.ok(response.body.error);
  assert.ok(response.body.error.code);
  assert.ok(response.requestId);
});

test("d4.material_movement_routes.reject_anonymous_requests_and_preserve_error_envelope", async () => {
  const client = apiClient(baseUrl);
  for (const [method, path] of [["GET", "/api/v1/production/material-movements"], ["POST", "/api/v1/production/material-movements/issue-preview"], ["POST", "/api/v1/production/material-movements/returns"]]) {
    const response = await client.request(path, { method, body: method === "POST" ? JSON.stringify({}) : undefined });
    assert.equal(response.status, 401);
    assert.ok(response.body.error);
    assert.equal(typeof response.body.error.code, "string");
    assert.ok(response.requestId);
  }
});

test("d4.material_movement_validation_is_not_reached_without_authentication", async () => {
  const response = await apiClient(baseUrl).request("/api/v1/production/material-movements/not-a-uuid/impact-preview");
  assert.equal(response.status, 401);
  assert.equal(typeof response.body.error.message, "string");
  assert.ok(response.body.meta);
});
