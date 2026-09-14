// 工序员工日报面板（components/production/daily-reports-panel.tsx）的**真实行为**测试。
//
// 取代遗留的源码正则测试 apps/web/lib/daily-reports-panel.test.mjs —— 那个文件用 readFileSync 读 .tsx
// 源码做正则断言，把 JSX 书写形式当契约。这里全部改为真实 render + userEvent 驱动，
// 断言渲染结果与 callsTo(...) 记录到的请求方法与请求体。
//
// 从遗留文件继承的断言意图（逐条映射到本文件的用例）：
//  1) 「挑选员工支持同一员工重复复选、不得去重」→ B2（两次选择器同一个员工 → 两行独立草稿行）
//  2) 「幂等键用草稿行自身标识而不是行序号」→ C6（失败重试 + 删掉首行后，剩余行的键必须不变）
//  3) 「计时单位统一为小时」→ D4（90 分钟展示为 1.5 小时、计时行时长可编辑、计件行禁用）
//  4) 「草稿表与日报表都有备注列且更正要能保存备注」→ B3 / D6 / D9
//  5) 「更正只提交改动过的计价字段」→ D6 / D9（只改备注时 PATCH body 不含 quantity/unit_price）
//  6) 「备注变化要参与已修改判定」→ D6（改备注后行内保存按钮从 disabled 变为可点）
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DailyReportsPanel } from "../components/production/daily-reports-panel";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi } from "./helpers/api-stub";

const today = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- 固定装置

type Order = ReturnType<typeof order>;

/** 生产单：默认 in_house + in_progress，含一个 active 工序与一个非 active 工序。 */
function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "po-1",
    productionOrderNo: "MO-001",
    orderNo: "SO-001",
    executionMode: "in_house",
    status: "in_progress",
    plannedQuantity: "100",
    operations: [
      { id: "op-1", operationNameSnapshot: "缝制", targetQuantity: "50", status: "active" },
      { id: "op-x", operationNameSnapshot: "裁剪", targetQuantity: "50", status: "pending" },
    ],
    ...overrides,
  };
}

function employee(overrides: Record<string, unknown> = {}) {
  return { id: "e-1", employeeNo: "E001", name: "张三", employmentStatus: "active", ...overrides };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: "rep-1",
    version: 3,
    productionOrderId: "po-1",
    employeeNameSnapshot: "张三",
    employeeId: "e-1",
    reportDate: "2026-01-05",
    wageMode: "piece_rate",
    quantity: "2",
    durationMinutes: undefined as string | undefined,
    calculatedAmount: "20",
    unitPrice: "10",
    remark: "原备注",
    productionOrderOperation: { id: "op-1", targetQuantity: "50" },
    ...overrides,
  };
}

const defaultOrders: Order[] = [
  order(),
  order({ id: "po-2", productionOrderNo: "MO-002", status: "draft" }),
  order({ id: "po-3", productionOrderNo: "MO-003", executionMode: "outsourced" }),
  order({
    id: "po-4",
    productionOrderNo: "MO-004",
    status: "completed",
    operations: [{ id: "op-4", operationNameSnapshot: "整烫", targetQuantity: "20", status: "active" }],
  }),
];

const defaultEmployees = [
  employee(),
  employee({ id: "e-2", employeeNo: "E002", name: "李四" }),
  employee({ id: "e-3", employeeNo: "E003", name: "王五", employmentStatus: "resigned" }),
];

// rep-1 + rep-2：同一员工同一天两条计件（合计 50.00）；rep-3：另一员工另一天的计时条目（90 分钟）；
// rep-9：另一工序的条目（不得出现在当前工序视图里）。
const defaultReports = [
  report(),
  report({ id: "rep-2", quantity: "3", calculatedAmount: "30" }),
  report({
    id: "rep-3",
    employeeId: "e-2",
    employeeNameSnapshot: "李四",
    reportDate: "2026-01-06",
    wageMode: "time_rate",
    quantity: "0",
    durationMinutes: "90",
    calculatedAmount: "30",
    unitPrice: "20",
    remark: null,
  }),
  report({ id: "rep-9", productionOrderOperation: { id: "op-2", targetQuantity: "10" } }),
];

