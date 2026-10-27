// 单号联动的一致性命中（集成测试，需要 TEST_DATABASE_URL；`npm run test:integration`）。
//
// 为什么需要它：读路径里还有大量靠 order_no 关联的地方。只要「有单号的行一定能解析出
// sales_order_id，且它指向的销售单单号与该行文本一致」，文本 join 与 id join 查到的就是同一批行。
// 一旦这里红了，说明两条路会分叉 —— 那时才需要讨论换 join，或者修数据。
//
// 历史：2026-10-27 在生产快照上跑同一口径，发现 customer_payments 有 6 行孤儿；
// 根因是那 11 张表没有填充触发器，已由迁移 20261027210000 补齐。
const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { requireTestDatabaseUrl } = require("../../../../tests/helpers/test-context.cjs");

const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });

after(async () => { await prisma.$disconnect(); });

async function linkedTables() {
  return prisma.$queryRawUnsafe(
    `SELECT c.table_name
       FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.column_name = 'sales_order_id'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns k
           WHERE k.table_schema = 'public' AND k.table_name = c.table_name AND k.column_name = 'order_no'
        )
      ORDER BY c.table_name`,
  );
}

test("每一行带单号的数据都能解析到同一张销售单（0 不一致、0 孤儿）", async () => {
  const tables = await linkedTables();
  assert.ok(tables.length >= 38, `带单号与外键的表应有 38 张，实际 ${tables.length} 张：检查迁移是否都应用了`);

  const failures = [];
  for (const { table_name: table } of tables) {
    const [row] = await prisma.$queryRawUnsafe(
      `SELECT
         count(*) FILTER (
           WHERE x.sales_order_id IS NOT NULL
             AND x.order_no IS DISTINCT FROM (SELECT s.order_no FROM sales_orders s WHERE s.id = x.sales_order_id)
         )::int AS mismatched,
         count(*) FILTER (
           WHERE x.order_no IS NOT NULL AND x.order_no <> '' AND x.sales_order_id IS NULL
         )::int AS orphan
       FROM "${table}" x`,
    );
    if (row.mismatched > 0) failures.push(`${table}: ${row.mismatched} 行指向了别的销售单`);
    if (row.orphan > 0) failures.push(`${table}: ${row.orphan} 行有单号但外键为空`);
  }
  assert.deepEqual(failures, [], failures.join("；"));
});

test("填充触发器已覆盖全部 38 张表，且不包含销售单本身", async () => {
  const [row] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'fill_sales_order_id' AND NOT tgisinternal`);
  assert.ok(row.n >= 38, `填充触发器应有 38 个，实际 ${row.n} 个`);
  const [self] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'fill_sales_order_id' AND tgrelid = 'sales_orders'::regclass`);
  assert.equal(self.n, 0, "销售单自己不能挂这个触发器");
});
