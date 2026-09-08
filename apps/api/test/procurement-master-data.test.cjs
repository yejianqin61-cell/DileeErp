const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConflictException } = require("@nestjs/common");
const { ProcurementMasterDataService } = require("../dist/modules/procurement/procurement-master-data.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }), record: async () => {} };

test("referenced unit cannot be physically deleted", async () => {
  const prisma = {
    unit: { findFirst: async () => ({ id: "unit-1" }) },
    material: { count: async () => 1 },
    bomItem: { count: async () => 0 },
    operationCatalog: { count: async () => 0 },
    productionOrderOperation: { count: async () => 0 },
    $transaction: async (fn) => fn({ ...prisma, $queryRawUnsafe: async () => [] }),
  };
  const service = new ProcurementMasterDataService(prisma, audit);
  await assert.rejects(() => service.deleteUnit("unit-1", user), (error) => error instanceof ConflictException && error.getResponse().code === "MASTER_DATA_IN_USE");
});

require("reflect-metadata");
const { MaterialDto, UpdateMaterialDto } = require("../dist/modules/procurement/procurement-master-data.controller.js");
const { plainToInstance } = require("class-transformer");
const { validate } = require("class-validator");

const unitId = "5a6b93f4-e3e2-45e0-a0c4-4cf5f9bf3ee5";

test("material create persists specification model and color", async () => {
  const writes = [];
  const prisma = {
    unit: { findFirst: async () => ({ id: unitId, isActive: true }) },
    material: { create: async (input) => { writes.push(input.data); return { id: "material-1", ...input.data }; } },
  };
  const service = new ProcurementMasterDataService(prisma, audit);
  const material = await service.createMaterial({ material_code: "MAT-SPEC-1", name: "棉布", default_unit_id: unitId, specification_model: "A-01/160g", color: "深灰" }, user);
  assert.equal(writes[0].specificationModel, "A-01/160g");
  assert.equal(writes[0].color, "深灰");
  assert.equal(material.specificationModel, "A-01/160g");
  assert.equal(material.color, "深灰");
});

test("material create defaults specification model and color to null", async () => {
  const writes = [];
  const prisma = {
    unit: { findFirst: async () => ({ id: unitId, isActive: true }) },
    material: { create: async (input) => { writes.push(input.data); return { id: "material-1", ...input.data }; } },
  };
  const service = new ProcurementMasterDataService(prisma, audit);
  await service.createMaterial({ material_code: "MAT-SPEC-2", name: "棉布", default_unit_id: unitId }, user);
  assert.equal(writes[0].specificationModel, null);
  assert.equal(writes[0].color, null);
});

test("material update sets clears and keeps specification model and color", async () => {
  const updates = [];
  const prisma = { material: { findFirst: async () => ({ id: "material-1" }), update: async (input) => { updates.push(input.data); return input.data; } } };
  const service = new ProcurementMasterDataService(prisma, audit);
  await service.updateMaterial("material-1", { specification_model: "B-02", color: "米白" }, user);
  assert.equal(updates[0].specificationModel, "B-02");
  assert.equal(updates[0].color, "米白");
  await service.updateMaterial("material-1", { specification_model: null, color: null }, user);
  assert.equal(updates[1].specificationModel, null);
  assert.equal(updates[1].color, null);
  await service.updateMaterial("material-1", { name: "改名" }, user);
  assert.equal("specificationModel" in updates[2], false);
  assert.equal("color" in updates[2], false);
});

test("material list returns specification model and color", async () => {
  const prisma = { material: { findMany: async () => [{ id: "material-1", materialCode: "MAT-SPEC-1", name: "棉布", specificationModel: "A-01/160g", color: "深灰", defaultUnit: { id: unitId, name: "米" } }] } };
  const service = new ProcurementMasterDataService(prisma, audit);
  const rows = await service.listMaterials();
  assert.equal(rows[0].specificationModel, "A-01/160g");
  assert.equal(rows[0].color, "深灰");
});

test("material create dto accepts optional specification model and color", async () => {
  const dto = plainToInstance(MaterialDto, { material_code: "MAT-SPEC-1", name: "棉布", default_unit_id: unitId, specification_model: "A-01/160g", color: "深灰" });
  const errors = await validate(dto);
  assert.deepEqual(errors.map((error) => error.property), []);
});

test("material create dto rejects overlong specification model and color", async () => {
  const dto = plainToInstance(MaterialDto, { name: "棉布", default_unit_id: unitId, specification_model: "x".repeat(201), color: "x".repeat(101) });
  const errors = await validate(dto);
  assert.deepEqual(errors.map((error) => error.property).sort(), ["color", "specification_model"]);
});

test("material update dto allows null and bounded strings for specification model and color", async () => {
  const cleared = await validate(plainToInstance(UpdateMaterialDto, { specification_model: null, color: null }));
  assert.deepEqual(cleared.map((error) => error.property), []);
  const set = await validate(plainToInstance(UpdateMaterialDto, { specification_model: "B-02", color: "米白" }));
  assert.deepEqual(set.map((error) => error.property), []);
  const invalid = await validate(plainToInstance(UpdateMaterialDto, { specification_model: 42, color: "x".repeat(101) }));
  assert.deepEqual(invalid.map((error) => error.property).sort(), ["color", "specification_model"]);
});
