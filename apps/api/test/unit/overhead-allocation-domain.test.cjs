// 月度管理费分摊的纯口径测试（`overhead-allocation.domain.ts`）。
//
// 这一层的三条铁律：
//   1. **费率不四舍五入**：先修约再乘数量会让「单价 × 数量 = 金额」对不上，财务逐行验算时就会怀疑整张表；
//   2. **算不出来就是 null**：费率/金额/占比算不出来时留空（空单元格），绝不写 0 或 NaN ——
//      0 是「确实为零」的事实，两者在财务上完全不同（老表那里是 #DIV/0!，我们不写那个）；
//   3. **单位是分摊的一部分**：「55 元/打」与「55 元/支」差 12 倍，所以只有归一后同单位才套费率。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const {
  allocationAmountFor,
  allocationPeriodDays,
  allocationPeriodOf,
  allocationQuantity,
  allocationRate,
  allocationSpansMonths,
  allocationUnitCandidates,
  allocationUnitMatches,
  isAllocationPeriod,
  normalizeAllocationUnit,
  shareOf,
  unitAmountOf,
} = require("../../dist/modules/finance/overhead-allocation.domain.js");
const { normalizeSpecUnit } = require("../../dist/modules/sales/sales-orders.service.js");

const dec = (value) => new Prisma.Decimal(value);

/* ------------------------------------------------------------------ 数量与费率 */

test("分摊数量：人工覆盖值优先，且**填了 0 就认 0**（0 是「这个月没生产」这个事实）", () => {
  assert.equal(allocationQuantity({ amount: "220000", unit: "打", quantityOverride: "0", autoQuantity: "3700" }).toString(), "0");
  assert.equal(allocationQuantity({ amount: "220000", unit: "打", quantityOverride: 0, autoQuantity: 3700 }).toString(), "0");
  assert.equal(allocationQuantity({ amount: "220000", unit: "打", quantityOverride: null, autoQuantity: "3700" }).toString(), "3700");
  assert.equal(allocationQuantity({ amount: "220000", unit: "打", autoQuantity: "3700" }).toString(), "3700", "不传覆盖值时用自动汇总值");
  assert.equal(allocationQuantity({ amount: "220000", unit: "打", quantityOverride: "", autoQuantity: "3700" }).toString(), "3700", "空串等于「没覆盖」");
  assert.equal(allocationQuantity({ amount: "220000", unit: "打" }), null, "两个值都没有 → null（而不是 0）");
});

test("费率：数量为 0 / null 时返回 null，绝不返回 0 或 NaN", () => {
  assert.equal(allocationRate({ amount: "220000", unit: "打", autoQuantity: "0" }), null);
  assert.equal(allocationRate({ amount: "220000", unit: "打", quantityOverride: "0", autoQuantity: "3700" }), null);
  assert.equal(allocationRate({ amount: "220000", unit: "打" }), null);
  assert.equal(allocationRate({ amount: "220000", unit: "打", autoQuantity: "3700" }).toString(), dec("220000").div(3700).toString());
  // 「费率 = 0」与「费率算不出来」是两件事：后者要在表尾点名，前者是一张真表。
  assert.notEqual(allocationRate({ amount: "220000", unit: "打" }), 0);
  assert.equal(Number.isNaN(allocationRate({ amount: "220000", unit: "打" })), false);
});

test("费率不提前修约：金额 = 数量 × 费率 回到总额本身（220000 ÷ 3700 这类除不尽的费率）", () => {
  const facts = { amount: "220000", unit: "打", autoQuantity: "3700" };
  const rate = allocationRate(facts);
  assert.equal(rate.toString(), "59.459459459459459459", "费率保留完整精度，不修约成 59.46");
  const amount = allocationAmountFor(rate, allocationQuantity(facts));
  assert.equal(amount.toString(), "220000", "数量 × 费率 必须回到总额：修约过的费率会得到 220002");
  // 反过来也能对上：金额 ÷ 数量 = 费率，所以财务拿「单价 × 数量」逐行验算时处处成立。
  assert.equal(unitAmountOf(amount, "3700").toString(), rate.toString());
});

