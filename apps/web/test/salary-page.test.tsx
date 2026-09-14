// app/finance/salary/page.tsx 的**行为**测试：真实渲染 + 真实点击 + 断言真实发出的请求。
//
// 被测面的数据契约（全部来自页面源码，不是想象）：
//   GET    /production/employees                 员工（只喂「新建工资台账」的姓名下拉 + 车间/非车间分区）
//   GET    /hr/payroll-ledgers[?from=&to=]       工资台账（车间、非车间两张表共用同一份列定义）
//   GET    /hr/payroll-payables                  工资应付（决定「未生成 / 应付草稿 / 应付已确认」与按钮）
//   GET    /hr/salary-payments                   工资付款
//   POST   /hr/payroll-ledgers/generate          新建台账（employee_name + 期间 + 9 个金额字段 + currency）
//   PATCH  /hr/payroll-ledgers/:id               编辑（草稿；已确认必须带 reason）
//   DELETE /hr/payroll-ledgers/:id               删除（仅草稿）
//   POST   /hr/payroll-ledgers/:id/confirm       确认（无 body）
//   POST   /hr/payroll-ledgers/:id/reopen        回到草稿（body: reason）
//   POST   /hr/payroll-ledgers/:id/payable       生成应付（body: {}）
//   POST   /hr/payroll-ledgers/:id/close         关闭（仅 paid）
//   POST   /hr/payroll-payables/:id/confirm      确认应付
//   POST   /hr/salary-payments                   新建工资付款
//   POST   /hr/salary-payments/:id/post          核销过账（body: allocations:[{ledger_id, amount}]）
//   POST   /hr/salary-payments/:id/reverse       冲销（body: reason）
//
// 这些路径/method 与 apps/api/src/modules/hr/hr.controller.ts:41-64 一一对应：编辑只注册了 PATCH、
// 删除只注册了 DELETE；确认/回退/生成应付/关闭/过账/冲销都是 POST。写错 method 会 404，写错字段名
// 会被 DTO 的 whitelist 丢掉（hr.controller.ts:17-24），所以这里对 method + 完整 URL + 请求体逐条断言。
//
// 本文件**没有**导出断言：该页面没有任何导出/下载入口（全站导出在
// components/production/payroll-export-panel.tsx，已有独立测试 payroll-export-panel.test.tsx）；
// 也**没有**权限分支（没有「仅管理员可见」的按钮），权限维度通过 403 失败态覆盖。
//
// 动作结果只经 toast 呈现（notifySuccess / notifyError），因此渲染时一并挂 <Toaster />。
import { describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SalaryPage from "../app/finance/salary/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 页面 useEffect 里 Promise.all 的 4 个 GET + 币种字典 1 个 GET（前缀是 api-client 拼的 /api/v1）。 */
const EP = {
  employees: "/api/v1/production/employees",
  ledgers: "/api/v1/hr/payroll-ledgers",
  payables: "/api/v1/hr/payroll-payables",
  payments: "/api/v1/hr/salary-payments",
  // 工资台账/工资付款的币种下拉来自可配置字典（lib/currency-options.ts），随首屏一起拉取。
  currencies: "/api/v1/dictionaries/currency/items",
} as const;
const ALL_LISTS = Object.values(EP);

type Handler = (url: string, call: StubbedCall) => Response | undefined | Promise<Response | undefined>;

/**
 * 桩：4 个列表接口各回自己那一份数据（默认空），extra 优先执行，用于注入 403 / 422 等特例。
 * ledger / payable 前缀下既有 GET（列表）又有 POST/PATCH/DELETE（动作），因此按 method 分流：
 * GET 回列表，其余回一个成功信封。返回 fetch 调用记录，供 callsTo(...) 断言 method / url / body。
 */
function stubSalary(data: Partial<Record<keyof typeof EP, unknown[]>> = {}, extra?: Handler) {
  return stubApi(async (url, call) => {
    const injected = await extra?.(url, call);
    if (injected) return injected;
    if (url.startsWith(EP.employees)) return apiOk(data.employees ?? []);
    if (url.startsWith(EP.payables)) return apiOk(data.payables ?? []);
    if (url.startsWith(EP.payments)) return apiOk(data.payments ?? []);
    if (url.startsWith(EP.currencies)) return apiOk(data.currencies ?? []);
    if (url.startsWith(EP.ledgers)) return call.method === "GET" ? apiOk(data.ledgers ?? []) : apiOk({});
    return apiOk({});
  });
}

/** 渲染工资总览页（连带 Toaster：动作结果只经 toast 呈现，页面本身没有动作错误区）。 */
function renderSalary() {
  return render(
    <>
      <SalaryPage />
      <Toaster />
    </>
  );
}

/** 渲染并等到数据加载完成（页面根出现）。 */
async function openSalary() {
  renderSalary();
  await screen.findByTestId("page-finance-salary");
}

/** 取某个面板（section）的作用域，避免同名文本/按钮跨表歧义（车间/非车间两张表列定义相同）。 */
function panel(title: string) {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (!section) throw new Error(`找不到面板：${title}`);
  return within(section as HTMLElement);
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const postsTo = (calls: StubbedCall[], suffix: string) => callsTo(calls, suffix).filter((call) => call.method === "POST");
const gets = (calls: StubbedCall[]) => calls.filter((call) => call.method === "GET");
/** 直接读 input.value：number/date 输入用 toHaveValue 会走 valueAsNumber，容易误判。 */
const valueOf = (testId: string) => (screen.getByTestId(testId) as HTMLInputElement).value;
/** 日期输入在 jsdom 里按 locale 分段编辑不可靠，直接写入合法日期字符串。 */
const setDate = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
/** 打开 ActionDialog 的 Radix Select 并选中某一项（选项文案即 value 的可读形式）。 */
async function pickOption(testId: string, optionName: string) {
  await userEvent.click(screen.getByTestId(testId));
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

const workshopEmployee = { id: "emp-1", employeeNo: "E-001", name: "张三", employeeType: "workshop" };
const officeEmployee = { id: "emp-2", employeeNo: "E-101", name: "李四", employeeType: "office" };

/** 车间已确认台账：金额字段给足小数位，贴近后端 Decimal(18,4).toFixed(4) 的真实返回。 */
const workshopLedger = {
  id: "pl-1", ledgerNo: "PAYROLL-001", employeeId: "emp-1",
  periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-03-31T00:00:00.000Z", currency: "CNY",
  baseSalary: "5000.0000", productionSourceAmount: "1234.5000", overtimeAmount: "100.0000",
  attendanceDeduction: "50.0000", performanceAmount: "200.0000", allowanceAmount: "300.0000",
  socialInsurance: "400.0000", individualTax: "90.0000", otherAdjustment: "10.0000",
  payableAmount: "6304.5000", paidAmount: "1000.0000", outstandingAmount: "5304.5000",
  status: "confirmed", employee: workshopEmployee,
};
const officeLedger = {
  id: "pl-2", ledgerNo: "PAYROLL-002", employeeId: "emp-2",
  periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-03-31T00:00:00.000Z", currency: "CNY",
  baseSalary: "8000.0000", productionSourceAmount: "0.0000", overtimeAmount: "0.0000",
  attendanceDeduction: "0.0000", performanceAmount: "0.0000", allowanceAmount: "0.0000",
  socialInsurance: "600.0000", individualTax: "200.0000", otherAdjustment: "0.0000",
  payableAmount: "7200.0000", paidAmount: "0.0000", outstandingAmount: "7200.0000",
  status: "draft", employee: officeEmployee,
};
const expiredLedger = { ...workshopLedger, id: "pl-3", ledgerNo: "PAYROLL-003", status: "expired" };
const paidLedger = { ...workshopLedger, id: "pl-4", ledgerNo: "PAYROLL-004", status: "paid", paidAmount: "6304.5000", outstandingAmount: "0.0000" };
const partiallyPaidLedger = { ...workshopLedger, id: "pl-5", ledgerNo: "PAYROLL-005", status: "partially_paid", paidAmount: "1000.0000" };
const draftPayment = { id: "sp-1", paymentNo: "SALARY-001", paymentDate: "2026-03-05T08:00:00.000Z", amount: "1000.0000", currency: "CNY", status: "draft" };
const postedPayment = { id: "sp-2", paymentNo: "SALARY-002", paymentDate: "2026-03-06T08:00:00.000Z", amount: "2000.0000", currency: "CNY", status: "posted" };

describe("工资总览：加载门禁与列表请求契约", () => {
  it("加载中只有加载态（无页面根、无操作入口）；完成后页面根出现且 4 个列表接口 + 币种字典各被 GET 一次", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls = stubSalary({}, async (url, call) => {
      if (url.endsWith(EP.employees) && call.method === "GET") { await gate; return apiOk([workshopEmployee]); }
      return undefined;
    });

    renderSalary();

    expect(screen.getByTestId("loading-state")).toBeVisible();
    expect(screen.queryByTestId("page-finance-salary")).toBeNull();
    // 数据没到之前入口不能存在：否则「新建工资台账」会把空的员工选项快照进弹窗
    expect(screen.queryByRole("button", { name: "新建工资台账" })).toBeNull();
    expect(screen.queryByRole("button", { name: "新建工资付款" })).toBeNull();

    release();

    expect(await screen.findByTestId("page-finance-salary")).toBeVisible();
    await waitFor(() => expect(gets(calls)).toHaveLength(ALL_LISTS.length));
    expect(gets(calls).map((call) => call.url).sort()).toEqual(
      [...ALL_LISTS].sort()
    );
    expect(screen.queryByTestId("loading-state")).toBeNull();
  });

  it("期间筛选：改动期间会带 from/to 重新拉取台账，且筛选值保留在输入框里", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger, officeLedger] });
    await openSalary();

    // 初始加载是不带 query 的集合根（少一个 ? 也会被这里抓到）
    expect(gets(calls).map((call) => call.url)).toContain(EP.ledgers);

    fireEvent.change(screen.getByLabelText(/期间开始/), { target: { value: "2026-03-01" } });
    await waitFor(() => expect(calls.some((call) => call.url === `${EP.ledgers}?from=2026-03-01`)).toBe(true));

    fireEvent.change(screen.getByLabelText(/期间结束/), { target: { value: "2026-03-31" } });
    await waitFor(() =>
      expect(calls.some((call) => call.url === `${EP.ledgers}?from=2026-03-01&to=2026-03-31`)).toBe(true)
    );

    // loading 会把整页换成加载态，但期间状态必须留着，否则用户每输一次日期就丢一次
    expect((screen.getByLabelText(/期间开始/) as HTMLInputElement).value).toBe("2026-03-01");
    expect((screen.getByLabelText(/期间结束/) as HTMLInputElement).value).toBe("2026-03-31");
  });
});

