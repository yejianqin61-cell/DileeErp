// 生产单集成测试。
//
// 2026-09-13 修复说明：
//   两条用例都写于「包装工序自动追加」特性之前，且因环境长期阻断从未回归，因此：
//     - 新增生产单会自动补一道「包装」收尾工序（production-orders.service.ts:99），
//       于是 PRODUCTION_OPERATIONS_REQUIRED 不再会被 create() 之后的启动触发；
//     - 该自动工序先占 sequence_no = 1（同文件 :98），手工再加工序会撞唯一约束。
//   修复原则：**不弱化原有断言意图** —— 守卫仍要验证（改为先把工序软删再启动），
//   工序顺序改用批量接口自动分配，并把"包装工序必须在末尾"这一新规则显式断言出来。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PrismaClient } = require("@prisma/client");
const { ProductionOrdersService } = require("../../dist/modules/production/production-orders.service.js");
const { ProductionProgressService } = require("../../dist/modules/production/production-progress.service.js");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { requireTestDatabaseUrl } = require("../../../../tests/helpers/test-context.cjs");
const { createFactories } = require("../../../../tests/fixtures/factories.cjs");

const withFixtures = async (prefix, body) => {
  const prisma = new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } });
  const fx = createFactories({ prisma, prefix });
  // service 构造函数要的是真实 AuditService（带 record()），不是夹具里的审计字段工具。
  const audit = new AuditService(prisma);
  try {
    return await body({ audit, fx, prisma, user: fx.actor() });
  } finally {
    await fx.cleanup();
    await prisma.$disconnect();
  }
};

test("production.order.creates_from_confirmed_order_and_requires_operations_before_start", async () => {
  await withFixtures("production", async ({ audit, fx, prisma, user }) => {
    // 用 productionPrerequisites 而不是 productionChain：后者会先把该销售订单的主生产单建掉，
    // 而一个销售订单只允许一张标准主生产单，本用例要自己调用 create() 就会 409。
    const { unit, bom, location, outsourceSite, operation } = await fx.productionPrerequisites();
    const operation2 = await fx.createOperationCatalog(unit, { operationCode: `OP2-${fx.run.id}`, operationName: "裁剪" });

    const service = new ProductionOrdersService(prisma, audit);

    // ---- A. 守卫 PRODUCTION_OPERATIONS_REQUIRED 仍然有效 ----
    // 注意：建单会自动补包装工序，所以"建单后直接启动"已不再触发守卫；
    // 要验证守卫必须先把工序置为无效。用 status="cancelled" 而不是软删 ——
    // 软删会留下 (productionOrderId, sequenceNo) 唯一索引占位，之后 addOperations 从 max+1
    // 起算就会撞唯一约束；cancelled 保留序号，语义上也确实不再是有效工序。
    const created = await service.create({ order_no: fx.run.orderNo, bom_id: bom.id, bom_version: 1, execution_mode: "in_house", execution_location_id: location.id, planned_quantity: "10", unit_id: unit.id }, user);
    assert.equal(created.orderNo, fx.run.orderNo);
    assert.equal(created.bomVersion, 1);
    assert.equal(created.status, "draft");

    // 域规则：建单自动补「包装」收尾工序（production-orders.service.ts:99，仅在工序主数据存在包装工序时）
    const operationsAfterCreate = created.operations.filter((row) => !row.deletedAt);
    const packaging = operationsAfterCreate.find((row) => row.operationNameSnapshot.includes("包装"));
    assert.ok(packaging, "建单应自动补一道包装收尾工序");
    assert.equal(packaging.sequenceNo, 1);

    await prisma.productionOrderOperation.updateMany({ where: { productionOrderId: created.id }, data: { status: "cancelled", ...fx.audit.update() } });
    await assert.rejects(
      () => service.transition(created.id, "in_progress", "启动", user),
      (error) => error.getResponse().code === "PRODUCTION_OPERATIONS_REQUIRED",
    );

    // ---- B. 正常路径：补单（子生产单，厂内）加工序 → 启动 → 包装顺延到末尾 ----
    // 同一销售订单只允许一张标准主生产单，因此第二张必须是补单并关联父单。
    const child = await service.create({ order_no: fx.run.orderNo, bom_id: bom.id, bom_version: 1, production_order_type: "supplement", parent_production_order_id: created.id, execution_mode: "in_house", execution_location_id: location.id, planned_quantity: "10", unit_id: unit.id }, user);

    // 批量加工序：序号由服务端自动分配（max+1），不会与任何占用冲突
    const added = await service.addOperations(child.id, [{ operation_id: operation.id, target_quantity: "10" }], user);
    assert.equal(added.length, 1);
    assert.equal(added[0].operationNameSnapshot, operation.operationName);

    const started = await service.transition(child.id, "in_progress", "启动", user);
    assert.equal(started.status, "in_progress");

    const appended = await service.addOperations(child.id, [{ operation_id: operation2.id, target_quantity: "10" }], user);
    assert.equal(appended[0].operationNameSnapshot, operation2.operationName);

    // 新规则：包装工序始终被顺延到末尾，不能排在中间
    const routeAfterAppend = await service.get(child.id);
    const live = routeAfterAppend.operations.filter((row) => !row.deletedAt && row.status !== "cancelled").sort((a, b) => a.sequenceNo - b.sequenceNo);
    assert.ok(live.length >= 3, "补单应有 缝制 / 裁剪 / 包装 三道工序");
    assert.ok(live.at(-1).operationNameSnapshot.includes("包装"), "包装工序必须在工序路线末尾");

    // 规则本身：同一销售订单不允许第二张标准主生产单
    await assert.rejects(
      () => service.create({ order_no: fx.run.orderNo, bom_id: bom.id, bom_version: 1, execution_mode: "in_house", execution_location_id: location.id, planned_quantity: "10", unit_id: unit.id }, user),
      (error) => error.getResponse().code === "PRODUCTION_ORDER_ALREADY_EXISTS",
    );
    // 而补单不受执行方式限制：外加工补单同样可以挂工序
    const outsourced = await service.create({ order_no: fx.run.orderNo, bom_id: bom.id, bom_version: 1, production_order_type: "supplement", parent_production_order_id: created.id, execution_mode: "outsourced", execution_location_id: outsourceSite.id, planned_quantity: "10", unit_id: unit.id }, user);
    const outsourcedOperation = await service.addOperations(outsourced.id, [{ operation_id: operation.id, target_quantity: "10" }], user);
    assert.equal(outsourcedOperation[0].operationNameSnapshot, operation.operationName);
  });
});

