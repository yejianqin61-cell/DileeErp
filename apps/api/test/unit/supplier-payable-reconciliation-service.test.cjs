const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { SupplierPayableReconciliationService } = require("../../dist/modules/finance/supplier-payable-reconciliation.service.js");

/** CashFlowService 替身：`requireSubject` 校验会计科目，`recordConfirmation` 把确认金额写成收支流水。 */
const cashFlowStub = (extra = {}) => ({ requireSubject: async () => null, recordConfirmation: async () => null, ...extra });

test("supplier payable reconciliation resolution locks and rechecks status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "recon-1", status: "resolved" };
  const prisma = {
    supplierPayableReconciliation: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayableReconciliation: prisma.supplierPayableReconciliation,
    }),
  };
  const service = new SupplierPayableReconciliationService(prisma, { update: () => ({}), record: async () => {} }, cashFlowStub());
  await assert.rejects(() => service.resolve("recon-1", "已核实", { id: "user-1" }), (error) => error.getResponse().code === "RECONCILIATION_NOT_RESOLVABLE");
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

// ------------------------------------------------------------------ 对账完成 → 批量确认应付

function confirmHarness(reconciliation, drafts) {
  const locks = [];
  const updates = [];
  const audits = [];
  const cashFlowCalls = [];
  const reconciliationUpdates = [];
  let lastQuery;
  const prisma = {
    supplierPayableReconciliation: {
      findFirst: async () => reconciliation,
      update: async ({ where, data }) => { reconciliationUpdates.push({ id: where.id, ...data }); return { ...reconciliation, ...data }; },
    },
    supplierPayableEntry: {
      findMany: async (args) => { lastQuery = args; return drafts; },
      update: async ({ where, data }) => { updates.push({ id: where.id, status: data.status }); return { ...where, status: data.status }; },
    },
    bank: { findFirst: async ({ where }) => (where.id === "bank-dead" ? null : { id: where.id, bankName: "农业银行", accountNumber: "5706" }) },
  };
  prisma.$transaction = async (fn) => fn({
    $queryRaw: async (strings) => { locks.push(Array.isArray(strings) ? strings.join("") : String(strings)); return []; },
    supplierPayableReconciliation: prisma.supplierPayableReconciliation,
    supplierPayableEntry: prisma.supplierPayableEntry,
  });
  const audit = { create: () => ({}), update: () => ({ updatedBy: "user-1" }), record: async (...args) => audits.push(args), recordWithOrderNo: async (...args) => audits.push(args) };
  const cashFlow = cashFlowStub({ recordConfirmation: async (input) => { cashFlowCalls.push(input); return { id: "cf-1", created: true, amount: input.amount }; } });
  // 2026-09-24 起确认应付 = 挂账（逐条一张凭证）：cashFlowCalls 变成反向护栏。
  const accrualCalls = [];
  const vouchers = {
    createAccrual: async (input) => { accrualCalls.push(input); return { id: `voucher-${accrualCalls.length}`, replayed: false }; },
    accruedSourceIds: async () => new Set(),
  };
  return { service: new SupplierPayableReconciliationService(prisma, audit, cashFlow, undefined, vouchers), locks, updates, audits, cashFlowCalls, accrualCalls, reconciliationUpdates, query: () => lastQuery };
}

const draftEntry = (id, amount, sourceStatus, sourceType = "raw_material_inbound") => ({ id, payableNo: `AP-${id}`, orderNo: "SO-1", amount: new Prisma.Decimal(amount), currency: "CNY", sourceType, payableSource: { status: sourceStatus ?? "pending_finance" }, outsourcePayableSource: null });

