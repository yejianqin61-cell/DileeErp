// 列表结果必须说清是否完整（审计 2026-11-28 D-4）。
//
// 查询结果超过 20 行时只给 20 行；结果里没有标记，模型会把这 20 条当全部回答。
// `has_more` = 本次返回之外还有行没给出；`total_count` 只在实现手里本来就有全量时给。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ToolExecutor } = require("../../dist/modules/business-query-agent/tools/tool-executor.js");
const { buildBaseSystemPrompt } = require("../../dist/modules/business-query-agent/tools/system-prompt.js");

const principal = { user: { id: "u1", username: "admin", display_name: "管理员" }, accessLevel: "operational" };
const executorFor = (client) => new ToolExecutor(client, { async readActiveRoleKeys() { return ["laoban"]; } });
const range = (count, build) => Array.from({ length: count }, (_, index) => build(index));
const decimal = (value) => ({ toString: () => String(value) });

/** 按 skip/take 切片的假表：分页语义要和数据库一致，否则测不出「下一页还有没有」。 */
function table(rows) {
  const calls = [];
  return { calls, findMany: async ({ skip = 0, take } = {}) => { calls.push({ skip, take }); return rows.slice(skip, take === undefined ? undefined : skip + take); } };
}

const root = { id: "so-id", orderNo: "SO-1", quantity: decimal(10), unit: "个", status: "confirmed", updatedAt: new Date("2026-11-01T00:00:00Z") };
const rootTable = { findFirst: async () => root };

const overdue = (index) => ({ purchaseOrderNo: `PO-${index}`, orderNo: "SO-1", status: "ordered", expectedDate: new Date("2026-01-01T00:00:00Z"), supplierSnapshot: {} });
const salesRow = (index) => ({ orderNo: `SO-${index}`, productName: "伞", quantity: decimal(1), unit: "个", status: "confirmed", deliveryDate: null, orderDate: null, customerSnapshot: null, updatedAt: new Date() });
const receipt = (index) => ({ receiptNo: `RC-${index}`, receivedDate: new Date(), quantity: decimal(1), status: "received", purchaseOrder: { purchaseOrderNo: "PO-1" } });

const run = (client, tool, operation, args) => executorFor(client).execute({ tool, operation, args }, principal);

test("无根列表 25 行：返回 20 行，has_more 为真并带总数", async () => {
  const fact = await run({ purchaseOrder: table(range(25, overdue)) }, "procurement_query", "list_overdue_arrivals", {});
  assert.equal(fact.data.length, 20);
  assert.equal(fact.has_more, true);
  assert.equal(fact.total_count, 25);
});

test("无根列表最后一页：has_more 为假", async () => {
  const fact = await run({ purchaseOrder: table(range(25, overdue)) }, "procurement_query", "list_overdue_arrivals", { page: 2 });
  assert.equal(fact.data.length, 5);
  assert.equal(fact.has_more, false);
  assert.equal(fact.total_count, 25);
});

test("数据库分页的列表：满页且下一页有行时 has_more 为真，来源不混入下一页", async () => {
  const fact = await run({ salesOrder: table(range(21, salesRow)) }, "order_query", "list_documents", {});
  assert.equal(fact.data.length, 20);
  assert.equal(fact.has_more, true);
  assert.equal(fact.sources.length, 20);
  assert.equal("total_count" in fact, false);
});

test("数据库分页的列表：恰好 20 行时 has_more 为假", async () => {
  const fact = await run({ salesOrder: table(range(20, salesRow)) }, "order_query", "search_orders", { q: "SO" });
  assert.equal(fact.data.length, 20);
  assert.equal(fact.has_more, false);
});

test("不满一页时不多查一次", async () => {
  const purchaseReceipt = table(range(3, receipt));
  const fact = await run({ salesOrder: rootTable, purchaseReceipt }, "procurement_query", "get_receipts", { order_no: "SO-1" });
  assert.equal(fact.has_more, false);
  assert.equal(purchaseReceipt.calls.length, 1);
});

