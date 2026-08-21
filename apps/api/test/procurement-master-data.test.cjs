const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { ProcurementMasterDataService } = require("../dist/modules/procurement/procurement-master-data.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }), record: async () => {} };

test("referenced unit cannot be physically deleted", async () => {
  const prisma = { unit: { findFirst: async () => ({ id: "unit-1" }) }, material: { count: async () => 1 }, bomItem: { count: async () => 0 } };
  const service = new ProcurementMasterDataService(prisma, audit);
  await assert.rejects(() => service.deleteUnit("unit-1", user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "MASTER_DATA_IN_USE");
});
