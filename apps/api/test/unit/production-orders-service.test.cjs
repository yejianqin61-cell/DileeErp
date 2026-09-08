const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConflictException, NotFoundException, UnprocessableEntityException } = require("@nestjs/common");
const { ProductionOrdersService } = require("../../dist/modules/production/production-orders.service.js");

test("adding a production operation rechecks duplicates under the production-order lock", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "in_progress", operations: [{ operationCatalogId: "operation-1", sequenceNo: 1, status: "active" }] };
  const prisma = {
    operationCatalog: { findFirst: async () => ({ id: "operation-1", operationName: "缝制", defaultUnitId: "unit-1", isActive: true }) },
    unit: { findFirst: async () => ({ id: "unit-1", isActive: true }) },
    productionOrder: { findFirst: async () => order },
    $transaction: async (fn) => fn({
      $queryRaw: async () => undefined,
      productionOrder: { findFirst: async () => order },
      productionOrderOperation: { create: async () => ({ id: "new-operation" }) },
    }),
  };
  const service = new ProductionOrdersService(prisma, { create: () => ({}), record: async () => undefined });
  await assert.rejects(() => service.addOperation("order-1", { operation_id: "operation-1", sequence_no: 2, target_quantity: "10" }, { id: "user-1" }), (error) => error instanceof ConflictException && error.getResponse().code === "PRODUCTION_OPERATION_DUPLICATE");
});

const user = { id: "user-1" };
const baseInput = { order_no: "SO-1", bom_id: "bom-1", bom_version: 1, execution_mode: "in_house", execution_location_id: "location-1", planned_quantity: "100", unit_id: "unit-1" };

function refsPrisma() {
  return {
    salesOrder: { findFirst: async () => ({ id: "so-1", orderNo: "SO-1", status: "confirmed" }) },
    bom: { findFirst: async () => ({ id: "bom-1", orderNo: "SO-1", salesOrderId: "so-1", version: 1, status: "published", items: [] }) },
    productionLocation: { findFirst: async () => ({ id: "location-1", locationType: "workshop", isActive: true }) },
    unit: { findFirst: async () => ({ id: "unit-1", isActive: true }) },
  };
}

test("create rejects a second standard root production order for the same sales order with a 409 conflict", async () => {
  const existing = { id: "po-existing", productionOrderNo: "MO-0001", status: "draft" };
  let duplicateQueries = 0;
  let createCalls = 0;
  const prisma = {
    ...refsPrisma(),
    $transaction: async (fn) => fn({
      $queryRaw: async () => undefined,
      salesOrder: { findFirst: async () => ({ id: "so-1", status: "confirmed" }) },
      productionOrder: { findFirst: async () => { duplicateQueries += 1; return existing; }, create: async () => { createCalls += 1; throw new Error("create must not be reached"); } },
    }),
  };
  const service = new ProductionOrdersService(prisma, { create: () => ({}), record: async () => undefined });
  await assert.rejects(() => service.create({ ...baseInput, production_order_type: "standard" }, user), (error) => error instanceof ConflictException && error.getResponse().code === "PRODUCTION_ORDER_ALREADY_EXISTS" && JSON.stringify(error.getResponse().details) === JSON.stringify([{ production_order_id: "po-existing", production_order_no: "MO-0001", status: "draft" }]));
  assert.equal(duplicateQueries, 1);
  assert.equal(createCalls, 0);
});

test("create locks the sales order and re-confirms it is confirmed and not deleted inside the transaction", async () => {
  let lockQueryCount = 0;
  let duplicateQueries = 0;
  const prisma = {
    ...refsPrisma(),
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockQueryCount += 1; },
      salesOrder: { findFirst: async () => null },
      productionOrder: { findFirst: async () => { duplicateQueries += 1; return null; }, create: async () => { throw new Error("create must not be reached"); } },
    }),
  };
  const service = new ProductionOrdersService(prisma, { create: () => ({}), record: async () => undefined });
  await assert.rejects(() => service.create({ ...baseInput, production_order_type: "standard" }, user), (error) => error instanceof NotFoundException && error.getResponse().code === "SALES_ORDER_NOT_CONFIRMED");
  assert.equal(lockQueryCount, 1);
  assert.equal(duplicateQueries, 0);
});