test("以订单为根的分页列表：下一页有行时 has_more 为真", async () => {
  const fact = await run({ salesOrder: rootTable, purchaseReceipt: table(range(21, receipt)) }, "procurement_query", "get_receipts", { order_no: "SO-1" });
  assert.equal(fact.has_more, true);
});

test("BOM 明细按页返回，第二页给出剩下的行", async () => {
  const items = range(25, (index) => ({ bomId: "b1", sequence: index + 1, materialName: `料${index + 1}`, requiredQuantity: decimal(1), unit: "个" }));
  const client = { salesOrder: rootTable, bom: { findMany: async () => [{ id: "b1", version: 1, status: "released" }] }, bomItem: { findMany: async () => items } };
  const first = await run(client, "sales_query", "get_bom", { order_no: "SO-1" });
  const second = await run(client, "sales_query", "get_bom", { order_no: "SO-1", page: 2 });
  assert.equal(first.has_more, true);
  assert.equal(first.total_count, 25);
  assert.deepEqual(second.data.map((row) => row.sequence), [21, 22, 23, 24, 25]);
  assert.equal(second.has_more, false);
});

test("不分页的附件列表：超过 20 条时 has_more 为真，来源只列返回的行", async () => {
  const empty = { findMany: async () => [] };
  const links = range(25, (index) => ({ id: `l${index}`, entityType: "sales_order", entityId: `e${index}`, attachment: { mimeType: "image/png", fileSize: decimal(1), createdAt: new Date() } }));
  const client = { salesOrder: rootTable, attachmentLink: table(links) };
  for (const name of ["bom", "purchaseOrder", "purchaseReceipt", "productionOrder", "incomingInspection", "rawMaterialInbound", "rawMaterialMovement", "finishedGoodsQcRecord", "finishedGoodsInbound", "finishedGoodsInboundNotice", "finishedGoodsOutbound"]) client[name] = empty;
  const fact = await run(client, "order_query", "get_order_attachments", { order_no: "SO-1" });
  assert.equal(fact.data.length, 20);
  assert.equal(fact.has_more, true);
  assert.equal(fact.sources.length, 20);
});

test("不分页的外协流转：单条链超过 20 行时 has_more 为真", async () => {
  const batch = (index) => ({ batchNo: `B-${index}`, status: "dispatched", plannedQuantity: decimal(1), dispatchedQuantity: decimal(1), dispatchDate: null });
  const client = { salesOrder: rootTable, outsourceLogisticsBatch: table(range(25, batch)), outsourceReturnTransfer: table([]), outsourceDirectShipment: table([]) };
  const fact = await run(client, "production_query", "get_outsource_flow", { order_no: "SO-1" });
  assert.equal(fact.data.length, 20);
  assert.equal(fact.has_more, true);
});

test("按号检索超过 20 行时 has_more 为真", async () => {
  const client = { salesOrder: table(range(25, salesRow)), purchaseOrder: table([]), productionOrder: table([]) };
  const fact = await run(client, "order_query", "search_documents", { q: "SO" });
  assert.equal(fact.data.length, 20);
  assert.equal(fact.has_more, true);
});

test("按号检索：单类单据查到上限而归并后行数很少，仍标 has_more", async () => {
  const purchase = (index) => ({ purchaseOrderNo: `PO-${index}`, orderNo: "SO-1", status: "ordered", purchaseDate: null, expectedDate: null, updatedAt: new Date() });
  const client = { salesOrder: table([]), purchaseOrder: table(range(25, purchase)), productionOrder: table([]) };
  const fact = await run(client, "order_query", "search_documents", { q: "SO-1" });
  assert.equal(fact.data.length, 1);
  assert.equal(fact.has_more, true);
});

test("单对象结果不带完整性标记", async () => {
  const salesOrder = { findFirst: async () => ({ ...root, productName: "伞" }) };
  const fact = await run({ salesOrder }, "sales_query", "get_sales_order", { order_no: "SO-1" });
  assert.equal("has_more" in fact, false);
});

test("系统指令要求结果不完整时据实说明", () => {
  const prompt = buildBaseSystemPrompt("operational");
  assert.ok(prompt.includes("has_more"));
  assert.ok(prompt.includes("只列了部分"));
});
