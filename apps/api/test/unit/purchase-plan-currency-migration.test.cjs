// 迁移守卫：`20260930140000_purchase_plan_currency`（给采购计划行加币种）与它依赖的两条不变式。
//
// 用户 2026-09-30：「针对当前的采购计划，要求添加价格字段，单价，总价。不然财务没法付钱。」
// 设计依据：`docs/design/purchase-plan-pricing-2026-09-30.md`。
//
// 为什么这一条迁移需要守卫：
//   · 加列是**不可逆**操作，而本机没有 PostgreSQL（跑不了 `migrate deploy`），
//     写错类型/写错可空性只有部署时才会发现 —— 那时表里已经有真实数据了。
//   · 币种必须是 `NOT NULL DEFAULT 'CNY'`：可空会让"计划合计"多出"币种未知"一档，
//     而界面上没有任何地方能把它补回来（币种的决策点在「收束下单」里按供应商组选）。
//
// 另外两条**源码级**不变式（行为测试在 purchase-plans-service.test.cjs，这里钉住"它还在"）：
//   · 收束下单前逐行要求单价 > 0；
//   · 采购单侧的下单门禁也必须是"大于 0"而不是"不为负"——否则同一个洞留在
//     `POST /purchase-orders` 与 `POST /purchase-orders/split` 上（它们现在没有前端调用点，
//     但接口是活的，且"0 元采购单 → 0 元应付"正是用户说的"财务没法付钱"）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const API_ROOT = path.join(__dirname, "..", "..");
const MIGRATIONS = path.join(API_ROOT, "prisma", "migrations");
const MIGRATION_NAME = "20260930140000_purchase_plan_currency";
const raw = fs.readFileSync(path.join(MIGRATIONS, MIGRATION_NAME, "migration.sql"), "utf8");
/** 去掉注释行再断言：注释里写了什么不算数（引用旧写法的注释不能让守卫变红）。 */
const sql = raw.replace(/^--.*$/gm, "");
const schema = fs.readFileSync(path.join(API_ROOT, "prisma", "schema.prisma"), "utf8");
const planItemModel = schema.slice(schema.indexOf("model PurchasePlanItem {"), schema.indexOf("model PurchaseReceipt {"));
const planService = fs.readFileSync(path.join(API_ROOT, "src", "modules", "procurement", "purchase-plans.service.ts"), "utf8");
const orderService = fs.readFileSync(path.join(API_ROOT, "src", "modules", "procurement", "purchase-orders.service.ts"), "utf8");

