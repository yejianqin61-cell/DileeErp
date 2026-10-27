// 单号外键守卫（阶段 5 / R-8）：带 order_no 的表必须能落到 sales_order_id。
//
// 为什么需要它：`order_no` 是文本副本，改号时靠 38 项登记表逐张扫。补了外键之后，
// 关系由数据库保证；这个守卫防止以后新增一张带单号的表却忘了补列，让文本联动重新长回来。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "..");
const SCHEMA = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
const MIGRATIONS = join(ROOT, "prisma", "migrations");

/** 豁免只有两条：审计事件流（历史必须留旧号）与销售单本身（源头）。 */
const EXEMPT = ["AuditEvent", "SalesOrder"];

function scanSchema(text) {
  const models = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    const open = /^model (\w+) \{/.exec(line);
    if (open) { current = open[1]; models.set(current, { orderNo: false, salesOrderId: false }); continue; }
    if (current && /^\}/.test(line)) { current = null; continue; }
    if (!current) continue;
    if (line.includes('@map("order_no")')) models.get(current).orderNo = true;
    if (line.includes('@map("sales_order_id")')) models.get(current).salesOrderId = true;
  }
  return models;
}

function missingFk(models) {
  return [...models.entries()]
    .filter(([name, model]) => model.orderNo && !model.salesOrderId && !EXEMPT.includes(name))
    .map(([name]) => name)
    .sort();
}

test("带 order_no 的模型要么有 sales_order_id，要么在豁免里", () => {
  const models = scanSchema(SCHEMA);
  assert.deepEqual(missingFk(models), [], "这些表带 order_no 却没有 sales_order_id");
});

test("豁免恰好两条，且都确实带 order_no", () => {
  const models = scanSchema(SCHEMA);
  assert.deepEqual(EXEMPT.slice().sort(), ["AuditEvent", "SalesOrder"]);
  for (const name of EXEMPT) assert.ok(models.get(name)?.orderNo, `${name} 必须带 order_no 才谈得上豁免`);
});

test("三份新迁移：每张补列的表都有回填、外键与索引", () => {
  const dirs = readdirSync(MIGRATIONS).filter((name) => name.includes("order_no_fk") && !name.includes("autofill") && statSync(join(MIGRATIONS, name)).isDirectory());
  assert.equal(dirs.length, 3, "阶段 5 的三份迁移必须都在");
  const sql = dirs.map((name) => readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8")).join("\n");
  const tables = [...sql.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN "sales_order_id"/g)].map((match) => match[1]);
  assert.equal(tables.length, 27, "应有 27 张表被补列");
  for (const table of tables) {
    assert.ok(sql.includes(`UPDATE "${table}" t SET "sales_order_id"`), `${table} 缺少回填语句`);
    assert.ok(sql.includes(`CONSTRAINT "${table}_sales_order_id_fkey"`), `${table} 缺少外键`);
    assert.ok(sql.includes(`INDEX "${table}_sales_order_id_idx"`), `${table} 缺少索引`);
  }
});

test("自动填充触发器覆盖全部 27 张表，且只读 sales_orders", () => {
  const sql = readFileSync(join(MIGRATIONS, "20261027200000_order_no_fk_autofill", "migration.sql"), "utf8");
  assert.match(sql, /CREATE OR REPLACE FUNCTION fill_sales_order_id\(\)/, "缺少填充函数");
  assert.match(sql, /WHERE s\.order_no = NEW\.order_no AND s\.deleted_at IS NULL/, "只认未软删的销售单");
  const targets = sql.match(/targets text\[\] := ARRAY\[([^\]]+)\]/);
  assert.ok(targets, "缺少表清单");
  const tables = [...targets[1].matchAll(/'(\w+)'/g)].map((match) => match[1]);
  assert.equal(tables.length, 27, "触发器必须覆盖 27 张表");
  assert.ok(!tables.includes("sales_orders"), "销售单自己不能挂这个触发器");
  assert.ok(!tables.includes("audit_events"), "审计事件流不能挂这个触发器");
});

test("漂移模拟：删掉一张表的 sales_order_id，守卫必须报出来", () => {
  const doctored = SCHEMA.replace(/model PurchaseReceipt \{[\s\S]*?\n\}/, (block) => block.replace(/\n\s*salesOrderId[^\n]*\n\s*salesOrder\s+SalesOrder\?[^\n]*/, ""));
  const missing = missingFk(scanSchema(doctored));
  assert.ok(missing.includes("PurchaseReceipt"), `守卫没有发现漂移，返回值：${missing.join("、")}`);
});
