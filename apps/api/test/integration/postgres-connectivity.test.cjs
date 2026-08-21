const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { requireTestDatabaseUrl } = require("../../../../tests/helpers/test-context.cjs");

test("postgres.test_database.is_reachable_and_isolated", async () => {
  const url = requireTestDatabaseUrl();
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const rows = await prisma.$queryRawUnsafe("select current_database() as name");
    assert.match(rows[0].name, /test/i);
  } finally {
    await prisma.$disconnect();
  }
});
