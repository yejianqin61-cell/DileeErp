// 单据清单与时间线（T09）：一批的全部表单，按模块分组。
//
// 老板原话：「查看当时该批货号的采购，生产，QC 的所有表单，信息」——
// 本文件钉住「这一批到底有哪些单、能不能被人拿走别的批的单」。
// 设计：docs/design/reorder-item-no-and-summary-2026-09-26.md §三.2、§一.1
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BadRequestException, NotFoundException } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
const { ReorderService } = require("../../dist/modules/reorder/reorder.service.js");
const { DOCUMENT_GROUPS, TIMELINE_LIMIT } = require("../../dist/modules/reorder/reorder.domain.js");

const decimal = (value) => new Prisma.Decimal(value);

/** 假 Prisma：17 组各自的来源表都实现一遍，默认空；测试只填关心的那几张。 */
function fakePrisma(rows = {}) {
  const table = (name) => ({ findMany: async (arguments_) => { rows.calls = rows.calls ?? {}; rows.calls[name] = arguments_; return rows[name] ?? []; } });
  return {
    // `"order" in rows` 而不是 `rows.order ?? 默认`：测试要能显式传 `null` 表示"这张单查不到"，
    // 用 `??` 会把显式的 null 当成"没传"，于是测出来的是默认那张单 —— 断言就白写了。
    salesOrder: { findFirst: async () => ("order" in rows ? rows.order : { id: "order-1", orderNo: "DL260001-1", itemNo: "27621 流水花扇", deletedAt: null }) },
    bom: table("boms"),
    purchaseOrder: table("purchaseOrders"),
    purchaseReceipt: table("receipts"),
    incomingInspection: table("inspections"),
    rawMaterialInbound: table("inbounds"),
    productionOrder: table("productionOrders"),
    rawMaterialMovement: table("movements"),
    operationDailyReport: table("dailyReports"),
    finishedGoodsInspectionSubmission: table("submissions"),
    finishedGoodsQcRecord: table("qcRecords"),
    finishedGoodsInboundNotice: table("notices"),
    finishedGoodsInbound: table("finishedInbounds"),
    finishedGoodsDefective: table("defectives"),
    finishedGoodsOutbound: table("outbounds"),
    receivableSource: table("receivables"),
    payableSource: table("payableSources"),
    supplierPayableEntry: table("payables"),
    auditEvent: table("auditEvents"),
  };
}

const groupOf = (result, type) => result.groups.find((group) => group.document_type === type);

// ------------------------------------------------------------------ 守卫

test("单据清单：17 个分组**恒存在**（空组也给 documents: []）", async () => {
  const result = await new ReorderService(fakePrisma()).orderDocuments("27621 流水花扇", "DL260001-1");
  assert.equal(result.groups.length, DOCUMENT_GROUPS.length);
  assert.deepEqual(result.groups.map((group) => group.document_type), DOCUMENT_GROUPS.map((group) => group.type));
  for (const group of result.groups) {
    // 「空组」与「没有这个模块」是两条不同的信息：老板要问的正是"当时有没有做 QC"。
    assert.deepEqual(group.documents, [], `${group.document_type} 应给空数组而不是缺组`);
    assert.ok(group.label.length > 0, `${group.document_type} 必须有中文名`);
  }
});

test("单据清单：订单不属于该货号 → 404 ORDER_NOT_IN_ARTICLE（否则就是一条取任意订单单据的通道）", async () => {
  const service = new ReorderService(fakePrisma({ order: { id: "o", orderNo: "DL260999-1", itemNo: "88001", deletedAt: null } }));
  await assert.rejects(
    () => service.orderDocuments("27621 流水花扇", "DL260999-1"),
    (error) => error instanceof NotFoundException && error.getResponse().code === "ORDER_NOT_IN_ARTICLE",
  );
});

test("单据清单：订单不存在或已软删 → 404 ORDER_NOT_FOUND", async () => {
  for (const order of [null, { id: "o", orderNo: "DL260001-1", itemNo: "27621 流水花扇", deletedAt: new Date() }]) {
    const service = new ReorderService(fakePrisma({ order }));
    await assert.rejects(
      () => service.orderDocuments("27621 流水花扇", "DL260001-1"),
      (error) => error instanceof NotFoundException && error.getResponse().code === "ORDER_NOT_FOUND",
    );
  }
});

