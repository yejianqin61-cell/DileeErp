const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { FinishedGoodsInboundNoticesService } = require("../../dist/modules/production/finished-goods-inbound-notices.service.js");
const { FinishedGoodsQcService } = require("../../dist/modules/production/finished-goods-qc.service.js");
const { FinishedGoodsInventoryService } = require("../../dist/modules/warehouse/finished-goods-inventory.service.js");

// 全链路闭环（无数据库：三个已编译服务共享同一份内存存储）：
// 员工日报报工（UI 唯一入口）→ 生产按包装工序累计量分批发成品入库通知 → 仓库按通知送检 → 提交 → 录入 QC
// → 分批登记成品入库 → 过账（写库存事实）→ 不合格登记次品并过账 → 通知/存量口径全部自洽。
const auditStub = () => ({ create: () => ({}), update: () => ({}), softDelete: () => ({}), record: async () => undefined });

/** 真实 Prisma 的 status 过滤既可能是字符串也可能是 { in: [...] }，替身两种都要支持。 */
function statusFilter(where) {
  if (where?.status?.in) return where.status.in;
  if (typeof where?.status === "string") return [where.status];
  return null;
}
function matchesSubmission(where, row) {
  if (!where?.submissionId) return true;
  return where.submissionId.in ? where.submissionId.in.includes(row.submissionId) : row.submissionId === where.submissionId;
}

function store() {
  const order = {
    id: "order-1", orderNo: "SO-1", productionOrderNo: "MO-1", executionMode: "in_house", status: "in_progress",
    plannedQuantity: new Prisma.Decimal("100"), unitId: "unit-1", unit: { id: "unit-1", name: "个" }, productSpecification: "24骨",
    operations: [
      { id: "op-sew", operationNameSnapshot: "缝制", status: "active", sequenceNo: 1, targetQuantity: new Prisma.Decimal("100") },
      { id: "op-pack", operationNameSnapshot: "包装", status: "active", sequenceNo: 2, targetQuantity: new Prisma.Decimal("100") },
    ],
  };
  return {
    order,
    employeeReports: [{ productionOrderOperationId: "op-pack", quantity: new Prisma.Decimal("60"), deletedAt: null }],
    operationReports: [],
    notices: [],
    submissions: [],
    qcRecords: [],
    inbounds: [],
    defectives: [],
    facts: [],
    locks: [],
  };
}

