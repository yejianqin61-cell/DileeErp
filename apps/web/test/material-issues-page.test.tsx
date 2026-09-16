// 领料单 / 补料单列表页（app/production/material-issues/page.tsx）的**真实行为**测试。
//
// 背景：出库已改为两步 —— 生产在草稿上点「确认提交」把单据交给仓库（draft → pending_outbound，
// 不动库存），仓库「确认出库」时才写原料库存事实（pending_outbound → posted）。
// 之前该页面草稿行直接「过账出库」，等于生产单方扣减原料库存，仓库没有任何话语权；本文件钉住新口径：
//   1) 草稿行只能「确认提交」（POST .../submit，请求体为空、不带幂等键），不再直接打 /post；
//   2) 「待仓库出库」行显示状态，可「撤回提交」（reopen 带必填原因），也可由仓库在本页「确认出库」；
//   3) 双击任意行弹出详情窗口，逐行列出该单**全部**领用物料（而不是列表里的「N 项」合计）。
//
// 注意：globals: false，vitest API 必须显式 import（见 apps/web/vitest.config.mts）。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MaterialIssuesPage from "../app/production/material-issues/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

type Issue = Record<string, any>;

const line = (over: Issue = {}): Issue => ({ id: "l-1", materialId: "m-1", quantity: "3", remark: null, unit: { name: "米" }, material: { materialCode: "RM-1", name: "面料A", specificationModel: "150D" }, ...over });

const issue = (over: Issue = {}): Issue => ({
  id: "mi-1",
  movementNo: "MI-001",
  documentType: "issue",
  status: "draft",
  orderNo: "SO-001",
  productionOrderId: "po-1",
  productionOrder: { productionOrderNo: "MO-001", orderNo: "SO-001" },
  businessDate: "2026-01-02",
  createdAt: "2026-01-02T03:04:05.000Z",
  remark: null,
  reason: null,
  lines: [line()],
  ...over,
});

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, any>;
const lastTo = (calls: StubbedCall[], suffix: string) => callsTo(calls, suffix).at(-1)!;
const listCalls = (calls: StubbedCall[]) => calls.filter((call) => call.method === "GET" && call.url.endsWith("/production/material-movements"));
/** 按单元格文本定位单据行（表格行都带 data-testid="data-table-row"）。 */
function rowOf(text: string) {
  const row = screen.getByText(text).closest('[data-testid="data-table-row"]');
  if (!row) throw new Error(`没有找到包含「${text}」的单据行`);
  return within(row as HTMLElement);
}

type ApiRoutes = {
  movements?: (call: StubbedCall) => Response | Promise<Response>;
  /** 双击行弹出的详情：GET /production/material-movements/:id。 */
  detail?: (call: StubbedCall) => Response | Promise<Response>;
  /** 提交 / 确认出库 / reopen / reverse / 删除等写操作的兜底钩子，返回 undefined 表示不拦截。 */
  actions?: (url: string, call: StubbedCall) => Response | Promise<Response> | undefined;
};

function stubPageApi(routes: ApiRoutes = {}) {
  return stubApi((url, call) => {
    const intercepted = routes.actions?.(url, call);
    if (intercepted) return intercepted;
    if (url.endsWith("/production/orders")) return apiOk([]);
    if (url.includes("/production/material-movements")) {
      // 详情 GET 与列表 GET 必须分开：列表桩返回数组，当成详情会把弹窗撑坏。
      if (call.method === "GET" && /\/production\/material-movements\/[^/?]+$/.test(url)) return routes.detail?.(call) ?? apiErr(404, "NOT_FOUND", `未打桩的详情请求：${url}`);
      if (call.method === "GET") return routes.movements?.(call) ?? apiOk([]);
      return apiOk({});
    }
    return apiErr(404, "NOT_FOUND", `未打桩的请求：${call.method} ${url}`);
  });
}

