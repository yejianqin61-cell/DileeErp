// 月度管理费分摊服务（财务 2026-09-20 第 4 条）。
//
// 无可用 PostgreSQL，因此用手写 Prisma 替身验证**服务层的规则**：期间唯一键下的 upsert（含把软删的
// 那条恢复回来）、费率/数量的派生、按单位过滤的自动数量、逻辑删除与审计。
// 纯口径（费率不四舍五入、单位归一、占比除零）见 overhead-allocation-domain.test.cjs。
const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { OverheadAllocationService } = require("../../dist/modules/finance/overhead-allocation.service.js");
const { allocationUnitCandidates } = require("../../dist/modules/finance/overhead-allocation.domain.js");

const audit = (events = []) => ({
  create: () => ({ createdBy: "user-1", updatedBy: "user-1" }),
  update: () => ({ updatedBy: "user-1" }),
  softDelete: () => ({ deletedAt: new Date("2026-09-20T00:00:00.000Z"), deletedBy: "user-1", updatedBy: "user-1" }),
  record: async (action, entityType, actorId, entityId, details) => { events.push({ action, entityId, details }); },
});

/**
 * 替身：`rows` 是库里的分摊记录（含已软删的），`dailyQuantity` 是本月计件日报数量合计。
 *
 * 每次 `create`/`update` 都写回 `rows`，所以同一个替身可以连做「新建 → 再 upsert」两步。
 */
function harness({ rows = [], dailyQuantity = null, aggregateArgs = [] } = {}) {
  const events = [];
  const store = [...rows];
  const prisma = {
    overheadAllocation: {
      findMany: async ({ where } = {}) => store.filter((row) => row.deletedAt === null && (!where?.period || row.period === where.period)),
      findFirst: async ({ where }) => store.find((row) => (where.id ? row.id === where.id : row.period === where.period) && (where.deletedAt === undefined || row.deletedAt === where.deletedAt)) ?? null,
      create: async ({ data }) => { const row = { id: `oa-${store.length + 1}`, deletedAt: null, ...data }; store.push(row); return row; },
      update: async ({ where, data }) => { const index = store.findIndex((row) => row.id === where.id); store[index] = { ...store[index], ...data }; return store[index]; },
    },
    employeeDailyReport: {
      aggregate: async (args) => { aggregateArgs.push(args); return { _sum: { quantity: dailyQuantity } }; },
    },
  };
  // upsert 在一个事务里做「查 + 写」，替身用同一个对象即可（真实库上的并发由 period 唯一键兜底）。
  prisma.$transaction = async (fn) => fn(prisma);
  return { service: new OverheadAllocationService(prisma, audit(events)), store, events, aggregateArgs };
}

const record = (extra = {}) => ({
  id: "oa-1", period: "2026-08", amount: new Prisma.Decimal("220000"), unit: "打",
  quantityOverride: null, remark: null,
  createdAt: new Date("2026-09-20T00:00:00.000Z"), updatedAt: new Date("2026-09-20T00:00:00.000Z"),
  createdBy: "user-1", updatedBy: "user-1", deletedAt: null, ...extra,
});

test("费率 = 总额 ÷ 自动汇总数量：22 万 ÷ 4000 打 = 55（财务给的例子）", async () => {
  const { service } = harness({ rows: [record()], dailyQuantity: new Prisma.Decimal("4000") });
  const resolved = await service.resolved("2026-08");
  assert.equal(resolved.auto_quantity, "4000");
  assert.equal(resolved.quantity, "4000");
  assert.equal(resolved.rate, "55");
  assert.equal(resolved.unit, "打");
});

