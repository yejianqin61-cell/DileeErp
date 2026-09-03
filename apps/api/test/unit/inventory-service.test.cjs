const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { InventoryService } = require("../../dist/platform/inventory/inventory.service.js");

test("raw material balance ignores facts for finished products", async () => {
  let aggregateCalled = false;
  const client = {
    material: { findFirst: async () => null },
    inventoryFact: { aggregate: async () => { aggregateCalled = true; return { _sum: { quantityDelta: new Prisma.Decimal("9") } }; } },
  };
  const result = await new InventoryService().rawMaterialBalance(client, "finished-1", "unit-1");
  assert.equal(result.toString(), "0");
  assert.equal(aggregateCalled, false);
});
