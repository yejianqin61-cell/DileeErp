const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { SupplierPayableService } = require("../../dist/modules/finance/supplier-payable.service.js");

/**
 * CashFlowService 替身：确认应付（逐条 / 按对账单批量）都要记账 ——
 * `requireSubject` 校验会计科目，`recordConfirmation` 写支出流水（= 钱从银行账户转出）。
 */
const cashFlowStub = (extra = {}) => ({ requireSubject: async () => null, recordConfirmation: async () => null, ...extra });

test("payable list exposes purchase batch traceability, supplier name and payable balance", async () => {
  const prisma = {
    supplierPayableEntry: { findMany: async () => [{
      id: "entry-1", sourceNoSnapshot: "GR-1", amount: new Prisma.Decimal("100"),
      supplierId: "supplier-1", currency: "CNY", orderNo: "SO-1", purchaseOrderId: null, confirmationDate: new Date("2026-09-10T00:00:00.000Z"),
      supplier: { id: "supplier-1", name: "绍兴纺织", supplierCode: "S001" },
      payableSource: { purchaseReceipt: { receiptNo: "GR-1", extensionData: { batch_sequence: 2 } }, rawMaterialInbound: null, purchaseOrder: { purchaseOrderNo: "PO-1" } },
      outsourcePayableSource: null,
      allocations: [
        { status: "active", amount: new Prisma.Decimal("40"), payment: { status: "posted" } },
        { status: "active", amount: new Prisma.Decimal("10"), payment: { status: "draft" } },
        { status: "reversed", amount: new Prisma.Decimal("5"), payment: { status: "posted" } },
      ],
    }] },
    supplierPayableReconciliation: { findMany: async () => [] },
  };
  const service = new SupplierPayableService(prisma, {}, cashFlowStub());
  const [row] = await service.list();
  assert.equal(row.source_no, "GR-1");
  assert.equal(row.purchase_order_no, "PO-1");
  assert.equal(row.batch_sequence, 2);
  assert.equal(row.supplier_name, "绍兴纺织", "财务列表要能看出供应商名称，不能只给 UUID");
  // 已付只算「有效核销 + 已过账付款」：草稿付款与已冲销核销都不算。
  assert.equal(row.paid_amount, "40.0000");
  assert.equal(row.outstanding_amount, "60.0000");
  assert.equal(row.reconciliation, null, "没有被任何对账单覆盖时必须是 null，前端据此判断「待创建对账」");
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户反馈）：
//   「待创建对账中，对某条条目创建对账单之后，待创建对账就不该继续展示这条条目了」
//   「某条条目我点击接受应付，为什么没有在待创建对账中看见这条条目」
// 已纳入某张对账单范围的草稿必须被标记出来，前端才能既不重复对账、又能说明它去哪了。
// ---------------------------------------------------------------------------

test("应付列表标出每条应付被哪张对账单覆盖（供应商+币种+期间，可收窄到订单/采购单）", async () => {
  const base = { amount: new Prisma.Decimal("100"), status: "draft", allocations: [], payableSource: null, outsourcePayableSource: null, supplier: null };
  const rows = [
    { ...base, id: "covered-by-order", supplierId: "supplier-1", currency: "CNY", orderNo: "SO-7", purchaseOrderId: null, confirmationDate: new Date("2026-09-11T00:00:00.000Z") },
    { ...base, id: "order-mismatch", supplierId: "supplier-1", currency: "CNY", orderNo: "SO-8", purchaseOrderId: null, confirmationDate: new Date("2026-09-11T00:00:00.000Z") },
    { ...base, id: "other-month", supplierId: "supplier-1", currency: "CNY", orderNo: "SO-7", purchaseOrderId: null, confirmationDate: new Date("2026-08-10T00:00:00.000Z") },
    { ...base, id: "other-currency", supplierId: "supplier-1", currency: "USD", orderNo: "SO-7", purchaseOrderId: null, confirmationDate: new Date("2026-09-12T00:00:00.000Z") },
    { ...base, id: "other-supplier", supplierId: "supplier-2", currency: "CNY", orderNo: "SO-7", purchaseOrderId: null, confirmationDate: new Date("2026-09-12T00:00:00.000Z") },
  ];
  const prisma = {
    supplierPayableEntry: { findMany: async () => rows },
    supplierPayableReconciliation: {
      findMany: async (args) => {
        assert.deepEqual(args.where.supplierId, { in: ["supplier-1", "supplier-2"] }, "只取涉及供应商的对账单，不要全表扫");
        return [{ id: "recon-2", reconciliationNo: "APREC-2", status: "difference", supplierId: "supplier-1", currency: "CNY", orderNo: "SO-7", purchaseOrderId: null, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") }];
      },
    },
  };
  const service = new SupplierPayableService(prisma, {}, cashFlowStub());
  const result = await service.list();
  const byId = Object.fromEntries(result.map((row) => [row.id, row]));
  assert.deepEqual(byId["covered-by-order"].reconciliation, { id: "recon-2", reconciliation_no: "APREC-2", status: "difference", period_start: new Date("2026-09-01T00:00:00.000Z"), period_end: new Date("2026-09-30T00:00:00.000Z") });
  assert.equal(byId["order-mismatch"].reconciliation, null, "按订单创建的对账只覆盖同订单的应付");
  assert.equal(byId["other-month"].reconciliation, null, "8 月的应付不在 9 月对账范围里");
  assert.equal(byId["other-currency"].reconciliation, null, "币种不一致不算覆盖");
  assert.equal(byId["other-supplier"].reconciliation, null, "别家供应商的对账不覆盖这条");
});

test("supplier payable confirmation locks and rechecks the current draft", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "payable-1", status: "confirmed", orderNo: "SO-1", payableNo: "AP-1" };
  const prisma = {
    supplierPayableEntry: {
      findFirst: async () => row,
      update: async () => { updateCount += 1; return row; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayableEntry: prisma.supplierPayableEntry,
    }),
  };
  const audit = { recordWithOrderNo: async () => {} };
  const service = new SupplierPayableService(prisma, audit, cashFlowStub());
  await assert.rejects(
    () => service.confirm("payable-1", { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYABLE_NOT_CONFIRMABLE",
  );
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

test("supplier payable confirmation rejects a voided source", async () => {
  const row = { id: "payable-1", status: "draft", payableSource: { status: "voided" }, outsourcePayableSource: null };
  const prisma = { supplierPayableEntry: { findFirst: async () => row, update: async () => { throw new Error("must not write"); } }, $transaction: async (fn) => fn({ $queryRaw: async () => [], supplierPayableEntry: prisma.supplierPayableEntry }) };
  const service = new SupplierPayableService(prisma, { recordWithOrderNo: async () => {} }, cashFlowStub());
  await assert.rejects(() => service.confirm("payable-1", { id: "user-1" }), (error) => error.getResponse().code === "PAYABLE_SOURCE_VOIDED");
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求「一旦确认应付，金额就要转出对应的账户」）：
//   逐条确认应付也要记账。用户点的是「确认应付」列表行上的那条路，不记账的话
//   用户实际看到的仍然是「确认了但银行余额没动」。
// ---------------------------------------------------------------------------

function payableConfirmHarness(entry) {
  const cashFlowCalls = [];
  const prisma = {
    bank: { findFirst: async ({ where }) => (where.id === "bank-dead" ? null : { id: where.id, bankName: "农业银行", accountNumber: "5706" }) },
    supplierPayableEntry: { findFirst: async () => entry, update: async ({ data }) => ({ ...entry, ...data }) },
  };
  prisma.$transaction = async (fn) => fn({ $queryRaw: async () => [], supplierPayableEntry: prisma.supplierPayableEntry });
  const audit = { update: () => ({ updatedBy: "user-1" }), recordWithOrderNo: async () => {} };
  const cashFlow = cashFlowStub({ recordConfirmation: async (input) => { cashFlowCalls.push(input); return { id: "cf-1", created: true, amount: input.amount }; } });
  return { service: new SupplierPayableService(prisma, audit, cashFlow), cashFlowCalls };
}

const draftPayable = (extra = {}) => ({
  id: "payable-1", payableNo: "AP-1", status: "draft", orderNo: "SO-1", supplierId: "supplier-1",
  amount: new Prisma.Decimal("500"), currency: "CNY", sourceType: "raw_material_inbound",
  supplier: { name: "晋江大田" }, payableSource: { status: "received" }, outsourcePayableSource: null, ...extra,
});

test("逐条确认应付：写一条支出流水并从指定的支付银行转出", async () => {
  const { service, cashFlowCalls } = payableConfirmHarness(draftPayable());
  const result = await service.confirm("payable-1", { id: "user-1" }, { bank_id: "bank-1" });
  assert.equal(cashFlowCalls.length, 1);
  const input = cashFlowCalls[0];
  assert.equal(input.direction, "expense", "确认应付 = 钱出去");
  assert.equal(input.sourceType, "supplier_payable_entry");
  assert.equal(input.sourceId, "payable-1");
  assert.equal(input.amount.toString(), "500");
  assert.equal(input.bankId, "bank-1");
  assert.equal(input.counterpartyName, "晋江大田", "对方名称取供应商名，不能退化成 UUID");
  assert.deepEqual(input.subjectNames, ["主营业务成本", "原材料"], "会计科目候选链按来源类型选定");
  assert.equal(result.cash_flow_entry_id, "cf-1");
  assert.equal(result.bank_missing, false);
});

test("逐条确认应付：外加工来源归到「加工费」；没选银行时回报 bank_missing", async () => {
  const outsource = payableConfirmHarness(draftPayable({ sourceType: "outsource_receipt", outsourcePayableSource: { status: "received" }, payableSource: null }));
  const result = await outsource.service.confirm("payable-1", { id: "user-1" });
  assert.deepEqual(outsource.cashFlowCalls[0].subjectNames, ["加工费"]);
  assert.equal(outsource.cashFlowCalls[0].bankId, null);
  assert.equal(result.bank_missing, true);
});

test("逐条确认应付：银行非法时先拒绝，不确认任何应付", async () => {
  const { service, cashFlowCalls } = payableConfirmHarness(draftPayable());
  await assert.rejects(
    () => service.confirm("payable-1", { id: "user-1" }, { bank_id: "bank-dead" }),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
  assert.deepEqual(cashFlowCalls, []);
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求「不要又是登记付款又是确认应付，直接就是支持勾选，批量确认」）：
//   界面勾选多条草稿应付 → 一次确认。整批共用「支付银行 + 会计科目」，但**每条应付各写一条流水**
//   （每条都有自己的单号，合并成一条就追不回是哪批料的钱）；已确认/来源作废的条目跳过而非整批失败。
// ---------------------------------------------------------------------------

const batchDraft = (id, extra = {}) => ({
  id, payableNo: `AP-${id}`, orderNo: "SO-1", supplierId: "supplier-1",
  amount: new Prisma.Decimal("100"), currency: "CNY", sourceType: "raw_material_inbound",
  status: "draft", supplier: { name: "晋江大田" }, payableSource: { status: "received" }, outsourcePayableSource: null, ...extra,
});

function batchHarness(rows, options = {}) {
  const cashFlowCalls = [];
  const writes = [];
  let locks = 0;
  const entryTable = {
    // 替身照做服务端的过滤条件（id 列表 + status = draft），才能断言「已确认的会被跳过」。
    findMany: async (args) => rows.filter((row) => args.where.id.in.includes(row.id) && row.status === "draft"),
    updateMany: async ({ where, data }) => {
      const targets = rows.filter((row) => where.id.in.includes(row.id) && row.status === "draft");
      writes.push({ ids: where.id.in, data });
      for (const row of targets) row.status = "confirmed";
      return { count: options.updateCount ?? targets.length };
    },
  };
  const prisma = {
    bank: { findFirst: async ({ where }) => (where.id === "bank-dead" ? null : { id: where.id, bankName: "农业银行", accountNumber: "5706" }) },
    supplierPayableEntry: entryTable,
  };
  prisma.$transaction = async (fn) => fn({ $queryRaw: async () => { locks += 1; return []; }, supplierPayableEntry: entryTable });
  const audit = { update: () => ({ updatedBy: "user-1" }), recordWithOrderNo: async () => {} };
  const cashFlow = cashFlowStub({ recordConfirmation: async (input) => { cashFlowCalls.push(input); return { id: `cf-${cashFlowCalls.length}` }; } });
  return { service: new SupplierPayableService(prisma, audit, cashFlow), cashFlowCalls, writes, locks: () => locks };
}

test("勾选批量确认：每条应付各写一条支出流水，并按币种给合计", async () => {
  const harness = batchHarness([batchDraft("p1"), batchDraft("p2", { amount: new Prisma.Decimal("250") }), batchDraft("p3", { status: "confirmed" })]);
  const result = await harness.service.batchConfirm(["p1", "p2", "p3"], { id: "user-1" }, { bank_id: "bank-1", subject_id: "subject-1" });
  assert.equal(result.confirmed_count, 2);
  assert.equal(result.skipped_count, 1, "已经被确认过的条目要跳过，不能重复记账（同一笔钱扣两次）");
  assert.equal(harness.cashFlowCalls.length, 2, "逐条写流水，才追得回是哪批料的钱");
  assert.deepEqual(harness.cashFlowCalls.map((call) => call.sourceId), ["p1", "p2"]);
  assert.deepEqual(harness.cashFlowCalls.map((call) => call.amount.toString()), ["100", "250"]);
  assert.equal(harness.cashFlowCalls.every((call) => call.direction === "expense" && call.bankId === "bank-1" && call.subjectId === "subject-1"), true);
  assert.deepEqual(result.amounts, [{ currency: "CNY", amount: "350.0000" }]);
  assert.equal(result.bank_missing, false);
  assert.deepEqual(result.cash_flow_entry_ids, ["cf-1", "cf-2"]);
});

test("勾选批量确认：来源已作废的条目不确认，但也不让整批失败", async () => {
  const harness = batchHarness([batchDraft("p1"), batchDraft("p2", { payableSource: { status: "voided" } })]);
  const result = await harness.service.batchConfirm(["p1", "p2"], { id: "user-1" }, {});
  assert.equal(result.confirmed_count, 1);
  assert.equal(result.skipped_count, 1);
  assert.deepEqual(harness.cashFlowCalls.map((call) => call.sourceId), ["p1"]);
  assert.deepEqual(harness.writes[0].ids, ["p1"], "作废来源那条不能被写成已确认");
});

test("勾选批量确认：勾的全是不可确认的条目时拒绝，一条流水都不写", async () => {
  const harness = batchHarness([batchDraft("p1", { status: "confirmed" })]);
  await assert.rejects(
    () => harness.service.batchConfirm(["p1"], { id: "user-1" }),
    (error) => error.getResponse().code === "NO_DRAFT_PAYABLES",
  );
  assert.deepEqual(harness.cashFlowCalls, []);
  assert.deepEqual(harness.writes, []);
});

test("勾选批量确认：没有勾选任何条目时直接拒绝", async () => {
  const harness = batchHarness([]);
  await assert.rejects(
    () => harness.service.batchConfirm([], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYABLE_IDS_REQUIRED",
  );
  assert.equal(harness.locks(), 0, "连事务都不该进");
});

test("勾选批量确认：银行非法时先拒绝，一条都不确认", async () => {
  const harness = batchHarness([batchDraft("p1")]);
  await assert.rejects(
    () => harness.service.batchConfirm(["p1"], { id: "user-1" }, { bank_id: "bank-dead" }),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
  assert.deepEqual(harness.cashFlowCalls, []);
  assert.deepEqual(harness.writes, []);
});

test("勾选批量确认：合计按币种分组，不跨币种相加", async () => {
  const harness = batchHarness([batchDraft("p1"), batchDraft("p2", { currency: "USD", amount: new Prisma.Decimal("20") })]);
  const result = await harness.service.batchConfirm(["p1", "p2"], { id: "user-1" }, {});
  assert.deepEqual(result.amounts, [{ currency: "CNY", amount: "100.0000" }, { currency: "USD", amount: "20.0000" }]);
  assert.equal(result.bank_missing, true, "没指定银行时界面必须给出警告，而不是一句成功");
});

test("勾选批量确认：会计科目候选链按每条自己的来源类型选定", async () => {
  const harness = batchHarness([batchDraft("p1"), batchDraft("p2", { sourceType: "outsource_receipt", payableSource: null, outsourcePayableSource: { status: "received" } })]);
  await harness.service.batchConfirm(["p1", "p2"], { id: "user-1" }, {});
  assert.deepEqual(harness.cashFlowCalls.map((call) => call.subjectNames), [["主营业务成本", "原材料"], ["加工费"]]);
});

test("勾选批量确认：状态被别的入口改动时整批拒绝，不出现「界面说确认了、库里没确认」", async () => {
  const harness = batchHarness([batchDraft("p1")], { updateCount: 0 });
  await assert.rejects(
    () => harness.service.batchConfirm(["p1"], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYABLE_CONFIRM_CONFLICT",
  );
  assert.deepEqual(harness.cashFlowCalls, [], "没写成状态就绝不能记账");
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求）：「确认应付里如果是已付款的条目就不要出现了」+
//   「支持按已付未付、按时间范围筛选」。过滤在映射之后做（关键字要匹配物料名/供应商名/来源批次号，
//   这些都是映射阶段才从关联里摊平出来的），所以这里断言的是最终列表。
// ---------------------------------------------------------------------------

test("应付台账按付款情况筛选：未付只留草稿，已付含已确认及以后", async () => {
  const base = { amount: new Prisma.Decimal("100"), allocations: [], payableSource: null, outsourcePayableSource: null, supplier: null, orderNo: "SO-1", currency: "CNY", purchaseOrderId: null };
  const rows = [
    { ...base, id: "p-draft", payableNo: "AP-001", status: "draft", supplierId: "s-1", confirmationDate: new Date("2026-09-10T00:00:00.000Z") },
    { ...base, id: "p-confirmed", payableNo: "AP-002", status: "confirmed", supplierId: "s-1", confirmationDate: new Date("2026-09-11T00:00:00.000Z") },
    { ...base, id: "p-reversed", payableNo: "AP-003", status: "reversed", supplierId: "s-1", confirmationDate: new Date("2026-09-12T00:00:00.000Z") },
  ];
  const prisma = { supplierPayableEntry: { findMany: async () => rows }, supplierPayableReconciliation: { findMany: async () => [] } };
  const service = new SupplierPayableService(prisma, {}, cashFlowStub());
  const ids = (filter) => service.list(undefined, undefined, undefined, filter).then((result) => result.map((row) => row.id));

  assert.deepEqual(await ids({ payment: "unpaid" }), ["p-draft"]);
  assert.deepEqual(await ids({ payment: "paid" }), ["p-confirmed"]);
  assert.deepEqual(await ids({ payment: "all" }), ["p-draft", "p-confirmed", "p-reversed"], "全部包含已冲销的");
  assert.deepEqual(await ids({}), ["p-draft", "p-confirmed", "p-reversed"], "不传筛选时保持原行为（不静默丢行）");
});

test("应付台账按确认日期区间与关键字筛选（区间含两端，无日期的行不算命中）", async () => {
  const base = { amount: new Prisma.Decimal("100"), allocations: [], payableSource: null, outsourcePayableSource: null, supplier: null, status: "draft", currency: "CNY", purchaseOrderId: null };
  const rows = [
    { ...base, id: "p-1", payableNo: "AP-001", supplierId: "s-1", orderNo: "SO-1", confirmationDate: new Date("2026-09-01T00:00:00.000Z") },
    { ...base, id: "p-2", payableNo: "AP-002", supplierId: "s-1", orderNo: "SO-2", confirmationDate: new Date("2026-09-30T00:00:00.000Z") },
    { ...base, id: "p-3", payableNo: "AP-003", supplierId: "s-1", orderNo: "SO-3", confirmationDate: new Date("2026-10-01T00:00:00.000Z") },
  ];
  const prisma = { supplierPayableEntry: { findMany: async () => rows }, supplierPayableReconciliation: { findMany: async () => [] } };
  const service = new SupplierPayableService(prisma, {}, cashFlowStub());
  const ids = (filter) => service.list(undefined, undefined, undefined, filter).then((result) => result.map((row) => row.id));

  assert.deepEqual(await ids({ from: "2026-09-01", to: "2026-09-30" }), ["p-1", "p-2"], "两端当天都算命中");
  assert.deepEqual(await ids({ from: "2026-09-02" }), ["p-2", "p-3"]);
  assert.deepEqual(await ids({ q: "SO-2" }), ["p-2"], "关键字走与列表页搜索同一批字段");
  assert.deepEqual(await ids({ q: "ap-003" }), ["p-3"], "单号大小写不敏感");
});

test("supplier payable reversal locks and rechecks active allocations", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = {
    id: "payable-1", status: "confirmed", orderNo: "SO-1", payableNo: "AP-1", remark: null,
    allocations: [{ payment: { status: "posted" } }],
  };
  const prisma = {
    supplierPayableEntry: {
      findFirst: async () => row,
      update: async () => { updateCount += 1; return row; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayableEntry: prisma.supplierPayableEntry,
    }),
  };
  const audit = { recordWithOrderNo: async () => {} };
  const service = new SupplierPayableService(prisma, audit, cashFlowStub());
  await assert.rejects(
    () => service.reverse("payable-1", "撤销原因", { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYABLE_HAS_ALLOCATIONS",
  );
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

test("supplier payable draft update locks and rechecks the current status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "payable-1", status: "confirmed", amount: "10", confirmationDate: new Date(), remark: null };
  const prisma = {
    supplierPayableEntry: {
      findFirst: async () => row,
      update: async () => { updateCount += 1; return row; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayableEntry: prisma.supplierPayableEntry,
    }),
  };
  const audit = { recordWithOrderNo: async () => {}, update: () => ({}) };
  const service = new SupplierPayableService(prisma, audit, cashFlowStub());
  await assert.rejects(
    () => service.updateDraft("payable-1", { amount: "12" }, { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYABLE_NOT_EDITABLE",
  );
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

// 2026-09-15：「应付管理都要支持选择币种、编辑币种」。
test("应付草稿可编辑币种：走币种字典校验并写回应付条目", async () => {
  let updated;
  const checked = [];
  const row = { id: "payable-1", status: "draft", amount: "10", currency: "CNY", confirmationDate: new Date("2026-09-15"), remark: null };
  const prisma = {
    supplierPayableEntry: { findFirst: async () => row, update: async ({ data }) => { updated = data; return { ...row, ...data }; } },
    $transaction: async (fn) => fn({ $queryRaw: async () => [], supplierPayableEntry: prisma.supplierPayableEntry }),
  };
  const audit = { recordWithOrderNo: async () => {}, update: () => ({}) };
  const service = new SupplierPayableService(prisma, audit, cashFlowStub(), { assertSupported: async (code) => { checked.push(code); } });
  await service.updateDraft("payable-1", { currency: "USD", amount: "12" }, { id: "user-1" });
  assert.deepEqual(checked, ["USD"]);
  assert.equal(updated.currency, "USD");
  assert.equal(updated.amount.toString(), "12");
});

test("confirmed supplier payable can be reopened to draft with a reason", async () => {
  let updated;
  const row = { id: "payable-1", status: "confirmed", orderNo: "SO-1", remark: null, allocations: [] };
  const prisma = {
    supplierPayableEntry: {
      findFirst: async () => row,
      update: async ({ data }) => { updated = data; return { ...row, ...data }; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      supplierPayableEntry: prisma.supplierPayableEntry,
    }),
  };
  const service = new SupplierPayableService(prisma, { update: () => ({}), recordWithOrderNo: async () => {} }, cashFlowStub());
  const result = await service.reopen("payable-1", "修正供应商金额", { id: "user-1" });
  assert.equal(result.status, "draft");
  assert.equal(updated.status, "draft");
});

test("payable source creation restores a soft-deleted unique entry", async () => {
  let restored = 0;
  const received = [];
  const deleted = { id: "payable-1", deletedAt: new Date(), sourceType: "raw_material_inbound" };
  const prisma = {
    payableSource: { findFirst: async () => ({ id: "source-1", status: "pending_finance", orderNo: "PO-1", supplierId: "supplier-1", quantity: "1", unitPrice: "2", taxRate: "0", amount: "2", currency: "CNY", rawMaterialInbound: { inboundNo: "IN-1" }, purchaseReceipt: null }), updateMany: async ({ where, data }) => { received.push({ where, data }); return { count: 1 }; } },
    supplierPayableEntry: { findUnique: async () => deleted, update: async () => { restored += 1; return { ...deleted, deletedAt: null, orderNo: "PO-1", amount: { toString: () => "2" } }; } },
    $transaction: async (fn) => fn({ $queryRaw: async () => [], payableSource: prisma.payableSource, supplierPayableEntry: prisma.supplierPayableEntry }),
  };
  const service = new SupplierPayableService(prisma, { update: () => ({}), recordWithOrderNo: async () => {} }, cashFlowStub());
  const result = await service.createFromSource({ source_type: "raw_material_inbound", source_id: "source-1" }, { id: "user-1" });
  assert.equal(result.deletedAt, null);
  assert.equal(restored, 1);
  // 接收应付必须把来源推进到「已接收」：否则列表永远显示按钮、永远「待财务接收」。
  assert.deepEqual(received.map((item) => ({ where: item.where, status: item.data.status })), [{ where: { id: "source-1", status: { not: "voided" } }, status: "received" }]);
});

test("外加工签收来源接收后同样标记为已接收（来源模型不同，状态口径一致）", async () => {
  const received = [];
  const source = { id: "osource-1", orderNo: "SO-2", supplierId: "supplier-2", quantity: new Prisma.Decimal("8"), unitPrice: new Prisma.Decimal("3"), taxRate: null, amount: new Prisma.Decimal("24"), currency: "CNY", purchaseOrderId: null, purchaseOrderItemId: null, logisticsBatchId: "batch-2", logisticsBatch: { batchNo: "B-2" }, outsourceReceipt: { id: "receipt-2" } };
  const prisma = {
    outsourcePayableSource: { updateMany: async ({ where, data }) => { received.push({ where, data }); return { count: 1 }; } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      outsourcePayableSource: { findFirst: async () => source, updateMany: prisma.outsourcePayableSource.updateMany },
      supplierPayableEntry: { findUnique: async () => null, create: async ({ data }) => ({ id: "entry-2", orderNo: data.orderNo, payableNo: data.payableNo, sourceType: data.sourceType, amount: data.amount, deletedAt: null }) },
    }),
  };
  const service = new SupplierPayableService(prisma, { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({ updatedBy: "user-1" }), recordWithOrderNo: async () => {} }, cashFlowStub());
  await service.createFromSource({ source_type: "outsource_receipt", source_id: "osource-1" }, { id: "user-1" });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].where, { id: "osource-1", status: { not: "voided" } });
  assert.equal(received[0].data.status, "received");
});

test("创建应付时把采购单/采购明细关联落库（否则按采购单对账的系统余额恒为 0）", async () => {
  let captured;
  const source = { id: "source-1", orderNo: "SO-1", supplierId: "supplier-1", quantity: new Prisma.Decimal("10"), unitPrice: new Prisma.Decimal("5"), taxRate: null, amount: new Prisma.Decimal("50"), currency: "CNY", purchaseOrderId: "po-1", purchaseOrderItemId: "poi-1", rawMaterialInbound: { inboundNo: "IN-1" }, purchaseReceipt: null };
  const prisma = {
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      payableSource: { findFirst: async () => source, updateMany: async () => ({ count: 1 }) },
      supplierPayableEntry: {
        findUnique: async () => null,
        create: async ({ data }) => { captured = data; return { id: "entry-1", ...data }; },
      },
    }),
  };
  const service = new SupplierPayableService(prisma, { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({ updatedBy: "user-1" }), recordWithOrderNo: async () => {} }, cashFlowStub());
  await service.createFromSource({ source_type: "raw_material_inbound", source_id: "source-1" }, { id: "user-1" });
  assert.equal(captured.purchaseOrderId, "po-1");
  assert.equal(captured.purchaseOrderItemId, "poi-1");
  assert.equal(captured.outsourceLogisticsBatchId, null, "原料入库来源没有外加工批次");
});

test("外加工签收来源创建应付时带上批次关联", async () => {
  let captured;
  const source = { id: "osource-1", orderNo: "SO-2", supplierId: "supplier-2", quantity: new Prisma.Decimal("8"), unitPrice: new Prisma.Decimal("3"), taxRate: null, amount: new Prisma.Decimal("24"), currency: "CNY", purchaseOrderId: "po-2", purchaseOrderItemId: "poi-2", logisticsBatchId: "batch-2", logisticsBatch: { batchNo: "B-2" }, outsourceReceipt: { id: "receipt-2" } };
  const prisma = {
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      outsourcePayableSource: { findFirst: async () => source, updateMany: async () => ({ count: 1 }) },
      supplierPayableEntry: {
        findUnique: async () => null,
        create: async ({ data }) => { captured = data; return { id: "entry-2", ...data }; },
      },
    }),
  };
  const service = new SupplierPayableService(prisma, { create: () => ({ createdBy: "user-1", updatedBy: "user-1" }), update: () => ({ updatedBy: "user-1" }), recordWithOrderNo: async () => {} }, cashFlowStub());
  await service.createFromSource({ source_type: "outsource_receipt", source_id: "osource-1" }, { id: "user-1" });
  assert.equal(captured.outsourceLogisticsBatchId, "batch-2");
  assert.equal(captured.purchaseOrderId, "po-2");
});

// ---------------------------------------------------------------------------
// 2026-09-20（用户要求）：「应付管理中，其他应付这种类型的，允许进行逻辑删除。因为有时候录错了」，
// 随后又补一句「包括删除确认应付和应付对账」。
//
// 五条边界都要钉住：① 只有其他应付能删（原料/外加工是到货事实的账，录错了要走冲销）；
// ② 草稿与**已确认（未付款）**都能删，已确认的必须在**同一个事务**里回冲那笔支出（钱要回到账上）；
// ③ 已被付款核销（部分付款/已付清）的不能删（核销记录会指向不存在的应付）；
// ④ 已被对账单覆盖时拒绝，并给出可执行的下一步（去「应付对账」删掉那张对账单）；
// ⑤ 原因必填、走软删除、写进备注并单独记一条审计。
// ---------------------------------------------------------------------------

/** 逻辑删除的替身：记录被写入的 data、审计事件与「回冲流水」的调用（含它拿到的是不是同一个事务）。 */
function removeOtherHarness({ entry, scopes = [], flows = [] } = {}) {
  const updates = [];
  const events = [];
  const reversals = [];
  const tx = {
    $queryRaw: async () => [],
    supplierPayableEntry: {
      findFirst: async () => entry,
      update: async ({ data }) => { updates.push(data); return { ...entry, ...data }; },
    },
    supplierPayableReconciliation: { findMany: async () => scopes },
  };
  const prisma = { supplierPayableEntry: { findFirst: async () => entry }, $transaction: async (fn) => fn(tx) };
  const audit = {
    softDelete: () => ({ deletedAt: new Date("2026-09-20T00:00:00.000Z"), deletedBy: "user-1", updatedBy: "user-1" }),
    update: () => ({ updatedBy: "user-1" }),
    record: async (action, entityType, actorId, entityId, details) => { events.push({ action, entityType, actorId, entityId, details }); },
  };
  const cashFlow = cashFlowStub({
    // 只有传进来的 client 是**那个事务**、且条目确实是已确认时，才回冲 ——
    // 替身必须能区分这两件事，否则「软删除提交了、回冲却失败」这类缺陷测不出来。
    reverseSourceFlowInTransaction: async (client, sourceType, sourceId, reason) => {
      reversals.push({ client, sourceType, sourceId, reason, sameTransaction: client === tx });
      return entry?.status === "confirmed" ? flows : [];
    },
  });
  return { service: new SupplierPayableService(prisma, audit, cashFlow), updates, events, reversals, tx };
}

const otherDraft = (extra = {}) => ({
  id: "entry-other", payableNo: "APO-1", sourceType: "other", status: "draft", supplierId: "supplier-1",
  currency: "CNY", orderNo: null, purchaseOrderId: null, confirmationDate: new Date("2026-09-10T00:00:00.000Z"),
  amount: new Prisma.Decimal("500"), remark: null, allocations: [], ...extra,
});

test("其他应付草稿可以逻辑删除：写删除原因、软删除并记一条审计", async () => {
  const { service, updates, events, reversals } = removeOtherHarness({ entry: otherDraft() });
  const row = await service.removeOther("entry-other", "金额录错，应是 50 不是 500", { id: "user-1" });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].deletedBy, "user-1");
  assert.ok(updates[0].deletedAt instanceof Date);
  assert.equal(updates[0].remark, "删除原因：金额录错，应是 50 不是 500");
  assert.equal(row.deletedBy, "user-1");
  assert.equal(reversals.length, 0, "草稿从没记过账，不该去回冲任何流水");
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "supplier_payable.delete_other");
  assert.equal(events[0].details.reason, "金额录错，应是 50 不是 500");
  assert.equal(events[0].details.amount, "500");
  assert.equal(events[0].details.status_when_deleted, "draft");
});

test("其他应付删除：原有备注被保留（删除原因追加在后面，不覆盖）", async () => {
  const { service, updates } = removeOtherHarness({ entry: otherDraft({ remark: "8 月水电" }) });
  await service.removeOther("entry-other", "重复录入", { id: "user-1" });
  assert.equal(updates[0].remark, "8 月水电\n删除原因：重复录入");
});

test("其他应付删除：原因必填，空原因不发请求", async () => {
  const { service, updates } = removeOtherHarness({ entry: otherDraft() });
  await assert.rejects(() => service.removeOther("entry-other", "   ", { id: "user-1" }), (error) => error.getResponse().code === "DELETION_REASON_REQUIRED");
  assert.equal(updates.length, 0);
});

test("其他应付删除：原料入库 / 外加工签收形成的应付不能删（那是到货事实的账）", async () => {
  for (const sourceType of ["raw_material_inbound", "outsource_receipt", "purchase_receipt"]) {
    const { service, updates } = removeOtherHarness({ entry: otherDraft({ sourceType }) });
    await assert.rejects(
      () => service.removeOther("entry-other", "录错了", { id: "user-1" }),
      (error) => error.getResponse().code === "SUPPLIER_PAYABLE_NOT_OTHER",
      sourceType,
    );
    assert.equal(updates.length, 0);
  }
});

// ---------------------------------------------------------------------------
// 2026-09-20（用户追问）：「包括删除确认应付」。
//
// 原来只放给草稿，理由是「已确认的已经记账」—— 但那正是她录错的那一条的来源：
// 导入 / 手工录的其他应付常常是先确认了才发现录错。既有的「回退草稿 → 再删除」也绕不过去，
// 因为回退会把条目退回草稿态（钱仍然挂着）。所以改成：**已确认（未付款）也能删，
// 删的时候在同一个事务里把那笔支出流水回冲掉**，钱回到账上。
// ---------------------------------------------------------------------------

test("其他应付删除：已确认（未付款）也能删，且**在同一个事务里**回冲那笔支出流水", async () => {
  const flows = [{ id: "cf-1", entryNo: "CF-20260920-1", amount: new Prisma.Decimal("500") }];
  const { service, updates, events, reversals, tx } = removeOtherHarness({ entry: otherDraft({ status: "confirmed" }), flows });
  const row = await service.removeOther("entry-other", "整张单子录错了，供应商也不对", { id: "user-1" });

  assert.equal(reversals.length, 1, "已确认的应付删掉时必须回冲它那句支出流水");
  assert.equal(reversals[0].sameTransaction, true, "回冲必须发生在**同一个事务**里：软删除提交了、回冲失败的话，这条应付已经从列表上消失，用户再也点不到它");
  assert.equal(reversals[0].sourceType, "supplier_payable_entry");
  assert.equal(reversals[0].sourceId, "entry-other");
  assert.ok(reversals[0].reason.includes("删除其他应付 APO-1"), "回冲原因要写明是因为删了哪条应付");

  assert.equal(updates.length, 1);
  assert.ok(updates[0].deletedAt instanceof Date);
  // 删除 ≠ 冲销：状态原样保留，只是软删除 —— 事后从「含已删除」的视角才看得出它是什么状态下被删的。
  assert.equal(updates[0].status, undefined, "不该改状态");
  assert.equal(row.status, "confirmed");
  assert.equal(events.length, 2, "一条冲销流水的审计 + 一条删除的审计");
  assert.equal(events[0].action, "cash_flow_entry.reverse");
  assert.equal(events[0].details.entry_no, "CF-20260920-1");
  assert.equal(events[0].details.because, "supplier_payable.delete_other");
  assert.equal(events[1].action, "supplier_payable.delete_other");
  assert.equal(events[1].details.status_when_deleted, "confirmed");
  assert.deepEqual(events[1].details.reversed_cash_flow_entry_nos, ["CF-20260920-1"]);
  assert.equal(tx.supplierPayableEntry !== undefined, true);
});

test("其他应付删除：已被付款核销（部分付款 / 已付清）的不能删 —— 核销记录会指向不存在的应付", async () => {
  for (const status of ["partially_paid", "paid"]) {
    const entry = otherDraft({ status, allocations: [{ status: "active", amount: new Prisma.Decimal("200"), payment: { status: "posted" } }] });
    const { service, updates, reversals } = removeOtherHarness({ entry });
    await assert.rejects(
      () => service.removeOther("entry-other", "录错了", { id: "user-1" }),
      (error) => error.getResponse().code === "SUPPLIER_PAYABLE_HAS_ALLOCATIONS",
      status,
    );
    assert.equal(updates.length, 0);
    assert.equal(reversals.length, 0, "被拦下时既不改数据也不回冲流水");
  }
  // 草稿付款（未过账）的核销不算「已经付出去的钱」：它不在余额里，也不挡删除。
  const draftAllocation = otherDraft({ allocations: [{ status: "active", amount: new Prisma.Decimal("200"), payment: { status: "draft" } }] });
  const { service, updates } = removeOtherHarness({ entry: draftAllocation });
  await service.removeOther("entry-other", "录错了", { id: "user-1" });
  assert.equal(updates.length, 1);
});

test("其他应付删除：已被对账单覆盖时拒绝，并在错误里点名是哪张对账单（下一步是去删那张对账单）", async () => {
  const scope = { id: "recon-1", reconciliationNo: "APREC-9", status: "matched", supplierId: "supplier-1", currency: "CNY", orderNo: null, purchaseOrderId: null, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") };
  const { service, updates } = removeOtherHarness({ entry: otherDraft(), scopes: [scope] });
  await assert.rejects(
    () => service.removeOther("entry-other", "录错了", { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYABLE_IN_RECONCILIATION"
      && error.getResponse().message.includes("APREC-9")
      && error.getResponse().message.includes("删除那张对账单"),
  );
  assert.equal(updates.length, 0, "被拦下时不写任何字段");
});

test("其他应付删除：供应商不存在这条时 404；别家的对账单不覆盖这条", async () => {
  const missing = removeOtherHarness({ entry: null });
  await assert.rejects(() => missing.service.removeOther("entry-x", "录错了", { id: "user-1" }), (error) => error.getResponse().code === "SUPPLIER_PAYABLE_NOT_FOUND");
  const otherSupplierScope = { id: "recon-2", reconciliationNo: "APREC-10", status: "matched", supplierId: "supplier-2", currency: "CNY", orderNo: null, purchaseOrderId: null, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") };
  const { service, updates } = removeOtherHarness({ entry: otherDraft(), scopes: [otherSupplierScope] });
  await service.removeOther("entry-other", "录错了", { id: "user-1" });
  assert.equal(updates.length, 1, "别家供应商的对账单不该挡住这条的删除");
});
