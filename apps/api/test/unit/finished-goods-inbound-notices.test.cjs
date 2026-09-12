const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { UnprocessableEntityException } = require("@nestjs/common");
const { FinishedGoodsInboundNoticesService } = require("../../dist/modules/production/finished-goods-inbound-notices.service.js");
const { syncFinishedGoodsInboundNoticeStatus } = require("../../dist/modules/production/finished-goods-inbound-notice-status.js");
const { FinishedGoodsQcService } = require("../../dist/modules/production/finished-goods-qc.service.js");

// 成品入库通知（分批）：包装工序累计报工量 = 可通知量；生产手动分批发通知；
// 仓库按通知送检/QC，QC 合格量再入库；通知状态随送检/入库进度推导。

const auditStub = () => ({ create: () => ({}), update: () => ({}), softDelete: () => ({}), record: async () => undefined });

function order(overrides = {}) {
  return {
    id: "order-1", orderNo: "SO-1", productionOrderNo: "MO-1", executionMode: "in_house", status: "in_progress",
    plannedQuantity: new Prisma.Decimal("100"), unitId: "unit-1", unit: { id: "unit-1", name: "个" }, productSpecification: "24骨",
    operations: [
      { id: "op-1", operationNameSnapshot: "缝伞", status: "active", sequenceNo: 1, targetQuantity: new Prisma.Decimal("100") },
      { id: "op-2", operationNameSnapshot: "包装", status: "active", sequenceNo: 2, targetQuantity: new Prisma.Decimal("100") },
    ],
    ...overrides,
  };
}

/** 内存版 Prisma 替身：覆盖通知/送检/QC/入库与库存事实。 */
function buildClient(state = {}) {
  const notices = state.notices ?? [];
  const submissions = state.submissions ?? [];
  const qcRecords = state.qcRecords ?? [];
  const inbounds = state.inbounds ?? [];
  const facts = state.facts ?? [];
  const operationReports = state.operationReports ?? [{ productionOrderOperationId: "op-2", completedQuantity: new Prisma.Decimal("60"), deletedAt: null }];
  const client = {
    notices, submissions, qcRecords, inbounds, facts,
    $queryRaw: async () => [],
    productionOrder: { findFirst: async () => state.order ?? order(), findMany: async () => [state.order ?? order()] },
    salesOrder: { findFirst: async () => ({ productName: "蓝色折叠伞" }) },
    operationDailyReport: { aggregate: async ({ where }) => ({ _sum: { completedQuantity: operationReports.filter((row) => row.productionOrderOperationId === where.productionOrderOperationId && !row.deletedAt).reduce((sum, row) => sum.plus(row.completedQuantity), new Prisma.Decimal(0)) } }) },
    inventoryFact: { findMany: async ({ where }) => facts.filter((fact) => !where?.inventoryCategory || fact.inventoryCategory === where.inventoryCategory || (where.inventoryCategory?.in && where.inventoryCategory.in.includes(fact.inventoryCategory))) },
    finishedGoodsInboundNotice: {
      findMany: async ({ where }) => notices.filter((row) => !row.deletedAt && (!where?.productionOrderId || row.productionOrderId === where.productionOrderId) && (!where?.status || (where.status.not ? row.status !== where.status.not : row.status === where.status)) && (!where?.id?.in || where.id.in.includes(row.id))),
      findFirst: async ({ where }) => notices.find((row) => (!where.id || row.id === where.id) && (!where.idempotencyKey || row.idempotencyKey === where.idempotencyKey) && !row.deletedAt) ?? null,
      aggregate: async ({ where }) => ({ _sum: { noticeQuantity: notices.filter((row) => row.productionOrderId === where.productionOrderId && !row.deletedAt && row.status !== "cancelled").reduce((sum, row) => sum.plus(row.noticeQuantity), new Prisma.Decimal(0)) } }),
      create: async ({ data }) => { const row = { id: `notice-${notices.length + 1}`, version: 1, status: "pending", deletedAt: null, ...data }; notices.push(row); return row; },
      update: async ({ where, data }) => { const row = notices.find((item) => item.id === where.id); Object.assign(row, data); return row; },
    },
    finishedGoodsInspectionSubmission: {
      findMany: async ({ where }) => submissions.filter((row) => !row.deletedAt && row.sourceType === where.sourceType && (!where.sourceId || row.sourceId === where.sourceId || where.sourceId?.in?.includes(row.sourceId)) && (where.status?.notIn ? !where.status.notIn.includes(row.status) : true)),
      findFirst: async ({ where }) => submissions.find((row) => row.id === where.id && !row.deletedAt) ?? null,
      aggregate: async ({ where }) => ({ _sum: { submittedQuantity: submissions.filter((row) => !row.deletedAt && row.sourceType === where.sourceType && row.sourceId === where.sourceId && (where.status?.notIn ? !where.status.notIn.includes(row.status) : true) && (!where.id?.not || row.id !== where.id.not)).reduce((sum, row) => sum.plus(row.submittedQuantity), new Prisma.Decimal(0)) } }),
      count: async ({ where }) => submissions.filter((row) => !row.deletedAt && row.sourceType === where.sourceType && row.sourceId === where.sourceId && (where.status?.notIn ? !where.status.notIn.includes(row.status) : true)).length,
      create: async ({ data }) => { const row = { id: `sub-${submissions.length + 1}`, version: 1, deletedAt: null, ...data }; submissions.push(row); return row; },
    },
    finishedGoodsQcRecord: {
      findMany: async ({ where }) => qcRecords.filter((row) => !row.deletedAt && (!where.status || row.status === where.status) && (where.submissionId?.in ? where.submissionId.in.includes(row.submissionId) : true)),
      findFirst: async ({ where }) => qcRecords.find((row) => row.id === where.id && !row.deletedAt && (!where.status || row.status === where.status)) ?? null,
    },
    finishedGoodsInbound: {
      findMany: async ({ where }) => inbounds.filter((row) => !row.deletedAt && where.submissionId.in.includes(row.submissionId) && where.status.in.includes(row.status)),
      aggregate: async ({ where }) => ({ _sum: { quantity: inbounds.filter((row) => !row.deletedAt && row.status === where.status && where.submissionId.in.includes(row.submissionId)).reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)) } }),
      groupBy: async ({ where }) => {
        const ids = where.qcRecordId.in;
        const grouped = new Map();
        for (const row of inbounds.filter((item) => !item.deletedAt && ids.includes(item.qcRecordId) && where.status.in.includes(item.status))) {
          grouped.set(row.qcRecordId, (grouped.get(row.qcRecordId) ?? new Prisma.Decimal(0)).plus(row.quantity));
        }
        return [...grouped.entries()].map(([qcRecordId, quantity]) => ({ qcRecordId, _sum: { quantity } }));
      },
    },
  };
  return client;
}