test("人工覆盖的分摊数量优先于自动汇总值", async () => {
  const { service } = harness({ rows: [record({ quantityOverride: new Prisma.Decimal("3700") })], dailyQuantity: new Prisma.Decimal("4000") });
  const resolved = await service.resolved("2026-08");
  assert.equal(resolved.auto_quantity, "4000", "自动值仍如实回报，财务才能判断要不要覆盖");
  assert.equal(resolved.quantity, "3700");
  // 22 万 ÷ 3700 除不尽：**不四舍五入**，否则「单价 × 数量 ≠ 金额」。
  assert.equal(resolved.rate, new Prisma.Decimal("220000").div(new Prisma.Decimal("3700")).toString());
  assert.match(resolved.rate, /^59\.4594/);
});

test("自动数量按分摊单位过滤：单位是「打」时只统计以打为单位的计件日报", async () => {
  const { service, aggregateArgs } = harness({ rows: [record({ unit: "打" })], dailyQuantity: new Prisma.Decimal("100") });
  await service.resolved("2026-08");
  const where = aggregateArgs[0].where;
  assert.deepEqual(where.productionOrderOperation.unit.name.in, allocationUnitCandidates("打"), "同义词（含带末尾标点的写法）全部下推到 SQL 的 IN，而不是把整月日报读回内存");
  assert.equal(where.productionOrderOperation.unit.name.mode, "insensitive");
  assert.equal(where.deletedAt, null);
  assert.equal(where.reportDate.gte.toISOString(), "2026-08-01T00:00:00.000Z", "期间取整月（含首日零点）");
  assert.equal(where.reportDate.lte.toISOString(), "2026-08-31T23:59:59.999Z", "末日取到 23:59:59.999，否则当天填报的日报会全部落空");
});

test("期间没有登记时 resolved 返回 record=null 而不是 404（「还没录」是面板的初始状态）", async () => {
  const { service } = harness({ rows: [], dailyQuantity: new Prisma.Decimal("4000") });
  const resolved = await service.resolved("2026-08");
  assert.equal(resolved.record, null);
  assert.equal(resolved.rate, null, "没有总额就没有费率");
  // 没有单位（没有记录）时无从过滤自动数量，如实给 null 而不是编一个 0。
  assert.equal(resolved.auto_quantity, null);
});

test("分摊数量为 0 时费率是 null 而不是 0（算不出来与费率是 0 是两件事）", async () => {
  const { service } = harness({ rows: [record()], dailyQuantity: new Prisma.Decimal("0") });
  const resolved = await service.resolved("2026-08");
  assert.equal(resolved.quantity, "0");
  assert.equal(resolved.rate, null);
});

test("登记（新建）：按期间 upsert 并留下审计", async () => {
  const { service, store, events } = harness({ rows: [], dailyQuantity: new Prisma.Decimal("4000") });
  const saved = await service.upsert({ period: "2026-08", amount: "220000", unit: "打", remark: "22 万 ÷ 4000 打" }, { id: "user-1" });
  assert.equal(store.length, 1);
  assert.equal(store[0].amount.toString(), "220000");
  assert.equal(store[0].createdBy, "user-1");
  assert.equal(saved.rate, "55");
  assert.equal(events[0].action, "overhead_allocation.upsert");
  assert.equal(events[0].details.restored, false);
});

test("登记（同期间再存一次）：只更新那一条，不新建（两条并存会让「用哪条算费率」有歧义）", async () => {
  const { service, store } = harness({ rows: [record()], dailyQuantity: new Prisma.Decimal("4000") });
  await service.upsert({ period: "2026-08", amount: "180000", unit: "打" }, { id: "user-1" });
  assert.equal(store.length, 1, "唯一键在这个期间上，只能更新");
  assert.equal(store[0].amount.toString(), "180000");
});

