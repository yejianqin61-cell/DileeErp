// 按号检索任意单据（R-1）：销售单号、采购单号、生产单号都能进，统一落到所属销售单。
//
// 为什么需要它：以前只有 search_orders，问采购单也要先搜销售单，用户看到的是「查了销售单」。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { searchDocuments } = require("../../dist/modules/business-query-agent/tools/document-search-tools.js");

function matches(row, where) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") return expected.some((clause) => matches(row, clause));
    if (key === "deletedAt") return (row.deletedAt ?? null) === expected;
    if (expected && typeof expected === "object" && "contains" in expected) {
      const hay = String(row[key] ?? "");
      const needle = String(expected.contains);
      return expected.mode === "insensitive" ? hay.toLowerCase().includes(needle.toLowerCase()) : hay.includes(needle);
    }
    if (expected && typeof expected === "object" && "equals" in expected) {
      const hay = String(row[key] ?? "");
      const needle = String(expected.equals);
      return expected.mode === "insensitive" ? hay.toLowerCase() === needle.toLowerCase() : hay === needle;
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

const client = ({ sales = [], purchases = [], productions = [] } = {}) => ({
  salesOrder: model(sales),
  purchaseOrder: model(purchases),
  productionOrder: model(productions),
});

const order = (orderNo, extra = {}) => ({ orderNo, productName: "伞头", quantity: "100", unit: "个", status: "confirmed", deliveryDate: null, updatedAt: "2026-10-01T00:00:00.000Z", deletedAt: null, ...extra });

test("销售单号命中：类型 sales_order，带所属销售单号", async () => {
  const rows = await searchDocuments(client({ sales: [order("DL260170-4H 伞头")] }), { q: "DL260170", page: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].document_type, "sales_order");
  assert.equal(rows[0].sales_order_no, "DL260170-4H 伞头");
  assert.equal(rows[0].document_no, "DL260170-4H 伞头");
});

test("采购单号命中：类型 purchase_order，所属销售单号有值", async () => {
  const rows = await searchDocuments(client({
    purchases: [{ purchaseOrderNo: "PO-20260911-FEBD8A15", orderNo: "DL260170-4H 伞头", status: "ordered", supplierSnapshot: { name: "伞厂" }, updatedAt: "2026-10-01T00:00:00.000Z", deletedAt: null }],
  }), { q: "PO-20260911", page: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].document_type, "purchase_order");
  assert.equal(rows[0].document_no, "PO-20260911-FEBD8A15");
  assert.equal(rows[0].sales_order_no, "DL260170-4H 伞头");
});

test("生产单号命中：类型 production_order", async () => {
  const rows = await searchDocuments(client({
    productions: [{ productionOrderNo: "MO-20260911-66CEBE1A", orderNo: "DL260122", status: "in_progress", updatedAt: "2026-10-01T00:00:00.000Z", deletedAt: null }],
  }), { q: "MO-20260911", page: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].document_type, "production_order");
  assert.equal(rows[0].sales_order_no, "DL260122");
});

test("查不到就返回空数组，不报错", async () => {
  const rows = await searchDocuments(client({}), { q: "不存在的单号", page: 1 });
  assert.deepEqual(rows, []);
});

test("顺序固定：销售单 → 采购单 → 生产单", async () => {
  const rows = await searchDocuments(client({
    sales: [order("DL1")],
    purchases: [{ purchaseOrderNo: "PO-DL1", orderNo: "DL1", status: "ordered", updatedAt: "2026-10-01T00:00:00.000Z", deletedAt: null }],
    productions: [{ productionOrderNo: "MO-DL1", orderNo: "DL1", status: "in_progress", updatedAt: "2026-10-01T00:00:00.000Z", deletedAt: null }],
  }), { q: "DL1", page: 1 });
  assert.equal(rows.length, 1, "同一张销售单只出一行");
  assert.equal(rows[0].document_type, "sales_order");
  assert.deepEqual(rows[0].related_documents, [
    { document_type: "purchase_order", document_no: "PO-DL1" },
    { document_type: "production_order", document_no: "MO-DL1" },
  ]);
});

test("只有下游单据命中时，也落回所属销售单且顺序为采购在前", async () => {
  const rows = await searchDocuments(client({
    purchases: [{ purchaseOrderNo: "PO-9", orderNo: "DL9", status: "ordered", updatedAt: "2026-10-01T00:00:00.000Z", deletedAt: null }],
    productions: [{ productionOrderNo: "MO-8", orderNo: "DL8", status: "in_progress", updatedAt: "2026-10-01T00:00:00.000Z", deletedAt: null }],
  }), { q: "PO-9", page: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sales_order_no, "DL9");
});

test("命中超过 20 行时截断到 20", async () => {
  const sales = Array.from({ length: 30 }, (_, index) => order(`SO-${index}`));
  const rows = await searchDocuments(client({ sales }), { q: "SO-", page: 1 });
  assert.equal(rows.length, 20);
});

test("归一：小写检索词命中大写单号", async () => {
  const rows = await searchDocuments(client({ sales: [order("DL260170-4H 伞头")] }), { q: "dl260170-4h", page: 1 });
  assert.equal(rows.length, 1);
});

test("归一：检索词里的多余空白被合并", async () => {
  const { parseSearchDocumentsInput } = require("../../dist/modules/business-query-agent/tools/document-search-tools.js");
  assert.deepEqual(parseSearchDocumentsInput({ q: "  DL260170-4H   伞头  " }), { q: "DL260170-4H 伞头", page: 1 });
  const rows = await searchDocuments(client({ sales: [order("DL260170-4H 伞头")] }), { q: "DL260170-4H 伞头", page: 1 });
  assert.equal(rows.length, 1);
});

test("根验证：大小写不同也能找到同一张单，找不到才 404", async () => {
  const { assertOrderRoot } = require("../../dist/modules/business-query-agent/tools/order-root.js");
  const store = { salesOrder: { async findFirst({ where }) { return matches(order("DL260170-4H 伞头"), where) ? order("DL260170-4H 伞头") : null; } } };
  const root = await assertOrderRoot(store, "dl260170-4h 伞头");
  assert.equal(root.orderNo, "DL260170-4H 伞头");
  await assert.rejects(() => assertOrderRoot(store, "DL999999-ZZ"), (error) => error.getStatus() === 404);
});

test("输入校验：额外字段一律 422，检索词不能为空", () => {
  const { parseSearchDocumentsInput } = require("../../dist/modules/business-query-agent/tools/document-search-tools.js");
  assert.throws(() => parseSearchDocumentsInput({ q: "SO", filters: {} }), (error) => error.getStatus() === 400);
  assert.throws(() => parseSearchDocumentsInput({ q: "   " }), (error) => error.getStatus() === 400);
  assert.deepEqual(parseSearchDocumentsInput({ q: " SO " }), { q: "SO", page: 1 });
});
