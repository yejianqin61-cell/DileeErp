const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { SupplierPaymentService } = require("../../dist/modules/finance/supplier-payment.service.js");
// 应付侧的真实现：合并付款要断言「部分核销 → partially_paid、结清 → paid」，而状态口径只有一处
// （`SupplierPayableService.refreshStatus`），测试里不重抄一遍。
const { SupplierPayableService } = require("../../dist/modules/finance/supplier-payable.service.js");

test("supplier payment draft update locks and rechecks current status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "payment-1", status: "posted", amount: "10", paymentDate: new Date(), paymentMethod: "bank", remark: null };
  const prisma = {
    supplierPayment: {
      findFirst: async () => row,
      update: async () => { updateCount += 1; return row; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayment: prisma.supplierPayment,
    }),
  };
  const audit = { update: () => ({}) };
  const service = new SupplierPaymentService(prisma, audit, {});
  await assert.rejects(
    () => service.updateDraft("payment-1", { amount: "12" }, { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYMENT_NOT_EDITABLE",
  );
  assert.equal(lockCount, 1);
  assert.equal(updateCount, 0);
});

test("supplier payment reversal locks and rechecks the payment", async () => {
  let lockCount = 0;
  const row = { id: "payment-1", status: "reversed", remark: null, allocations: [] };
  const prisma = {
    supplierPayment: { findFirst: async () => row, update: async () => row },
    supplierPaymentAllocation: { updateMany: async () => {} },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { lockCount += 1; return []; },
      supplierPayment: prisma.supplierPayment,
      supplierPaymentAllocation: prisma.supplierPaymentAllocation,
    }),
  };
  const audit = { update: () => ({}), record: async () => {} };
  const service = new SupplierPaymentService(prisma, audit, { refreshStatus: async () => {} });
  await assert.rejects(
    () => service.reverse("payment-1", "撤销原因", { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYMENT_NOT_REVERSIBLE",
  );
  assert.equal(lockCount, 1);
});

test("supplier payment posting locks the payment before allocation checks", async () => {
  const calls = [];
  const current = { id: "payment-1", status: "posted", amount: "10", currency: "CNY" };
  const prisma = {
    supplierPayment: { findFirst: async () => current },
    $transaction: async (fn) => fn({
      $queryRaw: async () => { calls.push("lock"); },
      supplierPayment: { findFirst: async () => current },
    }),
  };
  const service = new SupplierPaymentService(prisma, {}, {});
  await assert.rejects(() => service.post(current.id, [{ payable_entry_id: "entry-1", amount: "10" }], { id: "user-1" }), (error) => error.getResponse().code === "SUPPLIER_PAYMENT_NOT_POSTABLE");
  assert.deepEqual(calls, ["lock"]);
});

// 2026-09-15：付款建单补齐与收款侧同样的幂等键 + 重复草稿守卫
// （这一族建单接口此前是全局唯一没有幂等保护的，见 20260915120000 迁移）。
const paymentInput = (extra = {}) => ({ supplier_id: "supplier-1", order_no: "SO-1", payment_date: "2026-09-15", amount: "300", currency: "USD", payment_method: "bank_transfer", ...extra });
/** CashFlowService 替身：建单只用到 `requireSubject`（校验会计科目）。返回 null = 不指定科目。 */
const cashFlowStub = (extra = {}) => ({ requireSubject: async () => null, ...extra });
const createDeps = (prisma) => new SupplierPaymentService(prisma, { create: () => ({}), record: async () => {} }, {}, cashFlowStub());

// 2026-09-15：过账后必须真的把支出写进收支流水。
// 历史缺陷：写死的收支项目 key「外加工费」在字典里不存在（字典里是「外加工费 晋江大田工资」），
// CashFlowService 当时遇到缺项直接 return null，于是**每一笔供应商付款都被静默丢掉**。
// 2026-09-17 起候选链给的是会计科目**名称**，缺项仍然显式 422（见 cash-flow-autocreate 测试）。
function postFixture({ sourceType = "raw_material_inbound", supplierName = "晋江大田", bank = { bankName: "农业银行", accountNumber: "5706" }, bankId = "bank-1", subjectId = null, accrued = [], entries = null, coverages = [] } = {}) {
  const cashFlowCalls = [];
  const payment = { id: "payment-1", paymentNo: "SPAY-1", status: "posted", orderNo: "SO-1", amount: new Prisma.Decimal("300"), currency: "CNY", paymentDate: new Date("2026-09-15T00:00:00.000Z"), paymentMethod: "转账", payeeName: null, supplierId: "supplier-1", bankId, subjectId, remark: null };
  const prisma = {
    supplierPayment: { findFirst: async () => ({ ...payment, status: "draft" }) },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      supplierPayment: { findFirst: async () => ({ ...payment, status: "draft", supplier: { name: supplierName }, bank }), update: async () => payment },
      supplierPaymentAllocation: { create: async ({ data }) => ({ id: "alloc-1", ...data }) },
      // 「收支类目」（2026-10-13）：付款过账会去查覆盖本次核销应付的对账单；默认空表。
      supplierPayableReconciliation: { findMany: async () => coverages },
    }),
  };
  const payable = { allocationBalance: async (id) => ({ entry: entries?.get(id) ?? { id: "entry-1", supplierId: "supplier-1", currency: "CNY", orderNo: "SO-1", status: "confirmed", sourceType }, available: new Prisma.Decimal("1000") }), refreshStatus: async () => {} };
  const cashFlow = { autoCreateFromPayment: async (input) => { cashFlowCalls.push(input); return { id: "cf-1" }; }, autoReverseFromPayment: async () => null };
  // 销账科目取决于「这批应付有没有先挂过账」：`accrued` 给出已挂账的 entry id（默认空 = 历史数据，走老口径）。
  const vouchers = { accruedSourceIds: async () => new Set(accrued) };
  const service = new SupplierPaymentService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} }, payable, cashFlow, undefined, vouchers);
  return { service, cashFlowCalls };
}

