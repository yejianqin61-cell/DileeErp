// 成品出库通知链路（销售发起 → 仓库按整批建出库单）的真实行为测试。
//
// 取代的遗留源码正则测试：apps/web/lib/outbound-notice-entries.test.mjs
// 那个文件用 readFileSync 读 .tsx 文本做正则匹配，只能证明"源码里出现过某个字符串"：
// 把按钮的 onClick 删掉、把 production_order_id 从请求体里去掉、把 disabled 拆掉，
// 正则一样全绿。这里改为真实渲染 + 真实点击/输入，断言**实际发出的请求**与**屏幕上的结果**。
//
// 继承自 outbound-notice-entries.test.mjs 的断言意图（逐条落地为行为）：
//   1) 打开销售单必须能看到成品入库/出库与可出库量（GET /sales-orders/:id/finished-goods）；
//   2) 销售页必须有可点的「通知仓库出库」入口（单批）与「通知仓库出库（全部可出库批次）」，
//      且没有可出库量时单批入口不可点（正则只能证明字符串存在）；
//   3) 提交出库通知的请求体形状：单批带 production_order_id，整批不带；两者都带幂等键；
//   4) 待处理通知可以取消，取消必须填原因，原因进入请求体；
//   5) 仓库页必须能看到销售发起的出库通知列表，并只对 pending 提供「生成出库单」；
//   6) 整批口径：生成出库单的请求体不携带数量（数量由通知固定，仓库不能改）；
//   7) 出库单过账后要提示"已生成应收来源，等待财务收款"。
//
// 说明：本文件的"明细行"= 销售单下按生产单拆分的成品行；新增一条明细 = 对该行发出库通知，
// 删除一条明细 = 取消该通知。这两个页面里**不存在**可编辑单元格形式的出库通知明细表格
// （详见交付报告"未能覆盖的行为"）。
//
// 注意：globals: false，测试 API 必须显式 import。
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SalesPage from "../app/sales/page";
import FinishedGoodsStoragePage from "../app/warehouse/finished-goods-storage/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 可手动控制兑现时机的 Promise：把页面稳定停在"提交中/加载中"状态做断言。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const lastTo = (calls: StubbedCall[], suffix: string) => callsTo(calls, suffix).at(-1)!;

/** 按单元格文本定位明细行，再做行内断言（表格很多，不能靠 getAllByTestId 的下标）。 */
function rowOf(text: string) {
  const cell = screen.getByText(text);
  const row = cell.closest('[data-testid="data-table-row"]');
  if (!row) throw new Error(`没有找到包含「${text}」的明细行`);
  return within(row as HTMLElement);
}

/* ------------------------------------------------------------------ 销售页桩 */

const ORDER_ID = "so-1";
const ORDER_NO = "SO-20260101-001";
const FG_URL = `/api/v1/sales-orders/${ORDER_ID}/finished-goods`;

const contact = { id: "contact-1", name: "张三", phone: "138", isDefault: true, isActive: true };
const customer = { id: "cust-1", customerCode: "C-001", name: "客户A", isActive: true, contacts: [contact] };
const order = { id: ORDER_ID, orderNo: ORDER_NO, productName: "连衣裙", productSpec: "M", quantity: "100", unit: "件", status: "confirmed", customer, boms: [] };
const units = [{ id: "unit-1", name: "件", isActive: true }];

type Summary = Record<string, unknown>;

/** 成品情况：po-1 有 60 件可出库（历史通知已出库），po-2 的可出库量已被待处理通知占满。 */
const summary: Summary = {
  sales_order_id: ORDER_ID,
  order_no: ORDER_NO,
  customer: "客户A",
  product_name: "连衣裙",
  unit: "件",
  // 本单合计（后端按「产品+单位」折出来的三个数字）：全部 70+20=90，已出库 10，未出库 80
  totals: [{ product_name: "连衣裙", unit: "件", inbound_quantity: "90", outbound_quantity: "10", unshipped_quantity: "80", production_order_count: 2 }],
  production_orders: [
    {
      production_order_id: "po-1",
      production_order_no: "MO-1",
      production_status: "completed",
      planned_quantity: "100",
      inbound_quantity: "70",
      outbound_quantity: "10",
      pending_notice_quantity: "0",
      available_quantity: "60",
      unit: "件",
      notices: [{ id: "n-done", notice_no: "OGN-DONE", notice_quantity: "10", shipped_quantity: "10", remaining_quantity: "0", status: "completed", notified_at: "2026-01-01T00:00:00.000Z", outbound_nos: ["OUT-9"], outbound_statuses: ["posted"] }],
    },
    {
      production_order_id: "po-2",
      production_order_no: "MO-2",
      production_status: "in_progress",
      planned_quantity: "50",
      inbound_quantity: "20",
      outbound_quantity: "0",
      pending_notice_quantity: "20",
      available_quantity: "0",
      unit: "件",
      notices: [{ id: "n-1", notice_no: "OGN-1", notice_quantity: "20", shipped_quantity: "0", remaining_quantity: "20", status: "pending", notified_at: "2026-01-02T00:00:00.000Z" }],
    },
  ],
};

