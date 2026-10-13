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
  // 2026-09-24 起「确认应付」= 挂账（借成本 / 贷应付账款），不再写收支流水：
  // cashFlowCalls 现在是反向护栏 —— 哪天有人把 recordConfirmation 加回确认路径，这些用例会立刻红。
  const cashFlowCalls = [];
  const accrualCalls = [];
  const prisma = {
    bank: { findFirst: async ({ where }) => (where.id === "bank-dead" ? null : { id: where.id, bankName: "农业银行", accountNumber: "5706" }) },
    supplierPayableEntry: { findFirst: async () => entry, update: async ({ data }) => ({ ...entry, ...data }) },
  };
  prisma.$transaction = async (fn) => fn({ $queryRaw: async () => [], supplierPayableEntry: prisma.supplierPayableEntry });
  const audit = { update: () => ({ updatedBy: "user-1" }), recordWithOrderNo: async () => {} };
  const cashFlow = cashFlowStub({ recordConfirmation: async (input) => { cashFlowCalls.push(input); return { id: "cf-1", created: true, amount: input.amount }; } });
  const vouchers = {
    createAccrual: async (input) => { accrualCalls.push(input); return { id: `voucher-${accrualCalls.length}`, replayed: false }; },
    accruedSourceIds: async () => new Set(),
  };
  return { service: new SupplierPayableService(prisma, audit, cashFlow, undefined, vouchers), cashFlowCalls, accrualCalls };
}

const draftPayable = (extra = {}) => ({
  id: "payable-1", payableNo: "AP-1", status: "draft", orderNo: "SO-1", supplierId: "supplier-1",
  amount: new Prisma.Decimal("500"), currency: "CNY", sourceType: "raw_material_inbound",
  supplier: { name: "晋江大田" }, payableSource: { status: "received" }, outsourcePayableSource: null, ...extra,
});

test("逐条确认应付：挂一张账（借成本 / 贷应付账款），不写收支流水、不动银行", async () => {
  const { service, cashFlowCalls, accrualCalls } = payableConfirmHarness(draftPayable());
  const result = await service.confirm("payable-1", { id: "user-1" }, { bank_id: "bank-1" });
  assert.deepEqual(cashFlowCalls, [], "确认那一刻钱还没付：写支出流水就等于「钱还没付先记了付款」");
  assert.equal(accrualCalls.length, 1);
  const input = accrualCalls[0];
  assert.equal(input.source_type, "supplier_payable");
  assert.equal(input.source_id, "payable-1");
  assert.equal(input.document_no, "AP-1");
  assert.equal(input.amount.toString(), "500");
  assert.equal(input.counterparty_name, "晋江大田", "对方名称取供应商名，不能退化成 UUID");
  assert.deepEqual(input.contra_subject_names, ["主营业务成本", "原材料"], "会计科目候选链按来源类型选定（借成本 / 贷应付账款）");
  assert.equal(result.accrual_voucher_id, "voucher-1");
  assert.equal(result.cash_flow_entry_id, null);
  assert.equal(result.bank_missing, false);
});

test("逐条确认应付：外加工来源归到「加工费」；没选银行也不再报 bank_missing", async () => {
  const outsource = payableConfirmHarness(draftPayable({ sourceType: "outsource_receipt", outsourcePayableSource: { status: "received" }, payableSource: null }));
  const result = await outsource.service.confirm("payable-1", { id: "user-1" });
  assert.deepEqual(outsource.accrualCalls[0].contra_subject_names, ["加工费"]);
  assert.equal(result.bank_missing, false, "挂账不动钱：银行在「登记付款」那一步才问");
});

test("逐条确认应付：银行非法时先拒绝，不确认任何应付", async () => {
  const { service, accrualCalls } = payableConfirmHarness(draftPayable());
  await assert.rejects(
    () => service.confirm("payable-1", { id: "user-1" }, { bank_id: "bank-dead" }),
    (error) => error.getResponse().code === "BANK_NOT_FOUND",
  );
  assert.deepEqual(accrualCalls, []);
});