type StubOptions = {
  orders?: Order[] | ((callIndex: number) => Response);
  employees?: unknown[];
  reports?: unknown[];
  /** 批量保存 POST /production/employee-reports/batch 的响应。 */
  batch?: () => Response | Promise<Response>;
  /** 单条日报 PATCH / DELETE 的响应。 */
  mutate?: () => Response | Promise<Response>;
};

function stubPanel(options: StubOptions = {}) {
  let orderCalls = 0;
  return stubApi((url) => {
    if (url.endsWith("/production/employees")) return apiOk(options.employees ?? defaultEmployees);
    if (url.includes("/production/employee-reports/batch")) return (options.batch ?? (() => apiOk({})))();
    // 具体到 /employee-reports/:id 的变更请求（PATCH / DELETE）
    if (url.includes("/production/employee-reports/")) return (options.mutate ?? (() => apiOk({})))();
    if (url.includes("/production/employee-reports")) return apiOk(options.reports ?? defaultReports);
    if (url.includes("/production/orders")) {
      orderCalls += 1;
      if (typeof options.orders === "function") return options.orders(orderCalls);
      return apiOk(options.orders ?? defaultOrders);
    }
    return apiOk([]);
  });
}

/** 渲染面板（含 Toaster 以便断言通知），并等到首次加载完成。 */
async function renderPanel(options: StubOptions = {}) {
  const calls = stubPanel(options);
  render(
    <>
      <DailyReportsPanel />
      <Toaster />
    </>
  );
  await screen.findByTestId("daily-reports-panel");
  return calls;
}

/** 打开 MO-001 的「缝制」工序日报弹窗。 */
async function openOperationForm() {
  await userEvent.click(screen.getByRole("button", { name: "缝制" }));
  return screen.findByTestId("operation-report-form");
}

/** 通过批量选择器把给定员工加入日报草稿（每次都会打开一次选择器）。 */
async function pickEmployees(...ids: string[]) {
  await userEvent.click(screen.getByTestId("employee-report-add"));
  await screen.findByTestId("employee-picker");
  for (const id of ids) await userEvent.click(screen.getByTestId(`employee-picker-option-${id}`));
  await userEvent.click(screen.getByTestId("employee-picker-apply"));
  await waitFor(() => expect(screen.queryByTestId("employee-picker")).toBeNull());
}

const draftRow = (index: number) => within(screen.getByTestId("operation-report-draft-table")).getAllByRole("row").slice(1)[index];
const draftRowCount = () => within(screen.getByTestId("operation-report-draft-table")).getAllByRole("row").length - 1;
const reportRow = (index: number) => within(screen.getByTestId("employee-report-table")).getAllByRole("row").slice(1)[index];
const reportRowCount = () => within(screen.getByTestId("employee-report-table")).getAllByRole("row").length - 1;
const cellsOf = (row: HTMLElement) => within(row).getAllByRole("cell");

/** 填写草稿行的计价字段（草稿表每行 3 个 spinbutton：件数 / 时长 / 单价）。 */
async function fillDraftRow(index: number, values: { quantity?: string; duration_hours?: string; unit_price?: string; remark?: string }) {
  const row = draftRow(index);
  const spin = within(row).getAllByRole("spinbutton");
  if (values.quantity !== undefined) {
    await userEvent.clear(spin[0]);
    await userEvent.type(spin[0], values.quantity);
  }
  if (values.duration_hours !== undefined) {
    await userEvent.clear(spin[1]);
    await userEvent.type(spin[1], values.duration_hours);
  }
  if (values.unit_price !== undefined) {
    await userEvent.clear(spin[2]);
    await userEvent.type(spin[2], values.unit_price);
  }
  if (values.remark !== undefined) {
    const remark = within(row).getByRole("textbox");
    await userEvent.clear(remark);
    await userEvent.type(remark, values.remark);
  }
}

const batchBodies = (calls: ReturnType<typeof stubPanel>) =>
  callsTo(calls, "/production/employee-reports/batch").map((call) => JSON.parse(String(call.body)) as Record<string, unknown>);
const batchRows = (calls: ReturnType<typeof stubPanel>) =>
  batchBodies(calls).map((body) => JSON.parse(String(body.rows)) as Array<Record<string, string>>);
