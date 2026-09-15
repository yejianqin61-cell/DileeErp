// 收支流水迁移的守卫（源码文本 + 常量一致性检查，不连数据库）。
//
// 为什么需要它：这是三期唯一一个**改库**的改动，而本机没有可用 PostgreSQL，
// 迁移无法在真实库上跑。因此逐条断言的都是可静态验证的性质：
//   1. 迁移排在既有迁移之后（Prisma 按目录名排序执行）；
//   2. 两本字典的类型与全部种子项都写进了迁移（否则老库升级后字典为空）；
//   3. 字典写入幂等，且空库直接返回（由 seed 负责初始化）；
//   4. 建表的列/约束/外键与 schema 期望一致 —— 其中「可空关联必须用 ON DELETE SET NULL」
//      这一条是实际踩到的坑：Prisma 对可选关联生成 SET NULL，写成 RESTRICT 会让
//      `migrate status` 认为库与 schema 有漂移（用 `prisma migrate diff` 逐列比对过）；
//   5. seed.ts 里也种同样两本字典（新库初始化与老库升级必须得到同一份清单）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const {
  CASH_FLOW_ITEM_DICTIONARY_KEY,
  SETTLEMENT_ACCOUNT_DICTIONARY_KEY,
  DEFAULT_CASH_FLOW_ITEMS,
  DEFAULT_SETTLEMENT_ACCOUNTS,
} = require("../../dist/modules/finance/cash-flow-catalog.js");

const migrationsRoot = join(__dirname, "..", "..", "prisma", "migrations");
const folder = "20260914190000_cash_flow_entries";
const sql = readFileSync(join(migrationsRoot, folder, "migration.sql"), "utf8");
const seed = readFileSync(join(migrationsRoot, "..", "seed.ts"), "utf8");

test("cash flow migration precedes every migration added after it", () => {
  const folders = readdirSync(migrationsRoot).filter((name) => statSync(join(migrationsRoot, name)).isDirectory()).sort();
  const index = folders.indexOf(folder);
  assert.ok(index >= 0, "收支流水迁移必须存在");
  // 原断言是「收支迁移必须是最后一个」。它真正要防的是：新迁移被排到收支迁移**前面**，
  // 使字典种子顺序被插队（Prisma 按目录名顺序执行）。收支迁移之后合法地出现新迁移是正常的
  // （例如 20260915120000_payment_idempotency_key），所以这里守住两条：
  //   1. 收支迁移之后的每个迁移时间戳都更大（顺序与预期一致，不会插队）；
  //   2. 迁移目录名一律以 14 位时间戳开头（否则 sort() 的顺序不可信）。
  for (const name of folders.slice(index + 1)) {
    assert.ok(name.slice(0, 14) > folder.slice(0, 14), `迁移 ${name} 必须晚于收支流水迁移`);
  }
  for (const name of folders) assert.match(name.slice(0, 14), /^\d{14}$/, `迁移目录 ${name} 必须以 14 位时间戳开头`);
});

test("cash flow migration seeds both dictionaries with every default entry", () => {
  assert.match(sql, /INSERT INTO "dictionary_types"/, "必须建立字典类型");
  assert.ok(sql.includes(`'${CASH_FLOW_ITEM_DICTIONARY_KEY}'`), "收支项目的字典 key 必须写进迁移");
  assert.ok(sql.includes(`'${SETTLEMENT_ACCOUNT_DICTIONARY_KEY}'`), "结算账户的字典 key 必须写进迁移");
  assert.equal(DEFAULT_CASH_FLOW_ITEMS.length, 37, "老表「项目」列有 37 行");
  assert.equal(DEFAULT_SETTLEMENT_ACCOUNTS.length, 2, "老表「结算方式」里出现过 2 个银行账户");
  for (const item of [...DEFAULT_CASH_FLOW_ITEMS, ...DEFAULT_SETTLEMENT_ACCOUNTS]) {
    assert.ok(sql.includes(`('${item.key}'`), `字典项「${item.label}」必须写进迁移，否则老库升级后这一项缺失`);
  }
});

test("cash flow migration dictionary writes are idempotent and skip an empty database", () => {
  const conflicts = sql.match(/ON CONFLICT \("type_id", "key"\) DO NOTHING/g) ?? [];
  assert.equal(conflicts.length, 2, "两本字典的写入都必须 ON CONFLICT DO NOTHING（幂等）");
  assert.match(sql, /ON CONFLICT \("key"\) DO NOTHING/, "字典类型同样幂等");
  assert.match(sql, /IF actor_id IS NULL THEN\s+RETURN;/, "空库（无用户）直接返回，交给 seed 初始化");
  assert.match(sql, /IF items_type_id IS NOT NULL THEN/, "读不到类型时不继续写字典项");
});

test("cash flow migration only adds objects (never drops existing facts)", () => {
  assert.equal(/DROP\s+(TABLE|COLUMN)/i.test(sql), false, "迁移只做加法：不允许 DROP 表或列");
  assert.match(sql, /CREATE TABLE "cash_flow_entries"/);
  assert.match(sql, /CREATE UNIQUE INDEX "cash_flow_entries_entry_no_key"/);
});

test("cash flow migration guards direction/amount/status at the database level", () => {
  // 库层兜底：即使有写入绕过 HTTP 服务，也不允许出现方向不明或金额非正的流水。
  assert.match(sql, /CONSTRAINT "cash_flow_entries_direction_check" CHECK \("direction" IN \('income', 'expense'\)\)/);
  assert.match(sql, /CONSTRAINT "cash_flow_entries_amount_positive_check" CHECK \("amount" > 0\)/);
  assert.match(sql, /CONSTRAINT "cash_flow_entries_status_check" CHECK \("status" IN \('posted', 'reversed'\)\)/);
});

test("cash flow migration keeps the item FK restrictive and the optional account FK set-null", () => {
  assert.match(
    sql,
    /CONSTRAINT "cash_flow_entries_item_id_fkey" FOREIGN KEY \("item_id"\) REFERENCES "dictionary_items"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE/,
    "项目是必填关联 → RESTRICT（字典项只软删除，不会真删）",
  );
  assert.match(
    sql,
    /CONSTRAINT "cash_flow_entries_settlement_account_id_fkey" FOREIGN KEY \("settlement_account_id"\) REFERENCES "dictionary_items"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
    "账户是可空关联 → Prisma 期望 SET NULL；写成 RESTRICT 会造成库与 schema 漂移",
  );
});

test("seed.ts seeds the same two dictionaries (fresh database parity)", () => {
  // 空库（无用户）时迁移不种字典，必须由 seed 补齐，否则新库的收支项目下拉是空的。
  // 断言的是**常量名**而不是字面量 key：seed 复用 cash-flow-catalog.ts 的导出，
  // 不另抄一份字符串（抄一份就会出现「迁移与 seed 清单不一致」）。
  assert.ok(seed.includes("CASH_FLOW_ITEM_DICTIONARY_KEY"), "seed 必须种收支项目字典");
  assert.ok(seed.includes("SETTLEMENT_ACCOUNT_DICTIONARY_KEY"), "seed 必须种结算账户字典");
  assert.ok(seed.includes("DEFAULT_CASH_FLOW_ITEMS"), "seed 必须复用同一份清单，而不是另抄一遍");
  assert.ok(seed.includes("DEFAULT_SETTLEMENT_ACCOUNTS"), "seed 必须复用同一份清单");
  assert.ok(seed.includes("cash-flow-catalog"), "seed 从 cash-flow-catalog 导入，与迁移共用一份清单");
});