const scopeRow = (status, extra = {}) => ({ id: "recon-1", status, reconciliationNo: "APREC-1", supplierId: "supplier-1", supplier: { id: "supplier-1", name: "晋江大田" }, orderNo: null, purchaseOrderId: null, currency: "CNY", periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30"), bankId: "bank-1", subjectId: null, ...extra });

test("应付对账还有未处理差异时不允许批量确认应付", async () => {
  const { service, updates } = confirmHarness(scopeRow("difference"), [draftEntry("e1", "10")]);
  await assert.rejects(
    () => service.confirmPayables("recon-1", { id: "user-1" }),
    (error) => error.getResponse().code === "RECONCILIATION_NOT_COMPLETED",
  );
  assert.deepEqual(updates, [], "被拒绝时不得写入任何应付");
});

test("应付对账对平后批量确认草稿应付，来源已作废的草稿被跳过并回报", async () => {
  const { service, locks, updates, audits } = confirmHarness(scopeRow("matched"), [draftEntry("e1", "10"), draftEntry("e2", "32.5"), draftEntry("e3", "99", "voided")]);
  const result = await service.confirmPayables("recon-1", { id: "user-1" });
  assert.equal(result.confirmed_count, 2);
  assert.equal(result.confirmed_amount, "42.5000");
  assert.equal(result.skipped_count, 1);
  assert.equal(result.skipped[0].reason, "来源已作废");
  assert.deepEqual(updates.map((item) => item.id), ["e1", "e2"]);
  // 1 次对账行锁 + 每条被确认的应付一次行锁（被跳过的草稿不锁也不写）
  assert.equal(locks.filter((sql) => sql.includes("supplier_payable_reconciliations")).length, 1);
  assert.equal(locks.filter((sql) => sql.includes("supplier_payable_entries")).length, 2);
  assert.equal(audits[0][0], "supplier_payable_reconciliation.confirm_payables");
  assert.equal(audits[0][4].confirmed_amount, "42.5000");
});

test("批量确认只取对账范围内的草稿应付，可选收窄到订单与采购单", async () => {
  const { service, query } = confirmHarness({ ...scopeRow("matched"), orderNo: "SO-7", purchaseOrderId: "po-9" }, []);
  await service.confirmPayables("recon-1", { id: "user-1" });
  const where = query().where;
  assert.equal(where.status, "draft");
  assert.equal(where.supplierId, "supplier-1");
  assert.equal(where.currency, "CNY");
  assert.equal(where.orderNo, "SO-7");
  assert.equal(where.purchaseOrderId, "po-9");
});

// ---------------------------------------------------------------------------
// 2026-09-24（两步口径）：确认应付 = **挂账**（每条应付一张凭证，借成本 / 贷应付账款），
//   不再写「钱已转出」的支出流水 —— 钱还没付，现金那条留给「登记付款」。
// ---------------------------------------------------------------------------

test("确认应付走挂账：每条应付一张凭证，不写支出流水、不动银行", async () => {
  const harness = confirmHarness(scopeRow("matched"), [draftEntry("e1", "10"), draftEntry("e2", "32.5")]);
  const result = await harness.service.confirmPayables("recon-1", { id: "user-1" });
  assert.deepEqual(harness.cashFlowCalls, [], "钱还没付：确认这一步绝不能写「钱转出」的流水");
  assert.equal(harness.accrualCalls.length, 2, "对账单只是「一次确认多条」的入口，挂账仍然逐条");
  assert.deepEqual(harness.accrualCalls.map((call) => call.source_id), ["e1", "e2"]);
  assert.deepEqual(harness.accrualCalls.map((call) => call.amount.toString()), ["10", "32.5"]);
  assert.equal(harness.accrualCalls[0].counterparty_name, "晋江大田", "对方名称取供应商名，不能退化成 UUID");
  assert.deepEqual(harness.accrualCalls[0].contra_subject_names, ["主营业务成本", "原材料"], "原料入库来源 → 主营业务成本（与付款过账同一套归类口径）");
  assert.equal(result.bank_missing, false);
  assert.equal(result.cash_flow_entry_id, null);
  assert.deepEqual(result.accrual_voucher_ids, ["voucher-1", "voucher-2"]);
});

test("确认应付：外加工来源归到「加工费」，且确认时补的银行/科目回写对账单", async () => {
  const harness = confirmHarness(
    scopeRow("matched", { bankId: null }),
    [draftEntry("e1", "10", undefined, "outsource_receipt")],
  );
  const result = await harness.service.confirmPayables("recon-1", { id: "user-1" }, { bank_id: "bank-1", subject_id: "subject-9" });
  assert.deepEqual(harness.accrualCalls[0].contra_subject_names, ["加工费"], "来源类型决定科目候选链");
  assert.equal(harness.accrualCalls[0].contra_subject_id, "subject-9", "人工选的科目优先于候选链");
  assert.equal(harness.reconciliationUpdates[0].bankId, "bank-1");
  assert.equal(harness.reconciliationUpdates[0].subjectId, "subject-9");
  assert.equal(result.bank_missing, false);
});

test("应付对账单没有银行账户时：照样挂账，也没有 bank_missing 警告", async () => {
  const harness = confirmHarness(scopeRow("matched", { bankId: null }), [draftEntry("e1", "10")]);
  const result = await harness.service.confirmPayables("recon-1", { id: "user-1" });
  assert.equal(harness.accrualCalls.length, 1);
  assert.equal(result.bank_missing, false, "挂账与银行无关：这里再提示「没选账户」只会让人以为账没记上");
});

test("确认应付时不能用一个不在池子里的银行账户（先校验，再动事务）", async () => {
  const { service, updates, cashFlowCalls } = confirmHarness(scopeRow("matched", { bankId: null }), [draftEntry("e1", "10")]);
  await assert.rejects(
    () => service.confirmPayables("recon-1", { id: "user-1" }, { bank_id: "bank-dead" }),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
  assert.deepEqual(updates, [], "银行非法时不得确认任何应付（不能出现「确认了但没记账」）");
  assert.deepEqual(cashFlowCalls, []);
});

// ---------------------------------------------------------------------------
// 2026-09-15：应付流转与对账口径
//   用户反馈「接收应付后没有流转到应付对账」「对账创建完也没有流转到确认付款」。
//   根因之一：对账快照只统计**已确认**应付，而它对账之后要确认的正是那些草稿 ——
//   财务刚接收完去做对账时系统余额恒为 0、差异恒等于 −外部余额，两边口径不一致，流转就断了。
// ---------------------------------------------------------------------------

/** create 的替身：记录查询条件与写入数据。 */
function createHarness(entries) {
  const captured = { where: null, data: null };
  let created = 0;
  const prisma = {
    supplier: { findFirst: async () => ({ id: "supplier-1" }) },
    supplierPayableEntry: { findMany: async (args) => { captured.where = args.where; return entries; } },
    supplierPayment: { findMany: async () => [] },
    supplierPayableReconciliation: { create: async ({ data }) => { captured.data = data; created += 1; return { id: `recon-${created}`, ...data }; } },
  };
  const audit = { create: () => ({}), record: async () => {}, recordWithOrderNo: async () => {} };
  return { service: new SupplierPayableReconciliationService(prisma, audit, cashFlowStub()), captured };
}

const scopedEntry = (overrides = {}) => ({ id: "entry-1", amount: new Prisma.Decimal("500"), status: "draft", currency: "CNY", supplierId: "supplier-1", orderNo: "SO-1", confirmationDate: new Date("2026-09-10T00:00:00.000Z"), ...overrides });

test("创建应付对账时把待确认的草稿也算进系统余额（先对账、再确认应付）", async () => {
  const { service, captured } = createHarness([scopedEntry()]);
  const row = await service.create({ supplier_id: "supplier-1", period_start: "2026-09-01", period_end: "2026-09-30", external_balance: "500", currency: "CNY" }, { id: "user-1" });
  assert.deepEqual(captured.where.status, { in: ["draft", "confirmed", "partially_paid", "paid"] }, "草稿必须纳入对账快照，否则刚接收完应付去做对账时系统余额恒为 0");
  assert.equal(row.payableAmountSnapshot.toString(), "500", "应付快照 = 对账范围内全部应付（含草稿）");
  assert.equal(row.systemBalance.toString(), "500");
  assert.equal(row.difference.toString(), "0");
  assert.equal(row.status, "matched", "外部余额与草稿合计一致时必须直接对平，否则用户会被卡在「有差异」过不去");
});

test("列表返回流转摘要：覆盖多少条应付、多少条待确认、哪些订单与物料", async () => {
  const row = { id: "recon-1", status: "matched", supplierId: "supplier-1", currency: "CNY", orderNo: null, purchaseOrderId: null, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") };
  const entries = [
    { supplierId: "supplier-1", currency: "CNY", orderNo: "SO-1", purchaseOrderId: null, confirmationDate: new Date("2026-09-10T00:00:00.000Z"), amount: new Prisma.Decimal("500"), status: "draft", payableSource: { purchaseOrder: { purchaseOrderNo: "PO-1" }, purchaseOrderItem: { materialSnapshot: null, material: { name: "涤纶布", specificationModel: "150D" } } }, outsourcePayableSource: null },
    { supplierId: "supplier-1", currency: "CNY", orderNo: "SO-2", purchaseOrderId: null, confirmationDate: new Date("2026-09-11T00:00:00.000Z"), amount: new Prisma.Decimal("300"), status: "confirmed", payableSource: { purchaseOrder: { purchaseOrderNo: "PO-2" }, purchaseOrderItem: { materialSnapshot: { name: "拉链", specificationModel: "5#" }, material: null } }, outsourcePayableSource: null },
    // 不在期间内：不能混进这条对账的摘要
    { supplierId: "supplier-1", currency: "CNY", orderNo: "SO-9", purchaseOrderId: null, confirmationDate: new Date("2026-08-01T00:00:00.000Z"), amount: new Prisma.Decimal("999"), status: "draft", payableSource: null, outsourcePayableSource: null },
  ];
  const prisma = { supplierPayableReconciliation: { findMany: async () => [row] }, supplierPayableEntry: { findMany: async () => entries } };
  const service = new SupplierPayableReconciliationService(prisma, { record: async () => {} }, cashFlowStub());
  const result = (await service.list())[0];
  assert.equal(result.flow.entry_count, 2);
  assert.equal(result.flow.draft_count, 1);
  assert.equal(result.flow.draft_amount, "500.0000");
  assert.equal(result.flow.can_confirm_payables, true, "已对平且有草稿 → 前端要能直接批量确认");
  assert.deepEqual(result.flow.order_nos, ["SO-1", "SO-2"], "新列：该批原料对应订单号");
  assert.deepEqual(result.flow.purchase_order_nos, ["PO-1", "PO-2"]);
  assert.deepEqual(result.flow.material_names, ["涤纶布", "拉链"], "新列：采购的物料名称（含快照兜底）");
  assert.deepEqual(result.flow.material_specifications, ["150D", "5#"], "新列：规格型号（主数据优先，物料被删后回落来源快照）");
});

test("没有覆盖条目的对账也返回完整摘要结构（前端不必做空值判断）", async () => {
  const row = { id: "recon-1", status: "difference", supplierId: "supplier-1", currency: "CNY", orderNo: null, purchaseOrderId: null, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") };
  const prisma = { supplierPayableReconciliation: { findMany: async () => [row] }, supplierPayableEntry: { findMany: async () => [] } };
  const service = new SupplierPayableReconciliationService(prisma, { record: async () => {} }, cashFlowStub());
  const flow = (await service.list())[0].flow;
  assert.deepEqual(flow, { entry_count: 0, draft_count: 0, draft_amount: "0.0000", can_confirm_payables: false, order_nos: [], purchase_order_nos: [], material_names: [], material_specifications: [] });
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户反馈）：
//   「已创建对账单，双击某个条目，弹出的表单还应当显示这个订单的物料名称和规格型号」
// 详情必须和列表用同一份摘要口径（flow）+ 逐条的物料名称/规格型号。
// ---------------------------------------------------------------------------
test("对账详情返回 flow 摘要，且逐条明细带物料名称与规格型号", async () => {
  const row = { id: "recon-1", reconciliationNo: "APREC-1", status: "matched", supplierId: "supplier-1", currency: "CNY", orderNo: null, purchaseOrderId: null, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") };
  const entry = { id: "entry-1", payableNo: "AP-1", sourceType: "raw_material_inbound", sourceNoSnapshot: "IN-1", orderNo: "SO-1", quantity: new Prisma.Decimal("10"), amount: new Prisma.Decimal("500"), currency: "CNY", status: "draft", confirmationDate: new Date("2026-09-10T00:00:00.000Z"), purchaseOrderId: null, supplierId: "supplier-1", payableSource: { purchaseOrder: { purchaseOrderNo: "PO-1" }, purchaseOrderItem: { materialSnapshot: null, unit: { name: "米" }, material: { name: "涤纶布", specificationModel: "150D" } } }, outsourcePayableSource: null };
  const prisma = {
    supplierPayableReconciliation: { findFirst: async () => row },
    supplierPayableEntry: { findMany: async () => [entry] },
    payableSource: { findMany: async () => [] },
    outsourcePayableSource: { findMany: async () => [] },
  };
  const service = new SupplierPayableReconciliationService(prisma, { record: async () => {} }, cashFlowStub());
  const detail = await service.get("recon-1");
  assert.deepEqual(detail.flow.material_names, ["涤纶布"]);
  assert.deepEqual(detail.flow.material_specifications, ["150D"]);
  assert.equal(detail.details.payable_entries[0].material_name, "涤纶布");
  assert.equal(detail.details.payable_entries[0].material_specification, "150D");
  assert.equal(detail.details.payable_entries[0].unit_name, "米");
  assert.equal(detail.details.payable_entries[0].purchase_order_no, "PO-1");
});

// ---------------------------------------------------------------------------
// 2026-09-20（用户要求）：「其他应付的条目支持删除，包括删除确认应付和应付对账」。
//
// 删一条误录的其他应付时，原来会被「请先处理那张对账单」挡住 —— 而对账单根本没有删除入口。
// 这条接口就是那个「下一步」：把录错的对账单删掉，被它覆盖的草稿应付重新回到「待创建对账」，
// 也就重新变得可删除。已经用于确认应付并记账的对账单不能删（那笔支出会失去来源单号）。
// ---------------------------------------------------------------------------

/** 删除对账单的替身：记录被写入的 data、审计事件与「以这张对账单为来源的支出流水」查询。 */
function removeReconciliationHarness({ row, flows = [] } = {}) {
  const updates = [];
  const events = [];
  const locks = [];
  const tx = {
    $queryRaw: async () => { locks.push("supplier_payable_reconciliations"); return []; },
    supplierPayableReconciliation: {
      findFirst: async () => row,
      update: async ({ data }) => { updates.push(data); return { ...row, ...data }; },
    },
    cashFlowEntry: { findMany: async () => flows },
  };
  const prisma = { $transaction: async (fn) => fn(tx) };
  const audit = {
    softDelete: () => ({ deletedAt: new Date("2026-09-20T00:00:00.000Z"), deletedBy: "user-1", updatedBy: "user-1" }),
    record: async (action, entityType, actorId, entityId, details) => { events.push({ action, entityType, actorId, entityId, details }); },
  };
  return { service: new SupplierPayableReconciliationService(prisma, audit, cashFlowStub()), updates, events, locks };
}

const reconciliationRow = (extra = {}) => ({
  id: "recon-1", reconciliationNo: "APREC-1", status: "matched", supplierId: "supplier-1", currency: "CNY",
  orderNo: null, purchaseOrderId: null, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z"),
  systemBalance: new Prisma.Decimal("1200"), remark: null, ...extra,
});

test("应付对账可以逻辑删除：行锁 + 写删除原因 + 软删除 + 一条审计", async () => {
  const { service, updates, events, locks } = removeReconciliationHarness({ row: reconciliationRow() });
  const row = await service.remove("recon-1", "供应商选错了，这张是重复建的", { id: "user-1" });
  assert.equal(locks.length, 1, "删除也要先锁行（与 resolve / confirmPayables 同一把锁）");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].deletedBy, "user-1");
  assert.ok(updates[0].deletedAt instanceof Date);
  assert.equal(updates[0].remark, "删除原因：供应商选错了，这张是重复建的");
  assert.equal(updates[0].status, undefined, "删除 ≠ 改状态：软删除标记才是「这条已经不在账上」的唯一标记");
  assert.equal(row.deletedBy, "user-1");
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "supplier_payable_reconciliation.delete");
  assert.equal(events[0].details.reconciliation_no, "APREC-1");
  assert.equal(events[0].details.status_when_deleted, "matched");
  assert.equal(events[0].details.reason, "供应商选错了，这张是重复建的");
});

test("应付对账删除：原因必填；已用于确认应付并记账的对账单拒删并点名那笔支出流水", async () => {
  const blank = removeReconciliationHarness({ row: reconciliationRow() });
  await assert.rejects(() => blank.service.remove("recon-1", "   ", { id: "user-1" }), (error) => error.getResponse().code === "DELETION_REASON_REQUIRED");
  assert.equal(blank.updates.length, 0);

  const confirmed = removeReconciliationHarness({ row: reconciliationRow(), flows: [{ entryNo: "CF-20260920-7" }] });
  await assert.rejects(
    () => confirmed.service.remove("recon-1", "录错了", { id: "user-1" }),
    (error) => error.getResponse().code === "RECONCILIATION_HAS_CONFIRMED_PAYABLES" && error.getResponse().message.includes("CF-20260920-7"),
  );
  assert.equal(confirmed.updates.length, 0, "被拦下时不写任何字段");
});

test("应付对账删除：对账单不存在时 404（不静默成功）", async () => {
  const { service, updates } = removeReconciliationHarness({ row: null });
  await assert.rejects(() => service.remove("recon-x", "录错了", { id: "user-1" }), (error) => error.getResponse().code === "RECONCILIATION_NOT_FOUND");
  assert.equal(updates.length, 0);
});
