// 币种字典迁移的守卫（源码文本 + 常量一致性检查，不连数据库）。
//
// 背景：币种从写死的枚举升级为可配置字典，已部署的库必须靠迁移补数据，
// 而不是只在新库种子（prisma/seed.ts）里加一行 —— 否则老库升级后币种字典为空。
//
// 本文件只证明迁移「写了什么」，不证明它能在 PostgreSQL 上跑通
// （那需要真实数据库，见 docs/test 的集成层）；因此逐条断言的是可静态验证的性质：
//   1. 迁移排在所有既有迁移之后（Prisma 按目录名排序执行）；
//   2. 同时建立 dictionary_types.key='currency' 与全部内置币种项；
//   3. 每条 INSERT 都是 ON CONFLICT DO NOTHING（幂等，重复执行不报错）；
//   4. 没有用户时直接返回（空库由 seed 负责），避免 actor 为 NULL 导致 NOT NULL 违约。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { DEFAULT_CURRENCIES } = require("../../dist/platform/currency/currency-catalog.js");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260913100000_currency_dictionary";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");

test("currency migration precedes every migration added after it", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  const index = folders.indexOf(folder);
  assert.ok(index >= 0, "币种字典迁移必须存在");
  // 原断言是「币种迁移必须是最后一个」。它真正要防的是：新迁移被排到币种迁移**前面**，
  // 使已部署库升级时币种种子被跳过（Prisma 按目录名顺序执行）。
  // 币种迁移之后合法地再出现新迁移是正常的，所以这里守住两条：
  //   1. 币种迁移之后的每个迁移时间戳都更大（顺序与预期一致，不会插队）；
  //   2. 迁移目录名一律以 14 位时间戳开头（否则 sort() 的顺序不可信）。
  for (const name of folders.slice(index + 1)) {
    assert.ok(name.slice(0, 14) > folder.slice(0, 14), `迁移 ${name} 必须晚于币种字典迁移`);
  }
  for (const name of folders) assert.match(name.slice(0, 14), /^\d{14}$/, `迁移目录 ${name} 必须以 14 位时间戳开头`);
});

test("currency migration seeds the dictionary type and every built-in currency", () => {
  assert.match(sql, /INSERT INTO "dictionary_types"/, "必须建立字典类型");
  assert.match(sql, /'currency'/, "字典类型的 key 必须是 currency（前端按 /dictionaries/currency/items 取）");
  for (const currency of DEFAULT_CURRENCIES) {
    assert.ok(sql.includes(`('${currency.key}'`), `内置币种 ${currency.key} 必须写进迁移，否则老库升级后下拉缺它`);
  }
});

test("currency migration is idempotent and skips an empty database", () => {
  const inserts = sql.match(/INSERT INTO "dictionary_(types|items)"/g) ?? [];
  const conflicts = sql.match(/ON CONFLICT \([^)]*\) DO NOTHING/g) ?? [];
  // 三条 INSERT：字典类型、内置币种，以及 DO 块里针对历史值兜底的动态 SQL（EXECUTE format(...)）。
  assert.equal(inserts.length, 3, "字典类型 / 内置币种 / 历史值兜底各一条 INSERT");
  assert.equal(conflicts.length, 3, "三条 INSERT 都必须 ON CONFLICT DO NOTHING（幂等）");
  assert.match(sql, /SELECT "id" INTO actor_id FROM "users" ORDER BY "created_at" LIMIT 1;/, "取首个用户作为审计操作人");
  assert.match(sql, /IF actor_id IS NULL THEN\s+RETURN;/, "空库（无用户）直接返回，交给 seed 初始化");
  // 变量名不写死（曾从 type_id 改名为 currency_type_id，避免与列名 type_id 混淆），只钉住「读不到类型就退出」这个行为。
  assert.match(sql, /SELECT "id" INTO \w+ FROM "dictionary_types" WHERE "key" = 'currency' AND "deleted_at" IS NULL;/, "读取 currency 字典类型的 id");
  assert.match(sql, /SELECT "id" INTO \w+ FROM "dictionary_types"[\s\S]*?IF \w+ IS NULL THEN\s+RETURN;/, "类型未建立时不继续写字典项");
});

test("currency migration backfills currency codes already used by business data", () => {
  // 宪法：已被业务数据引用的类目必须保留历史快照（这里落成「xxx（历史值）」字典项）。
  assert.match(sql, /information_schema\.columns/, "必须扫描所有带 currency 列的业务表");
  assert.match(sql, /information_schema\.tables/, "只处理基表，跳过视图");
  assert.match(sql, /column_name = 'currency'/, "按列名 currency 识别业务表");
  assert.match(sql, /（历史值）/, "补出来的项要标注为历史值，便于管理员识别与清理");
  assert.match(sql, /ON CONFLICT \("type_id", "key"\) DO NOTHING/, "兜底同样幂等");
});
