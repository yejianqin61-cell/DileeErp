// W1 自测（需要真实 PostgreSQL）：夹具工厂、测试用户种子、不变量断言在真实库上协同工作。
//
// 这个文件有三重作用：
//   1. 验收 W1 地基建本身（夹具能建出合法状态、能清理干净、种子用户权限正确）；
//   2. 固化"入库通知 → 接收 → 登记入库 → 过账"的真实业务顺序
//      —— 旧集成用例正是漏掉"接收会创建并关联草稿入库单"这一环而永远 422
//      （见 docs/test/results/2026-09-13-w0-environment-unblock.md §5）；
//   3. 作为 P3 各链路用例的样板：夹具 + 真实 service + 不变量断言的写法。
//
// 运行：TEST_DATABASE_URL=<专用测试库> npm run test:integration
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { InventoryService } = require("../../dist/platform/inventory/inventory.service.js");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { RawMaterialInboundsService } = require("../../dist/modules/procurement/raw-material-inbounds.service.js");
const { RawMaterialInboundNoticesService } = require("../../dist/modules/procurement/raw-material-inbound-notices.service.js");
const { requireTestDatabaseUrl } = require("../../../../tests/helpers/test-context.cjs");
const { createFactories } = require("../../../../tests/fixtures/factories.cjs");
const { hashToken, seedTestUsers } = require("../../../../tests/fixtures/seed-users.cjs");
const {
  assertAllocationWithinBalance,
  assertAudit,
  assertAuditEventRecorded,
  assertChainConsistency,
  assertDecimalEquals,
  assertNoDuplicateSource,
  assertNoNegativeInventory,
  assertOrderNo,
  assertQcBalance,
  assertServerOwnsAuditFields,
} = require("../../../../tests/helpers/business-invariants.cjs");

const withPrisma = async (body) => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  try {
    return await body(prisma);
  } finally {
    await prisma.$disconnect();
  }
};

test("W1 fixtures build a rule-compliant procurement chain and leave no residue after cleanup", async () => {
  await withPrisma(async (prisma) => {
    const fx = createFactories({ prisma, prefix: "w1-chain" });
    let orderNo;
    try {
      const chain = await fx.procurementChain();
      orderNo = fx.run.orderNo;

      // 6.1 身份与来源：order_no 必须贯穿全部单据
      assertOrderNo("W1 chain order_no", orderNo, [chain.salesOrder, chain.bom, chain.purchaseOrder, chain.receipt, chain.inspection]);
      // 6.2 审计：四字段齐备，且 createdBy 必须是夹具的操作人（服务端口径）
      assertChainConsistency("W1 chain", { actorId: fx.actor().id, facts: [chain.salesOrder, chain.purchaseOrder, chain.receipt], orderNo });
      assertAudit("W1 chain audit", chain.inspection);
      assertServerOwnsAuditFields("W1 chain ownership", chain.purchaseOrder, fx.actor().id);
      // 6.3 数量：QC 分流必须自洽
      assertQcBalance("W1 chain qc split", chain.inspection);
      // 采购明细金额守恒：数量 × 单价 = 金额
      assertDecimalEquals("W1 purchase item amount", "20", String(Number(chain.item.quantity) * Number(chain.item.unitPrice)));
      // 上游引用完整性
      assert.equal(chain.bomItem.bomId, chain.bom.id);
      assert.equal(chain.item.bomItemId, chain.bomItem.id);
      assert.equal(chain.receipt.purchaseOrderItemId, chain.item.id);
      assert.equal(chain.inspection.purchaseReceiptId, chain.receipt.id);
    } finally {
      await fx.cleanup();
    }

    // 清理必须彻底：任何一张表残留都会毒化后续用例
    const residual = {
      boms: await prisma.bom.count({ where: { orderNo } }),
      customers: await prisma.customer.count({ where: { customerCode: `C-${fx.run.id}` } }),
      salesOrders: await prisma.salesOrder.count({ where: { orderNo } }),
      suppliers: await prisma.supplier.count({ where: { supplierCode: `S-${fx.run.id}` } }),
      units: await prisma.unit.count({ where: { name: `件-${fx.run.id}` } }),
    };
    assert.deepEqual(residual, { boms: 0, customers: 0, salesOrders: 0, suppliers: 0, units: 0 });
  });
});