test("供应商付款过账后自动写收支流水：科目按应付来源选定，且不再用科目表里不存在的名称", async () => {
  const { service, cashFlowCalls } = postFixture();
  await service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.equal(cashFlowCalls.length, 1);
  const input = cashFlowCalls[0];
  assert.deepEqual(input.subjectNames, ["主营业务成本", "原材料"], "原料入库来源 → 主营业务成本（科目名称候选链，第一个存在的生效）");
  assert.equal(input.direction, "expense");
  assert.equal(input.counterpartyName, "晋江大田", "对方名称取供应商名，不能退化成 UUID");
  assert.equal(input.settlementMethod, "转账--农业银行5706", "结算方式按老表格式带出银行账户");
  assert.deepEqual(input.settlementAccountHint, { bankName: "农业银行", accountNumber: "5706" }, "银行信息一并带给收支流水，用于匹配结算账户字典");
  // 2026-09-16：bankId 是银行余额的唯一依据 —— 单据上选了银行就必须落到流水上。
  assert.equal(input.bankId, "bank-1", "支付银行要写进流水的 bankId，否则这笔钱不动任何银行账户余额");
  assert.equal(input.sourceType, "supplier_payment");
  assert.equal(input.sourceId, "payment-1");
});

test("供应商付款过账：过账时选的科目优先，其次用建单时存在付款单上的科目", async () => {
  const fromDraft = postFixture({ subjectId: "subject-from-draft" });
  await fromDraft.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.equal(fromDraft.cashFlowCalls[0].subjectId, "subject-from-draft", "建单时填在付款单上的科目不能丢");
  const atPost = postFixture({ subjectId: "subject-from-draft" });
  await atPost.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" }, "subject-at-post");
  assert.equal(atPost.cashFlowCalls[0].subjectId, "subject-at-post", "过账时临时选的科目优先");
});

test("供应商付款过账：外加工与其他应付各自映射到对应会计科目", async () => {
  const outsource = postFixture({ sourceType: "outsource_receipt" });
  await outsource.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.deepEqual(outsource.cashFlowCalls[0].subjectNames, ["加工费"]);
  const other = postFixture({ sourceType: "other" });
  await other.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.deepEqual(other.cashFlowCalls[0].subjectNames, ["管理费用", "其他管理费用"]);
});