async function renderPage(routes: ApiRoutes = {}) {
  const calls = stubPageApi(routes);
  render(<><Toaster /><MaterialIssuesPage /></>);
  await screen.findByTestId("page-production-material-issues");
  return calls;
}

describe("领料单列表页：确认提交（草稿 → 待仓库出库）", () => {
  it("草稿行「确认提交」打到 /submit 且请求体为空：不再由生产端直接过账扣库存", async () => {
    const calls = await renderPage({ movements: () => apiOk([issue()]) });
    await screen.findByText("MI-001");

    await userEvent.click(rowOf("MI-001").getByRole("button", { name: "确认提交" }));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mi-1/submit")).toHaveLength(1));
    const submitCall = lastTo(calls, "/production/material-movements/mi-1/submit");
    expect(submitCall.method).toBe("POST");
    expect(bodyOf(submitCall)).toEqual({});
    // 旧的一步过账入口必须彻底消失（打出去就等于绕过仓库）
    expect(callsTo(calls, "/production/material-movements/mi-1/post")).toHaveLength(0);
    expect(callsTo(calls, "/post-replenishment")).toHaveLength(0);
    expect(await screen.findByText("已提交仓库，等待确认出库")).toBeVisible();
    // 成功后重新拉列表，用户马上能看到新状态
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
  });

  it("待仓库出库行：状态显示为「待仓库出库」，「撤回提交」必须填原因后 POST reopen", async () => {
    const calls = await renderPage({ movements: () => apiOk([issue({ id: "mi-5", movementNo: "MI-005", status: "pending_outbound", submittedAt: "2026-01-03T02:00:00.000Z" })]) });
    await screen.findByText("MI-005");
    const row = rowOf("MI-005");

    expect(row.getByText("待仓库出库")).toBeVisible();
    await userEvent.click(row.getByRole("button", { name: "撤回提交" }));

    // 原因必填：空着提交被挡下，且不发请求
    expect(await screen.findByRole("heading", { name: "撤回提交：MI-005" })).toBeVisible();
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写撤回原因");
    expect(callsTo(calls, "/reopen")).toHaveLength(0);

    await userEvent.type(screen.getByTestId("action-field-reason"), "车间填错数量");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mi-5/reopen")).toHaveLength(1));
    expect(bodyOf(lastTo(calls, "/reopen"))).toEqual({ reason: "车间填错数量" });
    expect(await screen.findByText("已撤回提交，单据回到草稿")).toBeVisible();
  });

  it("待仓库出库行可由仓库在本页「确认出库」：领料单走 /post 且带幂等键", async () => {
    const calls = await renderPage({ movements: () => apiOk([issue({ id: "mi-6", movementNo: "MI-006", status: "pending_outbound" })]) });
    await screen.findByText("MI-006");

    await userEvent.click(rowOf("MI-006").getByRole("button", { name: "确认出库" }));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mi-6/post")).toHaveLength(1));
    const postCall = lastTo(calls, "/production/material-movements/mi-6/post");
    expect(postCall.method).toBe("POST");
    // 这一步写库存事实：必须带幂等键，否则重复点击会把同一批料扣两遍
    expect(typeof bodyOf(postCall).idempotency_key).toBe("string");
    expect(bodyOf(postCall).idempotency_key).toMatch(/^web-movement-/);
    expect(await screen.findByText("领料单已确认出库")).toBeVisible();
  });

  it("待仓库出库的补料单「确认出库」走 post-replenishment（打 /post 会被服务端 422）", async () => {
    const calls = await renderPage({ movements: () => apiOk([issue({ id: "mc-1", movementNo: "MC-001", documentType: "replenishment", status: "pending_outbound", reason: "坏片补料" })]) });
    await screen.findByText("MC-001");
    expect(rowOf("MC-001").getByText("补料单")).toBeVisible();

    await userEvent.click(rowOf("MC-001").getByRole("button", { name: "确认出库" }));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mc-1/post-replenishment")).toHaveLength(1));
    expect(callsTo(calls, "/production/material-movements/mc-1/post")).toHaveLength(0);
    expect(bodyOf(lastTo(calls, "/post-replenishment")).idempotency_key).toMatch(/^web-movement-/);
    expect(await screen.findByText("补料单已确认出库")).toBeVisible();
  });

  it("状态筛选提供「待仓库出库」：选中后只留下待出库单据", async () => {
    await renderPage({ movements: () => apiOk([issue(), issue({ id: "mi-5", movementNo: "MI-005", status: "pending_outbound" })]) });
    await screen.findByText("MI-001");
    expect(screen.getByText("MI-005")).toBeVisible();

    // 筛选栏的三个下拉依次是：生产单 / 类型 / 状态
    await userEvent.click(screen.getAllByRole("combobox")[2]);
    await userEvent.click(await screen.findByRole("option", { name: "待仓库出库" }));

    await waitFor(() => expect(screen.queryByText("MI-001")).toBeNull());
    expect(screen.getByText("MI-005")).toBeVisible();
  });
});