const patchCalls = (calls: ReturnType<typeof stubPanel>, id: string) => callsTo(calls, `/api/v1/production/employee-reports/${id}`);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------- A. 加载态与数据加载

describe("工序员工日报面板：加载态、错误态与生产单筛选", () => {
  it("首次加载渲染加载态，完成后渲染面板并只列出可登记的自产未完成生产单", async () => {
    const gate = deferred<Response>();
    stubApi((url) => (url.includes("/production/orders") ? gate.promise : apiOk([])));

    render(<DailyReportsPanel />);

    expect(screen.getByTestId("loading-state")).toBeVisible();

    gate.resolve(apiOk(defaultOrders));

    expect(await screen.findByTestId("daily-reports-panel")).toBeVisible();
    expect(screen.queryByTestId("loading-state")).toBeNull();
    // 草稿单（MO-002）与外协单（MO-003）都不能登记日报；进行中与已完成可以
    expect(screen.getByText("MO-001")).toBeVisible();
    expect(screen.getByText("MO-004")).toBeVisible();
    expect(screen.queryByText("MO-002")).toBeNull();
    expect(screen.queryByText("MO-003")).toBeNull();
    // 只有 active 工序有可点入口
    expect(screen.getByRole("button", { name: "缝制" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "裁剪" })).toBeNull();
  });

  it("没有可登记的生产单时渲染空态", async () => {
    await renderPanel({ orders: [] });

    expect(screen.getByTestId("empty-state")).toHaveTextContent("暂无未完成生产单");
  });

  it("加载失败渲染错误态；点「重新加载」重发请求并恢复面板", async () => {
    let orderAttempts = 0;
    const calls = stubApi((url) => {
      if (url.includes("/production/orders")) {
        orderAttempts += 1;
        return orderAttempts === 1 ? apiErr(500, "INTERNAL_ERROR", "生产单加载失败") : apiOk([order()]);
      }
      if (url.endsWith("/production/employees")) return apiOk(defaultEmployees);
      if (url.includes("/production/employee-reports")) return apiOk([]);
      return apiOk([]);
    });

    render(<DailyReportsPanel />);

    expect(await screen.findByTestId("error-state")).toHaveTextContent("生产单加载失败");

    await userEvent.click(screen.getByTestId("error-state-retry"));

    expect(await screen.findByTestId("daily-reports-panel")).toBeVisible();
    expect(screen.queryByTestId("error-state")).toBeNull();
    expect(callsTo(calls, "/production/orders")).toHaveLength(2);
  });

  it("员工选择器只列出在职员工", async () => {
    await renderPanel();
    await openOperationForm();
    await userEvent.click(screen.getByTestId("employee-report-add"));

    expect(await screen.findByTestId("employee-picker-option-e-1")).toHaveTextContent("E001 / 张三");
    expect(screen.getByTestId("employee-picker-option-e-2")).toBeVisible();
    expect(screen.queryByTestId("employee-picker-option-e-3")).toBeNull();
  });

  it("收到 production-order-operation-updated 事件时重新拉取数据", async () => {
    const calls = await renderPanel();
    expect(callsTo(calls, "/production/orders")).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new Event("production-order-operation-updated"));
    });

    await waitFor(() => expect(callsTo(calls, "/production/orders")).toHaveLength(2));
  });
});

// ---------------------------------------------------------------- B. 草稿行新增与编辑

