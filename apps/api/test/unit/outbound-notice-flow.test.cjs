const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
const { FinishedGoodsOutboundNoticeService } = require("../../dist/modules/sales/finished-goods-outbound-notice.service.js");
const { FinishedGoodsOutboundService } = require("../../dist/modules/warehouse/finished-goods-outbound.service.js");

// 成品出库通知链路（需求 4/6）：
//   成品入库 → 销售「通知仓库出库」（整批） → 仓库按通知生成出库单（整批） → 过账生成应收（通知财务收款）
// 口径：可出库 = 已过账入库 − 已过账/已发出/已签收出库 − 待办通知量；通知与出库都必须是整批。
const user = { id: "00000000-0000-0000-0000-000000000001", username: "tester" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => undefined };

function decimal(value) { return new Prisma.Decimal(value); }

function salesService(overrides = {}) {
  const balance = overrides.balance ?? decimal(50); // 库存事实余额（= 入库 − 出库 + 退货回仓）
  const prisma = {
    salesOrder: {
      findFirst: async () => ({ id: "so-1", orderNo: "SO-1", customerId: "customer-1", productName: "折叠伞", productSpec: "8K", quantity: decimal(100), unit: "把", settlementUnitPrice: decimal("12.5"), customer: { id: "customer-1", name: "海外客户" } }),
    },
    productionOrder: {
      findMany: async () => [{ id: "po-1", productionOrderNo: "MO-1", status: "completed", executionMode: "in_house", executionLocation: { name: "一车间" }, unitId: "unit-1", unit: { name: "把" }, plannedQuantity: decimal(100), productSpecification: "8K" }],
      findFirst: async () => ({ id: "po-1", productionOrderNo: "MO-1", unitId: "unit-1", productSpecification: "8K", unit: { name: "把" } }),
    },
    finishedGoodsInbound: { aggregate: async () => ({ _sum: { quantity: overrides.inbound ?? decimal(60) } }) },
    finishedGoodsOutbound: { aggregate: async () => ({ _sum: { quantity: overrides.outbound ?? decimal(0) } }) },
    finishedGoodsOutboundNotice: {
      aggregate: async () => ({ _sum: { noticeQuantity: overrides.pendingNotice ?? decimal(0) } }),
      findMany: async () => overrides.notices ?? [],
      findFirst: async () => overrides.existingNotice ?? null,
      create: async ({ data }) => { overrides.created?.push(data); return { id: "notice-1", ...data }; },
      update: async ({ data }) => ({ id: "notice-1", ...data }),
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => undefined,
      productionOrder: { findFirst: async () => ({ id: "po-1", unitId: "unit-1", productSpecification: "8K", unit: { name: "把" } }) },
      finishedGoodsInbound: { aggregate: async () => ({ _sum: { quantity: overrides.inbound ?? decimal(60) } }) },
      finishedGoodsOutbound: { aggregate: async () => ({ _sum: { quantity: overrides.outbound ?? decimal(0) } }) },
      finishedGoodsOutboundNotice: { aggregate: async () => ({ _sum: { noticeQuantity: overrides.pendingNotice ?? decimal(0) } }), create: async ({ data }) => { overrides.created?.push(data); return { id: "notice-1", ...data }; } },
    }),
  };
  return new FinishedGoodsOutboundNoticeService(prisma, { finishedGoodsBalance: async () => balance }, audit);
}

test("销售订单成品情况：可出库 = 库存余额 − 待办通知量（退货回仓也会算进来）", async () => {
  const service = salesService({ inbound: decimal(60), outbound: decimal(10), pendingNotice: decimal(20), balance: decimal(50) });
  const summary = await service.summary("so-1");
  const row = summary.production_orders[0];
  assert.equal(row.inbound_quantity, "60");
  assert.equal(row.outbound_quantity, "10");
  assert.equal(row.pending_notice_quantity, "20");
  assert.equal(row.available_quantity, "30");
  assert.equal(summary.settlement_unit_price, "12.5");
});