test("供应商付款过账：挂过账的应付销账借「应付账款」（成本在挂账时已记过），历史数据仍借成本", async () => {
  // 2026-09-24 两步口径：确认应付 = 挂账（借成本 / 贷应付账款），付款 = 销账（借应付账款 / 贷银行存款）。
  // 这条应付挂过账 → 借方必须是应付账款，再借一次成本就是成本翻倍。
  const settled = postFixture({ accrued: ["entry-1"] });
  await settled.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.deepEqual(settled.cashFlowCalls[0].subjectNames, ["应付账款"], "挂过账 → 借应付账款");

  // 没挂过账（当年「确认即记账」的历史单据）：仍按老口径借成本/存货，历史不动。
  const legacy = postFixture({ accrued: [] });
  await legacy.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.deepEqual(legacy.cashFlowCalls[0].subjectNames, ["主营业务成本", "原材料"], "没挂过账 → 老口径");
});

/* ------------------------------------------- 收支类目（2026-10-13，用户要的「这笔钱算什么」） */

/** 一条被核销的应付（`settled` 里带上它自己的科目）。 */
const settledEntry = (overrides = {}) => ({ id: "entry-1", supplierId: "supplier-1", currency: "CNY", orderNo: "SO-1", status: "confirmed", sourceType: "other", subjectId: null, purchaseOrderId: null, confirmationDate: new Date("2026-10-01T00:00:00.000Z"), ...overrides });

test("收支类目：其他应付条目自己填的科目带进流水（备用金不会被写成「管理费用」）", async () => {
  const fixture = postFixture({
    sourceType: "other",
    entries: new Map([["entry-1", settledEntry({ subjectId: "subject-备用金" })]]),
  });

  await fixture.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });

  const input = fixture.cashFlowCalls[0];
  assert.equal(input.categorySubjectId, "subject-备用金", "单据上填过的科目优先");
  // 主科目仍是「按来源的候选链 / 应付账款」——它要被拿去生成凭证，不能拿类目顶替。
  // 这一批没挂过账（历史数据）→ 主科目是「其他应付」的候选链，而类目把**到底是哪一笔**说清楚。
  assert.deepEqual(input.categorySubjectNames, ["管理费用", "其他管理费用"], "单据上没填时才用候选链兜底");
  assert.deepEqual(input.subjectNames, ["管理费用", "其他管理费用"], "主科目不受影响（本批未挂账）");
});

test("收支类目：条目没填科目时取**覆盖它的对账单**科目（与应付台账的显示链逐字对齐）", async () => {
  const coverage = { id: "recon-1", reconciliationNo: "APR-1", status: "resolved", supplierId: "supplier-1", currency: "CNY", orderNo: null, purchaseOrderId: null, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-10-31T00:00:00.000Z"), subjectId: "subject-房租费" };
  const fixture = postFixture({ sourceType: "other", entries: new Map([["entry-1", settledEntry()]]), coverages: [coverage] });

  await fixture.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });

  assert.equal(fixture.cashFlowCalls[0].categorySubjectId, "subject-房租费");
});

test("收支类目：一笔付款核销多条时取**金额最大**的那条条目的科目", async () => {
  const fixture = postFixture({
    sourceType: "other",
    entries: new Map([
      ["entry-1", settledEntry({ id: "entry-1", subjectId: "subject-备用金" })],
      ["entry-2", settledEntry({ id: "entry-2", subjectId: "subject-房租费" })],
    ]),
  });
  // allocationBalance 的替身按 id 返回对应的条目：`payable` 用 entries.get(id)。
  await fixture.service.post("payment-1", [
    { payable_entry_id: "entry-1", amount: "100" },
    { payable_entry_id: "entry-2", amount: "200" },
  ], { id: "user-1" });

  assert.equal(fixture.cashFlowCalls[0].categorySubjectId, "subject-房租费", "200 > 100 → 房租费");
});

test("收支类目：都没填科目时留空，让候选链兜底（不在这里瞎猜）", async () => {
  const fixture = postFixture({ sourceType: "raw_material_inbound", entries: new Map([["entry-1", settledEntry({ sourceType: "raw_material_inbound" })]]) });

  await fixture.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });

  assert.equal(fixture.cashFlowCalls[0].categorySubjectId, null, "采购应付没有条目科目 → 交给 categorySubjectNames（原材料/主营业务成本）");
  assert.deepEqual(fixture.cashFlowCalls[0].categorySubjectNames, ["主营业务成本", "原材料"]);
});