describe("工资总览：车间/非车间分区与列表渲染", () => {
  it("按员工类型分区渲染，金额带币种、期间截断、状态中文化、过期附提示", async () => {
    stubSalary({ employees: [workshopEmployee, officeEmployee], ledgers: [workshopLedger, officeLedger, expiredLedger] });
    await openSalary();

    const workshop = panel("车间");
    // 员工列是「工号 / 姓名」拼接。
    // 注意：expiredLedger = { ...workshopLedger, id/status }，同一员工在这个测试里有两张车间台账，
    // 所以同名文本必然出现两次 —— 断言条数，而不是断言唯一。
    expect(workshop.getAllByText("E-001 / 张三")).toHaveLength(2);
    // 车间台账进车间表，非车间台账不能混进来
    expect(workshop.queryByText("E-101 / 李四")).toBeNull();
    // 周期列把 ISO 时间截断成 10 位并按「A 至 B」拼接
    expect(workshop.getAllByText("2026-03-01 至 2026-03-31").length).toBeGreaterThan(0);
    // 应发/已付/未付列是「金额 币种」，金额保持后端字符串（不做千分位或舍入）
    expect(workshop.getAllByText("6304.5000 CNY").length).toBeGreaterThan(0);
    expect(workshop.getAllByText("1000.0000 CNY").length).toBeGreaterThan(0);
    expect(workshop.getAllByText("5304.5000 CNY").length).toBeGreaterThan(0);
    // 基本工资 / 生产来源是裸字符串列
    expect(workshop.getAllByText("5000.0000").length).toBeGreaterThan(0);
    expect(workshop.getAllByText("1234.5000").length).toBeGreaterThan(0);
    // 状态映射 + 过期提示
    expect(workshop.getByText("已确认")).toBeVisible();
    expect(workshop.getByText("已过期（需重新结算）")).toBeVisible();

    const office = panel("非车间");
    expect(office.getByText("E-101 / 李四")).toBeVisible();
    expect(office.queryByText("E-001 / 张三")).toBeNull();
    // 应发与未付都是 7200.0000（该台账未收款），同一行里同名金额出现两次
    expect(office.getAllByText("7200.0000 CNY").length).toBeGreaterThan(0);
    expect(office.getByText("草稿")).toBeVisible();
  });

  it("工资应付列：未生成显示「未生成」，有应付时显示中文化状态而不是按钮", async () => {
    stubSalary({
      ledgers: [workshopLedger],
      payables: [{ id: "pp-1", ledgerId: "pl-1", payableNo: "PPAY-001", amount: "6304.5000", currency: "CNY", status: "confirmed" }],
    });
    await openSalary();

    const workshop = panel("车间");
    // 「应付已确认」同时出现在「工资应付」列和行内状态文本里，因此按条数断言。
    expect(workshop.getAllByText("应付已确认").length).toBeGreaterThan(0);
    expect(workshop.queryByText("未生成")).toBeNull();
    // 已确认的应付不能再点「确认应付」（后端只有草稿应付可以确认）
    expect(workshop.queryByRole("button", { name: "确认应付" })).toBeNull();
  });

  it("工资付款表：日期截断、金额带币种、状态走中文映射", async () => {
    stubSalary({ payments: [draftPayment, postedPayment] });
    await openSalary();

    const payments = panel("工资付款");
    expect(payments.getByText("SALARY-001")).toBeVisible();
    expect(payments.getByText("2026-03-05")).toBeVisible();
    expect(payments.getByText("1000.0000 CNY")).toBeVisible();
    // status 是 accessorKey 列，字符串会经 displayText 中文化
    expect(payments.getByText("草稿")).toBeVisible();
    expect(payments.getByText("已过账")).toBeVisible();
    expect(payments.getByText("2026-03-06")).toBeVisible();
  });

  it("所有列表为空时三个区块回落到空态（不留加载态、不渲染空表格）", async () => {
    stubSalary();
    await openSalary();

    for (const title of ["暂无车间工资台账", "暂无非车间工资台账", "暂无工资付款"]) {
      expect(screen.getByText(title)).toBeVisible();
    }
    expect(screen.queryByTestId("data-table")).toBeNull();
    expect(screen.queryByTestId("loading-state")).toBeNull();
  });

  it("员工姓名/工号筛选是本地过滤：只留下匹配行且不发新请求", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger, officeLedger] });
    await openSalary();
    const before = gets(calls).length;

    await userEvent.type(screen.getByLabelText(/员工姓名\/工号/), "李四");

    expect(panel("非车间").getByText("E-101 / 李四")).toBeVisible();
    expect(screen.queryByText("E-001 / 张三")).toBeNull();
    expect(gets(calls)).toHaveLength(before);
  });
});

