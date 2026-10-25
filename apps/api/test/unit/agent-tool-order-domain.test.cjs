// 订单领域 5 个 operation 的单元测试（假只读 client，喂「带财务字段的宽行」）。
//
// 本批的通用红线：宽行里的财务字段（单价/金额/币种/应收应付）在投影结果里必须一个都不剩。
// overview/status 是「重建非财务汇总」而不是「从工作台返回里删字段」——所以测试喂的是
// 各表独立行，断言的是投影出的数量与 blocker 规则。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { assertOrderRoot, parseOrderRootInput } = require("../../dist/modules/business-query-agent/tools/order-root.js");
const { getOrderTimeline, getOrderAlerts } = require("../../dist/modules/business-query-agent/tools/order-query-tools.js");
const { getOrderOverview, getOrderStatus } = require("../../dist/modules/business-query-agent/tools/order-overview-tools.js");
const { getOrderAttachments } = require("../../dist/modules/business-query-agent/tools/attachment-tools.js");

const ORDER_NO = "SO-TEST-001";

/** 假只读 client：每张表返回一行「塞满财务字段」的宽行，记录 where 供断言。 */
function fakeClient(config = {}) {
  const calls = { tables: {} };
  const wide = (extra = {}) => ({ unit_price: "9.9", total_amount: "990", currency: "USD", receivable_amount: "500", settlement_unit_price: "9.8", payroll_amount: "77", ...extra });
  const table = (name, rows) => {
    calls.tables[name] = [];
    return {
      findMany: async (args) => { calls.tables[name].push(args); return typeof rows === "function" ? rows(args) : rows; },
      groupBy: async (args) => { calls.tables[name] = (calls.tables[name] ?? []).concat(args); return config.inventoryGroup ?? []; },
      findFirst: async (args) => { calls.tables[name] = (calls.tables[name] ?? []).concat(args); return "root" in config ? config.root : { id: "root-1", orderNo: ORDER_NO, quantity: { toString: () => "100" }, unit: "把", status: "confirmed", updatedAt: new Date() }; },
    };
  };
  return {
    calls,
    salesOrder: table("salesOrder", undefined),
    auditEvent: {
      findMany: async (args) => {
        calls.tables.auditEvent = calls.tables.auditEvent ?? []; calls.tables.auditEvent.push(args);
        const rows = config.audit ?? [{ id: "a1", action: "sales_order.confirm", entityType: "sales_order", entityId: "root-1", createdAt: new Date("2026-10-01T00:00:00Z") }, { id: "a2", action: "receivable_source.create", entityType: "receivable_source", entityId: "r1", createdAt: new Date("2026-10-02T00:00:00Z") }, { id: "a3", action: "finished_goods_outbound.post", entityType: "finished_goods_outbound", entityId: "f1", createdAt: new Date("2026-10-03T00:00:00Z") }];
        const or = args.where?.OR;
        // 模拟 Prisma 的 OR startsWith 下推：白名单过滤发生在查询里。
        return or ? rows.filter((row) => or.some((condition) => row.action.startsWith(condition.action.startsWith))) : rows;
      },
    },
    productionDailyAlert: table("productionDailyAlert", config.dailyAlerts ?? [{ id: "d1", alertType: "over_order", orderNo: ORDER_NO, createdAt: new Date() }]),
    finishedGoodsQcRecord: table("finishedGoodsQcRecord", config.qc ?? [{ id: "q1", orderNo: ORDER_NO, createdAt: new Date(), conclusion: "rejected", ...wide() }]),
    alertHandling: table("alertHandling", config.handling ?? []),
    bom: table("bom", config.boms ?? []),
    bomItem: table("bomItem", config.bomItems ?? [{ requiredQuantity: { toString: () => "300" }, unit: "套" }]),
    purchaseOrder: table("purchaseOrder", config.purchases ?? [{ purchaseOrderNo: "PO-1", status: "confirmed", supplierSnapshot: { name: "供应商甲", phone: "138", address: "某市" }, ...wide() }]),
    purchaseOrderItem: table("purchaseOrderItem", config.purchaseItems ?? [{ quantity: { toString: () => "250" }, unitId: "u1" }]),
    purchaseReceipt: table("purchaseReceipt", config.receipts ?? [{ receiptNo: "RC-1", status: "posted", quantity: { toString: () => "240" }, extensionData: { payable: "x" } }]),
    incomingInspection: table("incomingInspection", config.inspections ?? [{ id: "i1", status: "posted", inspectedQuantity: { toString: () => "240" }, acceptedQuantity: { toString: () => "230" }, conditionalQuantity: { toString: () => "5" }, rejectedQuantity: { toString: () => "5" } }]),
    productionOrder: table("productionOrder", config.production ?? [{ productionOrderNo: "PR-1", status: "in_progress", executionMode: "in_house", plannedQuantity: { toString: () => "100" }, ...wide() }]),
    operationDailyReport: table("operationDailyReport", config.reports ?? [{ completedQuantity: { toString: () => "60" } }]),
    rawMaterialMovement: table("rawMaterialMovement", config.movements ?? [{ documentType: "issue", status: "posted", lines: [{ quantity: { toString: () => "120" } }] }]),
    rawMaterialInbound: table("rawMaterialInbound", config.inbounds ?? [{ inboundNo: "RI-1", status: "posted", quantity: { toString: () => "230" } }]),
    inventoryFact: {
      findMany: async (args) => { calls.tables.inventoryFactFind = (calls.tables.inventoryFactFind ?? []).concat(args); return config.inventoryFacts ?? [{ inventoryCategory: "finished_goods", quantityDelta: { toString: () => "55" } }, { inventoryCategory: "raw_material", quantityDelta: { toString: () => "-5" } }]; },
      groupBy: async (args) => { calls.tables.inventoryFactGroup = (calls.tables.inventoryFactGroup ?? []).concat(args); return config.inventoryGroup ?? [{ orderNo: ORDER_NO, _sum: { quantityDelta: { lt: () => true } } }]; },
    },
    finishedGoodsInbound: table("finishedGoodsInbound", config.finishedInbounds ?? [{ inboundNo: "FI-1", status: "posted", quantity: { toString: () => "55" }, submission: { sourceType: "finished_goods_inbound_notice" } }]),
    finishedGoodsOutbound: table("finishedGoodsOutbound", config.outbounds ?? [{ outboundNo: "FO-1", status: "shipped", quantity: { toString: () => "40" }, salesOrder: { unitPrice: "9.9", receivableAmount: "900" } }]),
    finishedGoodsInboundNotice: table("finishedGoodsInboundNotice", config.notices ?? [{ noticeNo: "FN-1", status: "pending", noticeQuantity: { toString: () => "60" }, operationNameSnapshot: "包装" }]),
    attachmentLink: table("attachmentLink", config.links ?? [{ id: "l1", entityType: "sales_order", entityId: "root-1", mimeType: "image/png", fileSize: BigInt(2048), attachment: { mimeType: "image/png", fileSize: BigInt(2048), createdAt: new Date("2026-10-05T00:00:00Z"), fileName: "报价单-客户机密.png", storageKey: "uploads/secret.png" } }]),
  };
}

