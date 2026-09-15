// 工资管理三个页面的**行为**测试：真实渲染 + 真实点击/输入 + 断言真实请求。
//
//   /finance/salary          只提供两个入口（工资台账 / 工资付款）—— 页面本身不拉任何数据
//   /finance/salary/ledger   工资台账：可编辑满页表格（mode="ledger"）
//   /finance/salary/payments 工资付款：当月台账只留「总工资」，付款/冲销在行内完成（mode="payments"）
//
// 被测面的数据契约（全部来自组件源码，不是想象）：
//   POST   /hr/payroll-ledgers/import-month               进入页面/切月份自动导入本月全部员工（幂等）
//   GET    /hr/payroll-ledgers[?month=&department_id=&position_id=]   当月台账（两个二级页共用的行来源）
//   GET    /hr/payroll-payables                           工资应付（只有工资台账页要：生成/确认应付按钮）
//   GET    /production/employees                          新建台账弹窗的姓名下拉
//   GET    /production/departments | /production/positions  部门/岗位筛选下拉
//   PATCH  /hr/payroll-ledgers/:id                        单元格保存（一个类目一个字段）
//   POST   /hr/payroll-ledgers/:id/confirm|reopen|payable|close、DELETE /hr/payroll-ledgers/:id
//   POST   /hr/payroll-payables/:id/confirm
//   POST   /hr/payroll-ledgers/:id/pay                    行内付款：一次完成生成应付 + 建付款 + 核销过账
//   POST   /hr/payroll-ledgers/:id/unpay                  行内冲销：把该台账下已过账的付款整体回退
//
// 2026-09-15 两轮变化：① 台账从只读表变成可编辑表格（逐格 PATCH）；② 工资管理页只留两个入口，
// 台账与付款各自成为二级页，付款表直接搬当月台账、只保留「总工资」，操作都在行内完成。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SalaryWorkspace from "../components/finance/salary-workspace";
import FinanceSalaryPage from "../app/finance/salary/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  employees: "/api/v1/production/employees",
  departments: "/api/v1/production/departments",
  positions: "/api/v1/production/positions",
  ledgers: "/api/v1/hr/payroll-ledgers",
  importMonth: "/api/v1/hr/payroll-ledgers/import-month",
  payables: "/api/v1/hr/payroll-payables",
  payments: "/api/v1/hr/salary-payments",
  currencies: "/api/v1/dictionaries/currency/items",
} as const;

type Handler = (url: string, call: StubbedCall) => Response | undefined | Promise<Response | undefined>;
type SalaryData = Partial<Record<"employees" | "departments" | "positions" | "ledgers" | "payables" | "currencies", unknown[]>> & { imported?: Record<string, unknown> };

/** 按月导入的默认响应：一次导入 2 人、新建 2 条。 */
const importResult = (overrides: Record<string, unknown> = {}) => ({
  month: "2026-03", period_start: "2026-03-01", period_end: "2026-03-31", currency: "CNY",
  candidates: 2, created: 2, existing: 0, not_employed: 0, report_count: 7,
  ledgers: [], skipped: [], ...overrides,
});

/**
 * 桩：每个列表接口各回自己那一份数据（默认空），extra 优先执行，用于注入 403/422 等特例。
 * ledger 前缀下既有 GET（列表）又有 POST/PATCH/DELETE（动作），因此按 method 分流。
 */
function stubSalary(data: SalaryData = {}, extra?: Handler) {
  return stubApi(async (url, call) => {
    const injected = await extra?.(url, call);
    if (injected) return injected;
    if (url.startsWith(EP.importMonth)) return apiOk(data.imported ?? importResult());
    if (url.startsWith(EP.employees)) return apiOk(data.employees ?? []);
    if (url.startsWith(EP.departments)) return apiOk(data.departments ?? []);
    if (url.startsWith(EP.positions)) return apiOk(data.positions ?? []);
    if (url.startsWith(EP.payables)) return apiOk(data.payables ?? []);
    if (url.startsWith(EP.currencies)) return apiOk(data.currencies ?? []);
    if (url.startsWith(EP.ledgers)) return call.method === "GET" ? apiOk(data.ledgers ?? []) : apiOk({});
    return apiOk({});
  });
}

/**
 * 渲染某个二级页并等到数据加载完成（页面根出现）。
 *
 * 工资台账与工资付款现在是两个真实路由（/finance/salary/ledger、/finance/salary/payments），
 * 由路由决定 mode —— 不再是同一页里的查询参数 tab。
 */
async function openSalary(mode: "ledger" | "payments" = "ledger", props: Partial<{ initialMonth: string; initialDepartmentId: string; initialPositionId: string }> = {}) {
  render(<><SalaryWorkspace mode={mode} initialMonth="2026-03" {...props} /><Toaster /></>);
  return screen.findByTestId(mode === "payments" ? "page-finance-salary-payments" : "page-finance-salary-ledger");
}

/**
 * 取某个面板（section）的作用域。
 *
 * 必须挑「在 section 里的那个标题」：二级页的 PageHeader 也是 h1「工资台账」/「工资付款」，
 * 直接 getByRole("heading", { name }) 会同时命中页头与面板标题。
 */