describe("工序员工日报面板：草稿行新增与编辑", () => {
  it("批量选择员工：一次勾选多名员工，每名员工各追加一行草稿", async () => {
    await renderPanel();
    await openOperationForm();

    expect(draftRowCount()).toBe(0);

    await pickEmployees("e-1", "e-2");

    expect(draftRowCount()).toBe(2);
    expect(cellsOf(draftRow(0))[0]).toHaveTextContent("张三");
    expect(cellsOf(draftRow(1))[0]).toHaveTextContent("李四");
    // 未选查看日期时，新增行回落到当天
    expect(cellsOf(draftRow(0))[1]).toHaveTextContent(today);
  });

  it("同一员工可重复登记：再次打开选择器重新勾选会让同一员工出现两行独立草稿", async () => {
    await renderPanel();
    await openOperationForm();

    await pickEmployees("e-1");
    await pickEmployees("e-1");

    expect(draftRowCount()).toBe(2);
    expect(cellsOf(draftRow(0))[0]).toHaveTextContent("张三");
    expect(cellsOf(draftRow(1))[0]).toHaveTextContent("张三");
  });

  it("每次打开选择器都清空上次勾选：不重新勾选直接加入不会追加任何行", async () => {
    await renderPanel();
    await openOperationForm();

    await userEvent.click(screen.getByTestId("employee-report-add"));
    await screen.findByTestId("employee-picker");
    await userEvent.click(screen.getByTestId("employee-picker-option-e-1"));
    expect(screen.getByTestId("employee-picker-option-e-1")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("employee-picker-apply"));
    await waitFor(() => expect(screen.queryByTestId("employee-picker")).toBeNull());

    // 第二次打开：上一次的勾选必须已被清空，否则会静默多追加一行
    await userEvent.click(screen.getByTestId("employee-report-add"));
    await screen.findByTestId("employee-picker");
    expect(screen.getByTestId("employee-picker-option-e-1")).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByTestId("employee-picker-apply"));
    await waitFor(() => expect(screen.queryByTestId("employee-picker")).toBeNull());

    expect(draftRowCount()).toBe(1);
  });

  it("编辑草稿行：件数、单价、备注写回该行；计件行的时长输入不可编辑", async () => {
    await renderPanel();
    await openOperationForm();
    await pickEmployees("e-1");

    const spin = within(draftRow(0)).getAllByRole("spinbutton");
    expect(spin[1]).toBeDisabled();

    await fillDraftRow(0, { quantity: "7", unit_price: "12.5", remark: "上午批次" });

    expect(within(draftRow(0)).getAllByRole("spinbutton")[0]).toHaveValue(7);
    expect(within(draftRow(0)).getAllByRole("spinbutton")[2]).toHaveValue(12.5);
    expect(within(draftRow(0)).getByRole("textbox")).toHaveValue("上午批次");
  });

  it("计薪方式切到计时后时长输入启用；未填时长时保存被阻断并给出小时口径提示", async () => {
    const calls = await renderPanel();
    await openOperationForm();
    await pickEmployees("e-1");
    await fillDraftRow(0, { quantity: "1", unit_price: "20" });

    await userEvent.click(within(draftRow(0)).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "计时" }));

    const spin = within(draftRow(0)).getAllByRole("spinbutton");
    expect(spin[1]).toBeEnabled();

    await userEvent.click(screen.getByTestId("operation-report-save"));

    expect(await screen.findByText("计时日报必须填写时长（小时）")).toBeVisible();
    expect(callsTo(calls, "/production/employee-reports/batch")).toHaveLength(0);
  });

  it("删除草稿行只移除该行", async () => {
    await renderPanel();
    await openOperationForm();
    await pickEmployees("e-1", "e-2");
    expect(draftRowCount()).toBe(2);

    await userEvent.click(within(draftRow(0)).getByRole("button", { name: "删除" }));

    expect(draftRowCount()).toBe(1);
    expect(cellsOf(draftRow(0))[0]).toHaveTextContent("李四");
  });

  it("查看日期决定草稿行日期，并同步已有草稿行与批量保存的 report_date", async () => {
    const calls = await renderPanel();
    await openOperationForm();

    fireEvent.change(screen.getByTestId("operation-report-date"), { target: { value: "2026-02-10" } });
    await pickEmployees("e-1");
    expect(cellsOf(draftRow(0))[1]).toHaveTextContent("2026-02-10");

    // 改查看日期：已存在的草稿行日期一起跟随，否则行展示与批量 report_date 会不一致
    fireEvent.change(screen.getByTestId("operation-report-date"), { target: { value: "2026-02-11" } });
    expect(cellsOf(draftRow(0))[1]).toHaveTextContent("2026-02-11");

    await fillDraftRow(0, { quantity: "1", unit_price: "5" });
    await userEvent.click(screen.getByTestId("operation-report-save"));
    await waitFor(() => expect(callsTo(calls, "/production/employee-reports/batch")).toHaveLength(1));

    expect(batchBodies(calls)[0].report_date).toBe("2026-02-11");
  });
});

