// 仓库首页（app/warehouse/page.tsx）「待出库通知」面板的**真实行为**测试。
//
// 背景：原料出库改成两步后，仓库多了一块新职责 —— 生产「确认提交」送来的待出库单据
// （GET /production/material-movements/pending-outbound）必须由仓库「确认出库」才真正扣减原料库存。
// 本文件钉住：
//   1) 面板列出待出库单据（类型/生产单/订单号/物料明细/明细数/提交时间）；
//   2) 「确认出库」按单据类型走 postMovementPath（补料单必须走 post-replenishment）且带幂等键；
//   3) 待出库接口失败时不能把整页（含待入库通知）一起打空；
//   4) 空态说明触发条件，并保留跳到完整列表页的入口。
//
// 注意：globals: false，vitest API 必须显式 import（见 apps/web/vitest.config.mts）。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WarehousePage from "../app/warehouse/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

type Pending = Record<string, any>;

const inboundNotice = { id: "n-1", noticeNo: "IN-001", orderNo: "PO-001", status: "pending", notifiedQuantity: "20", notifiedAt: "2026-01-02T01:00:00.000Z", purchaseOrder: { purchaseOrderNo: "PO-2026-001" }, purchaseReceipt: { receiptNo: "RC-001" }, purchaseOrderItem: { material: { materialCode: "RM-9", name: "原料C" }, unit: { name: "米" } } };

const pendingIssue = (over: Pending = {}): Pending => ({
  id: "mv-1",
  movementNo: "MI-001",
  documentType: "issue",
  status: "pending_outbound",
  orderNo: "SO-001",
  productionOrderId: "po-1",
  businessDate: "2026-01-02",
  submittedAt: "2026-01-03T02:00:00.000Z",
  createdAt: "2026-01-02T03:04:05.000Z",
  productionOrder: { productionOrderNo: "MO-001", orderNo: "SO-001" },
  lines: [
    { id: "l-1", materialId: "m-1", quantity: "3", remark: null, material: { materialCode: "RM-1", name: "面料A", specificationModel: "150D" }, unit: { name: "米" } },
    { id: "l-2", materialId: "m-2", quantity: "8", remark: null, material: { materialCode: "RM-2", name: "拉链B", specificationModel: "3号" }, unit: { name: "条" } },
  ],
  ...over,
});

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, any>;
const lastTo = (calls: StubbedCall[], suffix: string) => callsTo(calls, suffix).at(-1)!;
const pendingCalls = (calls: StubbedCall[]) => calls.filter((call) => call.method === "GET" && call.url.endsWith("/production/material-movements/pending-outbound"));

type ApiRoutes = {
  notices?: (call: StubbedCall) => Response | Promise<Response>;
  pending?: (call: StubbedCall) => Response | Promise<Response>;
  actions?: (url: string, call: StubbedCall) => Response | Promise<Response> | undefined;
};

function stubWarehouseApi(routes: ApiRoutes = {}) {
  return stubApi((url, call) => {
    const intercepted = routes.actions?.(url, call);
    if (intercepted) return intercepted;
    if (url.endsWith("/raw-material-inbound-notices")) return routes.notices?.(call) ?? apiOk([inboundNotice]);
    if (url.endsWith("/production/material-movements/pending-outbound")) return routes.pending?.(call) ?? apiOk([pendingIssue()]);
    if (call.method === "POST") return apiOk({});
    return apiErr(404, "NOT_FOUND", `未打桩的请求：${call.method} ${url}`);
  });
}

/** 定位包含某单据号的待出库行。 */
function rowOf(text: string) {
  const row = screen.getByText(text).closest('[data-testid="data-table-row"]');
  if (!row) throw new Error(`没有找到包含「${text}」的待出库行`);
  return within(row as HTMLElement);
}

async function renderWarehouse(routes: ApiRoutes = {}) {
  const calls = stubWarehouseApi(routes);
  render(<><Toaster /><WarehousePage /></>);
  await screen.findByTestId("page-warehouse");
  return calls;
}