function panel(title: string) {
  const heading = screen.getAllByRole("heading", { name: title }).find((item) => item.closest("section"));
  const section = heading?.closest("section");
  if (!section) throw new Error(`找不到面板：${title}`);
  return within(section as HTMLElement);
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const postsTo = (calls: StubbedCall[], suffix: string) => callsTo(calls, suffix).filter((call) => call.method === "POST");
const ledgerGets = (calls: StubbedCall[]) => calls.filter((call) => call.method === "GET" && (call.url === EP.ledgers || call.url.startsWith(`${EP.ledgers}?`)));
const paymentGets = (calls: StubbedCall[]) => calls.filter((call) => call.method === "GET" && (call.url === EP.payments || call.url.startsWith(`${EP.payments}?`)));
const patches = (calls: StubbedCall[]) => calls.filter((call) => call.method === "PATCH");
const setValue = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const cell = (ledgerId: string, key: string) => screen.getByTestId(`payroll-cell-${ledgerId}-${key}`);

/** 逐格编辑：单击 → 输入 → Enter。 */
function editCell(ledgerId: string, key: string, value: string) {
  fireEvent.click(cell(ledgerId, key));
  fireEvent.change(screen.getByTestId(`payroll-cell-input-${ledgerId}-${key}`), { target: { value } });
  fireEvent.keyDown(screen.getByTestId(`payroll-cell-input-${ledgerId}-${key}`), { key: "Enter" });
}

/** 打开 Radix Select 并选中某一项（选项文案即 value 的可读形式）。 */
async function pickOption(testId: string, optionName: string | RegExp) {
  await userEvent.click(screen.getByTestId(testId));
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

/**
 * 断言某条 toast 出现过。
 *
 * 不能用 getByTestId("toast-item")：自动导入也会产生一条 toast，只要两条同时在场就会「found multiple
 * elements」——那是测试写法的坑，不是产品缺陷。
 */
async function expectToast(text: string) {
  await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes(text))).toBe(true));
}

// ------------------------------------------------------------------ 夹具

const department = { id: "dep-1", name: "生产部", code: "D001" };
const otherDepartment = { id: "dep-2", name: "行政部", code: "D002" };
const position = { id: "pos-1", name: "缝制工", code: "P001", departmentId: "dep-1" };
const otherPosition = { id: "pos-2", name: "包装工", code: "P002", departmentId: "dep-1" };
const workshopEmployee = { id: "emp-1", employeeNo: "E-001", name: "张三", employeeType: "workshop", department, position };
const officeEmployee = { id: "emp-2", employeeNo: "E-101", name: "李四", employeeType: "non_workshop", department: otherDepartment, position: otherPosition };

/** 车间台账：基本工资格 = 基本工资 + 生产来源（当前 0 + 1234.5），其余类目为空。 */
const workshopLedger = {
  id: "pl-1", ledgerNo: "PAYROLL-001", employeeId: "emp-1",
  periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-03-31T00:00:00.000Z", currency: "CNY",
  baseSalary: "0.0000", productionSourceAmount: "1234.5000", overtimeAmount: "0.0000",
  attendanceDeduction: "0.0000", lateDeduction: "0.0000", absenceDeduction: "0.0000", earlyLeaveDeduction: "0.0000",
  performanceAmount: "0.0000", allowanceAmount: "0.0000", housingAllowance: "0.0000",
  socialInsurance: "0.0000", individualTax: "0.0000", otherAdjustment: "0.0000",
  basicSalaryAmount: "1234.5000", otherAdjustmentAmount: "0.0000",
  payableAmount: "1234.5000", paidAmount: "0.0000", outstandingAmount: "1234.5000",
  status: "draft", remark: null, sourceSnapshot: [], adjustments: [], allocations: [],
  employee: workshopEmployee,
};
const officeLedger = { ...workshopLedger, id: "pl-3", ledgerNo: "PAYROLL-003", employeeId: "emp-2", basicSalaryAmount: "5000.0000", baseSalary: "5000.0000", productionSourceAmount: "0.0000", employee: officeEmployee };
const confirmedLedger = { ...workshopLedger, id: "pl-2", status: "confirmed" };
const expiredLedger = { ...workshopLedger, id: "pl-4", status: "expired" };
/** 已付过一笔的台账：付款页的「已付/未付/冲销」都由它的核销明细驱动。 */
const paidLedger = {
  ...workshopLedger, id: "pl-9", ledgerNo: "PAYROLL-009", status: "partially_paid",
  paidAmount: "500.0000", outstandingAmount: "734.5000",
  allocations: [{ id: "alloc-1", amount: "500.0000", status: "active", payment: { paymentNo: "SALARY-001", status: "posted", paymentDate: "2026-03-05T00:00:00.000Z" } }],
};

// ------------------------------------------------------------------ 工资管理入口页

describe("工资管理：入口页只提供两个功能入口", () => {
  it("工资管理页只有两个板块卡片，指向台账与付款两个二级页，且自身不拉任何数据", () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    render(<FinanceSalaryPage />);
    expect(screen.getByTestId("page-finance-salary")).toBeInTheDocument();
    const grid = within(screen.getByTestId("salary-section-grid"));
    expect(grid.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByTestId("salary-section-ledger")).toHaveAttribute("href", "/finance/salary/ledger");
    expect(screen.getByTestId("salary-section-payments")).toHaveAttribute("href", "/finance/salary/payments");
    expect(screen.getByRole("heading", { name: "工资台账" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "工资付款" })).toBeVisible();
    expect(calls, "入口页不拉数据：进错页不该触发按月导入写库").toHaveLength(0);
  });
});

// ------------------------------------------------------------------ 自动导入本月员工