function prismaFor(state) {
  const client = {
    $queryRaw: async (...args) => { state.locks.push(Array.isArray(args[0]) ? args[0].join("?") : String(args[0])); return []; },
    productionOrder: { findFirst: async () => state.order, findMany: async () => [state.order] },
    salesOrder: { findFirst: async () => ({ productName: "蓝色折叠伞" }) },
    operationDailyReport: { aggregate: async ({ where }) => ({ _sum: { completedQuantity: state.operationReports.filter((r) => r.productionOrderOperationId === where.productionOrderOperationId && !r.deletedAt).reduce((s, r) => s.plus(r.completedQuantity), new Prisma.Decimal(0)) } }) },
    employeeDailyReport: { aggregate: async ({ where }) => ({ _sum: { quantity: state.employeeReports.filter((r) => r.productionOrderOperationId === where.productionOrderOperationId && !r.deletedAt).reduce((s, r) => s.plus(r.quantity), new Prisma.Decimal(0)) } }) },
    finishedGoodsInboundNotice: {
      findMany: async ({ where }) => state.notices.filter((r) => !r.deletedAt && (!where?.productionOrderId || r.productionOrderId === where.productionOrderId) && (!where?.status || (where.status.not ? r.status !== where.status.not : r.status === where.status))),
      findFirst: async ({ where }) => state.notices.find((r) => (!where.id || r.id === where.id) && (!where.idempotencyKey || r.idempotencyKey === where.idempotencyKey) && !r.deletedAt) ?? null,
      aggregate: async ({ where }) => ({ _sum: { noticeQuantity: state.notices.filter((r) => r.productionOrderId === where.productionOrderId && !r.deletedAt && r.status !== "cancelled").reduce((s, r) => s.plus(r.noticeQuantity), new Prisma.Decimal(0)) } }),
      create: async ({ data }) => { const row = { id: `notice-${state.notices.length + 1}`, version: 1, status: "pending", deletedAt: null, ...data }; state.notices.push(row); return row; },
      update: async ({ where, data }) => { const row = state.notices.find((r) => r.id === where.id); Object.assign(row, data); return row; },
    },
    finishedGoodsInspectionSubmission: {
      findMany: async ({ where }) => state.submissions.filter((r) => !r.deletedAt && r.sourceType === where.sourceType && (!where.sourceId || (where.sourceId.in ? where.sourceId.in.includes(r.sourceId) : r.sourceId === where.sourceId)) && (where.status?.notIn ? !where.status.notIn.includes(r.status) : true)),
      findFirst: async ({ where }) => state.submissions.find((r) => r.id === where.id && !r.deletedAt) ?? null,
      aggregate: async ({ where }) => ({ _sum: { submittedQuantity: state.submissions.filter((r) => !r.deletedAt && r.sourceType === where.sourceType && r.sourceId === where.sourceId && (where.status?.notIn ? !where.status.notIn.includes(r.status) : true) && (!where.id?.not || r.id !== where.id.not)).reduce((s, r) => s.plus(r.submittedQuantity), new Prisma.Decimal(0)), inspectedQuantity: state.qcRecords.filter((q) => q.submissionId === where.submissionId && q.status === "active" && !q.deletedAt).reduce((s, q) => s.plus(q.inspectedQuantity), new Prisma.Decimal(0)) } }),
      count: async ({ where }) => state.submissions.filter((r) => !r.deletedAt && r.sourceType === where.sourceType && r.sourceId === where.sourceId && (where.status?.notIn ? !where.status.notIn.includes(r.status) : true)).length,
      // 真实库的 status 默认值是 draft（草稿送检），替身必须一致，否则状态推导会被误判成“已提交”。
      create: async ({ data }) => { const row = { id: `sub-${state.submissions.length + 1}`, version: 1, status: "draft", deletedAt: null, ...data }; state.submissions.push(row); return row; },
      update: async ({ where, data }) => { const row = state.submissions.find((r) => r.id === where.id); Object.assign(row, data); return row; },
    },
    finishedGoodsQcRecord: {
      findMany: async ({ where }) => state.qcRecords.filter((r) => !r.deletedAt && (!where.status || r.status === where.status) && (where.submissionId?.in ? where.submissionId.in.includes(r.submissionId) : true)),
      findFirst: async ({ where }) => state.qcRecords.find((r) => r.id === where.id && !r.deletedAt && (!where.status || r.status === where.status)) ?? null,
      aggregate: async ({ where }) => ({ _sum: { inspectedQuantity: state.qcRecords.filter((r) => !r.deletedAt && r.submissionId === where.submissionId && (!where.status || r.status === where.status) && (!where.id?.not || r.id !== where.id.not)).reduce((s, r) => s.plus(r.inspectedQuantity), new Prisma.Decimal(0)) } }),
      // 真实库是 Decimal 列（Prisma 负责转换），替身要把服务层传入的字符串转成 Decimal。
      create: async ({ data }) => { const submission = state.submissions.find((row) => row.id === data.submissionId); const row = { id: `qc-${state.qcRecords.length + 1}`, version: 1, status: "active", deletedAt: null, ...data, inspectedQuantity: new Prisma.Decimal(data.inspectedQuantity), qualifiedQuantity: new Prisma.Decimal(data.qualifiedQuantity), conditionalAcceptQuantity: new Prisma.Decimal(data.conditionalAcceptQuantity), rejectedQuantity: new Prisma.Decimal(data.rejectedQuantity), submission: submission ? { ...submission, unit: { name: "个" } } : undefined }; state.qcRecords.push(row); return row; },
    },
    finishedGoodsInbound: {
      findMany: async ({ where }) => state.inbounds.filter((r) => !r.deletedAt && (!where.submissionId || where.submissionId.in.includes(r.submissionId)) && (!where.status || (where.status.in ? where.status.in.includes(r.status) : r.status === where.status))),
      // 真实查询带 include: { qcRecord: { include: { submission: true } } }（过账时要据此刷新来源通知）。
      findFirst: async ({ where }) => {
        const row = state.inbounds.find((r) => r.id === where.id && !r.deletedAt);
        if (!row) return null;
        const qc = state.qcRecords.find((q) => q.id === row.qcRecordId);
        const submission = qc ? state.submissions.find((s) => s.id === qc.submissionId) : undefined;
        return { ...row, qcRecord: qc ? { ...qc, submission } : undefined };
      },
      aggregate: async ({ where }) => ({ _sum: { quantity: state.inbounds.filter((r) => !r.deletedAt && (!where.qcRecordId || r.qcRecordId === where.qcRecordId) && matchesSubmission(where, r) && (!where.id?.not || r.id !== where.id.not) && (!statusFilter(where) || statusFilter(where).includes(r.status))).reduce((s, r) => s.plus(r.quantity), new Prisma.Decimal(0)) } }),
      groupBy: async ({ where }) => {
        const grouped = new Map();
        for (const row of state.inbounds.filter((r) => !r.deletedAt && where.qcRecordId.in.includes(r.qcRecordId) && where.status.in.includes(r.status))) grouped.set(row.qcRecordId, (grouped.get(row.qcRecordId) ?? new Prisma.Decimal(0)).plus(row.quantity));
        return [...grouped.entries()].map(([qcRecordId, quantity]) => ({ qcRecordId, _sum: { quantity } }));
      },
      create: async ({ data }) => { const row = { id: `in-${state.inbounds.length + 1}`, status: "draft", deletedAt: null, ...data }; state.inbounds.push(row); return row; },
      update: async ({ where, data }) => { const row = state.inbounds.find((r) => r.id === where.id); Object.assign(row, data); return row; },
    },
    finishedGoodsDefective: {
      findMany: async ({ where }) => state.defectives.filter((r) => !r.deletedAt && (!where.submissionId || where.submissionId.in.includes(r.submissionId)) && (!where.status || (where.status.in ? where.status.in.includes(r.status) : r.status === where.status))),
      findFirst: async ({ where }) => state.defectives.find((r) => r.id === where.id && !r.deletedAt) ?? null,
      aggregate: async ({ where }) => ({ _sum: { quantity: state.defectives.filter((r) => !r.deletedAt && r.qcRecordId === where.qcRecordId && (!where.id?.not || r.id !== where.id.not) && where.status.in.includes(r.status)).reduce((s, r) => s.plus(r.quantity), new Prisma.Decimal(0)) } }),
      groupBy: async ({ where }) => {
        const grouped = new Map();
        for (const row of state.defectives.filter((r) => !r.deletedAt && where.qcRecordId.in.includes(r.qcRecordId) && where.status.in.includes(r.status))) grouped.set(row.qcRecordId, (grouped.get(row.qcRecordId) ?? new Prisma.Decimal(0)).plus(row.quantity));
        return [...grouped.entries()].map(([qcRecordId, quantity]) => ({ qcRecordId, _sum: { quantity } }));
      },
      create: async ({ data }) => { const row = { id: `def-${state.defectives.length + 1}`, status: "draft", deletedAt: null, ...data }; state.defectives.push(row); return row; },
      update: async ({ where, data }) => { const row = state.defectives.find((r) => r.id === where.id); Object.assign(row, data); return row; },
    },
    inventoryFact: {
      findFirst: async () => null,
      create: async ({ data }) => { state.facts.push(data); return data; },
      findMany: async ({ where }) => state.facts.filter((f) => !where?.productionOrderId || f.productionOrderId === where.productionOrderId),
    },
  };
  return client;
}