describe("工资总览：台账动作的 method + URL + 请求体", () => {
  it("草稿台账「确认」：POST /:id/confirm 且不带 body，成功后提示并重新拉取", async () => {
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] });
    await openSalary();

    await userEvent.click(panel("车间").getByRole("button", { name: "确认" }));

    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/confirm")).toHaveLength(1));
    const confirm = postsTo(calls, "/hr/payroll-ledgers/pl-1/confirm")[0];
    expect(confirm.method).toBe("POST");
    expect(confirm.url).toBe(`${EP.ledgers}/pl-1/confirm`);
    expect(confirm.body).toBeNull();
    expect(await screen.findByText("工资台账已确认")).toBeVisible();
    // 成功后重新拉取列表（数据流闭环）
    await waitFor(() => expect(gets(calls).filter((call) => call.url === EP.ledgers)).toHaveLength(2));
  });

  it("草稿台账「删除」：DELETE /:id（不是 POST/PATCH）", async () => {
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] });
    await openSalary();

    await userEvent.click(panel("车间").getByRole("button", { name: "删除" }));

    await waitFor(() => expect(callsTo(calls, "/hr/payroll-ledgers/pl-1").filter((call) => call.method === "DELETE")).toHaveLength(1));
    const remove = callsTo(calls, "/hr/payroll-ledgers/pl-1")[0];
    expect(remove.method).toBe("DELETE");
    expect(await screen.findByText("工资台账已删除")).toBeVisible();
    // 删除入口不能被误当成编辑（PATCH 到同一个 /:id）
    expect(callsTo(calls, "/hr/payroll-ledgers/pl-1").filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("草稿台账「编辑」：弹窗预填当前值，保存发出 PATCH /:id 且带上用户改后的值与 currency", async () => {
    const calls = stubSalary({ employees: [workshopEmployee], ledgers: [{ ...workshopLedger, status: "draft" }] });
    await openSalary();

    await userEvent.click(panel("车间").getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("heading", { name: "编辑工资台账" })).toBeVisible();
    expect(valueOf("action-field-base_salary")).toBe("5000.0000");
    expect(valueOf("action-field-period_start")).toBe("2026-03-01");
    // 草稿编辑不需要修改原因（后端只在 confirmed 时要求 reason）
    expect(screen.queryByTestId("action-field-reason")).toBeNull();

    await userEvent.clear(screen.getByTestId("action-field-base_salary"));
    await userEvent.type(screen.getByTestId("action-field-base_salary"), "5200");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    // 一次点击 = 一次请求：提交瞬间弹窗关闭
    expect(screen.queryByTestId("action-dialog")).toBeNull();

    await waitFor(() => expect(callsTo(calls, "/hr/payroll-ledgers/pl-1").filter((call) => call.method === "PATCH")).toHaveLength(1));
    const edit = callsTo(calls, "/hr/payroll-ledgers/pl-1").filter((call) => call.method === "PATCH")[0];
    expect(edit.url).toBe(`${EP.ledgers}/pl-1`);
    expect(bodyOf(edit)).toEqual({
      employee_id: "emp-1", period_start: "2026-03-01", period_end: "2026-03-31",
      base_salary: "5200", overtime_amount: "100.0000", attendance_deduction: "50.0000",
      performance_amount: "200.0000", allowance_amount: "300.0000", social_insurance: "400.0000",
      individual_tax: "90.0000", other_adjustment: "10.0000", remark: "", currency: "CNY",
    });
    expect(await screen.findByText("工资台账已更新")).toBeVisible();
  });

  it("已确认台账「编辑」：修改原因必填，不填不发请求，填了随 PATCH 一起下发", async () => {
    const calls = stubSalary({ employees: [workshopEmployee], ledgers: [workshopLedger] });
    await openSalary();

    await userEvent.click(panel("车间").getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("heading", { name: "编辑工资台账" })).toBeVisible();

    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("请填写修改原因");
    expect(callsTo(calls, "/hr/payroll-ledgers/pl-1").filter((call) => call.method === "PATCH")).toHaveLength(0);

    await userEvent.type(screen.getByTestId("action-field-reason"), "生产来源金额重算");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/hr/payroll-ledgers/pl-1").filter((call) => call.method === "PATCH")).toHaveLength(1));
    const edit = callsTo(calls, "/hr/payroll-ledgers/pl-1").filter((call) => call.method === "PATCH")[0];
    const body = bodyOf(edit);
    expect(body.reason).toBe("生产来源金额重算");
    expect(body.currency).toBe("CNY");
    expect(body.base_salary).toBe("5000.0000");
  });

  it("已确认台账「回到草稿」：POST /:id/reopen，body 只有 reason", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();

    await userEvent.click(panel("车间").getByRole("button", { name: "回到草稿" }));
    expect(await screen.findByRole("heading", { name: "工资台账回退草稿" })).toBeVisible();

    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("请填写回退原因");
    expect(callsTo(calls, "/reopen")).toHaveLength(0);

    await userEvent.type(screen.getByTestId("action-field-reason"), "金额录错");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/reopen")).toHaveLength(1));
    const reopen = postsTo(calls, "/hr/payroll-ledgers/pl-1/reopen")[0];
    expect(reopen.url).toBe(`${EP.ledgers}/pl-1/reopen`);
    expect(bodyOf(reopen)).toEqual({ reason: "金额录错" });
    expect(await screen.findByText("工资台账已回到草稿")).toBeVisible();
  });

  it("已过期台账同样可以回到草稿（后端 canReopenPayroll 接受 confirmed/expired）", async () => {
    const calls = stubSalary({ ledgers: [expiredLedger] });
    await openSalary();

    await userEvent.click(panel("车间").getByRole("button", { name: "回到草稿" }));
    await screen.findByRole("heading", { name: "工资台账回退草稿" });
    await userEvent.type(screen.getByTestId("action-field-reason"), "重新结算");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-3/reopen")).toHaveLength(1));
    expect(bodyOf(postsTo(calls, "/hr/payroll-ledgers/pl-3/reopen")[0])).toEqual({ reason: "重新结算" });
  });

  it("未生成应付时「生成应付」：POST /:id/payable 且 body 是空对象；已有草稿应付则改为「确认应付」POST /payroll-payables/:id/confirm", async () => {
    const noPayable = stubSalary({ ledgers: [workshopLedger] });
    await openSalary();
    expect(panel("车间").getByText("未生成")).toBeVisible();

    await userEvent.click(panel("车间").getByRole("button", { name: "生成应付" }));
    await waitFor(() => expect(postsTo(noPayable, "/hr/payroll-ledgers/pl-1/payable")).toHaveLength(1));
    const generate = postsTo(noPayable, "/hr/payroll-ledgers/pl-1/payable")[0];
    expect(generate.url).toBe(`${EP.ledgers}/pl-1/payable`);
    expect(bodyOf(generate)).toEqual({});
    expect(await screen.findByText("工资应付已生成")).toBeVisible();

    // 应付已生成（草稿）时按钮换成「确认应付」，路径前缀从 payroll-ledgers 换成 payroll-payables
    // 同一用例里要第二次渲染页面：必须先卸载上一棵树，否则「车间」标题与行会出现两份。
    cleanup();
    const withDraftPayable = stubSalary({
      ledgers: [workshopLedger],
      payables: [{ id: "pp-9", ledgerId: "pl-1", payableNo: "PPAY-009", amount: "6304.5000", currency: "CNY", status: "draft" }],
    });
    await openSalary();
    expect(panel("车间").getByText("应付草稿")).toBeVisible();
    expect(panel("车间").queryByRole("button", { name: "生成应付" })).toBeNull();

    await userEvent.click(panel("车间").getByRole("button", { name: "确认应付" }));
    await waitFor(() => expect(postsTo(withDraftPayable, "/hr/payroll-payables/pp-9/confirm")).toHaveLength(1));
    expect(postsTo(withDraftPayable, "/hr/payroll-payables/pp-9/confirm")[0].url).toBe(`${EP.payables}/pp-9/confirm`);
    expect(await screen.findByText("工资应付已确认")).toBeVisible();
  });

  it("已付清台账出现「关闭」：POST /:id/close", async () => {
    const calls = stubSalary({ ledgers: [paidLedger] });
    await openSalary();

    expect(panel("车间").getByText("已支付")).toBeVisible();
    await userEvent.click(panel("车间").getByRole("button", { name: "关闭" }));

    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/pl-4/close")).toHaveLength(1));
    expect(postsTo(calls, "/hr/payroll-ledgers/pl-4/close")[0].url).toBe(`${EP.ledgers}/pl-4/close`);
    expect(await screen.findByText("工资台账已关闭")).toBeVisible();
  });

  it("业务规则分支：部分支付台账不提供任何行内动作（后端 update 会 422 拒绝编辑）", async () => {
    stubSalary({ ledgers: [partiallyPaidLedger] });
    await openSalary();

    const workshop = panel("车间");
    expect(workshop.getByText("部分支付")).toBeVisible();
    for (const name of ["编辑", "确认", "删除", "回到草稿", "生成应付", "关闭"]) {
      expect(workshop.queryByRole("button", { name })).toBeNull();
    }
  });
});