describe("工资管理：每月自动导入全部员工", () => {
  it("进入页面先幂等导入本月全部员工，导入完成后再拉列表", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    const imports = postsTo(calls, EP.importMonth);
    expect(imports).toHaveLength(1);
    expect(bodyOf(imports[0])).toEqual({ month: "2026-03" });
    // 导入必须排在台账查询之前，否则会把「还没导入」的空表读回来
    const importIndex = calls.indexOf(imports[0]);
    const ledgerIndex = calls.findIndex((call) => call.method === "GET" && call.url.startsWith(EP.ledgers));
    expect(importIndex).toBeLessThan(ledgerIndex);
    expect(screen.getByTestId("salary-import-summary")).toHaveTextContent("本月在册 2 人：新建 2 条、已有 0 条、不在职 0 人、涉及生产日报 7 条。");
  });

  it("新建了台账时给出成功提示；没有任何新建时不打扰用户", async () => {
    const first = stubSalary({ imported: importResult({ created: 3, candidates: 3 }) });
    const view = render(<><SalaryWorkspace mode="ledger" initialMonth="2026-03" /><Toaster /></>);
    await expectToast("已自动导入本月 3 名员工的工资台账");
    expect(postsTo(first, EP.importMonth)).toHaveLength(1);
    view.unmount();

    const second = stubSalary({ imported: importResult({ created: 0, existing: 2 }) });
    render(<><SalaryWorkspace mode="ledger" initialMonth="2026-04" /><Toaster /></>);
    await waitFor(() => expect(postsTo(second, EP.importMonth)).toHaveLength(1));
    expect(screen.queryByText(/已自动导入/)).toBeNull();
    // 还要等列表加载完成：加载态下筛选条与导入摘要都还没渲染
    expect(await screen.findByTestId("salary-import-summary")).toHaveTextContent("新建 0 条、已有 2 条");
  });

  it("切换月份会重新导入该月并带 new month 重新拉取台账", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    setValue("salary-month-filter", "2026-04");
    await waitFor(() => expect(postsTo(calls, EP.importMonth)).toHaveLength(2));
    expect(bodyOf(postsTo(calls, EP.importMonth)[1])).toEqual({ month: "2026-04" });
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url === `${EP.ledgers}?month=2026-04`)).toBe(true));
  });

  it("导入失败只提示导入失败，列表照常加载（导入是幂等增强，不是列表的前置门禁）", async () => {
    stubSalary({ ledgers: [workshopLedger] }, (url, call) => (url.startsWith(EP.importMonth) && call.method === "POST" ? apiErr(403, "FORBIDDEN", "无权导入工资台账") : undefined));
    await openSalary();
    expect(screen.getByTestId("salary-import-summary")).toHaveTextContent("本月导入失败：无权导入工资台账");
    expect(panel("工资台账").getByText("E-001")).toBeVisible();
  });

  it("「重新导入本月员工」按钮可手动重跑（同样的幂等请求）", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    await userEvent.click(screen.getByTestId("salary-import-button"));
    await waitFor(() => expect(postsTo(calls, EP.importMonth)).toHaveLength(2));
  });
});

// 用户两次强调「全屏！」：两个二级页都是「一条细工具条 + 表格铺满可视区」，工具条上还有浏览器全屏开关。
describe("工资管理：满屏表格与浏览器全屏", () => {
  it("页面根与表格容器都带满屏类，工具条取代了原来的页头", async () => {
    stubSalary({ ledgers: [workshopLedger] });
    await openSalary("ledger");
    expect(screen.getByTestId("page-finance-salary-ledger").className).toContain("page-fullscreen");
    expect(screen.getByTestId("salary-ledger-panel").className).toContain("page-fullscreen-table");
    expect(screen.getByTestId("salary-ledger-panel").querySelector(".panel-body")).not.toBeNull();
    expect(screen.getByTestId("salary-import-summary")).toBeVisible();
  });

  it("点「全屏」调用浏览器全屏，退出后按钮回到「全屏」", async () => {
    const requestFullscreen = vi.fn(async () => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.documentElement });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    const exitFullscreen = vi.fn(async () => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: requestFullscreen });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });
    try {
      stubSalary({ ledgers: [workshopLedger] });
      await openSalary("ledger");
      await userEvent.click(screen.getByTestId("salary-fullscreen-button"));
      await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByTestId("salary-fullscreen-button")).toHaveTextContent("退出全屏"));
      await userEvent.click(screen.getByTestId("salary-fullscreen-button"));
      await waitFor(() => expect(exitFullscreen).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByTestId("salary-fullscreen-button")).toHaveTextContent("全屏"));
    } finally {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
      Reflect.deleteProperty(document.documentElement, "requestFullscreen");
      Reflect.deleteProperty(document, "exitFullscreen");
    }
  });

  it("浏览器不支持全屏时给出提示，而不是点了没反应", async () => {
    Reflect.deleteProperty(document.documentElement, "requestFullscreen");
    stubSalary({ ledgers: [workshopLedger] });
    await openSalary("payments");
    await userEvent.click(screen.getByTestId("salary-fullscreen-button"));
    await expectToast("当前浏览器不支持全屏");
  });
});
// ------------------------------------------------------------------ 筛选（两个二级页共用）

describe("工资管理：月份/部门/岗位/员工筛选", () => {
  it("初始月份作为服务端参数带给台账列表，且两个页面都不再拉工资付款列表", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url === `${EP.ledgers}?month=2026-03`)).toBe(true));
    expect(paymentGets(calls), "付款行直接来自当月台账，不再单独拉 /hr/salary-payments").toHaveLength(0);
  });

  it("工资付款页的筛选与台账页同一套：月份/部门/岗位都进台账查询，岗位下拉按部门收窄", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger], departments: [department, otherDepartment], positions: [position, otherPosition] });
    await openSalary("payments");
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url === `${EP.ledgers}?month=2026-03`)).toBe(true));
    await pickOption("salary-department-filter", "生产部");
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url === `${EP.ledgers}?month=2026-03&department_id=dep-1`)).toBe(true));
    expect(calls.some((call) => call.url === `${EP.positions}?department_id=dep-1`)).toBe(true);
    await pickOption("salary-position-filter", "缝制工");
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url.includes("position_id=pos-1"))).toBe(true));
  });

  it("工资付款页不会拉工资应付与员工清单（那两样只有台账页要）", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary("payments");
    expect(calls.some((call) => call.url.startsWith(EP.payables))).toBe(false);
    expect(calls.some((call) => call.url.startsWith(EP.employees))).toBe(false);
    expect(calls.some((call) => call.url.startsWith(EP.importMonth))).toBe(true);
  });

  it("按岗位筛选：带 position_id 重新拉取台账", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger], departments: [department], positions: [position] });
    await openSalary();
    await pickOption("salary-position-filter", "缝制工");
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url.includes("position_id=pos-1"))).toBe(true));
  });

  it("切换部门会清空已选岗位（否则会查出空集）", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger], departments: [department, otherDepartment], positions: [position] });
    await openSalary();
    await pickOption("salary-position-filter", "缝制工");
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url.includes("position_id=pos-1"))).toBe(true));
    await pickOption("salary-department-filter", "生产部");
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url === `${EP.ledgers}?month=2026-03&department_id=dep-1`)).toBe(true));
    expect(ledgerGets(calls).some((call) => call.url.includes("position_id=pos-1") && call.url.includes("department_id"))).toBe(false);
  });

  it("员工姓名/工号筛选是本地过滤：只留下匹配行且不发新请求", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger, officeLedger] });
    await openSalary();
    const before = ledgerGets(calls).length;
    setValue("salary-employee-filter", "E-101");
    expect(panel("工资台账").queryByText("E-001")).toBeNull();
    expect(panel("工资台账").getByText("E-101")).toBeVisible();
    expect(ledgerGets(calls)).toHaveLength(before);
  });

  it("两个二级页各有一个「返回工资管理」入口，指回入口页", async () => {
    for (const mode of ["ledger", "payments"] as const) {
      const view = render(<><SalaryWorkspace mode={mode} initialMonth="2026-03" /><Toaster /></>);
      await screen.findByTestId(mode === "payments" ? "page-finance-salary-payments" : "page-finance-salary-ledger");
      expect(screen.getByRole("link", { name: /工资管理/ })).toHaveAttribute("href", "/finance/salary");
      view.unmount();
    }
  });
});