/** 分批通知：只通知 20 件时服务端返回的通知（提示语用服务端返回的通知号与数量）。 */
const partialNotice = { id: "n-part", notice_no: "OGN-PART", notice_quantity: "20", shipped_quantity: "0", remaining_quantity: "20", status: "pending", notified_at: "2026-01-03T00:00:00.000Z" };
/** 只通知 20 件后：待仓库建单 20、仍可出库 40（余量没有被吃掉，可以再通知一次）。 */
const summaryAfterPartialNotify: Summary = {
  ...summary,
  production_orders: [
    { ...(summary.production_orders as Summary[])[0], pending_notice_quantity: "20", available_quantity: "40", notices: [partialNotice, ...((summary.production_orders as Summary[])[0].notices as unknown[])] },
    (summary.production_orders as Summary[])[1],
  ],
};

/** 销售页顶部的成品出库总览（模块级：全部销售单按产品+单位汇总）。 */
const finishedGoodsOverview = {
  production_order_count: 2,
  groups: [{ product_name: "连衣裙", unit: "件", inbound_quantity: "90", outbound_quantity: "10", unshipped_quantity: "80", production_order_count: 2 }],
};

function salesApi(routes: { summary?: (callIndex: number) => Response; notify?: () => Response | Promise<Response>; overview?: (callIndex: number) => Response } = {}) {
  let summaryCalls = 0;
  let overviewCalls = 0;
  const calls = stubApi((url) => {
    if (url.includes(`/sales-orders/${ORDER_ID}/finished-goods`)) {
      summaryCalls += 1;
      return routes.summary?.(summaryCalls) ?? apiOk(summary);
    }
    if (url.endsWith("/sales-orders/finished-goods-summary")) {
      overviewCalls += 1;
      return routes.overview?.(overviewCalls) ?? apiOk(finishedGoodsOverview);
    }
    if (url.includes("/outbound-notices")) return routes.notify?.() ?? apiOk([]);
    if (url.endsWith("/customers?page_size=200")) return apiOk([customer]);
    if (url.endsWith("/sales-orders?page_size=200")) return apiOk([order]);
    if (url.endsWith("/units")) return apiOk(units);
    return apiErr(404, "NOT_FOUND", `未打桩的请求：${url}`);
  });
  return { calls, summaryCalls: () => summaryCalls, overviewCalls: () => overviewCalls };
}

function renderSales() {
  return render(
    <>
      <SalesPage />
      <Toaster />
    </>
  );
}

/** 打开销售单详情（Sheet），停在「成品入库与出库」区块。 */
async function openOrderSheet() {
  await userEvent.click(await screen.findByRole("button", { name: ORDER_NO }));
  expect(await screen.findByRole("heading", { name: "成品入库与出库" })).toBeVisible();
}

const notifyButtons = () => screen.getAllByRole("button", { name: "通知仓库出库" });
const batchNotifyButton = () => screen.getByRole("button", { name: "通知仓库出库（全部可出库批次）" });