test("单据清单：大小写/空白变体的货号也能通过守卫（归一后再比）", async () => {
  const service = new ReorderService(fakePrisma({ order: { id: "o", orderNo: "DL260001-1", itemNo: "DL27621", deletedAt: null } }));
  const result = await service.orderDocuments("dl27621", "DL260001-1");
  assert.equal(result.item_no, "DL27621");
});

// ------------------------------------------------------------------ 逐组映射

test("单据清单：采购单/到货/生产单/成品 QC 的关键字段都映射出来（单号、日期、数量、状态中文）", async () => {
  const result = await new ReorderService(fakePrisma({
    purchaseOrders: [{ id: "po-1", purchaseOrderNo: "PO-1", purchaseDate: new Date("2026-05-03"), createdAt: new Date("2026-05-01"), status: "ordered", totalAmount: decimal("12345.6"), currency: "CNY", supplierSnapshot: { name: "某某五金厂" } }],
    receipts: [{ id: "rc-1", receiptNo: "RC-1", receivedDate: new Date("2026-05-20"), quantity: decimal("1200"), status: "received" }],
    productionOrders: [{ id: "pr-1", productionOrderNo: "PR-1", plannedQuantity: decimal("1960"), status: "in_progress", executionMode: "in_house", plannedStartedOn: new Date("2026-06-01"), completedOn: null, deliveryDueOn: null, createdAt: new Date("2026-05-25"), unit: { name: "支" }, executionLocation: { name: "本厂" } }],
    qcRecords: [{ id: "qc-1", qcNo: "QC-1", inspectionDate: new Date("2026-07-01"), inspectedQuantity: decimal("1960"), qualifiedQuantity: decimal("1930"), conditionalAcceptQuantity: decimal("0"), rejectedQuantity: decimal("30"), conclusion: "qualified_with_rejects", status: "active", rejectionReason: "破洞" }],
  })).orderDocuments("27621 流水花扇", "DL260001-1");

  const purchase = groupOf(result, "purchase_order").documents[0];
  assert.equal(purchase.document_no, "PO-1");
  assert.equal(purchase.date, "2026-05-03T00:00:00.000Z", "用业务日期（采购日期），不是 createdAt");
  assert.equal(purchase.date_source, "business");
  assert.equal(purchase.status_label, "已下单");
  assert.equal(purchase.extra.amount, "12345.6");
  assert.equal(purchase.extra.supplier_name, "某某五金厂");

  const production = groupOf(result, "production_order").documents[0];
  assert.equal(production.document_no, "PR-1");
  assert.equal(production.quantity, "1960");
  assert.equal(production.unit, "支");
  assert.equal(production.status_label, "生产中");
  assert.equal(production.extra.execution_location, "本厂");

  const qc = groupOf(result, "finished_qc").documents[0];
  assert.equal(qc.document_no, "QC-1");
  assert.equal(qc.status_label, "qualified_with_rejects", "认不出的状态原样返回状态码，不返回空字符串");
  assert.equal(qc.extra.rejected_quantity, "30");
});

test("单据清单：没有业务日期列的仓库单据回落到 createdAt，并标 date_source=created_at", async () => {
  const result = await new ReorderService(fakePrisma({
    inbounds: [{ id: "in-1", inboundNo: "IN-1", quantity: decimal("1200"), status: "posted", createdAt: new Date("2026-05-22T03:00:00Z"), unit: { name: "根" }, material: { name: "伞骨" } }],
    finishedInbounds: [{ id: "fi-1", inboundNo: "FI-1", quantity: decimal("1930"), status: "posted", createdAt: new Date("2026-07-05T02:00:00Z"), productNameSnapshot: "三折伞" }],
  })).orderDocuments("27621 流水花扇", "DL260001-1");

  const inbound = groupOf(result, "raw_material_inbound").documents[0];
  assert.equal(inbound.date_source, "created_at", "原料入库表没有业务日期列：必须标出这是登记时间");
  assert.equal(inbound.date, "2026-05-22T03:00:00.000Z");
  assert.equal(inbound.extra.material_name, "伞骨");
  assert.equal(groupOf(result, "finished_inbound").documents[0].date_source, "created_at");
});

