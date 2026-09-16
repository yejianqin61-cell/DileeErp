// 工资付款发放银行 + 原料出库仓库确认 迁移的守卫（源码文本 + schema 一致性，不连数据库）。
//
// 为什么需要它：本机没有可用 PostgreSQL，迁移无法在真实库上跑。这里逐条断言的都是可静态验证的性质，
// 其中两条是这类改动最容易踩的坑：
//   1. `salary_payments.bank_id` 是**可空**列 → 外键必须 ON DELETE SET NULL
//      （写成 RESTRICT 会让 `migrate status` 认为库与 schema 有漂移）；
//   2. `raw_material_movements` 的 `pending_outbound` 状态**不需要改库结构** ——
//      status 是 VARCHAR(30) 且这张表没有 status 的 CHECK 约束。如果将来有人给 status 加了
//      CHECK，这个状态的写入会被库层拒绝，而本机跑不了真实迁移，必须由这里挡住。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260916130000_salary_bank_and_material_outbound_confirm";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const schema = readFileSync(join(migrationsRoot, "..", "schema.prisma"), "utf8");
const movementSql = readFileSync(join(migrationsRoot, "20260822113000_raw_material_issue_movements", "migration.sql"), "utf8");

test("新迁移按时间戳排在既有迁移之后（Prisma 按目录名顺序执行）", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  const index = folders.indexOf(folder);
  assert.ok(index >= 0, "迁移必须存在");
  assert.equal(folders[index - 1], "20260916120000_employee_roster_fields", "必须紧跟在员工花名册迁移之后");
  for (const name of folders) assert.match(name.slice(0, 14), /^\d{14}$/, `迁移目录 ${name} 必须以 14 位时间戳开头`);
  for (const name of folders.slice(index + 1)) assert.ok(name.slice(0, 14) > folder.slice(0, 14), `迁移 ${name} 必须晚于本迁移`);
});

test("工资付款加发放银行列，且外键是可空关联的 SET NULL", () => {
  assert.match(sql, /ALTER TABLE "salary_payments" ADD COLUMN "bank_id" UUID;/);
  assert.match(
    sql,
    /CONSTRAINT "salary_payments_bank_id_fkey" FOREIGN KEY \("bank_id"\) REFERENCES "banks"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
    "可空关联必须 SET NULL；写成 RESTRICT 会造成库与 schema 漂移",
  );
  // 列可空：升级前的历史付款单没有银行，服务层才对**新建/过账**强制要求。
  assert.match(schema, /model SalaryPayment \{[\s\S]*?bankId\s+String\?\s+@map\("bank_id"\) @db\.Uuid/, "schema 里 bankId 必须可空");
  assert.match(schema, /bank\s+Bank\?\s+@relation\(fields: \[bankId\], references: \[id\]\)/);
  assert.match(schema, /salaryPayments\s+SalaryPayment\[\]/, "Bank 侧要有反向关系，否则 schema 不合法");
});

test("原料流转加提交时间列 + (status, submitted_at) 索引（待出库通知的查询路径）", () => {
  assert.match(sql, /ALTER TABLE "raw_material_movements" ADD COLUMN "submitted_at" TIMESTAMP\(3\);/);
  assert.match(sql, /CREATE INDEX "raw_material_movements_status_submitted_at_idx" ON "raw_material_movements"\("status", "submitted_at"\)/);
  assert.match(schema, /submittedAt\s+DateTime\?\s+@map\("submitted_at"\)/);
});

/**
 * 迁移里手写的索引必须在 schema 里声明。
 *
 * 为什么单独立一条：`prisma migrate diff`（库 → schema）的方向上，**库里存在而 schema 没声明的索引
 * 会被判定为漂移并要求 DROP 掉**。第一条版本正是漏了这条，部署后在真库上跑漂移检查才暴露出来：
 * `DROP INDEX "raw_material_movements_status_submitted_at_idx";`。
 * 本机跑不了真实迁移，所以只能静态挡住 —— 凡是本迁移 CREATE INDEX 的索引，
 * 都要能在 schema 的对应模型里找到同列同序的 @@index。
 */
test("迁移创建的索引必须在 schema 里声明（否则 migrate diff 会一直想 DROP 它）", () => {
  assert.match(
    schema,
    /model RawMaterialMovement \{[\s\S]*?@@index\(\[status, submittedAt\]\)/,
    "raw_material_movements_status_submitted_at_idx 必须在 schema 里声明为 @@index([status, submittedAt])，列顺序也要一致",
  );
  // 兜底：本迁移只建这一条索引，出现第二条就必须同时补 schema 声明与这里的断言。
  const created = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(created, ["raw_material_movements_status_submitted_at_idx"], "新增索引必须同步在这里登记并声明到 schema");
});

test("pending_outbound 状态不需要改库结构：status 是 VARCHAR 且没有 CHECK 约束", () => {
  // 只有在这两个条件同时成立时，新增状态才是「纯应用层」改动。
  assert.match(movementSql, /"status"\s+VARCHAR\(30\)\s+NOT NULL DEFAULT 'draft'/);
  assert.equal(
    /raw_material_movements_status_check/.test(movementSql),
    false,
    "如果将来给 raw_material_movements.status 加了 CHECK，pending_outbound 会被库层拒绝；" +
      "本机跑不了真实迁移，这条断言就是那道防线 —— 届时必须在本迁移里先 DROP 再重建 CHECK。",
  );
  for (const later of readdirSync(migrationsRoot).filter((name) => name > "20260822113000" && name !== folder)) {
    const file = join(migrationsRoot, later, "migration.sql");
    if (!statSync(join(migrationsRoot, later)).isDirectory()) continue;
    const text = readFileSync(file, "utf8");
    assert.equal(/raw_material_movements[\s\S]{0,200}status_check/.test(text), false, `迁移 ${later} 不得给 raw_material_movements.status 加 CHECK`);
  }
});

test("迁移只做加法，不删任何既有事实", () => {
  assert.equal(/DROP\s+(TABLE|COLUMN)/i.test(sql), false, "迁移只做加法：不允许 DROP 表或列");
});