test("W1 fixtures plus real services complete notice -> acknowledge -> draft -> post", async () => {
  await withPrisma(async (prisma) => {
    const fx = createFactories({ prisma, prefix: "w1-inbound" });
    const user = fx.actor();
    const audit = new AuditService(prisma);
    const inventory = new InventoryService();
    const inbounds = new RawMaterialInboundsService(prisma, audit, inventory);
    const notices = new RawMaterialInboundNoticesService(prisma, audit, inbounds);
    try {
      const chain = await fx.procurementChain();

      // 1) 采购创建入库通知
      const notice = fx.track("rawMaterialInboundNotice", await notices.createFromInspection(chain.inspection.id, "W1 自测", user));
      assert.equal(notice.status, "pending");

      // 2) 仓库接收通知 —— 关键：这一步会创建并关联草稿入库单
      await notices.acknowledge(notice.id, user);
      const acknowledged = await prisma.rawMaterialInboundNotice.findUnique({ where: { id: notice.id } });
      assert.equal(acknowledged.status, "acknowledged");
      assert.equal(acknowledged.receivedBy, user.id);

      const draft = await prisma.rawMaterialInbound.findFirst({ where: { deletedAt: null, incomingInspectionId: chain.inspection.id } });
      assert.ok(draft, "接收通知必须创建草稿入库单：否则过账会永远 422 INBOUND_NOTICE_NOT_ACKNOWLEDGED");
      assert.equal(draft.inboundNoticeId, notice.id, "草稿入库单必须回指通知，post() 依赖这个关联");
      assert.equal(draft.status, "draft");
      fx.track("rawMaterialInbound", draft);

      // 3) 过账：产生库存事实与应付来源
      const posted = await inbounds.post(draft.id, user);
      assert.equal(posted.status, "posted");

      const facts = await prisma.inventoryFact.findMany({ where: { rawMaterialInboundId: draft.id } });
      assert.equal(facts.length, 1);
      assert.equal(facts[0].orderNo, fx.run.orderNo);
      assertDecimalEquals("W1 inbound inventory delta", "10", facts[0].quantityDelta.toString());
      assertDecimalEquals("W1 raw material balance", "10", (await inventory.rawMaterialBalance(prisma, chain.material.id, chain.unit.id)).toString());

      const payables = await prisma.payableSource.findMany({ where: { rawMaterialInboundId: draft.id, status: { not: "voided" } } });
      assert.equal(payables.length, 1, "一次过账只允许产生一条应付来源");
      assertNoDuplicateSource("W1 payable idempotency", payables);
      assertOrderNo("W1 payable source order_no", fx.run.orderNo, [payables[0]]);
      assertDecimalEquals("W1 payable amount", "20", payables[0].amount.toString());

      // 4) 审计事件确实落表（而不只是四个审计字段存在）
      //    注意：AuditService.record() 只写 details.order_no，recordWithOrderNo() 才写 orderNo 列，
      //    因此查询必须同时覆盖两者（夹具的 fx.auditEvents() 已封装这一口径）。
      const events = await fx.auditEvents();
      assert.ok(events.length > 0, "过账链路必须留下审计事件");
      assertAuditEventRecorded("W1 inbound post audited", events, { action: "raw_material_inbound.post", entityId: draft.id });
      assertAuditEventRecorded("W1 notice acknowledge audited", events, { action: "raw_material_inbound_notice.acknowledge", entityId: notice.id });
      assertAuditEventRecorded("W1 notice create audited", events, { action: "raw_material_inbound_notice.create" });

      // 已知审计缺口（显式记录，不静默放过）：
      //   接收通知时由 createDraftForInspection 在事务内补建的草稿入库单**没有** create 审计事件
      //   —— 该事件只在 RawMaterialInboundsService.create()（raw-material-inbounds.service.ts:125）里写。
      //   依据 docs/design/testing-system-and-tooling-plan.md:171「创建、编辑、状态动作、冲销和逻辑删除均有审计事件」，
      //   这是一处待修缺口。若下面这条断言开始失败（事件出现了），说明缺口已修复：
      //   请同步更新本断言并修订 docs/test/00-recon-backend-coverage.md。
      const draftCreateAudits = events.filter((event) => event.action === "raw_material_inbound.create");
      assert.equal(
        draftCreateAudits.length,
        0,
        "草稿入库单的 create 审计缺口已修复 —— 请更新本条断言与 recon 记录（这是预期的修复信号，不是回归）",
      );

      // 5) 重复过账必须被拒绝，且事实数量不增加（幂等）
      await assert.rejects(() => inbounds.post(draft.id, user), (error) => error.getResponse().code === "INVALID_INBOUND_STATE");
      assert.equal(await prisma.inventoryFact.count({ where: { rawMaterialInboundId: draft.id } }), 1);
      assert.equal(await prisma.payableSource.count({ where: { rawMaterialInboundId: draft.id } }), 1);

      // 6) 数量与金额不变量
      assertNoNegativeInventory("W1 inventory non-negative", facts);
      assertAllocationWithinBalance("W1 payable not over-allocated", [], payables[0].amount.toString());
    } finally {
      await fx.cleanup();
    }
  });
});

