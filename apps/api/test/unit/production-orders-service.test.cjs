const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConflictException } = require("@nestjs/common");
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
