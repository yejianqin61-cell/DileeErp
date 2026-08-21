import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "playwright/test";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(databaseUrl)) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL must point to a dedicated test database");

const runId = randomUUID().slice(0, 8);
const username = `e2e-material-${runId}`;
const password = "E2eMaterial2026";
const orderNo = `E2E-MAT-${runId}`;
const unitName = `个-E2E-MAT-${runId}`;
const materialCode = `MAT-E2E-${runId}`;
const materialName = `E2E原料-${runId}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let userId;

test.beforeAll(async () => {
  userId = randomUUID();
  const audit = { createdBy: userId, updatedBy: userId };
  const role = await prisma.role.upsert({ where: { key: "administrator" }, update: { name: "管理员", updatedBy: userId }, create: { key: "administrator", name: "管理员", ...audit } });
  await prisma.user.create({ data: { id: userId, username, passwordHash: await argon2.hash(password, { type: argon2.argon2id }), displayName: "原料浏览器测试", ...audit } });
  await prisma.userRole.create({ data: { userId, roleId: role.id } });
  const unit = await prisma.unit.create({ data: { name: unitName, ...audit } });
  const material = await prisma.material.create({ data: { materialCode, name: materialName, defaultUnitId: unit.id, ...audit } });
  const customer = await prisma.customer.create({ data: { customerCode: `E2E-MAT-C-${runId}`, name: `E2E原料客户-${runId}`, ...audit } });
  const sales = await prisma.salesOrder.create({ data: { orderNo, customerId: customer.id, customerSnapshot: {}, orderDate: new Date(), productName: "E2E原料雨伞", quantity: "10", unit: unit.name, currency: "USD", status: "confirmed", ...audit } });
  const version = await prisma.salesOrderVersion.create({ data: { salesOrderId: sales.id, version: 1, snapshot: {}, ...audit } });
  const bom = await prisma.bom.create({ data: { orderNo, salesOrderId: sales.id, salesOrderVersionId: version.id, version: 1, status: "published", ...audit } });
  await prisma.bomItem.create({ data: { bomId: bom.id, materialId: material.id, unitId: unit.id, materialSnapshot: { name: materialName }, requiredQuantity: "5", unit: unit.name, ...audit } });
  const location = await prisma.productionLocation.create({ data: { name: `E2E原料车间-${runId}`, locationType: "workshop", ...audit } });
  const productionOrder = await prisma.productionOrder.create({ data: { productionOrderNo: `MO-${runId}`, orderNo, salesOrderId: sales.id, bomId: bom.id, bomVersion: 1, bomSnapshot: {}, executionMode: "in_house", executionLocationId: location.id, plannedQuantity: "10", unitId: unit.id, status: "in_progress", ...audit } });
  await prisma.inventoryFact.create({ data: { materialId: material.id, unitId: unit.id, inventoryCategory: "raw_material", quantityDelta: "10", sourceType: "e2e_fixture", sourceId: randomUUID(), orderNo, productionOrderId: productionOrder.id, createdBy: userId } });
});

test.afterAll(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM audit_events WHERE details->>'order_no' = '${orderNo}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM inventory_facts WHERE order_no = '${orderNo}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM raw_material_movement_risks WHERE movement_id IN (SELECT id FROM raw_material_movements WHERE order_no = '${orderNo}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM raw_material_movement_lines WHERE movement_id IN (SELECT id FROM raw_material_movements WHERE order_no = '${orderNo}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM raw_material_movements WHERE order_no = '${orderNo}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM production_orders WHERE order_no = '${orderNo}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM production_locations WHERE name = 'E2E原料车间-${runId}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM bom_items WHERE bom_id IN (SELECT id FROM boms WHERE order_no = '${orderNo}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM boms WHERE order_no = '${orderNo}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM sales_order_versions WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE order_no = '${orderNo}')`);
  await prisma.$executeRawUnsafe(`DELETE FROM sales_orders WHERE order_no = '${orderNo}'`);
  await prisma.customer.deleteMany({ where: { customerCode: `E2E-MAT-C-${runId}` } });
  await prisma.material.deleteMany({ where: { materialCode } });
  await prisma.unit.deleteMany({ where: { name: unitName } });
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.userRole.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

test("warehouse.material_movement_workflow_tracks_issue_return_scrap_and_reversal_guard", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  await page.goto("/warehouse");
  await expect(page.getByRole("heading", { name: "仓库" })).toBeVisible({ timeout: 15_000 });
  await page.locator('select[name="production_order_id"]').first().selectOption({ label: `MO-${runId} / ${orderNo}` });
  await page.locator('select[name="material_id"]').selectOption({ label: `${materialCode} / ${materialName}（${unitName}）` });
  await page.locator('input[name="quantity"]').first().fill("2");
  await page.getByRole("button", { name: "查看影响预览" }).click();
  await expect(page.getByRole("heading", { name: "影响预览" })).toBeVisible();
  await expect(page.getByText("8", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "创建并过账" }).click();
  await expect(page.getByRole("status")).toContainText("领料已过账");

  await page.locator('select[name="production_order_id"]').nth(1).selectOption({ label: `MO-${runId} / ${orderNo}` });
  await page.locator('select[name="source_issue_line_id"]').selectOption({ index: 1 });
  await page.locator('input[name="quantity"]').nth(1).fill("1");
  await page.getByRole("button", { name: "退料并过账" }).click();
  await expect(page.getByRole("status")).toContainText("退料已过账");
  await page.locator('input[name="quantity"]').nth(1).fill("1");
  await page.getByRole("button", { name: "报废并过账" }).click();
  await expect(page.getByRole("status")).toContainText("报废已过账");

  const issueRow = page.getByRole("row").filter({ hasText: orderNo }).filter({ hasText: "领料" }).first();
  await issueRow.getByRole("button", { name: "查看" }).click();
  await issueRow.getByRole("button", { name: "影响" }).click();
  await expect(page.getByText("冲销整张单据")).toBeVisible();
  await page.getByLabel("冲销原因").fill("验证下游记录冲销门禁");
  await page.getByRole("button", { name: "冲销整张单据" }).click();
  await expect(page.getByText("存在后续退料或报废记录，不能冲销来源领料")).toBeVisible();
});
