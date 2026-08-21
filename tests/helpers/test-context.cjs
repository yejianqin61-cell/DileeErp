const { randomUUID } = require("node:crypto");

function testRun(prefix = "dilee") {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  return { id, prefix: `${prefix}-${id}`, orderNo: `${prefix.toUpperCase()}-${id}` };
}

function requireTestDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL is required; DATABASE_URL is never used by tests");
  if (!/test/i.test(url)) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL must identify a dedicated test database");
  return url;
}

async function cleanup(cleanupAction, context) {
  try {
    await cleanupAction();
  } catch (error) {
    error.message = `Test cleanup failed for ${context.prefix}: ${error.message}`;
    throw error;
  }
}

module.exports = { cleanup, requireTestDatabaseUrl, testRun };
