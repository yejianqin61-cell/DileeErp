const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { CustomerPaymentService } = require("../../dist/modules/finance/customer-payment.service.js");
// 应收侧的真实现：整单结清后「应收变 paid」用真 `refreshStatus` 判定，测试里不重抄状态口径。
const { ReceivableService } = require("../../dist/modules/finance/receivable.service.js");

test("customer payment draft update locks and rechecks current status", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "payment-1", status: "posted", amount: "10", paymentDate: new Date(), paymentMethod: "bank", remark: null };
  const prisma = { customerPayment: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } }, $transaction: async (fn) => fn({ $queryRaw: async () => { lockCount += 1; }, customerPayment: prisma.customerPayment }) };
  const service = new CustomerPaymentService(prisma, { update: () => ({}) }, {});
  await assert.rejects(() => service.updateDraft("payment-1", { amount: "12" }, { id: "user-1" }), (error) => error.getResponse().code === "CUSTOMER_PAYMENT_NOT_EDITABLE");
  assert.equal(lockCount, 1); assert.equal(updateCount, 0);
});

test("customer payment reversal locks each receivable source before reversing allocations", async () => {
  const locks = [];
  const row = { id: "payment-1", status: "posted", allocations: [] };
  const prisma = {
    customerPayment: { findFirst: async () => row },
    $transaction: async (fn) => fn({
      $queryRaw: async (_strings, ...values) => { locks.push(values[0]); return []; },
      customerPayment: { findFirst: async () => ({ id: "payment-1", status: "posted", remark: null, orderNo: "SO-1", allocations: [{ receivableSourceId: "source-b" }, { receivableSourceId: "source-a" }] }), update: async () => ({ orderNo: "SO-1" }) },
      receivableAllocation: { updateMany: async () => {} },
    }),
  };
  // 第 4 个参数是 CashFlowService：冲销时要回冲收支流水（这里只断言锁顺序，所以给个空替身）。
  const service = new CustomerPaymentService(prisma, { update: () => ({}), record: async () => {} }, { refreshStatus: async () => {} }, { autoReverseFromPayment: async () => null });
  await service.reverse("payment-1", "撤销原因", { id: "user-1" });
  assert.deepEqual(locks, ["payment-1", "source-a", "source-b"]);
});

// 2026-09-15：收款建单补上幂等键与「重复草稿守卫」。
// 起因：一个订单被同一个人重复登记出 4 张完全相同的 14310 USD 草稿收款单
// （audit_events 里 4 次 customer_payment.create，details 逐字相同）。
const paymentInput = (extra = {}) => ({ customer_id: "customer-1", order_no: "SO-1", payment_date: "2026-09-15", amount: "14310", currency: "USD", payment_method: "bank_transfer", ...extra });
/**
 * CashFlowService 替身：建单只用到 `requireSubject`（校验会计科目），过账用 `autoCreateFromPayment`。
 * 返回 null 表示「不指定科目」——与服务端「留空则按来源自动归类」同义。
 */
const cashFlowStub = (extra = {}) => ({ requireSubject: async () => null, ...extra });
const createDeps = (prisma) => new CustomerPaymentService(prisma, { create: () => ({}), record: async () => {} }, {}, cashFlowStub());

test("收款建单：同一幂等键重放返回原单，不再新建（网络重试/双击不会重复落库）", async () => {
  let createCount = 0;
  const existing = { id: "payment-1", paymentNo: "PAY-1", status: "draft" };
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1" }) },
    customerPayment: {
      findFirst: async ({ where }) => (where.idempotencyKey ? existing : null),
      create: async () => { createCount += 1; return existing; },
    },
  };
  const row = await createDeps(prisma).create(paymentInput({ idempotency_key: "key-1" }), { id: "user-1" });
  assert.equal(row, existing);
  assert.equal(createCount, 0);
});

test("收款建单：同客户/订单/金额/币种的现存草稿会被拦下，避免又建一张重复草稿", async () => {
  let createCount = 0;
  const duplicate = { id: "payment-9", paymentNo: "PAY-20260915-DUP", status: "draft" };
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1" }) },
    customerPayment: {
      findFirst: async ({ where }) => (where.idempotencyKey ? null : duplicate),
      create: async () => { createCount += 1; return duplicate; },
    },
  };
  await assert.rejects(
    () => createDeps(prisma).create(paymentInput(), { id: "user-1" }),
    (error) => error.getResponse().code === "CUSTOMER_PAYMENT_DRAFT_EXISTS" && error.getResponse().message.includes("PAY-20260915-DUP"),
  );
  assert.equal(createCount, 0);
});

