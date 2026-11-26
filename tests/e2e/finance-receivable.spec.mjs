// 应收管理 E2E：确认应收（挂账）→ 勾选「合并收款」→ 过账核销 → 自动进收支流水（收入）。
//
// 特别覆盖用户反馈过的那个缺陷：核销时**不得**混进别的币种的应收来源。
// 这里同一客户播一条 USD、一条 CNY 应收：勾了 USD 之后 CNY 那条必须锁住选不动、也进不了收款单
// （服务端也会 422，但界面上就不该让人选上）。
import { PrismaClient } from "@prisma/client";
import { expect, test } from "playwright/test";
import { removeE2eAdmin, seedE2eAdmin } from "../helpers/e2e-auth.cjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(databaseUrl)) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL must point to a dedicated test database");

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let admin;
let customer;
let salesOrder;
let location;
let bank;
let source;
let otherSource;
const sourceNo = () => `E2E-AR-${admin.runId}`;

test.beforeAll(async () => {
  admin = await seedE2eAdmin(prisma, "receivable");
  const audit = { createdBy: admin.userId, updatedBy: admin.userId };
  customer = await prisma.customer.create({ data: { customerCode: `E2E-C-${admin.runId}`, name: `E2E客户-${admin.runId}`, ...audit } });
  const orderNo = `E2E-AR-ORDER-${admin.runId}`;
  const unit = await prisma.unit.create({ data: { name: `E2E打-${admin.runId}`, ...audit } });
  salesOrder = await prisma.salesOrder.create({
    data: { orderNo, customerId: customer.id, customerSnapshot: {}, orderDate: new Date(), productName: "E2E应收成品", quantity: "10", unit: unit.name, currency: "USD", status: "confirmed", unitPrice: "120", ...audit },
  });
  const version = await prisma.salesOrderVersion.create({ data: { salesOrderId: salesOrder.id, version: 1, snapshot: {}, ...audit } });
  // 生产单的**必填标量外键**必须一次给全（少一个 Prisma 会改用 checked 输入，报一个看不懂的
  // `Argument 'salesOrder' is missing`）：salesOrderId / executionLocationId / unitId 都给上。
  location = await prisma.productionLocation.create({ data: { name: `E2E车间-${admin.runId}`, locationType: "workshop", ...audit } });
  const productionOrder = await prisma.productionOrder.create({
    data: {
      productionOrderNo: `E2E-MO-${admin.runId}`,
      orderNo,
      salesOrderId: salesOrder.id,
      executionLocationId: location.id,
      unitId: unit.id,
      bomVersion: 1,
      bomSnapshot: {},
      executionMode: "in_house",
      plannedQuantity: "10",
      status: "in_progress",
      ...audit,
    },
  });
  await prisma.salesOrderVersion.update({ where: { id: version.id }, data: { updatedBy: admin.userId } });
  const outbound = await prisma.finishedGoodsOutbound.create({
    data: { outboundNo: `E2E-FGO-${admin.runId}`, orderNo, salesOrderId: salesOrder.id, productionOrderId: productionOrder.id, unitId: unit.id, quantity: "10", status: "posted", idempotencyKey: `e2e-${admin.runId}-outbound`, ...audit },
  });
  source = await prisma.receivableSource.create({
    data: { sourceNo: sourceNo(), orderNo, salesOrderId: salesOrder.id, outboundId: outbound.id, customerId: customer.id, quantity: "10", unit: unit.name, unitPrice: "120", amount: "1200", currency: "USD", status: "draft", ...audit },
  });
  const otherOutbound = await prisma.finishedGoodsOutbound.create({
    data: { outboundNo: `E2E-FGO2-${admin.runId}`, orderNo, salesOrderId: salesOrder.id, productionOrderId: productionOrder.id, unitId: unit.id, quantity: "1", status: "posted", idempotencyKey: `e2e-${admin.runId}-outbound-cny`, ...audit },
  });
  otherSource = await prisma.receivableSource.create({
    data: { sourceNo: `E2E-AR-CNY-${admin.runId}`, orderNo, salesOrderId: salesOrder.id, outboundId: otherOutbound.id, customerId: customer.id, quantity: "1", unit: unit.name, unitPrice: "300", amount: "300", currency: "CNY", status: "draft", ...audit },
  });
  bank = await prisma.bank.create({ data: { bankCode: `E2E-B-${admin.runId}`, bankName: "E2E收款银行", accountName: "E2E账户", accountNumber: `E2E-ACC-${admin.runId}`, currency: "USD", ...audit } });
});