describe("销售页：出库通知明细（成品入库与出库）", () => {
  it("销售页顶部：成品出库总览给出全部成品数 / 已出库数 / 未出库数（按产品与单位分行）", async () => {
    const { calls, overviewCalls } = salesApi();
    renderSales();

    const panel = within(await screen.findByTestId("finished-goods-overview"));
    expect(callsTo(calls, "/api/v1/sales-orders/finished-goods-summary")).toHaveLength(1);
    expect(overviewCalls()).toBe(1);
    // 三个数字的表头必须与用户口径同名，且说清「按产品与单位分行、不做跨单位合计」
    expect(panel.getByText("全部成品数")).toBeVisible();
    expect(panel.getByText("已出库数")).toBeVisible();
    expect(panel.getByText("未出库数")).toBeVisible();
    expect(panel.getByText(/不同单位的数量不做合计/)).toBeVisible();

    const row = panel.getByText("连衣裙").closest('[data-testid="data-table-row"]') as HTMLElement;
    expect(within(row).getByText("件")).toBeVisible();
    expect(within(row).getByText("90")).toBeVisible();
    expect(within(row).getByText("10")).toBeVisible();
    expect(within(row).getByText("80")).toBeVisible();
  });

  it("成品总览加载失败：就地给出错误态与重试，客户池/销售单两张表照常渲染", async () => {
    let failing = true;
    const { calls } = salesApi({ overview: () => (failing ? apiErr(500, "INTERNAL", "成品总览服务暂不可用") : apiOk(finishedGoodsOverview)) });
    renderSales();

    const panel = within(await screen.findByTestId("finished-goods-overview"));
    expect(await panel.findByText("成品总览服务暂不可用")).toBeVisible();
    expect(panel.queryByText("正在加载成品总览…")).toBeNull();
    expect(screen.getByRole("heading", { name: "客户池" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "销售单" })).toBeVisible();

    failing = false;
    await userEvent.click(panel.getByTestId("error-state-retry"));

    expect(await panel.findByText("全部成品数")).toBeVisible();
    expect(callsTo(calls, "/api/v1/sales-orders/finished-goods-summary")).toHaveLength(2);
  });

  it("打开销售单：拉取成品情况，按生产单展示入库/出库/可出库量，并只对待处理通知给出取消入口", async () => {
    const gate = deferred<Response>();
    const { calls, summaryCalls } = salesApi({ summary: () => gate.promise as unknown as Response });
    renderSales();
    await openOrderSheet();

    // 成品情况是异步拉取的：未返回前必须是明确的加载占位，而不是空数据
    expect(screen.getByText("正在加载成品情况…")).toBeVisible();
    expect(callsTo(calls, FG_URL)).toHaveLength(1);

    await act(async () => {
      gate.resolve(apiOk(summary));
    });

    expect(summaryCalls()).toBe(1);
    // 每一行明细：生产单号 + 状态 + 四个数量口径（可出库量决定能否通知）
    expect(await screen.findByText("MO-1 · 已完工")).toBeVisible();
    expect(screen.getByText("MO-2 · 生产中")).toBeVisible();
    // 本单合计（后端按产品+单位折出来的三个数字）显示在明细行上方
    expect(screen.getByTestId("order-finished-goods-totals")).toHaveTextContent("连衣裙 件 · 全部成品 90 · 已出库 10 · 未出库 80");
    expect(screen.getByText(/成品已入库 70 \/ 已出库 10 \/ 待仓库建单 0 \/ 可出库 60 件/)).toBeVisible();
    expect(screen.getByText(/成品已入库 20 \/ 已出库 0 \/ 待仓库建单 20 \/ 可出库 0 件/)).toBeVisible();

    // 明细行操作：可出库量 > 0 的行可通知；已被待处理通知占满的行不可点
    const buttons = notifyButtons();
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();

    // 通知明细：已完成的没有取消入口，待处理的才有（正则测试只能证明字符串存在）
    // 分批出库后行内展示 已出库/剩余（第三批需求 1）。
    const doneNotice = screen.getByText(/OGN-DONE · 通知 10 · 已出库 10 · 剩余 0 · 已出库（已通知财务收款） · 出库单 OUT-9/);
    expect(within(doneNotice).queryByRole("button", { name: "取消通知" })).toBeNull();
    const pendingNotice = screen.getByText(/OGN-1 · 通知 20 · 已出库 0 · 剩余 20 · 待仓库建出库单/);
    expect(within(pendingNotice).getByRole("button", { name: "取消通知" })).toBeEnabled();
  });

  it("单批「通知仓库出库」：弹窗默认整批可出库量，填成一部分后只通知该数量（分批通知）", async () => {
    const { calls } = salesApi({ summary: (index) => apiOk(index === 1 ? summary : summaryAfterPartialNotify), notify: () => apiOk([partialNotice]) });
    renderSales();
    await openOrderSheet();
    await screen.findByText("MO-1 · 已完工");

    await userEvent.click(notifyButtons()[0]);

    // 弹窗把「本次通知数量」（默认=全部可出库量）与「可只通知一部分」讲清楚
    expect(await screen.findByRole("heading", { name: "通知仓库出库：MO-1" })).toBeVisible();
    const quantity = screen.getByTestId<HTMLInputElement>("action-field-notice_quantity");
    expect(quantity).toHaveValue(60);
    expect(quantity).toHaveAttribute("placeholder", "可出库 60 件（可只通知一部分，余量以后再通知）");

    await userEvent.clear(quantity);
    await userEvent.type(quantity, "20");
    await userEvent.type(screen.getByTestId("action-field-remark"), "客户先要第一批");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, `/api/v1/sales-orders/${ORDER_ID}/outbound-notices`)).toHaveLength(1));
    const notify = lastTo(calls, `/api/v1/sales-orders/${ORDER_ID}/outbound-notices`);
    expect(notify.method).toBe("POST");
    // 请求体形状：指定生产单 + 本次通知数量 + 备注 + 幂等键（服务端按幂等键去重）
    expect(bodyOf(notify)).toMatchObject({ production_order_id: "po-1", notice_quantity: "20", remark: "客户先要第一批" });
    expect(bodyOf(notify).idempotency_key).toMatch(/^web-outbound-\d+-[a-z0-9]+$/);

    // 数据流：提交成功后必须重新拉成品情况；提示语用服务端返回的通知号与数量
    expect(await screen.findByText("已通知仓库出库：OGN-PART 本次 20 件")).toBeVisible();
    await waitFor(() => expect(callsTo(calls, FG_URL)).toHaveLength(2));
    expect(await screen.findByText(/OGN-PART · 通知 20 · 已出库 0 · 剩余 20 · 待仓库建出库单/)).toBeVisible();
    // 余量 40 没有被吃掉：该行仍可继续通知（下一批）
    expect(screen.getByText(/成品已入库 70 \/ 已出库 10 \/ 待仓库建单 20 \/ 可出库 40 件/)).toBeVisible();
    expect(notifyButtons()[0]).toBeEnabled();
  });

  it("分批通知超量：服务端 422 就地显示在弹窗里，不关闭弹窗、不刷新成品情况（不静默截断）", async () => {
    const { calls } = salesApi({ notify: () => apiErr(422, "OUTBOUND_NOTICE_QUANTITY_EXCEEDED", "本次通知数量超过当前可出库量") });
    renderSales();
    await openOrderSheet();
    await screen.findByText("MO-1 · 已完工");

    await userEvent.click(notifyButtons()[0]);
    const quantity = await screen.findByTestId<HTMLInputElement>("action-field-notice_quantity");
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "80");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("本次通知数量超过当前可出库量");
    // 弹窗保留、用户填的数量还在（改小即可重试）
    expect(screen.getByTestId("action-dialog")).toBeVisible();
    expect(screen.getByTestId<HTMLInputElement>("action-field-notice_quantity")).toHaveValue(80);
    expect(callsTo(calls, FG_URL)).toHaveLength(1);
    expect(screen.queryByText(/已通知仓库出库/)).toBeNull();
  });

  it("整批「通知仓库出库（全部可出库批次）」：请求体不带 production_order_id（由服务端决定批次）", async () => {
    const { calls } = salesApi({ notify: () => apiOk([]) });
    renderSales();
    await openOrderSheet();
    await screen.findByText("MO-1 · 已完工");

    await userEvent.click(batchNotifyButton());

    await waitFor(() => expect(callsTo(calls, `/api/v1/sales-orders/${ORDER_ID}/outbound-notices`)).toHaveLength(1));
    const notify = lastTo(calls, `/api/v1/sales-orders/${ORDER_ID}/outbound-notices`);
    const body = bodyOf(notify);
    expect(Object.keys(body)).not.toContain("production_order_id");
    expect(body.idempotency_key).toMatch(/^web-outbound-/);
    // 返回空数组表示这一次没有可出库的批次：提示语必须退化为普通成功文案
    expect(await screen.findByText("已通知仓库出库")).toBeVisible();
  });

  it("通知提交中：整批与所有单批入口一并禁用，连点只发一次请求（防重复通知）", async () => {
    const gate = deferred<Response>();
    const { calls } = salesApi({ notify: () => gate.promise });
    renderSales();
    await openOrderSheet();
    await screen.findByText("MO-1 · 已完工");

    await userEvent.click(batchNotifyButton());

    await waitFor(() => expect(batchNotifyButton()).toBeDisabled());
    for (const button of notifyButtons()) expect(button).toBeDisabled();

    // 连点：disabled 的按钮不再触发 onClick
    await userEvent.click(batchNotifyButton());
    await userEvent.click(notifyButtons()[0]);
    expect(callsTo(calls, `/api/v1/sales-orders/${ORDER_ID}/outbound-notices`)).toHaveLength(1);

    await act(async () => {
      gate.resolve(apiOk([]));
    });
  });

  it("通知失败：把服务端可读原因展示在弹窗里，不冒充成功也不刷新（没有新通知）", async () => {
    const { calls } = salesApi({ notify: () => apiErr(422, "OUTBOUND_NOTICE_NOTHING_TO_NOTIFY", "该生产单没有可通知出库的成品：需要先完成成品入库") });
    renderSales();
    await openOrderSheet();
    await screen.findByText("MO-1 · 已完工");

    await userEvent.click(notifyButtons()[0]);
    await screen.findByRole("heading", { name: "通知仓库出库：MO-1" });
    // 默认数量=可出库量，直接提交；失败原因必须按服务端原文展示，且弹窗不关
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("该生产单没有可通知出库的成品：需要先完成成品入库");
    expect(screen.queryByText(/已通知仓库出库/)).toBeNull();
    await waitFor(() => expect(callsTo(calls, `/api/v1/sales-orders/${ORDER_ID}/outbound-notices`)).toHaveLength(1));
    // 失败路径不得重新拉取成品情况（页面不会出现幻影通知）
    expect(callsTo(calls, FG_URL)).toHaveLength(1);
  });

  it("取消出库通知：原因必填（空提交不发请求），填好后原因进入请求体并刷新明细", async () => {
    const { calls } = salesApi({ summary: (index) => apiOk(index === 1 ? summary : summaryAfterCancel) });
    renderSales();
    await openOrderSheet();
    const pendingNotice = await screen.findByText(/OGN-1 · 通知 20/);

    await userEvent.click(within(pendingNotice).getByRole("button", { name: "取消通知" }));

    expect(await screen.findByRole("heading", { name: "取消出库通知：OGN-1" })).toBeVisible();
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写取消原因");
    expect(callsTo(calls, "/cancel")).toHaveLength(0);

    await userEvent.type(screen.getByTestId("action-field-reason"), "客户改期，先不出库");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/cancel")).toHaveLength(1));
    const cancel = lastTo(calls, "/cancel");
    expect(cancel.method).toBe("POST");
    expect(cancel.url).toBe(`/api/v1/sales-orders/${ORDER_ID}/outbound-notices/n-1/cancel`);
    expect(bodyOf(cancel)).toEqual({ reason: "客户改期，先不出库" });

    expect(await screen.findByText("出库通知已取消")).toBeVisible();
    await waitFor(() => expect(callsTo(calls, FG_URL)).toHaveLength(2));
    // 取消后该通知状态由服务端给出：前端按返回数据重绘（这里桩成 cancelled）
    expect(await screen.findByText(/OGN-1 · 通知 20 · 已出库 0 · 剩余 20 · 已取消/)).toBeVisible();
  });

  it("取消失败（仓库已建出库单）：展示可读原因，并且不把通知从明细里抹掉", async () => {
    const { calls } = salesApi({ notify: () => apiErr(422, "OUTBOUND_NOTICE_NOT_CANCELLABLE", "仓库已按该通知建出库单：请先在仓库取消（未过账）或冲销（已过账）出库单，再取消通知") });
    renderSales();
    await openOrderSheet();
    const pendingNotice = await screen.findByText(/OGN-1 · 通知 20/);

    await userEvent.click(within(pendingNotice).getByRole("button", { name: "取消通知" }));
    await screen.findByRole("heading", { name: "取消出库通知：OGN-1" });
    await userEvent.type(screen.getByTestId("action-field-reason"), "不想出了");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByText(/仓库已按该通知建出库单/)).toBeVisible();
    expect(screen.queryByText("出库通知已取消")).toBeNull();
    // 明细仍在、且仍是待处理（可再次尝试或去仓库处理）
    expect(screen.getByText(/OGN-1 · 通知 20 · 已出库 0 · 剩余 20 · 待仓库建出库单/)).toBeVisible();
    expect(callsTo(calls, FG_URL)).toHaveLength(1);
  });

  it("销售单没有生产单时：明确说明无法通知出库，且不给出通知入口", async () => {
    salesApi({ summary: () => apiOk({ ...summary, production_orders: [] }) });
    renderSales();
    await openOrderSheet();

    expect(await screen.findByText("该销售单还没有生产单，无法通知出库。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "通知仓库出库（全部可出库批次）" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: "通知仓库出库" })).toHaveLength(0);
  });

  // KNOWN_DEFECT：成品情况接口失败时，页面永久停在「正在加载成品情况…」。
  // 期望：失败要给出错误态（错误文案 + 重试），至少不能一直假装在加载；
  // 实际：loadFinishedGoods/useEffect 的 catch 只 setFinishedGoods(null)，而渲染分支
  //       `!finishedGoods ? "正在加载成品情况…"` 把 null 当成"加载中"，用户看不到任何失败信号。
  // 责任文件：apps/web/app/sales/page.tsx:38-39（catch 吞掉错误）与 :376-379（null 即加载中）。
  it("成品情况接口失败时永久停在「正在加载成品情况…」，没有错误态也没有重试（KNOWN_DEFECT）", async () => {
    const { calls } = salesApi({ summary: () => apiErr(500, "INTERNAL", "成品情况服务暂不可用") });
    renderSales();
    await openOrderSheet();

    expect(screen.getByText("正在加载成品情况…")).toBeVisible();
    await waitFor(() => expect(callsTo(calls, FG_URL)).toHaveLength(1));
    // 让失败响应彻底落地（fetch + json 都是微任务，一个宏任务足够）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByTestId("error-state")).toBeNull();
    expect(screen.queryByText("成品情况服务暂不可用")).toBeNull();
    // 连"通知仓库出库"入口都没渲染出来（既不能看到可出库量，也没法通知）
    expect(screen.queryAllByRole("button", { name: "通知仓库出库" })).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "通知仓库出库（全部可出库批次）" })).toBeNull();
    expect(screen.getByText("正在加载成品情况…")).toBeVisible();
  });
});