test("收款建单：没有重复时正常建单，并把幂等键写入记录", async () => {
  let created = null;
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1" }) },
    customerPayment: {
      findFirst: async () => null,
      create: async ({ data }) => { created = data; return { id: "payment-2", ...data }; },
    },
  };
  const row = await createDeps(prisma).create(paymentInput({ idempotency_key: "key-2" }), { id: "user-1" });
  assert.equal(created.idempotencyKey, "key-2");
  assert.equal(created.customerId, "customer-1");
  assert.equal(created.status ?? "draft", "draft");
  assert.equal(String(row.paymentNo).startsWith("PAY-"), true);
});

// 2026-09-15：「所有应收管理都要选择银行，从银行池里选择」。
// 银行是主数据（财务 → 银行账户），收款只能引用池子里的**启用**账户；停用的账户外键拦不住，必须显式校验。
const bank = { id: "bank-1", bankName: "农业银行", accountNumber: "5706" };
const createWithBank = (prisma) => new CustomerPaymentService(prisma, { create: () => ({}), record: async () => {} }, {}, cashFlowStub());

test("收款建单：选了银行 → 先校验账户再落库（bankId 写入收款单）", async () => {
  let created = null;
  const lookups = [];
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1" }) },
    bank: { findFirst: async ({ where }) => { lookups.push(where); return bank; } },
    customerPayment: { findFirst: async () => null, create: async ({ data }) => { created = data; return { id: "payment-3", ...data }; } },
  };
  await createWithBank(prisma).create(paymentInput({ bank_id: "bank-1" }), { id: "user-1" });
  assert.deepEqual(lookups, [{ id: "bank-1", deletedAt: null, isActive: true }], "只认「未删除 + 启用」的银行账户");
  assert.equal(created.bankId, "bank-1");
});

test("收款建单：银行不存在或已停用 → BANK_NOT_FOUND，不落库", async () => {
  let createCount = 0;
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1" }) },
    bank: { findFirst: async () => null },
    customerPayment: { findFirst: async () => null, create: async () => { createCount += 1; return {}; } },
  };
  await assert.rejects(() => createWithBank(prisma).create(paymentInput({ bank_id: "bank-dead" }), { id: "user-1" }), (error) => error.getResponse().code === "BANK_NOT_FOUND");
  assert.equal(createCount, 0);
});

test("编辑草稿收款：币种与到账银行都可改，且币种走字典校验", async () => {
  let updated = null;
  const supported = [];
  const current = { id: "payment-1", status: "draft", amount: new Prisma.Decimal("100"), currency: "CNY", bankId: "bank-1", paymentDate: new Date("2026-09-15"), paymentMethod: "转账", remark: null };
  const prisma = {
    bank: { findFirst: async () => bank },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      customerPayment: { findFirst: async () => current, update: async ({ data }) => { updated = data; return { ...current, ...data }; } },
    }),
  };
  const service = new CustomerPaymentService(prisma, { update: () => ({}) }, {}, cashFlowStub(), { assertSupported: async (code) => { supported.push(code); } });
  await service.updateDraft("payment-1", { currency: "USD", bank_id: "bank-1" }, { id: "user-1" });
  assert.deepEqual(supported, ["USD"], "改币种必须过币种字典");
  assert.equal(updated.currency, "USD");
  assert.equal(updated.bankId, "bank-1");
});

test("编辑草稿收款：bank_id 传 null 表示清空到账银行（选错了要能去掉）", async () => {
  let updated = null;
  const current = { id: "payment-1", status: "draft", amount: new Prisma.Decimal("100"), currency: "CNY", bankId: "bank-1", paymentDate: new Date("2026-09-15"), paymentMethod: "转账", remark: null };
  const prisma = {
    bank: { findFirst: async () => { throw new Error("清空银行不应查询银行账户"); } },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      customerPayment: { findFirst: async () => current, update: async ({ data }) => { updated = data; return { ...current, ...data }; } },
    }),
  };
  const service = new CustomerPaymentService(prisma, { update: () => ({}) }, {}, cashFlowStub());
  await service.updateDraft("payment-1", { bank_id: null }, { id: "user-1" });
  assert.equal(updated.bankId, null);
});