test.afterAll(async () => {
  const payments = await prisma.customerPayment.findMany({ where: { customerId: customer?.id ?? "" }, select: { id: true } });
  const paymentIds = payments.map((row) => row.id);
  const sourceIds = [source?.id, otherSource?.id].filter(Boolean);
  const flows = await prisma.cashFlowEntry.findMany({ where: { sourceType: "customer_payment", sourceId: { in: paymentIds } }, select: { id: true } });
  // 挂账凭证与流水凭证对来源单据没有外键，要按来源 id 显式删（分录级联）。
  const voucherSourceIds = [...sourceIds, ...paymentIds, ...flows.map((row) => row.id)];
  if (voucherSourceIds.length) await prisma.voucher.deleteMany({ where: { sourceId: { in: voucherSourceIds } } });
  if (paymentIds.length) {
    await prisma.receivableAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
    await prisma.cashFlowEntry.deleteMany({ where: { sourceType: "customer_payment", sourceId: { in: paymentIds } } });
    await prisma.customerPayment.deleteMany({ where: { id: { in: paymentIds } } });
  }
  if (sourceIds.length) {
    await prisma.receivableAdjustment.deleteMany({ where: { receivableSourceId: { in: sourceIds } } });
    await prisma.receivableSource.deleteMany({ where: { id: { in: sourceIds } } });
  }
  if (salesOrder) {
    await prisma.finishedGoodsOutbound.deleteMany({ where: { salesOrderId: salesOrder.id } });
    await prisma.productionOrder.deleteMany({ where: { salesOrderId: salesOrder.id } });
    await prisma.salesOrderVersion.deleteMany({ where: { salesOrderId: salesOrder.id } });
    await prisma.salesOrder.deleteMany({ where: { id: salesOrder.id } });
  }
  if (customer) await prisma.customer.deleteMany({ where: { id: customer.id } });
  if (location) await prisma.productionLocation.deleteMany({ where: { id: location.id } });
  await prisma.unit.deleteMany({ where: { name: `E2E打-${admin.runId}` } });
  if (bank) await prisma.bank.deleteMany({ where: { id: bank.id } });
  await removeE2eAdmin(prisma, admin?.userId);
  await prisma.$disconnect();
});

test("receivable.merge_receipt_settles_and_creates_income_cash_flow", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(admin.username);
  await page.getByTestId("login-password").fill(admin.password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  for (const id of [source.id, otherSource.id]) {
    const response = await page.request.post(`/api/v1/finance/receivable-sources/${id}/confirm`, { data: {} });
    expect(response.status()).toBe(201);
  }

  await page.goto("/finance/receivable?tab=confirmed");
  await expect(page.getByTestId("page-finance-receivable")).toBeVisible({ timeout: 15_000 });
  const row = page.getByTestId("data-table-row").filter({ hasText: sourceNo() }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("已确认");
  await expect(row).toContainText("1200");

  // 1) 勾选 USD 应收 → 同客户的 CNY 应收必须锁住（行内不再有「登记收款」：收款是整单结清的批量动作）
  const otherCheckbox = page.getByTestId(`receivable-select-${otherSource.id}`);
  await expect(otherCheckbox).toBeEnabled();
  await page.getByTestId(`receivable-select-${source.id}`).check();
  await expect(otherCheckbox).toBeDisabled();
  await expect(page.getByTestId(`receivable-select-lock-${otherSource.id}`)).toContainText("USD");

  // 2) 合并收款弹窗只带勾选的那条，金额与币种跟着应收走
  await page.getByTestId("receivable-merge-receipt").click();
  await expect(page.getByTestId("receivable-merge-dialog")).toBeVisible();
  await expect(page.getByTestId(`receivable-merge-amount-${source.id}`)).toContainText("1200");
  await expect(page.getByTestId(`receivable-merge-row-${otherSource.id}`)).toHaveCount(0);
  await expect(page.getByTestId("receivable-merge-receipt-amount")).toContainText("1200 USD");

  // 3) 选到账银行账户 → 一次完成建单 + 过账核销
  await page.getByTestId("receivable-merge-bank").getByRole("combobox").click();
  await page.getByRole("option").filter({ hasText: bank.accountNumber }).click();
  await page.getByTestId("receivable-merge-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("已收款并核销 1 条应收", { timeout: 15_000 });

  // 4) 结果回显 + 落库
  await expect.poll(async () => (await prisma.receivableSource.findUnique({ where: { id: source.id } }))?.status, { timeout: 15_000 }).toBe("paid");
  //    台账默认只看「未收」，收清的行要切到「已收」才看得到
  await expect(page.getByTestId(`receivable-select-${source.id}`)).toHaveCount(0, { timeout: 15_000 });
  await page.getByTestId("receivable-payment-filter").click();
  await page.getByRole("option").filter({ hasText: "已收（" }).click();
  await expect(page.getByTestId("data-table-row").filter({ hasText: sourceNo() }).first()).toContainText("已收清", { timeout: 15_000 });
  const payment = await prisma.customerPayment.findFirst({ where: { customerId: customer.id, status: "posted", deletedAt: null } });
  expect(payment).not.toBeNull();
  const allocations = await prisma.receivableAllocation.findMany({ where: { paymentId: payment.id, deletedAt: null } });
  expect(allocations.length).toBe(1);
  expect(allocations[0].amount.toString()).toBe("1200");

  // 5) 自动写收支流水：收入方向、计入所选银行；已挂账的回款冲「应收账款」，收支类目落「主营业务收入」
  const flow = await prisma.cashFlowEntry.findFirst({ where: { sourceType: "customer_payment", sourceId: payment.id, deletedAt: null } });
  expect(flow).not.toBeNull();
  expect(flow.direction).toBe("income");
  expect(flow.amount.toString()).toBe("1200");
  expect(flow.bankId).toBe(bank.id);
  const subject = await prisma.accountingSubject.findUnique({ where: { id: flow.subjectId } });
  expect(subject.name).toBe("应收账款");
  const category = await prisma.accountingSubject.findUnique({ where: { id: flow.categorySubjectId } });
  expect(category.name).toBe("主营业务收入");
});