function buildService(state = {}) {
  const client = buildClient(state);
  const prisma = { ...client, $transaction: async (fn) => fn(client) };
  return { client, service: new FinishedGoodsInboundNoticesService(prisma, auditStub()) };
}

const noticeInput = (overrides = {}) => ({ production_order_id: "order-1", notice_quantity: "20", notice_date: "2026-09-10", batch_no: "B1", ...overrides });

test("包装工序累计报工量是可通知上限：超过则 422 并给出可用量", async () => {
  const { service } = buildService();
  await assert.rejects(
    () => service.create(noticeInput({ notice_quantity: "61" }), { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INBOUND_NOTICE_QUANTITY_EXCEEDED" && error.getResponse().details[0].available_quantity === "60",
  );
});

test("分批通知：已通知量会从未通知余额里扣减，边生产边通知", async () => {
  const { client, service } = buildService();
  const first = await service.create(noticeInput({ notice_quantity: "20" }), { id: "user-1" });
  assert.equal(first.status, "pending");
  assert.match(first.noticeNo, /^FGN-\d{8}-[0-9A-F]{8}$/);
  assert.equal(first.operationNameSnapshot, "包装");
  assert.equal(first.productNameSnapshot, "蓝色折叠伞");
  // 包装又报工 30 后可以继续通知 40（60 + 30 - 20 = 70 可通知）
  client.operationDailyReport.aggregate = async () => ({ _sum: { completedQuantity: new Prisma.Decimal("90") } });
  await service.create(noticeInput({ notice_quantity: "70" }), { id: "user-1" });
  await assert.rejects(() => service.create(noticeInput({ notice_quantity: "1" }), { id: "user-1" }), (error) => error.getResponse().code === "INBOUND_NOTICE_QUANTITY_EXCEEDED");
});

test("没有包装工序的生产单不能通知入库（提示先补建包装工序）", async () => {
  const { service } = buildService({ order: order({ operations: [{ id: "op-1", operationNameSnapshot: "缝伞", status: "active", sequenceNo: 1, targetQuantity: new Prisma.Decimal("100") }] }) });
  await assert.rejects(() => service.create(noticeInput(), { id: "user-1" }), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PACKAGING_OPERATION_REQUIRED");
});

test("外加工生产单与未开工生产单不能发成品入库通知", async () => {
  const outsourced = buildService({ order: order({ executionMode: "outsourced" }) });
  await assert.rejects(() => outsourced.service.create(noticeInput(), { id: "user-1" }), (error) => error.getResponse().code === "INBOUND_NOTICE_ORDER_MODE_UNSUPPORTED");
  const draft = buildService({ order: order({ status: "draft" }) });
  await assert.rejects(() => draft.service.create(noticeInput(), { id: "user-1" }), (error) => error.getResponse().code === "INBOUND_NOTICE_ORDER_NOT_READY");
});

test("幂等键重复提交返回同一条通知", async () => {
  const { client, service } = buildService();
  const first = await service.create(noticeInput({ idempotency_key: "key-1" }), { id: "user-1" });
  const again = await service.create(noticeInput({ idempotency_key: "key-1" }), { id: "user-1" });
  assert.equal(again.id, first.id);
  assert.equal(client.notices.length, 1);
});

test("通知进度：可送检量 = 通知量 − 未取消送检量；已入库按过账量统计", async () => {
  const notices = [{ id: "notice-1", noticeNo: "FGN-1", orderNo: "SO-1", productionOrderId: "order-1", productionOrderOperationId: "op-2", productionOrderNoSnapshot: "MO-1", operationNameSnapshot: "包装", productNameSnapshot: "伞", productSpecificationSnapshot: null, unitId: "unit-1", unitNameSnapshot: "个", noticeQuantity: new Prisma.Decimal("50"), noticeDate: new Date("2026-09-10T00:00:00.000Z"), batchNo: null, status: "partially_inbound", remark: null, version: 1, deletedAt: null }];
  const submissions = [{ id: "sub-1", sourceType: "finished_goods_inbound_notice", sourceId: "notice-1", submittedQuantity: new Prisma.Decimal("30"), status: "qc_completed", deletedAt: null }];
  const qcRecords = [{ id: "qc-1", submissionId: "sub-1", qualifiedQuantity: new Prisma.Decimal("25"), conditionalAcceptQuantity: new Prisma.Decimal("2"), rejectedQuantity: new Prisma.Decimal("3"), status: "active", deletedAt: null }];
  const inbounds = [{ id: "in-1", submissionId: "sub-1", quantity: new Prisma.Decimal("20"), status: "posted", deletedAt: null }, { id: "in-2", submissionId: "sub-1", quantity: new Prisma.Decimal("5"), status: "draft", deletedAt: null }];
  const { service } = buildService({ notices, submissions, qcRecords, inbounds });
  const row = await service.get("notice-1");
  assert.equal(row.submittedQuantity, "30");
  assert.equal(row.qcQualifiedQuantity, "27");
  assert.equal(row.qcRejectedQuantity, "3");
  assert.equal(row.inboundPostedQuantity, "20");
  assert.equal(row.inboundDraftQuantity, "5");
  assert.equal(row.availableSubmissionQuantity, "20");
  assert.equal(row.remainingForInbound, "30");
  assert.equal(row.noticeQuantity, "50");
});

test("取消通知：必须填原因；已有送检单时不允许取消", async () => {
  // 每个 service 用独立行对象，避免上一个用例的 cancel 改写共享状态后影响下一个断言。
  const noticeRow = () => ({ id: "notice-1", noticeNo: "FGN-1", orderNo: "SO-1", productionOrderId: "order-1", noticeQuantity: new Prisma.Decimal("50"), status: "partially_inbound", remark: null, deletedAt: null });
  const noSubs = buildService({ notices: [noticeRow()] });
  await assert.rejects(() => noSubs.service.cancel("notice-1", "  ", { id: "user-1" }), (error) => error.getResponse().code === "CANCELLATION_REASON_REQUIRED");
  const cancelled = await noSubs.service.cancel("notice-1", "重复通知", { id: "user-1" });
  assert.equal(cancelled.status, "cancelled");

  const withSubs = buildService({ notices: [noticeRow()], submissions: [{ id: "sub-1", sourceType: "finished_goods_inbound_notice", sourceId: "notice-1", submittedQuantity: new Prisma.Decimal("10"), status: "draft", deletedAt: null }] });
  await assert.rejects(() => withSubs.service.cancel("notice-1", "想取消", { id: "user-1" }), (error) => error.getResponse().code === "INBOUND_NOTICE_HAS_SUBMISSIONS");
});

test("生产单成品存量汇总：包装报工、已通知、可通知、送检/QC/入库与成品/次品库存", async () => {
  const notices = [{ id: "notice-1", noticeNo: "FGN-1", orderNo: "SO-1", productionOrderId: "order-1", productionOrderOperationId: "op-2", productionOrderNoSnapshot: "MO-1", operationNameSnapshot: "包装", productNameSnapshot: "伞", productSpecificationSnapshot: "24骨", unitId: "unit-1", unitNameSnapshot: "个", noticeQuantity: new Prisma.Decimal("20"), noticeDate: new Date("2026-09-10T00:00:00.000Z"), batchNo: "B1", status: "partially_inbound", remark: null, version: 1, deletedAt: null }];
  const submissions = [{ id: "sub-1", sourceType: "finished_goods_inbound_notice", sourceId: "notice-1", submittedQuantity: new Prisma.Decimal("20"), status: "qc_completed", deletedAt: null }];
  const qcRecords = [{ id: "qc-1", submissionId: "sub-1", qualifiedQuantity: new Prisma.Decimal("18"), conditionalAcceptQuantity: new Prisma.Decimal("0"), rejectedQuantity: new Prisma.Decimal("2"), status: "active", deletedAt: null }];
  const inbounds = [{ id: "in-1", submissionId: "sub-1", quantity: new Prisma.Decimal("18"), status: "posted", deletedAt: null }];
  const facts = [
    { inventoryCategory: "finished_goods", quantityDelta: new Prisma.Decimal("18"), sourceType: "finished_goods_inbound" },
    { inventoryCategory: "defective_goods", quantityDelta: new Prisma.Decimal("2"), sourceType: "finished_goods_defective" },
    { inventoryCategory: "finished_goods", quantityDelta: new Prisma.Decimal("-5"), sourceType: "finished_goods_outbound" },
  ];
  const { service } = buildService({ notices, submissions, qcRecords, inbounds, facts });
  const summary = await service.orderSummary("order-1");
  assert.equal(summary.packaging_operation.name, "包装");
  assert.equal(summary.packaging_reported_quantity, "60");
  assert.equal(summary.notified_quantity, "20");
  assert.equal(summary.available_notice_quantity, "40");
  assert.equal(summary.submitted_quantity, "20");
  assert.equal(summary.qc_qualified_quantity, "18");
  assert.equal(summary.inbound_posted_quantity, "18");
  assert.equal(summary.finished_goods_stock, "13");
  assert.equal(summary.defective_goods_stock, "2");
  assert.equal(summary.outbound_quantity, "5");
  assert.equal(summary.notices.length, 1);
});

// 通知状态推导：pending → 有送检即 partially_inbound；通知量全部送检且无在途入库即 completed。
test("通知状态随送检与在途入库推导，取消态不被覆盖", async () => {
  const notices = [{ id: "notice-1", noticeNo: "FGN-1", orderNo: "SO-1", productionOrderId: "order-1", noticeQuantity: new Prisma.Decimal("20"), status: "pending", deletedAt: null }];
  const submissions = [];
  const inbounds = [];
  const client = buildClient({ notices, submissions, inbounds });
  const tx = { ...client };
  assert.equal(await syncFinishedGoodsInboundNoticeStatus(tx, "notice-1", { id: "user-1" }), "pending");
  submissions.push({ id: "sub-1", sourceType: "finished_goods_inbound_notice", sourceId: "notice-1", submittedQuantity: new Prisma.Decimal("8"), status: "submitted", deletedAt: null });
  assert.equal(await syncFinishedGoodsInboundNoticeStatus(tx, "notice-1", { id: "user-1" }), "partially_inbound");
  submissions[0].submittedQuantity = new Prisma.Decimal("20");
  assert.equal(await syncFinishedGoodsInboundNoticeStatus(tx, "notice-1", { id: "user-1" }), "completed");
  inbounds.push({ id: "in-1", submissionId: "sub-1", quantity: new Prisma.Decimal("5"), status: "draft", deletedAt: null });
  assert.equal(await syncFinishedGoodsInboundNoticeStatus(tx, "notice-1", { id: "user-1" }), "partially_inbound", "有在途草稿入库时不能算完成");
  const cancelled = buildClient({ notices: [{ ...notices[0], status: "cancelled" }] });
  assert.equal(await syncFinishedGoodsInboundNoticeStatus({ ...cancelled }, "notice-1", { id: "user-1" }), null, "取消态不参与推导");
});

// QC 侧：厂内来源改为通知；旧的整单完工来源不再接受新建。
function buildQc(state = {}) {
  const notices = state.notices ?? [{ id: "notice-1", noticeNo: "FGN-1", noticeQuantity: new Prisma.Decimal("20"), unitId: "unit-1", unitNameSnapshot: "个", productNameSnapshot: "伞", operationNameSnapshot: "包装", status: "pending", productionOrderId: "order-1", productSpecificationSnapshot: "24骨", batchNo: "B1", noticeDate: new Date("2026-09-10T00:00:00.000Z"), deletedAt: null }];
  const submissions = state.submissions ?? [];
  const client = buildClient({ ...state, notices, submissions });
  client.finishedGoodsInspectionSubmission.create = async ({ data }) => { const row = { id: `sub-${submissions.length + 1}`, version: 1, deletedAt: null, ...data }; submissions.push(row); return row; };
  const prisma = { ...client, $transaction: async (fn) => fn(client) };
  return { client, submissions, service: new FinishedGoodsQcService(prisma, auditStub(), { recalculateInTransaction: async () => undefined }) };
}

test("厂内送检来源改为成品入库通知：来源列表按通知（含批次与可送检量）返回", async () => {
  const { service } = buildQc();
  const sources = await service.listSources();
  const inHouse = sources.filter((row) => row.source_type === "finished_goods_inbound_notice");
  assert.equal(inHouse.length, 1);
  assert.equal(inHouse[0].source_id, "notice-1");
  assert.equal(inHouse[0].notice_no, "FGN-1");
  assert.equal(inHouse[0].packaging_operation_name, "包装");
  assert.equal(inHouse[0].available_quantity, "20");
  assert.equal(sources.some((row) => row.source_type === "in_house_completion"), false, "旧的整单完工来源不应再出现在来源列表里");
});

test("旧的 in_house_completion 来源不再接受新建送检单", async () => {
  const { service } = buildQc();
  await assert.rejects(
    () => service.createSubmission({ production_order_id: "order-1", source_type: "in_house_completion", source_id: "order-1", submitted_quantity: "5", submission_date: "2026-09-10" }, { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "FINISHED_GOODS_QC_SOURCE_TYPE_RETIRED",
  );
});

test("质检合格待入库的“可入库数量”必须是净值（扣掉草稿+已过账入库）", async () => {
  const qcRecords = [{ id: "qc-1", submissionId: "sub-1", qualifiedQuantity: new Prisma.Decimal("30"), conditionalAcceptQuantity: new Prisma.Decimal("0"), rejectedQuantity: new Prisma.Decimal("0"), status: "active", deletedAt: null, submission: { unitId: "unit-1", unitNameSnapshot: "个", unit: { name: "个" } } }];
  const inbounds = [
    { id: "in-1", submissionId: "sub-1", qcRecordId: "qc-1", quantity: new Prisma.Decimal("20"), status: "posted", deletedAt: null },
    { id: "in-2", submissionId: "sub-1", qcRecordId: "qc-1", quantity: new Prisma.Decimal("5"), status: "draft", deletedAt: null },
  ];
  const { service } = buildQc({ qcRecords, inbounds, submissions: [{ id: "sub-1", sourceType: "finished_goods_inbound_notice", sourceId: "notice-1", submittedQuantity: new Prisma.Decimal("30"), status: "qc_completed", deletedAt: null }], notices: [] });
  const sources = await service.availableInboundSources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].available_for_inbound_quantity, "5", "30 合格 − 20 已过账 − 5 在途 = 5");
});

test("qc-records 列表同样给出净值可入库量", async () => {
  const qcRecords = [{ id: "qc-1", submissionId: "sub-1", qcNo: "FQC-1", orderNo: "SO-1", productionOrderId: "order-1", sourceType: "finished_goods_inbound_notice", sourceId: "notice-1", qualifiedQuantity: new Prisma.Decimal("10"), conditionalAcceptQuantity: new Prisma.Decimal("5"), rejectedQuantity: new Prisma.Decimal("0"), status: "active", deletedAt: null }];
  const inbounds = [{ id: "in-1", submissionId: "sub-1", qcRecordId: "qc-1", quantity: new Prisma.Decimal("12"), status: "posted", deletedAt: null }];
  const { service } = buildQc({ qcRecords, inbounds, notices: [], submissions: [] });
  const rows = await service.listQcRecords();
  assert.equal(rows[0].availableForInboundQuantity, "3", "10 + 5 条件合格 − 12 已过账 = 3");
});

// 入库过账要把来源通知推进到「已完成」：这是「分批入库」能被看见的关键一环。
test("成品入库过账后来源通知状态推进到已完成（分批入库闭环）", async () => {
  const { FinishedGoodsInventoryService } = require("../../dist/modules/warehouse/finished-goods-inventory.service.js");
  const notices = [{ id: "notice-1", noticeNo: "FGN-1", orderNo: "SO-1", productionOrderId: "order-1", noticeQuantity: new Prisma.Decimal("20"), status: "partially_inbound", deletedAt: null }];
  const submissions = [{ id: "sub-1", sourceType: "finished_goods_inbound_notice", sourceId: "notice-1", submittedQuantity: new Prisma.Decimal("20"), status: "qc_completed", deletedAt: null }];
  const qcRecords = [{ id: "qc-1", submissionId: "sub-1", submission: submissions[0], qualifiedQuantity: new Prisma.Decimal("20"), conditionalAcceptQuantity: new Prisma.Decimal("0"), rejectedQuantity: new Prisma.Decimal("0"), status: "active", deletedAt: null }];
  const inbounds = [{ id: "in-1", qcRecordId: "qc-1", submissionId: "sub-1", orderNo: "SO-1", productionOrderId: "order-1", unitId: "unit-1", quantity: new Prisma.Decimal("20"), status: "draft", qcRecord: { submission: submissions[0] }, deletedAt: null }];
  const facts = [];
  const client = buildClient({ notices, submissions, qcRecords, inbounds, facts });
  client.finishedGoodsInbound.findFirst = async ({ where }) => inbounds.find((row) => row.id === where.id && !row.deletedAt) ?? null;
  client.finishedGoodsInbound.update = async ({ where, data }) => { const row = inbounds.find((item) => item.id === where.id); Object.assign(row, data); return row; };
  client.inventoryFact.findFirst = async () => null;
  client.inventoryFact.create = async ({ data }) => { facts.push(data); return data; };
  const prisma = { ...client, $transaction: async (fn) => fn(client) };
  const inventory = { finishedGoodsBalance: async () => new Prisma.Decimal(0) };
  const service = new FinishedGoodsInventoryService(prisma, auditStub(), inventory);
  await service.postInbound("in-1", { id: "user-1" });
  assert.equal(inbounds[0].status, "posted");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].quantityDelta.toString(), "20");
  assert.equal(notices[0].status, "completed", "通知量已全部送检且无在途入库 → 通知完成");
});

test("按通知送检：不得超过通知可送检量，成功后通知变为进行中", async () => {
  const { client, submissions, service } = buildQc();
  await assert.rejects(
    () => service.createSubmission({ production_order_id: "order-1", source_type: "finished_goods_inbound_notice", source_id: "notice-1", submitted_quantity: "21", submission_date: "2026-09-10" }, { id: "user-1" }),
    (error) => error.getResponse().code === "FINISHED_GOODS_SUBMISSION_QUANTITY_EXCEEDED",
  );
  const created = await service.createSubmission({ production_order_id: "order-1", source_type: "finished_goods_inbound_notice", source_id: "notice-1", submitted_quantity: "12", submission_date: "2026-09-10" }, { id: "user-1" });
  assert.equal(created.sourceType, "finished_goods_inbound_notice");
  assert.equal(submissions.length, 1);
  assert.equal(client.notices[0].status, "partially_inbound");
  // 再次送检最多 8（20 − 12）
  await assert.rejects(
    () => service.createSubmission({ production_order_id: "order-1", source_type: "finished_goods_inbound_notice", source_id: "notice-1", submitted_quantity: "9", submission_date: "2026-09-10" }, { id: "user-1" }),
    (error) => error.getResponse().code === "FINISHED_GOODS_SUBMISSION_QUANTITY_EXCEEDED" && error.getResponse().details[0].available_quantity === "8",
  );
});
