// 采购单列表的 `?order_no=` 深链（T13）。
//
// 这是修一个**既有缺陷**：工作台（与【返单与总结】）给出的 `/procurement?order_no=…` 链接
// 之前根本没人读，落点是一个没筛选的页面 —— 也就是说"点过去看这批的单"一直是半个功能。
// 本文件钉住：带参数进来即筛选、手工清空能看回全部（预置值是起点，不是锁）。
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PurchaseOrdersPage from "../app/procurement/orders/page";
import { apiOk, stubApi } from "./helpers/api-stub";

const route = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => route.searchParams,
  usePathname: () => "/procurement/orders",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

const purchaseOrder = (overrides: Record<string, unknown>) => ({
  id: `po-${overrides.purchaseOrderNo}`, purchaseOrderNo: "PO-1", orderNo: "DL260001-1", status: "ordered",
  supplier: { name: "某某五金厂" }, items: [], createdAt: "2026-09-10T01:20:00Z", updatedAt: "2026-09-10T02:40:00Z",
  createdBy: "u-1", updatedBy: "u-1", ...overrides,
});

function stub() {
  return stubApi((url) => {
    if (url.includes("/purchase-orders/bom-item-status")) return apiOk({});
    if (url.includes("/purchase-orders")) return apiOk([purchaseOrder({ purchaseOrderNo: "PO-1", orderNo: "DL260001-1" }), purchaseOrder({ purchaseOrderNo: "PO-2", orderNo: "DL260002-1" })]);
    return apiOk([]);
  });
}

describe("采购单列表：?order_no= 深链", () => {
  it("带 order_no 进来时首屏就筛到那一单（不再落在一个没筛选的列表上）", async () => {
    route.searchParams = new URLSearchParams({ order_no: "DL260001-1" });
    stub();
    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-1");
    expect(screen.queryByText("PO-2")).toBeNull();
  });

  it("预置值是起点不是锁：手工清空搜索框能看回全部", async () => {
    route.searchParams = new URLSearchParams({ order_no: "DL260001-1" });
    stub();
    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-1");
    await userEvent.clear(screen.getByPlaceholderText("采购单号 / 订单号 / 状态"));
    await waitFor(() => expect(screen.getByText("PO-2")).toBeTruthy());
    expect(screen.getByText("PO-1")).toBeTruthy();
  });

  it("不带参数时不受影响（老书签与日常进入路径）", async () => {
    route.searchParams = new URLSearchParams();
    stub();
    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-1");
    expect(screen.getByText("PO-2")).toBeTruthy();
  });
});