test("客户退货回到成品仓后，可出库量随之增加（按库存余额而不是硬算入库−出库）", async () => {
  // 入库 60、出库 10，但有一笔退货 5 回到成品仓 → 余额 55，扣掉待办通知 20 = 可出库 35
  const service = salesService({ inbound: decimal(60), outbound: decimal(10), pendingNotice: decimal(20), balance: decimal(55) });
  const summary = await service.summary("so-1");
  assert.equal(summary.production_orders[0].available_quantity, "35");
});

test("通知出库按可出库量建整批通知", async () => {
  const created = [];
  const service = salesService({ inbound: decimal(60), outbound: decimal(10), created });
  const notices = await service.createNotices("so-1", { remark: "整批发货" }, user);
  assert.equal(notices.length, 1);
  assert.equal(created[0].noticeQuantity.toString(), "50", "通知数量必须等于当时可出库量（整批）");
  assert.equal(created[0].status, "pending");
  assert.equal(created[0].outboundQuantity.toString(), "10");
});

test("没有可出库成品时给出可执行的 422，而不是静默成功", async () => {
  const service = salesService({ inbound: decimal(60), outbound: decimal(0), pendingNotice: decimal(60) });
  await assert.rejects(
    () => service.createNotices("so-1", {}, user),
    (error) => {
      assert.ok(error instanceof UnprocessableEntityException);
      assert.equal(error.getResponse().code, "OUTBOUND_NOTICE_NOTHING_TO_NOTIFY");
      assert.match(error.getResponse().message, /成品入库/);
      return true;
    },
  );
});

test("通知出库支持幂等键：重复提交返回同一张通知", async () => {
  const existing = { id: "notice-1", noticeNo: "OGN-1" };
  const service = salesService({ existingNotice: existing });
  const notices = await service.createNotices("so-1", { idempotency_key: "web-1" }, user);
  assert.deepEqual(notices, [existing]);
});

test("仓库按通知生成出库单：数量固定取通知数量（整批），并回填出库单号", async () => {
  const notice = { id: "notice-1", noticeNo: "OGN-1", status: "pending", orderNo: "SO-1", salesOrderId: "so-1", productionOrderId: "po-1", unitId: "unit-1", noticeQuantity: decimal(50), productNameSnapshot: "折叠伞", productSpecificationSnapshot: "8K" };
  const updates = [];
  const tx = {
    $queryRaw: async () => undefined,
    finishedGoodsOutboundNotice: { findFirst: async () => notice, update: async ({ data }) => { updates.push(data); return { ...notice, ...data }; } },
    finishedGoodsOutbound: { create: async ({ data }) => ({ id: "outbound-1", ...data }) },
  };
  const prisma = { finishedGoodsOutboundNotice: { findFirst: async () => notice }, finishedGoodsOutbound: { create: async () => ({ id: "outbound-1" }) }, $transaction: async (fn) => fn(tx) };
  const service = new FinishedGoodsOutboundService(prisma, audit, { finishedGoodsBalance: async () => decimal(50) });
  const outbound = await service.createOutboundFromNotice("notice-1", user);
  assert.equal(outbound.quantity.toString(), "50");
  assert.equal(updates[0].status, "outbound_created");
  assert.equal(updates[0].outboundId, "outbound-1");
});

test("通知已建单/已完成时不能重复生成出库单", async () => {
  const notice = { id: "notice-1", status: "outbound_created", productionOrderId: "po-1", unitId: "unit-1", noticeQuantity: decimal(50) };
  const service = new FinishedGoodsOutboundService({ finishedGoodsOutboundNotice: { findFirst: async () => notice } }, audit, { finishedGoodsBalance: async () => decimal(50) });
  await assert.rejects(
    () => service.createOutboundFromNotice("notice-1", user),
    (error) => error.getResponse().code === "OUTBOUND_NOTICE_NOT_PENDING",
  );
});