test("supplement/rework/split child orders bypass the single-standard-root conflict check", async () => {
  const parent = { id: "po-parent", orderNo: "SO-1", status: "draft" };
  const created = { id: "po-created", orderNo: "SO-1", productionOrderNo: "MO-0002", status: "draft" };
  for (const production_order_type of ["supplement", "rework", "split"]) {
    let lockQueryCount = 0;
    let duplicateQueries = 0;
    let createdData;
    const prisma = {
      ...refsPrisma(),
      productionOrder: { findFirst: async ({ where }) => (where.id === "po-parent" ? parent : created) },
      $transaction: async (fn) => fn({
        $queryRaw: async () => { lockQueryCount += 1; },
        salesOrder: { findFirst: async () => ({ id: "so-1", status: "confirmed" }) },
        productionOrder: { findFirst: async () => { duplicateQueries += 1; return { id: "po-existing" }; }, create: async ({ data }) => { createdData = data; return created; } },
      }),
    };
    const service = new ProductionOrdersService(prisma, { create: () => ({}), record: async () => undefined });
    const result = await service.create({ ...baseInput, production_order_type, parent_production_order_id: "po-parent" }, user);
    assert.equal(result.id, "po-created");
    assert.equal(lockQueryCount, 1);
    assert.equal(duplicateQueries, 0);
    assert.equal(createdData.productionOrderType, production_order_type);
    assert.equal(createdData.parentProductionOrderId, "po-parent");
    assert.equal(createdData.salesOrderId, "so-1");
  }
});

test("create maps a P2002 unique violation on the insert to the same single-standard-root 409 conflict", async () => {
  let lockQueryCount = 0;
  const uniqueViolation = new Error("unique constraint");
  uniqueViolation.code = "P2002";
  const prisma = {
    ...refsPrisma(),
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockQueryCount += 1; },
      salesOrder: { findFirst: async () => ({ id: "so-1", status: "confirmed" }) },
      productionOrder: { findFirst: async () => null, create: async () => { throw uniqueViolation; } },
    }),
  };
  const service = new ProductionOrdersService(prisma, { create: () => ({}), record: async () => undefined });
  await assert.rejects(() => service.create({ ...baseInput, production_order_type: "standard" }, user), (error) => error instanceof ConflictException && error.getResponse().code === "PRODUCTION_ORDER_ALREADY_EXISTS");
  assert.equal(lockQueryCount, 1);
});

test("create rethrows non-unique insert errors instead of masking them as a conflict", async () => {
  const failure = new Error("database unavailable");
  const prisma = {
    ...refsPrisma(),
    $transaction: async (fn) => fn({
      $queryRaw: async () => undefined,
      salesOrder: { findFirst: async () => ({ id: "so-1", status: "confirmed" }) },
      productionOrder: { findFirst: async () => null, create: async () => { throw failure; } },
    }),
  };
  const service = new ProductionOrdersService(prisma, { create: () => ({}), record: async () => undefined });
  await assert.rejects(() => service.create({ ...baseInput, production_order_type: "standard" }, user), (error) => error === failure);
});

function batchHarness({ catalogRows = [], unitRows = [{ id: "unit-1", isActive: true }], order, createImpl } = {}) {
  const createCalls = [];
  const auditRecords = [];
  let transactions = 0;
  const prisma = {
    operationCatalog: { findMany: async ({ where }) => catalogRows.filter((row) => where.id.in.includes(row.id) && !row.deletedAt) },
    unit: { findMany: async ({ where }) => unitRows.filter((row) => where.id.in.includes(row.id)) },
    productionOrder: { findFirst: async () => order },
    $transaction: async (fn) => { transactions += 1; return fn({
      $queryRaw: async () => undefined,
      productionOrder: { findFirst: async () => order },
      productionOrderOperation: { create: async ({ data }) => {
        if (createImpl) return createImpl({ data, createCalls });
        createCalls.push(data);
        return { id: `new-op-${createCalls.length}`, sequenceNo: data.sequenceNo, targetQuantity: data.targetQuantity, unitId: data.unitId, operationCatalogId: data.operationCatalogId, operationNameSnapshot: data.operationNameSnapshot };
      } },
    }); },
  };
  const audit = { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), record: async (...args) => { auditRecords.push(args); } };
  return { service: new ProductionOrdersService(prisma, audit), createCalls, auditRecords, isTransactionCalled: () => transactions > 0 };
}