// ---------------------------------------------------------------------------
// 2026-10-12：条目自己的科目优先于弹窗里临时选的那个（其他应付 = 备用金 / 房租 / 水电）。
//
// 为什么这条必须有守卫：备用金在财务那张科目表里是**资产类「库存现金（备用金）」**，
// 而其他应付的候选链首位是损益类「管理费用」—— 挂错了就是把资产记成一笔费用。
// 「一键确认应付」（对账单入口）本来就走 `entry.subjectId ?? result.subjectId`，
// 而「确认应付」页这两条入口（逐条 / 批量）原先**只看弹窗传的科目**，
// 于是同一笔备用金走两个入口会写出两种账。
// ---------------------------------------------------------------------------

test("逐条确认应付：条目自带科目时以条目为准（备用金不能被挂成管理费用）", async () => {
  const entry = draftPayable({ sourceType: "other", payableSource: null, subjectId: "subject-allowance", sourceNoSnapshot: "其他应付-备用金" });
  const { service, accrualCalls } = payableConfirmHarness(entry);

  // 财务在弹窗里没改科目（没传 subject_id）：必须落到条目自己的资产类科目，而不是候选链的管理费用
  await service.confirm("payable-1", { id: "user-1" }, {});
  assert.equal(accrualCalls[0].contra_subject_id, "subject-allowance");

  // 弹窗里临时改过（这里给另一个科目）时**条目仍然优先** —— 界面上的默认值就是条目科目，
  // 两者不一致只可能是调用方绕过了界面，此时以条目上留存的账务口径为准。
  await service.confirm("payable-1", { id: "user-1" }, { subject_id: "subject-typed-in-dialog" });
  assert.equal(accrualCalls[1].contra_subject_id, "subject-allowance", "条目 > 弹窗（与对账单路径同一优先级）");

  // 条目没填科目时，弹窗传的照旧生效（历史行为不变）
  const legacy = payableConfirmHarness(draftPayable());
  await legacy.service.confirm("payable-1", { id: "user-1" }, { subject_id: "subject-from-dialog" });
  assert.equal(legacy.accrualCalls[0].contra_subject_id, "subject-from-dialog");

  // 条目与弹窗都没有 → undefined，由 createAccrual 退回按来源类型的候选链
  const none = payableConfirmHarness(draftPayable({ sourceType: "other", payableSource: null }));
  await none.service.confirm("payable-1", { id: "user-1" }, {});
  assert.equal(none.accrualCalls[0].contra_subject_id, undefined);
  assert.deepEqual(none.accrualCalls[0].contra_subject_names, ["管理费用", "其他管理费用"]);
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
  const accrualCalls = [];
  const writes = [];
  /** findMany 的入参：`select.subjectId` 漏了的话「条目自带科目」这条路径永远读不到值。 */
  const findManyArgs = [];
  let locks = 0;
  const entryTable = {
    // 替身照做服务端的过滤条件（id 列表 + status = draft），才能断言「已确认的会被跳过」。
    findMany: async (args) => { findManyArgs.push(args); return rows.filter((row) => args.where.id.in.includes(row.id) && row.status === "draft"); },
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
  const vouchers = {
    createAccrual: async (input) => { accrualCalls.push(input); return { id: `voucher-${accrualCalls.length}`, replayed: false }; },
    accruedSourceIds: async () => new Set(),
  };
  return { service: new SupplierPayableService(prisma, audit, cashFlow, undefined, vouchers), cashFlowCalls, accrualCalls, writes, findManyArgs, locks: () => locks };
}

test("勾选批量确认：每条应付各挂一张账，并按币种给合计", async () => {
  const harness = batchHarness([batchDraft("p1"), batchDraft("p2", { amount: new Prisma.Decimal("250") }), batchDraft("p3", { status: "confirmed" })]);
  const result = await harness.service.batchConfirm(["p1", "p2", "p3"], { id: "user-1" }, { bank_id: "bank-1", subject_id: "subject-1" });
  assert.equal(result.confirmed_count, 2);
  assert.equal(result.skipped_count, 1, "已经被确认过的条目要跳过，不能重复挂账（挂两遍＝成本翻倍）");
  assert.deepEqual(harness.cashFlowCalls, [], "批量确认也不写流水：钱还没付");
  assert.equal(harness.accrualCalls.length, 2, "逐条挂账，才追得回是哪批料的应付");
  assert.deepEqual(harness.accrualCalls.map((call) => call.source_id), ["p1", "p2"]);
  assert.deepEqual(harness.accrualCalls.map((call) => call.amount.toString()), ["100", "250"]);
  assert.equal(harness.accrualCalls.every((call) => call.contra_subject_id === "subject-1"), true, "弹窗里选的科目是挂账的对方科目");
  assert.deepEqual(result.amounts, [{ currency: "CNY", amount: "350.0000" }]);
  assert.equal(result.bank_missing, false);
  assert.deepEqual(result.accrual_voucher_ids, ["voucher-1", "voucher-2"]);
});

test("勾选批量确认：条目自带科目时**逐条**按各自的科目挂账，弹窗那个只是没填时的兜底", async () => {
  // 一批里混着备用金（资产类）与房租（成本类）：取一条的值当整批的默认值就会把两者挂到同一个科目上。
  const harness = batchHarness([
    batchDraft("p1", { sourceType: "other", payableSource: null, subjectId: "subject-allowance" }),
    batchDraft("p2", { sourceType: "other", payableSource: null, subjectId: "subject-rent" }),
  ]);
  await harness.service.batchConfirm(["p1", "p2"], { id: "user-1" }, { subject_id: "subject-typed-in-dialog" });
  assert.deepEqual(
    harness.accrualCalls.map((call) => call.contra_subject_id),
    ["subject-allowance", "subject-rent"],
    "每条按自己的科目挂账（弹窗那个被条目盖住）",
  );

  // 条目没填时才落到弹窗/候选链（历史行为）
  const legacy = batchHarness([batchDraft("p1", { sourceType: "other", payableSource: null }), batchDraft("p2")]);
  await legacy.service.batchConfirm(["p1", "p2"], { id: "user-1" }, { subject_id: "subject-from-dialog" });
  assert.deepEqual(legacy.accrualCalls.map((call) => call.contra_subject_id), ["subject-from-dialog", "subject-from-dialog"]);
  // 而且取数时**必须把 subjectId 查出来**：select 里漏了这一列，条目科目永远是 undefined
  // （这条正是本轮修掉的缺陷：批量确认原先的 select 没有 subjectId）。
  assert.equal(legacy.findManyArgs[0].select.subjectId, true);
});

test("勾选批量确认：来源已作废的条目不确认，但也不让整批失败", async () => {  const harness = batchHarness([batchDraft("p1"), batchDraft("p2", { payableSource: { status: "voided" } })]);
  const result = await harness.service.batchConfirm(["p1", "p2"], { id: "user-1" }, {});
  assert.equal(result.confirmed_count, 1);
  assert.equal(result.skipped_count, 1);
  assert.deepEqual(harness.accrualCalls.map((call) => call.source_id), ["p1"]);
  assert.deepEqual(harness.writes[0].ids, ["p1"], "作废来源那条不能被写成已确认");
});

test("勾选批量确认：勾的全是不可确认的条目时拒绝，一张账都不挂", async () => {
  const harness = batchHarness([batchDraft("p1", { status: "confirmed" })]);
  await assert.rejects(
    () => harness.service.batchConfirm(["p1"], { id: "user-1" }),
    (error) => error.getResponse().code === "NO_DRAFT_PAYABLES",
  );
  assert.deepEqual(harness.cashFlowCalls, []);
  assert.deepEqual(harness.accrualCalls, []);
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
  assert.deepEqual(harness.accrualCalls, []);
  assert.deepEqual(harness.writes, []);
});

test("勾选批量确认：合计按币种分组，不跨币种相加", async () => {
  const harness = batchHarness([batchDraft("p1"), batchDraft("p2", { currency: "USD", amount: new Prisma.Decimal("20") })]);
  const result = await harness.service.batchConfirm(["p1", "p2"], { id: "user-1" }, {});
  assert.deepEqual(result.amounts, [{ currency: "CNY", amount: "100.0000" }, { currency: "USD", amount: "20.0000" }]);
  assert.equal(result.bank_missing, false, "挂账不动现金：这里不再有「没选银行」的警告");
});

test("勾选批量确认：会计科目候选链按每条自己的来源类型选定", async () => {
  const harness = batchHarness([batchDraft("p1"), batchDraft("p2", { sourceType: "outsource_receipt", payableSource: null, outsourcePayableSource: { status: "received" } })]);
  await harness.service.batchConfirm(["p1", "p2"], { id: "user-1" }, {});
  assert.deepEqual(harness.accrualCalls.map((call) => call.contra_subject_names), [["主营业务成本", "原材料"], ["加工费"]]);
});

test("勾选批量确认：状态被别的入口改动时整批拒绝，不出现「界面说确认了、库里没确认」", async () => {
  const harness = batchHarness([batchDraft("p1")], { updateCount: 0 });
  await assert.rejects(
    () => harness.service.batchConfirm(["p1"], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYABLE_CONFIRM_CONFLICT",
  );
  assert.deepEqual(harness.accrualCalls, [], "没写成状态就绝不能挂账");
});

// ---------------------------------------------------------------------------
// 2026-09-16（用户要求）：「确认应付里如果是已付款的条目就不要出现了」+
//   「支持按已付未付、按时间范围筛选」。过滤在映射之后做（关键字要匹配物料名/供应商名/来源批次号，
//   这些都是映射阶段才从关联里摊平出来的），所以这里断言的是最终列表。
//
// 2026-10-08（用户拍板）：确认改成两步挂账后，口径反转 —— 确认那一笔钱还没付出去
//   （supplier-payable.service.ts:200-227），所以 confirmed 属于**未付**；只有 paid（付清）才是已付。
// ---------------------------------------------------------------------------

test("应付台账按付款情况筛选：未付含草稿 + 已确认（挂账未付）+ 部分付款，已付只含付清", async () => {
  const base = { amount: new Prisma.Decimal("100"), allocations: [], payableSource: null, outsourcePayableSource: null, supplier: null, orderNo: "SO-1", currency: "CNY", purchaseOrderId: null };
  const rows = [
    { ...base, id: "p-draft", payableNo: "AP-001", status: "draft", supplierId: "s-1", confirmationDate: new Date("2026-09-10T00:00:00.000Z") },
    { ...base, id: "p-confirmed", payableNo: "AP-002", status: "confirmed", supplierId: "s-1", confirmationDate: new Date("2026-09-11T00:00:00.000Z") },
    { ...base, id: "p-partial", payableNo: "AP-004", status: "partially_paid", supplierId: "s-1", confirmationDate: new Date("2026-09-12T00:00:00.000Z") },
    { ...base, id: "p-paid", payableNo: "AP-005", status: "paid", supplierId: "s-1", confirmationDate: new Date("2026-09-13T00:00:00.000Z") },
    { ...base, id: "p-reversed", payableNo: "AP-003", status: "reversed", supplierId: "s-1", confirmationDate: new Date("2026-09-14T00:00:00.000Z") },
  ];
  const prisma = { supplierPayableEntry: { findMany: async () => rows }, supplierPayableReconciliation: { findMany: async () => [] } };
  const service = new SupplierPayableService(prisma, {}, cashFlowStub());
  const ids = (filter) => service.list(undefined, undefined, undefined, filter).then((result) => result.map((row) => row.id));

  // 确认只挂账、钱没动，所以它在未付里；付清了才进已付
  assert.deepEqual(await ids({ payment: "unpaid" }), ["p-draft", "p-confirmed", "p-partial"]);
  assert.deepEqual(await ids({ payment: "paid" }), ["p-paid"]);
  assert.deepEqual(await ids({ payment: "all" }), ["p-draft", "p-confirmed", "p-partial", "p-paid", "p-reversed"], "全部包含已冲销的");
  assert.deepEqual(await ids({}), ["p-draft", "p-confirmed", "p-partial", "p-paid", "p-reversed"], "不传筛选时保持原行为（不静默丢行）");
  // 冲销的行两边都不算：只在「全部」里出现
  const unpaid = await ids({ payment: "unpaid" });
  const paid = await ids({ payment: "paid" });
  assert.equal(unpaid.includes("p-reversed"), false);
  assert.equal(paid.includes("p-reversed"), false);
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

test("应付台账的「会计科目」列：条目手选 > 对账单填的 > 按来源候选链（与记账口径同一优先级）", async () => {
  const base = {
    amount: new Prisma.Decimal("100"), allocations: [], payableSource: null, outsourcePayableSource: null,
    supplier: null, status: "draft", currency: "CNY", purchaseOrderId: null, confirmationDate: new Date("2026-09-10T00:00:00.000Z"),
  };
  const rows = [
    // ① 条目自己填过（其他应付 = 备用金）：显示条目的资产类科目
    { ...base, id: "p-own", payableNo: "AP-001", supplierId: "s-1", orderNo: null, sourceType: "other", subjectId: "subj-allowance", subject: { category: "资产类", name: "库存现金（备用金）" } },
    // ② 条目没填，但覆盖它的对账单填了：显示对账单那个（确认应付走对账单入口时真正写进凭证的就是它）
    { ...base, id: "p-covered", payableNo: "AP-002", supplierId: "s-1", orderNo: "SO-7", sourceType: "raw_material_inbound", subjectId: null, subject: null },
    // ③ 两处都没有：显示按来源类型的候选链首位（财务要知道「点确认会挂到哪」）
    { ...base, id: "p-chain", payableNo: "AP-003", supplierId: "s-1", orderNo: null, sourceType: "outsource_receipt", subjectId: null, subject: null },
  ];
  const reconciliations = [{
    id: "rec-1", reconciliationNo: "APREC-001", status: "matched", supplierId: "s-1", currency: "CNY",
    orderNo: "SO-7", purchaseOrderId: null, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z"),
    subjectId: "subj-rent",
  }];
  const prisma = {
    supplierPayableEntry: { findMany: async () => rows },
    supplierPayableReconciliation: { findMany: async () => reconciliations },
    accountingSubject: { findMany: async ({ where }) => where.id.in.includes("subj-rent") ? [{ id: "subj-rent", category: "成本类", name: "房租费" }] : [] },
  };
  const service = new SupplierPayableService(prisma, {}, cashFlowStub());
  const byId = new Map((await service.list()).map((row) => [row.id, row]));

  assert.equal(byId.get("p-own").subject_name, "资产类 / 库存现金（备用金）");
  assert.equal(byId.get("p-covered").subject_name, "成本类 / 房租费", "对账单上填的科目也要显示（否则台账与凭证会各说各话）");
  assert.equal(byId.get("p-chain").subject_name, "成本类 / 加工费", "两处都没填时给候选链首位，别让财务面对空格子");
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

// ---------------------------------------------------------------------------
// 批量删除其他应付（2026-10-13，用户：「确认应付，加一个搜索框，加一个批量删除
// （只支持其他应付的删除）」）。
//
// 与逐条删除共用同一个 `removeOther()`（判据只有一份），差别只在**结果形状**：
// 逐条返回，能删的删、不能删的点名 —— 一批里夹着一条已对账的是常态，整批回滚会让她
// 先把那条摘出去再重来一遍。
// ---------------------------------------------------------------------------

/** 批量删除的替身：多条条目、逐条事务、可看到写入了哪些。 */
function batchRemoveHarness({ entries = [] } = {}) {
  const byId = new Map(entries.map((row) => [row.id, row]));
  const updates = [];
  const events = [];
  const tx = {
    $queryRaw: async () => [],
    supplierPayableEntry: {
      findFirst: async ({ where }) => byId.get(where.id) ?? null,
      update: async ({ where, data }) => { updates.push({ id: where.id, data }); return { ...byId.get(where.id), ...data }; },
    },
    supplierPayableReconciliation: { findMany: async () => [] },
  };
  const prisma = {
    // 批量删除会先把单号查出来：失败的条目没有行可返回，而界面上必须点名。
    supplierPayableEntry: { findMany: async ({ where }) => where.id.in.filter((id) => byId.has(id)).map((id) => ({ id, payableNo: byId.get(id).payableNo })) },
    $transaction: async (fn) => fn(tx),
  };
  const audit = {
    softDelete: () => ({ deletedAt: new Date("2026-10-13T00:00:00.000Z"), deletedBy: "user-1", updatedBy: "user-1" }),
    update: () => ({ updatedBy: "user-1" }),
    record: async (action, entityType, actorId, entityId, details) => { events.push({ action, entityType, actorId, entityId, details }); },
  };
  return { service: new SupplierPayableService(prisma, audit, cashFlowStub({ reverseSourceFlowInTransaction: async () => [] })), updates, events };
}

test("批量删除：能删的删、不能删的**点名**（原料入库形成的应付走冲销，不是删除）", async () => {
  const { service, updates, events } = batchRemoveHarness({ entries: [
    otherDraft({ id: "entry-a", payableNo: "APO-A" }),
    otherDraft({ id: "entry-b", payableNo: "APO-B", status: "confirmed" }),
    otherDraft({ id: "entry-c", payableNo: "APO-C", sourceType: "raw_material_inbound" }),
  ] });

  const result = await service.batchRemoveOther(["entry-a", "entry-b", "entry-c"], "整批录错，供应商也不对", { id: "user-1" });

  assert.deepEqual(result.deleted.map((row) => row.payable_no), ["APO-A", "APO-B"]);
  assert.equal(result.deleted_count, 2);
  assert.equal(result.failed_count, 1);
  assert.equal(result.failed[0].payable_no, "APO-C", "失败的那条也要点名（只给 UUID 等于没说）");
  assert.equal(result.failed[0].code, "SUPPLIER_PAYABLE_NOT_OTHER");
  assert.match(result.failed[0].message, /只有「其他应付」可以删除/);
  assert.equal(result.deleted[1].was_confirmed, true, "已确认的那条要标出来（它同时回冲了支出流水）");
  assert.equal(result.deleted[0].was_confirmed, false);
  assert.equal(updates.length, 2, "被拒的那条一个字都没写");
  assert.equal(events.filter((event) => event.action === "supplier_payable.delete_other").length, 2, "每条成功的删除各留一条审计");
});

test("批量删除：原因必填（与逐条删除同一条边界），一条都不删", async () => {
  const { service, updates } = batchRemoveHarness({ entries: [otherDraft({ id: "entry-a" })] });
  await assert.rejects(
    () => service.batchRemoveOther(["entry-a"], "   ", { id: "user-1" }),
    (error) => error.getResponse().code === "DELETION_REASON_REQUIRED" && /原因/.test(error.getResponse().message),
  );
  assert.equal(updates.length, 0);
});

test("批量删除：空勾选与超上限各自报错（超上限逐条事务会锁表）", async () => {
  const { service } = batchRemoveHarness({ entries: [] });
  await assert.rejects(() => service.batchRemoveOther([], "录错了", { id: "user-1" }), (error) => error.getResponse().code === "PAYABLE_BATCH_DELETE_EMPTY");
  const tooMany = Array.from({ length: 201 }, (_, index) => `entry-${index}`);
  await assert.rejects(
    () => service.batchRemoveOther(tooMany, "录错了", { id: "user-1" }),
    (error) => error.getResponse().code === "PAYABLE_BATCH_DELETE_TOO_MANY" && /200/.test(error.getResponse().message),
  );
});

test("批量删除：同一个 id 传两次只删一次（去重后再逐条走）", async () => {
  const { service, updates } = batchRemoveHarness({ entries: [otherDraft({ id: "entry-a" })] });
  const result = await service.batchRemoveOther(["entry-a", "entry-a"], "重复录入", { id: "user-1" });
  assert.equal(result.deleted_count, 1);
  assert.equal(result.failed_count, 0);
  assert.equal(updates.length, 1);
});

test("批量删除：已纳入对账单的那些被拒时把单号与原因一起回报（前端照原样点名）", async () => {
  const scope = { id: "recon-1", reconciliationNo: "APREC-9", status: "matched", supplierId: "supplier-1", currency: "CNY", orderNo: null, purchaseOrderId: null, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-09-30T00:00:00.000Z") };
  const { service } = batchRemoveHarness({ entries: [otherDraft({ id: "entry-a", payableNo: "APO-A" })] });
  // 覆盖判定与单条删除共用 `coveringPayableReconciliation`：这里让对账单的范围命中它。
  service["prisma"].$transaction = async (fn) => fn({
    $queryRaw: async () => [],
    supplierPayableEntry: { findFirst: async () => otherDraft({ id: "entry-a", payableNo: "APO-A" }), update: async () => otherDraft({ id: "entry-a" }) },
    supplierPayableReconciliation: { findMany: async () => [scope] },
  });

  const result = await service.batchRemoveOther(["entry-a"], "录错了", { id: "user-1" });

  assert.equal(result.deleted_count, 0);
  assert.equal(result.failed_count, 1);
  assert.equal(result.failed[0].payable_no, "APO-A");
  assert.equal(result.failed[0].code, "SUPPLIER_PAYABLE_IN_RECONCILIATION");
  assert.match(result.failed[0].message, /APREC-9/);
});
