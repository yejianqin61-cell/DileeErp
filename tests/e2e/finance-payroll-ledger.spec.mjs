// 工资台账 E2E：浏览器里改台账格子（真实保存）+ 行内付款。
//
// 覆盖的是「单元/集成测不到的部分」：满页可编辑表格的**交互契约** ——
// 单击进编辑、Enter 保存、值没变不打接口、保存后重新加载仍是新值。
// 前置的台账与应付用真库播种（生成/确认由集成测试覆盖），本 spec 只驱动浏览器。
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "playwright/test";
import { removeE2eAdmin, seedE2eAdmin } from "../helpers/e2e-auth.cjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(databaseUrl)) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL must point to a dedicated test database");

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const MONTH = "2026-09";
let admin;
let department;
let position;
let draftEmployee;
let draftLedger;
let payableEmployee;
let payableLedger;
let payableEntry;

test.beforeAll(async () => {
  admin = await seedE2eAdmin(prisma, "payroll");
  const audit = { createdBy: admin.userId, updatedBy: admin.userId };
  department = await prisma.department.create({ data: { code: `E2E-D-${admin.runId}`, name: `E2E工资部-${admin.runId}`, ...audit } });
  position = await prisma.position.create({ data: { departmentId: department.id, code: `E2E-P-${admin.runId}`, name: `E2E岗位-${admin.runId}`, ...audit } });
  const employeeOf = (suffix, name) => prisma.employee.create({
    data: { employeeNo: `E2E-${suffix}-${admin.runId}`, name, departmentId: department.id, positionId: position.id, employeeType: "non_workshop", employmentStatus: "active", ...audit },
  });
  draftEmployee = await employeeOf("D", `E2E草稿员工-${admin.runId}`);
  payableEmployee = await employeeOf("P", `E2E付款员工-${admin.runId}`);
  const period = { periodStart: new Date(`${MONTH}-01T00:00:00.000Z`), periodEnd: new Date(`${MONTH}-30T00:00:00.000Z`) };

  draftLedger = await prisma.payrollLedger.create({
    data: { ledgerNo: `E2E-PAYROLL-D-${admin.runId}`, employeeId: draftEmployee.id, ...period, currency: "CNY", baseSalary: "8000", performanceAmount: "1000", status: "draft", sourceSnapshot: {}, ...audit },
  });
  payableLedger = await prisma.payrollLedger.create({
    data: { ledgerNo: `E2E-PAYROLL-P-${admin.runId}`, employeeId: payableEmployee.id, ...period, currency: "CNY", baseSalary: "5000", status: "confirmed", sourceSnapshot: {}, ...audit },
  });
  payableEntry = await prisma.payrollPayableEntry.create({
    data: { payableNo: `E2E-PPAY-${admin.runId}`, ledgerId: payableLedger.id, employeeId: payableEmployee.id, amount: "5000", currency: "CNY", status: "confirmed", sourceSnapshot: {}, ...audit },
  });
});

test.afterAll(async () => {
  const ledgerIds = [draftLedger?.id, payableLedger?.id].filter(Boolean);
  if (ledgerIds.length) {
    await prisma.salaryPaymentAllocation.deleteMany({ where: { ledgerId: { in: ledgerIds } } });
    await prisma.payrollPayableEntry.deleteMany({ where: { ledgerId: { in: ledgerIds } } });
    await prisma.payrollAdjustment.deleteMany({ where: { ledgerId: { in: ledgerIds } } });
    await prisma.payrollLedger.deleteMany({ where: { id: { in: ledgerIds } } });
  }
  await prisma.salaryPayment.deleteMany({ where: { paymentNo: { contains: admin.runId } } });
  const employeeIds = [draftEmployee?.id, payableEmployee?.id].filter(Boolean);
  if (employeeIds.length) await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
  if (position) await prisma.position.deleteMany({ where: { id: position.id } });
  if (department) await prisma.department.deleteMany({ where: { id: department.id } });
  await removeE2eAdmin(prisma, admin?.userId);
  await prisma.$disconnect();
});