describe("仓库首页：待出库通知面板", () => {
  it("列出待出库单据：类型 / 生产单号 / 订单号 / 物料明细（物料名 × 数量单位）/ 明细数 / 提交时间", async () => {
    const calls = await renderWarehouse();
    await screen.findByText("MI-001");
    const row = rowOf("MI-001");

    expect(screen.getByRole("heading", { name: /待出库通知/ })).toBeVisible();
    expect(row.getByText("领料单")).toBeVisible();
    expect(row.getByText("MO-001")).toBeVisible();
    expect(row.getByText("SO-001")).toBeVisible();
    // 多条明细用「、」连接，仓库一眼看到要出哪些料、各多少
    expect(row.getByText("面料A × 3米、拉链B × 8条")).toBeVisible();
    expect(row.getByText("2")).toBeVisible();
    expect(row.getByText(new Date("2026-01-03T02:00:00.000Z").toLocaleString("zh-CN", { hour12: false }))).toBeVisible();
    expect(pendingCalls(calls)).toHaveLength(1);
    // 原有的待入库通知面板不受影响
    expect(screen.getByRole("heading", { name: /待入库通知/ })).toBeVisible();
    expect(screen.getByText("IN-001")).toBeVisible();
  });

  it("领料单行「确认出库」：POST /post 且带幂等键，成功后提示并重新拉取", async () => {
    const calls = await renderWarehouse();
    await screen.findByText("MI-001");

    await userEvent.click(rowOf("MI-001").getByRole("button", { name: "确认出库" }));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mv-1/post")).toHaveLength(1));
    const postCall = lastTo(calls, "/production/material-movements/mv-1/post");
    expect(postCall.method).toBe("POST");
    expect(bodyOf(postCall).idempotency_key).toMatch(/^web-outbound-/);
    expect(callsTo(calls, "/post-replenishment")).toHaveLength(0);
    expect(await screen.findByText("MI-001 已确认出库，原料库存已扣减")).toBeVisible();
    await waitFor(() => expect(pendingCalls(calls)).toHaveLength(2));
  });

  it("补料单行「确认出库」走 post-replenishment（打 /post 会被服务端判成「不是领料单」）", async () => {
    const calls = await renderWarehouse({ pending: () => apiOk([pendingIssue({ id: "mv-2", movementNo: "MC-001", documentType: "replenishment", reason: "坏片补料" })]) });
    await screen.findByText("MC-001");
    expect(rowOf("MC-001").getByText("补料单")).toBeVisible();

    await userEvent.click(rowOf("MC-001").getByRole("button", { name: "确认出库" }));

    await waitFor(() => expect(callsTo(calls, "/production/material-movements/mv-2/post-replenishment")).toHaveLength(1));
    expect(callsTo(calls, "/production/material-movements/mv-2/post")).toHaveLength(0);
    expect(bodyOf(lastTo(calls, "/post-replenishment")).idempotency_key).toMatch(/^web-outbound-/);
    expect(await screen.findByText("MC-001 已确认出库，原料库存已扣减")).toBeVisible();
  });

  it("确认出库失败：把后端消息提示出来，而不是误报成功", async () => {
    const calls = await renderWarehouse({ actions: (url) => (url.endsWith("/production/material-movements/mv-1/post") ? apiErr(422, "INSUFFICIENT_INVENTORY", "原料库存不足，无法出库") : undefined) });
    await screen.findByText("MI-001");

    await userEvent.click(rowOf("MI-001").getByRole("button", { name: "确认出库" }));

    expect(await screen.findByText("原料库存不足，无法出库")).toBeVisible();
    expect(screen.queryByText(/已确认出库/)).toBeNull();
    expect(pendingCalls(calls)).toHaveLength(1);
  });

  it("没有待出库单据：空态说明触发条件（生产点「确认提交」后才会出现）", async () => {
    await renderWarehouse({ pending: () => apiOk([]) });
    await screen.findByTestId("empty-state");

    const hints = screen.getAllByTestId("empty-state");
    expect(hints.some((hint) => hint.textContent?.includes("生产在领料单上点「确认提交」后，这里会出现待出库通知；确认出库才会真正扣减原料库存"))).toBe(true);
  });

  it("待出库接口失败不把整页打空：待入库通知照常渲染，且不显示整页错误", async () => {
    await renderWarehouse({ pending: () => apiErr(500, "INTERNAL", "待出库服务暂不可用") });
    await screen.findByText("IN-001");

    expect(screen.queryByTestId("error-state")).toBeNull();
    expect(screen.getByRole("heading", { name: /待出库通知/ })).toBeVisible();
    expect(screen.getAllByTestId("empty-state").length).toBeGreaterThan(0);
  });

  it("保留完整列表入口：面板里能跳到 /production/material-issues", async () => {
    await renderWarehouse();
    await screen.findByText("MI-001");

    const links = screen.getAllByRole("link", { name: /查看全部领料单 \/ 补料单|原料流转/ });
    expect(links.map((link) => link.getAttribute("href"))).toContain("/production/material-issues");
  });
});
