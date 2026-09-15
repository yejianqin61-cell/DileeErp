const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { SupplierPaymentService } = require("../../dist/modules/finance/supplier-payment.service.js");

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
const createDeps = (prisma) => new SupplierPaymentService(prisma, { create: () => ({}), record: async () => {} }, {});

// 2026-09-15：过账后必须真的把支出写进收支流水。
// 历史缺陷：写死的收支项目 key「外加工费」在字典里不存在（字典里是「外加工费 晋江大田工资」），
// CashFlowService 当时遇到缺项直接 return null，于是**每一笔供应商付款都被静默丢掉**。
function postFixture({ sourceType = "raw_material_inbound", supplierName = "晋江大田", bank = { bankName: "农业银行", accountNumber: "5706" } } = {}) {
  const cashFlowCalls = [];
  const payment = { id: "payment-1", paymentNo: "SPAY-1", status: "posted", orderNo: "SO-1", amount: new Prisma.Decimal("300"), currency: "CNY", paymentDate: new Date("2026-09-15T00:00:00.000Z"), paymentMethod: "转账", payeeName: null, supplierId: "supplier-1", remark: null };
  const prisma = {
    supplierPayment: { findFirst: async () => ({ ...payment, status: "draft" }) },
    $transaction: async (fn) => fn({
      $queryRaw: async () => [],
      supplierPayment: { findFirst: async () => ({ ...payment, status: "draft", supplier: { name: supplierName }, bank }), update: async () => payment },
      supplierPaymentAllocation: { create: async ({ data }) => ({ id: "alloc-1", ...data }) },
    }),
  };
  const payable = { allocationBalance: async () => ({ entry: { id: "entry-1", supplierId: "supplier-1", currency: "CNY", orderNo: "SO-1", status: "confirmed", sourceType }, available: new Prisma.Decimal("1000") }), refreshStatus: async () => {} };
  const cashFlow = { autoCreateFromPayment: async (input) => { cashFlowCalls.push(input); return { id: "cf-1" }; }, autoReverseFromPayment: async () => null };
  const service = new SupplierPaymentService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} }, payable, cashFlow);
  return { service, cashFlowCalls };
}

test("供应商付款过账后自动写收支流水：项目按应付来源选定，且不再用字典里不存在的 key", async () => {
  const { service, cashFlowCalls } = postFixture();
  await service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.equal(cashFlowCalls.length, 1);
  const input = cashFlowCalls[0];
  assert.deepEqual(input.itemKeys, ["原材料 成本", "货款"], "原料入库来源 → 原材料成本（候选链，第一个存在的生效）");
  assert.equal(input.direction, "expense");
  assert.equal(input.counterpartyName, "晋江大田", "对方名称取供应商名，不能退化成 UUID");
  assert.equal(input.settlementMethod, "转账--农业银行5706", "结算方式按老表格式带出银行账户");
  assert.deepEqual(input.settlementAccountHint, { bankName: "农业银行", accountNumber: "5706" }, "银行信息一并带给收支流水，用于匹配结算账户字典");
  assert.equal(input.sourceType, "supplier_payment");
  assert.equal(input.sourceId, "payment-1");
});

test("供应商付款过账：外加工与其他应付各自映射到对应收支项目", async () => {
  const outsource = postFixture({ sourceType: "outsource_receipt" });
  await outsource.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.deepEqual(outsource.cashFlowCalls[0].itemKeys, ["成品外加工费", "加工费"]);
  const other = postFixture({ sourceType: "other" });
  await other.service.post("payment-1", [{ payable_entry_id: "entry-1", amount: "300" }], { id: "user-1" });
  assert.deepEqual(other.cashFlowCalls[0].itemKeys, ["管理费用", "杂费车间装修费"]);
});

test("供应商付款冲销时回冲收支流水（钱没付出去，流水里不能留着）", async () => {
  const reversed = [];
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