/**
 * 2026-10-16（用户报障）：「该笔应付选择的是备用金付款，该笔凭证的会计科目没法正常显示」。
 *
 * 备用金这类其他应付的会计科目是「资产类 / 库存现金（备用金）」—— 资金科目，**不是欠款**，
 * 所以确认时不挂账（见 `voucher.service.ts` 的 `createAccrual`）。于是「借方写谁」只能从条目自己身上取：
 * 取条目科目 → 凭证 = 借 库存现金（备用金）/ 贷 银行存款；不取的话会被写成「借 管理费用」，
 * 那正是「会计科目没法正常显示」。
 */
test("未挂账的付款：借方取**条目自己**的科目（备用金取现不会被写成管理费用）", async () => {
  const transfer = postFixture({ sourceType: "other", entries: new Map([["entry-1", settledEntry({ subjectId: "subject-备用金" })]]) });
  await transfer.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.equal(transfer.cashFlowCalls[0].subjectId, "subject-备用金", "借方 = 条目自己的科目 → 借 库存现金（备用金）");
  assert.deepEqual(transfer.cashFlowCalls[0].subjectNames, ["管理费用", "其他管理费用"], "候选链仍然带上（条目没科目或科目已停用时兜底）");
  assert.equal(transfer.cashFlowCalls[0].categorySubjectId, "subject-备用金", "收支类目与借方同源");

  // 反向守卫①：**已挂账**的付款借方只能是应付账款 —— 取条目科目会让成本记两遍、应付账款永远挂在那儿。
  const accruedFixture = postFixture({ sourceType: "other", entries: new Map([["entry-1", settledEntry({ subjectId: "subject-备用金" })]]), accrued: ["entry-1"] });
  await accruedFixture.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.equal(accruedFixture.cashFlowCalls[0].subjectId, null, "已挂账 → 交给候选链（应付账款）");
  assert.deepEqual(accruedFixture.cashFlowCalls[0].subjectNames, ["应付账款"]);
  assert.equal(accruedFixture.cashFlowCalls[0].categorySubjectId, "subject-备用金", "人工/单据选的科目仍然进「收支类目」，只是不参与记账");

  // 反向守卫②：人工在付款单上选的科目优先于条目自己的科目。
  const picked = postFixture({ sourceType: "other", entries: new Map([["entry-1", settledEntry({ subjectId: "subject-备用金" })]]), subjectId: "subject-picked" });
  await picked.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.equal(picked.cashFlowCalls[0].subjectId, "subject-picked");

  // 反向守卫③：条目没填科目（历史数据）→ 仍是老口径的候选链，行为不变。
  const legacy = postFixture({ sourceType: "other" });
  await legacy.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.equal(legacy.cashFlowCalls[0].subjectId, null);
  assert.deepEqual(legacy.cashFlowCalls[0].subjectNames, ["管理费用", "其他管理费用"]);
});

test("供应商付款冲销时回冲收支流水（钱没付出去，流水里不能留着）", async () => {  const reversed = [];
  const payment = { id: "payment-1", paymentNo: "SPAY-1", status: "posted", orderNo: "SO-1", remark: null, amount: new Prisma.Decimal("300"), allocations: [] };
  const prisma = {
    supplierPayment: { findFirst: async () => payment, update: async () => payment },
    supplierPaymentAllocation: { updateMany: async () => {} },
    $transaction: async (fn) => fn({ $queryRaw: async () => [], supplierPayment: prisma.supplierPayment, supplierPaymentAllocation: prisma.supplierPaymentAllocation }),
  };
  const service = new SupplierPaymentService(prisma, { update: () => ({}), record: async () => {} }, { refreshStatus: async () => {} }, { autoReverseFromPayment: async (...args) => { reversed.push(args); return null; } });
  await service.reverse("payment-1", "银行退回", { id: "user-1" });
  assert.equal(reversed.length, 1);
  assert.deepEqual(reversed[0].slice(0, 2), ["supplier_payment", "payment-1"]);
  assert.match(reversed[0][2], /银行退回/);
});

