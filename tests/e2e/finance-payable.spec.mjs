// 应付管理 E2E：确认应付（挂账）→ 勾选「合并付款」→ 过账核销 → 自动进收支流水。
//
// 前置（供应商 + 银行账户 + 一条应付草稿）用真库播种，确认走真实接口（确认 = 挂账，要生成凭证）：
// 原料入库 → 应付来源 → 接收 → 确认这条链已由 finance-payable-chain 集成测试覆盖；
// 本 spec 验证浏览器里的合并付款与结果回显。
import { PrismaClient } from "@prisma/client";
import { expect, test } from "playwright/test";
import { removeE2eAdmin, seedE2eAdmin } from "../helpers/e2e-auth.cjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(databaseUrl)) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL must point to a dedicated test database");

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let admin;
let supplier;
let bank;
let entry;
const payableNo = () => `E2E-AP-${admin.runId}`;

test.beforeAll(async () => {
  admin = await seedE2eAdmin(prisma, "payable");
  const audit = { createdBy: admin.userId, updatedBy: admin.userId };
  supplier = await prisma.supplier.create({ data: { supplierCode: `E2E-S-${admin.runId}`, name: `E2E供应商-${admin.runId}`, ...audit } });
  bank = await prisma.bank.create({ data: { bankCode: `E2E-B-${admin.runId}`, bankName: "E2E付款银行", accountName: "E2E账户", accountNumber: `E2E-ACC-${admin.runId}`, currency: "CNY", ...audit } });
  entry = await prisma.supplierPayableEntry.create({
    data: {
      payableNo: payableNo(),
      supplierId: supplier.id,
      sourceType: "other",
      sourceNoSnapshot: `E2E-OTHER-${admin.runId}`,
      quantity: "1",
      unitPrice: "1500",
      amount: "1500",
      currency: "CNY",
      confirmationDate: new Date(),
      status: "draft",
      ...audit,
    },
  });
});

test.afterAll(async () => {
  const payments = await prisma.supplierPayment.findMany({ where: { supplierId: supplier?.id ?? "" }, select: { id: true } });
  const paymentIds = payments.map((row) => row.id);
  const flows = await prisma.cashFlowEntry.findMany({ where: { sourceType: "supplier_payment", sourceId: { in: paymentIds } }, select: { id: true } });
  // 挂账凭证与流水凭证对来源单据没有外键，要按来源 id 显式删（分录级联）。
  const voucherSourceIds = [entry?.id, ...paymentIds, ...flows.map((row) => row.id)].filter(Boolean);
  if (voucherSourceIds.length) await prisma.voucher.deleteMany({ where: { sourceId: { in: voucherSourceIds } } });
  if (paymentIds.length) {
    await prisma.supplierPaymentAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
    await prisma.cashFlowEntry.deleteMany({ where: { sourceType: "supplier_payment", sourceId: { in: paymentIds } } });
    await prisma.supplierPayment.deleteMany({ where: { id: { in: paymentIds } } });
  }
  if (entry) await prisma.supplierPayableEntry.deleteMany({ where: { id: entry.id } });
  if (supplier) {
    await prisma.supplierPayableReconciliation.deleteMany({ where: { supplierId: supplier.id } });
    await prisma.supplier.deleteMany({ where: { id: supplier.id } });
  }
  if (bank) await prisma.bank.deleteMany({ where: { id: bank.id } });
  await removeE2eAdmin(prisma, admin?.userId);
  await prisma.$disconnect();
});

test("payable.merge_payment_settles_and_creates_cash_flow", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(admin.username);
  await page.getByTestId("login-password").fill(admin.password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  const confirmed = await page.request.post(`/api/v1/finance/payable-entries/${entry.id}/confirm`, { data: {} });
  expect(confirmed.status()).toBe(201);

  await page.goto("/finance/payable?tab=confirmed");
  await expect(page.getByTestId("page-finance-payable")).toBeVisible({ timeout: 15_000 });
  const row = page.getByTestId("data-table-row").filter({ hasText: payableNo() }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("应付已确认");
  await expect(row).toContainText("1500");

  // 1) 勾选已确认应付 → 合并付款（行内不再有「登记付款」：确认只挂账，付款是整单结清的批量动作）
  await page.getByTestId(`payable-select-${entry.id}`).check();
  await page.getByTestId("payable-merge-pay").click();
  await expect(page.getByTestId("payable-merge-dialog")).toBeVisible();
  await expect(page.getByTestId(`payable-merge-amount-${entry.id}`)).toContainText("1500");

  // 2) 选支付银行账户 → 一次完成建单 + 过账核销
  await page.getByTestId("payable-merge-bank").getByRole("combobox").click();
  await page.getByRole("option").filter({ hasText: bank.accountNumber }).click();
  await page.getByTestId("payable-merge-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("已付款并核销 1 条应付", { timeout: 15_000 });

  // 3) 结果回显：应付已付清
  await expect.poll(async () => (await prisma.supplierPayableEntry.findUnique({ where: { id: entry.id } }))?.status, { timeout: 15_000 }).toBe("paid");
  //    台账默认只看「未付」，付清的行要切到「已付」才看得到
  await expect(page.getByTestId(`payable-select-${entry.id}`)).toHaveCount(0, { timeout: 15_000 });
  await page.getByTestId("payable-payment-filter").click();
  await page.getByRole("option").filter({ hasText: "已付（" }).click();
  await expect(page.getByTestId("data-table-row").filter({ hasText: payableNo() }).first()).toContainText("已付清", { timeout: 15_000 });

  // 4) 自动写收支流水（支出方向、计入所选银行；已挂账的付款冲「应付账款」，收支类目落「管理费用」）
  const payment = await prisma.supplierPayment.findFirst({ where: { supplierId: supplier.id, status: "posted", deletedAt: null } });
  expect(payment).not.toBeNull();
  const flow = await prisma.cashFlowEntry.findFirst({ where: { sourceType: "supplier_payment", sourceId: payment.id, deletedAt: null } });
  expect(flow).not.toBeNull();
  expect(flow.direction).toBe("expense");
  expect(flow.amount.toString()).toBe("1500");
  expect(flow.bankId).toBe(bank.id);
  const subject = await prisma.accountingSubject.findUnique({ where: { id: flow.subjectId } });
  expect(subject.name).toBe("应付账款");
  const category = await prisma.accountingSubject.findUnique({ where: { id: flow.categorySubjectId } });
  expect(category.name).toBe("管理费用");
});
