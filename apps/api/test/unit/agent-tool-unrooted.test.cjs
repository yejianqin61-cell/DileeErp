const assert = require("node:assert/strict");
const { test } = require("node:test");
const { listLowStockMaterials, listOverdueArrivals, parseUnrootedInput, UNROOTED_OPERATIONS } = require("../../dist/modules/business-query-agent/tools/unrooted-operations.js");
const { ToolExecutor } = require("../../dist/modules/business-query-agent/tools/tool-executor.js");

function inventoryClient(facts) {
  return {
    inventoryFact: {
      async findMany() {
        return facts;
      },
    },
  };
}

function purchaseClient(orders) {
  return {
    purchaseOrder: {
      async findMany() {
        return orders;
      },
    },
  };
}

const principal = { user: { id: "u1", username: "admin", display_name: "管理员" }, accessLevel: "operational" };
const roleReader = { async readActiveRoleKeys() { return ["laoban"]; } };

test("无根操作只接受 page，传 order_no 被拒绝并说明原因", () => {
  assert.throws(
    () => parseUnrootedInput({ order_no: "MOCK-ORD-001" }),
    (error) => error.getResponse().code === "AGENT_TOOL_ARGUMENT_INVALID" && error.getResponse().message.includes("order_no"),
  );
});

test("无根操作接受空参数，页码默认 1", () => {
  assert.equal(parseUnrootedInput({}).page, 1);
});

test("低库存按净额升序，且每条带口径说明", async () => {
  const facts = [
    { materialId: "m1", unitId: "u1", quantityDelta: "-5", material: { materialCode: "MOCK-M-001", name: "伞布" }, unit: { name: "码" } },
    { materialId: "m2", unitId: "u1", quantityDelta: "12", material: { materialCode: "MOCK-M-002", name: "伞骨" }, unit: { name: "个" } },
    { materialId: "m3", unitId: "u1", quantityDelta: "0", material: { materialCode: "MOCK-M-003", name: "包装袋" }, unit: { name: "个" } },
  ];
  const result = await listLowStockMaterials(inventoryClient(facts), { page: 1 });
  assert.deepEqual(result.data.map((row) => row.material_code), ["MOCK-M-001", "MOCK-M-003"]);
  assert.ok(result.data.every((row) => Number(row.net_quantity) <= 0));
  assert.match(result.data[0].basis, /净库存量/);
  assert.equal(result.sources[0].business_type, "material");
});

test("到货超期按预期日升序，带逾期天数与口径", async () => {
  const now = new Date("2026-11-23T00:00:00.000Z");
  const orders = [
    { purchaseOrderNo: "MOCK-PO-001", orderNo: "MOCK-ORD-001", status: "partially_arrived", expectedDate: new Date("2026-11-01T00:00:00.000Z"), supplierSnapshot: { name: "宁波伞布供应商（模拟）" } },
  ];
  const result = await listOverdueArrivals(purchaseClient(orders), { page: 1 }, now);
  assert.equal(result.data[0].overdue_days, 22);
  assert.equal(result.data[0].supplier_name, "宁波伞布供应商（模拟）");
  assert.match(result.data[0].basis, /expected_date/);
  assert.equal(result.sources[0].business_type, "purchase_order");
});

test("空数据返回空数组而不是报错", async () => {
  assert.deepEqual((await listLowStockMaterials(inventoryClient([]), { page: 1 })).data, []);
  assert.deepEqual((await listOverdueArrivals(purchaseClient([]), { page: 1 }, new Date())).data, []);
});

test("执行器：list_low_stock_materials 不带根也能执行", async () => {
  const executor = new ToolExecutor(inventoryClient([{ materialId: "m1", unitId: "u1", quantityDelta: "-1", material: { materialCode: "MOCK-M-001", name: "伞布" }, unit: { name: "码" } }]), roleReader);
  const fact = await executor.execute({ tool: "warehouse_query", operation: "list_low_stock_materials", args: {} }, principal);
  assert.equal(fact.order_no, null);
  assert.equal(fact.data.length, 1);
});

test("执行器：无根操作传 order_no 报参数错误，不报根缺失", async () => {
  const executor = new ToolExecutor(inventoryClient([]), roleReader);
  await assert.rejects(
    () => executor.execute({ tool: "warehouse_query", operation: "list_low_stock_materials", args: { order_no: "MOCK-ORD-001" } }, principal),
    (error) => error.getResponse().code === "AGENT_TOOL_ARGUMENT_INVALID",
  );
});

test("两个无根 operation 都登记在表里", () => {
  assert.deepEqual(Object.keys(UNROOTED_OPERATIONS).sort(), ["list_low_stock_materials", "list_overdue_arrivals"]);
});