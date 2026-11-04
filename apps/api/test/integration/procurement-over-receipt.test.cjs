// 超收（供应商多送）集成测试：真实 Postgres 上验证「质检查到实收 > 到货」时
// 到货批次会被抬到实收量，而采购单上的订购数量保持不变。
//
// 用户口径（2026-11-04）：采购伞布 1500 码、实际到货 1600 码 ——
// 「供应商会多送原料，但是系统不允许到货的大于订购数量。这点要允许。」
//
// 用 W1 夹具工厂建真实链路（客户→销售单→BOM→采购单→到货→质检），再驱动真实 service，
// 断言落在库里而不是 mock 的返回值上：数量、extension_data 标记、审计事件、订购量不变。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { IncomingInspectionsService } = require("../../dist/modules/procurement/incoming-inspections.service.js");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { assertAuditEventRecorded } = require("../../../../tests/helpers/business-invariants.cjs");
const { requireTestDatabaseUrl } = require("../../../../tests/helpers/test-context.cjs");
const { createFactories } = require("../../../../tests/fixtures/factories.cjs");

test("procurement.over_receipt.inspection_raises_receipt_to_actual_quantity", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const fx = createFactories({ prisma, prefix: "overreceipt" });
  const user = fx.actor();
  const audit = new AuditService(prisma);
  const inspections = new IncomingInspectionsService(prisma, audit);
  try {
    // 采购 10，到货先登记 10，质检尚未登记（pending / 0）。
    const chain = await fx.procurementChain({ inspection: { inspectedQuantity: "0", acceptedQuantity: "0", conditionalQuantity: "0", rejectedQuantity: "0", status: "pending", qcResult: null } });
    assert.equal(chain.item.quantity.toString(), "10", "夹具的采购数量应为 10");
    assert.equal(chain.receipt.quantity.toString(), "10", "到货先按 10 登记");

    // 质检实收 12：不再被「累计检验数量不能超过到货数量」拦下。
    const inspection = await inspections.create({
      purchase_receipt_id: chain.receipt.id,
      inspected_quantity: "12",
      accepted_quantity: "12",
      conditional_quantity: "0",
      rejected_quantity: "0",
      remark: "供应商多送 2 米",
    }, user);
    assert.equal(inspection.inspectedQuantity.toString(), "12");
    assert.equal(inspection.status, "accepted");

    // 到货批次被抬到实收量，并留下超收标记（原数量留在 corrected_from）。
    const receipt = await prisma.purchaseReceipt.findUnique({ where: { id: chain.receipt.id } });
    assert.equal(receipt.quantity.toString(), "12", "到货数量应被修正为实收量");
    assert.equal(receipt.extensionData.over_receipt, true);
    assert.equal(receipt.extensionData.over_receipt_corrected_from, "10");
    assert.equal(receipt.extensionData.over_receipt_reason, "供应商多送 2 米");

    // 采购单上的订购数量不动：超收是「到货事实」，不是改单。
    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: chain.item.id } });
    assert.equal(item.quantity.toString(), "10", "订购数量不能被超收改写");

    // 超收修正必须可追溯。
    assertAuditEventRecorded("over receipt audited", await fx.auditEvents(), { action: "purchase_receipt.over_receipt", entityId: chain.receipt.id });
  } finally {
    await fx.cleanup();
    await prisma.$disconnect();
  }
});