test("单据清单：领料/补料/退料按 documentType 分类并给中文，数量取明细行合计", async () => {
  const result = await new ReorderService(fakePrisma({
    movements: [
      { id: "mv-1", movementNo: "MV-1", documentType: "issue", status: "posted", businessDate: new Date("2026-06-02"), reason: null, lines: [{ quantity: decimal("100") }, { quantity: decimal("50") }] },
      { id: "mv-2", movementNo: "MV-2", documentType: "replenishment", status: "draft", businessDate: new Date("2026-06-10"), reason: "坏片", lines: [{ quantity: decimal("20") }] },
    ],
  })).orderDocuments("27621 流水花扇", "DL260001-1");
  const documents = groupOf(result, "material_movement").documents;
  assert.equal(documents[0].quantity, "150", "数量是明细行合计");
  assert.equal(documents[0].extra.document_type_label, "领料");
  assert.equal(documents[1].extra.document_type_label, "补料");
  assert.equal(documents[1].extra.reason, "坏片");
});

test("单据清单：工序日报**聚合成一行**（一个工序一条），带条数与首末日", async () => {
  const result = await new ReorderService(fakePrisma({
    dailyReports: [
      { id: "d-1", productionOrderNoSnapshot: "PR-1", operationNameSnapshot: "缝伞", reportDate: new Date("2026-06-05"), completedQuantity: decimal("500"), unit: { name: "支" } },
      { id: "d-2", productionOrderNoSnapshot: "PR-1", operationNameSnapshot: "缝伞", reportDate: new Date("2026-06-06"), completedQuantity: decimal("700"), unit: { name: "支" } },
      { id: "d-3", productionOrderNoSnapshot: "PR-1", operationNameSnapshot: "打顶", reportDate: new Date("2026-06-04"), completedQuantity: decimal("900"), unit: { name: "支" } },
    ],
  })).orderDocuments("27621 流水花扇", "DL260001-1");
  const documents = groupOf(result, "operation_daily_report").documents;
  assert.equal(documents.length, 2, "两个工序两行，不是逐条日报");
  const sewing = documents.find((row) => row.extra.operation_name === "缝伞");
  assert.equal(sewing.quantity, "1200");
  assert.equal(sewing.extra.report_count, 2);
  assert.equal(sewing.date, "2026-06-06T00:00:00.000Z", "日期取最后一条日报");
  assert.equal(sewing.extra.first_report_date, "2026-06-05T00:00:00.000Z");
});

test("单据清单：来料质检没有单号 → 用「到货单号 质检」标识，并带上 receipt_id 供深链", async () => {
  const result = await new ReorderService(fakePrisma({
    inspections: [{ id: "ins-1", status: "accepted", qcResult: "all_inbound", createdAt: new Date("2026-05-21"), inspectedQuantity: decimal("1200"), acceptedQuantity: decimal("1200"), conditionalQuantity: decimal("0"), rejectedQuantity: decimal("0"), purchaseReceiptId: "rc-1", purchaseReceipt: { receiptNo: "RC-1" } }],
  })).orderDocuments("27621 流水花扇", "DL260001-1");
  const inspection = groupOf(result, "incoming_inspection").documents[0];
  assert.equal(inspection.document_no, "RC-1 质检");
  assert.equal(inspection.extra.receipt_id, "rc-1");
  assert.equal(inspection.extra.accepted_quantity, "1200");
  assert.equal(inspection.date_source, "created_at");
});

test("单据清单：应付来源用「入库单号/到货单号」标识（绝不甩 UUID 给人看）", async () => {
  const result = await new ReorderService(fakePrisma({
    payableSources: [{ id: "ps-1", amount: decimal("1200"), currency: "CNY", status: "pending_finance", createdAt: new Date("2026-05-22"), purchaseReceipt: { receiptNo: "RC-1" }, rawMaterialInbound: { inboundNo: "IN-1" }, purchaseOrder: { purchaseOrderNo: "PO-1" } }],
  })).orderDocuments("27621 流水花扇", "DL260001-1");
  const payable = groupOf(result, "payable_source").documents[0];
  assert.equal(payable.document_no, "IN-1");
  assert.equal(payable.status_label, "待财务");
  assert.equal(payable.extra.purchase_order_no, "PO-1");
  // `source_id` 是给前端拼跳转用的内部 id（设计如此）；要钉的是**给人看的单号**里没有 id。
  assert.equal(String(payable.document_no).includes("ps-1"), false, "单号不能是内部 id");
});