describe("工资总览：新建台账与新建工资付款", () => {
  it("「新建工资台账」：员工必填（不选不发请求），提交 POST /hr/payroll-ledgers/generate 且字段名完整", async () => {
    const calls = stubSalary({ employees: [workshopEmployee] });
    await openSalary();

    await userEvent.click(screen.getByRole("button", { name: "新建工资台账" }));
    expect(await screen.findByRole("heading", { name: "新建工资台账" })).toBeVisible();
    // 姓名下拉的可读形式是「工号 / 姓名 / 类型」：下拉未展开时没有 option 节点，
    // 这里直接点选（pickOption 会断言选项文案），不在展开前做无效断言。

    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("请填写员工姓名");
    expect(postsTo(calls, "/hr/payroll-ledgers/generate")).toHaveLength(0);

    await pickOption("action-field-employee_name", "E-001 / 张三 / 车间");
    setDate("action-field-period_start", "2026-03-01");
    setDate("action-field-period_end", "2026-03-31");
    await userEvent.clear(screen.getByTestId("action-field-base_salary"));
    await userEvent.type(screen.getByTestId("action-field-base_salary"), "5000");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postsTo(calls, "/hr/payroll-ledgers/generate")).toHaveLength(1));
    const create = postsTo(calls, "/hr/payroll-ledgers/generate")[0];
    expect(create.url).toBe(`${EP.ledgers}/generate`);
    // 字段名与 hr.controller.ts:17 的 PayrollGenerateDto 对齐：改名会被 whitelist 丢掉并 400
    expect(bodyOf(create)).toEqual({
      employee_name: "张三", period_start: "2026-03-01", period_end: "2026-03-31",
      base_salary: "5000", overtime_amount: "0", attendance_deduction: "0", performance_amount: "0",
      allowance_amount: "0", social_insurance: "0", individual_tax: "0", other_adjustment: "0",
      remark: "", currency: "CNY",
    });
    expect(await screen.findByText("工资台账已创建")).toBeVisible();
  });

  it("「新建工资付款」：金额必填（不填不发请求），提交 POST /hr/salary-payments 且付款日期默认今天", async () => {
    const calls = stubSalary();
    await openSalary();

    await userEvent.click(screen.getByRole("button", { name: "新建工资付款" }));
    expect(await screen.findByRole("heading", { name: "新建工资付款" })).toBeVisible();
    expect(valueOf("action-field-payment_method")).toBe("银行转账");
    const today = new Date().toISOString().slice(0, 10);
    expect(valueOf("action-field-payment_date")).toBe(today);

    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("请填写付款金额");
    expect(postsTo(calls, EP.payments)).toHaveLength(0);

    await userEvent.type(screen.getByTestId("action-field-amount"), "1500");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postsTo(calls, EP.payments)).toHaveLength(1));
    const create = postsTo(calls, EP.payments)[0];
    expect(create.url).toBe(EP.payments);
    // 付款单不需要幂等键，也不接受 remark；只带 DTO（hr.controller.ts:20）要求的四个字段
    expect(bodyOf(create)).toEqual({ amount: "1500", payment_date: today, currency: "CNY", payment_method: "银行转账" });
    expect(await screen.findByText("工资付款草稿已创建")).toBeVisible();
  });
});