/** 取消成功后服务端返回 cancelled；前端按返回数据重绘。 */
const summaryAfterCancel: Summary = {
  ...summary,
  production_orders: [
    (summary.production_orders as Summary[])[0],
    { ...(summary.production_orders as Summary[])[1], pending_notice_quantity: "0", available_quantity: "20", notices: [{ id: "n-1", notice_no: "OGN-1", notice_quantity: "20", shipped_quantity: "0", remaining_quantity: "20", status: "cancelled", notified_at: "2026-01-02T00:00:00.000Z" }] },
  ],
};

/* -------------------------------------------------------------- 仓库成品仓储页桩 */

const pendingNotice = {
  id: "n-1",
  noticeNo: "OGN-1",
  orderNo: ORDER_NO,
  productionOrderId: "po-1",
  productNameSnapshot: "连衣裙",
  productSpecificationSnapshot: "M",
  noticeQuantity: "60",
  shippedQuantity: "0",
  remaining_quantity: "60",
  outbound_summary: "",
  status: "pending",
  notifiedAt: "2026-01-02T00:00:00.000Z",
  unit: { name: "件" },
  salesOrder: { customer: { name: "客户A" } },
};
const createdNotice = { ...pendingNotice, id: "n-2", noticeNo: "OGN-2", status: "outbound_created", noticeQuantity: "30", remaining_quantity: "30", outbound_summary: "OUT-1（draft 30）" };
const cancelledNotice = { ...pendingNotice, id: "n-3", noticeNo: "OGN-3", status: "cancelled" };
const outboundNotices = [pendingNotice, createdNotice, cancelledNotice];
/** 建单成功后：OGN-1 变成已建单待过账，来源出库单 OUT-9（分批出库支持多张出库单）。 */
const outboundNoticesAfterCreate = [
  { ...pendingNotice, status: "outbound_created", remaining_quantity: "0", outbound_summary: "OUT-9（draft 60）" },
  createdNotice,
  cancelledNotice,
];

