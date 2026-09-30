// 销售一级页与三个二级页（2026-09-30 用户要求：「成品出库总览，客户池，销售单，都收进二级页面」）。
//
// 为什么要单独一份用例：拆页这件事的风险不在"能不能跳转"，而在**拆完之后每一页是不是只做一件事** ——
// 一级页不该再去拉三个接口（那就白拆了），二级页也不该把别的板块的数据顺带拉回来。
// 所以这里断言的是「点了哪张卡 → 到了哪一页 → 那一页发了哪些请求」。
//
// 同一条链路的行为用例（出库通知、工艺单导出、货号筛选）分别留在
// outbound-notice-pages / sales-production-sheet / sales-item-no 三个文件里，不在这里重复。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import SalesBoardIndex from "../components/sales/sales-board-index";
import FinishedGoodsOverview from "../components/sales/finished-goods-overview";
import CustomerPool from "../components/sales/customer-pool";
import SalesOrdersList from "../components/sales/sales-orders-list";
import CustomersPage from "../app/customers/page";
import { SALES_BOARDS, salesBoardPath } from "../lib/sales-sections";
import { apiOk, callsTo, stubApi } from "./helpers/api-stub";

describe("销售一级页：三张卡片入口", () => {
  it("列出三个板块，各自指向自己的二级页地址", async () => {
    const calls = stubApi(() => apiOk([]));
    render(<SalesBoardIndex />);

    expect(screen.getByTestId("page-sales")).toBeVisible();
    expect(SALES_BOARDS.map((board) => board.title)).toEqual(["成品出库总览", "客户池", "销售单"]);
    for (const board of SALES_BOARDS) {
      const card = screen.getByTestId(`sales-board-${board.key}`);
      expect(card).toHaveTextContent(board.title);
      expect(card.getAttribute("href")).toBe(`/sales/${board.key}`);
    }
    expect(salesBoardPath("orders")).toBe("/sales/orders");

    // 一级页是**纯导航页**：拆页的意义就是它不再替二级页拉数据（拉了就白拆）。
    await waitFor(() => expect(screen.getByTestId("sales-board-grid")).toBeVisible());
    expect(calls).toHaveLength(0);
  });
});

describe("销售二级页：每一页只拉自己那一个接口", () => {
  it("成品出库总览页：只拉总览，不拉客户与销售单", async () => {
    const calls = stubApi((url) => (url.includes("finished-goods-summary") ? apiOk({ production_order_count: 0, groups: [] }) : apiOk([])));
    render(<FinishedGoodsOverview />);

    expect(screen.getByTestId("page-sales-finished-goods")).toBeVisible();
    await waitFor(() => expect(callsTo(calls, "/sales-orders/finished-goods-summary")).toHaveLength(1));
    expect(callsTo(calls, "/customers?page_size=200")).toHaveLength(0);
    expect(callsTo(calls, "/sales-orders?page_size=200")).toHaveLength(0);
  });

  it("客户池页：只拉客户（币种字典是静态配置，不算业务数据）", async () => {
    const calls = stubApi((url) => (url.includes("/customers") ? apiOk([]) : apiOk([])));
    render(<CustomerPool />);

    expect(screen.getByTestId("page-sales-customers")).toBeVisible();
    await waitFor(() => expect(callsTo(calls, "/customers?page_size=200")).toHaveLength(1));
    expect(callsTo(calls, "/sales-orders?page_size=200")).toHaveLength(0);
  });

  it("销售单页：只拉销售单", async () => {
    const calls = stubApi(() => apiOk([]));
    render(<SalesOrdersList />);

    expect(screen.getByTestId("page-sales-orders")).toBeVisible();
    await waitFor(() => expect(callsTo(calls, "/sales-orders?page_size=200")).toHaveLength(1));
    expect(callsTo(calls, "/customers?page_size=200")).toHaveLength(0);
    expect(callsTo(calls, "/sales-orders/finished-goods-summary")).toHaveLength(0);
  });

  it("同一个客户池组件挂在两个路由上：页面根 testid 跟着路由走（/customers 是「客户」栏目自己的入口）", async () => {
    stubApi(() => apiOk([]));
    render(<CustomersPage />);
    expect(screen.getByTestId("page-customers")).toBeVisible();
    // 同一个组件只渲染一个根节点，不会同时出现两个 page-* 钩子
    expect(screen.queryByTestId("page-sales-customers")).toBeNull();
  });
});