describe("工资总览：工资付款核销与冲销", () => {
  it("草稿付款「核销过账」：台账下拉只列可核销台账，提交 POST /salary-payments/:id/post 带 allocations", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger, officeLedger], payments: [draftPayment] });
    await openSalary();

    await userEvent.click(panel("工资付款").getByRole("button", { name: "核销过账" }));
    expect(await screen.findByRole("heading", { name: "工资付款核销：SALARY-001" })).toBeVisible();

    await userEvent.click(screen.getByTestId("action-field-ledger_id"));
    // 选项 = 已验证且未付 > 0 的台账，label 拼「工号 / 姓名 / 未付 金额 币种」
    expect(await screen.findByRole("option", { name: "E-001 / 张三 / 未付 5304.5000 CNY" })).toBeVisible();
    // 草稿台账不在可核销范围内（后端 post 只接受 confirmed/partially_paid）
    expect(screen.queryByRole("option", { name: /E-101 \/ 李四/ })).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: "E-001 / 张三 / 未付 5304.5000 CNY" }));

    // 核销金额默认取付款单金额
    expect(valueOf("action-field-amount")).toBe("1000.0000");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postsTo(calls, "/hr/salary-payments/sp-1/post")).toHaveLength(1));
    const post = postsTo(calls, "/hr/salary-payments/sp-1/post")[0];
    expect(post.url).toBe(`${EP.payments}/sp-1/post`);
    expect(bodyOf(post)).toEqual({ allocations: [{ ledger_id: "pl-1", amount: "1000.0000" }] });
    expect(await screen.findByText("工资付款已过账")).toBeVisible();
  });

  it("草稿付款未选台账时不发请求（required 门禁拦在弹窗里）", async () => {
    const calls = stubSalary({ ledgers: [workshopLedger], payments: [draftPayment] });
    await openSalary();

    await userEvent.click(panel("工资付款").getByRole("button", { name: "核销过账" }));
    await screen.findByRole("heading", { name: "工资付款核销：SALARY-001" });
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent("请填写工资台账");
    expect(callsTo(calls, "/post")).toHaveLength(0);
  });

  it("已过账付款「冲销」：原因必填，填了 POST /:id/reverse 只带 reason", async () => {
    const calls = stubSalary({ payments: [postedPayment] });
    await openSalary();

    await userEvent.click(panel("工资付款").getByRole("button", { name: "冲销" }));
    expect(await screen.findByRole("heading", { name: "冲销工资付款：SALARY-002" })).toBeVisible();

    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("请填写冲销原因");
    expect(callsTo(calls, "/reverse")).toHaveLength(0);

    await userEvent.type(screen.getByTestId("action-field-reason"), "重复发放");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postsTo(calls, "/hr/salary-payments/sp-2/reverse")).toHaveLength(1));
    const reverse = postsTo(calls, "/hr/salary-payments/sp-2/reverse")[0];
    expect(reverse.url).toBe(`${EP.payments}/sp-2/reverse`);
    expect(bodyOf(reverse)).toEqual({ reason: "重复发放" });
    expect(await screen.findByText("工资付款已冲销")).toBeVisible();
  });

  it("草稿付款行不出现「冲销」，已过账行不出现「核销过账」（状态决定入口）", async () => {
    stubSalary({ ledgers: [workshopLedger], payments: [draftPayment, postedPayment] });
    await openSalary();

    const payments = panel("工资付款");
    expect(payments.getAllByRole("button", { name: "核销过账" })).toHaveLength(1);
    expect(payments.getAllByRole("button", { name: "冲销" })).toHaveLength(1);
    const rows = payments.getAllByTestId("data-table-row");
    expect(within(rows[0]).getByText("SALARY-001")).toBeVisible();
    expect(within(rows[0]).queryByRole("button", { name: "冲销" })).toBeNull();
    expect(within(rows[1]).queryByRole("button", { name: "核销过账" })).toBeNull();
  });
});