// ------------------------------------------------------------------ 满页可编辑表格

describe("工资管理：工资台账可编辑表格", () => {
  it("车间工人的「基本工资」格只读（生产工资由日报自动汇总），格上给出原因", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    const basic = cell("pl-1", "baseSalary");
    expect(basic).toHaveTextContent("1234.5");
    expect(basic).toHaveAttribute("data-readonly", "true");
    expect(basic).toHaveAttribute("title", expect.stringContaining("由生产日报自动汇总"));
    fireEvent.click(basic);
    expect(screen.queryByTestId("payroll-cell-input-pl-1-baseSalary")).toBeNull();
    expect(patches(calls)).toHaveLength(0);
  });

  it("非车间员工的「基本工资」可改：逐格 PATCH 一个字段", async () => {
    const calls = stubSalary({ ledgers: [officeLedger] });
    await openSalary();
    expect(cell("pl-3", "baseSalary")).not.toHaveAttribute("data-readonly");
    editCell("pl-3", "baseSalary", "5200");
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].url).toBe(`${EP.ledgers}/pl-3`);
    expect(bodyOf(patches(calls)[0])).toEqual({ base_salary: "5200" });
    await expectToast("李四 的基本工资已更新为 5200");
  });

  it("绩效/房补/迟到/旷工/早退五个类目都能逐格改，字段名与后端 DTO 一致", async () => {
    const cases: Array<[string, string, string]> = [["performance", "performance_amount", "300"], ["housing", "housing_allowance", "400"], ["late", "late_deduction", "10"], ["absence", "absence_deduction", "20"], ["earlyLeave", "early_leave_deduction", "5"]];
    for (const [key, field, value] of cases) {
      const calls = stubSalary({ ledgers: [workshopLedger] });
      const view = render(<><SalaryWorkspace mode="ledger" initialMonth="2026-03" /><Toaster /></>);
      await screen.findByTestId("page-finance-salary-ledger");
      editCell("pl-1", key, value);
      await waitFor(() => expect(patches(calls)).toHaveLength(1));
      expect(bodyOf(patches(calls)[0])).toEqual({ [field]: value });
      view.unmount();
    }
  });

  it("清空金额格按 0 提交（后端不接受空字符串）", async () => {
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, performanceAmount: "120.0000" }] });
    await openSalary();
    expect(cell("pl-1", "performance")).toHaveTextContent("120");
    editCell("pl-1", "performance", "");
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(bodyOf(patches(calls)[0])).toEqual({ performance_amount: "0" });
  });

  it("值没改动就不打接口（点一下不等于写一次库）", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    fireEvent.click(cell("pl-1", "performance"));
    fireEvent.keyDown(screen.getByTestId("payroll-cell-input-pl-1-performance"), { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("payroll-cell-input-pl-1-performance")).toBeNull());
    expect(patches(calls)).toHaveLength(0);
  });

  it("非法金额就地报错且不发请求", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    editCell("pl-1", "performance", "1.23456");
    expect(screen.getByTestId("payroll-sheet-error")).toHaveTextContent("金额必须是非负数字，最多 4 位小数");
    expect(patches(calls)).toHaveLength(0);
  });

  it("保存失败时把后端的 422 原因显示在表格里，格子保持原值（不静默吞掉）", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] }, (url, call) => (call.method === "PATCH" ? apiErr(422, "PAYROLL_LEDGER_HAS_PAYABLE", "工资台账已生成工资应付，请先回退或冲销工资应付") : undefined));
    await openSalary();
    editCell("pl-1", "performance", "300");
    await waitFor(() => expect(screen.getByTestId("payroll-sheet-error")).toHaveTextContent("工资台账已生成工资应付，请先回退或冲销工资应付"));
    expect(patches(calls)).toHaveLength(1);
    expect(cell("pl-1", "performance")).toHaveTextContent("0");
    await expectToast("工资台账已生成工资应付，请先回退或冲销工资应付");
  });

  it("保存还没返回就点下一格时，不会把用户刚点开的那一格关掉", async () => {
    const gate: { release: () => void } = { release: () => undefined };
    const calls = stubApi(async (url, call) => {
      if (url.startsWith(EP.importMonth)) return apiOk(importResult());
      if (url.startsWith(EP.ledgers) && call.method === "PATCH") { await new Promise<void>((resolve) => { gate.release = resolve; }); return apiOk({}); }
      if (url.startsWith(EP.ledgers)) return apiOk([workshopLedger]);
      return apiOk([]);
    });
    await openSalary();
    editCell("pl-1", "performance", "300");
    // 保存还挂在网络里，用户已经点开下一格
    fireEvent.click(cell("pl-1", "housing"));
    expect(screen.getByTestId("payroll-cell-input-pl-1-housing")).toBeInTheDocument();
    gate.release();
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(screen.getByTestId("payroll-cell-input-pl-1-housing")).toBeInTheDocument();
  });

  it("已确认/已过期台账：已确认只读（提示先回到草稿），已过期仍可改（后端会把它拉回草稿）", async () => {
    const calls = stubSalary({ ledgers: [confirmedLedger, expiredLedger] });
    await openSalary();
    expect(cell("pl-2", "performance")).toHaveAttribute("data-readonly", "true");
    expect(cell("pl-2", "performance")).toHaveAttribute("title", expect.stringContaining("回到草稿"));
    fireEvent.click(cell("pl-2", "performance"));
    expect(patches(calls)).toHaveLength(0);

    editCell("pl-4", "performance", "88");
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].url).toBe(`${EP.ledgers}/pl-4`);
    expect(bodyOf(patches(calls)[0])).toEqual({ performance_amount: "88" });
  });

  it("只读列（其他增减/应发/已付/未付）不可编辑", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    for (const key of ["other", "payable", "paid", "outstanding", "status", "employeeNo"]) {
      expect(cell("pl-1", key)).toHaveAttribute("data-readonly", "true");
    }
    expect(patches(calls)).toHaveLength(0);
  });

  it("方向键在格与格之间移动（只读格上也能导航），Enter 在当前格进入编辑", async () => {
    stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    // 只读格单击不进入编辑，方向键因此可用（可编辑格单击即编辑，键盘交给输入框）
    fireEvent.click(cell("pl-1", "payable"));
    expect(cell("pl-1", "payable").className).toContain("payroll-sheet-active");
    fireEvent.keyDown(cell("pl-1", "payable"), { key: "ArrowLeft" });
    expect(cell("pl-1", "other").className).toContain("payroll-sheet-active");
    fireEvent.keyDown(cell("pl-1", "other"), { key: "ArrowLeft" });
    expect(cell("pl-1", "earlyLeave").className).toContain("payroll-sheet-active");
    fireEvent.keyDown(cell("pl-1", "earlyLeave"), { key: "Enter" });
    expect(screen.getByTestId("payroll-cell-input-pl-1-earlyLeave")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("payroll-cell-input-pl-1-earlyLeave"), { key: "Escape" });
    expect(screen.queryByTestId("payroll-cell-input-pl-1-earlyLeave")).toBeNull();
  });

  it("表格展示六个可编辑类目列 + 只读格 + 合计行，金额不带四位尾零", async () => {
    stubSalary({ ledgers: [workshopLedger, officeLedger] });
    await openSalary();
    const table = panel("工资台账");
    for (const [key, header] of [["baseSalary", "基本工资"], ["performance", "绩效"], ["housing", "房补"], ["late", "迟到扣款"], ["absence", "旷工扣款"], ["earlyLeave", "早退扣款"], ["other", "其他增减"], ["payable", "应发"], ["paid", "已付"], ["outstanding", "未付"]]) {
      expect(table.getByTestId(`payroll-sheet-head-${key}`)).toHaveTextContent(header);
    }
    expect(table.getByTestId("payroll-cell-pl-1-baseSalary")).toHaveTextContent("1234.5");
    expect(table.getByTestId("payroll-cell-pl-3-baseSalary")).toHaveTextContent("5000");
    // 合计行：1234.5（车间）+ 5000（非车间）
    expect(screen.getByTestId("payroll-sheet-total-baseSalary")).toHaveTextContent("6234.5000");
    expect(screen.getByTestId("payroll-sheet-count")).toHaveTextContent("共 2 条");
  });

  it("本月没有台账时给出空态与自助提示，不渲染空表格", async () => {
    stubSalary();
    await openSalary();
    expect(screen.getByText("本月暂无工资台账")).toBeVisible();
    expect(screen.queryByTestId("payroll-sheet")).toBeNull();
  });

  it("操作列保留全部台账动作（草稿：确认/编辑/删除；已确认：回到草稿/生成应付）", async () => {
    stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }, confirmedLedger] });
    await openSalary();
    const draftActions = within(screen.getByTestId("salary-actions-pl-1"));
    expect(draftActions.getByRole("button", { name: "确认" })).toBeVisible();
    expect(draftActions.getByRole("button", { name: "编辑" })).toBeVisible();
    expect(draftActions.getByRole("button", { name: "删除" })).toBeVisible();
    const confirmedActions = within(screen.getByTestId("salary-actions-pl-2"));
    expect(confirmedActions.getByRole("button", { name: "回到草稿" })).toBeVisible();
    expect(confirmedActions.getByRole("button", { name: "生成应付" })).toBeVisible();
  });
});

