const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConflictException, UnprocessableEntityException } = require("@nestjs/common");
const { BomsService } = require("../dist/modules/sales/boms.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };

function serviceWithBom(bom) {
  return new BomsService({ bom: { findFirst: async () => bom, update: async () => bom } }, { update: () => ({ updatedBy: user.id }), record: async () => {} });
}

test("empty draft BOM cannot be published", async () => {
  const service = serviceWithBom({ id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, items: [] });
  await assert.rejects(() => service.publish("bom-1", user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "BOM_ITEMS_REQUIRED");
});

test("published BOM can be edited in place", async () => {
  const service = serviceWithBom({ id: "bom-1", status: "published", orderNo: "DL260001", version: 1, items: [{ id: "item-1" }] });
  await service.update("bom-1", {}, user);
});

test("a sales order can have only one BOM", async () => {
  const prisma = { salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "DL260001", status: "confirmed", versions: [{ id: "version-1", version: 1 }], boms: [{ id: "bom-1", version: 1 }] }) } };
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
