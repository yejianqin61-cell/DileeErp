const assert = require("node:assert/strict");
const test = require("node:test");
const { CustomerPaymentService } = require("../../dist/modules/finance/customer-payment.service.js");

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
const createDeps = (prisma) => new CustomerPaymentService(prisma, { create: () => ({}), record: async () => {} }, {});

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
