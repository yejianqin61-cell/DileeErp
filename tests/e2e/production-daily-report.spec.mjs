import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "playwright/test";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(databaseUrl)) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL must point to a dedicated test database");
const runId = randomUUID().slice(0, 8);
const username = `e2e-d5-${runId}`;
const password = "E2eD5Report2026";
const orderNo = `E2E-D5-${runId}`;
const unitName = `件-D5-${runId}`;
const operationCode = `D5-OP-${runId}`;
const operationName = `D5缝制-${runId}`;
const employeeNo = `D5-E-${runId}`;
const employeeName = `D5员工-${runId}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let userId;
let salesId;
let employeeId;
let productionOrderId;
let productionOrderNo;
/** 工序计划数量（=考核是否超单的阈值）：员工计件日报合计 6 > 5。 */
const targetQuantity = "5";
const pieceQuantity = "6";
const pieceUnitPrice = "2";
const timeUnitPrice = "3";

test.beforeAll(async () => {
  userId = randomUUID();
  const audit = { createdBy: userId, updatedBy: userId };
  const role = await prisma.role.upsert({ where: { key: "administrator" }, update: { name: "管理员", updatedBy: userId }, create: { key: "administrator", name: "管理员", ...audit } });
  await prisma.user.create({ data: { id: userId, username, passwordHash: await argon2.hash(password, { type: argon2.argon2id }), displayName: "D5 浏览器测试", ...audit, roles: { create: [{ roleId: role.id }] } } });
  const unit = await prisma.unit.create({ data: { name: unitName, ...audit } });
  const customer = await prisma.customer.create({ data: { customerCode: `D5-C-${runId}`, name: `D5客户-${runId}`, ...audit } });
  const sales = await prisma.salesOrder.create({ data: { orderNo, customerId: customer.id, customerSnapshot: {}, orderDate: new Date(), productName: "D5雨伞", quantity: targetQuantity, unit: unit.name, currency: "USD", status: "confirmed", ...audit } });
  salesId = sales.id;
  const version = await prisma.salesOrderVersion.create({ data: { salesOrderId: sales.id, version: 1, snapshot: {}, ...audit } });
  const bom = await prisma.bom.create({ data: { orderNo, salesOrderId: sales.id, salesOrderVersionId: version.id, version: 1, status: "published", ...audit } });
  const location = await prisma.productionLocation.create({ data: { name: `D5车间-${runId}`, locationType: "workshop", ...audit } });
  const operation = await prisma.operationCatalog.create({ data: { operationCode, operationName, defaultUnitId: unit.id, ...audit } });
  const department = await prisma.department.create({ data: { code: `D5-D-${runId}`, name: `D5车间部-${runId}`, ...audit } });
  const position = await prisma.position.create({ data: { departmentId: department.id, code: `D5-P-${runId}`, name: `D5工人-${runId}`, ...audit } });
  const employee = await prisma.employee.create({ data: { employeeNo, name: employeeName, departmentId: department.id, positionId: position.id, employeeType: "workshop", employmentStatus: "active", ...audit } });
  employeeId = employee.id;
  await prisma.operationRate.createMany({ data: [
    { employeeId: employee.id, operationId: operation.id, wageMode: "piece_rate", unitPrice: pieceUnitPrice, effectiveFrom: new Date("2026-01-01"), ...audit },
    { employeeId: employee.id, operationId: operation.id, wageMode: "time_rate", unitPrice: timeUnitPrice, effectiveFrom: new Date("2026-01-01"), ...audit },
  ] });
  productionOrderNo = `MO-${runId}`;
  const productionOrder = await prisma.productionOrder.create({ data: { productionOrderNo, orderNo, salesOrderId: sales.id, bomId: bom.id, bomVersion: 1, bomSnapshot: {}, executionMode: "in_house", executionLocationId: location.id, plannedQuantity: targetQuantity, unitId: unit.id, status: "in_progress", ...audit } });
  productionOrderId = productionOrder.id;
  await prisma.productionOrderOperation.create({ data: { productionOrderId: productionOrder.id, operationCatalogId: operation.id, operationNameSnapshot: operation.operationName, unitId: unit.id, sequenceNo: 1, targetQuantity, ...audit } });
});

test.afterAll(async () => {
  await prisma.productionDailyAlert.deleteMany({ where: { orderNo } });
  await prisma.employeeDailyReport.deleteMany({ where: { orderNo } });
  await prisma.operationDailyReport.deleteMany({ where: { orderNo } });
  // 员工日报会派生生产薪资来源快照：它同时引用员工与生产单，不先清理会让后面的删除撞外键。
  await prisma.productionPayrollSource.deleteMany({ where: { orderNo } });
  await prisma.productionOrderOperation.deleteMany({ where: { productionOrder: { orderNo } } });
  await prisma.productionOrder.deleteMany({ where: { orderNo } });
  await prisma.operationRate.deleteMany({ where: { employee: { employeeNo } } });
  await prisma.employee.deleteMany({ where: { employeeNo } });
  await prisma.position.deleteMany({ where: { code: `D5-P-${runId}` } });
  await prisma.department.deleteMany({ where: { code: `D5-D-${runId}` } });
  await prisma.operationCatalog.deleteMany({ where: { operationCode } });
  await prisma.productionLocation.deleteMany({ where: { name: `D5车间-${runId}` } });
  await prisma.bom.deleteMany({ where: { orderNo } });
  if (salesId) await prisma.salesOrderVersion.deleteMany({ where: { salesOrderId: salesId } });
  await prisma.salesOrder.deleteMany({ where: { orderNo } });
  await prisma.customer.deleteMany({ where: { customerCode: `D5-C-${runId}` } });
  await prisma.unit.deleteMany({ where: { name: unitName } });
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.userRole.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

/** 打开当前工序的日报对话框（详情页唯一入口：订单列表 → 工序按钮 → 批量员工日报）。 */
async function openOperationReport(page) {
  await page.getByTestId("daily-reports-panel").getByRole("button", { name: operationName, exact: true }).click();
  await expect(page.getByTestId("operation-report-form")).toBeVisible({ timeout: 15_000 });
}

/** 批量选择员工：勾选工人后「加入日报」，草稿表出现一行。 */
async function addEmployeeDraft(page) {
  await page.getByTestId("employee-report-add").click();
  await expect(page.getByTestId("employee-picker")).toBeVisible();
  await page.getByTestId(`employee-picker-option-${employeeId}`).click();
  await page.getByTestId("employee-picker-apply").click();
  await expect(page.getByTestId("operation-report-draft-table").getByRole("row")).toHaveCount(2);
}

/**
 * 当前 UI 的日报入口只剩「工序员工日报」批量面板（旧的原生表单 `保存工序日报` / `保存员工日报`、
 * `name="employee_id"` / `name="wage_mode"` / `duration_minutes` 字段全部随 ActionDialog + Radix Select 迁移消失）：
 * 生产单详情页 → 日报面板 → 点工序按钮 → 批量选择员工 → 填件数/时长（小时）/单价 → 保存日报。
 * 后端在员工日报写入时同步重算「员工日记与工序日报差异」告警，并把它作为生产进度的阻塞项。
 */
test("production.daily-report.workbench_completes_operation_employee_alert_and_progress_flow", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  await page.goto(`/production/orders/${productionOrderId}`);
  await expect(page.getByRole("heading", { name: `生产单 ${productionOrderNo}` })).toBeVisible({ timeout: 15_000 });
  const panel = page.getByTestId("daily-reports-panel");
  await expect(panel).toContainText(productionOrderNo, { timeout: 15_000 });
  await expect(panel).toContainText("状态：in_progress");

  // 1) 计件员工日报：6 件 × 2 元/件 = 12.00（计划 5 件 → 超单）。
  await openOperationReport(page);
  await addEmployeeDraft(page);
  await page.getByTestId("operation-report-draft-table").getByPlaceholder("可选，用于统计").fill(pieceQuantity);
  await page.getByTestId("operation-report-draft-table").getByPlaceholder("元/件").fill(pieceUnitPrice);
  await page.getByTestId("operation-report-save").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("工序员工日报已保存");
  await expect(page.getByTestId("operation-report-form")).toBeHidden({ timeout: 15_000 });

  // 2) 重新打开该工序的日报：服务端累计（6 件）与超单判定都要看得见。
  await openOperationReport(page);
  const summary = page.getByTestId("daily-report-summary");
  await expect(summary).toContainText("本工序已完成数量");
  await expect(summary).toContainText(pieceQuantity, { timeout: 15_000 });
  await expect(summary).toContainText("是否超单");
  await expect(summary).toContainText("是");
  const savedRows = page.getByTestId("employee-report-table");
  const pieceRow = savedRows.getByRole("row").filter({ hasText: "计件" });
  await expect(pieceRow).toContainText(employeeName);
  await expect(pieceRow).toContainText("12.00");

  // 3) 计时员工日报：1 小时 × 3 元/小时 = 3.00（计时口径以小时录入，不再有 duration_minutes 字段）。
  await addEmployeeDraft(page);
  await page.getByTestId("operation-report-draft-table").getByRole("combobox").click();
  await page.getByRole("option").filter({ hasText: "计时" }).click();
  await page.getByTestId("operation-report-draft-table").getByPlaceholder("必填，如 1.5").fill("1");
  await page.getByTestId("operation-report-draft-table").getByPlaceholder("元/小时").fill(timeUnitPrice);
  await page.getByTestId("operation-report-save").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("工序员工日报已保存");
  await expect(page.getByTestId("operation-report-form")).toBeHidden({ timeout: 15_000 });

  // 4) 两种计薪方式的日报同时可见，且当日该员工总薪资联动合计为 12.00 + 3.00 = 15.00。
  await openOperationReport(page);
  const timeRow = savedRows.getByRole("row").filter({ hasText: "计时" });
  await expect(timeRow).toContainText("3.00", { timeout: 15_000 });
  await expect(timeRow).toContainText("15.00");
  await expect(pieceRow).toContainText("15.00");
  await expect(summary).toContainText("是");
  await page.getByTestId("operation-report-form").getByRole("button", { name: "关闭" }).click();
  await expect(page.getByTestId("operation-report-form")).toBeHidden({ timeout: 15_000 });

  // 5) 服务端生产进度：待处理的日报差异告警把生产单判为「存在阻塞」，并给出差异阻塞原因。
  //    日报面板保存后不会广播进度刷新事件，所以这里重新加载详情页读取服务端进度。
  await page.reload();
  const overview = page.getByTestId("order-overview");
  await expect(overview).toContainText("生产单概览", { timeout: 15_000 });
  await expect(overview).toContainText("存在阻塞", { timeout: 15_000 });
  await expect(overview).toContainText("日报数量差异");
  // 工序与进度面板里的服务端计量行，与工作台的「生产计量」同源。
  await expect(page.getByTestId("order-operations-panel")).toContainText("实际", { timeout: 15_000 });

  // 6) 告警中心：员工日报与工序日报不一致产生「生产日报差异」告警，确认后转为已确认（并可继续「解决」）。
  await page.goto("/reports");
  await expect(page.getByTestId("page-reports")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "告警中心" }).click();
  const alertTable = page.getByTestId("daily-alert-table");
  await expect(alertTable).toBeVisible({ timeout: 15_000 });
  const alertRow = alertTable.getByTestId("data-table-row").filter({ hasText: orderNo });
  await expect(alertRow).toContainText("生产日报差异", { timeout: 15_000 });
  await expect(alertRow).toContainText("待处理");
  await alertRow.getByRole("button", { name: "确认" }).click();
  await expect(page.getByTestId("action-dialog")).toBeVisible();
  await page.getByTestId("action-field-remark").fill("已核对");
  await page.getByTestId("action-dialog-submit").click();
  await expect(alertRow).toContainText("已确认", { timeout: 15_000 });
  await expect(alertRow.getByRole("button", { name: "解决" })).toBeVisible();

  // 6b) 联动验证（修复护栏）：告警中心确认必须同时把 production_daily_alert 置为 confirmed，
  //     否则订单侧的 daily_discrepancy 阻塞永远不会解除（production-progress.service.ts:169 只看 pending）。
  //     在修复前这里仍然显示「存在阻塞」，属真实缺陷 —— 本断言把它钉住。
  await page.goto(`/production`);
  await expect(page.getByTestId("page-production")).toBeVisible({ timeout: 15_000 });
  const orderRowBack = page.getByTestId("production-order-table").getByTestId("data-table-row").filter({ hasText: orderNo });
  await orderRowBack.getByRole("button").first().click();
  await expect(page.getByTestId("order-overview")).toContainText("生产单概览", { timeout: 15_000 });
  await expect(page.getByTestId("order-overview")).not.toContainText("日报数量差异", { timeout: 15_000 });

  // 7) 工作台：订单推进状态可见，生产计量显示服务端累计（完成 6 / 计划 5 / 超单 1，计量状态 over_order）。
  await page.goto("/");
  await expect(page.getByTestId("page-dashboard")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "订单全链路" })).toBeVisible({ timeout: 15_000 });
  await page.locator("#workbench-order-filter").fill(orderNo);
  const workbenchRow = page.getByTestId("data-table-row").filter({ hasText: orderNo });
  await expect(workbenchRow).toBeVisible({ timeout: 15_000 });
  await expect(workbenchRow).toContainText("进行中");
  await workbenchRow.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByRole("heading", { name: "生产计量" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "模块状态" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "超单量" })).toBeVisible();
  const measurementRow = page.getByTestId("data-table-row").filter({ hasText: operationName });
  await expect(measurementRow).toBeVisible({ timeout: 15_000 });
  const measurementCells = measurementRow.getByRole("cell");
  await expect(measurementCells.nth(1)).toHaveText(new RegExp(`^${pieceQuantity}(\\.0+)?$`));
  await expect(measurementCells.nth(2)).toHaveText(new RegExp(`^${targetQuantity}(\\.0+)?$`));
  await expect(measurementCells.nth(4)).toHaveText(/^1(\.0+)?$/);
  await expect(measurementCells.nth(7)).toHaveText("over_order");
});
