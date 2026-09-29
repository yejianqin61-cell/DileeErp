const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConflictException } = require("@nestjs/common");
const { BomsService } = require("../dist/modules/sales/boms.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };

function serviceWithBom(bom) {
  return new BomsService({ bom: { findFirst: async () => bom, update: async () => bom } }, { update: () => ({ updatedBy: user.id }), record: async () => {} });
}

test("a BOM can be edited in place", async () => {
  const service = serviceWithBom({ id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, items: [{ id: "item-1" }] });
  await service.update("bom-1", {}, user);
});

test("a sales order can have only one BOM", async () => {
  const prisma = { salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "DL260001", status: "confirmed", versions: [{ id: "version-1", version: 1 }], boms: [{ id: "bom-1", version: 1 }] }) } };
  const service = new BomsService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  await assert.rejects(() => service.createFromSalesOrder("order-1", {}, user), (error) => error instanceof ConflictException && error.getResponse().code === "BOM_ALREADY_EXISTS");
});

test("a concurrent BOM insert has the same duplicate error", async () => {
  const prisma = { salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "DL260001", status: "confirmed", versions: [{ id: "version-1", version: 1 }], boms: [] }) }, bom: { create: async () => { const error = new Error("duplicate"); error.code = "P2002"; throw error; } } };
  const service = new BomsService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  await assert.rejects(() => service.createFromSalesOrder("order-1", {}, user), (error) => error instanceof ConflictException && error.getResponse().code === "BOM_ALREADY_EXISTS");
});

test("BOM rows retain their name, model, and color", async () => {
  let saved;
  const bom = { id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, items: [] };
  const prisma = {
    bom: { findFirst: async () => bom },
    $transaction: async (callback) => callback({ bomItem: { updateMany: async () => {}, createMany: async ({ data }) => { saved = data; } } }),
  };
  const service = new BomsService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  service.get = async () => bom;
  await service.replaceItems("bom-1", [{ material_id: "material-1", material_name: "面料", model: "M-01", color: "蓝色", material_snapshot: { name: "旧名称" }, required_quantity: "2", unit: "米" }], user);
  assert.equal(saved[0].materialName, "面料");
  assert.equal(saved[0].model, "M-01");
  assert.equal(saved[0].color, "蓝色");
});

test("manual specification and color survive save even when the material snapshot differs", async () => {
  let saved;
  const bom = { id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, items: [] };
  const prisma = {
    bom: { findFirst: async () => bom },
    $transaction: async (callback) => callback({ bomItem: { updateMany: async () => {}, createMany: async ({ data }) => { saved = data; } } }),
  };
  const service = new BomsService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  service.get = async () => bom;
  await service.replaceItems("bom-1", [{ material_id: "material-1", material_name: "面料", model: "M-01", specification_model: "40支 手工修正", color: "墨绿", material_snapshot: { name: "主数据名称", specification_model: "40支 旧值", color: "红色" }, required_quantity: "2", unit: "米" }], user);
  assert.equal(saved[0].materialName, "面料");
  assert.equal(saved[0].specificationModel, "40支 手工修正");
  assert.equal(saved[0].color, "墨绿");
  assert.equal(saved[0].model, "M-01");
});

test("saving without a specification keeps it empty instead of resurrecting the legacy model", async () => {
  let saved;
  const bom = { id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, items: [] };
  const prisma = {
    bom: { findFirst: async () => bom },
    $transaction: async (callback) => callback({ bomItem: { updateMany: async () => {}, createMany: async ({ data }) => { saved = data; } } }),
  };
  const service = new BomsService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  service.get = async () => bom;
  await service.replaceItems("bom-1", [{ material_id: "material-1", material_name: "面料", model: "M-01", specification_model: undefined, color: undefined, material_snapshot: { specification_model: "主数据规格", color: "主数据颜色" }, required_quantity: "2", unit: "米" }], user);
  assert.equal(saved[0].specificationModel, undefined);
  assert.equal(saved[0].color, undefined);
});

test("edited required quantity is saved verbatim instead of being recomputed", async () => {
  let saved;
  const bom = { id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, salesOrderId: "order-1", items: [] };
  const prisma = {
    bom: { findFirst: async () => bom },
    salesOrder: { findUnique: async () => ({ quantity: { div: () => ({ mul: () => "99" }) } }) },
    $transaction: async (callback) => callback({ bomItem: { updateMany: async () => {}, createMany: async ({ data }) => { saved = data; } } }),
  };
  const service = new BomsService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  service.get = async () => bom;
  await service.replaceItems("bom-1", [{ material_id: "material-1", material_name: "面料", material_snapshot: { name: "面料" }, required_quantity: "7.5", unit: "米" }], user);
  assert.equal(saved[0].requiredQuantity.toString(), "7.5");
  assert.equal(saved[0].approvedUsage.toString(), "7.5");
});

