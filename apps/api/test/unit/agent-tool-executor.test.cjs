// 工具执行器的单元测试（假只读 client，不连数据库）。
//
// 执行器是模型与数据库之间的唯一通道，固定顺序：查 registry → 验参数 → 重查档位 →
// 只读查询 → 按档位投影 → 限制行数/字节数（docs/design/business-query-agent-v0-module-design-2026-10-25.md
// 「Tool executor 的顺序固定」）。测试证明：宽对象进不去、超行截得住、降权拦得下。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ToolExecutor } = require("../../dist/modules/business-query-agent/tools/tool-executor.js");

const USER_FULL = { user: { id: "u-boss", username: "boss", display_name: "老板" }, accessLevel: "full" };
const USER_OPS = { user: { id: "u-ops", username: "worker", display_name: "员工" }, accessLevel: "operational" };

/** 假只读 client：salesOrder 返回**带单价/金额的宽对象**，用于证明投影把它们剥掉。 */
function fakeReadClient({ rows = [], fail = false } = {}) {
  const calls = { findMany: 0 };
  return {
    calls,
    async readActiveRoleKeys() {}, // 占位：执行器实际注入的是独立 roleReader
    salesOrder: {
      findMany: async (args) => {
        calls.findMany += 1;
        if (fail) throw new Error("database down");
        return rows;
      },
    },
  };
}

function fakeRoleReader(roleKeys) {
  const seen = [];
  return { seen, calls: 0, async readActiveRoleKeys(userId) { this.seen.push(userId); this.calls += 1; return roleKeys; } };
}

const wideRow = (orderNo) => ({
  orderNo, productName: "手机壳", quantity: { toString: () => "100" }, unit: "个", status: "confirmed",
  deliveryDate: new Date("2026-11-01T00:00:00.000Z"), unitPrice: { toString: () => "9.9" }, totalAmount: { toString: () => "990" }, customerSnapshot: { name: "客户", phone: "13800000000" },
});

test("search_orders：宽对象只投影出 6 个允许字段，数量为字符串，来源逐行可追", async () => {
  const client = fakeReadClient({ rows: [wideRow("SO-001"), wideRow("SO-002")] });
  const executor = new ToolExecutor(client, fakeRoleReader(["qita"]));

  const fact = await executor.execute({ tool: "order_query", operation: "search_orders", args: { q: "SO" } }, USER_OPS);

  assert.equal(fact.operation, "search_orders");
  assert.equal(fact.access_level, "operational");
  assert.match(fact.as_of, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(fact.data[0]).sort(), ["delivery_date", "order_no", "product_name", "quantity", "status", "unit"].sort());
  assert.ok(!JSON.stringify(fact).includes("9.9"), "单价不得出现在结果里");
  assert.ok(!JSON.stringify(fact).includes("13800000000"), "客户快照不得出现在结果里");
  assert.equal(fact.data[0].quantity, "100");
  assert.deepEqual(fact.sources.map((source) => source.business_no), ["SO-001", "SO-002"]);
  assert.equal(fact.sources[0].business_type, "sales_order");
});

test("search_orders：结果超过 maxRows 截断到 20 行", async () => {
  const rows = Array.from({ length: 30 }, (_, index) => wideRow(`SO-${String(index + 1).padStart(3, "0")}`));
  const executor = new ToolExecutor(fakeReadClient({ rows }), fakeRoleReader(["qita"]));

  const fact = await executor.execute({ tool: "order_query", operation: "search_orders", args: { q: "SO" } }, USER_OPS);
  assert.equal(fact.data.length, 20);
});

test("operational 调 finance_query：在触达数据库前被拒（minAccess=full）", async () => {
  const client = fakeReadClient({ rows: [wideRow("SO-001")] });
  const executor = new ToolExecutor(client, fakeRoleReader(["qita"]));

  await assert.rejects(
    executor.execute({ tool: "finance_query", operation: "get_receivables", args: { order_no: "SO-001" } }, USER_OPS),
    (error) => error.getStatus() === 403,
  );
  assert.equal(client.calls.findMany, 0, "被拒的调用不得触达只读连接");
});

test("未注册 / 未实现的 operation 一律拒绝，不触达数据库", async () => {
  const client = fakeReadClient({ rows: [] });
  const executor = new ToolExecutor(client, fakeRoleReader(["qita"]));

  await assert.rejects(executor.execute({ tool: "order_query", operation: "drop_table", args: {} }, USER_OPS), (error) => error.getStatus() === 422);
  const fullExecutor = new ToolExecutor(client, fakeRoleReader(["laoban"]));
  await assert.rejects(fullExecutor.execute({ tool: "finance_query", operation: "not_an_operation", args: { order_no: "SO-001" } }, USER_FULL), (error) => error.getStatus() === 422, "P4-T3 完成后，未注册能力仍要显式拒绝");
  assert.equal(client.calls.findMany, 0);
});

test("参数校验：q 为空串/超长/缺失 → 400，不触达数据库", async () => {
  const client = fakeReadClient({ rows: [wideRow("SO-001")] });
  const executor = new ToolExecutor(client, fakeRoleReader(["qita"]));

  for (const args of [{}, { q: "" }, { q: "  " }, { q: "x".repeat(101) }, { q: "SO", page: 0 }, { q: "SO", extra: "nope" }]) {
    await assert.rejects(executor.execute({ tool: "order_query", operation: "search_orders", args }, USER_OPS), (error) => error.getStatus() === 400, `args=${JSON.stringify(args)} 应被拒`);
  }
  assert.equal(client.calls.findMany, 0);
});

test("执行前重查档位：角色被清空（denied）→ AGENT_ACCESS_REVOKED，不触达数据库", async () => {
  const client = fakeReadClient({ rows: [wideRow("SO-001")] });
  const executor = new ToolExecutor(client, fakeRoleReader([]));

  await assert.rejects(
    executor.execute({ tool: "order_query", operation: "search_orders", args: { q: "SO" } }, USER_OPS),
    (error) => error.getStatus() === 403 && error.getResponse().code === "AGENT_ACCESS_REVOKED",
  );
  assert.equal(client.calls.findMany, 0);
});

test("full 档可以调 search_orders，effective 档位随结果返回", async () => {
  const executor = new ToolExecutor(fakeReadClient({ rows: [wideRow("SO-001")] }), fakeRoleReader(["laoban"]));
  const fact = await executor.execute({ tool: "order_query", operation: "search_orders", args: { q: "SO", page: 1 } }, USER_FULL);
  assert.equal(fact.access_level, "full");
  assert.equal(fact.data.length, 1);
});