test("单据清单：软删的单据被排除（每组查询都带 deletedAt: null）", async () => {
  const rows = { calls: {} };
  const prisma = fakePrisma(rows);
  await new ReorderService(prisma).orderDocuments("27621 流水花扇", "DL260001-1");
  for (const name of ["boms", "purchaseOrders", "receipts", "inspections", "inbounds", "productionOrders", "movements", "dailyReports", "submissions", "qcRecords", "notices", "finishedInbounds", "defectives", "outbounds", "receivables", "payables"]) {
    assert.equal(rows.calls[name]?.where?.orderNo, "DL260001-1", `${name} 必须按本单过滤`);
    assert.equal(rows.calls[name]?.where?.deletedAt, null, `${name} 必须排除软删`);
  }
});

test("单据清单：金额与数量一律字符串，没有单一数量的单据 quantity 给 null（不硬凑）", async () => {
  const result = await new ReorderService(fakePrisma({
    purchaseOrders: [{ id: "po-1", purchaseOrderNo: "PO-1", purchaseDate: null, createdAt: new Date("2026-05-01"), status: "draft", totalAmount: decimal("0"), currency: "CNY", supplierSnapshot: null }],
  })).orderDocuments("27621 流水花扇", "DL260001-1");
  const purchase = groupOf(result, "purchase_order").documents[0];
  assert.equal(purchase.quantity, null, "采购单没有「一个数量」，给 null 而不是 0");
  assert.equal(purchase.extra.amount, "0", "金额是字符串，0 也给 \"0\"");
  assert.equal(purchase.date_source, "created_at", "没有采购日期时回落 createdAt");
  assert.equal(purchase.extra.supplier_name, null);
});

// ------------------------------------------------------------------ 时间线

test("时间线：指定 order_no 时只看这一批；查询按时间倒排、多取一条用于判断截断", async () => {
  const rows = { calls: {}, auditEvents: [
    { id: "e-2", action: "production_order.create", entityType: "production_order", entityId: "p", actorId: "u", orderNo: "DL260001-1", details: {}, createdAt: new Date("2026-05-20") },
    { id: "e-1", action: "sales_order.create", entityType: "sales_order", entityId: "o", actorId: "u", orderNo: "DL260001-1", details: {}, createdAt: new Date("2026-05-01") },
  ] };
  const timeline = await new ReorderService(fakePrisma(rows)).articleTimeline("27621 流水花扇", "DL260001-1");
  assert.deepEqual(timeline.order_nos, ["DL260001-1"]);
  // 排序由**数据库**做（假 Prisma 不会排序），所以这里断言的是"要求数据库怎么排"。
  assert.deepEqual(rows.calls.auditEvents.orderBy, { createdAt: "desc" }, "倒排：最近的在最前");
  assert.equal(rows.calls.auditEvents.take, TIMELINE_LIMIT + 1, "多取一条用来判断有没有被截断");
  assert.deepEqual(rows.calls.auditEvents.where.orderNo.in, ["DL260001-1"]);
  assert.deepEqual(timeline.events.map((event) => event.id), ["e-2", "e-1"]);
  assert.equal(timeline.events[0].created_at, "2026-05-20T00:00:00.000Z");
  assert.equal(timeline.truncated, false);
});

test("时间线：不给 order_no 时合并**整个货号**的订单号（含写法变体），并去重", async () => {
  const rows = {
    calls: {},
    orders: [],
    auditEvents: [],
  };
  const prisma = fakePrisma({ ...rows, calls: rows.calls });
  prisma.salesOrder.findMany = async () => ([
    { id: "o-1", orderNo: "A-1", itemNo: "27621 流水花扇", orderDate: new Date("2026-01-01"), deliveryDate: null, status: "closed", currentVersion: 1, quantity: decimal("10"), unit: "支", currency: "USD", productName: "伞", customerId: "c", customerSnapshot: { name: "X" }, reorderFromOrderNo: null },
    { id: "o-2", orderNo: "A-2", itemNo: "27621\u3000流水花扇", orderDate: new Date("2026-02-01"), deliveryDate: null, status: "closed", currentVersion: 1, quantity: decimal("10"), unit: "支", currency: "USD", productName: "伞", customerId: "c", customerSnapshot: { name: "X" }, reorderFromOrderNo: null },
    { id: "o-3", orderNo: "B-1", itemNo: "88001", orderDate: new Date("2026-03-01"), deliveryDate: null, status: "closed", currentVersion: 1, quantity: decimal("10"), unit: "支", currency: "USD", productName: "伞", customerId: "c", customerSnapshot: { name: "X" }, reorderFromOrderNo: null },
  ]);
  const timeline = await new ReorderService(prisma).articleTimeline("27621 流水花扇");
  assert.deepEqual(timeline.order_nos, ["A-1", "A-2"], "只合并同一个货号（含全角空格变体），不含别的货号");
});

