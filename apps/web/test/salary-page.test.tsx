// app/finance/salary/page.tsx 的**行为**测试：真实渲染 + 真实点击 + 断言真实发出的请求。
//
// 被测面的数据契约（全部来自页面源码，不是想象）：
//   GET    /production/employees                         员工（「新建工资台账」的姓名下拉）
//   GET    /production/departments                        部门筛选下拉
//   GET    /production/positions[?department_id=]          岗位筛选下拉（按所选部门收窄）
//   GET    /hr/payroll-ledgers[?month=&department_id=&position_id=]  工资台账（满页表格）
//   GET    /hr/payroll-payables                           工资应付（决定「未生成 / 应付草稿 / 应付已确认」与按钮）
//   GET    /hr/salary-payments                            工资付款
//   POST   /hr/payroll-ledgers/generate                   新建台账（employee_name + 期间 + 9 个金额字段 + currency）
//   PATCH  /hr/payroll-ledgers/:id                        编辑（草稿；已确认必须带 reason）
//   DELETE /hr/payroll-ledgers/:id                        删除（仅草稿）
//   POST   /hr/payroll-ledgers/:id/confirm                确认（无 body）
//   POST   /hr/payroll-ledgers/:id/reopen                 回到草稿（body: reason）
//   POST   /hr/payroll-ledgers/:id/payable                生成应付（body: {}）
//   POST   /hr/payroll-ledgers/:id/close                  关闭（仅 paid）
//   POST   /hr/payroll-payables/:id/confirm               确认应付
//   POST   /hr/salary-payments                            新建工资付款
//   POST   /hr/salary-payments/:id/post                   核销过账（body: allocations:[{ledger_id, amount}]）
//   POST   /hr/salary-payments/:id/reverse                冲销（body: reason）
//
// 这些路径/method 与 apps/api/src/modules/hr/hr.controller.ts 一一对应：编辑只注册了 PATCH、
// 删除只注册了 DELETE；确认/回退/生成应付/关闭/过账/冲销都是 POST。写错 method 会 404，写错字段名
// 会被 DTO 的 whitelist 丢掉，所以这里对 method + 完整 URL + 请求体逐条断言。
//
// 2026-09-14 变化：筛选从「期间起止」换成「月 + 部门 + 岗位」（前三者走服务端参数），
// 车间/非车间两张表合并为一张满页表格，并支持双击行查看台账详情。
// 动作结果只经 toast 呈现（notifySuccess / notifyError），因此渲染时一并挂 <Toaster />。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SalaryPage from "../app/finance/salary/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  employees: "/api/v1/production/employees",
  departments: "/api/v1/production/departments",
  positions: "/api/v1/production/positions",
  ledgers: "/api/v1/hr/payroll-ledgers",
  payables: "/api/v1/hr/payroll-payables",
  payments: "/api/v1/hr/salary-payments",
  currencies: "/api/v1/dictionaries/currency/items",
} as const;

type Handler = (url: string, call: StubbedCall) => Response | undefined | Promise<Response | undefined>;

/**
 * 桩：每个列表接口各回自己那一份数据（默认空），extra 优先执行，用于注入 403 / 409 等特例。
 * ledger / payable 前缀下既有 GET（列表）又有 POST/PATCH/DELETE（动作），因此按 method 分流。
 */
function stubSalary(data: Partial<Record<keyof typeof EP, unknown[]>> = {}, extra?: Handler) {
  return stubApi(async (url, call) => {
    const injected = await extra?.(url, call);
    if (injected) return injected;
    if (url.startsWith(EP.employees)) return apiOk(data.employees ?? []);
    if (url.startsWith(EP.departments)) return apiOk(data.departments ?? []);
    if (url.startsWith(EP.positions)) return apiOk(data.positions ?? []);
    if (url.startsWith(EP.payables)) return apiOk(data.payables ?? []);
    if (url.startsWith(EP.payments)) return apiOk(data.payments ?? []);
    if (url.startsWith(EP.currencies)) return apiOk(data.currencies ?? []);
    if (url.startsWith(EP.ledgers)) return call.method === "GET" ? apiOk(data.ledgers ?? []) : apiOk({});
    return apiOk({});
  });
}

/** 渲染并等到数据加载完成（页面根出现）。 */
async function openSalary() {
  render(<><SalaryPage /><Toaster /></>);
  await screen.findByTestId("page-finance-salary");
}