test("迁移：只给 purchase_plan_items 加 currency 一列，不动别的表、不删任何东西", () => {
  const altered = [...sql.matchAll(/ALTER TABLE "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(altered, ["purchase_plan_items"]);
  const added = [...sql.matchAll(/ADD COLUMN "([^"]+)" ([A-Z0-9()]+)( NOT NULL)?( DEFAULT [^;]+)?;/g)];
  assert.equal(added.length, 1, "一条加列语句");
  assert.equal(added[0][1], "currency");
  assert.equal(added[0][2], "VARCHAR(10)", "长度要与 schema 的 @db.VarChar(10) 一致");
  assert.equal(Boolean(added[0][3]), true, "必须 NOT NULL");
  assert.match(added[0][4] ?? "", /DEFAULT 'CNY'/, "必须有常量默认值：历史行读到的是同一个默认币种");
  // 加列迁移最危险的写法是"顺手改点别的"。
  assert.equal(/\bDROP\b/i.test(sql), false, "加列迁移不该有 DROP");
  assert.equal(/\bDELETE\s+FROM\b/i.test(sql), false);
  assert.equal(/\bTRUNCATE\b/i.test(sql), false);
  assert.equal(/\bUPDATE\b/i.test(sql), false, "不回填：常量默认值就是历史行的值");
});

test("迁移：schema 里的声明与 SQL 逐字对齐（否则 migrate diff 长期报漂移）", () => {
  assert.match(planItemModel, /currency\s+String\s+@default\("CNY"\) @map\("currency"\) @db\.VarChar\(10\)/, "字段名/映射/类型/默认值四项都要对上");
  // 可空是**不许**的：合计会多出"币种未知"一档，而页面上没地方补。
  assert.equal(/currency\s+String\?/.test(planItemModel), false, "currency 不能可空");
  // 不加索引：这一列只跟着行一起读，从不作为查询条件（多一个索引就是多一份漂移风险）。
  assert.equal(/@@index\(\[currency\]\)/.test(planItemModel), false);
});

test("迁移：目录名带 14 位时间戳，且排在采购计划那两条之后（Prisma 按目录名顺序执行）", () => {
  const names = fs.readdirSync(MIGRATIONS).filter((entry) => fs.statSync(path.join(MIGRATIONS, entry)).isDirectory()).sort();
  assert.match(MIGRATION_NAME, /^\d{14}_/);
  assert.ok(names.includes(MIGRATION_NAME), "迁移目录必须在仓库里");
  assert.ok(names.indexOf(MIGRATION_NAME) > names.indexOf("20260928090000_purchase_plan"), "表要先建出来");
  assert.ok(names.indexOf(MIGRATION_NAME) > names.indexOf("20260928100000_purchase_plan_backfill_drafts"), "搬完草稿再加列");
});

test("收束下单：计划侧逐行要求单价大于 0（0 单价 = 0 元应付，正是用户说的「财务没法付钱」）", () => {
  assert.match(planService, /code: "PURCHASE_PLAN_PRICE_REQUIRED"/);
  assert.match(planService, /if \(!line\.unitPrice\.gt\(0\)\)/, "判据必须是「大于 0」，不是「非负」");
  // 计划侧这句提示要把"第几行"说出来，否则采购员在一张 30 行的计划里找不到那一格。
  assert.match(planService, /第 \$\{rowNoOf\(lineId\)\} 行还没填单价/);
});

test("采购单侧的下单门禁一律收紧：0 价没有任何放行口子（2026-10-11 删掉了「价格待定」开关）", () => {
  const start = orderService.indexOf("private assertOrderableItems");
  const gate = orderService.slice(start, orderService.indexOf("采购单「打印信息」", start));
  // 判据必须是 isPositive（0 单价 = 0 元应付，正是用户说的「财务没法付钱」），而且**没有例外分支**。
  assert.match(gate, /if \(!this\.isPositive\(item\.unitPrice\)\) reasons\.push\("单价"\)/, "0 价必须一律拦下");
  assert.equal(/if \(!this\.isNonNegative\(item\.unitPrice\)\) reasons\.push\("单价"\)/.test(gate), false, "旧写法（非负）会放过 0 单价");
  // 2026-10-09 的 `allowPendingPrice` 例外已按用户 2026-10-11 的口径删除：
  // 「确定单价的能下单，没确定单价的先不下单」。留一个开关就是给 0 元应付留一条后门。
  // 判据用属性访问而不是裸词：注释里会提到这个名字，裸词会让这条守卫被自己的注释喂饱。
  assert.equal(/options\.allowPendingPrice|allowPendingPrice\s*[=:?]/.test(orderService), false, "放行开关必须彻底删掉，不能只改默认值");
  assert.match(orderService, /async collectGroups\(input: SplitInput, placeOrder: boolean\): Promise<MergedGroup\[\]>/);
});

test("下单写回币种：已下单行的币种永远等于那张采购单的币种（计划合计按币种分列才不说谎）", () => {
  // 认领链接与币种必须在**同一次**回写里完成：分两次就会有"链接写上了、币种还是人民币"的中间态，
  // 而计划合计恰恰是按币种分列的。
  assert.match(planService, /data: \{ purchaseOrderItemId: item\.id, currency: item\.currency/);
  /**
   * 币种的来源必须是**采购单头**，不是请求体里那一格。
   *
   * 2026-10-13 自动收束之后，一组的落点有两种（设计文档口径 1）：
   *   · 新建一张 → `createdOrder.currency`（新建单的头）；
   *   · 追加进已有那张 → `appended.order.currency`（`appendItems()` 从那张单读回来的头）。
   * 两条都取自单头 —— 所以"这一行谈的是什么钱"永远等于它落的那张单，而单头币种在
   * `appendItems()` 里是被四条判据之一（币种必须一致）钉死的。
   */
  assert.match(planService, /currency: appended\.order\.currency/, "并入已有单时，币种取那张单的头");
  assert.match(planService, /currency: createdOrder\.currency/, "新建单时，币种取新建单的头");
});