test("batch add creates every picked operation with auto-assigned sequences and one batch audit event", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "draft", operations: [
    { operationCatalogId: "op-x", sequenceNo: 1, status: "active" },
    { operationCatalogId: "op-c", sequenceNo: 4, status: "cancelled" },
  ] };
  const catalogRows = [
    { id: "op-a", operationName: "裁剪", defaultUnitId: "unit-2", isActive: true },
    { id: "op-b", operationName: "缝制", defaultUnitId: null, isActive: true },
  ];
  const unitRows = [{ id: "unit-1", isActive: true }, { id: "unit-2", isActive: true }, { id: "unit-3", isActive: true }];
  const { service, createCalls, auditRecords } = batchHarness({ catalogRows, unitRows, order });
  const result = await service.addOperations("order-1", [
    { operation_id: "op-b", target_quantity: "100" },
    { operation_id: "op-a", target_quantity: "50", unit_id: "unit-3" },
  ], user);
  assert.equal(createCalls.length, 2);
  // cancelled rows keep their sequence number, so new rows continue after the max (4)
  assert.deepEqual(createCalls.map((row) => row.sequenceNo), [5, 6]);
  assert.deepEqual(createCalls.map((row) => row.productionOrderId), ["order-1", "order-1"]);
  assert.deepEqual(createCalls.map((row) => row.operationCatalogId), ["op-b", "op-a"]);
  assert.deepEqual(createCalls.map((row) => row.operationNameSnapshot), ["缝制", "裁剪"]);
  // unit falls back to catalog default, then to the explicit unit_id override / order unit
  assert.deepEqual(createCalls.map((row) => row.unitId), ["unit-1", "unit-3"]);
  assert.deepEqual(createCalls.map((row) => String(row.targetQuantity)), ["100", "50"]);
  assert.equal(result.length, 2);
  assert.equal(auditRecords.length, 1);
  const [action, entityType, actorId, entityId, details] = auditRecords[0];
  assert.equal(action, "production_order_operation.batch_create");
  assert.equal(entityType, "production_order_operation");
  assert.equal(actorId, "user-1");
  assert.equal(entityId, "order-1");
  assert.equal(details.order_no, "SO-1");
  assert.equal(details.count, 2);
  assert.deepEqual(details.operations.map((row) => row.sequence_no), [5, 6]);
});

test("batch add rejects a duplicated catalog id inside one submission before any write", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "draft", operations: [] };
  const catalogRows = [{ id: "op-a", operationName: "裁剪", defaultUnitId: "unit-1", isActive: true }];
  const { service, createCalls, isTransactionCalled } = batchHarness({ catalogRows, order });
  await assert.rejects(() => service.addOperations("order-1", [
    { operation_id: "op-a", target_quantity: "10" },
    { operation_id: "op-a", target_quantity: "20" },
  ], user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PRODUCTION_OPERATION_BATCH_DUPLICATE");
  assert.equal(createCalls.length, 0);
  assert.equal(isTransactionCalled(), false);
});

test("batch add rejects missing or deactivated catalog operations with their ids listed", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "draft", operations: [] };
  const catalogRows = [
    { id: "op-a", operationName: "裁剪", defaultUnitId: "unit-1", isActive: true },
    { id: "op-c", operationName: "整烫", defaultUnitId: "unit-1", isActive: false },
  ];
  const { service, createCalls, isTransactionCalled } = batchHarness({ catalogRows, order });
  await assert.rejects(() => service.addOperations("order-1", [
    { operation_id: "op-a", target_quantity: "10" },
    { operation_id: "op-b", target_quantity: "10" },
    { operation_id: "op-c", target_quantity: "10" },
  ], user), (error) => {
    assert.ok(error instanceof NotFoundException && error.getResponse().code === "OPERATION_NOT_FOUND");
    assert.deepEqual(error.getResponse().details, [{ operation_id: "op-b" }, { operation_id: "op-c" }]);
    return true;
  });
  assert.equal(createCalls.length, 0);
  assert.equal(isTransactionCalled(), false);
});