test("管理费金额：费率或数量缺失时返回 null（留空，不写 0）", () => {
  assert.equal(allocationAmountFor(null, "100"), null);
  assert.equal(allocationAmountFor("55", null), null);
  assert.equal(allocationAmountFor("55", "0").toString(), "0", "数量确实是 0 时金额就是 0（一个事实）");
});

test("单价与占比：由金额反推单价；占比在合计为 0 或缺失时返回 null", () => {
  assert.equal(unitAmountOf("1000", "4").toString(), "250");
  assert.equal(unitAmountOf("1000", "0"), null);
  assert.equal(unitAmountOf("1000", null), null);
  assert.equal(unitAmountOf(null, "4"), null);

  assert.equal(shareOf("550", "1000").toString(), "0.55");
  assert.equal(shareOf("0", "1000").toString(), "0", "分子为 0 时占比是 0%（一个真数）");
  assert.equal(shareOf("550", "0"), null, "合计为 0 时留空 —— 老表这里是 #DIV/0!，不写那个");
  assert.equal(shareOf("550", null), null);
  assert.equal(Number.isNaN(shareOf("550", "0")), false);
});

/* ------------------------------------------------------------------ 单位归一 */

test("单位归一：支/只/个/把 与 pcs/pc/piece/pieces 是同一个单位，打/dz/doz/dozen 是另一个", () => {
  for (const unit of ["支", "只", "个", "把", "pcs", "pc", "piece", "pieces", "PCS", " 支 "]) {
    assert.equal(normalizeAllocationUnit(unit), "piece", unit);
  }
  for (const unit of ["打", "dz", "doz", "dozen", "DZ", "Dozen"]) {
    assert.equal(normalizeAllocationUnit(unit), "dozen", unit);
  }
  // 末尾的 `.` / `。` 不算单位名的一部分：录入时带标点的写法必须归到同一个单位，
  // 否则「登记填打、日报写打.」会被判成两个单位，费率差 12 倍而表上完全看不出来。
  for (const unit of ["打.", "打。", " 打. ", "Dozen."]) {
    assert.equal(normalizeAllocationUnit(unit), "dozen", unit);
  }
  for (const unit of ["pcs.", "pcs。", " 支. ", "pieces。"]) {
    assert.equal(normalizeAllocationUnit(unit), "piece", unit);
  }
  assert.equal(normalizeAllocationUnit("kg"), "kg", "不在同义词表里的单位原样返回（不去猜）");
  assert.equal(normalizeAllocationUnit("码"), "码", "未知单位也原样返回");
  assert.equal(normalizeAllocationUnit(""), null);
  assert.equal(normalizeAllocationUnit(null), null);
  assert.equal(normalizeAllocationUnit(undefined), null);
  assert.equal(normalizeAllocationUnit("."), null, "只剩标点等于空单位");
});

test("单位一致性：同义写法算一致（含末尾标点）；打与支**不**一致；空单位不跟任何人一致", () => {
  assert.equal(allocationUnitMatches("支", "pcs"), true);
  assert.equal(allocationUnitMatches("打", "dozen"), true);
  assert.equal(allocationUnitMatches("打", "打."), true, "末尾标点只是录入噪声，同一个单位");
  assert.equal(allocationUnitMatches("打", "支"), false, "打与支之间没有换算式，绝不能套同一个费率");
  assert.equal(allocationUnitMatches("打", "kg"), false);
  assert.equal(allocationUnitMatches(null, "打"), false, "空单位不能「碰巧相等」，否则没填单位的订单会套上费率");
  assert.equal(allocationUnitMatches("打", null), false);
  assert.equal(allocationUnitMatches(null, null), false);
});

