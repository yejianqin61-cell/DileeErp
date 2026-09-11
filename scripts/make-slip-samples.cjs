// 开发用：用示例数据生成领料单/补料单样例（不连接数据库），便于人工核对打印模板排版。
// 用法：node scripts/make-slip-samples.cjs
const fs = require("node:fs");
const path = require("node:path");
const { Prisma } = require("@prisma/client");
const { MaterialSlipExportService } = require("../apps/api/dist/modules/production/material-slip-export.service.js");

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
const operation = { operationNameSnapshot: "裁剪" };
const base = { productionOrderId: "order-1", createdBy: "user-1", productionOrder, productionOrderOperation: operation, remark: null };

const issue = {
  ...base,
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
  ...base,
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
const prisma = {
  rawMaterialMovement: { findFirst: async () => issue, findMany: async () => [issue] },
  user: { findFirst: async () => ({ displayName: "张三" }) },
  inventoryFact: { aggregate: async ({ where }) => ({ _sum: { quantityDelta: facts[where.materialId] ?? new Prisma.Decimal(0) } }) }
};

(async () => {
  const service = new MaterialSlipExportService(prisma);
  const targetDir = path.join(__dirname, "..", "docs", "samples");
  fs.mkdirSync(targetDir, { recursive: true });
  const issueBuffer = await service.exportSlip("issue-1");
  fs.writeFileSync(path.join(targetDir, "领料单-样例.xlsx"), issueBuffer);

  const replenishmentPrisma = { ...prisma, rawMaterialMovement: { findFirst: async () => replenishment, findMany: async () => [replenishment] } };
  const replenishmentBuffer = await new MaterialSlipExportService(replenishmentPrisma).exportSlip("replenishment-1");
  fs.writeFileSync(path.join(targetDir, "补料单-样例.xlsx"), replenishmentBuffer);

  console.log("written:", path.join(targetDir, "领料单-样例.xlsx"), issueBuffer.length, "bytes");
  console.log("written:", path.join(targetDir, "补料单-样例.xlsx"), replenishmentBuffer.length, "bytes");
})();