test("付款建单：同一幂等键重放返回原单，不再新建", async () => {
  let createCount = 0;
  const existing = { id: "payment-1", paymentNo: "SPAY-1", status: "draft" };
  const prisma = {
    supplier: { findFirst: async () => ({ id: "supplier-1" }) },
    supplierPayment: {
      findFirst: async ({ where }) => (where.idempotencyKey ? existing : null),
      create: async () => { createCount += 1; return existing; },
    },
  };
  const row = await createDeps(prisma).create(paymentInput({ idempotency_key: "key-1" }), { id: "user-1" });
  assert.equal(row, existing);
  assert.equal(createCount, 0);
});

test("付款建单：同供应商/订单/金额/币种的现存草稿会被拦下", async () => {
  let createCount = 0;
  const duplicate = { id: "payment-9", paymentNo: "SPAY-20260915-DUP", status: "draft" };
  const prisma = {
    supplier: { findFirst: async () => ({ id: "supplier-1" }) },
    supplierPayment: {
      findFirst: async ({ where }) => (where.idempotencyKey ? null : duplicate),
      create: async () => { createCount += 1; return duplicate; },
    },
  };
  await assert.rejects(
    () => createDeps(prisma).create(paymentInput(), { id: "user-1" }),
    (error) => error.getResponse().code === "SUPPLIER_PAYMENT_DRAFT_EXISTS" && error.getResponse().message.includes("SPAY-20260915-DUP"),
  );
  assert.equal(createCount, 0);
});

test("付款建单：没有重复时正常建单，并把幂等键写入记录", async () => {
  let created = null;
  const prisma = {
    supplier: { findFirst: async () => ({ id: "supplier-1" }) },
    supplierPayment: {
      findFirst: async () => null,
      create: async ({ data }) => { created = data; return { id: "payment-2", ...data }; },
    },
  };
  const row = await createDeps(prisma).create(paymentInput({ idempotency_key: "key-2" }), { id: "user-1" });
  assert.equal(created.idempotencyKey, "key-2");
  assert.equal(created.supplierId, "supplier-1");
  assert.equal(String(row.paymentNo).startsWith("SPAY-"), true);
});

// 2026-09-15：「应付管理都要支持选择币种、编辑币种」，且银行只能来自银行账户池（停用的不能选）。
test("付款建单：支付银行必须存在于银行账户池（停用/已删除 → BANK_NOT_FOUND）", async () => {
  let createCount = 0;
  const prisma = {
    supplier: { findFirst: async () => ({ id: "supplier-1" }) },
    bank: { findFirst: async () => null },
    supplierPayment: { findFirst: async () => null, create: async () => { createCount += 1; return {}; } },
  };
  await assert.rejects(() => createDeps(prisma).create(paymentInput({ bank_id: "bank-dead" }), { id: "user-1" }), (error) => error.getResponse().code === "BANK_NOT_FOUND");
  assert.equal(createCount, 0);
});

test("编辑草稿付款：币种与支付银行都可改，币种走字典校验", async () => {
  let updated = null;
  const checked = [];
  const current = { id: "payment-1", status: "draft", amount: new Prisma.Decimal("300"), currency: "CNY", bankId: null, paymentDate: new Date("2026-09-15"), paymentMethod: "转账", remark: null };
  const prisma = {
    bank: { findFirst: async ({ where }) => (where.id === "bank-1" ? { id: "bank-1", bankName: "农业银行", accountNumber: "5706" } : null) },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      supplierPayment: { findFirst: async () => current, update: async ({ data }) => { updated = data; return { ...current, ...data }; } },
    }),
  };
  const service = new SupplierPaymentService(prisma, { update: () => ({}) }, {}, {}, { assertSupported: async (code) => { checked.push(code); } });
  await service.updateDraft("payment-1", { currency: "USD", bank_id: "bank-1" }, { id: "user-1" });
  assert.deepEqual(checked, ["USD"]);
  assert.equal(updated.currency, "USD");
  assert.equal(updated.bankId, "bank-1");
});