function services(state) {
  const client = prismaFor(state);
  const prisma = { ...client, $transaction: async (fn) => fn(client) };
  const audit = auditStub();
  const inventory = { finishedGoodsBalance: async () => new Prisma.Decimal(0) };
  return {
    notices: new FinishedGoodsInboundNoticesService(prisma, audit),
    qc: new FinishedGoodsQcService(prisma, audit, {}),
    stock: new FinishedGoodsInventoryService(prisma, audit, inventory),
  };
}

test("全链路：员工日报报工 → 分批通知 → 送检/QC → 分批入库过账 → 次品过账 → 存量与状态自洽", async () => {
  const state = store();
  const { notices, qc, stock } = services(state);
  const user = { id: "user-1" };

  // 1) 可通知量来自员工日报（UI 唯一入口）：60
  const summaryBefore = await notices.orderSummary("order-1");
  assert.equal(summaryBefore.packaging_reported_quantity, "60");
  assert.equal(summaryBefore.available_notice_quantity, "60");

  // 2) 分批通知：先 20，再 40；第三次超量被拒
  const first = await notices.create({ production_order_id: "order-1", notice_quantity: "20", notice_date: "2026-09-10", batch_no: "B1" }, user);
  const second = await notices.create({ production_order_id: "order-1", notice_quantity: "40", notice_date: "2026-09-11", batch_no: "B2" }, user);
  assert.notEqual(first.id, second.id);
  await assert.rejects(() => notices.create({ production_order_id: "order-1", notice_quantity: "1", notice_date: "2026-09-11" }, user), (error) => error.getResponse().code === "INBOUND_NOTICE_QUANTITY_EXCEEDED");

  // 3) 仓库按通知送检（第一条通知 20）
  const sources = await qc.listSources();
  assert.equal(sources.length, 2, "两条通知各自是一个送检来源");
  const source = sources.find((row) => row.notice_no === first.noticeNo);
  assert.equal(source.available_quantity, "20");
  const submission = await qc.createSubmission({ production_order_id: "order-1", source_type: "finished_goods_inbound_notice", source_id: first.id, submitted_quantity: "20", submission_date: "2026-09-11" }, user);
  assert.equal(state.notices.find((row) => row.id === first.id).status, "partially_inbound", "草稿送检只占额度，通知不算完成");
  await qc.submit(submission.id, user);

  // 4) 录入 QC：18 合格 + 2 不合格
  await qc.createQcRecord({ submission_id: submission.id, inspection_date: "2026-09-11", inspected_quantity: "20", qualified_quantity: "18", conditional_accept_quantity: "0", rejected_quantity: "2", rejection_reason: "伞骨划伤" }, user);
  assert.equal(state.submissions[0].status, "qc_completed");
  assert.equal(state.notices.find((row) => row.id === first.id).status, "completed", "全部送检且无在途入库 → 已完成");

  // 5) 质检合格待入库：净值 18；可登记次品 2
  const available = await qc.availableInboundSources();
  const qcRow = available.find((row) => row.order_no === "SO-1");
  assert.equal(qcRow.available_for_inbound_quantity, "18");
  assert.equal(qcRow.available_for_defective_quantity, "2");

  // 6) 分批登记入库：先 10（草稿），过账；再 8（草稿），过账
  const inbound1 = await stock.createInbound({ qc_record_id: qcRow.qc_id, quantity: "10" }, user);
  assert.equal(state.notices.find((row) => row.id === first.id).status, "partially_inbound", "有在途草稿入库时不能显示已完成");
  await stock.postInbound(inbound1.id, user);
  const inbound2 = await stock.createInbound({ qc_record_id: qcRow.qc_id, quantity: "8" }, user);
  await stock.postInbound(inbound2.id, user);
  await assert.rejects(() => stock.createInbound({ qc_record_id: qcRow.qc_id, quantity: "1" }, user), (error) => error.getResponse().code === "FINISHED_GOODS_INBOUND_QUANTITY_EXCEEDED");

  // 7) 不合格登记次品并过账
  const defective = await stock.createDefective({ qc_record_id: qcRow.qc_id, quantity: "2" }, user);
  await stock.postDefective(defective.id, user);

  // 8) 库存事实：+18 成品、+2 次品
  const finishedFacts = state.facts.filter((fact) => fact.inventoryCategory === "finished_goods");
  const defectiveFacts = state.facts.filter((fact) => fact.inventoryCategory === "defective_goods");
  assert.equal(finishedFacts.length, 2, "两次分批入库各自写一条库存事实");
  assert.equal(finishedFacts.reduce((sum, fact) => sum + Number(fact.quantityDelta), 0), 18);
  assert.equal(defectiveFacts.reduce((sum, fact) => sum + Number(fact.quantityDelta), 0), 2);

  // 9) 收尾：生产单成品汇总与通知进度自洽
  const summary = await notices.orderSummary("order-1");
  assert.equal(summary.notified_quantity, "60");
  assert.equal(summary.submitted_quantity, "20");
  assert.equal(summary.qc_qualified_quantity, "18");
  assert.equal(summary.inbound_posted_quantity, "18");
  assert.equal(summary.finished_goods_stock, "18", "成品存量 = 已过账入库累计");
  assert.equal(summary.defective_goods_stock, "2");
  assert.equal(summary.available_notice_quantity, "0", "通知量已用完（20+40=60）");
  const completed = summary.notices.find((row) => row.id === first.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.availableSubmissionQuantity, "0", "通知量已全部送检");
  assert.equal(completed.inboundDraftQuantity, "0", "没有在途入库");
  assert.equal(completed.inboundPostedQuantity, "18");
  // 通知量 20、实际入库 18：差额 2 是 QC 不合格（已登记次品），不会再入库——这是「剩余未入库量」，不是待办。
  assert.equal(completed.remainingForInbound, "2");
  const pending = summary.notices.find((row) => row.id === second.id);
  assert.equal(pending.status, "pending");
  assert.equal(pending.remainingForInbound, "40");
});