const draftOutbound = {
  id: "ob-1",
  outboundNo: "OUT-1",
  orderNo: ORDER_NO,
  quantity: "60",
  status: "draft",
  productNameSnapshot: "连衣裙",
  shipmentDate: null,
  carrier: null,
  trackingNo: null,
  packingListNo: null,
  invoiceNo: null,
  unit: { name: "件" },
  salesOrder: { currency: "USD", unitPrice: "10", settlementUnitPrice: null, customer: { name: "客户A" } },
  outboundNotice: null,
};
const postedOutbound = { ...draftOutbound, id: "ob-2", outboundNo: "OUT-2", quantity: "40", status: "posted" };

type WarehouseRoutes = {
  notices?: (callIndex: number) => Response;
  outbounds?: () => Response;
  createOutbound?: () => Response | Promise<Response>;
  failAll?: () => boolean;
};

function warehouseApi(routes: WarehouseRoutes = {}) {
  let noticesCalls = 0;
  const calls = stubApi((url, call) => {
    if (routes.failAll?.()) return apiErr(500, "INTERNAL", "成品仓储情况加载失败");
    if (url.includes("/finished-goods/outbound-notices/") && url.endsWith("/create-outbound")) return routes.createOutbound?.() ?? apiOk({});
    if (url.includes("/finished-goods/outbound-notices")) {
      noticesCalls += 1;
      return routes.notices?.(noticesCalls) ?? apiOk(outboundNotices);
    }
    if (url.includes("/finished-goods/outbounds")) return routes.outbounds?.() ?? apiOk([]);
    if (url.includes("/finished-goods/inbound-notices")) return apiOk([]);
    if (url.includes("/finished-goods/qc-records/")) return apiOk([]);
    if (url.includes("/finished-goods/inbounds")) return apiOk([]);
    if (url.includes("/finished-goods/defectives")) return apiOk([]);
    if (url.includes("/inventory/balances")) return apiOk([]);
    return apiErr(404, "NOT_FOUND", `未打桩的请求：${call.method} ${url}`);
  });
  return { calls, noticesCalls: () => noticesCalls };
}

