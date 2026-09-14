// BOM 原料成本服务测试（R5：销售利润报表的成本口径）。
//
// 这一层的两个风险都不是"算错数"，而是"悄悄少算"：
//   1) 缺采购价的物料被当成 0 成本 → 毛利虚高；
//   2) 取价取错（采购日期可空，PostgreSQL 的 DESC 默认 NULLS FIRST 会让没日期的单据顶掉近期价格）。
// 因此断言里既核对金额，也核对"缺什么必须被记下来"。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { BomMaterialCostService } = require("../../dist/modules/finance/finance-report-cost.service.js");

const dec = (value) => new Prisma.Decimal(value);

function stubPrisma({ boms = [], prices = [] } = {}) {
  const calls = { bom: [], purchaseOrderItem: [] };
  const prisma = {
    bom: { findMany: async (args) => { calls.bom.push(args); return boms; } },
    purchaseOrderItem: { findMany: async (args) => { calls.purchaseOrderItem.push(args); return prices; } },
  };
  return { prisma, calls };
}

function bomItem(overrides = {}) {
  return {
    materialId: "m-1",
    materialName: "中棒",
    approvedUsage: dec("2"),
    baseUsage: dec("2"),
    requiredQuantity: dec("2"),
    productionBatchBase: dec("1"),
    material: { materialCode: "WPTM1", name: "中棒" },
    ...overrides,
  };
}

const price = (materialId, unitPrice, purchaseDate, createdAt = purchaseDate) => ({
  materialId,
  unitPrice: dec(unitPrice),
  purchaseOrder: { purchaseDate: purchaseDate ? new Date(purchaseDate) : null, createdAt: new Date(createdAt) },
});

test("finance-report.cost：成本 = 单件用量 × 销售单数量 × 采购单价", async () => {
  const { prisma } = stubPrisma({
    boms: [{ salesOrderId: "so-1", items: [bomItem({ approvedUsage: dec("2") })] }],
    prices: [price("m-1", "5", "2026-09-01")],
  });
  const costs = await new BomMaterialCostService(prisma).materialCosts([{ salesOrderId: "so-1", quantity: dec("100") }]);
  assert.equal(costs.get("so-1").cost.toString(), "1000");
  assert.equal(costs.get("so-1").hasBom, true);
  assert.deepEqual(costs.get("so-1").missingPrice, []);
});

test("finance-report.cost：单件用量按生产批量基数折算（100 用量／基数 1000 → 单件 0.1）", async () => {
  const { prisma } = stubPrisma({
    boms: [{ salesOrderId: "so-1", items: [bomItem({ approvedUsage: dec("100"), productionBatchBase: dec("1000") })] }],
    prices: [price("m-1", "2", "2026-09-01")],
  });
  const costs = await new BomMaterialCostService(prisma).materialCosts([{ salesOrderId: "so-1", quantity: dec("1000") }]);
  assert.equal(costs.get("so-1").cost.toString(), "200");
});

test("finance-report.cost：批量基数为空或 0 时按 1 处理，不会除以 0", async () => {
  const { prisma } = stubPrisma({
    boms: [
      { salesOrderId: "so-1", items: [bomItem({ approvedUsage: dec("3"), productionBatchBase: null })] },
      { salesOrderId: "so-2", items: [bomItem({ approvedUsage: dec("3"), productionBatchBase: dec("0") })] },
    ],
    prices: [price("m-1", "1", "2026-09-01")],
  });
  const costs = await new BomMaterialCostService(prisma).materialCosts([
    { salesOrderId: "so-1", quantity: dec("10") },
    { salesOrderId: "so-2", quantity: dec("10") },
  ]);
  assert.equal(costs.get("so-1").cost.toString(), "30");
  assert.equal(costs.get("so-2").cost.toString(), "30");
});

test("finance-report.cost：核定用量缺失时回落到基准用量、再回落到需求数量", async () => {
  const { prisma } = stubPrisma({
    boms: [{ salesOrderId: "so-1", items: [bomItem({ approvedUsage: null, baseUsage: dec("4"), requiredQuantity: dec("9") })] }],
    prices: [price("m-1", "1", "2026-09-01")],
  });
  const costs = await new BomMaterialCostService(prisma).materialCosts([{ salesOrderId: "so-1", quantity: dec("1") }]);
  assert.equal(costs.get("so-1").cost.toString(), "4");
});

test("finance-report.cost：缺采购价的物料成本按 0 计入，但必须出现在缺失清单里", async () => {
  const { prisma } = stubPrisma({
    boms: [{ salesOrderId: "so-1", items: [bomItem({ materialId: "m-1" }), bomItem({ materialId: "m-2", material: { materialCode: "WPTM2", name: "伞骨" } })] }],
    prices: [price("m-1", "5", "2026-09-01")],
  });
  const costs = await new BomMaterialCostService(prisma).materialCosts([{ salesOrderId: "so-1", quantity: dec("10") }]);
  const result = costs.get("so-1");
  assert.equal(result.cost.toString(), "100", "只算有价的 m-1（2 × 10 × 5）");
  assert.deepEqual(result.missingPrice, [{ materialCode: "WPTM2", materialName: "伞骨" }], "缺价物料必须被记下来，否则毛利虚高看不出来");
});