// 回归：过账时若不排除自己，「可用量 = 合格量 − (草稿+已过账，含自己)」会让任何入库单都过不了账。
test("多批次入库：每批都能过账，但累计不得超过 QC 合格量", async () => {
  const state = store();
  const { stock } = services(state);
  const user = { id: "user-1" };
  state.submissions.push({ id: "sub-1", sourceType: "finished_goods_inbound_notice", sourceId: "notice-x", submittedQuantity: new Prisma.Decimal("20"), status: "qc_completed", deletedAt: null });
  state.qcRecords.push({ id: "qc-1", submissionId: "sub-1", qualifiedQuantity: new Prisma.Decimal("20"), conditionalAcceptQuantity: new Prisma.Decimal("0"), rejectedQuantity: new Prisma.Decimal("0"), status: "active", deletedAt: null, submission: { id: "sub-1", status: "qc_completed", unitId: "unit-1", unitNameSnapshot: "个", unit: { name: "个" } } });

  const first = await stock.createInbound({ qc_record_id: "qc-1", quantity: "12" }, user);
  await stock.postInbound(first.id, user);
  assert.equal(state.facts.length, 1, "第一批过账后写入库存事实");

  const second = await stock.createInbound({ qc_record_id: "qc-1", quantity: "8" }, user);
  await stock.postInbound(second.id, user);
  assert.equal(state.facts.length, 2, "第二批也能过账（过账校验必须排除自己）");
  assert.equal(state.facts.reduce((sum, fact) => sum + Number(fact.quantityDelta), 0), 20);

  // 已过账 20 = 合格量 20 → 再登记/过账都被拒
  await assert.rejects(() => stock.createInbound({ qc_record_id: "qc-1", quantity: "1" }, user), (error) => error.getResponse().code === "FINISHED_GOODS_INBOUND_QUANTITY_EXCEEDED");
  const third = await stock.createInbound({ qc_record_id: "qc-1", quantity: "0.5" }, user).catch(() => null);
  assert.equal(third, null);
});
