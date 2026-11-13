// 生产单详情页「工序与进度」面板的关键字搜索行为测试（用户 2026-11-13：
// 「通览整个项目，统计所有下拉列表，所有表单是否都有搜索功能搜索框，如果没有，都需要加上搜索功能。
//   因为现在单子多了，查找比较麻烦。」）。
//
// 这一块有**两张表**（工序明细 DataTable + 完成率计量表），而且是「按单号找人」平时最少用、
// 「按工序名找人」最常用的那种页面：一个生产单十几道工序时，找「包装走到哪一步」只能滚。
// 因此把下面三条钉成契约：
//   1) 一个关键词同时收窄两张表（只筛一张会出现「上面剩 1 行、下面还是 8 行」，看不出哪行是真的）；
//   2) 两张表各自给「筛选后 N / M」，没命中时给明确文案而不是空白；
//   3) 清除后恢复全部行，计数与清除按钮一起消失。
//
// 纪律与同目录 use 例一致：只断言渲染结果与用户可见文本；三个重量级子面板用最薄替身隔离
// （它们是各自独立的被测单元，本文件只验证「工序与进度」那块）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiOk, stubApi } from "./helpers/api-stub";
import { ProductionOrderDetailPage } from "../components/production/production-order-detail-page";
import { Toaster } from "../components/ui/toaster";

vi.mock("../components/production/daily-reports-panel", () => ({
  DailyReportsPanel: () => <div data-testid="stub-daily-reports-panel" />,
}));
vi.mock("../components/production/finished-goods-panel", () => ({
  FinishedGoodsPanel: () => <div data-testid="stub-finished-goods-panel" />,
}));
vi.mock("../components/production/outsource-logistics-panel", () => ({
  OutsourceLogisticsPanel: () => <div data-testid="stub-outsource-logistics-panel" />,
}));

const operations = [
  { id: "opr-1", operationNameSnapshot: "裁剪", sequenceNo: 1, targetQuantity: "120", status: "active", unit: { name: "件" } },
  { id: "opr-2", operationNameSnapshot: "缝制", sequenceNo: 2, targetQuantity: "110", status: "active", unit: { name: "件" } },
  { id: "opr-3", operationNameSnapshot: "包装", sequenceNo: 3, targetQuantity: "100", status: "active", unit: { name: "件" } },
];

const order = {
  id: "po-1",
  productionOrderNo: "MO-2026-001",
  orderNo: "SO-2026-009",
  bomId: "bom-1",
  executionMode: "in_house",
  status: "in_progress",
  plannedQuantity: "120",
  unit: { name: "件" },
  executionLocation: { name: "一号车间" },
  operations,
};

/** 计量行与工序一一对应（计划 / 实际 / 差额 / 完成率），与后端 production-progress 的返回同形。 */
const measurements = [
  { operation_id: "opr-1", operation_name: "裁剪", source_type: "operation_report", planned_quantity: "120", actual_quantity: "100", difference_quantity: "-20", completion_rate: "0.8333333333333334" },
  { operation_id: "opr-2", operation_name: "缝制", source_type: "operation_report", planned_quantity: "110", actual_quantity: "115", difference_quantity: "5", completion_rate: "1.0454545454545454" },
  { operation_id: "opr-3", operation_name: "包装", source_type: "operation_report", planned_quantity: "100", actual_quantity: "40", difference_quantity: "-60", completion_rate: "0.4" },
];

function renderPage() {
  stubApi((url) => {
    if (url.includes("/production-progress/measurements")) return apiOk(measurements);
    if (url.includes("/production-progress/order-statuses")) return apiOk([]);
    if (url.endsWith("/production/operations")) return apiOk([]);
    if (url.endsWith("/units")) return apiOk([{ id: "unit-1", name: "件", isActive: true }]);
    if (url.includes("/production/material-movements?")) return apiOk([]);
    if (url.includes("/boms/")) return apiOk({ items: [] });
    if (url.endsWith("/materials")) return apiOk([]);
    if (url.endsWith("/production/orders/po-1")) return apiOk(order);
    return apiOk([]);
  });
  return render(
    <>
      <ProductionOrderDetailPage orderId="po-1" />
      <Toaster />
    </>
  );
}

const panel = () => screen.getByTestId("order-operations-panel");
const operationRows = () => within(panel()).queryAllByTestId("data-table-row");
const searchBox = () => screen.getByTestId("production-order-detail-search");
const countNote = () => screen.getByTestId("production-order-detail-count");

