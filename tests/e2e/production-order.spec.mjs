import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "playwright/test";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(databaseUrl)) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL must point to a dedicated test database");

const runId = randomUUID().slice(0, 8);
const username = `e2e-production-${runId}`;
const password = "E2eProduction2026";
const orderNo = `E2E-PROD-${runId}`;
const unitName = `件-E2E-${runId}`;
const locationName = `E2E车间-${runId}`;
const operationName = `E2E缝制-${runId}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let userId;
let salesId;

test.beforeAll(async () => {
  userId = randomUUID();
  const audit = { createdBy: userId, updatedBy: userId };
  const role = await prisma.role.upsert({ where: { key: "administrator" }, update: { name: "管理员", updatedBy: userId }, create: { key: "administrator", name: "管理员", ...audit } });
  await prisma.user.create({ data: { id: userId, username, passwordHash: await argon2.hash(password, { type: argon2.argon2id }), displayName: "生产浏览器测试", ...audit } });
  await prisma.userRole.create({ data: { userId, roleId: role.id } });
  const unit = await prisma.unit.create({ data: { name: unitName, ...audit } });
  const customer = await prisma.customer.create({ data: { customerCode: `E2E-C-${runId}`, name: `E2E客户-${runId}`, ...audit } });
  const sales = await prisma.salesOrder.create({ data: { orderNo, customerId: customer.id, customerSnapshot: {}, orderDate: new Date(), productName: "E2E雨伞", quantity: "12", unit: unit.name, currency: "USD", status: "confirmed", ...audit } });
  salesId = sales.id;
  const version = await prisma.salesOrderVersion.create({ data: { salesOrderId: sales.id, version: 1, snapshot: {}, ...audit } });
  await prisma.bom.create({ data: { orderNo, salesOrderId: sales.id, salesOrderVersionId: version.id, version: 1, status: "published", ...audit } });
});

test.afterAll(async () => {
  await prisma.productionOrderOperation.deleteMany({ where: { productionOrder: { orderNo } } });
  await prisma.productionOrder.deleteMany({ where: { orderNo } });
  await prisma.operationCatalog.deleteMany({ where: { operationName } });
  await prisma.productionLocation.deleteMany({ where: { name: locationName } });
  await prisma.bom.deleteMany({ where: { orderNo } });
  if (salesId) await prisma.salesOrderVersion.deleteMany({ where: { salesOrderId: salesId } });
  await prisma.salesOrder.deleteMany({ where: { orderNo } });
  await prisma.customer.deleteMany({ where: { customerCode: `E2E-C-${runId}` } });
  await prisma.unit.deleteMany({ where: { name: unitName } });
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.userRole.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

test("production.workbench_creates_location_operation_and_starts_an_in_house_order", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  await page.goto("/production");
  await expect(page.getByRole("heading", { name: "生产" })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("地点名称").fill(locationName);
  await page.getByRole("button", { name: "新增生产地点" }).click();
  await expect(page.getByRole("status")).toContainText("生产地点已创建");
  await page.getByLabel("工序名称").fill(operationName);
  await page.getByLabel("默认单位").selectOption({ label: unitName });
  await page.getByRole("button", { name: "新增工序" }).click();
  await expect(page.getByRole("status")).toContainText("工序已创建");
  await page.getByLabel("订单号").selectOption(orderNo);
  await page.getByLabel("执行地点").selectOption({ label: locationName });
  await page.getByRole("button", { name: "新建生产单" }).click();
  await expect(page.getByRole("status")).toContainText("生产单草稿已创建");
  const row = page.getByRole("row", { name: new RegExp(orderNo) });
  await row.getByRole("button", { name: "添加工序" }).click();
  await expect(page.getByRole("status")).toContainText("工序任务已添加");
  await row.getByRole("button", { name: "启动" }).click();
  await expect(row).toContainText("in_progress");
});