// 收款过账要把到账银行一并带给收支流水（匹配「结算账户」字典），否则收支明细看不到钱进了哪个账户。
test("收款过账：到账银行带给收支流水，且结算方式按老表格式带出", async () => {
  const cashFlowCalls = [];
  const payment = { id: "payment-1", paymentNo: "PAY-1", status: "posted", orderNo: "SO-1", amount: new Prisma.Decimal("100"), currency: "CNY", paymentDate: new Date("2026-09-15T00:00:00.000Z"), paymentMethod: "转账", payerName: null, customerId: "customer-1", bankId: "bank-1", subjectId: null, remark: null };
  const prisma = {
    customerPayment: { findFirst: async () => ({ ...payment, status: "draft" }) },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      customerPayment: { findFirst: async () => ({ ...payment, status: "draft", customer: { name: "晋江大田" }, bank }), update: async () => payment },
      receivableAllocation: { count: async () => 0, create: async ({ data }) => ({ id: "alloc-1", ...data }) },
      // 「收支类目」（2026-10-13）：收款过账会去查覆盖本次核销应收的对账单；本文件不涉及它，给空表。
      receivableReconciliation: { findMany: async () => [] },
    }),
  };
  const receivable = { allocationBalance: async () => ({ source: { id: "source-1", customerId: "customer-1", currency: "CNY", status: "confirmed" }, available: new Prisma.Decimal("100") }), refreshStatus: async () => {} };
  const cashFlow = { autoCreateFromPayment: async (input) => { cashFlowCalls.push(input); return { id: "cf-1" }; } };
  // 这条应收**先挂过账**（借应收账款 / 贷收入）→ 销账这条现金分录必须贷「应收账款」，
  // 再贷一次收入就是收入翻倍（两步口径见 docs/design/finance-accrual-two-step-2026-09-24.md）。
  const vouchers = { accruedSourceIds: async () => new Set(["source-1"]) };
  const service = new CustomerPaymentService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} }, receivable, cashFlow, undefined, vouchers);
  await service.post("payment-1", [{ receivable_source_id: "source-1", amount: "100" }], { id: "user-1" });
  assert.equal(cashFlowCalls.length, 1);
  const input = cashFlowCalls[0];
  assert.equal(input.direction, "income");
  assert.deepEqual(input.subjectNames, ["应收账款"], "挂过账的应收：销账贷应收账款，收入在挂账时已经记过");
  assert.equal(input.counterpartyName, "晋江大田", "对方名称取客户名，不能退化成 UUID");
  assert.equal(input.settlementMethod, "转账--农业银行5706");
  assert.deepEqual(input.settlementAccountHint, { bankName: "农业银行", accountNumber: "5706" });
  // 2026-09-16：bankId 是银行余额的唯一依据 —— 单据上选了银行就必须落到流水上，
  // 只给 settlementAccountHint（那只是拿去猜字典的）会让钱进不了任何账户。
  assert.equal(input.bankId, "bank-1", "到账银行要写进流水的 bankId，否则这笔钱进不了银行余额");
});