test("batch add rejects an invalid target quantity with the offending row labelled", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "draft", operations: [] };
  const catalogRows = [{ id: "op-a", operationName: "裁剪", defaultUnitId: "unit-1", isActive: true }];
  const { service, createCalls, isTransactionCalled } = batchHarness({ catalogRows, order });
  await assert.rejects(() => service.addOperations("order-1", [{ operation_id: "op-a", target_quantity: "0" }], user), (error) => {
    assert.ok(error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_OPERATION_TARGET");
    assert.equal(error.getResponse().details[0].field, "第 1 道工序目标数量");
    return true;
  });
  assert.equal(createCalls.length, 0);
  assert.equal(isTransactionCalled(), false);
});

test("batch add rechecks duplicates against live operations inside the lock and never writes partial rows", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "draft", operations: [{ operationCatalogId: "op-b", sequenceNo: 1, status: "active" }] };
  const catalogRows = [
    { id: "op-a", operationName: "裁剪", defaultUnitId: "unit-1", isActive: true },
    { id: "op-b", operationName: "缝制", defaultUnitId: "unit-1", isActive: true },
  ];
  const { service, createCalls } = batchHarness({ catalogRows, order });
  await assert.rejects(() => service.addOperations("order-1", [
    { operation_id: "op-a", target_quantity: "10" },
    { operation_id: "op-b", target_quantity: "10" },
  ], user), (error) => {
    assert.ok(error instanceof ConflictException && error.getResponse().code === "PRODUCTION_OPERATION_DUPLICATE");
    assert.equal(error.getResponse().details[0].operation_id, "op-b");
    return true;
  });
  assert.equal(createCalls.length, 0);
});

test("batch add refuses non-editable production orders inside the transaction", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "completed", operations: [] };
  const catalogRows = [{ id: "op-a", operationName: "裁剪", defaultUnitId: "unit-1", isActive: true }];
  const { service, createCalls } = batchHarness({ catalogRows, order });
  await assert.rejects(() => service.addOperations("order-1", [{ operation_id: "op-a", target_quantity: "10" }], user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PRODUCTION_OPERATION_NOT_EDITABLE");
  assert.equal(createCalls.length, 0);
});

test("batch add rejects an unresolved unit before opening the transaction", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "draft", operations: [] };
  const catalogRows = [{ id: "op-a", operationName: "裁剪", defaultUnitId: "unit-9", isActive: true }];
  const { service, createCalls, isTransactionCalled } = batchHarness({ catalogRows, unitRows: [{ id: "unit-1", isActive: true }], order });
  await assert.rejects(() => service.addOperations("order-1", [{ operation_id: "op-a", target_quantity: "10" }], user), (error) => {
    assert.ok(error instanceof NotFoundException && error.getResponse().code === "UNIT_NOT_FOUND");
    assert.deepEqual(error.getResponse().details, [{ unit_id: "unit-9" }]);
    return true;
  });
  assert.equal(createCalls.length, 0);
  assert.equal(isTransactionCalled(), false);
});

test("batch add rejects an empty submission", async () => {
  const { service, isTransactionCalled } = batchHarness({});
  await assert.rejects(() => service.addOperations("order-1", [], user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PRODUCTION_OPERATION_BATCH_EMPTY");
  assert.equal(isTransactionCalled(), false);
});

test("batch add propagates a row insert failure so the transaction rolls the whole batch back", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "draft", operations: [] };
  const catalogRows = [
    { id: "op-a", operationName: "裁剪", defaultUnitId: "unit-1", isActive: true },
    { id: "op-b", operationName: "缝制", defaultUnitId: "unit-1", isActive: true },
  ];
  const failure = new Error("insert failed");
  const { service, createCalls, auditRecords } = batchHarness({
    catalogRows, order,
    createImpl: ({ data, createCalls }) => { createCalls.push(data); if (createCalls.length === 2) throw failure; return { id: "x", sequenceNo: data.sequenceNo }; },
  });
  await assert.rejects(() => service.addOperations("order-1", [
    { operation_id: "op-a", target_quantity: "10" },
    { operation_id: "op-b", target_quantity: "10" },
  ], user), (error) => error === failure);
  assert.equal(createCalls.length, 2);
  assert.equal(auditRecords.length, 0);
});

// ---------------------------------------------------------------------------
// PATCH /production/orders/:id/operations/:operationId — 工序计量目标数量与单位编辑
// The endpoint must stay a legal PATCH: keep the production-order FOR UPDATE
// lock, validate the unit/quantity before writing, require a reason while the
// order is in production, and refresh the progress measurement snapshot.
// ---------------------------------------------------------------------------

