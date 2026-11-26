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
const productionOrderNo = `MO-${runId}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let userId;
let productionOrderId;

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
  // materialName 是 BomItem 的必填字段（BOM 明细要能脱离物料主数据独立显示），
  // 本条夹具此前遗漏它，导致 beforeAll 直接抛 PrismaClientValidationError —— 该 spec 从未跑起来过。
  await prisma.bomItem.create({ data: { bomId: bom.id, materialId: material.id, materialName, unitId: unit.id, materialSnapshot: { name: materialName }, requiredQuantity: "5", unit: unit.name, ...audit } });
  const location = await prisma.productionLocation.create({ data: { name: `E2E原料车间-${runId}`, locationType: "workshop", ...audit } });
  const productionOrder = await prisma.productionOrder.create({ data: { productionOrderNo, orderNo, salesOrderId: sales.id, bomId: bom.id, bomVersion: 1, bomSnapshot: {}, executionMode: "in_house", executionLocationId: location.id, plannedQuantity: "10", unitId: unit.id, status: "in_progress", ...audit } });
  productionOrderId = productionOrder.id;
  // 期初原料库存：只按「物料 + 单位」计入余额，**不能**带 production_order_id ——
  // 服务端的「生产已领累计」= 该生产单下 raw_material 事实的负和，把期初库存挂到生产单上
  // 会让它被算成「已领 -10」（issue-preview 的生产领用数量因此变成负数）。
  await prisma.inventoryFact.create({ data: { materialId: material.id, unitId: unit.id, inventoryCategory: "raw_material", quantityDelta: "10", sourceType: "e2e_fixture", sourceId: randomUUID(), orderNo, createdBy: userId } });
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

/** 「领料单 / 补料单」列表页：全部原料流转单。 */
function movementsPanel(page) {
  return page.getByTestId("page-production-material-issues");
}
/** 原料仓储情况页的「库存汇总」面板：按物料+单位的当前原料余额。 */
function balancesPanel(page) {
  return page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "库存汇总" }) });
}
/** 按表头文字取一行里的单元格：列会增删，写死下标会静默读错列。 */
async function cellByHeader(table, row, header) {
  await expect(row).toBeVisible({ timeout: 15_000 });
  const headers = (await table.getByRole("columnheader").allTextContents()).map((text) => text.trim());
  const index = headers.indexOf(header);
  expect(index, `表头里应有「${header}」，实际：${headers.join(" | ")}`).toBeGreaterThanOrEqual(0);
  return row.getByRole("cell").nth(index);
}
/** 在 ActionDialog 里选一个 Radix Select 选项（原生 selectOption 对 Radix 无效）。 */
async function chooseOption(page, fieldTestId, optionText) {
  await page.getByTestId(fieldTestId).click();
  await page.getByRole("option").filter({ hasText: optionText }).click();
}

/**
 * 当前 UI 的原料流转流程（旧 spec 在生产/仓库页用的原生 `select[name="production_order_id"]`
 * 等控件已随 ActionDialog + Radix Select + 全屏领料单编辑页迁移而消失）：
 *   仓库 → 新建领料单（全屏编辑页，物料只能从该生产单订单 BOM 里选）→ 保存草稿 → 列表里「确认提交」
 *   → 仓库「待出库通知」确认出库 → 查看库存影响/审计上下文 → 退料并过账 → 报废并过账
 *   → 尝试冲销来源领料（必须被下游记录拦住）。
 */
test("warehouse.material_movement_workflow_tracks_issue_return_scrap_and_reversal_guard", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  await page.goto("/warehouse");
  await expect(page.getByRole("heading", { name: "仓库" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("page-warehouse")).toBeVisible();

  // 1) 新建领料单：从仓库入口进全屏编辑页，生产单与物料都从当前数据里选。
  await page.getByRole("link", { name: "新建领料单" }).click();
  await expect(page).toHaveURL(/\/production\/material-issues\/new/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "新建领料单" })).toBeVisible();
  await expect(page.getByTestId("loading-state")).toBeHidden({ timeout: 15_000 });
  await chooseOption(page, "material-slip-order-select", productionOrderNo);

  // 2) 服务端领料预览：配料 5（BOM）、已领 0、当前库存 10；本订单没有采购入库，余下以配料为基准 = 5 - 0 - 2 = 3。
  const slipLines = page.getByTestId("material-slip-lines");
  await expect(page.getByTestId("material-slip-line-material-0")).toContainText(materialName, { timeout: 15_000 });
  const slipRow = slipLines.getByRole("row").nth(1);
  // 先等默认数量 1 的预览落地（余下 4）再改数量：编辑页不丢弃过期的预览响应，抢在它返回前改会被旧值盖掉。
  await expect(await cellByHeader(slipLines, slipRow, "余下数量")).toHaveText(/^4(\.0+)?$/, { timeout: 15_000 });
  await page.getByTestId("material-slip-line-quantity-0").fill("2");
  for (const [header, expected] of [["配料数量", "5"], ["已领数量", "0"], ["余下数量", "3"], ["当前库存量", "10"], ["实际入库数量", "0"]]) {
    await expect(await cellByHeader(slipLines, slipRow, header), header).toHaveText(new RegExp(`^${expected}(\\.0+)?$`));
  }

  // 3) 保存草稿：编辑页保存后回到领料/补料单列表，草稿必须真的落在列表里（保存成功即整页跳转，
  //    提示 toast 会被跳转吃掉，所以这里断言的是跳转结果 + 列表里的草稿行，而不是瞬时提示）。
  await page.getByTestId("material-slip-save-draft").click();
  await expect(page).toHaveURL(/\/production\/material-issues\?production_order_id=/, { timeout: 15_000 });
  await expect(page.getByTestId("page-production-material-issues")).toBeVisible({ timeout: 15_000 });
  const draftRow = page.getByTestId("data-table-row").filter({ hasText: orderNo }).filter({ hasText: "领料单" });
  await expect(draftRow).toContainText("草稿", { timeout: 15_000 });
  await expect(draftRow).toContainText(`× 2${unitName}`);

  // 4) 两段式出库：生产「确认提交」（不动库存）→ 仓库在「待出库通知」里确认出库（扣减原料库存）。
  const movementNo = (await (await cellByHeader(movementsPanel(page), draftRow, "单据号")).textContent()).trim();
  expect(movementNo).toMatch(/^MI-/);
  await draftRow.getByRole("button", { name: "确认提交" }).click();
  await expect(page.getByTestId("toast-item").last()).toContainText("已提交仓库，等待确认出库", { timeout: 15_000 });
  await expect(page.getByTestId("data-table-row").filter({ hasText: movementNo })).toContainText("待仓库出库");

  await page.goto("/warehouse");
  await expect(page.getByTestId("page-warehouse")).toBeVisible({ timeout: 15_000 });
  const pendingRow = page.getByTestId("data-table-row").filter({ hasText: movementNo });
  await pendingRow.getByRole("button", { name: "确认出库" }).click();
  await expect(page.getByTestId("toast-item").last()).toContainText("已确认出库，原料库存已扣减", { timeout: 15_000 });
  await expect(pendingRow).toHaveCount(0);

  // 5) 原料余额从 10 扣到 8，单据列表里能看到已过账的领料单。
  await page.goto("/warehouse/raw-material-storage");
  const balanceRow = balancesPanel(page).getByTestId("data-table-row").filter({ hasText: materialCode });
  await expect(await cellByHeader(balancesPanel(page), balanceRow, "已过账库存")).toHaveText(/^8(\.0+)?$/, { timeout: 15_000 });
  await page.goto(`/production/material-issues?production_order_id=${productionOrderId}`);
  const issueRow = movementsPanel(page).getByTestId("data-table-row").filter({ hasText: movementNo });
  await expect(issueRow).toContainText("已过账", { timeout: 15_000 });

  // 6) 库存影响 + 单据详情/审计上下文（单据列表行内的两个弹窗）。
  await issueRow.getByRole("button", { name: "影响" }).click();
  const impactDialog = page.getByRole("dialog").filter({ hasText: "库存影响" });
  await expect(impactDialog).toBeVisible({ timeout: 15_000 });
  await expect(impactDialog).toContainText(materialName);
  await expect(impactDialog.getByTestId("impact-quantity")).toHaveText(/^2(\.0+)?/);
  await expect(impactDialog.getByTestId("impact-stock")).toHaveText(/^8(\.0+)?$/);
  await page.keyboard.press("Escape");
  await expect(impactDialog).toBeHidden();
  await issueRow.getByRole("button", { name: "审计" }).click();
  const auditSheet = page.getByRole("dialog").filter({ hasText: "库存单详情与审计上下文" });
  await expect(auditSheet).toBeVisible({ timeout: 15_000 });
  await expect(auditSheet).toContainText(movementNo);
  await expect(auditSheet).toContainText(orderNo);
  const postEvent = auditSheet.getByTestId("data-table-row").filter({ hasText: "过账" });
  await expect(postEvent).toContainText("原料浏览器测试");
  await page.keyboard.press("Escape");

  // 7) 退料并过账：必须填原因（当前流程把原因做成了必填项）。
  await page.getByRole("button", { name: "退料" }).click();
  await expect(page.getByTestId("action-dialog")).toBeVisible();
  await chooseOption(page, "action-field-production_order_id", productionOrderNo);
  await chooseOption(page, "action-field-source_issue_line_id", materialName);
  await page.getByTestId("action-field-reason").fill("验证退料流程");
  await page.getByTestId("action-field-quantity").fill("1");
  await page.getByTestId("action-dialog-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("退料已过账");
  await expect(movementsPanel(page).getByTestId("data-table-row").filter({ hasText: orderNo }).filter({ hasText: "退料" })).toContainText("已过账");

  // 8) 报废并过账。
  await page.getByRole("button", { name: "报废" }).click();
  await expect(page.getByTestId("action-dialog")).toBeVisible();
  await chooseOption(page, "action-field-production_order_id", productionOrderNo);
  await chooseOption(page, "action-field-source_issue_line_id", materialName);
  await page.getByTestId("action-field-reason").fill("验证报废流程");
  await page.getByTestId("action-field-quantity").fill("1");
  await page.getByTestId("action-dialog-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("报废已过账");
  await expect(movementsPanel(page).getByTestId("data-table-row").filter({ hasText: orderNo }).filter({ hasText: "报废" })).toContainText("已过账");

  // 9) 冲销门禁：来源领料已经有下游退料/报废记录，冲销必须被拒绝，单据状态保持已过账。
  await issueRow.getByRole("button", { name: "冲销" }).click();
  await expect(page.getByRole("dialog").filter({ hasText: `冲销：${movementNo}` })).toBeVisible();
  await page.getByLabel("冲销原因").fill("验证下游记录冲销门禁");
  await page.getByTestId("action-dialog-submit").click();
  await expect(page.getByTestId("toast-item").last()).toContainText("存在后续退料或报废记录，不能冲销来源领料", { timeout: 15_000 });
  await expect(issueRow).toContainText("已过账");
});