test("收款过账：没挂过账的应收（历史数据）仍按老口径贷收入，不让应收账款变成负数", async () => {
  const cashFlowCalls = [];
  const payment = { id: "payment-1", paymentNo: "PAY-1", status: "posted", orderNo: "SO-1", amount: new Prisma.Decimal("100"), currency: "CNY", paymentDate: new Date("2026-09-15T00:00:00.000Z"), paymentMethod: "转账", payerName: null, customerId: "customer-1", bankId: null, subjectId: null, remark: null };
  const prisma = {
    customerPayment: { findFirst: async () => ({ ...payment, status: "draft" }) },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      customerPayment: { findFirst: async () => ({ ...payment, status: "draft", customer: { name: "晋江大田" }, bank: null }), update: async () => payment },
      receivableAllocation: { count: async () => 0, create: async ({ data }) => ({ id: "alloc-1", ...data }) },
      // 「收支类目」（2026-10-13）：收款过账会去查覆盖本次核销应收的对账单；本文件不涉及它，给空表。
      receivableReconciliation: { findMany: async () => [] },
    }),
  };
  const receivable = { allocationBalance: async () => ({ source: { id: "source-1", customerId: "customer-1", currency: "CNY", status: "confirmed" }, available: new Prisma.Decimal("100") }), refreshStatus: async () => {} };
  const cashFlow = { autoCreateFromPayment: async (input) => { cashFlowCalls.push(input); return { id: "cf-1" }; } };
  // 一条都没挂账：贷应收账款会让「应收账款」凭空出现贷方余额（历史那笔钱从没进过应收）。
  const vouchers = { accruedSourceIds: async () => new Set() };
  const service = new CustomerPaymentService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} }, receivable, cashFlow, undefined, vouchers);
  await service.post("payment-1", [{ receivable_source_id: "source-1", amount: "100" }], { id: "user-1" });
  assert.deepEqual(cashFlowCalls[0].subjectNames, ["主营业务收入"], "老口径：直接贷收入（历史不动）");

  // 一半挂过账、一半没有 → 也退回老口径：混着两种口径的收款说不清贷方是谁，不猜。
  // 2026-11-09 D4：每条来源的核销额必须等于它自己的未核销余额（source-1 剩 60、source-2 剩 40）。
  const mixed = [];
  const cashFlowMixed = { autoCreateFromPayment: async (input) => { mixed.push(input); return { id: "cf-2" }; } };
  const vouchersMixed = { accruedSourceIds: async () => new Set(["source-1"]) };
  const receivableMixed = {
    allocationBalance: async (id) => ({
      source: { id, customerId: "customer-1", orderNo: "SO-1", currency: "CNY", status: "confirmed", createdAt: new Date("2026-10-01T00:00:00.000Z") },
      available: new Prisma.Decimal(id === "source-1" ? "60" : "40"),
    }),
    refreshStatus: async () => {},
  };
  const serviceMixed = new CustomerPaymentService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} }, receivableMixed, cashFlowMixed, undefined, vouchersMixed);
  await serviceMixed.post("payment-1", [{ receivable_source_id: "source-1", amount: "60" }, { receivable_source_id: "source-2", amount: "40" }], { id: "user-1" });
  assert.deepEqual(mixed[0].subjectNames, ["主营业务收入"], "有一条没挂账就整笔按老口径");
});

test("收款过账：过账时选的科目优先，其次用建单时存在收款单上的科目", async () => {
  const cashFlowCalls = [];
  const payment = { id: "payment-1", paymentNo: "PAY-1", status: "posted", orderNo: "SO-1", amount: new Prisma.Decimal("100"), currency: "CNY", paymentDate: new Date("2026-09-15T00:00:00.000Z"), paymentMethod: "转账", payerName: null, customerId: "customer-1", bankId: null, subjectId: "subject-from-draft", remark: null };
  const prisma = {
    customerPayment: { findFirst: async () => ({ ...payment, status: "draft" }) },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      customerPayment: { findFirst: async () => ({ ...payment, status: "draft", customer: { name: "晋江大田" }, bank: null }), update: async () => payment },
      receivableAllocation: { count: async () => 0, create: async ({ data }) => ({ id: "alloc-1", ...data }) },
      // 「收支类目」（2026-10-13）：收款过账会去查覆盖本次核销应收的对账单；本文件不涉及它，给空表。
      receivableReconciliation: { findMany: async () => [] },
    }),
  };
  const receivable = { allocationBalance: async () => ({ source: { id: "source-1", customerId: "customer-1", currency: "CNY", status: "confirmed" }, available: new Prisma.Decimal("100") }), refreshStatus: async () => {} };
  const cashFlow = { autoCreateFromPayment: async (input) => { cashFlowCalls.push(input); return { id: "cf-1" }; } };
  const service = new CustomerPaymentService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} }, receivable, cashFlow, undefined, { accruedSourceIds: async () => new Set() });
  await service.post("payment-1", [{ receivable_source_id: "source-1", amount: "100" }], { id: "user-1" });
  await service.post("payment-1", [{ receivable_source_id: "source-1", amount: "100" }], { id: "user-1" }, "subject-at-post");
  assert.equal(cashFlowCalls[0].subjectId, "subject-from-draft", "过账没选科目时要用建单时填在收款单上的科目，表单里填过的不能丢");
  assert.equal(cashFlowCalls[1].subjectId, "subject-at-post", "过账时临时选的科目优先");
});