function updateOperationHarness({ order, unitRows = [{ id: "unit-1", isActive: true }, { id: "unit-2", isActive: true }], updateImpl } = {}) {
  const updateCalls = [];
  const auditRecords = [];
  let lockQueries = 0;
  let transactions = 0;
  const progressCalls = [];
  const progress = { recalculateInTransaction: async (...args) => { progressCalls.push(args); return { status: "in_production" }; } };
  const prisma = {
    unit: { findFirst: async ({ where }) => unitRows.find((row) => row.id === where.id && row.isActive) ?? null },
    productionOrder: { findFirst: async () => order },
    $transaction: async (fn) => {
      transactions += 1;
      return fn({
        $queryRaw: async () => { lockQueries += 1; },
        productionOrder: { findFirst: async () => order },
        productionOrderOperation: { update: updateImpl ?? (async ({ data }) => {
          updateCalls.push(data);
          return { id: "op-1", status: "active", sequenceNo: 1, targetQuantity: data.targetQuantity ?? "10", unitId: data.unitId ?? "unit-1" };
        }) },
      });
    },
  };
  const audit = {
    create: () => ({ createdBy: "user-1", updatedBy: "user-1" }),
    update: () => ({ updatedBy: "user-1" }),
    record: async (...args) => { auditRecords.push(args); },
  };
  return {
    service: new ProductionOrdersService(prisma, audit, progress),
    updateCalls, auditRecords, progressCalls,
    lockCount: () => lockQueries, transactionCount: () => transactions,
  };
}

const editableOperation = { id: "op-1", status: "active", sequenceNo: 1, targetQuantity: "10", unitId: "unit-1" };

test("updateOperation edits target quantity and unit on a draft order without a reason", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "draft", operations: [editableOperation] };
  const { service, updateCalls, auditRecords, lockCount } = updateOperationHarness({ order });
  const row = await service.updateOperation("order-1", "op-1", { target_quantity: "88", unit_id: "unit-2" }, undefined, user);
  assert.equal(lockCount(), 1);
  assert.equal(updateCalls.length, 1);
  assert.equal(String(updateCalls[0].targetQuantity), "88");
  assert.equal(updateCalls[0].unitId, "unit-2");
  assert.equal(row.unitId, "unit-2");
  assert.equal(auditRecords.length, 1);
  const [action, entityType, actorId, entityId, details] = auditRecords[0];
  assert.equal(action, "production_order_operation.update");
  assert.equal(entityType, "production_order_operation");
  assert.equal(actorId, "user-1");
  assert.equal(entityId, "op-1");
  assert.deepEqual(details.changed, ["target_quantity", "unit_id"]);
  assert.equal(details.before.target_quantity, "10");
  assert.equal(details.after.target_quantity, "88");
});

test("updateOperation on an in-progress order requires a correction reason", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "in_progress", operations: [editableOperation] };
  const { service, updateCalls, transactionCount } = updateOperationHarness({ order });
  await assert.rejects(() => service.updateOperation("order-1", "op-1", { target_quantity: "20" }, undefined, user), (error) => {
    assert.ok(error instanceof UnprocessableEntityException && error.getResponse().code === "OPERATION_UPDATE_REASON_REQUIRED");
    return true;
  });
  await assert.rejects(() => service.updateOperation("order-1", "op-1", { target_quantity: "20" }, "   ", user), (error) => error.getResponse().code === "OPERATION_UPDATE_REASON_REQUIRED");
  // The reason rule depends on the live order status, so the check legitimately runs
  // under the FOR UPDATE lock inside the transaction — assert no row was written.
  assert.equal(updateCalls.length, 0);
});

test("updateOperation accepts an in-progress order edit when a reason is supplied", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "in_progress", operations: [editableOperation] };
  const { service, updateCalls, auditRecords } = updateOperationHarness({ order });
  await service.updateOperation("order-1", "op-1", { target_quantity: "20" }, "客户改单调整目标", user);
  assert.equal(updateCalls.length, 1);
  assert.equal(auditRecords[0][4].reason, "客户改单调整目标");
});

