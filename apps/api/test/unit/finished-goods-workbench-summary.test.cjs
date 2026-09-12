const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { OrderWorkbenchService } = require("../../dist/modules/order-workbench/order-workbench.service.js");

// 工作台成品库存卡片要同时给出 成品存量 / 待入库 / 在途 / 已出库，
// 且「待入库」只能减掉「入库通知来源」的已过账量：历史 in_house_completion / 外加工回厂入库没有通知，
// 若一起减会算出负数（实测 -100）。
function build(overrides = {}) {
  const empty = async () => [];
  const prisma = {
    salesOrder: { findFirst: async () => ({ orderNo: "SO-1", status: "confirmed", currency: "CNY", quantity: new Prisma.Decimal("100"), customerSnapshot: {} }) },
    bom: { findMany: empty }, bomItem: { findMany: empty },
    purchaseOrder: { findMany: empty }, purchaseOrderItem: { findMany: empty },
    purchaseReceipt: { findMany: empty }, incomingInspection: { findMany: empty },
    productionOrder: { findMany: empty }, operationDailyReport: { findMany: empty }, rawMaterialMovement: { findMany: empty },
    rawMaterialInbound: { findMany: empty }, inventoryFact: { findMany: empty }, finishedGoodsQcRecord: { findMany: empty },
    finishedGoodsInbound: { findMany: empty }, finishedGoodsOutbound: { findMany: empty }, finishedGoodsInboundNotice: { findMany: empty },
    receivableSource: { findMany: empty }, customerPayment: { findMany: empty }, receivableAllocation: { findMany: empty },
    payableSource: { findMany: empty }, supplierPayableEntry: { findMany: empty }, supplierPayment: { findMany: empty }, supplierPaymentAllocation: { findMany: empty },
    ...overrides,
  };
  return { service: new OrderWorkbenchService(prisma, {}) };
}

test("工作台成品库存：通知量按「通知来源」的过账量扣减，不会出现负数待入库", async () => {
  const { service } = build({
    // 历史厂内完工入库（没有通知来源）100：不能拿它去抵通知量。
    finishedGoodsInbound: { findMany: async () => [{ id: "in-legacy", inboundNo: "FGI-LEGACY", status: "posted", quantity: new Prisma.Decimal("100"), submission: { sourceType: "in_house_completion" } }] },
    finishedGoodsInboundNotice: { findMany: async () => [{ id: "notice-1", noticeNo: "FGN-1", status: "partially_inbound", noticeQuantity: new Prisma.Decimal("40"), noticeDate: new Date("2026-09-10T00:00:00.000Z"), operationNameSnapshot: "包装" }] },
    inventoryFact: { findMany: async () => [
      { id: "f1", inventoryCategory: "finished_goods", quantityDelta: new Prisma.Decimal("100"), sourceId: "in-legacy" },
      { id: "f2", inventoryCategory: "defective_goods", quantityDelta: new Prisma.Decimal("5"), sourceId: "d-1" },
    ] },
    finishedGoodsOutbound: { findMany: async () => [{ id: "out-1", outboundNo: "FGO-1", status: "posted", quantity: new Prisma.Decimal("30") }] },
  });
  const summary = await service.summary("SO-1");
  const card = summary.finished_goods_inventory_summary;
  assert.equal(card.notified_quantity, "40");
  assert.equal(card.pending_inbound_quantity, "40", "历史入库不抵通知量，也不会变负数");
  assert.equal(card.stock_quantity, "100");
  assert.equal(card.defective_stock_quantity, "5");
  assert.equal(card.outbound_quantity, "30");
  assert.equal(card.notice_count, 1);
});

test("工作台成品库存：通知来源的过账入库会扣减待入库", async () => {
  const { service } = build({
    finishedGoodsInbound: { findMany: async () => [
      { id: "in-1", inboundNo: "FGI-1", status: "posted", quantity: new Prisma.Decimal("25"), submission: { sourceType: "finished_goods_inbound_notice" } },
      { id: "in-2", inboundNo: "FGI-2", status: "draft", quantity: new Prisma.Decimal("5"), submission: { sourceType: "finished_goods_inbound_notice" } },
      { id: "in-3", inboundNo: "FGI-3", status: "posted", quantity: new Prisma.Decimal("10"), submission: { sourceType: "in_house_completion" } },
    ] },
    finishedGoodsInboundNotice: { findMany: async () => [{ id: "notice-1", noticeNo: "FGN-1", status: "partially_inbound", noticeQuantity: new Prisma.Decimal("40"), noticeDate: new Date("2026-09-10T00:00:00.000Z"), operationNameSnapshot: "包装" }] },
  });
  const summary = await service.summary("SO-1");
  const card = summary.finished_goods_inventory_summary;
  assert.equal(card.posted_quantity, "35", "已入库仍是全部已过账（含历史）");
  assert.equal(card.noticed_posted_quantity, "25", "待入库只减通知来源的过账量");
  assert.equal(card.draft_quantity, "5");
  assert.equal(card.pending_inbound_quantity, "15");
});
