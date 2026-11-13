// 成品存量与入库通知面板（FinishedGoodsPanel）的**关键字搜索**行为测试。
//
// 用户 2026-11-13：「通览整个项目，统计所有下拉列表，所有表单是否都有搜索功能搜索框，如果没有，都需要
// 加上搜索功能。因为现在单子多了，查找比较麻烦。」入库通知是分批发出来的，一张生产单跑几个月就有几十条：
// 这里钉住那颗搜索框的三种行为（收窄 / 无命中提示 / 清除后恢复），以及一条容易改坏的边界：
// **上面的整单汇总数字不能跟着关键词变**（否则「可通知入库 40」会变成某个关键词下的小计，看起来像库存变了）。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiOk, stubApi } from "./helpers/api-stub";
import { FinishedGoodsPanel } from "../components/production/finished-goods-panel";
import { Toaster } from "../components/ui/toaster";

function notice(overrides: Record<string, unknown> = {}) {
  return {
    id: "n-1",
    noticeNo: "FGI-001",
    noticeDate: "2026-09-01T00:00:00.000Z",
    batchNo: "B1",
    status: "pending",
    noticeQuantity: "20",
    submittedQuantity: "0",
    qcQualifiedQuantity: "0",
    qcRejectedQuantity: "0",
    inboundDraftQuantity: "0",
    inboundPostedQuantity: "0",
    availableSubmissionQuantity: "20",
    remainingForInbound: "20",
    operationNameSnapshot: "包装",
    unitNameSnapshot: "件",
    ...overrides,
  };
}

/** 四条通知：状态、批次、日期各不同，够区分「按单号」「按批次」「按状态」「按日期」四种命中。 */
const summary = {
  production_order_id: "po-1",
  production_order_no: "MO-2026-001",
  order_no: "SO-2026-001",
  execution_mode: "in_house",
  status: "in_progress",
  planned_quantity: "100",
  unit_name: "件",
  packaging_operation: { id: "op-pack", name: "包装", sequence_no: 5, target_quantity: "100", status: "active" },
  packaging_reported_quantity: "60",
  notified_quantity: "20",
  available_notice_quantity: "40",
  submitted_quantity: "20",
  qc_qualified_quantity: "18",
  inbound_draft_quantity: "10",
  inbound_posted_quantity: "8",
  finished_goods_stock: "8",
  defective_goods_stock: "2",
  outbound_quantity: "3",
  customer_return_quantity: "1",
  notice_count: 4,
  notices: [
    notice({ id: "n-1", noticeNo: "FGI-001", batchNo: "B1", noticeDate: "2026-09-01T00:00:00.000Z", status: "pending" }),
    notice({ id: "n-2", noticeNo: "FGI-002", batchNo: null, noticeDate: "2026-09-11T00:00:00.000Z", status: "partially_inbound", submittedQuantity: "20" }),
    notice({ id: "n-3", noticeNo: "FGI-003", batchNo: "B3", noticeDate: "2026-10-02T00:00:00.000Z", status: "completed", submittedQuantity: "20" }),
    notice({ id: "n-4", noticeNo: "FGI-004", batchNo: "B4", noticeDate: "2026-10-09T00:00:00.000Z", status: "cancelled" }),
  ],
};

function renderPanel() {
  stubApi((url) => (url.endsWith("/production/orders/po-1/finished-goods-summary") ? apiOk(summary) : apiOk({})));
  return render(
    <>
      <Toaster />
      <FinishedGoodsPanel productionOrderId="po-1" executionMode="in_house" orderStatus="in_progress" />
    </>
  );
}

const noticeRows = () => screen.queryAllByTestId("data-table-row");
const searchBox = () => screen.getByTestId("finished-goods-panel-search");

describe("FinishedGoodsPanel：入库通知表的关键字搜索", () => {
  it("没有关键词时列出全部通知，且不显示「筛选后」计数", async () => {
    renderPanel();

    expect(await screen.findByText("FGI-001")).toBeVisible();
    expect(noticeRows()).toHaveLength(4);
    expect(screen.queryByTestId("finished-goods-panel-count")).toBeNull();
    expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
  });

  it("按通知单号收窄，并给出「筛选后 N / M 条」", async () => {
    renderPanel();
    await screen.findByText("FGI-001");

    await userEvent.type(searchBox(), "FGI-003");

    await waitFor(() => expect(noticeRows()).toHaveLength(1));
    expect(noticeRows()[0]).toHaveTextContent("FGI-003");
    expect(screen.getByTestId("finished-goods-panel-count")).toHaveTextContent("筛选后 1 / 4 条");
  });

  it("批次、日期与中文状态也参与匹配（搜「B3」「2026-10-09」「已取消」各命中一行）", async () => {
    renderPanel();
    await screen.findByText("FGI-001");

    await userEvent.type(searchBox(), "B3");
    await waitFor(() => expect(noticeRows()).toHaveLength(1));
    expect(noticeRows()[0]).toHaveTextContent("FGI-003");

    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), "2026-10-09");
    await waitFor(() => expect(noticeRows()).toHaveLength(1));
    expect(noticeRows()[0]).toHaveTextContent("FGI-004");

    // 状态列显示的是中文（待送检 / 入库中 / 已完成 / 已取消），按中文搜必须能命中
    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), "已取消");
    await waitFor(() => expect(noticeRows()).toHaveLength(1));
    expect(noticeRows()[0]).toHaveTextContent("FGI-004");
  });

  it("没命中时给出「没有匹配」空态与总数，而不是空表格", async () => {
    renderPanel();
    await screen.findByText("FGI-001");

    await userEvent.type(searchBox(), "FGI-999");

    expect(await screen.findByTestId("empty-state")).toHaveTextContent("没有匹配“FGI-999”的入库通知");
    expect(screen.getByTestId("empty-state")).toHaveTextContent("本生产单共 4 条通知");
    expect(noticeRows()).toHaveLength(0);
  });

  it("「清除搜索」恢复全部通知与原本的空态文案", async () => {
    renderPanel();
    await screen.findByText("FGI-001");
    await userEvent.type(searchBox(), "B3");
    await waitFor(() => expect(noticeRows()).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));

    await waitFor(() => expect(noticeRows()).toHaveLength(4));
    expect(searchBox()).toHaveValue("");
    expect(screen.queryByTestId("finished-goods-panel-count")).toBeNull();
  });

  it("关键字只过滤表格：上方整单汇总（可通知入库 40 / 成品存量 8）不随关键词变化", async () => {
    renderPanel();
    await screen.findByText("FGI-001");
    const before = screen.getByText("可通知入库").closest("span");
    if (!before) throw new Error("未找到「可通知入库」汇总项");

    await userEvent.type(searchBox(), "已取消");
    await waitFor(() => expect(noticeRows()).toHaveLength(1));

    // 汇总项仍然报整单的数字：跟着筛选变会让人以为库存真的变成 1 条的 20 了
    expect(screen.getByText("可通知入库").closest("span")).toBe(before);
    expect(within(before).getByText("40")).toBeVisible();
    expect(within(before).queryByText("20")).toBeNull();
  });
});