test("updateOperation refuses completed or closed production orders", async () => {
  for (const status of ["completed", "closed"]) {
    const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status, operations: [editableOperation] };
    const { service, updateCalls } = updateOperationHarness({ order });
    await assert.rejects(() => service.updateOperation("order-1", "op-1", { target_quantity: "20" }, "原因", user), (error) => {
      assert.ok(error instanceof UnprocessableEntityException && error.getResponse().code === "PRODUCTION_OPERATION_NOT_EDITABLE");
      assert.equal(error.getResponse().details[0].production_order_status, status);
      return true;
    });
    assert.equal(updateCalls.length, 0);
  }
});

test("updateOperation rejects unknown or deactivated units before opening a transaction", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "draft", operations: [editableOperation] };
  const { service, transactionCount } = updateOperationHarness({ order, unitRows: [{ id: "unit-1", isActive: true }] });
  await assert.rejects(() => service.updateOperation("order-1", "op-1", { unit_id: "unit-9" }, undefined, user), (error) => {
    assert.ok(error instanceof NotFoundException && error.getResponse().code === "UNIT_NOT_FOUND");
    return true;
  });
  assert.equal(transactionCount(), 0);
});

test("updateOperation rejects an invalid target quantity before opening a transaction", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "draft", operations: [editableOperation] };
  const { service, transactionCount } = updateOperationHarness({ order });
  for (const target_quantity of ["0", "-3", "abc", "1.23456"]) {
    await assert.rejects(() => service.updateOperation("order-1", "op-1", { target_quantity }, undefined, user), (error) => error.getResponse().code === "INVALID_OPERATION_TARGET");
  }
  assert.equal(transactionCount(), 0);
});

test("updateOperation refreshes the production progress measurement snapshot inside the transaction", async () => {
  const order = { id: "order-1", orderNo: "SO-1", unitId: "unit-1", status: "in_progress", operations: [editableOperation] };
  const { service, progressCalls } = updateOperationHarness({ order });
  await service.updateOperation("order-1", "op-1", { target_quantity: "30" }, "目标调整", user);
  assert.equal(progressCalls.length, 1);
  const [tx, productionOrderId, sourceType, sourceId, actor] = progressCalls[0];
  assert.ok(tx && typeof tx === "object");
  assert.equal(productionOrderId, "order-1");
  assert.equal(sourceType, "production_order_operation");
  assert.equal(sourceId, "op-1");
  assert.deepEqual(actor, user);
});

// 完工门禁与进度计量同口径：工序实际完成量 = max(工序日报累计, 员工日报累计)。
function completionHarness({ operationReports = [], employeeReports = [] } = {}) {
  const order = { id: "order-1", orderNo: "SO-1", productionOrderNo: "MO-1", unitId: "unit-1", status: "in_progress", executionMode: "in_house", plannedQuantity: "50", operations: [{ id: "op-1", status: "active", sequenceNo: 1, targetQuantity: "50", operationNameSnapshot: "缝伞" }] };
  const tx = {
    $queryRaw: async () => undefined,
    productionOrder: {
      findFirst: async () => order,
      update: async ({ data }) => ({ ...order, ...data, actualCompletedQuantity: data.actualCompletedQuantity ?? null }),
    },
    operationDailyReport: { groupBy: async () => operationReports },
    employeeDailyReport: { groupBy: async () => employeeReports },
    productionDailyAlert: { count: async () => 0 },
  };
  const service = new ProductionOrdersService({ $transaction: async (fn) => fn(tx) }, { create: () => ({}), update: () => ({ updatedBy: user.id }), record: async () => {} });
  return service;
}

test("completion counts employee daily report quantities toward operation targets", async () => {
  const service = completionHarness({ employeeReports: [{ productionOrderOperationId: "op-1", _sum: { quantity: "50" } }] });
  const row = await service.transition("order-1", "completed", "完工", user);
  assert.equal(row.status, "completed");
  assert.equal(row.actualCompletedQuantity.toString(), "50");
});

test("completion still refuses when the larger source is below the target", async () => {
  const service = completionHarness({
    operationReports: [{ productionOrderOperationId: "op-1", _sum: { completedQuantity: "30" } }],
    employeeReports: [{ productionOrderOperationId: "op-1", _sum: { quantity: "49" } }],
  });
  await assert.rejects(() => service.transition("order-1", "completed", "完工", user), (error) => {
    assert.ok(error instanceof UnprocessableEntityException && error.getResponse().code === "PRODUCTION_OPERATIONS_INCOMPLETE");
    assert.equal(error.getResponse().details[0].completed_quantity, "49");
    return true;
  });
});