test("parseOrderRootInput：order_no 非空 ≤100，page 1..1000；拒绝空/超长/坏 page/额外字段", () => {
  assert.deepEqual(parseOrderRootInput({ order_no: ORDER_NO }), { orderNo: ORDER_NO });
  assert.deepEqual(parseOrderRootInput({ order_no: " SO ", page: 2 }), { orderNo: "SO", page: 2 });
  for (const bad of [{}, { order_no: "" }, { order_no: "x".repeat(101) }, { order_no: ORDER_NO, page: 0 }, { order_no: ORDER_NO, page: "2" }, { order_no: ORDER_NO, extra: 1 }]) {
    assert.throws(() => parseOrderRootInput(bad), undefined, `应拒绝 ${JSON.stringify(bad)}`);
  }
  // withPage:false 的操作连 page 都不收（overview/status 是单对象）
  assert.throws(() => parseOrderRootInput({ order_no: ORDER_NO, page: 2 }, { withPage: false }));
});

test("assertOrderRoot：未软删订单返回根行；软删/不存在 → 404 ORDER_NOT_FOUND", async () => {
  const client = fakeClient();
  const root = await assertOrderRoot(client, ORDER_NO);
  assert.equal(root.orderNo, ORDER_NO);
  assert.deepEqual(client.calls.tables.salesOrder[0].where, { orderNo: ORDER_NO, deletedAt: null }, "根查询必须带软删过滤");

  const missing = fakeClient({ root: null });
  await assert.rejects(assertOrderRoot(missing, "SO-GONE"), (error) => error.getStatus() === 404 && error.getResponse().code === "ORDER_NOT_FOUND");
});