test("finance-report.cost：没有 BOM 的销售单成本为 0 且标记 hasBom=false（导出时进表尾说明）", async () => {
  const { prisma } = stubPrisma({ boms: [], prices: [] });
  const costs = await new BomMaterialCostService(prisma).materialCosts([{ salesOrderId: "so-1", quantity: dec("10") }]);
  assert.equal(costs.get("so-1").cost.toString(), "0");
  assert.equal(costs.get("so-1").hasBom, false);
});

test("finance-report.cost：BOM 存在但没有明细时同样按「没有 BOM」处理", async () => {
  const { prisma } = stubPrisma({ boms: [{ salesOrderId: "so-1", items: [] }], prices: [] });
  const costs = await new BomMaterialCostService(prisma).materialCosts([{ salesOrderId: "so-1", quantity: dec("10") }]);
  assert.equal(costs.get("so-1").hasBom, false);
});

test("finance-report.cost：取价按采购日期取最近一次", async () => {
  const { prisma } = stubPrisma({
    boms: [{ salesOrderId: "so-1", items: [bomItem()] }],
    prices: [price("m-1", "5", "2026-01-01"), price("m-1", "7", "2026-03-01"), price("m-1", "6", "2026-02-01")],
  });
  const costs = await new BomMaterialCostService(prisma).materialCosts([{ salesOrderId: "so-1", quantity: dec("1") }]);
  assert.equal(costs.get("so-1").cost.toString(), "14", "取 2026-03-01 的单价 7（2 × 1 × 7）");
});

test("finance-report.cost：采购日期为空的单据按创建时间参与比较，且不会顶掉近期价格", async () => {
  const { prisma } = stubPrisma({
    boms: [{ salesOrderId: "so-1", items: [bomItem()] }],
    // 日期为空但创建时间很早：不应盖过 2026-03-01 的那条
    prices: [price("m-1", "99", null, "2025-01-01"), price("m-1", "7", "2026-03-01")],
  });
  const costs = await new BomMaterialCostService(prisma).materialCosts([{ salesOrderId: "so-1", quantity: dec("1") }]);
  assert.equal(costs.get("so-1").cost.toString(), "14");
});

test("finance-report.cost：采购日期为空且创建时间最新时按创建时间取（新物料常常只有草稿单有价）", async () => {
  const { prisma } = stubPrisma({
    boms: [{ salesOrderId: "so-1", items: [bomItem()] }],
    prices: [price("m-1", "5", "2026-01-01"), price("m-1", "8", null, "2026-06-01")],
  });
  const costs = await new BomMaterialCostService(prisma).materialCosts([{ salesOrderId: "so-1", quantity: dec("1") }]);
  assert.equal(costs.get("so-1").cost.toString(), "16");
});

test("finance-report.cost：取价只排除已取消的采购单，且只取未删除的明细", async () => {
  const { prisma, calls } = stubPrisma({ boms: [{ salesOrderId: "so-1", items: [bomItem()] }], prices: [] });
  await new BomMaterialCostService(prisma).materialCosts([{ salesOrderId: "so-1", quantity: dec("1") }]);
  const where = calls.purchaseOrderItem[0].where;
  assert.equal(where.deletedAt, null);
  assert.deepEqual(where.purchaseOrder, { deletedAt: null, status: { not: "cancelled" } }, "草稿采购单的报价也算报价，只排除已取消");
});

test("finance-report.cost：一批订单一共只查两次库（避免逐单 N+1）", async () => {
  const { prisma, calls } = stubPrisma({
    boms: [
      { salesOrderId: "so-1", items: [bomItem()] },
      { salesOrderId: "so-2", items: [bomItem()] },
      { salesOrderId: "so-3", items: [bomItem()] },
    ],
    prices: [price("m-1", "5", "2026-09-01")],
  });
  const costs = await new BomMaterialCostService(prisma).materialCosts([
    { salesOrderId: "so-1", quantity: dec("1") },
    { salesOrderId: "so-2", quantity: dec("1") },
    { salesOrderId: "so-3", quantity: dec("1") },
  ]);
  assert.equal(calls.bom.length, 1);
  assert.equal(calls.purchaseOrderItem.length, 1);
  assert.equal(costs.get("so-3").cost.toString(), "10");
});

test("finance-report.cost：同一物料在 BOM 里重复出现时，缺失清单按物料去重", async () => {
  const { prisma } = stubPrisma({
    boms: [{ salesOrderId: "so-1", items: [bomItem({ materialId: "m-9" }), bomItem({ materialId: "m-9" })] }],
    prices: [],
  });
  const costs = await new BomMaterialCostService(prisma).materialCosts([{ salesOrderId: "so-1", quantity: dec("1") }]);
  assert.equal(costs.get("so-1").missingPrice.length, 1);
});

test("finance-report.cost：没有订单时不查库", async () => {
  const { prisma, calls } = stubPrisma();
  const costs = await new BomMaterialCostService(prisma).materialCosts([]);
  assert.equal(costs.size, 0);
  assert.equal(calls.bom.length, 0);
  assert.equal(calls.purchaseOrderItem.length, 0);
});
