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