test("get_order_overview：非财务汇总重建，财务 summary/字段一个不出现", async () => {
  const client = fakeClient();
  const result = await getOrderOverview(client, await assertOrderRoot(client, ORDER_NO));

  const json = JSON.stringify(result.data);
  for (const banned of ["receivable_summary", "payable_summary", "amounts", "unit_price", "total_amount", "currency", "receivable", "payable"]) {
    assert.ok(!json.includes(banned), `overview 不得出现 ${banned}`);
  }
  assert.equal(result.data.order_no, ORDER_NO);
  assert.equal(result.data.procurement_summary.counts.records, 1, "采购 summary 有记录数");
  assert.equal(result.data.procurement_summary.ordered_quantity, "250");
  assert.equal(result.data.procurement_summary.bom_required_quantity, "300");
  assert.ok(result.data.blockers.some((blocker) => blocker.code === "PROCUREMENT_SHORT_ORDER"), "采购少于 BOM 是数量 blocker");
  assert.ok(result.sources.some((source) => source.business_type === "sales_order" && source.business_no === ORDER_NO));
});

test("get_order_status：overall_status 用非财务状态源重算，blockers 无财务口径", async () => {
  // 工作台口径：生产阻塞 = 生产单处于 draft/paused（in_progress 不阻塞，只是进行中）。
  const client = fakeClient({ production: [{ productionOrderNo: "PR-1", status: "paused", executionMode: "in_house", plannedQuantity: { toString: () => "100" } }] });
  const result = await getOrderStatus(client, await assertOrderRoot(client, ORDER_NO));
  const json = JSON.stringify(result.data);
  for (const banned of ["receivable", "payable", "amount", "currency"]) assert.ok(!json.includes(banned));
  assert.ok(["not_started", "in_progress", "blocked", "ready_to_ship", "completed"].includes(result.data.overall_status));
  assert.ok(result.data.blockers.some((blocker) => blocker.code === "PRODUCTION_PENDING"), "生产单 in_progress → 生产阻塞");
});

test("get_order_timeline：非财务白名单过滤（财务动作不出），投影固定三字段无 details", async () => {
  const client = fakeClient();
  const fact = await getOrderTimeline(client, { orderNo: ORDER_NO }, 1);
  const actions = fact.data.map((row) => row.action);
  assert.deepEqual(actions, ["sales_order.confirm", "finished_goods_outbound.post"], "receivable_source.create 必须被白名单滤掉");
  for (const row of fact.data) {
    assert.deepEqual(Object.keys(row).sort(), ["action", "entity_type", "entity_id", "time"].sort());
  }
});

test("get_order_alerts：三源按订单下推 + 去重 + 处理状态合并", async () => {
  const client = fakeClient();
  const fact = await getOrderAlerts(client, { orderNo: ORDER_NO }, 1);
  const kinds = fact.data.map((row) => row.source_type).sort();
  assert.deepEqual(kinds, ["finished_goods_qc", "inventory", "production_daily_alert"], "三源都要有");
  assert.ok(client.calls.tables.productionDailyAlert[0].where.orderNo === ORDER_NO, "日报告警按订单下推");
  assert.ok(fact.data.every((row) => typeof row.severity === "string" && typeof row.title === "string"));
});

test("get_order_attachments：只有类型/大小/时间/实体，文件名与存储键不出", async () => {
  const client = fakeClient();
  const fact = await getOrderAttachments(client, { orderNo: ORDER_NO, id: "root-1" });
  const json = JSON.stringify(fact);
  for (const banned of ["file_name", "fileName", "storage_key", "storageKey", "报价单", "secret.png", "url", "download"]) {
    assert.ok(!json.includes(banned), `附件投影不得出现 ${banned}`);
  }
  assert.equal(fact.data.length, 1);
  assert.equal(fact.data[0].entity_type, "sales_order");
  assert.equal(fact.data[0].file_type, "image/png");
  assert.equal(fact.data[0].size, "2048");
});