// ---------------------------------------------------------------- C. 保存链路

describe("工序员工日报面板：保存日报的请求体与幂等", () => {
  it("保存日报：POST 批量接口携带生产单/工序/report_date/rows，成功后弹窗关闭、提示并重新拉取", async () => {
    const calls = await renderPanel();
    await openOperationForm();
    await pickEmployees("e-1", "e-2");
    await fillDraftRow(0, { quantity: "5", unit_price: "12", remark: "上午" });
    await fillDraftRow(1, { quantity: "6", unit_price: "13" });

    await userEvent.click(screen.getByTestId("operation-report-save"));

    await waitFor(() => expect(screen.queryByTestId("operation-report-form")).toBeNull());
    expect(await screen.findByText("工序员工日报已保存")).toBeVisible();

    const [batch] = callsTo(calls, "/production/employee-reports/batch");
    expect(batch.method).toBe("POST");
    expect(batchBodies(calls)[0]).toMatchObject({
      production_order_id: "po-1",
      production_order_operation_id: "op-1",
      report_date: today,
    });

    const rows = batchRows(calls)[0];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ employee_id: "e-1", report_date: today, wage_mode: "piece_rate", quantity: "5", unit_price: "12", remark: "上午" });
    expect(rows[1]).toMatchObject({ employee_id: "e-2", quantity: "6", unit_price: "13" });
    // 幂等键是前端生成的；draft_id 是前端内部字段，绝不能进入请求体
    expect(rows[0].idempotency_key).toMatch(/^daily-/);
    expect(rows[1].idempotency_key).toMatch(/^daily-/);
    expect(rows[0].idempotency_key).not.toBe(rows[1].idempotency_key);
    expect(Object.keys(rows[0])).not.toContain("draft_id");
    // 保存成功后必须重新拉取，列表才会出现刚保存的日报
    expect(callsTo(calls, "/production/employee-reports")).toHaveLength(2);
  });

  it("保存日报：同一员工的两条草稿行必须产生不同的幂等键（否则第二条会被静默丢弃）", async () => {
    const calls = await renderPanel();
    await openOperationForm();
    await pickEmployees("e-1");
    await pickEmployees("e-1");
    await fillDraftRow(0, { quantity: "1", unit_price: "5" });
    await fillDraftRow(1, { quantity: "2", unit_price: "5" });

    await userEvent.click(screen.getByTestId("operation-report-save"));
    await waitFor(() => expect(callsTo(calls, "/production/employee-reports/batch")).toHaveLength(1));

    const rows = batchRows(calls)[0];
    expect(rows.map((row) => row.employee_id)).toEqual(["e-1", "e-1"]);
    expect(rows[0].idempotency_key).not.toBe(rows[1].idempotency_key);
  });

  it("计件件数为 0 时不发送请求，并给出可读错误", async () => {
    const calls = await renderPanel();
    await openOperationForm();
    await pickEmployees("e-1");
    await fillDraftRow(0, { unit_price: "10" });

    await userEvent.click(screen.getByTestId("operation-report-save"));

    expect(await screen.findByText("计件日报必须填写有效件数")).toBeVisible();
    expect(callsTo(calls, "/production/employee-reports/batch")).toHaveLength(0);
  });

  it("单价为空时不发送请求，并给出可读错误", async () => {
    const calls = await renderPanel();
    await openOperationForm();
    await pickEmployees("e-1");
    await fillDraftRow(0, { quantity: "3" });

    await userEvent.click(screen.getByTestId("operation-report-save"));

    expect(await screen.findByText("请填写当日人工单价")).toBeVisible();
    expect(callsTo(calls, "/production/employee-reports/batch")).toHaveLength(0);
  });

  it("保存中按钮禁用并改文案，重复点击只发出一次请求", async () => {
    const gate = deferred<Response>();
    const calls = await renderPanel({ batch: () => gate.promise });
    await openOperationForm();
    await pickEmployees("e-1");
    await fillDraftRow(0, { quantity: "1", unit_price: "5" });

    await userEvent.click(screen.getByTestId("operation-report-save"));

    await waitFor(() => expect(screen.getByTestId("operation-report-save")).toBeDisabled());
    expect(screen.getByTestId("operation-report-save")).toHaveTextContent("保存中...");

    await userEvent.click(screen.getByTestId("operation-report-save"));
    expect(callsTo(calls, "/production/employee-reports/batch")).toHaveLength(1);

    gate.resolve(apiOk({}));
    await waitFor(() => expect(screen.queryByTestId("operation-report-form")).toBeNull());
  });

  it("保存失败后重试：幂等键沿用原值，删掉首行也不会把旧键落到别的员工身上", async () => {
    const calls = await renderPanel({ batch: () => apiErr(500, "INTERNAL_ERROR", "批量保存失败") });
    await openOperationForm();
    await pickEmployees("e-1", "e-2");
    await fillDraftRow(0, { quantity: "1", unit_price: "5" });
    await fillDraftRow(1, { quantity: "2", unit_price: "5" });

    await userEvent.click(screen.getByTestId("operation-report-save"));
    await waitFor(() => expect(callsTo(calls, "/production/employee-reports/batch")).toHaveLength(1));

    const firstRows = batchRows(calls)[0];
    expect(firstRows.map((row) => row.employee_id)).toEqual(["e-1", "e-2"]);

    // 网络超时后操作员常常会删掉/调整一行再重试：行序号整体前移，
    // 若幂等键用序号拼，剩下这行会拿到已被 e-1 用过的旧键而被服务端当成重复提交丢弃
    await userEvent.click(within(draftRow(0)).getByRole("button", { name: "删除" }));
    await userEvent.click(screen.getByTestId("operation-report-save"));
    await waitFor(() => expect(callsTo(calls, "/production/employee-reports/batch")).toHaveLength(2));

    const secondRows = batchRows(calls)[1];
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0].employee_id).toBe("e-2");
    expect(secondRows[0].idempotency_key).toBe(firstRows[1].idempotency_key);
    expect(secondRows[0].idempotency_key).not.toBe(firstRows[0].idempotency_key);
  });

  it("保存失败：提示错误、弹窗保持打开且草稿行不丢", async () => {
    const calls = await renderPanel({ batch: () => apiErr(500, "INTERNAL_ERROR", "批量保存失败") });
    await openOperationForm();
    await pickEmployees("e-1");
    await fillDraftRow(0, { quantity: "1", unit_price: "5" });

    await userEvent.click(screen.getByTestId("operation-report-save"));

    expect(await screen.findByText("批量保存失败")).toBeVisible();
    expect(screen.getByTestId("operation-report-form")).toBeVisible();
    expect(draftRowCount()).toBe(1);
    expect(screen.getByTestId("operation-report-save")).toBeEnabled();
    // 失败不应触发整页刷新，避免用户输入被冲掉
    expect(callsTo(calls, "/production/employee-reports")).toHaveLength(1);
  });

  it("KNOWN_DEFECT：草稿表为空时点「保存日报」仍提示成功并关闭弹窗，且没有任何请求", async () => {
    // 期望：空草稿时不应宣称“已保存”（应禁用保存按钮或提示“请先添加日报行”）。
    // 实际：直接 notifySuccess + closeDialog，不发任何请求（daily-reports-panel.tsx:241 的 `if (drafts.length)`，
    //       保存按钮（:297）也不按 drafts.length 禁用）。属于“假成功”反馈，本轮只固化现状，不修产品代码。
    const calls = await renderPanel();
    await openOperationForm();
    expect(draftRowCount()).toBe(0);

    await userEvent.click(screen.getByTestId("operation-report-save"));

    expect(await screen.findByText("工序员工日报已保存")).toBeVisible();
    await waitFor(() => expect(screen.queryByTestId("operation-report-form")).toBeNull());
    expect(callsTo(calls, "/production/employee-reports/batch")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- D. 汇总数字与日报数据流

describe("工序员工日报面板：汇总数字与已存日报的数据流", () => {
  it("汇总条展示生产总数量、工序计划数量、本工序已完成数量与是否超单", async () => {
    await renderPanel();
    await openOperationForm();

    const summary = screen.getByTestId("daily-report-summary");
    expect(summary).toHaveTextContent("查看日期全部日期");
    expect(summary).toHaveTextContent("生产总数量100");
    expect(summary).toHaveTextContent("工序计划数量50");
    // 只统计当前生产单当前工序的计件日报：2 + 3 = 5（另一工序的 rep-9 与计时行 rep-3 不计入）
    expect(summary).toHaveTextContent("本工序已完成数量5");
    expect(summary).toHaveTextContent("是否超单否");

    fireEvent.change(screen.getByTestId("operation-report-date"), { target: { value: "2026-01-05" } });
    expect(summary).toHaveTextContent("查看日期2026-01-05");
  });

  it("已完成数量超过工序计划数量时显示超单", async () => {
    await renderPanel({ orders: [order({ operations: [{ id: "op-1", operationNameSnapshot: "缝制", targetQuantity: "3", status: "active" }] })] });
    await openOperationForm();

    expect(screen.getByTestId("daily-report-summary")).toHaveTextContent("本工序已完成数量5");
    expect(screen.getByTestId("daily-report-summary")).toHaveTextContent("是否超单是");
  });

  it("查看日期留空时展示当前工序全部日期的条目，选中日期后只展示该日条目", async () => {
    await renderPanel();
    await openOperationForm();

    expect(reportRowCount()).toBe(3);
    expect(within(screen.getByTestId("employee-report-table")).getByText("李四")).toBeVisible();

    fireEvent.change(screen.getByTestId("operation-report-date"), { target: { value: "2026-01-05" } });

    expect(reportRowCount()).toBe(2);
    expect(within(screen.getByTestId("employee-report-table")).queryByText("李四")).toBeNull();
  });

  it("时长按小时展示与编辑：90 分钟显示 1.5，计时行可编辑、计件行禁用", async () => {
    await renderPanel();
    await openOperationForm();
    fireEvent.change(screen.getByTestId("operation-report-date"), { target: { value: "2026-01-06" } });

    const timeRateSpin = within(reportRow(0)).getAllByRole("spinbutton");
    expect(timeRateSpin[1]).toHaveValue(1.5);
    expect(timeRateSpin[1]).toBeEnabled();
    // 计时行的单价语义按 元/小时 提示
    expect(timeRateSpin[2]).toHaveAttribute("title", "单价（元/小时）");

    fireEvent.change(screen.getByTestId("operation-report-date"), { target: { value: "2026-01-05" } });
    const pieceRateSpin = within(reportRow(0)).getAllByRole("spinbutton");
    expect(pieceRateSpin[1]).toBeDisabled();
    expect(pieceRateSpin[2]).toHaveAttribute("title", "单价（元/件）");
  });

  it("行内修改件数后本行薪资与「当日该员工总薪资」按员工+日期联动更新", async () => {
    await renderPanel();
    await openOperationForm();
    fireEvent.change(screen.getByTestId("operation-report-date"), { target: { value: "2026-01-05" } });

    // rep-1：2 件 × 10 元 = 20.00。
    // 「当日该员工总薪资」按 员工+日期 跨工序合计（与历史口径一致）：rep-1 20 + rep-2 30 + 另一工序 rep-9 20 = 70.00
    expect(cellsOf(reportRow(0))[7]).toHaveTextContent("20.00");
    expect(cellsOf(reportRow(0))[8]).toHaveTextContent("70.00");
    expect(cellsOf(reportRow(1))[8]).toHaveTextContent("70.00");

    const quantity = within(reportRow(0)).getAllByRole("spinbutton")[0];
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "5");

    // 行内编辑即时参与本地预览：本行 5 × 10 = 50.00，当日合计 50 + 30 + 20 = 100.00
    expect(cellsOf(reportRow(0))[7]).toHaveTextContent("50.00");
    expect(cellsOf(reportRow(0))[8]).toHaveTextContent("100.00");
    expect(cellsOf(reportRow(1))[8]).toHaveTextContent("100.00");
  });

  it("行内更正只提交改动过的计价字段：只改备注时 PATCH body 不含 quantity/unit_price/duration_hours", async () => {
    const calls = await renderPanel();
    await openOperationForm();
    fireEvent.change(screen.getByTestId("operation-report-date"), { target: { value: "2026-01-05" } });

    const save = screen.getByTestId("employee-report-save-rep-1");
    // 未改动时不允许保存；改备注后必须变为可保存（备注要参与“已修改”判定）
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent("未修改");

    await userEvent.clear(within(reportRow(0)).getByRole("textbox"));
    await userEvent.type(within(reportRow(0)).getByRole("textbox"), "补录备注");

    expect(screen.getByTestId("employee-report-save-rep-1")).toBeEnabled();
    expect(screen.getByTestId("employee-report-save-rep-1")).toHaveTextContent("保存");

    await userEvent.type(screen.getByPlaceholderText("更正原因"), "录入有误");
    await userEvent.click(screen.getByTestId("employee-report-save-rep-1"));

    await waitFor(() => expect(patchCalls(calls, "rep-1")).toHaveLength(1));
    const [patch] = patchCalls(calls, "rep-1");
    expect(patch.method).toBe("PATCH");
    expect(JSON.parse(String(patch.body))).toEqual({ reason: "录入有误", expected_version: 3, remark: "补录备注" });
    expect(await screen.findByText("日报已更正，当日员工薪资和总薪资已联动更新")).toBeVisible();
  });

  it("行内更正未填更正原因时阻断提交，不发送 PATCH", async () => {
    const calls = await renderPanel();
    await openOperationForm();
    fireEvent.change(screen.getByTestId("operation-report-date"), { target: { value: "2026-01-05" } });

    await userEvent.clear(within(reportRow(0)).getByRole("textbox"));
    await userEvent.type(within(reportRow(0)).getByRole("textbox"), "补录备注");
    await userEvent.click(screen.getByTestId("employee-report-save-rep-1"));

    expect(await screen.findByText("请填写更正原因后再保存日报修改")).toBeVisible();
    expect(patchCalls(calls, "rep-1")).toHaveLength(0);
  });

  it("行内更正失败（版本冲突）：丢弃本地编辑、刷新服务端最新数据并提示原因", async () => {
    const calls = await renderPanel({ mutate: () => apiErr(422, "DAILY_REPORT_VERSION_CONFLICT", "日报版本已过期") });
    await openOperationForm();
    fireEvent.change(screen.getByTestId("operation-report-date"), { target: { value: "2026-01-05" } });

    await userEvent.clear(within(reportRow(0)).getByRole("textbox"));
    await userEvent.type(within(reportRow(0)).getByRole("textbox"), "补录备注");
    await userEvent.type(screen.getByPlaceholderText("更正原因"), "录入有误");
    await userEvent.click(screen.getByTestId("employee-report-save-rep-1"));

    expect(await screen.findByText(/日报版本已过期/)).toBeVisible();
    // 残留的旧版本行内编辑必须被丢弃，否则用户会拿着过期 version 反复 422
    await waitFor(() => expect(screen.getByTestId("employee-report-save-rep-1")).toBeDisabled());
    expect(screen.getByTestId("employee-report-save-rep-1")).toHaveTextContent("未修改");
    expect(within(reportRow(0)).getByRole("textbox")).toHaveValue("原备注");
    expect(callsTo(calls, "/production/employee-reports")).toHaveLength(2);
  });

  it("更正弹窗回填展示原值；什么都没改时只提交原因与版本，不整包回传计价字段", async () => {
    const calls = await renderPanel();
    await openOperationForm();
    fireEvent.change(screen.getByTestId("operation-report-date"), { target: { value: "2026-01-05" } });

    await userEvent.click(within(reportRow(0)).getByRole("button", { name: "更正" }));

    expect(await screen.findByTestId("action-dialog")).toBeVisible();
    // 时长以小时回填（该计件行没有时长，应为空）
    expect(screen.getByTestId("action-field-quantity")).toHaveValue(2);
    expect(screen.getByTestId("action-field-duration_hours")).toHaveValue(null);
    expect(screen.getByTestId("action-field-unit_price")).toHaveValue(10);
    expect(screen.getByTestId("action-field-remark")).toHaveValue("原备注");

    await userEvent.type(screen.getByTestId("action-field-reason"), "工价复核");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(patchCalls(calls, "rep-1")).toHaveLength(1));
    expect(JSON.parse(String(patchCalls(calls, "rep-1")[0].body))).toEqual({ reason: "工价复核", expected_version: 3, remark: "原备注" });
    await waitFor(() => expect(screen.queryByTestId("action-dialog")).toBeNull());
  });
});
