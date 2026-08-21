const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { BomsService } = require("../dist/modules/sales/boms.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };

function serviceWithBom(bom) {
  return new BomsService({ bom: { findFirst: async () => bom, update: async () => bom } }, { update: () => ({ updatedBy: user.id }), record: async () => {} });
}

test("empty draft BOM cannot be published", async () => {
  const service = serviceWithBom({ id: "bom-1", status: "draft", orderNo: "DL260001", version: 1, items: [] });
  await assert.rejects(() => service.publish("bom-1", user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "BOM_ITEMS_REQUIRED");
});

test("published BOM cannot be edited in place", async () => {
  const service = serviceWithBom({ id: "bom-1", status: "published", orderNo: "DL260001", version: 1, items: [{ id: "item-1" }] });
  await assert.rejects(() => service.update("bom-1", {}, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "BOM_PUBLISHED_READ_ONLY");
});