describe("领料单列表页：双击查看全部领用物料", () => {
  it("双击单据行：弹窗逐行列出该单全部领用物料（物料名称与数量都出现）", async () => {
    const detail = issue({
      id: "mi-9",
      movementNo: "MI-009",
      orderNo: "SO-009",
      submittedAt: "2026-01-03T02:00:00.000Z",
      productionOrder: { productionOrderNo: "MO-009", orderNo: "SO-009" },
      lines: [
        line({ id: "l-1", materialId: "m-1", quantity: "3", unit: { name: "米" }, material: { materialCode: "RM-1", name: "面料A", specificationModel: "150D" } }),
        line({ id: "l-2", materialId: "m-2", quantity: "8", unit: { name: "条" }, remark: "备损", material: { materialCode: "RM-2", name: "拉链B", specificationModel: "3号" } }),
      ],
    });
    const calls = await renderPage({
      // 列表行只有 materialId，物料编码/名称/规格必须由详情接口补上
      movements: () => apiOk([issue({ id: "mi-9", movementNo: "MI-009", lines: [line({ id: "l-1", materialId: "m-1", quantity: "3", material: undefined })] })]),
      detail: () => apiOk(detail),
    });
    await screen.findByText("MI-009");

    await userEvent.dblClick(screen.getByText("MI-009"));

    const dialog = await screen.findByTestId("material-slip-detail");
    expect(callsTo(calls, "/production/material-movements/mi-9")).toHaveLength(1);
    expect(within(dialog).getByText("领用物料（2 项）")).toBeVisible();
    const rows = within(dialog).getAllByTestId("data-table-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("面料A");
    expect(rows[0]).toHaveTextContent("3");
    expect(rows[1]).toHaveTextContent("拉链B");
    expect(rows[1]).toHaveTextContent("8");
    expect(rows[1]).toHaveTextContent("备损");
    // 头部字段也要齐全
    expect(within(dialog).getByText("MO-009")).toBeVisible();
    expect(within(dialog).getByText("SO-009")).toBeVisible();
  });

  it("详情加载失败：弹窗内显示错误与重试，不静默空白", async () => {
    const calls = await renderPage({
      movements: () => apiOk([issue({ id: "mi-9", movementNo: "MI-009" })]),
      detail: () => apiErr(500, "INTERNAL", "单据详情暂不可用"),
    });
    await screen.findByText("MI-009");

    await userEvent.dblClick(screen.getByText("MI-009"));

    const dialog = await screen.findByTestId("material-slip-detail");
    expect(within(dialog).getByTestId("error-state")).toHaveTextContent("单据详情暂不可用");

    await userEvent.click(within(dialog).getByTestId("error-state-retry"));
    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mi-9")).toHaveLength(2));
  });
});