describe("工资总览：失败态与权限", () => {
  it("台账接口 403：整表落到错误态并显示后端 message（不渲染成空表），重试成功后恢复", async () => {
    let failing = true;
    const calls = stubApi(async (url, call) => {
      if (url.startsWith(EP.ledgers) && call.method === "GET") {
        if (failing) { failing = false; return apiErr(403, "FORBIDDEN", "无权查看工资台账"); }
        return apiOk([workshopLedger]);
      }
      return apiOk([]);
    });

    renderSalary();

    expect(await screen.findByTestId("error-state")).toHaveTextContent("无权查看工资台账");
    // 加载失败不能把「没拿到数据」渲染成「正常空表」
    expect(screen.queryByTestId("data-table")).toBeNull();
    expect(screen.queryByText("暂无车间工资台账")).toBeNull();

    await userEvent.click(screen.getByTestId("error-state-retry"));

    expect(await screen.findByTestId("page-finance-salary")).toBeVisible();
    expect(screen.queryByTestId("error-state")).toBeNull();
    expect(panel("车间").getByText("E-001 / 张三")).toBeVisible();
    expect(gets(calls).filter((call) => call.url === EP.ledgers)).toHaveLength(2);
  });

  it("动作 409：toast 显示后端 message 且不出现成功提示", async () => {
    stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] }, (url, call) =>
      url.endsWith("/hr/payroll-ledgers/pl-1/confirm") && call.method === "POST"
        ? apiErr(409, "PAYROLL_NOT_CONFIRMABLE", "只有草稿台账可以确认")
        : undefined
    );
    await openSalary();

    await userEvent.click(panel("车间").getByRole("button", { name: "确认" }));

    expect(await screen.findByText("只有草稿台账可以确认")).toBeVisible();
    expect(screen.queryByText("工资台账已确认")).toBeNull();
  });

  it("动作 404：删除时台账已被别人删除，toast 显示后端 message 且不出现成功提示", async () => {
    stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] }, (url, call) =>
      url.endsWith("/hr/payroll-ledgers/pl-1") && call.method === "DELETE"
        ? apiErr(404, "PAYROLL_LEDGER_NOT_FOUND", "薪资台账不存在")
        : undefined
    );
    await openSalary();

    await userEvent.click(panel("车间").getByRole("button", { name: "删除" }));

    expect(await screen.findByText("薪资台账不存在")).toBeVisible();
    expect(screen.queryByText("工资台账已删除")).toBeNull();
  });

  it("非 API 异常（网络中断）落到兜底文案「工资数据加载失败」", async () => {
    stubApi(async () => { throw new TypeError("Failed to fetch"); });
    renderSalary();

    expect(await screen.findByTestId("error-state")).toHaveTextContent("工资数据加载失败");
  });

  it("工资付款接口 500：错误态显示后端 message，重试可恢复", async () => {
    let failing = true;
    const calls = stubApi(async (url, call) => {
      if (url.startsWith(EP.payments) && call.method === "GET") {
        if (failing) { failing = false; return apiErr(500, "INTERNAL_SERVER_ERROR", "工资付款查询失败"); }
        return apiOk([draftPayment]);
      }
      return apiOk([]);
    });

    renderSalary();

    expect(await screen.findByTestId("error-state")).toHaveTextContent("工资付款查询失败");
    await userEvent.click(screen.getByTestId("error-state-retry"));

    expect(await screen.findByTestId("page-finance-salary")).toBeVisible();
    expect(panel("工资付款").getByText("SALARY-001")).toBeVisible();
    expect(gets(calls).filter((call) => call.url === EP.payments)).toHaveLength(2);
  });
});

