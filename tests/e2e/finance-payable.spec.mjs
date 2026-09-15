// 应付管理 E2E：确认应付台账 → 登记付款 → 展开付款面板 → 过账核销 → 自动进收支流水。
//
// 前置（供应商 + 一条已确认应付）用真库播种：原料入库 → 应付来源 → 接收 → 确认这条链
// 已由 finance-payable-chain 集成测试覆盖；本 spec 验证浏览器里的三步操作与结果回显。
import { PrismaClient } from "@prisma/client";
import { expect, test } from "playwright/test";
import { removeE2eAdmin, seedE2eAdmin } from "../helpers/e2e-auth.cjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(databaseUrl)) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL must point to a dedicated test database");

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let admin;
let supplier;
let entry;
const payableNo = () => `E2E-AP-${admin.runId}`;

test.beforeAll(async () => {
  admin = await seedE2eAdmin(prisma, "payable");
  const audit = { createdBy: admin.userId, updatedBy: admin.userId };
  supplier = await prisma.supplier.create({ data: { supplierCode: `E2E-S-${admin.runId}`, name: `E2E供应商-${admin.runId}`, ...audit } });
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
      status: "confirmed",
      ...audit,
    },
  });
});

test.afterAll(async () => {
  const payments = await prisma.supplierPayment.findMany({ where: { supplierId: supplier?.id ?? "" }, select: { id: true } });
  const paymentIds = payments.map((row) => row.id);
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
  await removeE2eAdmin(prisma, admin?.userId);
  await prisma.$disconnect();
});

test("payable.register_payment_then_post_creates_cash_flow", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(admin.username);
  await page.getByTestId("login-password").fill(admin.password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  await page.goto("/finance/payable?tab=confirmed");
  await expect(page.getByTestId("page-finance-payable")).toBeVisible({ timeout: 15_000 });
  const row = page.getByTestId("data-table-row").filter({ hasText: payableNo() }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("应付已确认");
  await expect(row).toContainText("1500");

  // 1) 登记付款（对应 AP-xxx）
  await row.getByRole("button", { name: "登记付款" }).click();
  await expect(page.getByTestId("action-dialog")).toBeVisible();
  await page.getByTestId("action-field-amount").fill("1500");
  await page.getByTestId("action-dialog-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("付款草稿已创建", { timeout: 15_000 });

  // 2) 付款面板默认是展开的（useCollapsiblePanel 的 defaultOpen=true，并按 localStorage 记忆），
  //    所以只有在它确实收起时才点开 —— 无条件点击会把它关掉，付款行就找不到了。
  const paymentsToggle = page.getByTestId("payable-payments-toggle");
  if ((await paymentsToggle.getAttribute("aria-expanded")) !== "true") await paymentsToggle.click();
  const paymentRow = page.getByTestId("data-table-row").filter({ hasText: "SPAY-" }).first();
  await expect(paymentRow).toBeVisible({ timeout: 15_000 });
  // 草稿付款行才有「过账/核销」按钮 —— 用行为断言，不依赖状态列的中文文案
  await expect(paymentRow.getByRole("button", { name: "过账/核销" })).toBeVisible({ timeout: 15_000 });

  // 3) 过账/核销：选应付条目 + 核销金额
  await paymentRow.getByRole("button", { name: "过账/核销" }).click();
  await expect(page.getByTestId("action-dialog")).toBeVisible();
  await page.getByTestId("action-field-entry_id").click();
  await page.getByRole("option").filter({ hasText: payableNo() }).click();
  await page.getByTestId("action-field-amount").fill("1500");
  await page.getByTestId("action-dialog-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("付款已过账并核销", { timeout: 15_000 });

  // 4) 结果回显：应付已付清
  await expect.poll(async () => (await prisma.supplierPayableEntry.findUnique({ where: { id: entry.id } }))?.status, { timeout: 15_000 }).toBe("paid");
  await expect(page.getByTestId("data-table-row").filter({ hasText: payableNo() }).first()).toContainText("已付清", { timeout: 15_000 });

  // 5) 自动写收支流水（支出方向、「管理费用」——其他应付没有来源可判时的默认归类）
  const payment = await prisma.supplierPayment.findFirst({ where: { supplierId: supplier.id, status: "posted", deletedAt: null } });
  expect(payment).not.toBeNull();
  const flow = await prisma.cashFlowEntry.findFirst({ where: { sourceType: "supplier_payment", sourceId: payment.id, deletedAt: null } });
  expect(flow).not.toBeNull();
  expect(flow.direction).toBe("expense");
  expect(flow.amount.toString()).toBe("1500");
  const item = await prisma.dictionaryItem.findUnique({ where: { id: flow.itemId } });
  expect(item.key).toBe("管理费用");
});
