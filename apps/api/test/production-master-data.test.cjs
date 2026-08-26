const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConflictException, NotFoundException } = require("@nestjs/common");
const { ProductionMasterDataService } = require("../dist/modules/production/production-master-data.service.js");
const { ProductionOrdersService } = require("../dist/modules/production/production-orders.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => {} };

test("production location only accepts workshop or outsource site", async () => {
  const service = new ProductionMasterDataService({}, audit);
  await assert.rejects(() => service.createLocation({ name: "无效地点", location_type: "warehouse" }, user), (error) => error instanceof ConflictException && error.getResponse().code === "INVALID_LOCATION_TYPE");
});

test("employee rejects a position that does not belong to its active department", async () => {
  const prisma = { position: { findFirst: async () => null }, employee: { create: async () => { throw new Error("must not write"); } } };
  const service = new ProductionMasterDataService(prisma, audit);
  await assert.rejects(() => service.createEmployee({ employee_no: "E-1", name: "员工", department_id: "5a6b93f4-e3e2-45e0-a0c4-4cf5f9bf3ee5", position_id: "0ec5168a-bc9d-4c8c-ac0d-cb269fbd1a76", employee_type: "worker" }, user), (error) => error instanceof NotFoundException && error.getResponse().code === "ORGANIZATION_NOT_FOUND");
});

test("employee can leave only from active status", async () => {
  const updates = [];
  const prisma = { employee: { findFirst: async () => ({ id: "employee-1", employmentStatus: "active" }), update: async (input) => { updates.push(input); return input.data; } } };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new ProductionMasterDataService(prisma, audit);
  await service.setEmployeeLeft("employee-1", "2026-08-26", { id: "user-1" });
  assert.equal(updates[0].data.employmentStatus, "left");
  assert.equal(updates[0].data.leftOn.toISOString().slice(0, 10), "2026-08-26");
});

test("operation rates reject overlapping effective date ranges", async () => {
  const prisma = {
    employee: { findFirst: async () => ({ id: "employee-1" }) },
    operationCatalog: { findFirst: async () => ({ id: "operation-1" }) },
    operationRate: { findMany: async () => [{ id: "rate-1", effectiveFrom: new Date("2026-01-01"), effectiveTo: new Date("2026-12-31") }] },
  };
  const service = new ProductionMasterDataService(prisma, audit);
  await assert.rejects(() => service.createRate({ employee_id: "employee-1", operation_id: "operation-1", wage_mode: "piece_rate", unit_price: "1.50", effective_from: "2026-06-01", effective_to: "2026-06-30" }, user), (error) => error instanceof ConflictException && error.getResponse().code === "OPERATION_RATE_OVERLAP");
});

test("production order rejects an execution location type mismatch", async () => {
  const prisma = {
    salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1", status: "confirmed" }) },
    bom: { findFirst: async () => ({ id: "bom-1", orderNo: "SO-1", version: 1, status: "published" }) },
    productionLocation: { findFirst: async () => ({ id: "location-1", locationType: "outsource_site", isActive: true }) },
    unit: { findFirst: async () => ({ id: "unit-1", isActive: true }) },
  };
  const service = new ProductionOrdersService(prisma, audit);
  await assert.rejects(() => service.create({ order_no: "SO-1", bom_id: "bom-1", bom_version: 1, execution_mode: "in_house", execution_location_id: "location-1", planned_quantity: "10", unit_id: "unit-1" }, user), (error) => error instanceof require("@nestjs/common").UnprocessableEntityException && error.getResponse().code === "EXECUTION_LOCATION_MISMATCH");
});

test("in-house production order cannot start without an active operation", async () => {
  const prisma = {
    productionOrder: { findFirst: async () => ({ id: "po-1", status: "draft", executionMode: "in_house", operations: [], orderNo: "SO-1" }) },
  };
  const service = new ProductionOrdersService(prisma, audit);
  await assert.rejects(() => service.transition("po-1", "in_progress", "启动生产", user), (error) => error instanceof require("@nestjs/common").UnprocessableEntityException && error.getResponse().code === "PRODUCTION_OPERATIONS_REQUIRED");
});

test("production impact preview keeps the order identity and marks unbuilt downstream facts", async () => {
  const prisma = {
    productionOrder: { findFirst: async () => ({ id: "po-1", orderNo: "SO-1", productionOrderNo: "MO-1", status: "draft", bomId: "bom-1", bomVersion: 1, operations: [] }) },
    purchaseOrder: { findMany: async () => [] },
    auditEvent: { count: async () => 2 },
  };
  const service = new ProductionOrdersService(prisma, audit);
  const preview = await service.impactPreview("po-1");
  assert.equal(preview.order_no, "SO-1");
  assert.equal(preview.downstream.inventory_facts, "本批尚未建立");
  assert.equal(preview.audit_event_count, 2);
});