describe("工资总览：已知缺陷", () => {
  it("KNOWN_DEFECT：重名员工在下拉里选了具体工号，请求体仍只带姓名 → 台账永远建不出来", async () => {
    // 场景：两个同名员工（工号不同）。下拉里能按工号区分并选中，
    // 但选中的是「名字」这个 value，请求体里没有 employee_id。
    const calls = stubSalary({ employees: [workshopEmployee, { ...officeEmployee, name: "张三" }] }, (url, call) =>
      url.endsWith("/hr/payroll-ledgers/generate") && call.method === "POST" && !bodyOf(call).employee_id
        // 复刻 api 侧 payroll-ledger.service.ts:19 的真实规则
        ? apiErr(422, "EMPLOYEE_NAME_AMBIGUOUS", "存在同名员工，请选择具体工号")
        : undefined
    );
    await openSalary();

    await userEvent.click(screen.getByRole("button", { name: "新建工资台账" }));
    await screen.findByRole("heading", { name: "新建工资台账" });
    // 用户明确选中了「E-001 / 张三 / 车间」这一行
    await pickOption("action-field-employee_name", "E-001 / 张三 / 车间");
    setDate("action-field-period_start", "2026-03-01");
    setDate("action-field-period_end", "2026-03-31");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    const create = postsTo(calls, "/hr/payroll-ledgers/generate")[0];
    const body = bodyOf(create);
    // 期望（docs/design/2026-09-master-development-improvement-spec.md:40「重名必须选择具体工号」；
    //   api 侧 payroll-ledger.service.ts:19 只有拿到 employee_id 才能消歧）：
    //   选中带工号的选项后应下发 employee_id: "emp-1"，生成成功并提示「工资台账已创建」。
    // 实际（app/finance/salary/page.tsx:97 的 options value 用的是 item.name，
    //   :110 只发 { ...values, currency: "CNY" }，values 里没有 employee_id）：
    //   请求体只有 employee_name: "张三"，后端按姓名匹配到 2 条同名 → 422，用户在 UI 上无解。
    expect(body.employee_name).toBe("张三");
    expect(body.employee_id).toBeUndefined();
    expect(await screen.findByText("存在同名员工，请选择具体工号")).toBeVisible();
    expect(screen.queryByText("工资台账已创建")).toBeNull();
  });

  it("KNOWN_DEFECT：行内动作按钮没有 in-flight 守卫，连点两次会发出两次 POST", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls = stubSalary({ ledgers: [{ ...workshopLedger, status: "draft" }] }, async (url, call) => {
      if (url.endsWith("/hr/payroll-ledgers/pl-1/confirm") && call.method === "POST") { await gate; return apiOk({}); }
      return undefined;
    });
    await openSalary();

    // 第一次请求还挂在网络上时，按钮依然可点
    await userEvent.click(panel("车间").getByRole("button", { name: "确认" }));
    await userEvent.click(panel("车间").getByRole("button", { name: "确认" }));

    // 期望（apps/web/app/finance/salary/page.tsx:82 的 run() 应有 in-flight 标志、
    //   :155 的行内 Button 应 disabled；docs/test/00-recon-frontend-coverage.md 第 15 项把这条列为待修缺口）：
    //   提交期间按钮禁用 → 只发出 1 次 POST /hr/payroll-ledgers/pl-1/confirm。
    // 实际：两次点击各发一次 POST，第二次必然被后端的「已被其他操作处理」拒绝并弹出无意义的「操作失败」。
    expect(postsTo(calls, "/hr/payroll-ledgers/pl-1/confirm")).toHaveLength(2);

    release();
    // 两次请求都真的完成了（toast 也攒了两条），证明不是被去重吞掉
    expect(await screen.findAllByText("工资台账已确认")).toHaveLength(2);
  });
});