test("单位候选写法：归一标识还原成全部原始写法（含末尾标点），供 SQL IN 过滤", () => {
  assert.deepEqual(allocationUnitCandidates("打"), [
    "dz", "doz", "dozen", "打",
    "dz.", "doz.", "dozen.", "打.",
    "dz。", "doz。", "dozen。", "打。",
  ]);
  assert.deepEqual(allocationUnitCandidates("DZ"), allocationUnitCandidates("打"), "带标点的写法不能漏：SQL 的 IN 不做归一");
  assert.deepEqual(allocationUnitCandidates("打."), allocationUnitCandidates("打"), "标点写法自身也要能展开出同一批候选");
  assert.deepEqual(allocationUnitCandidates("支"), [
    "pcs", "pc", "piece", "pieces", "支", "只", "个", "把",
    "pcs.", "pc.", "piece.", "pieces.", "支.", "只.", "个.", "把.",
    "pcs。", "pc。", "piece。", "pieces。", "支。", "只。", "个。", "把。",
  ]);
  assert.deepEqual(allocationUnitCandidates("kg"), ["kg", "kg.", "kg。"]);
  assert.deepEqual(allocationUnitCandidates(null), []);
  for (const candidate of allocationUnitCandidates("打")) assert.equal(normalizeAllocationUnit(candidate), "dozen");
  for (const candidate of allocationUnitCandidates("支")) assert.equal(normalizeAllocationUnit(candidate), "piece");
});

test("单位同义词表与销售模块的 normalizeSpecUnit 不会各改一份（逐词比对两边结果）", () => {
  // 两份同义词表是**故意**重复的：`normalizeSpecUnit` 在 sales 服务文件里，
  // 从 finance 引它会把整个销售服务（Nest 装饰器 + Prisma）拖进这个纯口径模块。
  // 代价就是可能悄悄漂移 —— 这组向量就是那道闸：同义词表、trim、大小写、末尾标点的规则
  // 只要有任何一边改了，这里立刻红。
  const words = [
    ...allocationUnitCandidates("支"),
    ...allocationUnitCandidates("打"),
    "PCS.", "打.", "打。", " 支 ", "Dozen", "KG", "kg", " 打 ", " pcs ", "码", "米", "", null, undefined,
  ];
  for (const word of words) {
    assert.equal(
      normalizeAllocationUnit(word),
      normalizeSpecUnit(word),
      `「${String(word)}」在两份同义词表里归一结果不同`,
    );
  }
});

/* ------------------------------------------------------------------ 期间 */

test("期间字面量：只认 YYYY-MM", () => {
  assert.equal(isAllocationPeriod("2026-09"), true);
  assert.equal(isAllocationPeriod("2026-12"), true);
  assert.equal(isAllocationPeriod("2026-13"), false);
  assert.equal(isAllocationPeriod("2026-9"), false);
  assert.equal(isAllocationPeriod("2026-09-01"), false);
  assert.equal(isAllocationPeriod(""), false);
  assert.equal(isAllocationPeriod(null), false);
});

test("期间起止日：月末按日历算（平年 2 月 28 天、闰年 2 月 29 天）", () => {
  assert.deepEqual(allocationPeriodDays("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(allocationPeriodDays("2024-02"), { from: "2024-02-01", to: "2024-02-29" }, "2024 是闰年");
  assert.deepEqual(allocationPeriodDays("2026-09"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(allocationPeriodDays("2026-12"), { from: "2026-12-01", to: "2026-12-31" }, "跨年边界不能算成 30 天");
});

test("报表区间 → 分摊期间：先看起始日，没有起始日才看结束日", () => {
  assert.equal(allocationPeriodOf("2026-09-01", "2026-09-30"), "2026-09");
  // 跨月时**取起始月**：9/1–10/31 的报表如果取结束月，9 月的订单会被乘上 10 月的费率。
  assert.equal(allocationPeriodOf("2026-09-01", "2026-10-31"), "2026-09");
  assert.equal(allocationPeriodOf(null, "2026-09-30"), "2026-09");
  assert.equal(allocationPeriodOf(undefined, undefined), null);
  assert.equal(allocationPeriodOf("2026-13-01", "2026-09-30"), null, "起始月非法时不悄悄回落到结束月");
});

test("跨月判定：两端都有值且月份不同", () => {
  assert.equal(allocationSpansMonths("2026-09-01", "2026-10-01"), true);
  assert.equal(allocationSpansMonths("2026-09-01", "2026-09-30"), false);
  assert.equal(allocationSpansMonths("2026-09-01", null), false, "只给一端谈不上跨月");
  assert.equal(allocationSpansMonths(null, null), false);
});
