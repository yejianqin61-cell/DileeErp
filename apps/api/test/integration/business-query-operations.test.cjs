// P3-T6 真库对照：一条订单链路上的所有已开放 operation 都必须能经订单根验证执行，
// 关键数量与直接查询一致，且结果 JSON 不含非财务档位的财务红线词。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { requireTestDatabaseUrl } = require("../../../../tests/helpers/test-context.cjs");
const { createFactories } = require("../../../../tests/fixtures/factories.cjs");
const { assertOrderRoot } = require("../../dist/modules/business-query-agent/tools/order-root.js");
const { searchOrders, getOrderAlerts, getOrderTimeline } = require("../../dist/modules/business-query-agent/tools/order-query-tools.js");
const { getOrderOverview, getOrderStatus } = require("../../dist/modules/business-query-agent/tools/order-overview-tools.js");
const { getOrderAttachments } = require("../../dist/modules/business-query-agent/tools/attachment-tools.js");
const { getSalesOrder, getCustomer, getBom, getSalesReturns } = require("../../dist/modules/business-query-agent/tools/sales-query-tools.js");
const { getPurchasePlans, getPurchaseOrders, getReceipts, getIncomingInspections } = require("../../dist/modules/business-query-agent/tools/procurement-query-tools.js");
const { getProductionOrders, getOperationProgress, getOperationReports, getOutsourceFlow } = require("../../dist/modules/business-query-agent/tools/production-query-tools.js");
const { getRawMaterialBalance, getInventoryFacts, getMaterialMovements, getFinishedGoodsQc, getFinishedGoodsInbounds, getFinishedGoodsOutbounds } = require("../../dist/modules/business-query-agent/tools/warehouse-query-tools.js");

const FINANCIAL_TERMS = /unit_price|total_amount|amount|currency|price|payable|receivable|salary|wage|bank|settlement|balance_cny/i;

test("business query P3：同一订单的 24 个非财务 operation 可读、关键数量对齐且不泄财务字段", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const fx = createFactories({ prisma, prefix: "bqops" });
  try {
    const chain = await fx.productionChain();
    const supplier = await fx.createSupplier();
    const purchaseOrder = await fx.createPurchaseOrder({ salesOrder: chain.salesOrder, bom: chain.bom, supplier });
    const item = await fx.createPurchaseOrderItem(purchaseOrder, { material: chain.material, unit: chain.unit, bomItem: chain.bomItem, supplier });
    const receipt = await fx.createReceipt(purchaseOrder, item);
    await fx.createIncomingInspection(receipt);
    await fx.seedInventoryFact({ material: chain.material, unit: chain.unit, quantity: "10" });

    const root = await assertOrderRoot(prisma, fx.run.orderNo);
    const results = [
      await searchOrders(prisma, { q: fx.run.orderNo, page: 1 }),
      await getOrderOverview(prisma, root), await getOrderStatus(prisma, root), await getOrderTimeline(prisma, root, 1), await getOrderAlerts(prisma, root, 1), await getOrderAttachments(prisma, root),
      await getSalesOrder(prisma, root), await getCustomer(prisma, root), await getBom(prisma, root, 1), await getSalesReturns(prisma, root, 1),
      await getPurchasePlans(prisma, root, 1), await getPurchaseOrders(prisma, root, 1), await getReceipts(prisma, root, 1), await getIncomingInspections(prisma, root, 1),
      await getProductionOrders(prisma, root), await getOperationProgress(prisma, root), await getOperationReports(prisma, root, 1), await getOutsourceFlow(prisma, root),
      await getRawMaterialBalance(prisma, root), await getInventoryFacts(prisma, root, 1), await getMaterialMovements(prisma, root, 1), await getFinishedGoodsQc(prisma, root, 1), await getFinishedGoodsInbounds(prisma, root, 1), await getFinishedGoodsOutbounds(prisma, root, 1),
    ];
    assert.equal(results.length, 24);
    for (const result of results) assert.doesNotMatch(JSON.stringify(result), FINANCIAL_TERMS, "operational 结果不能含财务字段");
    assert.equal(results[0][0].order_no, fx.run.orderNo);
    assert.equal(results[6].data.quantity, chain.salesOrder.quantity.toString());
    assert.equal(results[8].data[0].required_quantity, chain.bomItem.requiredQuantity.toString());
    assert.equal(results[11].data[0].ordered_quantity, item.quantity.toString());
    assert.equal(results[12].data[0].quantity, receipt.quantity.toString());
    assert.equal(results[14].data[0].planned_quantity, chain.productionOrder.plannedQuantity.toString());
    assert.equal(results[18].data[0].quantity, "10", "原料余额沿用库存事实全局聚合口径");
    assert.equal(results[19].data[0].quantity_delta, "10", "库存流水保留订单范围事实增减量");
  } finally {
    await fx.cleanup();
    await prisma.$disconnect();
  }
});