// 收支类目（2026-10-13，用户：「其他应付其他应收也要带上会计科目」）。
// 应收来源上**没有**科目列，所以这一格取自**覆盖这条应收的应收对账单** ——
// 与应付侧的「条目 > 对账单」同一条链，只是应收少了条目那一级。
test("收支类目：收款过账把覆盖这条应收的应收对账科目带给流水（其他应收也带上会计科目）", async () => {
  const cashFlowCalls = [];
  const payment = { id: "payment-1", paymentNo: "PAY-1", status: "posted", orderNo: "SO-1", amount: new Prisma.Decimal("100"), currency: "CNY", paymentDate: new Date("2026-10-05T00:00:00.000Z"), paymentMethod: "转账", payerName: null, customerId: "customer-1", bankId: null, subjectId: null, remark: null };
  const coverage = { id: "recon-1", reconciliationNo: "ARR-1", status: "resolved", customerId: "customer-1", orderNo: null, currency: "CNY", periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-10-31T00:00:00.000Z"), subjectId: "subject-其他应收款" };
  const prisma = {
    customerPayment: { findFirst: async () => ({ ...payment, status: "draft" }) },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      customerPayment: { findFirst: async () => ({ ...payment, status: "draft", customer: { name: "晋江大田" }, bank: null }), update: async () => payment },
      receivableAllocation: { count: async () => 0, create: async ({ data }) => ({ id: "alloc-1", ...data }) },
      receivableReconciliation: { findMany: async () => [coverage] },
    }),
  };
  const receivable = { allocationBalance: async () => ({ source: { id: "source-1", customerId: "customer-1", orderNo: "SO-1", currency: "CNY", status: "confirmed", createdAt: new Date("2026-10-01T00:00:00.000Z") }, available: new Prisma.Decimal("100") }), refreshStatus: async () => {} };
  const service = new CustomerPaymentService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} }, receivable, { autoCreateFromPayment: async (input) => { cashFlowCalls.push(input); return { id: "cf-1" }; } }, undefined, { accruedSourceIds: async () => new Set(["source-1"]) });

  await service.post("payment-1", [{ receivable_source_id: "source-1", amount: "100" }], { id: "user-1" });

  assert.equal(cashFlowCalls[0].categorySubjectId, "subject-其他应收款", "覆盖它的对账单上填的科目");
  assert.deepEqual(cashFlowCalls[0].categorySubjectNames, ["主营业务收入", "营业外收入"], "没有对账单时按收款候选链兜底");
  assert.deepEqual(cashFlowCalls[0].subjectNames, ["应收账款"], "主科目不受影响（挂过账 → 贷应收账款）");
});

/* ============================================================
 * 2026-11-09 D4：强制核销额=单据额（应收侧）
 * 契约：docs/design/finance-governance-r2-r3-briefs-2026-11-09.md §1-A / §R2-1（brief 表 4~5）
 * 旧口径（部分收款、收款金额可大于核销合计）自本日起作废。
 * ============================================================ */

/**
 * 应收 D4 夹具：核销台账在内存里累计，状态用真 `ReceivableService.refreshStatus` 判定。
 * `available` 可小于 `sourceAmount`，用来模拟「历史 partially_paid、还剩一笔」。
 */