test("production.order.operation.target-and-unit.patchable-with-lock-and-validation", async () => {
  await withFixtures("patchop", async ({ audit, fx, prisma, user }) => {
    const { unit, bom, location, operation } = await fx.productionPrerequisites();
    const altUnit = await fx.createUnit({ name: `打-${fx.run.id}` });
    const progressService = new ProductionProgressService(prisma, audit);
    const service = new ProductionOrdersService(prisma, audit, progressService);

    const order = await service.create({ order_no: fx.run.orderNo, bom_id: bom.id, bom_version: 1, execution_mode: "in_house", execution_location_id: location.id, planned_quantity: "10", unit_id: unit.id }, user);
    // 用批量接口拿工序行，序号自动分配，避免撞上自动补齐的包装工序
    const [operationRow] = await service.addOperations(order.id, [{ operation_id: operation.id, target_quantity: "10" }], user);

    // 草稿态：目标数量与单位可直接改，无需原因
    const patched = await service.updateOperation(order.id, operationRow.id, { target_quantity: "8", unit_id: altUnit.id }, undefined, user);
    assert.equal(String(patched.targetQuantity), "8");
    assert.equal(patched.unitId, altUnit.id);

    // 非法值在任何写入之前就被拒
    await assert.rejects(() => service.updateOperation(order.id, operationRow.id, { target_quantity: "0" }, undefined, user), (error) => error.getResponse().code === "INVALID_OPERATION_TARGET");
    await assert.rejects(() => service.updateOperation(order.id, operationRow.id, { unit_id: "00000000-0000-4000-8000-000000000000" }, undefined, user), (error) => error.getResponse().code === "UNIT_NOT_FOUND");

    await service.transition(order.id, "in_progress", "启动", user);
    // 进行中：缺原因被拒，带原因通过
    await assert.rejects(() => service.updateOperation(order.id, operationRow.id, { target_quantity: "6" }, undefined, user), (error) => error.getResponse().code === "OPERATION_UPDATE_REASON_REQUIRED");
    const reasoned = await service.updateOperation(order.id, operationRow.id, { target_quantity: "6" }, "客户改单下调目标", user);
    assert.equal(String(reasoned.targetQuantity), "6");

    // 进度快照由 PATCH 自身重算
    const recalcEvents = await prisma.auditEvent.count({ where: { entityType: "production_progress", entityId: order.id, action: "production_progress.recalculate", details: { path: ["trigger", "source_type"], equals: "production_order_operation" } } });
    assert.ok(recalcEvents >= 2, "目标/单位 PATCH 必须重算进度快照");

    // 完工后工序冻结。
    // 完工要求**所有非 cancelled 的有效工序**都达标（production-orders.service.ts:268-270），
    // 自动补建的包装工序也在此列，因此先把它置为 cancelled —— 本用例只考核缝制工序的编辑保护。
    await prisma.productionOrderOperation.updateMany({ where: { productionOrderId: order.id, operationNameSnapshot: { contains: "包装" } }, data: { status: "cancelled", ...fx.audit.update() } });
    await service.updateOperation(order.id, operationRow.id, { target_quantity: "2" }, "对齐完工口径", user);
    await prisma.operationDailyReport.create({
      data: { productionOrderId: order.id, productionOrderOperationId: operationRow.id, orderNo: fx.run.orderNo, productionOrderNoSnapshot: order.productionOrderNo, operationNameSnapshot: operation.operationName, unitId: altUnit.id, reportDate: new Date(), completedQuantity: "2", ...fx.audit.create() },
    });
    await service.transition(order.id, "completed", "完工", user);
    await assert.rejects(() => service.updateOperation(order.id, operationRow.id, { target_quantity: "5" }, "冻结校验", user), (error) => error.getResponse().code === "PRODUCTION_OPERATION_NOT_EDITABLE");
  });
});