function renderWarehouse() {
  return render(
    <>
      <FinishedGoodsStoragePage />
      <Toaster />
    </>
  );
}

const noticesHeading = () => screen.findByRole("heading", { name: /成品出库通知（销售发起）/ });
const createOutboundButton = (noticeNo: string) => rowOf(noticeNo).getByRole("button", { name: "生成出库单" });

describe("仓库成品仓储页：出库通知列表 → 出库单（支持分批）", () => {
  it("按状态渲染销售发起的出库通知，还有剩余量的通知都能继续「生成出库单」", async () => {
    const { calls } = warehouseApi();
    renderWarehouse();
    await noticesHeading();

    // 通知来自销售页的发起动作：请求不带 order_no 时看全部
    expect(callsTo(calls, "/api/v1/finished-goods/outbound-notices")).toHaveLength(1);
    expect(calls[0].method).toBe("GET");

    const pending = rowOf("OGN-1");
    expect(pending.getByText("待建出库单")).toBeVisible();
    expect(pending.getByText("60 件")).toBeVisible();
    expect(pending.getByText("0 / 60")).toBeVisible();
    expect(createOutboundButton("OGN-1")).toBeEnabled();

    // 已建单但只出了一部分的，仍可继续出库（分批出库：剩余量 > 0 就有入口）
    const created = rowOf("OGN-2");
    expect(created.getByText("已建单待过账")).toBeVisible();
    expect(created.getByText("OUT-1（draft 30）")).toBeVisible();
    expect(created.getByText("0 / 30")).toBeVisible();
    expect(createOutboundButton("OGN-2")).toBeEnabled();

    const cancelled = rowOf("OGN-3");
    // 状态列与操作列都显示「已取消」，且没有可点的建单入口
    expect(cancelled.getAllByText("已取消")).toHaveLength(2);
    expect(cancelled.queryByRole("button", { name: "生成出库单" })).toBeNull();

    // 分批口径必须在界面上说清楚
    expect(screen.getByText(/支持分批出库（单张数量 ≤ 当前成品可用量）/)).toBeVisible();
    expect(screen.getByText(/销售在销售订单页「通知仓库出库」后出现在这里/)).toBeVisible();
  });

  it("生成出库单前必须输入「确认」：错误输入不建单，并给出可读提示", async () => {
    const { calls } = warehouseApi();
    renderWarehouse();
    await noticesHeading();

    await userEvent.click(createOutboundButton("OGN-1"));

    expect(await screen.findByTestId("action-dialog")).toBeVisible();
    // 对话框必须把"本次出库数量"讲清楚（支持分批出库，默认是通知剩余量）
    expect(screen.getByText(/确认出库数量不超过剩余 60 件/)).toBeVisible();

    await userEvent.type(screen.getByTestId("action-field-confirm"), "好");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByText("请输入“确认”以生成出库单")).toBeVisible();
    expect(callsTo(calls, "/create-outbound")).toHaveLength(0);
  });

  it("输入「确认」后建单：请求体带本次出库数量（支持分批），成功后重新加载通知列表", async () => {
    const { calls } = warehouseApi({ notices: (index) => apiOk(index === 1 ? outboundNotices : outboundNoticesAfterCreate) });
    renderWarehouse();
    await noticesHeading();

    await userEvent.click(createOutboundButton("OGN-1"));
    await screen.findByTestId("action-dialog");
    await userEvent.type(screen.getByTestId("action-field-confirm"), "确认");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/create-outbound")).toHaveLength(1));
    const create = lastTo(calls, "/create-outbound");
    expect(create.method).toBe("POST");
    expect(create.url).toBe("/api/v1/finished-goods/outbound-notices/n-1/create-outbound");
    // 默认出剩余量，且数量进入请求体（分批出库：仓库可以只出一部分）；
    // 同时带上打开弹窗时生成的幂等键，网络重试才会命中同一张出库单。
    expect(bodyOf(create)).toMatchObject({ quantity: "60" });
    expect(String(bodyOf(create).idempotency_key)).toMatch(/^web-notice-outbound-n-1-\d+-[a-z0-9]+$/);

    expect(await screen.findByText("成品出库单已生成（本次 60，待过账）")).toBeVisible();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finished-goods/outbound-notices")).toHaveLength(2));
    // 列表按服务端返回重绘：OGN-1 变成已建单待过账，来源出库单是 OUT-9
    const pending = rowOf("OGN-1");
    expect(pending.getByText("已建单待过账")).toBeVisible();
    expect(pending.getByText("OUT-9（draft 60）")).toBeVisible();
    expect(pending.queryByRole("button", { name: "生成出库单" })).toBeNull();
  });

  it("建单失败（例如已被别人建单）：展示服务端原因，不误报成功", async () => {
    const { calls } = warehouseApi({ createOutbound: () => apiErr(422, "OUTBOUND_NOTICE_ALREADY_CONSUMED", "该出库通知已建出库单，不能重复建单") });
    renderWarehouse();
    await noticesHeading();

    await userEvent.click(createOutboundButton("OGN-1"));
    await screen.findByTestId("action-dialog");
    await userEvent.type(screen.getByTestId("action-field-confirm"), "确认");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByText("该出库通知已建出库单，不能重复建单")).toBeVisible();
    expect(screen.queryByText("成品出库单已生成（整批，待过账）")).toBeNull();
    expect(callsTo(calls, "/create-outbound")).toHaveLength(1);
  });

  // 已修复（2026-09）：仓库页 onSubmit 现在 return 提交 Promise，校验失败用抛错代替 notifyError，
  // 于是 ActionDialog 把原因显示在弹窗内并保留用户已填的值（与销售页、质检模块一致）。
  it("「确认」输入错误时弹窗保留、错误就地显示、不发请求", async () => {
    const { calls } = warehouseApi();
    renderWarehouse();
    await noticesHeading();

    await userEvent.click(createOutboundButton("OGN-1"));
    const dialog = await screen.findByTestId("action-dialog");
    await userEvent.type(screen.getByTestId("action-field-confirm"), "就这样");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请输入“确认”以生成出库单");
    expect(callsTo(calls, "/create-outbound")).toHaveLength(0);
    expect(screen.getByTestId("action-dialog")).toBeVisible();
    // 用户填的数量没有被清掉，改成「确认」即可原样提交
    expect(within(dialog).getByTestId("action-field-quantity")).toHaveValue(60);
  });

  it("订单号筛选：order_no 进入全部成品仓储查询（通知列表不能只筛一半）", async () => {
    const { calls } = warehouseApi();
    renderWarehouse();
    await noticesHeading();
    expect(callsTo(calls, "/api/v1/finished-goods/outbound-notices")).toHaveLength(1);

    await userEvent.type(screen.getByPlaceholderText("可选，留空看全部"), "SO-9");
    await userEvent.click(screen.getByRole("button", { name: "筛选" }));

    await waitFor(() => expect(callsTo(calls, "/api/v1/finished-goods/outbound-notices?order_no=SO-9")).toHaveLength(1));
    const scoped = calls.filter((call) => call.url.includes("order_no=SO-9")).map((call) => call.url);
    expect(scoped).toContain("/api/v1/inventory/balances?category=finished_goods&order_no=SO-9");
    expect(scoped).toContain("/api/v1/inventory/balances?category=defective_goods&order_no=SO-9");
    expect(scoped).toContain("/api/v1/finished-goods/inbounds?order_no=SO-9");
    expect(scoped).toContain("/api/v1/finished-goods/outbounds?order_no=SO-9");
  });

  it("加载失败：显示错误态并可重试（重试成功后渲染出库通知列表）", async () => {
    let failing = true;
    const { calls } = warehouseApi({ failAll: () => failing });
    renderWarehouse();

    expect(await screen.findByTestId("error-state")).toHaveTextContent("成品仓储情况加载失败");
    const before = calls.length;

    failing = false;
    await userEvent.click(screen.getByTestId("error-state-retry"));

    expect(await screen.findByRole("heading", { name: /成品出库通知（销售发起）/ })).toBeVisible();
    expect(calls.length).toBeGreaterThan(before);
    expect(screen.getByText("待建出库单")).toBeVisible();
  });

  it("整批出库单：草稿可过账/取消，过账成功提示「已生成应收来源，等待财务收款」并刷新列表", async () => {
    const { calls } = warehouseApi({ notices: () => apiOk([]), outbounds: () => apiOk([draftOutbound]) });
    renderWarehouse();
    await noticesHeading();

    const row = rowOf("OUT-1");
    // 应收金额按结算币价优先、否则单价 × 数量（过账后财务据此收款）
    expect(row.getByText("600.00 USD")).toBeVisible();
    expect(row.getByRole("button", { name: "过账出库" })).toBeEnabled();
    expect(row.getByRole("button", { name: "取消出库单" })).toBeEnabled();
    // 草稿还没过账：没有发货/签收/冲销入口
    expect(row.queryByRole("button", { name: "维护发货" })).toBeNull();
    expect(row.queryByRole("button", { name: "登记签收" })).toBeNull();
    expect(row.queryByRole("button", { name: "冲销" })).toBeNull();

    await userEvent.click(row.getByRole("button", { name: "过账出库" }));

    await waitFor(() => expect(callsTo(calls, "/finished-goods/outbounds/ob-1/post")).toHaveLength(1));
    const post = lastTo(calls, "/finished-goods/outbounds/ob-1/post");
    expect(post.method).toBe("POST");
    expect(post.body).toBe("{}");
    expect(await screen.findByText("成品出库已过账（已生成应收来源，等待财务收款）")).toBeVisible();
    await waitFor(() => expect(calls.filter((call) => call.url.includes("/finished-goods/outbounds")).length).toBeGreaterThanOrEqual(2));
  });

  it("已过账出库单：维护发货走 PATCH，请求体形状与字段缺省剔除正确", async () => {
    const { calls } = warehouseApi({ notices: () => apiOk([]), outbounds: () => apiOk([postedOutbound]) });
    renderWarehouse();
    await noticesHeading();

    const row = rowOf("OUT-2");
    expect(row.getByRole("button", { name: "维护发货" })).toBeEnabled();
    expect(row.getByRole("button", { name: "登记签收" })).toBeEnabled();
    expect(row.getByRole("button", { name: "冲销" })).toBeEnabled();
    expect(row.queryByRole("button", { name: "过账出库" })).toBeNull();

    await userEvent.click(row.getByRole("button", { name: "维护发货" }));
    expect(await screen.findByRole("heading", { name: "维护发货信息：OUT-2" })).toBeVisible();

    await userEvent.type(screen.getByTestId("action-field-carrier"), "顺丰");
    await userEvent.type(screen.getByTestId("action-field-tracking_no"), "SF123456");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1));
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.url).toBe("/api/v1/finished-goods/outbounds/ob-2/shipping");
    const body = bodyOf(patch);
    expect(body).toMatchObject({ carrier: "顺丰", tracking_no: "SF123456" });
    // 发货日期必填且默认今天；未填写的可选字段必须被剔除（undefined 不进 JSON）
    expect(String(body.shipment_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(body).sort()).toEqual(["carrier", "shipment_date", "tracking_no"]);
    expect(await screen.findByText("发货信息已保存")).toBeVisible();
  });
});
