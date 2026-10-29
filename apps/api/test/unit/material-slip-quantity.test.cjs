const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { issuedBeforeQuantity, remainingQuantity } = require("../../dist/modules/production/material-slip-quantity.js");
const { MaterialSlipExportService } = require("../../dist/modules/production/material-slip-export.service.js");
const { RawMaterialMovementsService } = require("../../dist/modules/production/raw-material-movements.service.js");

// 领料单的四个数量（配料 / 已领 / 本次 / 余下）在**打印件**和**系统页面**上必须是同一组数字。
// 2026-10-29 之前页面显示的是「生产领用数量（含本单）」与「生产未领用（不含本单）」，
// 与打印件的「已领数量（不含本单）」「余下数量（减本次）」差一个本次领料量 ——
// 车间拿纸核对系统就会对不上。这组用例守两件事：
//   ① 口径函数本身的算法与边界（含超领负数、浮点、无配料数量）；
//   ② 导出服务与预估接口都走这一份实现，并且对**同一个业务状态**给出完全相同的四个数。

test("已领数量：草稿不扣本单，已过账要扣掉本单自己的数量", () => {
  // 草稿 / 待仓库出库：库存事实里还没有本单，净领料天然就是「本单之前」。
  assert.equal(issuedBeforeQuantity(4, 2, false), 4);
  // 已过账：净领料 6 里含本单自己的 2，扣掉才是本单之前的已领。
  assert.equal(issuedBeforeQuantity(6, 2, true), 4);
  // 净领料为 0（从没领过）：本单之前就是 0，不能因为扣本单变成负数。
  assert.equal(issuedBeforeQuantity(0, 0, true), 0);
});

test("余下数量 = 配料 − 已领 − 本次；超领原样返回负数，没有配料数量时留空", () => {
  assert.equal(remainingQuantity(5, 4, 2), -1, "超领 1 个：打印件与页面都显示 -1");
  assert.equal(remainingQuantity(10, 3, 7), 0);
  assert.equal(remainingQuantity(10, 3, 0), 7);
  assert.equal(remainingQuantity(null, 0, 2), null, "非 BOM 物料没有配料数量，余下必须留空而不是 0");
  // 浮点守卫：0.1 + 0.2 不能以 0.30000000000000004 的形式漏到页面上。
  assert.equal(issuedBeforeQuantity(0.1 + 0.2, 0, false), 0.3);
  assert.equal(remainingQuantity(0.3, 0, 0.1), 0.2);
});

/** 导出件侧：已过账的单据，净领料 6、本单 2 → 已领 4、余下 5−4−2 = −1。 */
async function exportLine(overrides = {}) {
  const { status = "posted", fact = "-6", ownQuantity = "2" } = overrides;
  const movement = {
    id: "movement-1",
    movementNo: "MI-20261029-0001",
    documentType: "issue",
    status,
    productionOrderId: "order-1",
    createdBy: "user-1",
    createdAt: new Date("2026-10-29T02:30:00Z"),
    reason: null,
    remark: null,
    productionOrder: {
      productionOrderNo: "MO-20261029-0001",
      orderNo: "DL260001",
      plannedQuantity: new Prisma.Decimal("100"),
      productSpecification: "22寸×8K",
      unit: { name: "把" },
      executionLocation: { name: "一车间" },
      salesOrder: { productName: "自动雨伞", productSpec: "22寸" },
      bom: { items: [{ materialId: "material-1", approvedUsage: new Prisma.Decimal("5"), requiredQuantity: new Prisma.Decimal("6"), specificationModel: "58cm", model: null, color: "黑色" }] }
    },
    productionOrderOperation: null,
    lines: [{ materialId: "material-1", unitId: "unit-1", quantity: new Prisma.Decimal(ownQuantity), bomReferenceQuantity: new Prisma.Decimal("6"), material: { name: "伞骨", materialCode: "M-001", specificationModel: "58cm", color: "黑色" }, unit: { name: "根" } }]
  };
  const prisma = {
    rawMaterialMovement: { findFirst: async () => movement },
    inventoryFact: { aggregate: async () => ({ _sum: { quantityDelta: new Prisma.Decimal(fact) } }) }
  };
  const service = new MaterialSlipExportService(prisma, { namesOf: async () => new Map([["user-1", "张三"]]) });
  return (await service.buildDocument("movement-1")).lines[0];
}

/** 预估侧：草稿状态（本单还没写库存事实），净领料 4 → 已领 4、余下 5−4−2 = −1。 */
async function previewLine(overrides = {}) {
  const { fact = "-4", ownQuantity = "2", approved = "5", required = "6" } = overrides;
  const prisma = {
    material: { findFirst: async () => ({ id: "material-1", name: "伞骨", materialCode: "M-001", materialType: "raw_material", defaultUnitId: "unit-1" }) },
    bomItem: { findFirst: async () => ({ approvedUsage: new Prisma.Decimal(approved), requiredQuantity: new Prisma.Decimal(required), unit: "根", specificationModel: "58cm", model: null, color: "黑色" }) },
    inventoryFact: { aggregate: async () => ({ _sum: { quantityDelta: new Prisma.Decimal(fact) } }) },
    purchaseOrderItem: { aggregate: async () => ({ _sum: { quantity: null } }) },
    rawMaterialInbound: { aggregate: async () => ({ _sum: { quantity: null } }) }
  };
  const inventory = { rawMaterialBalance: async () => new Prisma.Decimal("100") };
  const service = new RawMaterialMovementsService(prisma, {}, inventory);
  const result = await service.previewLines({ id: "order-1", orderNo: "DL260001", bomId: "bom-1" }, [{ material_id: "material-1", quantity: ownQuantity }]);
  return result.lines[0];
}

test("同一个业务状态：系统页面预估与导出件的四个数量完全一致", async () => {
  const exported = await exportLine();
  const previewed = await previewLine();
  const printed = [exported.bomQuantity, exported.issuedQuantity, exported.currentQuantity, exported.remainingQuantity];
  const shown = [previewed.material_quantity, previewed.issued_quantity, previewed.current_quantity, previewed.remaining_quantity];
  assert.deepEqual(printed, [5, 4, 2, -1], "导出件：配料 5、已领 4（不含本单）、本次 2、余下 -1");
  assert.deepEqual(shown, printed, "页面预估列必须与打印件逐项相等（此前差一个本次领料量）");
});

test("草稿与已过账的单据：页面显示「已领数量」都不含本单", async () => {
  // 已过账（事实含本单 2）：导出件扣掉本单；草稿（事实不含本单）不扣 —— 两条路径都得 4。
  const posted = await exportLine({ status: "posted", fact: "-6" });
  const draft = await exportLine({ status: "draft", fact: "-4" });
  assert.equal(posted.issuedQuantity, draft.issuedQuantity);
  assert.equal(posted.remainingQuantity, draft.remainingQuantity);
});

test("口径守卫：导出服务与预估接口都引用同一份 material-slip-quantity，不再各自算公式", () => {
  const sourceDir = path.join(__dirname, "..", "..", "src", "modules", "production");
  for (const file of ["material-slip-export.service.ts", "raw-material-movements.service.ts"]) {
    const source = fs.readFileSync(path.join(sourceDir, file), "utf8");
    assert.match(source, /from "\.\/material-slip-quantity"/, `${file} 必须从统一口径模块引入`);
    assert.match(source, /issuedBeforeQuantity\(/, `${file} 必须调用 issuedBeforeQuantity`);
  }
});