test("手动建出库单也必须整批：数量不等于当前可用量直接 422", async () => {
  const refs = { sales: { id: "so-1", orderNo: "SO-1", quantity: decimal(100), unit: "把", productName: "折叠伞", productSpec: "8K" }, production: { id: "po-1", unitId: "unit-1", salesOrderId: "so-1", orderNo: "SO-1" } };
  const prisma = { salesOrder: { findFirst: async () => refs.sales }, productionOrder: { findFirst: async () => refs.production }, finishedGoodsOutbound: { create: async () => ({ id: "outbound-1" }) } };
  const service = new FinishedGoodsOutboundService(prisma, audit, { finishedGoodsBalance: async () => decimal(60) });
  await assert.rejects(
    () => service.createOutbound({ sales_order_id: "so-1", production_order_id: "po-1", quantity: "30" }, user),
    (error) => {
      assert.equal(error.getResponse().code, "FINISHED_GOODS_OUTBOUND_MUST_BE_FULL_BATCH");
      assert.deepEqual(error.getResponse().details, [{ available_quantity: "60", requested_quantity: "30" }]);
      return true;
    },
  );
});

test("出库过账后：生成应收来源草稿（按结算币价）并把通知置为 completed", async () => {
  const outbound = { id: "outbound-1", status: "draft", productionOrderId: "po-1", unitId: "unit-1", quantity: decimal(50), orderNo: "SO-1", salesOrderId: "so-1", productNameSnapshot: "折叠伞", productSpecificationSnapshot: "8K", signedAt: null, riskReason: null };
  const receivableWrites = [];
  const noticeUpdates = [];
  const tx = {
    $queryRaw: async () => undefined,
    inventoryFact: { findFirst: async () => null, create: async () => undefined },
    finishedGoodsOutbound: { update: async ({ data }) => ({ ...outbound, ...data }), aggregate: async () => ({ _sum: { quantity: decimal(0) } }) },
    salesOrder: { findUnique: async () => ({ id: "so-1", customerId: "customer-1", unit: "把", unitPrice: decimal(10), settlementUnitPrice: decimal("12.5"), taxRate: null, currency: "USD", quantity: decimal(100) }) },
    receivableSource: { create: async ({ data }) => { receivableWrites.push(data); return data; } },
    finishedGoodsOutboundNotice: { updateMany: async ({ data }) => { noticeUpdates.push(data); return { count: 1 }; } },
  };
  const prisma = { finishedGoodsOutbound: { findFirst: async () => outbound, aggregate: async () => ({ _sum: { quantity: decimal(0) } }) }, $transaction: async (fn) => fn(tx) };
  const service = new FinishedGoodsOutboundService(prisma, audit, { finishedGoodsBalance: async () => decimal(50) });
  await service.postOutbound("outbound-1", user);
  assert.equal(receivableWrites.length, 1, "出库过账必须生成应收来源草稿（通知财务收款）");
  assert.equal(receivableWrites[0].unitPrice.toString(), "12.5", "应收按销售单的结算币价计价");
  assert.equal(receivableWrites[0].amount.toString(), "625");
  assert.equal(receivableWrites[0].status, "draft");
  assert.equal(noticeUpdates[0].status, "completed", "来源出库通知要置为已完成");
});

test("出库冲销后：来源通知退回待处理，仓库可以重新建单", async () => {
  const outbound = { id: "outbound-1", status: "posted", productionOrderId: "po-1", unitId: "unit-1", quantity: decimal(50), orderNo: "SO-1", salesOrderId: "so-1", productNameSnapshot: "折叠伞", productSpecificationSnapshot: "8K", remark: null };
  const noticeUpdates = [];
  const tx = {
    $queryRaw: async () => undefined,
    inventoryFact: { findFirst: async () => null, create: async () => undefined },
    finishedGoodsOutbound: { update: async ({ data }) => ({ ...outbound, ...data }) },
    receivableSource: { findFirst: async () => null },
    finishedGoodsOutboundNotice: { updateMany: async ({ data }) => { noticeUpdates.push(data); return { count: 1 }; } },
  };
  const prisma = { finishedGoodsOutbound: { findFirst: async () => outbound }, $transaction: async (fn) => fn(tx) };
  const service = new FinishedGoodsOutboundService(prisma, audit, {});
  await service.reverseOutbound("outbound-1", "发错货", user);
  assert.equal(noticeUpdates[0].status, "pending");
  assert.equal(noticeUpdates[0].outboundId, null);
});