test("编辑草稿付款：bank_id 传 null 清空支付银行，undefined 不改动", async () => {
  const rows = [];
  const current = { id: "payment-1", status: "draft", amount: new Prisma.Decimal("300"), currency: "CNY", bankId: "bank-1", paymentDate: new Date("2026-09-15"), paymentMethod: "转账", remark: null };
  const prisma = {
    bank: { findFirst: async () => { throw new Error("清空/不改动都不应查询银行账户"); } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      supplierPayment: { findFirst: async () => current, update: async ({ data }) => { rows.push(data); return { ...current, ...data }; } },
    }),
  };
  const service = new SupplierPaymentService(prisma, { update: () => ({}) }, {}, {});
  await service.updateDraft("payment-1", { bank_id: null }, { id: "user-1" });
  await service.updateDraft("payment-1", { amount: "310" }, { id: "user-1" });
  assert.equal(rows[0].bankId, null, "null 表示清空银行");
  assert.equal(rows[1].bankId, "bank-1", "undefined 表示保持原值");
});

// ------------------------------------------------------------------ 合并付款：一次核销多条应付（可跨订单）
//
// 2026-10-08（用户确认）：「同一供应商多笔应付（可跨多张订单）一次付款并**真正核销**」。
//
// 后端的关键就是 `post` 的 `:96`：订单一致性**只在付款单自己带 `order_no` 时才校验** ——
// 所以界面在跨订单时有意省略 `order_no`，这一条允许一次核销多张订单的应付；其余红线
// （供应商 / 币种必须与付款单一致、单条不超未核销余额、合计不超付款金额）一条都不放松。
// 下面逐条钉住，并且钉住「被拒时一行核销都不落库」（事务回滚）。

/**
 * 多笔应付的过账夹具。
 *
 * 与上面的 `postFixture`（单条应付）的差别：这里一次给出**多条**应付（各自的订单号 / 币种 /
 * 供应商 / 金额），并记录每一行落库的核销 —— 多订单核销的关键断言就是这些核销行。
 *
 * `$transaction` 带**回滚**：抛错时把内存里的核销行与台账恢复原样，这样「被拒时一行都不落库」
 * 才是真的在验事务（真库的事务本来就会回滚，夹具不能比真库更宽松）。
 *
 * `realStatus: true` 时用**真的** `SupplierPayableService.refreshStatus`（状态口径的唯一实现，
 * 见 `supplier-payable.service.ts:408-421`），在内存台账上算「已核销多少」，用于钉住
 * 「部分核销 → partially_paid，结清 → paid」。
 */
function mergeFixture({ payables, payment = {}, realStatus = false }) {
  const allocationRows = [];
  const refreshed = [];
  const ledger = [];
  const entries = new Map(payables.map((row) => [row.id, { supplierId: "supplier-1", currency: "CNY", status: "confirmed", sourceType: "raw_material_inbound", ...row, amount: new Prisma.Decimal(row.amount) }]));
  const draft = {
    id: "payment-1", paymentNo: "SPAY-1", status: "draft", orderNo: null,
    amount: new Prisma.Decimal("800"), currency: "CNY", paymentDate: new Date("2026-10-08T00:00:00.000Z"),
    paymentMethod: "转账", payeeName: null, supplierId: "supplier-1", bankId: "bank-1", subjectId: null, remark: null,
    supplier: { name: "晋江大田" }, bank: { bankName: "农业银行", accountNumber: "5706" },
    ...payment,
  };
  const client = {
    $queryRaw: async () => [],
    supplierPayment: { findFirst: async () => ({ ...draft }), update: async ({ data }) => ({ ...draft, ...data }) },
    supplierPaymentAllocation: {
      create: async ({ data }) => {
        allocationRows.push(data);
        ledger.push({ payableEntryId: data.payableEntryId, amount: data.amount });
        return { id: `alloc-${allocationRows.length}`, ...data };
      },
      aggregate: async ({ where }) => ({
        _sum: { amount: ledger.filter((row) => row.payableEntryId === where.payableEntryId).reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)) },
      }),
    },
    supplierPayableEntry: {
      findFirst: async ({ where }) => (entries.has(where.id) ? { ...entries.get(where.id) } : null),
      update: async ({ where, data }) => { Object.assign(entries.get(where.id), data); return { ...entries.get(where.id) }; },
    },
    // 「收支类目」（2026-10-13）：付款过账会去查覆盖本次核销应付的对账单（条目没填科目时取它的）；
    // 本文件不涉及对账，给空表 —— 于是类目走候选链兜底。
    supplierPayableReconciliation: { findMany: async () => [] },
  };
  const prisma = {
    supplierPayment: { findFirst: async () => ({ ...draft }) },
    $transaction: async (fn) => {
      const rowsBefore = [...allocationRows];
      const ledgerBefore = [...ledger];
      try {
        return await fn(client);
      } catch (error) {
        allocationRows.length = 0; allocationRows.push(...rowsBefore);
        ledger.length = 0; ledger.push(...ledgerBefore);
        throw error;
      }
    },
  };
  const payable = realStatus ? new SupplierPayableService(client, { update: () => ({}) }) : {
    allocationBalance: async (id) => {
      const row = entries.get(id);
      return { entry: { ...row }, available: new Prisma.Decimal(row.available ?? row.amount) };
    },
    refreshStatus: async (_tx, id) => { refreshed.push(id); },
  };
  const cashFlowCalls = [];
  const service = new SupplierPaymentService(
    prisma,
    { create: () => ({}), update: () => ({}), record: async () => {} },
    payable,
    { autoCreateFromPayment: async (input) => { cashFlowCalls.push(input); return { id: "cf-1" }; }, autoReverseFromPayment: async () => null },
    undefined,
    { accruedSourceIds: async () => new Set() },
  );
  return { service, allocationRows, refreshed, cashFlowCalls, entries, ledger };
}

