const assert = require("node:assert/strict");
const { test } = require("node:test");
const { requireTestDatabaseUrl, testRun } = require("../../../../tests/helpers/test-context.cjs");
const { businessFixtures } = require("../../../../tests/fixtures/business-fixtures.cjs");

test("test runs produce isolated order numbers and fixture references", () => {
  const first = businessFixtures(testRun());
  const second = businessFixtures(testRun());
  assert.notEqual(first.run.orderNo, second.run.orderNo);
  assert.equal(first.salesOrder("customer-id").order_no, first.run.orderNo);
});

test("integration tests refuse a missing or non-test database URL", () => {
  const previous = process.env.TEST_DATABASE_URL;
  delete process.env.TEST_DATABASE_URL;
  assert.throws(requireTestDatabaseUrl, /TEST_BLOCKED/);
  process.env.TEST_DATABASE_URL = "postgresql://localhost/dilee_erp";
  assert.throws(requireTestDatabaseUrl, /dedicated test database/);
  if (previous === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL = previous;
});