function receivableD4Fixture({ sourceAmount = "80", available = sourceAmount, paymentAmount = sourceAmount, status = "confirmed" } = {}) {
  const allocations = [];
  const sources = new Map([["source-1", { id: "source-1", sourceNo: "AR-1", customerId: "customer-1", orderNo: "SO-1", currency: "CNY", status, amount: new Prisma.Decimal(sourceAmount), createdAt: new Date("2026-10-01T00:00:00.000Z") }]]);
  // 历史 partially_paid：把「之前已经核销的那部分」预置进台账，只暴露剩余 `available` 给本次收款。
  const alreadyAllocated = new Prisma.Decimal(sourceAmount).minus(new Prisma.Decimal(available));
  if (alreadyAllocated.gt(0)) allocations.push({ paymentId: "payment-historical", receivableSourceId: "source-1", amount: alreadyAllocated, currency: "CNY" });
  const payment = { id: "payment-1", paymentNo: "PAY-1", status: "draft", orderNo: "SO-1", amount: new Prisma.Decimal(paymentAmount), currency: "CNY", paymentDate: new Date("2026-11-09T00:00:00.000Z"), paymentMethod: "转账", payerName: null, customerId: "customer-1", bankId: "bank-1", subjectId: null, remark: null, customer: { name: "晋江大田" }, bank };
  const client = {
    $queryRaw: async () => [],
    customerPayment: { findFirst: async () => payment, update: async ({ data }) => ({ ...payment, ...data }) },
    receivableAllocation: {
      count: async () => 0,
      create: async ({ data }) => { allocations.push(data); return { id: `alloc-${allocations.length}`, ...data }; },
      aggregate: async ({ where }) => ({
        _sum: { amount: allocations.filter((row) => row.receivableSourceId === where.receivableSourceId).reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0)) },
      }),
    },
    receivableSource: {
      findFirst: async ({ where }) => sources.get(where.id) ?? null,
      update: async ({ where, data }) => { Object.assign(sources.get(where.id), data); return sources.get(where.id); },
    },
    receivableReconciliation: { findMany: async () => [] },
  };
  // 与真库一致：事务抛错时内存里的核销行回滚，这样「被拒时一行都不落库」才是真的在验事务。
  const prisma = {
    customerPayment: { findFirst: async () => payment },
    $transaction: async (fn) => {
      const before = [...allocations];
      try {
        return await fn(client);
      } catch (error) {
        allocations.length = 0;
        allocations.push(...before);
        throw error;
      }
    },
  };
  const receivable = new ReceivableService(client, { update: () => ({}), record: async () => {} });
  const cashFlowCalls = [];
  const service = new CustomerPaymentService(
    prisma,
    { create: () => ({}), update: () => ({}), record: async () => {} },
    receivable,
    { autoCreateFromPayment: async (input) => { cashFlowCalls.push(input); return { id: "cf-1" }; } },
    undefined,
    { accruedSourceIds: async () => new Set(["source-1"]) },
  );
  return { service, allocations, cashFlowCalls, sources };
}

test("2026-11-09 D4：应收 80 全额核销 + 收款单 80 → 过账成功，应收 paid、流水/核销各 1 条", async () => {
  const fixture = receivableD4Fixture();
  const posted = await fixture.service.post("payment-1", [{ receivable_source_id: "source-1", amount: "80" }], { id: "user-1" });
  assert.equal(posted.status, "posted");
  assert.equal(fixture.sources.get("source-1").status, "paid", "整单结清后应收是已收款");
  assert.equal(fixture.allocations.length, 1, "核销 1 条");
  assert.equal(fixture.cashFlowCalls.length, 1, "流水 1 条");
  assert.equal(fixture.cashFlowCalls[0].amount.toString(), "80");
});

test("2026-11-09 D4：应收 80 只核销 50 → 422 ALLOCATION_MUST_SETTLE_RECEIVABLE（details 带三个金额）", async () => {
  const fixture = receivableD4Fixture({ paymentAmount: "50" });
  await assert.rejects(
    () => fixture.service.post("payment-1", [{ receivable_source_id: "source-1", amount: "50" }], { id: "user-1" }),
    (error) => {
      assert.equal(error.getResponse().code, "ALLOCATION_MUST_SETTLE_RECEIVABLE");
      assert.deepEqual(error.getResponse().details, [{ receivable_amount: "80", available_amount: "80", requested_amount: "50" }]);
      return true;
    },
  );
  assert.equal(fixture.allocations.length, 0, "被拒时核销行必须随事务回滚");
});

test("2026-11-09 D4：历史 partially_paid 应收只能按剩余 available 结清（结清后 paid）", async () => {
  // 应收 100、之前已收 40、剩 60：本次收款只能核销 60；按剩余余额结清后应收变 paid。
  const fixture = receivableD4Fixture({ sourceAmount: "100", available: "60", paymentAmount: "60", status: "partially_paid" });
  await fixture.service.post("payment-1", [{ receivable_source_id: "source-1", amount: "60" }], { id: "user-1" });
  assert.equal(fixture.sources.get("source-1").status, "paid", "历史部分收款按剩余余额结清后是已收款");
});

test("2026-11-09 D4：应收 80 全额核销但收款单 100 → 422 PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION", async () => {
  const fixture = receivableD4Fixture({ paymentAmount: "100" });
  await assert.rejects(
    () => fixture.service.post("payment-1", [{ receivable_source_id: "source-1", amount: "80" }], { id: "user-1" }),
    (error) => {
      assert.equal(error.getResponse().code, "PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION");
      assert.deepEqual(error.getResponse().details, [{ payment_amount: "100", allocated_amount: "80" }]);
      return true;
    },
  );
  assert.equal(fixture.allocations.length, 0);
});