test("合并付款过账：一次核销多张订单的应付（付款单不写订单号）→ 每条应付一行核销、订单号逐条复制", async () => {
  const fixture = mergeFixture({ payables: [
    { id: "entry-a", orderNo: "SO-1", amount: "500" },
    { id: "entry-b", orderNo: "SO-2", amount: "300" },
  ] });
  const posted = await fixture.service.post("payment-1", [
    { payable_entry_id: "entry-a", amount: "500" },
    { payable_entry_id: "entry-b", amount: "300" },
  ], { id: "user-1" });

  assert.equal(posted.status, "posted");
  assert.equal(fixture.allocationRows.length, 2, "N 条应付 → N 行核销（跨订单也不例外）");
  // 每条核销行复制**它自己那条应付**的订单号：付款单没有订单号，核销行必须追得回订单。
  assert.deepEqual(
    fixture.allocationRows.map((row) => [row.payableEntryId, row.orderNo, row.amount.toString(), row.currency]),
    [["entry-a", "SO-1", "500", "CNY"], ["entry-b", "SO-2", "300", "CNY"]],
  );
  assert.deepEqual(fixture.refreshed, ["entry-a", "entry-b"], "每条应付都要刷新状态（不是只刷第一条）");
  // 钱只出一次：写一条按付款单汇总的收支流水，金额是整张付款单的金额。
  assert.equal(fixture.cashFlowCalls.length, 1);
  assert.equal(fixture.cashFlowCalls[0].amount.toString(), "800");
  assert.equal(fixture.cashFlowCalls[0].bankId, "bank-1", "银行必须落到流水上（银行余额的依据）");
});

test("合并付款过账：付款单写了订单号 → 同订单的应付能核销，另一张订单的被拒（ALLOCATION_REFERENCE_MISMATCH）", async () => {
  // 同订单：界面把 order_no 写上，后端校验通过（付款单与订单对得上）。
  const sameOrder = mergeFixture({ payables: [{ id: "entry-a", orderNo: "SO-1", amount: "500" }], payment: { orderNo: "SO-1" } });
  await sameOrder.service.post("payment-1", [{ payable_entry_id: "entry-a", amount: "500" }], { id: "user-1" });
  assert.equal(sameOrder.allocationRows.length, 1);

  // 跨订单：付款单带着 SO-1，却想核销 SO-2 的应付 —— 必须拒，且**一行都不能落库**。
  const crossed = mergeFixture({ payables: [{ id: "entry-b", orderNo: "SO-2", amount: "300" }], payment: { orderNo: "SO-1" } });
  await assert.rejects(
    () => crossed.service.post("payment-1", [{ payable_entry_id: "entry-b", amount: "300" }], { id: "user-1" }),
    (error) => error.getResponse().code === "ALLOCATION_REFERENCE_MISMATCH",
  );
  assert.equal(crossed.allocationRows.length, 0, "被拒时核销行必须随事务回滚");
});