test("a provided unit_id wins over the material default unit and unknown unit_ids are rejected", async () => {
  let saved;
  const bom = { id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, salesOrderId: "order-1", items: [] };
  const prisma = {
    bom: { findFirst: async () => bom },
    salesOrder: { findUnique: async () => ({ quantity: "10" }) },
    unit: { findMany: async () => [{ id: "unit-2" }] },
    $transaction: async (callback) => callback({ bomItem: { updateMany: async () => {}, createMany: async ({ data }) => { saved = data; } } }),
  };
  const service = new BomsService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  service.get = async () => bom;
  await service.replaceItems("bom-1", [{ material_id: "material-1", material_name: "面料", material_snapshot: { name: "面料" }, required_quantity: "2", unit: "码", unit_id: "unit-2" }], user);
  assert.equal(saved[0].unitId, "unit-2");
  await assert.rejects(() => service.replaceItems("bom-1", [{ material_id: "material-1", material_name: "面料", material_snapshot: { name: "面料" }, required_quantity: "2", unit: "码", unit_id: "unit-9" }], user), (error) => error.getResponse().code === "BOM_UNIT_NOT_FOUND");
});

test("bom items get sequential numbers starting from one", async () => {
  let saved;
  const bom = { id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, items: [] };
  const prisma = {
    bom: { findFirst: async () => bom },
    $transaction: async (callback) => callback({ bomItem: { updateMany: async () => {}, createMany: async ({ data }) => { saved = data; } } }),
  };
  const service = new BomsService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  service.get = async () => bom;
  await service.replaceItems("bom-1", [
    { material_id: "material-1", material_name: "面料", material_snapshot: { name: "面料" }, required_quantity: "2", unit: "米" },
    { material_id: "material-2", material_name: "伞骨", material_snapshot: { name: "伞骨" }, required_quantity: "1", unit: "根" },
  ], user);
  assert.deepEqual(saved.map((row) => row.sequence), [1, 2]);
});

// ---- BOM 行默认供应商（2026-09-26，「BOM 表新增一个 column：供应商」）----

test("BOM 行的默认供应商：落库时写 id + 快照（供应商改名后 BOM 上仍看得见当时记的是哪家）", async () => {
  let saved;
  const bom = { id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, items: [] };
  const prisma = {
    bom: { findFirst: async () => bom },
    supplier: { findMany: async () => [{ id: "supplier-1", supplierCode: "S-001", name: "宁波辅料厂" }] },
    $transaction: async (callback) => callback({ bomItem: { updateMany: async () => {}, createMany: async ({ data }) => { saved = data; } } }),
  };
  const service = new BomsService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  service.get = async () => bom;
  await service.replaceItems("bom-1", [{ material_id: "material-1", material_name: "面料", material_snapshot: { name: "面料" }, required_quantity: "2", unit: "米", supplier_id: "supplier-1" }], user);
  assert.equal(saved[0].supplierId, "supplier-1");
  assert.deepEqual(saved[0].supplierSnapshot, { id: "supplier-1", supplierCode: "S-001", name: "宁波辅料厂" });
});

test("BOM 行的默认供应商：不存在或已停用一律拒绝（列表里找不到的供应商不能挂上去）", async () => {
  const bom = { id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, items: [] };
  const prisma = {
    bom: { findFirst: async () => bom },
    // 已停用的供应商不会被查出来
    supplier: { findMany: async ({ where }) => where.id.in.filter((id) => id === "supplier-1").map((id) => ({ id, supplierCode: "S-001", name: "宁波辅料厂" })) },
    $transaction: async (callback) => callback({ bomItem: { updateMany: async () => {}, createMany: async () => {} } }),
  };
  const service = new BomsService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  service.get = async () => bom;
  await assert.rejects(
    () => service.replaceItems("bom-1", [{ material_id: "material-1", material_name: "面料", material_snapshot: { name: "面料" }, required_quantity: "2", unit: "米", supplier_id: "supplier-9" }], user),
    (error) => error.getResponse().code === "BOM_SUPPLIER_NOT_FOUND",
  );
});

test("BOM 行的默认供应商：留空写 SQL NULL（不是 JSON 的 null 字面量）", async () => {
  const { Prisma } = require("@prisma/client");
  let saved;
  const bom = { id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, items: [] };
  const prisma = {
    bom: { findFirst: async () => bom },
    supplier: { findMany: async () => [] },
    $transaction: async (callback) => callback({ bomItem: { updateMany: async () => {}, createMany: async ({ data }) => { saved = data; } } }),
  };
  const service = new BomsService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  service.get = async () => bom;
  await service.replaceItems("bom-1", [{ material_id: "material-1", material_name: "面料", material_snapshot: { name: "面料" }, required_quantity: "2", unit: "米" }], user);
  assert.equal(saved[0].supplierId, null);
  // 必须是 `DbNull`（SQL NULL）而不是 `JsonNull`（JSON 的 null 字面量）：后者会让
  // `WHERE supplier_snapshot IS NULL` 找不到这些行 —— 将来查"哪些行没有快照"会漏。
  assert.equal(saved[0].supplierSnapshot, Prisma.DbNull);
});

test("BOM 行的默认供应商：轻量桩（没有 supplier 表）也能保存 —— 与 unit/material 同一套写法", async () => {
  let saved;
  const bom = { id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, items: [] };
  const prisma = {
    bom: { findFirst: async () => bom },
    // 故意不给 supplier：老调用方/单测桩没有这张表时不该炸
    $transaction: async (callback) => callback({ bomItem: { updateMany: async () => {}, createMany: async ({ data }) => { saved = data; } } }),
  };
  const service = new BomsService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });
  service.get = async () => bom;
  await service.replaceItems("bom-1", [{ material_id: "material-1", material_name: "面料", material_snapshot: { name: "面料" }, required_quantity: "2", unit: "米" }], user);
  assert.equal(saved[0].supplierId, null);
});