// ------------------------------------------------------------------ 详情弹窗

describe("工资管理：台账详情", () => {
  it("「详情」展示全部类目金额、生产日报来源覆盖度与三个明细分区", async () => {
    const snapshot = [
      { report_date: "2026-03-01", order_no: "SO-1", operation_name: "裁剪", wage_mode: "piece_rate", report_count: 2, quantity: "30", duration_hours: "0", amount: "90" },
      { report_date: "2026-03-02", order_no: "SO-2", operation_name: "包装", wage_mode: "time_rate", report_count: 1, quantity: "0", duration_hours: "8", amount: "360" },
    ];
    stubSalary({ ledgers: [{ ...workshopLedger, sourceSnapshot: snapshot }] });
    await openSalary();
    await userEvent.click(within(screen.getByTestId("salary-actions-pl-1")).getByRole("button", { name: "详情" }));
    const dialog = await screen.findByTestId("finance-record-detail");
    for (const label of ["台账编号", "基本工资", "其中生产工资（自动）", "绩效", "房补", "迟到扣款", "旷工扣款", "早退扣款", "其他增减", "应发", "已付", "未付"]) {
      expect(within(dialog).getByText(label)).toBeInTheDocument();
    }
    expect(within(dialog).getByText(/生产日报来源（2 行 \/ 3 条日报）/)).toBeInTheDocument();
    expect(within(dialog).getByText(/覆盖 2 天 \/ 2 张生产单 \/ 2 道工序/)).toBeInTheDocument();
    expect(within(dialog).getByText("工资调整（0 条）")).toBeInTheDocument();
    expect(within(dialog).getByText("工资付款核销（0 条）")).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ 台账动作

describe("工资管理：台账动作的 method + URL + 请求体", () => {
  it("草稿台账「确认」：POST /:id/confirm 且不带 body，成功后重新拉取", async () => {
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] });
    await openSalary();
    await userEvent.click(within(screen.getByTestId("salary-actions-pl-1")).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/confirm")).toHaveLength(1));
    expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/confirm")[0].body).toBeNull();
    expect(ledgerGets(calls)).toHaveLength(2);
  });

  it("草稿台账「删除」：DELETE /:id（不是 POST/PATCH）", async () => {
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] });
    await openSalary();
    await userEvent.click(within(screen.getByTestId("salary-actions-pl-1")).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(callsTo(calls, "/hr/payroll-ledgers/pl-1")).toHaveLength(1));
    expect(callsTo(calls, "/hr/payroll-ledgers/pl-1")[0].method).toBe("DELETE");
  });

  it("草稿台账「编辑」：弹窗预填当前值（含新增类目），保存发出 PATCH /:id", async () => {
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, status: "draft", performanceAmount: "120.0000", housingAllowance: "300.0000" }] });
    await openSalary();
    await userEvent.click(within(screen.getByTestId("salary-actions-pl-1")).getByRole("button", { name: "编辑" }));
    expect((screen.getByTestId("action-field-base_salary") as HTMLInputElement).value).toBe("0.0000");
    expect((screen.getByTestId("action-field-performance_amount") as HTMLInputElement).value).toBe("120.0000");
    expect((screen.getByTestId("action-field-housing_allowance") as HTMLInputElement).value).toBe("300.0000");
    setValue("action-field-performance_amount", "200");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, "/hr/payroll-ledgers/pl-1")).toHaveLength(1));
    const call = callsTo(calls, "/hr/payroll-ledgers/pl-1")[0];
    expect(call.method).toBe("PATCH");
    expect(bodyOf(call)).toMatchObject({ employee_id: "emp-1", performance_amount: "200", currency: "CNY" });
  });

  it("已确认台账「编辑」：修改原因必填，不填不发请求；后端拒绝时弹窗不关并显示原因", async () => {
    const calls = stubSalary({ ledgers: [confirmedLedger] }, (url, call) => (call.method === "PATCH" ? apiErr(422, "PAYROLL_LEDGER_HAS_PAYABLE", "请先回退或冲销工资应付") : undefined));
    await openSalary();
    await userEvent.click(within(screen.getByTestId("salary-actions-pl-2")).getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(screen.getByTestId("action-dialog-error")).toHaveTextContent("请填写修改原因");
    expect(callsTo(calls, "/hr/payroll-ledgers/pl-2")).toHaveLength(0);
    setValue("action-field-reason", "补发差额");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(screen.getByTestId("action-dialog-error")).toHaveTextContent("请先回退或冲销工资应付"));
    expect(screen.getByTestId("action-dialog")).toBeInTheDocument();
  });

  it("回到草稿：POST /:id/reopen，body 只有 reason", async () => {
    const calls = stubSalary({ ledgers: [confirmedLedger] });
    await openSalary();
    await userEvent.click(within(screen.getByTestId("salary-actions-pl-2")).getByRole("button", { name: "回到草稿" }));
    setValue("action-field-reason", "重新核算");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-2/reopen")).toHaveLength(1));
    expect(bodyOf(postsTo(calls, "/hr/payroll-ledgers/pl-2/reopen")[0])).toEqual({ reason: "重新核算" });
  });

  it("未生成应付时「生成应付」：POST /:id/payable 且 body 是空对象", async () => {
    const calls = stubSalary({ ledgers: [confirmedLedger] });
    await openSalary();
    await userEvent.click(within(screen.getByTestId("salary-actions-pl-2")).getByRole("button", { name: "生成应付" }));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-2/payable")).toHaveLength(1));
    expect(bodyOf(postsTo(calls, "/hr/payroll-ledgers/pl-2/payable")[0])).toEqual({});
  });

  it("已有草稿应付时显示「应付草稿」并给出确认入口，不再显示生成应付", async () => {
    const calls = stubSalary({ ledgers: [confirmedLedger], payables: [{ id: "pp-1", ledgerId: "pl-2", payableNo: "PAY-001", amount: "1234.5000", currency: "CNY", status: "draft" }] });
    await openSalary();
    const actions = within(screen.getByTestId("salary-actions-pl-2"));
    expect(screen.getByTestId("salary-payable-status-pl-2")).toHaveTextContent("应付草稿");
    expect(actions.queryByRole("button", { name: "生成应付" })).toBeNull();
    await userEvent.click(actions.getByRole("button", { name: "确认应付" }));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-payables/pp-1/confirm")).toHaveLength(1));
  });

  it("已付清台账出现「关闭」：POST /:id/close", async () => {
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, status: "paid", outstandingAmount: "0.0000" }] });
    await openSalary();
    await userEvent.click(within(screen.getByTestId("salary-actions-pl-1")).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/close")).toHaveLength(1));
  });

  it("部分支付台账不提供任何行内动作（后端 update 会 422 拒绝编辑），状态列仍显示中文", async () => {
    stubSalary({ ledgers: [{ ...workshopLedger, status: "partially_paid" }] });
    await openSalary();
    expect(cell("pl-1", "status")).toHaveTextContent("部分支付");
    const actions = within(screen.getByTestId("salary-actions-pl-1"));
    for (const name of ["确认", "编辑", "删除", "回到草稿", "生成应付", "确认应付", "关闭"]) {
      expect(actions.queryByRole("button", { name })).toBeNull();
    }
  });
});