test("登记：同期间那条被软删过时**恢复它**而不是新建（否则会直接撞唯一索引）", async () => {
  const deleted = record({ deletedAt: new Date("2026-09-19T00:00:00.000Z"), deletedBy: "user-2" });
  const { service, store, events } = harness({ rows: [deleted], dailyQuantity: new Prisma.Decimal("4000") });
  await service.upsert({ period: "2026-08", amount: "220000", unit: "打" }, { id: "user-1" });
  assert.equal(store.length, 1);
  assert.equal(store[0].id, "oa-1", "沿用原记录（同一个 id）");
  assert.equal(store[0].deletedAt, null);
  assert.equal(store[0].deletedBy, null);
  assert.equal(events[0].details.restored, true, "「删了又出现」要能被看见，否则看起来像幽灵数据");
});

test("登记：期间 / 金额 / 单位 / 数量覆盖的校验", async () => {
  const cases = [
    [{ period: "2026-13", amount: "1", unit: "打" }, "INVALID_OVERHEAD_PERIOD"],
    [{ period: "2026-8", amount: "1", unit: "打" }, "INVALID_OVERHEAD_PERIOD"],
    [{ period: "2026-08", amount: "0", unit: "打" }, "INVALID_OVERHEAD_AMOUNT"],
    [{ period: "2026-08", amount: "abc", unit: "打" }, "INVALID_OVERHEAD_AMOUNT"],
    [{ period: "2026-08", amount: "100", unit: "  " }, "OVERHEAD_UNIT_REQUIRED"],
    [{ period: "2026-08", amount: "100", unit: "打", quantity_override: "0" }, "INVALID_OVERHEAD_QUANTITY"],
  ];
  for (const [body, code] of cases) {
    const { service, store } = harness({});
    await assert.rejects(() => service.upsert(body, { id: "user-1" }), (error) => error.getResponse().code === code, code);
    assert.equal(store.length, 0, `${code}：拦下时不写库`);
  }
});

test("登记：数量覆盖传空串等于「回到自动值」（清掉覆盖，不是存一个 0）", async () => {
  const { service, store } = harness({ rows: [record({ quantityOverride: new Prisma.Decimal("3700") })], dailyQuantity: new Prisma.Decimal("4000") });
  const saved = await service.upsert({ period: "2026-08", amount: "220000", unit: "打", quantity_override: "" }, { id: "user-1" });
  assert.equal(store[0].quantityOverride, null);
  assert.equal(saved.quantity, "4000", "回到自动值");
});

test("删除：逻辑删除并留审计（记录与原因都还在）", async () => {
  const { service, store, events } = harness({ rows: [record()], dailyQuantity: new Prisma.Decimal("4000") });
  const deleted = await service.remove("oa-1", { id: "user-1" });
  assert.equal(deleted.deletedBy, "user-1");
  assert.equal(events[0].action, "overhead_allocation.delete");
  assert.equal(events[0].details.period, "2026-08");
  // 删掉之后这个期间就不再出现在列表里（核算表的管理费列随之留空）。
  assert.equal((await service.list()).length, 0);
  assert.equal(store.length, 1, "是软删除，行本身还在");
});

test("删除：不存在或已删除时 404", async () => {
  const { service } = harness({ rows: [] });
  await assert.rejects(() => service.remove("oa-x", { id: "user-1" }), (error) => error.getResponse().code === "OVERHEAD_ALLOCATION_NOT_FOUND");
});

test("列表：按期间过滤，且每条都带上派生的数量与费率", async () => {
  const { service } = harness({ rows: [record(), record({ id: "oa-2", period: "2026-07", amount: new Prisma.Decimal("110000") })], dailyQuantity: new Prisma.Decimal("4000") });
  const all = await service.list();
  assert.equal(all.length, 2);
  assert.equal(all.every((row) => row.rate !== null), true);
  const one = await service.list("2026-07");
  assert.equal(one.length, 1);
  assert.equal(one[0].rate, "27.5");
});

test("列表：期间参数非法时 422（而不是把 '2026-8' 当成一个查不到的期间静默返回空）", async () => {
  const { service } = harness({});
  await assert.rejects(() => service.list("2026-8"), (error) => error.getResponse().code === "INVALID_OVERHEAD_PERIOD");
});
