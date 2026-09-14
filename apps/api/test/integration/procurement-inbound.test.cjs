// 采购链路集成测试：BOM → 采购单 → 分批到货 → 来料 QC → 入库通知 → 接收 → 原料入库 → 过账 → 应付来源。
//
// 2026-09-13 重写说明：
//   本用例此前从未真正跑通过（夹具里 `notice` 用 const 声明在 try 内、finally 引用时抛
//   ReferenceError；即使修掉，手工插入 status="acknowledged" 的通知也不会与入库单建立关联，
//   过账必然 422 INBOUND_NOTICE_NOT_ACKNOWLEDGED）。
//   现改用 W1 夹具工厂 + 真实 service 驱动，业务顺序由代码而非人工约定保证：
//     采购建通知 → 仓库接收入库通知（创建并关联草稿入库单）→ 过账。
//   断言意图全部保留，并补充了 order_no 贯穿与审计事件存在性。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { RawMaterialInboundsService } = require("../../dist/modules/procurement/raw-material-inbounds.service.js");
const { RawMaterialInboundNoticesService } = require("../../dist/modules/procurement/raw-material-inbound-notices.service.js");
const { InventoryService } = require("../../dist/platform/inventory/inventory.service.js");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { assertAuditEventRecorded, assertInventoryFacts, assertNoDuplicateSource, assertOrderNo } = require("../../../../tests/helpers/business-invariants.cjs");
const { requireTestDatabaseUrl } = require("../../../../tests/helpers/test-context.cjs");
const { createFactories } = require("../../../../tests/fixtures/factories.cjs");

test("procurement.inbound.post_generates_inventory_and_a_single_payable_source", async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const fx = createFactories({ prisma, prefix: "procurement" });
  const user = fx.actor();
  const audit = new AuditService(prisma);
  const inventory = new InventoryService();
  const inbounds = new RawMaterialInboundsService(prisma, audit, inventory);
  const notices = new RawMaterialInboundNoticesService(prisma, audit, inbounds);
  try {
    const chain = await fx.procurementChain();

    // 采购侧创建入库通知，仓库侧接收。
    // 接收这一步会在事务内补建草稿入库单并回写 inboundNoticeId（raw-material-inbound-notices.service.ts:92-93），
    // 这正是过账前置校验所依赖的关联。
    const notice = fx.track("rawMaterialInboundNotice", await notices.createFromInspection(chain.inspection.id, "采购链集成测试", user));
    assert.equal(notice.status, "pending");
    await notices.acknowledge(notice.id, user);

    const draft = await prisma.rawMaterialInbound.findFirst({ where: { deletedAt: null, incomingInspectionId: chain.inspection.id } });
    assert.ok(draft, "接收通知必须产出草稿入库单");
    assert.equal(draft.inboundNoticeId, notice.id);
    assert.equal(draft.status, "draft");
    fx.track("rawMaterialInbound", draft);

    // 过账：重复过账必须被拒（幂等护栏）
    await inbounds.post(draft.id, user);
    await assert.rejects(() => inbounds.post(draft.id, user), (error) => error.getResponse().code === "INVALID_INBOUND_STATE");

    const posted = await prisma.rawMaterialInbound.findUnique({ where: { id: draft.id }, include: { inventoryFacts: true, payableSources: true } });
    assert.equal(posted.status, "posted");

    // 6.1 身份与来源：order_no 必须贯穿采购单、到货、QC、入库单与应付来源
    assertOrderNo("procurement order chain", fx.run.orderNo, [chain.purchaseOrder, chain.receipt, chain.inspection, posted, posted.payableSources[0]]);

    // 6.3 数量：库存事实与余额
    assertInventoryFacts("procurement posted inbound", posted.inventoryFacts, "10");
    assert.equal(posted.inventoryFacts[0].sourceType, "raw_material_inbound");
    assert.equal(posted.inventoryFacts[0].sourceId, draft.id);
    assert.equal(posted.inventoryFacts[0].orderNo, fx.run.orderNo);
    assert.equal(posted.inventoryFacts[0].unitId, chain.unit.id);
    assert.equal((await inventory.rawMaterialBalance(prisma, chain.material.id, chain.unit.id)).toString(), "10");

    // 幂等：一次过账只允许产生一条有效应付来源
    assertNoDuplicateSource("payable source idempotency", posted.payableSources);
    assert.equal(posted.payableSources.length, 1);
    assert.equal(posted.payableSources[0].status, "pending_finance");

    // 6.2 审计：过账必须留下审计事件（真的查表，而不只是看四个审计字段）
    const events = await fx.auditEvents();
    assertAuditEventRecorded("procurement inbound post audited", events, { action: "raw_material_inbound.post", entityId: draft.id });

    // 冲销保护：应付已确认后不得直接冲销入库
    const payableEntry = await prisma.supplierPayableEntry.create({
      data: {
        payableNo: `AP-${fx.run.id}`,
        orderNo: fx.run.orderNo,
        supplierId: chain.supplier.id,
        sourceType: "raw_material_inbound",
        payableSourceId: posted.payableSources[0].id,
        sourceNoSnapshot: posted.payableSources[0].id,
        quantity: "10",
        unitPrice: "2",
        amount: "20",
        currency: "USD",
        confirmationDate: new Date(),
        status: "confirmed",
        ...fx.audit.create(),
      },
    });
    fx.track("supplierPayableEntry", payableEntry);
    await assert.rejects(
      () => inbounds.reverse(draft.id, { reason: "已确认应付不得冲销" }, user),
      (error) => error.getResponse().code === "INBOUND_PAYABLE_ALREADY_CONFIRMED",
    );
  } finally {
    await fx.cleanup();
    await prisma.$disconnect();
  }
});