test("payroll.ledger_cell_edit_persists_and_inline_payment_settles", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("login-username").fill(admin.username);
  await page.getByTestId("login-password").fill(admin.password);
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  // 薪资从单页拆成了 hub + 子页：先确认 hub 上有入口，再进台账页（覆盖 7e9cae6 的路由拆分）
  await page.goto("/finance/salary");
  await expect(page.getByTestId("salary-section-grid")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("salary-section-ledger").click();
  await expect(page).toHaveURL(/\/finance\/salary\/ledger/, { timeout: 15_000 });
  await expect(page.getByTestId("page-finance-salary-ledger")).toBeVisible({ timeout: 15_000 });

  // 月份筛选到 2026-09，等台账表格出来
  await page.getByTestId("salary-month-filter").fill(MONTH);
  const sheet = page.getByTestId("payroll-sheet");
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  const draftRow = sheet.getByTestId(`payroll-row-${draftLedger.id}`).or(sheet.getByRole("row").filter({ hasText: `E2E草稿员工-${admin.runId}` }));
  await expect(draftRow.first()).toBeVisible({ timeout: 15_000 });

  // 1) 单元格：单击进入编辑 → 填值 → Enter 保存
  const performanceCell = page.getByTestId(`payroll-cell-${draftLedger.id}-performance`);
  await expect(performanceCell).toContainText("1000", { timeout: 15_000 });
  await performanceCell.click();
  const input = page.getByTestId(`payroll-cell-input-${draftLedger.id}-performance`);
  await expect(input).toBeVisible();
  await input.fill("1234");
  await input.press("Enter");
  await expect(performanceCell).toContainText("1234", { timeout: 15_000 });

  // 2) 真的落库了：刷新页面后仍是新值（证明不是只改了个本地 state）
  await page.reload();
  await expect(page.getByTestId("payroll-sheet")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("salary-month-filter").fill(MONTH);
  await expect(page.getByTestId(`payroll-cell-${draftLedger.id}-performance`)).toContainText("1234", { timeout: 15_000 });
  const persisted = await prisma.payrollLedger.findUnique({ where: { id: draftLedger.id } });
  expect(persisted.performanceAmount.toString()).toBe("1234");

  // 3) 付款在「工资付款」子页（台账页只有编辑/确认/删除；付款动作拆到了 payments 模式）
  await page.goto("/finance/salary");
  await page.getByTestId("salary-section-payments").click();
  await expect(page).toHaveURL(/\/finance\/salary\/payments/, { timeout: 15_000 });
  await expect(page.getByTestId("page-finance-salary-payments")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("salary-month-filter").fill(MONTH);
  await expect(page.getByTestId(`salary-pay-button-${payableLedger.id}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`salary-pay-amount-${payableLedger.id}`).fill("5000");
  await page.getByTestId(`salary-pay-button-${payableLedger.id}`).click();
  await expect(page.getByTestId("toast-item").last()).toContainText("已付款", { timeout: 15_000 });

  // 4) 落库校验：台账已付清、应付已付清、并自动写了收支流水
  await expect.poll(async () => (await prisma.payrollLedger.findUnique({ where: { id: payableLedger.id } }))?.status, { timeout: 15_000 }).toBe("paid");
  const entry = await prisma.payrollPayableEntry.findUnique({ where: { id: payableEntry.id } });
  expect(entry.status).toBe("paid");
  const allocations = await prisma.salaryPaymentAllocation.findMany({ where: { ledgerId: payableLedger.id, deletedAt: null } });
  expect(allocations.length).toBe(1);
  expect(allocations[0].amount.toString()).toBe("5000");
  const flow = await prisma.cashFlowEntry.findFirst({ where: { sourceType: "salary_payment", sourceId: allocations[0].paymentId, deletedAt: null } });
  expect(flow).not.toBeNull();
  expect(flow.direction).toBe("expense");
});