test("时间线：超过上限时回报 truncated=true（静默截断会让人以为这就是全部）", async () => {
  const events = Array.from({ length: TIMELINE_LIMIT + 5 }, (_, index) => ({ id: `e-${index}`, action: "x", entityType: "y", entityId: "z", actorId: "u", orderNo: "DL260001-1", details: {}, createdAt: new Date(2026, 0, 1, 0, 0, index) }));
  const timeline = await new ReorderService(fakePrisma({ auditEvents: events })).articleTimeline("27621 流水花扇", "DL260001-1");
  assert.equal(timeline.truncated, true);
  assert.equal(timeline.events.length, TIMELINE_LIMIT);
});

test("时间线：货号不存在 → 404 ARTICLE_NOT_FOUND", async () => {
  const prisma = fakePrisma();
  prisma.salesOrder.findMany = async () => [];
  await assert.rejects(
    () => new ReorderService(prisma).articleTimeline("不存在的货号"),
    (error) => error instanceof NotFoundException && error.getResponse().code === "ARTICLE_NOT_FOUND",
  );
  void BadRequestException;
});

// ------------------------------------------------------------------ 与工作台的口径交叉

test("交叉一致：同一个订单，返单模块的采购金额与 QC 合格数必须与工作台相等", async () => {
  // 这条断言是**防止两套口径漂移**的关键：返单页与工作台都会回答"这张单采购了多少、QC 合格多少"，
  // 两边对不上时业务会先怀疑数据、再怀疑系统，最后谁都不信。
  const { OrderWorkbenchService } = require("../../dist/modules/order-workbench/order-workbench.service.js");
  const order = {
    id: "order-1", orderNo: "DL260001-1", itemNo: "27621 流水花扇", orderDate: new Date("2026-06-18"), deliveryDate: null,
    status: "confirmed", currentVersion: 1, quantity: decimal("1960"), unit: "支", currency: "USD",
    productName: "三折伞", customerId: "customer-1", customerSnapshot: { name: "FLOWER1" }, reorderFromOrderNo: null,
  };
  const purchases = [
    { orderNo: "DL260001-1", totalAmount: decimal("100.5"), currency: "CNY" },
    { orderNo: "DL260001-1", totalAmount: decimal("200.25"), currency: "CNY" },
  ];
  const qcRows = [
    { orderNo: "DL260001-1", inspectedQuantity: decimal("1960"), qualifiedQuantity: decimal("1930"), conditionalAcceptQuantity: decimal("0"), rejectedQuantity: decimal("30") },
  ];
  /** 工作台要查 20 张表，其中大多数与这条断言无关：用 Proxy 给"没提到的表"一个空表。 */
  const emptyTable = { findMany: async () => [], count: async () => 0, findFirst: async () => null, groupBy: async () => [] };
  const prisma = new Proxy({ salesOrder: { findFirst: async () => order, findMany: async () => [order] }, purchaseOrder: { findMany: async () => purchases }, finishedGoodsQcRecord: { findMany: async () => qcRows } }, {
    get: (target, property) => (property in target ? target[property] : emptyTable),
  });

  const workbench = await new OrderWorkbenchService(prisma).summary("DL260001-1");
  const article = (await new ReorderService(prisma).listArticles({})).data[0];

  // 工作台把采购金额**跨币种**加成一个数（它自己的既有口径），所以这里只用单一币种做对照；
  // 返单模块更严：按币种分行，永不跨币种相加。
  assert.equal(article.purchase_amounts.length, 1);
  assert.equal(article.purchase_amounts[0].amount, workbench.procurement_summary.amounts.amount);
  assert.equal(article.qc.qualified, workbench.finished_goods_qc_summary.qualified_quantity);
  assert.equal(article.qc.rejected, workbench.finished_goods_qc_summary.rejected_quantity);
});