test("W1 seeded test users carry the documented RBAC shape and usable sessions", async () => {
  await withPrisma(async (prisma) => {
    const seeded = await seedTestUsers(prisma, { prefix: "w1-users" });
    try {
      // 角色齐全（含一个无任何模块权限的登录用户，用于 403「无模块访问权限」断言）
      for (const name of ["administrator", "sales", "procurement", "warehouse", "finance", "production", "hr", "noModule"]) {
        assert.ok(seeded.users[name], `missing seeded user: ${name}`);
        assert.equal(seeded.users[name].isActive, true);
        assert.ok(seeded.credentials[name].username.endsWith(seeded.run.id));
      }

      // 模块权限形状：操作员角色必须恰好带上自己的模块，且不能多带
      const roleModules = async (userName) => {
        const rows = await prisma.userRole.findMany({
          where: { userId: seeded.users[userName].id },
          include: { role: { include: { permissions: true } } },
        });
        return rows.flatMap((row) => row.role.permissions.map((permission) => permission.moduleKey)).sort();
      };
      assert.deepEqual(await roleModules("sales"), ["sales"]);
      assert.deepEqual(await roleModules("warehouse"), ["warehouse"]);
      assert.deepEqual(await roleModules("finance"), ["finance"]);
      // 无权限用户：登录可以成功，但任何带 @RequireModules 的接口都必须 403
      assert.deepEqual(await roleModules("noModule"), []);
      // 管理员靠 role.key === "administrator" 短路（module-permission.guard.ts:22），不需要权限行
      const adminRoles = await prisma.userRole.findMany({ where: { userId: seeded.users.administrator.id }, include: { role: true } });
      assert.deepEqual(adminRoles.map((row) => row.role.key), ["administrator"]);

      // 会话：tokenHash 必须是 sha256(token)（auth.service.ts:122）
      const session = await seeded.createSession("sales");
      const stored = await prisma.session.findFirst({ where: { tokenHash: hashToken(session.token) } });
      assert.ok(stored, "session row must be addressable by sha256(token)");
      assert.equal(stored.userId, seeded.users.sales.id);
      assert.ok(stored.expiresAt.getTime() > Date.now());
      assert.equal(session.cookie, `dilee_session=${session.token}`);
    } finally {
      await seeded.cleanup();
    }

    // 清理彻底：用户、角色、角色权限都不留下
    const leftovers = await prisma.user.count({ where: { username: { endsWith: seeded.run.id } } });
    assert.equal(leftovers, 0);
    const leftoverRoles = await prisma.role.count({ where: { key: { endsWith: seeded.run.id } } });
    assert.equal(leftoverRoles, 0);
    const leftoverPermissions = await prisma.rolePermission.count({ where: { roleKey: { endsWith: seeded.run.id } } });
    assert.equal(leftoverPermissions, 0);
    // 共享的 administrator 角色必须被保留（其他种子与部署都依赖它）
    assert.ok(await prisma.role.findUnique({ where: { key: "administrator" } }));
  });
});