/** 面板里最后一张表就是完成率计量表（工序表在前）；表不存在时返回 null。 */
function measurementRows() {
  const tables = within(panel()).queryAllByRole("table");
  if (!tables.length) return null;
  return within(tables[tables.length - 1]).queryAllByRole("row").slice(1);
}

beforeEach(() => {
  // 折叠状态存在 localStorage（dilee:panel:production-order-operations），不清理会串用例。
  window.localStorage.clear();
});

describe("生产单详情页：工序与进度的关键字搜索", () => {
  it("没有关键词时两张表都列全，且不显示计数与清除按钮", async () => {
    renderPage();
    await screen.findByTestId("order-overview");

    expect(operationRows()).toHaveLength(3);
    expect(measurementRows()).toHaveLength(3);
    expect(screen.queryByTestId("production-order-detail-count")).toBeNull();
    expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
  });

  it("一个关键词同时收窄工序表与计量表，两边各自给「筛选后 N / M」", async () => {
    renderPage();
    await screen.findByTestId("order-overview");

    await userEvent.type(searchBox(), "包装");

    await waitFor(() => expect(operationRows()).toHaveLength(1));
    expect(operationRows()[0]).toHaveTextContent("包装");
    expect(measurementRows()).toHaveLength(1);
    expect(measurementRows()?.[0]).toHaveTextContent("包装");
    expect(countNote()).toHaveTextContent("工序：筛选后 1 / 3 道");
    expect(countNote()).toHaveTextContent("计量行：筛选后 1 / 3 行");
  });

  it("空格分词按 AND 收窄：「裁剪 120」命中一道工序，而「裁剪 包装」什么都命中不到", async () => {
    renderPage();
    await screen.findByTestId("order-overview");

    await userEvent.type(searchBox(), "裁剪 120");
    await waitFor(() => expect(operationRows()).toHaveLength(1));
    expect(operationRows()[0]).toHaveTextContent("裁剪");

    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), "裁剪 包装");
    expect(await screen.findByText(/没有匹配“裁剪 包装”的工序/)).toBeVisible();
  });

  it("没命中工序时给「没有匹配」空态与总工序数；计量表整块消失时单独说明", async () => {
    renderPage();
    await screen.findByTestId("order-overview");

    await userEvent.type(searchBox(), "不存在的工序");

    // 空态限定在「工序与进度」这块面板里：领料面板（单据为空）也有自己的 empty-state，
    // 全局找会撞在一起（两个 data-testid="empty-state"）。
    const empty = await within(panel()).findByTestId("empty-state");
    expect(empty).toHaveTextContent("没有匹配“不存在的工序”的工序");
    expect(empty).toHaveTextContent("本生产单共 3 道工序");
    expect(operationRows()).toHaveLength(0);
    // 计量表跟着一起被筛空：不能只是消失，要说清楚「是本单没有数据」还是「被关键词筛掉了」
    expect(screen.getByTestId("production-order-detail-measurements-empty")).toHaveTextContent("没有匹配“不存在的工序”的计量行");
    expect(countNote()).toHaveTextContent("工序：筛选后 0 / 3 道");
    expect(countNote()).toHaveTextContent("计量行：筛选后 0 / 3 行");
  });

  it("「清除搜索」恢复两张表与计数", async () => {
    renderPage();
    await screen.findByTestId("order-overview");
    await userEvent.type(searchBox(), "包装");
    await waitFor(() => expect(operationRows()).toHaveLength(1));

    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));

    await waitFor(() => expect(operationRows()).toHaveLength(3));
    expect(measurementRows()).toHaveLength(3);
    expect(searchBox()).toHaveValue("");
    expect(screen.queryByTestId("production-order-detail-count")).toBeNull();
    expect(screen.queryByTestId("production-order-detail-measurements-empty")).toBeNull();
  });

  it("过滤只改显示：「编辑」按钮仍绑在这一行的工序上（过滤后点编辑，改的是搜出来的那道）", async () => {
    renderPage();
    await screen.findByTestId("order-overview");
    await userEvent.type(searchBox(), "包装");
    await waitFor(() => expect(operationRows()).toHaveLength(1));

    await userEvent.click(within(operationRows()[0]).getByRole("button", { name: "编辑" }));

    // 弹窗标题带工序名：如果过滤把行序搞错，这里会变成「编辑工序：裁剪」
    expect(await screen.findByText("编辑工序：包装")).toBeVisible();
    expect(screen.getByTestId("action-field-target_quantity")).toHaveValue(100);
  });
});
