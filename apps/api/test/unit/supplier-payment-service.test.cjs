const assert = require("node:assert/strict");
const test = require("node:test");
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