/** 取某个面板（section）的作用域，避免同名文本/按钮跨表歧义。 */
function panel(title: string) {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (!section) throw new Error(`找不到面板：${title}`);
  return within(section as HTMLElement);
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const postsTo = (calls: StubbedCall[], suffix: string) => callsTo(calls, suffix).filter((call) => call.method === "POST");
const ledgerGets = (calls: StubbedCall[]) => calls.filter((call) => call.method === "GET" && (call.url === EP.ledgers || call.url.startsWith(`${EP.ledgers}?`)));
const setValue = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
/** 打开 Radix Select 并选中某一项（选项文案即 value 的可读形式）。 */
async function pickOption(testId: string, optionName: string | RegExp) {
  await userEvent.click(screen.getByTestId(testId));
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

// ------------------------------------------------------------------ 夹具

const department = { id: "dep-1", name: "生产部", code: "D001" };
const otherDepartment = { id: "dep-2", name: "行政部", code: "D002" };
const position = { id: "pos-1", name: "缝制工", code: "P001", departmentId: "dep-1" };
const otherPosition = { id: "pos-2", name: "包装工", code: "P002", departmentId: "dep-1" };
const workshopEmployee = { id: "emp-1", employeeNo: "E-001", name: "张三", employeeType: "workshop", department, position };
const officeEmployee = { id: "emp-2", employeeNo: "E-101", name: "李四", employeeType: "non_workshop", department: otherDepartment, position: otherPosition };

/** 已确认台账：金额字段给足小数位，贴近后端 Decimal(18,4).toFixed(4) 的真实返回。 */
const workshopLedger = {
  id: "pl-1", ledgerNo: "PAYROLL-001", employeeId: "emp-1",
  periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-03-31T00:00:00.000Z", currency: "CNY",
  baseSalary: "5000.0000", productionSourceAmount: "1234.5000", overtimeAmount: "100.0000",
  attendanceDeduction: "50.0000", performanceAmount: "0.0000", allowanceAmount: "200.0000",
  socialInsurance: "300.0000", individualTax: "80.0000", otherAdjustment: "0.0000",
  payableAmount: "6104.5000", paidAmount: "0.0000", outstandingAmount: "6104.5000",
  status: "confirmed", remark: null, sourceSnapshot: [], adjustments: [], allocations: [],
  employee: workshopEmployee,
};
const expiredLedger = { ...workshopLedger, id: "pl-2", status: "expired" };
const officeLedger = { ...workshopLedger, id: "pl-3", ledgerNo: "PAYROLL-003", employeeId: "emp-2", employee: officeEmployee };
const payment = { id: "sp-1", paymentNo: "SALARY-001", paymentDate: "2026-03-05T08:00:00.000Z", amount: "3000.0000", currency: "CNY", status: "draft" };

// ------------------------------------------------------------------ 加载门禁与筛选

describe("工资管理：加载门禁与筛选请求契约", () => {
  it("加载中只有加载态；完成后页面根出现，列表接口各被 GET 一次", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    render(<><SalaryPage /><Toaster /></>);
    expect(screen.getByTestId("loading-state")).toBeInTheDocument();
    expect(screen.queryByTestId("page-finance-salary")).toBeNull();
    await screen.findByTestId("page-finance-salary");
    for (const path of [EP.employees, EP.departments, EP.positions, EP.payables, EP.payments, EP.currencies]) {
      expect(callsTo(calls, path).filter((call) => call.method === "GET")).toHaveLength(1);
    }
    expect(ledgerGets(calls)).toHaveLength(1);
    expect(ledgerGets(calls)[0].url).toBe(EP.ledgers);
  });

  it("按月份筛选：带 month 重新拉取台账，筛选值保留在输入框里", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    setValue("salary-month-filter", "2026-03");
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url === `${EP.ledgers}?month=2026-03`)).toBe(true));
    expect((screen.getByTestId("salary-month-filter") as HTMLInputElement).value).toBe("2026-03");
  });

  it("按部门筛选：带 department_id 重新拉取台账，岗位下拉同时按该部门收窄", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger], departments: [department, otherDepartment], positions: [position, otherPosition] });
    await openSalary();
    await pickOption("salary-department-filter", "生产部");
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url === `${EP.ledgers}?department_id=dep-1`)).toBe(true));
    expect(calls.some((call) => call.url === `${EP.positions}?department_id=dep-1`)).toBe(true);
  });

  it("按岗位筛选：带 position_id 重新拉取台账", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger], departments: [department], positions: [position] });
    await openSalary();
    await pickOption("salary-position-filter", "缝制工");
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url === `${EP.ledgers}?position_id=pos-1`)).toBe(true));
  });

  it("切换部门会清空已选岗位（否则会查出空集）", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger], departments: [department, otherDepartment], positions: [position] });
    await openSalary();
    await pickOption("salary-position-filter", "缝制工");
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url.includes("position_id=pos-1"))).toBe(true));
    await pickOption("salary-department-filter", "生产部");
    await waitFor(() => expect(ledgerGets(calls).some((call) => call.url === `${EP.ledgers}?department_id=dep-1`)).toBe(true));
    expect(ledgerGets(calls).some((call) => call.url.includes("position_id=pos-1") && call.url.includes("department_id"))).toBe(false);
  });
});