test("合并付款过账：供应商不一致、币种不一致都被拒（ALLOCATION_REFERENCE_MISMATCH）", async () => {
  const otherSupplier = mergeFixture({ payables: [{ id: "entry-a", orderNo: "SO-1", amount: "500", supplierId: "supplier-2" }] });
  await assert.rejects(
    () => otherSupplier.service.post("payment-1", [{ payable_entry_id: "entry-a", amount: "500" }], { id: "user-1" }),
    (error) => error.getResponse().code === "ALLOCATION_REFERENCE_MISMATCH",
  );
  assert.equal(otherSupplier.allocationRows.length, 0);

  // 金额不跨币种合计：付款单是 CNY，USD 的应付不能混进来。
  const otherCurrency = mergeFixture({ payables: [{ id: "entry-a", orderNo: "SO-1", amount: "500", currency: "USD" }] });
  await assert.rejects(
    () => otherCurrency.service.post("payment-1", [{ payable_entry_id: "entry-a", amount: "500" }], { id: "user-1" }),
    (error) => error.getResponse().code === "ALLOCATION_REFERENCE_MISMATCH",
  );
  assert.equal(otherCurrency.allocationRows.length, 0);
});

test("合并付款过账：单条超过未核销余额、合计超过付款金额都被拒，且一行都不落库", async () => {
  // 单条超余额：未核销余额 300，却要核销 400。
  const overBalance = mergeFixture({ payables: [{ id: "entry-a", orderNo: "SO-1", amount: "800", available: "300" }] });
  await assert.rejects(
    () => overBalance.service.post("payment-1", [{ payable_entry_id: "entry-a", amount: "400" }], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYABLE_ALLOCATION_EXCEEDED" && error.getResponse().details[0].available_amount === "300",
  );
  assert.equal(overBalance.allocationRows.length, 0);

  // 合计超付款金额：两条各 500（余额充足），付款单只有 800。
  const overTotal = mergeFixture({ payables: [
    { id: "entry-a", orderNo: "SO-1", amount: "500" },
    { id: "entry-b", orderNo: "SO-2", amount: "500" },
  ] });
  await assert.rejects(
    () => overTotal.service.post("payment-1", [
      { payable_entry_id: "entry-a", amount: "500" },
      { payable_entry_id: "entry-b", amount: "500" },
    ], { id: "user-1" }),
    (error) => error.getResponse().code === "PAYMENT_ALLOCATION_EXCEEDED",
  );
  assert.equal(overTotal.allocationRows.length, 0, "超过付款金额时先前写入的核销行也必须回滚");
});

test("合并付款：部分核销 → 应付是 partially_paid，第二笔付款结清后变 paid（真 refreshStatus + 累计核销）", async () => {
  // 应付 800，先付 300（部分），再付 500（结清）。状态由 `SupplierPayableService.refreshStatus`
  // 按「应付金额 - 已过账核销累计」判定，这里用真实现，避免在测试里再抄一遍状态口径。
  const first = mergeFixture({ payables: [{ id: "entry-a", orderNo: "SO-1", amount: "800" }], payment: { amount: new Prisma.Decimal("300") }, realStatus: true });
  await first.service.post("payment-1", [{ payable_entry_id: "entry-a", amount: "300" }], { id: "user-1" });
  assert.equal(first.entries.get("entry-a").status, "partially_paid", "部分核销后是部分付款");

  // 第二笔付款接着核销余额（同一张应付、累计核销额相加）—— 用一个共享台账的夹具模拟同一张应付。
  const second = mergeFixture({ payables: [{ id: "entry-a", orderNo: "SO-1", amount: "800" }], payment: { amount: new Prisma.Decimal("500") }, realStatus: true });
  // 把第一笔的核销搬进第二笔的台账（真库里它们本来就是同一张应付上的两行核销）。
  second.ledger.push({ payableEntryId: "entry-a", amount: new Prisma.Decimal("300") });
  await second.service.post("payment-1", [{ payable_entry_id: "entry-a", amount: "500" }], { id: "user-1" });
  assert.equal(second.entries.get("entry-a").status, "paid", "核销额累计到应付金额后是已付款");
});
