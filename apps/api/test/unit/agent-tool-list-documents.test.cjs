const assert = require("node:assert/strict");
const { test } = require("node:test");
const { listDocuments, parseListDocumentsInput, SALES_ORDER_STATUSES } = require("../../dist/modules/business-query-agent/tools/list-documents-tools.js");

function matches(row, where) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "deletedAt") return (row.deletedAt ?? null) === expected;
    if (key === "updatedAt") {
      const value = new Date(row.updatedAt).getTime();
      if (expected.gte !== undefined && value < expected.gte.getTime()) return false;
      if (expected.lte !== undefined && value > expected.lte.getTime()) return false;
      return true;
    }
    if (expected && typeof expected === "object" && "path" in expected) {
      const target = expected.path.reduce((node, segment) => (node == null ? undefined : node[segment]), row[key]);
      return typeof target === "string" && target.includes(expected.string_contains);
    }
    if (expected && typeof expected === "object" && "contains" in expected) {
      const hay = String(row[key] ?? "");
      return expected.mode === "insensitive" ? hay.toLowerCase().includes(String(expected.contains).toLowerCase()) : hay.includes(String(expected.contains));
    }
    return row[key] === expected;
  });
}

function model(rows) {
  return {
    async findMany({ where = {}, orderBy, skip = 0, take = 20 } = {}) {
      const found = rows.filter((row) => matches(row, where));
      if (orderBy?.updatedAt === "desc") found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return found.slice(skip, skip + take).map((row) => ({ ...row }));
    },
  };
}

const client = (sales = []) => ({ salesOrder: model(sales) });

const order = (orderNo, extra = {}) => ({
  orderNo,
  productName: "伞",
  quantity: { toString: () => "1000" },
  unit: "个",
  status: "confirmed",
  orderDate: new Date("2026-08-20T00:00:00.000Z"),
  deliveryDate: new Date("2026-09-20T00:00:00.000Z"),
  customerSnapshot: { name: "海风家居（模拟）" },
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
  ...extra,
});

test("status 白名单内的值解析成功", () => {
  const input = parseListDocumentsInput({ status: "confirmed" });
  assert.equal(input.status, "confirmed");
  assert.equal(input.page, 1);
});

test("status 不在白名单时抛错并列出允许值", () => {
  assert.throws(
    () => parseListDocumentsInput({ status: "已确认" }),
    (error) => error.getResponse().code === "AGENT_TOOL_ARGUMENT_INVALID" && SALES_ORDER_STATUSES.every((value) => error.getResponse().message.includes(value)),
  );
});

test("未知字段被拒绝", () => {
  assert.throws(
    () => parseListDocumentsInput({ bogus: 1 }),
    (error) => error.getResponse().code === "AGENT_TOOL_ARGUMENT_INVALID" && error.getResponse().message.includes("bogus"),
  );
});

test("无参数时解析成功且页码默认 1", () => {
  const input = parseListDocumentsInput({});
  assert.equal(input.page, 1);
  assert.equal(input.status, undefined);
});

test("日期格式不合法时抛错", () => {
  assert.throws(() => parseListDocumentsInput({ from: "2026/08/01" }), (error) => /YYYY-MM-DD/.test(error.getResponse().message));
  assert.throws(() => parseListDocumentsInput({ to: "2026-13-45" }), (error) => error.getResponse().code === "AGENT_TOOL_ARGUMENT_INVALID");
});

test("无数值时返回全部（受分页限制）", async () => {
  const rows = await listDocuments(client([order("MOCK-ORD-001"), order("MOCK-ORD-002")]), { page: 1 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].customer_name, "海风家居（模拟）");
});

test("status 过滤生效", async () => {
  const rows = await listDocuments(client([order("MOCK-ORD-001", { status: "confirmed" }), order("MOCK-ORD-002", { status: "draft" })]), { status: "draft", page: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].order_no, "MOCK-ORD-002");
});

test("customer_q 命中客户名，不匹配的订单不出现", async () => {
  const rows = await listDocuments(
    client([order("MOCK-ORD-001", { customerSnapshot: { name: "海风家居（模拟）" } }), order("MOCK-ORD-002", { customerSnapshot: { name: "远山贸易（模拟）" } })]),
    { customerQ: "海风", page: 1 },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].order_no, "MOCK-ORD-001");
});

test("product_q 按产品名片段过滤", async () => {
  const rows = await listDocuments(
    client([order("MOCK-ORD-001", { productName: "蓝色折叠伞" }), order("MOCK-ORD-002", { productName: "黑色直柄伞" })]),
    { productQ: "折叠", page: 1 },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].order_no, "MOCK-ORD-001");
});

test("分页每页 20 行", async () => {
  const many = Array.from({ length: 25 }, (_, index) => order(`MOCK-ORD-${String(index).padStart(3, "0")}`));
  const first = await listDocuments(client(many), { page: 1 });
  const second = await listDocuments(client(many), { page: 2 });
  assert.equal(first.length, 20);
  assert.equal(second.length, 5);
});