// ------------------------------------------------------------------ 列表渲染

describe("工资管理：满页表格渲染", () => {
  it("一张表里同时展示部门/岗位/类型、金额带币种、状态中文化、过期附提示", async () => {
    stubSalary({ ledgers: [workshopLedger, officeLedger, expiredLedger] });
    await openSalary();
    const table = panel("工资台账");
    // 同一员工在本用例里有两条台账（已确认 + 已过期），因此用 getAllByText
    expect(table.getAllByText("E-001 / 张三").length).toBe(2);
    expect(table.getByText("E-101 / 李四")).toBeVisible();
    expect(table.getAllByText("生产部").length).toBe(2);
    expect(table.getByText("行政部")).toBeVisible();
    expect(table.getAllByText("缝制工").length).toBe(2);
    expect(table.getByText("包装工")).toBeVisible();
    expect(table.getAllByText("车间").length).toBe(2);
    expect(table.getByText("非车间")).toBeVisible();
    expect(table.getAllByText("2026-03-01 至 2026-03-31").length).toBe(3);
    expect(table.getAllByText("6104.5000 CNY").length).toBeGreaterThan(0);
    expect(table.getAllByText("已确认").length).toBeGreaterThan(0);
    expect(table.getByText("已过期（需重新结算）")).toBeVisible();
  });

  it("工资应付列：未生成显示「未生成」，有草稿应付时显示中文化状态并给出确认按钮", async () => {
    stubSalary({ ledgers: [workshopLedger], payables: [{ id: "pp-1", ledgerId: "pl-1", payableNo: "PAY-001", amount: "6104.5000", currency: "CNY", status: "draft" }] });
    await openSalary();
    const table = panel("工资台账");
    expect(table.getByText("应付草稿")).toBeVisible();
    expect(table.queryByRole("button", { name: "生成应付" })).toBeNull();
    expect(table.getByRole("button", { name: "确认应付" })).toBeVisible();
  });

  it("工资付款表：日期截断、金额带币种、状态中文化", async () => {
    stubSalary({ ledgers: [workshopLedger], payments: [payment] });
    await openSalary();
    const table = panel("工资付款");
    expect(table.getByText("SALARY-001")).toBeVisible();
    expect(table.getByText("2026-03-05")).toBeVisible();
    expect(table.getByText("3000.0000 CNY")).toBeVisible();
    expect(table.getByText("草稿")).toBeVisible();
  });

  it("所有列表为空时两个区块回落到空态（不留加载态、不渲染空表格）", async () => {
    stubSalary();
    await openSalary();
    expect(screen.getByText("暂无工资台账")).toBeVisible();
    expect(screen.getByText("暂无工资付款")).toBeVisible();
    expect(screen.queryByTestId("data-table")).toBeNull();
  });

  it("员工姓名/工号筛选是本地过滤：只留下匹配行且不发新请求", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger, officeLedger] });
    await openSalary();
    const before = ledgerGets(calls).length;
    setValue("salary-employee-filter", "E-101");
    expect(panel("工资台账").queryByText("E-001 / 张三")).toBeNull();
    expect(panel("工资台账").getByText("E-101 / 李四")).toBeVisible();
    expect(ledgerGets(calls)).toHaveLength(before);
  });

  it("双击台账行弹出详情弹窗，展示全部金额字段与三个明细分区", async () => {
    stubSalary({ ledgers: [{ ...workshopLedger, sourceSnapshot: [{ order_no: "SO-1", wage_mode: "piece_rate", quantity: "30.0000", duration_hours: "0", amount: "90.0000" }] }] });
    await openSalary();
    fireEvent.doubleClick(screen.getAllByTestId("data-table-row")[0]);
    const dialog = await screen.findByTestId("finance-record-detail");
    for (const label of ["台账编号", "员工", "部门", "岗位", "基本工资", "生产来源", "加班工资", "考勤扣款", "绩效金额", "补贴金额", "社保", "个税", "其他调整", "应发", "已付", "未付"]) {
      expect(within(dialog).getByText(label)).toBeInTheDocument();
    }
    expect(within(dialog).getByText("生产日报来源（1 条）")).toBeInTheDocument();
    expect(within(dialog).getByText("工资调整（0 条）")).toBeInTheDocument();
    expect(within(dialog).getByText("工资付款核销（0 条）")).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ 台账动作

describe("工资管理：台账动作的 method + URL + 请求体", () => {
  it("草稿台账「确认」：POST /:id/confirm 且不带 body，成功后重新拉取", async () => {
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] });
    await openSalary();
    await userEvent.click(panel("工资台账").getByRole("button", { name: "确认" }));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/confirm")).toHaveLength(1));
    expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/confirm")[0].body).toBeNull();
    expect(callsTo(calls, EP.ledgers)).toHaveLength(2);
  });

  it("草稿台账「删除」：DELETE /:id（不是 POST/PATCH）", async () => {
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] });
    await openSalary();
    await userEvent.click(panel("工资台账").getByRole("button", { name: "删除" }));
    await waitFor(() => expect(callsTo(calls, "/hr/payroll-ledgers/pl-1")).toHaveLength(1));
    expect(callsTo(calls, "/hr/payroll-ledgers/pl-1")[0].method).toBe("DELETE");
  });

  it("草稿台账「编辑」：弹窗预填当前值，保存发出 PATCH /:id 且带上用户改后的值", async () => {
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] });
    await openSalary();
    await userEvent.click(panel("工资台账").getByRole("button", { name: "编辑" }));
    expect((screen.getByTestId("action-field-base_salary") as HTMLInputElement).value).toBe("5000.0000");
    setValue("action-field-base_salary", "5200");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, "/hr/payroll-ledgers/pl-1")).toHaveLength(1));
    const call = callsTo(calls, "/hr/payroll-ledgers/pl-1")[0];
    expect(call.method).toBe("PATCH");
    expect(bodyOf(call)).toMatchObject({ employee_id: "emp-1", base_salary: "5200", currency: "CNY" });
  });

  it("已确认台账「编辑」：修改原因必填，不填不发请求，填了随 PATCH 一起下发", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    await userEvent.click(panel("工资台账").getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(screen.getByTestId("action-dialog-error")).toHaveTextContent("请填写修改原因");
    expect(callsTo(calls, "/hr/payroll-ledgers/pl-1")).toHaveLength(0);
    setValue("action-field-reason", "补发差额");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, "/hr/payroll-ledgers/pl-1")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/hr/payroll-ledgers/pl-1")[0]).reason).toBe("补发差额");
  });

  it("回到草稿：POST /:id/reopen，body 只有 reason", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    await userEvent.click(panel("工资台账").getByRole("button", { name: "回到草稿" }));
    setValue("action-field-reason", "重新核算");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/reopen")).toHaveLength(1));
    expect(bodyOf(postsTo(calls, "/hr/payroll-ledgers/pl-1/reopen")[0])).toEqual({ reason: "重新核算" });
  });

  it("已过期台账同样可以回到草稿（后端 canReopenPayroll 接受 confirmed/expired）", async () => {
    const calls = stubSalary({ ledgers: [expiredLedger] });
    await openSalary();
    await userEvent.click(panel("工资台账").getByRole("button", { name: "回到草稿" }));
    setValue("action-field-reason", "重算");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-2/reopen")).toHaveLength(1));
  });

  it("未生成应付时「生成应付」：POST /:id/payable 且 body 是空对象", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    expect(panel("工资台账").getByText("未生成")).toBeVisible();
    await userEvent.click(panel("工资台账").getByRole("button", { name: "生成应付" }));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/payable")).toHaveLength(1));
    expect(bodyOf(postsTo(calls, "/hr/payroll-ledgers/pl-1/payable")[0])).toEqual({});
  });

  it("已付清台账出现「关闭」：POST /:id/close", async () => {
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, status: "paid", outstandingAmount: "0.0000" }] });
    await openSalary();
    await userEvent.click(panel("工资台账").getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/close")).toHaveLength(1));
  });

  it("业务规则分支：部分支付台账不提供任何行内动作（后端 update 会 422 拒绝编辑）", async () => {
    stubSalary({ ledgers: [{ ...workshopLedger, status: "partially_paid" }] });
    await openSalary();
    const table = panel("工资台账");
    expect(table.getByText("部分支付")).toBeVisible();
    for (const name of ["确认", "编辑", "删除", "回到草稿", "生成应付", "确认应付", "关闭"]) {
      expect(table.queryByRole("button", { name })).toBeNull();
    }
  });
});

