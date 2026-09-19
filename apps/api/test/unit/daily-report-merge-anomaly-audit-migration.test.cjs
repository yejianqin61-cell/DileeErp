// 「日报合并异常」补审计字段的库级守卫（内存替身看不到列，只有迁移 SQL 能证明）。
//
// 生产迁移：apps/api/prisma/migrations/20260919120000_daily_report_merge_anomaly_audit/migration.sql
// 依据：全站盘点认定它是数据层唯一的真缺口（docs/design/operator-and-timestamp-governance-inventory-2026-09-16.md 3.1）——
//   这张表会被更新（resolveMergeAnomaly 把 status 改成 resolved），但行上没有「谁改的、什么时候改的」。
//
// 这里守住四件事：
//   1. 两列真的建出来了；
//   2. **updated_at 先可空回填、再置 NOT NULL**：直接在已有数据上加 NOT NULL 列会让迁移失败，
//      顺序错了在空库上照样通过、上生产才炸；
//   3. **updated_by 允许为空**：没被人解决过的自动异常确实没有「操作人」，
//      硬塞一个猜测值比留空更坏（审计要的是真实归属）；
//   4. 已解决行的 updated_by 取自审计事件的真实 actor，不是常量、不是当前时间。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { migrationSql } = require("../helpers/migration-guards.cjs");

const sql = migrationSql();
const TABLE = "daily_report_merge_anomalies";

test("两列都建出来了", () => {
  assert.match(sql, new RegExp(`ALTER TABLE "${TABLE}" ADD COLUMN "updated_at" TIMESTAMP\\(3\\);`, "i"), "updated_at 必须存在");
  assert.match(sql, new RegExp(`ALTER TABLE "${TABLE}" ADD COLUMN "updated_by" UUID;`, "i"), "updated_by 必须存在");
});

test("updated_at：先加可空列 → 回填 → 再置 NOT NULL（顺序不能反）", () => {
  const add = sql.indexOf(`ALTER TABLE "${TABLE}" ADD COLUMN "updated_at"`);
  const backfill = sql.indexOf(`SET "updated_at" = COALESCE("resolved_at", "created_at")`);
  const notNull = sql.indexOf(`ALTER TABLE "${TABLE}" ALTER COLUMN "updated_at" SET NOT NULL`);
  assert.ok(add >= 0 && backfill >= 0 && notNull >= 0, "三个语句都必须存在");
  assert.ok(add < backfill, "必须先加列再回填");
  assert.ok(backfill < notNull, "必须先把历史行填上值，才能置 NOT NULL（否则已有数据时迁移失败）");
  assert.equal(new RegExp(`ADD COLUMN "updated_at" TIMESTAMP\\(3\\) NOT NULL`, "i").test(sql), false, "不能直接加 NOT NULL 列");
});

test("updated_at 的回填是可推导的，不是编造：已解决取 resolved_at，未解决取 created_at", () => {
  assert.match(sql, /SET "updated_at" = COALESCE\("resolved_at", "created_at"\)/i);
});

test("updated_by 允许为空：没被人解决过的自动异常没有操作人", () => {
  assert.equal(new RegExp(`ADD COLUMN "updated_by" UUID[^;]*NOT NULL`, "i").test(sql), false, "updated_by 必须可空");
  assert.equal(new RegExp(`ALTER COLUMN "updated_by" SET NOT NULL`, "i").test(sql), false, "不得把 updated_by 置为 NOT NULL");
});

test("updated_by 的回填只认审计事件里的真实 actor，且只针对已解决的行", () => {
  const backfill = /UPDATE "daily_report_merge_anomalies" AS anomaly\s+SET "updated_by" = \(([\s\S]*?)\)\s+WHERE([\s\S]*?);/i.exec(sql);
  assert.ok(backfill, "必须有一条 updated_by 的回填语句");
  assert.match(backfill[1], /FROM "audit_events"/i, "归属必须来自 audit_events");
  assert.match(backfill[1], /event\."actor_id"/i, "取的是 actor_id");
  assert.match(backfill[1], /event\."entity_type" = 'daily_report_merge_anomaly'/i, "要按对象类型过滤");
  assert.match(backfill[2], /anomaly\."status" = 'resolved'/i, "只回填已解决的行");
  assert.match(backfill[2], /anomaly\."updated_by" IS NULL/i, "已有值不覆盖");
});

test("不加 created_by：异常是系统自动归并的，不存在「创建人」这个业务事实", () => {
  assert.equal(new RegExp(`ALTER TABLE "${TABLE}"[^;]*ADD COLUMN "created_by"`, "i").test(sql), false);
});

test("不加索引与唯一约束（异常列表按状态与日期排队列，不按这两列筛选）", () => {
  assert.equal(new RegExp(`CREATE (UNIQUE )?INDEX[^;]*"${TABLE}"[^;]*"updated_(at|by)"`, "i").test(sql), false);
  assert.equal(new RegExp(`ALTER TABLE "${TABLE}"[^;]*ADD CONSTRAINT[^;]*"updated_(at|by)"`, "i").test(sql), false);
});
