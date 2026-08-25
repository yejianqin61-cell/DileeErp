const assert = require("node:assert/strict");
const { test } = require("node:test");
const baseUrl = process.env.API_BASE_URL;

test("sales_orders.pagination_query_is_transformed_before_prisma", async () => {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) throw new Error("TEST_BLOCKED: INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required");

  const login = await fetch(new URL("/api/v1/auth/login", baseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  assert.equal(login.status, 201);
  const cookie = login.headers.get("set-cookie");
  assert.ok(cookie);

  const response = await fetch(new URL("/api/v1/sales-orders?page_size=200", baseUrl), { headers: { cookie } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.meta.page_size, 200);
  assert.ok(Array.isArray(body.data));
});
