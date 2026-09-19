// 时区运维脚本（scripts/db-timezone-utc.sql）的守卫测试。
//
// 为什么这个脚本值得单独一组断言：它是**唯一**会改动「操作时间」历史数据的东西，
// 而且必须由人在生产库上手工执行。最容易出事的两种写法是
//   ① 把 `UPDATE ... SET created_at = created_at - interval '8 hours'` 写成**会直接执行**的语句
//      —— 在本来就是 UTC 的库上跑一次就把全库创建时间改错 8 小时；
//   ② 有人图省事把它挂进迁移或部署脚本，于是每次发布都自动跑一遍。
// 这两条都在下面钉住。
//
// 运行：node --test scripts/db-timezone-script.test.mjs
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(root, "scripts", "db-timezone-utc.sql");
const script = readFileSync(scriptPath, "utf8");

/** 去掉行注释、块注释与单引号字符串，只留下**会真正执行**的骨架。 */
function executableSkeleton(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

const skeleton = executableSkeleton(script);

test("脚本必须存在（API 启动告警与设计文档都引用了它）", () => {
  assert.ok(existsSync(scriptPath), "scripts/db-timezone-utc.sql 必须存在");
});

test("把库级默认时区钉成 UTC：用 current_database() 动态取名，不写死库名", () => {
  assert.match(script, /ALTER DATABASE %I SET timezone TO ''UTC''/i, "必须通过 format(%I) 动态设置当前库");
  assert.match(script, /current_database\(\)/i, "库名必须来自 current_database()，否则换库就失效");
  assert.match(script, /DO \$\$/i, "ALTER DATABASE 需要包在 DO 块里动态执行");
  // 写死库名会让脚本在别的环境（factory/test）上静默改错库
  assert.equal(/ALTER DATABASE\s+"?dilee/i.test(script), false, "不得写死库名");
});

test("绝不包含会直接执行的破坏性语句（历史订正必须是「只生成、不执行」）", () => {
  const destructive = /(?:^|;)\s*(UPDATE|DELETE|DROP|TRUNCATE)\b/i.exec(skeleton);
  assert.equal(destructive, null, `脚本里出现了会直接执行的 ${destructive?.[1] ?? ""} 语句；历史订正只能生成语句供人工复核`);
  // 唯一允许的 ALTER 是当前库的时区设置（在 DO 块里、字符串内，因此已被剥离）
  assert.equal(/;\s*ALTER\s/i.test(skeleton), false, "不得出现直接执行的 ALTER 语句");
});

test("第 4 步生成的订正语句只针对 created_at，且明确不动 updated_at", () => {
  const generated = /format\('UPDATE %I\.%I SET "([a-z_]+)" = "\1" - interval/i.exec(script);
  assert.ok(generated, "必须提供「只生成、不执行」的订正语句模板");
  assert.equal(generated[1], "created_at", "订正范围只能是数据库默认值写的 created_at");
  assert.equal(/SET "updated_at"/i.test(script), false, "由应用写的 updated_at 已经是 UTC，不得订正");
  assert.match(script, /不能动/, "必须写明为什么不动 updated_at");
});

test("必须先测量旧偏移再谈订正（否则无从判断要不要改）", () => {
  assert.match(script, /offset_hours/i, "要给出旧偏移的分布查询");
  assert.match(script, /interval '5 minutes'/i, "偏移测量必须限定在「创建与改动同一时间窗」的行上，否则量到的是业务间隔");
  assert.match(script, /第 2 步/, "要看得到「先测后改」的步骤顺序");
});

test("脚本顶部必须讲清两个时间的来源不同（否则后来的人会订正错列）", () => {
  assert.match(script, /CURRENT_TIMESTAMP/, "必须写明 created_at 由数据库默认值写入");
  assert.match(script, /@updatedAt/, "必须写明 updated_at 由 Prisma 客户端写入");
  assert.match(script, /TIMESTAMP\(3\)/, "必须写明物理类型是无时区的 TIMESTAMP(3)");
});

test("不得被迁移或部署流程自动执行（只能在生产上手工跑）", () => {
  const migrationsRoot = join(root, "apps", "api", "prisma", "migrations");
  for (const name of readdirSync(migrationsRoot)) {
    const dir = join(migrationsRoot, name);
    if (!statSync(dir).isDirectory()) continue;
    const sql = readFileSync(join(dir, "migration.sql"), "utf8");
    assert.equal(/db-timezone-utc/.test(sql), false, `迁移 ${name} 不得引用时区脚本`);
    // 迁移里也不该出现 ALTER DATABASE：非 compose 部署的应用账号可能不是库 owner，会让整次发布失败
    assert.equal(/ALTER DATABASE/i.test(sql), false, `迁移 ${name} 不得包含 ALTER DATABASE`);
  }
  const automation = ["scripts/apply-migrations.ps1", "scripts/deploy-incremental.ps1", "package.json"]
    .filter((rel) => existsSync(join(root, rel)))
    .map((rel) => [rel, readFileSync(join(root, rel), "utf8")]);
  for (const [rel, content] of automation) {
    assert.equal(/db-timezone-utc/.test(content), false, `${rel} 不得自动执行时区脚本`);
  }
});

test("脚本自带用法说明与「先看 /health」的引导", () => {
  assert.match(script, /psql/, "要给出执行方式");
  assert.match(script, /\/api\/v1\/health/, "要指向应用侧的自检入口，而不是让人盲改");
});