// ------------------------------------------------------------------ 新建

describe("工资管理：新建台账与新建工资付款", () => {
  it("「新建工资台账」：员工必填，提交 POST /hr/payroll-ledgers/generate 且字段名完整", async () => {
    const calls = stubSalary({ employees: [workshopEmployee] });
    await openSalary();
    await userEvent.click(screen.getByRole("button", { name: "新建工资台账" }));
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(screen.getByTestId("action-dialog-error")).toHaveTextContent("请填写员工姓名");
    expect(postsTo(calls, "/hr/payroll-ledgers/generate")).toHaveLength(0);

    await pickOption("action-field-employee_name", "E-001 / 张三 / 车间");
    setValue("action-field-period_start", "2026-03-01");
    setValue("action-field-period_end", "2026-03-31");
    setValue("action-field-base_salary", "5000");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/generate")).toHaveLength(1));
    const body = bodyOf(postsTo(calls, "/hr/payroll-ledgers/generate")[0]);
    expect(body.employee_name).toBe("张三");
    expect(body.period_start).toBe("2026-03-01");
    expect(body.period_end).toBe("2026-03-31");
    expect(body.currency).toBe("CNY");
    for (const field of ["overtime_amount", "attendance_deduction", "performance_amount", "allowance_amount", "social_insurance", "individual_tax", "other_adjustment"]) {
      expect(body[field]).toBe("0");
    }
  });

  it("「新建工资付款」：金额必填，提交 POST /hr/salary-payments 且付款日期默认今天", async () => {
    const calls = stubSalary();
    await openSalary();
    const today = new Date().toISOString().slice(0, 10);
    await userEvent.click(screen.getByRole("button", { name: "新建工资付款" }));
    expect((screen.getByTestId("action-field-payment_date") as HTMLInputElement).value).toBe(today);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(screen.getByTestId("action-dialog-error")).toHaveTextContent("请填写付款金额");
    setValue("action-field-amount", "3000");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/hr/salary-payments")).toHaveLength(1));
    expect(bodyOf(postsTo(calls, "/hr/salary-payments")[0])).toMatchObject({ amount: "3000", payment_date: today, payment_method: "银行转账", currency: "CNY" });
  });
});

