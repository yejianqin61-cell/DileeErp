// 开发用：用示例数据生成 领料单 / 补料单 / 采购订单 样例（不连接数据库），便于人工核对打印模板排版。
// 用法：node scripts/make-export-samples.cjs
const fs = require("node:fs");
const path = require("node:path");
const { Prisma } = require("@prisma/client");
const { MaterialSlipExportService } = require("../apps/api/dist/modules/production/material-slip-export.service.js");
const { PurchaseOrderExportService } = require("../apps/api/dist/modules/procurement/purchase-order-export.service.js");

const targetDir = path.join(__dirname, "..", "docs", "samples");
fs.mkdirSync(targetDir, { recursive: true });
const write = (name, buffer) => {
  const target = path.join(targetDir, name);
  fs.writeFileSync(target, buffer);
  console.log("written:", target, buffer.length, "bytes");
};

// ── 领料单 / 补料单 ──
// 核定用量按整单总量填写（BOM 编辑器里录入的就是整单数量），不是单件用量。
const productionOrder = {
  productionOrderNo: "MO-20260910-0001",
  orderNo: "DL260001",
  plannedQuantity: new Prisma.Decimal("500"),
  productSpecification: "22寸×8K",
  unit: { name: "把" },
  executionLocation: { name: "一车间" },
  salesOrder: { productName: "自动雨伞", productSpec: "22寸" },
  bom: {
    items: [
      { materialId: "m1", approvedUsage: new Prisma.Decimal("2500"), requiredQuantity: new Prisma.Decimal("2500"), specificationModel: "58cm", model: null, color: "黑色" },
      { materialId: "m2", approvedUsage: new Prisma.Decimal("500"), requiredQuantity: new Prisma.Decimal("500"), specificationModel: "EVA", model: null, color: "透明" }
    ]
  }
};
const slipBase = { productionOrderId: "order-1", createdBy: "user-1", productionOrder, productionOrderOperation: { operationNameSnapshot: "裁剪" } };

const issue = {
  ...slipBase,
  movementNo: "MI-20260910-8F3A21C7",
  documentType: "issue",
  status: "posted",
  createdAt: new Date("2026-09-10T02:30:00Z"),
  reason: null,
  remark: "第一批领料，裁剪工序",
  lines: [
    { materialId: "m1", unitId: "u1", quantity: new Prisma.Decimal("1200"), bomReferenceQuantity: new Prisma.Decimal("2500"), material: { name: "伞骨", materialCode: "M-001", specificationModel: "58cm", color: "黑色" }, unit: { name: "根" } },
    { materialId: "m2", unitId: "u2", quantity: new Prisma.Decimal("200"), bomReferenceQuantity: new Prisma.Decimal("500"), material: { name: "伞布", materialCode: "M-002", specificationModel: "EVA", color: "透明" }, unit: { name: "米" } },
    { materialId: "m3", unitId: "u3", quantity: new Prisma.Decimal("15"), bomReferenceQuantity: null, material: { name: "手柄", materialCode: "M-003", specificationModel: null, color: null }, unit: { name: "个" } }
  ]
};

const replenishment = {
  ...slipBase,
  movementNo: "MC-20260910-5B7C9D01",
  documentType: "replenishment",
  status: "posted",
  createdAt: new Date("2026-09-10T03:10:00Z"),
  reason: "伞布原始坏片 12 米，需补领",
  remark: null,
  lines: [
    { materialId: "m2", unitId: "u2", quantity: new Prisma.Decimal("12"), bomReferenceQuantity: new Prisma.Decimal("500"), material: { name: "伞布", materialCode: "M-002", specificationModel: "EVA", color: "透明" }, unit: { name: "米" } }
  ]
};

const facts = { m1: new Prisma.Decimal("-1500"), m2: new Prisma.Decimal("-320"), m3: new Prisma.Decimal("-15") };
const slipPrisma = (movement) => ({
  rawMaterialMovement: { findFirst: async () => movement, findMany: async () => [movement] },
  user: { findFirst: async () => ({ displayName: "张三" }) },
  inventoryFact: { aggregate: async ({ where }) => ({ _sum: { quantityDelta: facts[where.materialId] ?? new Prisma.Decimal(0) } }) }
});

// ── 采购订单 ──
const purchaseOrder = {
  id: "po-1",
  purchaseOrderNo: "PO-20260910-1234ABCD",
  orderNo: "DL260001",
  status: "ordered",
  createdAt: new Date("2026-09-10T01:20:00Z"),
  updatedAt: new Date("2026-09-10T02:40:00Z"),
  createdBy: "user-1",
  updatedBy: "user-2",
  remark: "含税价；交期如有变动请在一天内回复。",
  expectedDate: new Date("2026-09-20T00:00:00Z"),
  supplier: { name: "某某五金厂", contactName: "李经理", phone: "13800000000" },
  items: [
    { materialSnapshot: { name: "伞骨" }, model: "58cm", quantity: new Prisma.Decimal("2500"), unitPrice: new Prisma.Decimal("1.25"), amount: new Prisma.Decimal("3125.0000"), expectedDate: new Date("2026-09-18T00:00:00Z"), material: { name: "伞骨", specificationModel: "58cm" }, unit: { name: "根" }, supplier: { name: "某某五金厂" } },
    { materialSnapshot: { name: "伞布" }, model: "EVA 190T", quantity: new Prisma.Decimal("500"), unitPrice: new Prisma.Decimal("6.5"), amount: new Prisma.Decimal("3250.0000"), expectedDate: null, material: { name: "伞布", specificationModel: "EVA" }, unit: { name: "米" }, supplier: { name: "某某纺织厂" } },
    { materialSnapshot: { name: "手柄" }, model: null, quantity: new Prisma.Decimal("500"), unitPrice: new Prisma.Decimal("0.85"), amount: new Prisma.Decimal("425.0000"), expectedDate: new Date("2026-09-20T00:00:00Z"), material: { name: "手柄", specificationModel: "直柄" }, unit: { name: "个" }, supplier: { name: "某某五金厂" } }
  ]
};
const purchasePrisma = {
  purchaseOrder: { findFirst: async () => purchaseOrder, findMany: async () => [purchaseOrder] },
  user: { findMany: async () => [{ id: "user-1", displayName: "王采购" }, { id: "user-2", displayName: "赵主管" }] }
};

(async () => {
  write("领料单-样例.xlsx", await new MaterialSlipExportService(slipPrisma(issue)).exportSlip("issue-1"));
  write("补料单-样例.xlsx", await new MaterialSlipExportService(slipPrisma(replenishment)).exportSlip("replenishment-1"));
  write("采购订单-样例.xlsx", await new PurchaseOrderExportService(purchasePrisma).exportOrder("po-1"));
})();
