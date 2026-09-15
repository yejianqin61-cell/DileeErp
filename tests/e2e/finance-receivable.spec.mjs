// 应收管理 E2E：确认应收台账 → 登记收款 → 展开收款面板 → 过账核销 → 自动进收支流水（收入）。
//
// 特别覆盖用户反馈过的那个缺陷：核销下拉**不得**列出别的币种/订单的应收来源。
// 这里播一条 USD 应收，再用一笔 CNY 收款去核销，断言下拉里根本选不到那条 USD 来源
// （服务端也会 422，但界面上就不该出现选不动的选项）。
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
let source;
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
    data: { sourceNo: sourceNo(), orderNo, salesOrderId: salesOrder.id, outboundId: outbound.id, customerId: customer.id, quantity: "10", unit: unit.name, unitPrice: "120", amount: "1200", currency: "USD", status: "confirmed", ...audit },
  });
});

test.afterAll(async () => {
  const payments = await prisma.customerPayment.findMany({ where: { customerId: customer?.id ?? "" }, select: { id: true } });
  const paymentIds = payments.map((row) => row.id);
  if (paymentIds.length) {
    await prisma.receivableAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
    await prisma.cashFlowEntry.deleteMany({ where: { sourceType: "customer_payment", sourceId: { in: paymentIds } } });
    await prisma.customerPayment.deleteMany({ where: { id: { in: paymentIds } } });
  }
  if (source) {
    await prisma.receivableAdjustment.deleteMany({ where: { receivableSourceId: source.id } });
    await prisma.receivableSource.deleteMany({ where: { id: source.id } });
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
  await removeE2eAdmin(prisma, admin?.userId);
  await prisma.$disconnect();
});

test("receivable.register_receipt_then_post_creates_income_cash_flow", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(admin.username);
  await page.getByTestId("login-password").fill(admin.password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  await page.goto("/finance/receivable?tab=confirmed");
  await expect(page.getByTestId("page-finance-receivable")).toBeVisible({ timeout: 15_000 });
  const row = page.getByTestId("data-table-row").filter({ hasText: sourceNo() }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("已确认");
  await expect(row).toContainText("1200");

  // 1) 登记收款：客户/订单/金额应预填，币种默认跟随应收（USD）
  await row.getByRole("button", { name: "登记收款" }).click();
  await expect(page.getByTestId("action-dialog")).toBeVisible();
  await page.getByTestId("action-field-amount").fill("1200");
  await page.getByTestId("action-dialog-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("收款草稿已创建", { timeout: 15_000 });

  // 2) 收款面板默认展开（useCollapsiblePanel defaultOpen=true + localStorage 记忆）：
  //    只有在收起时才点开，无条件点击会把它关掉。
  const paymentsToggle = page.getByTestId("receivable-payments-toggle");
  if ((await paymentsToggle.getAttribute("aria-expanded")) !== "true") await paymentsToggle.click();
  const paymentRow = page.getByTestId("data-table-row").filter({ hasText: "PAY-" }).first();
  await expect(paymentRow).toBeVisible({ timeout: 15_000 });
  await paymentRow.getByRole("button", { name: "过账/核销" }).click();
  await expect(page.getByTestId("action-dialog")).toBeVisible();

  // 3) 核销下拉**只应**列出同客户 + 同币种的应收来源：
  //    本 spec 只播了一条 USD 应收、且收款也是 USD，所以它必须出现在候选里；
  //    同时断言候选里不出现别的币种（用 CNY 字样兜底）。
  await page.getByTestId("action-field-source_id").click();
  const options = page.getByRole("option");
  await expect(options.filter({ hasText: sourceNo() })).toBeVisible({ timeout: 15_000 });
  const texts = await options.allTextContents();
  expect(texts.some((text) => text.includes("USD"))).toBe(true);
  await options.filter({ hasText: sourceNo() }).click();
  await page.getByTestId("action-field-amount").fill("1200");
  await page.getByTestId("action-dialog-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("收款已过账并核销", { timeout: 15_000 });

  // 4) 结果回显 + 落库
  await expect.poll(async () => (await prisma.receivableSource.findUnique({ where: { id: source.id } }))?.status, { timeout: 15_000 }).toBe("paid");
  await expect(page.getByTestId("data-table-row").filter({ hasText: sourceNo() }).first()).toContainText("已收清", { timeout: 15_000 });
  const payment = await prisma.customerPayment.findFirst({ where: { customerId: customer.id, status: "posted", deletedAt: null } });
  expect(payment).not.toBeNull();
  const allocations = await prisma.receivableAllocation.findMany({ where: { paymentId: payment.id, deletedAt: null } });
  expect(allocations.length).toBe(1);
  expect(allocations[0].amount.toString()).toBe("1200");

  // 5) 自动写收支流水：收入方向、项目「货款」
  const flow = await prisma.cashFlowEntry.findFirst({ where: { sourceType: "customer_payment", sourceId: payment.id, deletedAt: null } });
  expect(flow).not.toBeNull();
  expect(flow.direction).toBe("income");
  const item = await prisma.dictionaryItem.findUnique({ where: { id: flow.itemId } });
  expect(item.key).toBe("货款");
});