// ------------------------------------------------------------------ 工资付款核销与冲销

describe("工资管理：工资付款核销与冲销", () => {
  it("草稿付款「核销过账」：只列可核销台账，提交 POST /salary-payments/:id/post 带 allocations", async () => {
    const calls = stubSalary({
      ledgers: [workshopLedger, { ...officeLedger, status: "draft" }],
      payments: [payment],
    });
    await openSalary();
    await userEvent.click(panel("工资付款").getByRole("button", { name: "核销过账" }));
    await pickOption("action-field-ledger_id", /E-001 \/ 张三/);
    setValue("action-field-amount", "3000");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/hr/salary-payments/sp-1/post")).toHaveLength(1));
    const post = postsTo(calls, "/hr/salary-payments/sp-1/post")[0];
    expect({ url: post.url, method: post.method, body: post.body }).toEqual({ url: "/api/v1/hr/salary-payments/sp-1/post", method: "POST", body: JSON.stringify({ allocations: [{ ledger_id: "pl-1", amount: "3000" }] }) });
  });

  it("草稿付款未选台账时不发请求（required 门禁拦在弹窗里）", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger], payments: [payment] });
    await openSalary();
    await userEvent.click(panel("工资付款").getByRole("button", { name: "核销过账" }));
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(screen.getByTestId("action-dialog-error")).toHaveTextContent("请填写工资台账");
    expect(postsTo(calls, "/hr/salary-payments/sp-1/post")).toHaveLength(0);
  });

  it("已过账付款「冲销」：原因必填，填了 POST /:id/reverse 只带 reason", async () => {
    const calls = stubSalary({ payments: [{ ...payment, status: "posted" }] });
    await openSalary();
    await userEvent.click(panel("工资付款").getByRole("button", { name: "冲销" }));
    setValue("action-field-reason", "银行退回");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/hr/salary-payments/sp-1/reverse")).toHaveLength(1));
    const reverse = postsTo(calls, "/hr/salary-payments/sp-1/reverse")[0];
    expect({ url: reverse.url, method: reverse.method, body: reverse.body }).toEqual({ url: "/api/v1/hr/salary-payments/sp-1/reverse", method: "POST", body: JSON.stringify({ reason: "银行退回" }) });
  });

  it("草稿付款行不出现「冲销」，已过账行不出现「核销过账」（状态决定入口）", async () => {
    stubSalary({ payments: [payment, { ...payment, id: "sp-2", paymentNo: "SALARY-002", status: "posted" }] });
    await openSalary();
    const table = panel("工资付款");
    expect(table.getAllByRole("button", { name: "核销过账" })).toHaveLength(1);
    expect(table.getAllByRole("button", { name: "冲销" })).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ 失败态与权限

describe("工资管理：失败态与权限", () => {
  it("台账接口 403：整表落到错误态并显示后端 message（不渲染成空表），重试成功后恢复", async () => {
    let fail = true;
    const calls = stubSalary({ ledgers: [workshopLedger] }, (url) => (fail && url.startsWith(EP.ledgers) ? apiErr(403, "FORBIDDEN", "无权访问工资台账") : undefined));
    await openSalary();
    expect(screen.getByTestId("error-state")).toHaveTextContent("无权访问工资台账");
    expect(screen.queryByRole("heading", { name: "工资台账" })).toBeNull();
    fail = false;
    fireEvent.click(screen.getByTestId("error-state-retry"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "工资台账" })).toBeVisible());
    expect(callsTo(calls, EP.ledgers).length).toBeGreaterThan(1);
  });

  it("动作 409：toast 显示后端 message 且不出现成功提示", async () => {
    stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] }, (url) => (url.endsWith("/confirm") ? apiErr(409, "PAYROLL_NOT_CONFIRMABLE", "工资台账已被其他操作处理") : undefined));
    await openSalary();
    await userEvent.click(panel("工资台账").getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.getByTestId("toast-item")).toHaveTextContent("工资台账已被其他操作处理"));
    expect(screen.queryByText("工资台账已确认")).toBeNull();
  });

  it("动作 404：删除时台账已被别人删除，toast 显示后端 message", async () => {
    stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] }, (url, call) => (call.method === "DELETE" ? apiErr(404, "PAYROLL_LEDGER_NOT_FOUND", "薪资台账不存在") : undefined));
    await openSalary();
    await userEvent.click(panel("工资台账").getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.getByTestId("toast-item")).toHaveTextContent("薪资台账不存在"));
  });

  it("非 API 异常（网络中断）落到兜底文案「工资数据加载失败」", async () => {
    stubSalary({}, () => { throw new TypeError("Failed to fetch"); });
    await openSalary();
    expect(screen.getByTestId("error-state")).toHaveTextContent("工资数据加载失败");
  });
});

// ------------------------------------------------------------------ 已知缺陷（保持可见）

describe("工资管理：已知缺陷", () => {
  it("KNOWN_DEFECT：重名员工在下拉里选了具体工号，请求体仍只带姓名 → 台账永远建不出来", async () => {
    const calls = stubSalary({ employees: [workshopEmployee, { ...workshopEmployee, id: "emp-9", employeeNo: "E-900" }] });
    await openSalary();
    await userEvent.click(screen.getByRole("button", { name: "新建工资台账" }));
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
    const button = panel("工资台账").getByRole("button", { name: "确认" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/confirm")).toHaveLength(2));
  });
});
