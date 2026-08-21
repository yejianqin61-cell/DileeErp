const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConflictException, NotFoundException } = require("@nestjs/common");
const { ProductionMasterDataService } = require("../dist/modules/production/production-master-data.service.js");

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

test("operation rates reject overlapping effective date ranges", async () => {
  const prisma = {
    employee: { findFirst: async () => ({ id: "employee-1" }) },
    operationCatalog: { findFirst: async () => ({ id: "operation-1" }) },
    operationRate: { findMany: async () => [{ id: "rate-1", effectiveFrom: new Date("2026-01-01"), effectiveTo: new Date("2026-12-31") }] },
  };
  const service = new ProductionMasterDataService(prisma, audit);
  await assert.rejects(() => service.createRate({ employee_id: "employee-1", operation_id: "operation-1", wage_mode: "piece_rate", unit_price: "1.50", effective_from: "2026-06-01", effective_to: "2026-06-30" }, user), (error) => error instanceof ConflictException && error.getResponse().code === "OPERATION_RATE_OVERLAP");
});