// ------------------------------------------------------------------ 工资付款二级页

describe("工资管理：工资付款（当月台账只留总工资，操作在行内）", () => {
  it("把当月工资台账搬过来：一行一个员工，类目列全部收掉，只留总工资/已付/未付", async () => {
    // 非车间台账：这一页只关心应发合计，所以直接给它自己的应发金额
    stubSalary({ ledgers: [confirmedLedger, { ...officeLedger, payableAmount: "5000.0000", outstandingAmount: "5000.0000" }] });
    await openSalary("payments");
    const table = panel("工资付款");
    expect(table.getByTestId("payroll-pay-row-pl-2")).toBeInTheDocument();
    expect(table.getByTestId("payroll-pay-row-pl-3")).toBeInTheDocument();
    // 只有总工资（+ 付款状态），没有基本工资/绩效/房补/扣款这些类目列
    for (const key of ["total", "paid", "outstanding", "status", "currency"]) {
      expect(table.getByTestId(`payroll-sheet-head-${key}`)).toBeInTheDocument();
    }
    for (const key of ["baseSalary", "performance", "housing", "late", "absence", "earlyLeave", "other"]) {
      expect(table.queryByTestId(`payroll-sheet-head-${key}`)).toBeNull();
      expect(table.queryByTestId(`payroll-cell-pl-2-${key}`)).toBeNull();
    }
    expect(table.getByTestId("payroll-cell-pl-2-total")).toHaveTextContent("1234.5");
    expect(table.getByTestId("payroll-cell-pl-3-total")).toHaveTextContent("5000");
    // 合计行：把筛选结果的总工资加起来，方便一眼看出本月要发多少
    expect(screen.getByTestId("payroll-sheet-total-total")).toHaveTextContent("6234.5000");
    expect(screen.getByTestId("payroll-sheet-count")).toHaveTextContent("共 2 条");
  });

  it("行内付款：金额默认等于未付，点「付款」发出一次 POST /:id/pay（含付款日期与方式）", async () => {
    const calls = stubSalary({ ledgers: [confirmedLedger] });
    await openSalary("payments");
    expect((screen.getByTestId("salary-pay-amount-pl-2") as HTMLInputElement).value).toBe("1234.5");
    setValue("salary-payment-date", "2026-03-25");
    setValue("salary-payment-method", "现金");
    await userEvent.click(screen.getByTestId("salary-pay-button-pl-2"));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-2/pay")).toHaveLength(1));
    const call = postsTo(calls, "/hr/payroll-ledgers/pl-2/pay")[0];
    expect(bodyOf(call)).toEqual({ amount: "1234.5", payment_date: "2026-03-25", payment_method: "现金" });
    await expectToast("张三 已付款 1234.5");
  });

  it("行内付款：可以只付一部分，也可以改金额后再提交", async () => {
    const calls = stubSalary({ ledgers: [confirmedLedger] });
    await openSalary("payments");
    setValue("salary-pay-amount-pl-2", "500");
    await userEvent.click(screen.getByTestId("salary-pay-button-pl-2"));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-2/pay")).toHaveLength(1));
    expect(bodyOf(postsTo(calls, "/hr/payroll-ledgers/pl-2/pay")[0]).amount).toBe("500");
  });

  it("行内付款：超过未付、金额非法、金额为 0 都不发请求（本地先拦一次）", async () => {
    const calls = stubSalary({ ledgers: [confirmedLedger] });
    await openSalary("payments");
    setValue("salary-pay-amount-pl-2", "9999");
    await userEvent.click(screen.getByTestId("salary-pay-button-pl-2"));
    await expectToast("付款金额不能超过未付 1234.5");
    setValue("salary-pay-amount-pl-2", "1.23456");
    await userEvent.click(screen.getByTestId("salary-pay-button-pl-2"));
    await expectToast("付款金额必须是不小于 0 的数字，最多 4 位小数");
    setValue("salary-pay-amount-pl-2", "0");
    await userEvent.click(screen.getByTestId("salary-pay-button-pl-2"));
    expect(postsTo(calls, "/hr/payroll-ledgers/pl-2/pay")).toHaveLength(0);
  });

  it("行内付款：后端拒绝时 toast 显示原因，不发成功提示", async () => {
    stubSalary({ ledgers: [confirmedLedger] }, (url, call) => (url.endsWith("/pay") && call.method === "POST" ? apiErr(422, "PAYROLL_PAYABLE_NOT_PAYABLE", "该台账的工资应付已冲销，不能再次付款") : undefined));
    await openSalary("payments");
    await userEvent.click(screen.getByTestId("salary-pay-button-pl-2"));
    await expectToast("该台账的工资应付已冲销，不能再次付款");
    expect(screen.queryByText(/已付款/)).toBeNull();
  });

  it("只有已确认/部分支付且未付 > 0 的台账给付款入口，其余行只给原因", async () => {
    stubSalary({ ledgers: [confirmedLedger, { ...workshopLedger, id: "pl-1" }, { ...confirmedLedger, id: "pl-5", status: "paid", paidAmount: "1234.5000", outstandingAmount: "0.0000" }, expiredLedger] });
    await openSalary("payments");
    expect(screen.getByTestId("salary-pay-button-pl-2")).toBeVisible();
    expect(screen.getByTestId("salary-pay-hint-pl-1")).toHaveTextContent("待确认");
    expect(screen.getByTestId("salary-pay-hint-pl-5")).toHaveTextContent("已付清");
    expect(screen.getByTestId("salary-pay-hint-pl-4")).toHaveTextContent("已过期");
    expect(screen.queryByTestId("salary-pay-amount-pl-1")).toBeNull();
    expect(screen.queryByTestId("salary-pay-button-pl-4")).toBeNull();
  });

  it("行内冲销：已付过的行出现「冲销」，原因必填，提交 POST /:id/unpay", async () => {
    const calls = stubSalary({ ledgers: [paidLedger] });
    await openSalary("payments");
    expect(screen.getByTestId("payroll-cell-pl-9-paid")).toHaveTextContent("500");
    expect(screen.getByTestId("payroll-cell-pl-9-outstanding")).toHaveTextContent("734.5");
    expect(screen.queryByTestId("salary-unpay-button-pl-2")).toBeNull();
    await userEvent.click(screen.getByTestId("salary-unpay-button-pl-9"));
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(screen.getByTestId("action-dialog-error")).toHaveTextContent("请填写冲销原因");
    expect(postsTo(calls, "/hr/payroll-ledgers/pl-9/unpay")).toHaveLength(0);
    setValue("action-field-reason", "银行退回");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-9/unpay")).toHaveLength(1));
    expect(bodyOf(postsTo(calls, "/hr/payroll-ledgers/pl-9/unpay")[0])).toEqual({ reason: "银行退回" });
  });

  it("没有已过账付款的行不出现「冲销」，草稿台账也不出现", async () => {
    stubSalary({ ledgers: [confirmedLedger, { ...workshopLedger, id: "pl-1" }] });
    await openSalary("payments");
    expect(screen.queryByTestId("salary-unpay-button-pl-2")).toBeNull();
    expect(screen.queryByTestId("salary-unpay-button-pl-1")).toBeNull();
  });

  it("本月没有台账时给出空态并指路到工资台账页", async () => {
    stubSalary({ ledgers: [] });
    await openSalary("payments");
    expect(screen.getByTestId("salary-payment-empty")).toHaveTextContent("请先到「工资台账」页导入并确认本月台账");
    expect(screen.queryByTestId("payroll-sheet")).toBeNull();
  });

  it("员工姓名/工号筛选与台账页同口径，且行内操作只作用于该行", async () => {
    const calls = stubSalary({ ledgers: [confirmedLedger, { ...officeLedger, status: "confirmed" }] });
    await openSalary("payments");
    setValue("salary-employee-filter", "李四");
    expect(screen.getByTestId("payroll-pay-row-pl-3")).toBeInTheDocument();
    expect(screen.queryByTestId("payroll-pay-row-pl-2")).toBeNull();
    await userEvent.click(screen.getByTestId("salary-pay-button-pl-3"));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-3/pay")).toHaveLength(1));
    expect(postsTo(calls, "/hr/payroll-ledgers/pl-2/pay")).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ 新建台账

describe("工资管理：新建工资台账", () => {
  it("员工必填；提交 POST /hr/payroll-ledgers/generate 且新增类目字段名完整", async () => {
    const calls = stubSalary({ employees: [workshopEmployee] });
    await openSalary();
    await userEvent.click(screen.getByTestId("salary-create-ledger"));
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(screen.getByTestId("action-dialog-error")).toHaveTextContent("请填写员工姓名");
    expect(postsTo(calls, "/hr/payroll-ledgers/generate")).toHaveLength(0);

    await pickOption("action-field-employee_name", "E-001 / 张三 / 车间");
    setValue("action-field-period_start", "2026-03-01");
    setValue("action-field-period_end", "2026-03-31");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/generate")).toHaveLength(1));
    const body = bodyOf(postsTo(calls, "/hr/payroll-ledgers/generate")[0]);
    expect(body.employee_name).toBe("张三");
    expect(body.period_start).toBe("2026-03-01");
    expect(body.period_end).toBe("2026-03-31");
    expect(body.currency).toBe("CNY");
    // 六个类目 + 历史类目都必须下发，否则后端的 whitelist 会把没传的字段当 0
    for (const field of ["base_salary", "performance_amount", "housing_allowance", "late_deduction", "absence_deduction", "early_leave_deduction", "overtime_amount", "attendance_deduction", "allowance_amount", "social_insurance", "individual_tax", "other_adjustment"]) {
      expect(body[field]).toBe("0");
    }
  });
});

// ------------------------------------------------------------------ 失败态

describe("工资管理：失败态与权限", () => {
  it("台账接口 403：整表落到错误态并显示后端 message（不渲染成空表），重试成功后恢复", async () => {
    let fail = true;
    const calls = stubSalary({ ledgers: [workshopLedger] }, (url, call) => (fail && call.method === "GET" && url.startsWith(EP.ledgers) ? apiErr(403, "FORBIDDEN", "无权访问工资台账") : undefined));
    await openSalary();
    expect(screen.getByTestId("error-state")).toHaveTextContent("无权访问工资台账");
    expect(screen.queryByTestId("salary-ledger-panel")).toBeNull();
    fail = false;
    fireEvent.click(screen.getByTestId("error-state-retry"));
    await waitFor(() => expect(screen.getByTestId("salary-ledger-panel")).toBeVisible());
    expect(ledgerGets(calls).length).toBeGreaterThan(1);
  });

  it("动作 409：toast 显示后端 message 且不出现成功提示", async () => {
    stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] }, (url) => (url.endsWith("/confirm") ? apiErr(409, "PAYROLL_NOT_CONFIRMABLE", "工资台账已被其他操作处理") : undefined));
    await openSalary();
    await userEvent.click(within(screen.getByTestId("salary-actions-pl-1")).getByRole("button", { name: "确认" }));
    await expectToast("工资台账已被其他操作处理");
    expect(screen.queryByText("工资台账已确认")).toBeNull();
  });

  it("非 API 异常（网络中断）落到兜底文案「工资数据加载失败」", async () => {
    stubSalary({}, (url, call) => { if (call.method === "GET" && url.startsWith(EP.ledgers)) throw new TypeError("Failed to fetch"); return undefined; });
    await openSalary();
    expect(screen.getByTestId("error-state")).toHaveTextContent("工资数据加载失败");
  });
});

// ------------------------------------------------------------------ 已知缺陷（保持可见）

describe("工资管理：已知缺陷", () => {
  it("KNOWN_DEFECT：重名员工在下拉里选了具体工号，请求体仍只带姓名 → 台账永远建不出来", async () => {
    const calls = stubSalary({ employees: [workshopEmployee, { ...workshopEmployee, id: "emp-9", employeeNo: "E-900" }] });
    await openSalary();
    await userEvent.click(screen.getByTestId("salary-create-ledger"));
    await pickOption("action-field-employee_name", "E-001 / 张三 / 车间");
    setValue("action-field-period_start", "2026-03-01");
    setValue("action-field-period_end", "2026-03-31");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/generate")).toHaveLength(1));
    const body = bodyOf(postsTo(calls, "/hr/payroll-ledgers/generate")[0]);
    // 后端 EMPLOYEE_NAME_AMBIGUOUS：重名时只给 name 会被 422 拒绝
    expect(body.employee_name).toBe("张三");
    expect(body.employee_id).toBeUndefined();
  });

  it("KNOWN_DEFECT：行内动作按钮没有 in-flight 守卫，连点两次会发出两次 POST", async () => {
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] });
    await openSalary();
    const button = within(screen.getByTestId("salary-actions-pl-1")).getByRole("button", { name: "确认" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/confirm")).toHaveLength(2));
  });
});
