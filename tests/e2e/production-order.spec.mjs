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
  // 工序的「默认单位」从单位池里选，所以单位必须由夹具预先建好（单位池页面只能查看/维护，本 spec 不在浏览器里新建单位）。
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

/**
 * 当前 UI 的流程（旧 spec 直接在生产页用原生 select/input 建地点、建工序、加工序，这些控件已随
 * ActionDialog / DataTable / Radix Select 迁移而不存在）：
 *   加工地点池页面建地点 → 工序池页面建工序（默认单位取单位池里的启用单位）→ 生产页新建生产单
 *   （订单号是 searchable-select，执行地点是 Radix select）→ 进生产单详情页 → 「添加工序」
 *   （multi-checkbox）→ 详情页「启动生产」。
 */
test("production.workbench_creates_location_operation_and_starts_an_in_house_order", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  // 1) 加工地点池：主数据已从生产页拆到独立页面。
  await page.goto("/production/locations");
  await expect(page.getByRole("heading", { name: "加工地点池" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("loading-state")).toBeHidden({ timeout: 15_000 });
  await page.getByTestId("master-data-create-location").click();
  await expect(page.getByTestId("action-dialog")).toBeVisible();
  await page.getByTestId("action-field-name").fill(locationName);
  await page.getByTestId("action-dialog-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("加工地点已创建");
  await expect(page.getByTestId("data-table-row").filter({ hasText: locationName })).toBeVisible({ timeout: 15_000 });

  // 2) 工序池：默认单位从启用单位里选（Radix select，不能用 selectOption）。
  // 必须先等主数据加载完成：新建工序对话框的「默认单位」选项来自 /units，页面还在 loading 时
  // 打开对话框会得到一个空的单位下拉（按钮在 loading 期间也可点）。
  await page.goto("/production/operations");
  await expect(page.getByRole("heading", { name: "工序池" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("loading-state")).toBeHidden({ timeout: 15_000 });
  await page.getByTestId("master-data-create-operation").click();
  await expect(page.getByTestId("action-dialog")).toBeVisible();
  await page.getByTestId("action-field-operation_name").fill(operationName);
  await page.getByTestId("action-field-default_unit_id").click();
  await page.getByRole("option").filter({ hasText: unitName }).click();
  await page.getByTestId("action-dialog-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("工序已创建");
  const operationRow = page.getByTestId("data-table-row").filter({ hasText: operationName });
  await expect(operationRow).toBeVisible({ timeout: 15_000 });
  await expect(operationRow).toContainText(unitName);

  // 3) 生产页新建生产单：订单号是 searchable-select，执行地点是 Radix select。
  await page.goto("/production");
  await expect(page.getByTestId("page-production")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("loading-state")).toBeHidden({ timeout: 15_000 });
  await page.getByTestId("production-create-order").click();
  await expect(page.getByTestId("action-dialog")).toBeVisible();
  // 订单号是 searchable-select：先搜索出候选（断言候选确实被列出），再用键盘 Enter 选中。
  // 注意：该 popover 是「就地绝对定位」的（不像 Radix Select 走 portal），命中测试会被对话框遮罩
  // 挡在对话框可视区之外，所以这里走组件本身支持的键盘路径（搜索框 + Enter），而不是鼠标点击选项。
  await page.getByTestId("action-field-order_no").getByRole("combobox").click();
  await page.getByTestId("searchable-select-search").fill(orderNo);
  await expect(page.getByTestId("searchable-select-option").filter({ hasText: orderNo })).toBeVisible();
  await page.getByTestId("searchable-select-search").press("Enter");
  await expect(page.getByTestId("action-field-order_no")).toContainText(orderNo);
  await page.getByTestId("action-field-execution_location_id").click();
  await page.getByRole("option").filter({ hasText: locationName }).click();
  await page.getByTestId("action-dialog-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("生产单草稿已创建");

  const orderRow = page.getByTestId("production-order-table").getByTestId("data-table-row").filter({ hasText: orderNo });
  await expect(orderRow).toBeVisible({ timeout: 15_000 });
  await expect(orderRow).toContainText("draft");
  await expect(orderRow).toContainText(locationName);
  // 生产单创建时会自动补一道「包装」工序（工序池里存在启用的包装工序），所以草稿单一建好就有工序。
  await expect(orderRow).toContainText("包装");
  await expect(orderRow.getByRole("button", { name: "启动" })).toBeVisible();

  // 4) 生产单详情：单号单元格是 link 按钮，点进详情页。
  const orderLink = orderRow.getByRole("button").first();
  const productionOrderNo = (await orderLink.textContent()).trim();
  expect(productionOrderNo).toMatch(/^MO-/);
  await orderLink.click();
  await expect(page).toHaveURL(/\/production\/orders\//, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: `生产单 ${productionOrderNo}` })).toBeVisible({ timeout: 15_000 });

  // 5) 添加工序：multi-checkbox 选择工序池里的工序（已在单上的包装工序是 disabled 的）。
  await page.getByTestId("order-add-operation").click();
  await expect(page.getByTestId("action-dialog")).toBeVisible();
  const operationOption = page.getByTestId("action-field-operation_ids").locator("label").filter({ hasText: operationName });
  await expect(operationOption.locator("input")).toBeEnabled();
  await operationOption.click();
  await page.getByTestId("action-dialog-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("工序已添加");
  await expect(page.getByTestId("order-operations-panel")).toContainText(operationName, { timeout: 15_000 });

  // 6) 详情页启动生产：状态必须真的变成 in_progress（不是只弹一个提示）。
  await page.getByTestId("order-transition-in_progress").click();
  await expect(page.getByTestId("action-dialog")).toBeVisible();
  await page.getByTestId("action-field-reason").fill("E2E 浏览器测试启动生产");
  await page.getByTestId("action-dialog-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("启动生产成功");
  await expect(page.getByTestId("order-overview")).toContainText("生产中", { timeout: 15_000 });
  // 日报面板显示的是服务端原始状态值，用它锁死 in_progress（该面板只列生产中/已完工的厂内生产单）。
  await expect(page.getByTestId("daily-reports-panel")).toContainText("状态：in_progress", { timeout: 15_000 });

  // 7) 回到生产单列表：该行状态已推进为 in_progress，且不再提供「启动」按钮。
  await page.goto("/production");
  const startedRow = page.getByTestId("production-order-table").getByTestId("data-table-row").filter({ hasText: orderNo });
  await expect(startedRow).toBeVisible({ timeout: 15_000 });
  await expect(startedRow).toContainText("in_progress");
  await expect(startedRow.getByRole("button", { name: "启动" })).toHaveCount(0);
});
