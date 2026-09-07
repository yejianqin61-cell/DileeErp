const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConflictException, NotFoundException } = require("@nestjs/common");
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
