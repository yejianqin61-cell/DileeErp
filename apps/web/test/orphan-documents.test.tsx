// 销售单删除与「孤立单据」（2026-11-03）的前端**行为**测试。
//
// 用户口径：「销售单能够删除；删除后，相对应的采购单及其后续绑定的单据**不删**，而是显示为孤立单据。」
// 这里钉住四件事（都是回归时真的会打红的事实）：
//   1. 删除先问 `GET /sales-orders/:id/delete-preview`，确认框按类型列出会留下的下游单据与张数；
//   2. 非草稿不填原因不发 DELETE；填了则 body 带 `{ reason }`（草稿不填原因另见 sales-item-no.test.tsx）；
//   3. 下游列表/详情的「孤立」徽章只认后端 `orphaned` 字段（同一份数据里 orphaned=false 的行不能出现徽章）；
//   4. 孤立单据汇总页按**被删销售单**分组渲染（分组键是 sales_order_id 而不是单号），空态是「没有孤立单据」。
//
// 纪律：真实渲染组件 + 真实点击 + 真实 fetch 桩（helpers/api-stub），不 mock 业务模块。
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SalesOrdersList from "../components/sales/sales-orders-list";
import PurchaseOrdersPage from "../app/procurement/orders/page";
import PurchaseOrderDetailPage from "../app/procurement/orders/[id]/page";
import ProductionPage from "../app/production/page";
import SalesOrphansPage from "../app/sales/orphans/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi } from "./helpers/api-stub";

// 这些页面在 App Router 之外没有路由上下文：不 mock 的话 useSearchParams / useParams 直接抛错。
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useParams: () => ({ id: "po-1" }),
}));

// ---------------------------------------------------------------- 删除确认框（销售单列表）

const confirmedOrder = {
  id: "order-1", orderNo: "DL260170", itemNo: "27621", productName: "三折伞", quantity: "1960", unit: "支",
  status: "confirmed", customer: { id: "customer-1", name: "家百纳" }, boms: [],
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};

/** 契约 §3.1：已确认单 + 2 张采购单 + 1 张生产单。 */
const deletePreview = {
  sales_order_id: "order-1", order_no: "DL260170", status: "confirmed", reason_required: true,
  downstream: [{ key: "purchase_order", label: "采购单", count: 2 }, { key: "production_order", label: "生产单", count: 1 }],
  downstream_total: 3,
};

function openSalesOrders(preview: unknown = deletePreview) {
  const calls = stubApi((url, call) => {
    // 传 Response 时是「预览接口失败」的用例：直接回那份失败信封，不要再套 apiOk。
    if (url.includes("/delete-preview")) return preview instanceof Response ? preview : apiOk(preview);
    if (url.includes("/sales-orders?")) return apiOk([confirmedOrder]);
    if (call.method === "DELETE") return apiOk({ id: "order-1" });
    return apiOk([]);
  });
  render(<><SalesOrdersList /><Toaster /></>);
  return calls;
}

describe("删除销售单：先预览影响面，非草稿必须填原因", () => {
  it("确认框列出会留下的下游单据与张数（类型 + 张数，不只一句「有下游」）", async () => {
    const calls = openSalesOrders();
    await screen.findByTestId("page-sales-orders");
    await userEvent.click(await screen.findByTestId("order-delete-DL260170"));

    const dialog = within(await screen.findByTestId("action-dialog"));
    // 分组头 + 两类单据各一行：读的人要能一眼数清「2 张采购单 + 1 张生产单」。
    expect(dialog.getByText("删除后会留下 3 张下游单据：")).toBeVisible();
    expect(dialog.getByText("采购单：2 张")).toBeVisible();
    expect(dialog.getByText("生产单：1 张")).toBeVisible();
    // 已确认（非草稿）：原因输入框在，且标了必填。
    expect(dialog.getByTestId("action-field-reason")).toBeVisible();
    // 只是预览：确认之前没有任何 DELETE。
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("不填原因点「确认删除」：留在弹窗里提示必填，不发 DELETE", async () => {
    const calls = openSalesOrders();
    await screen.findByTestId("page-sales-orders");
    await userEvent.click(await screen.findByTestId("order-delete-DL260170"));
    await screen.findByTestId("action-dialog");

    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写删除原因");
    expect(screen.getByTestId("action-dialog")).toBeVisible();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("填了原因才发 DELETE，body 带 reason；成功后 toast 说明留下了几张孤立单据", async () => {
    const calls = openSalesOrders();
    await screen.findByTestId("page-sales-orders");
    await userEvent.click(await screen.findByTestId("order-delete-DL260170"));
    await screen.findByTestId("action-dialog");

    await userEvent.type(within(screen.getByTestId("action-dialog")).getByTestId("action-field-reason"), "客户取消订单");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
    const deleted = calls.find((call) => call.method === "DELETE");
    expect(deleted?.url.endsWith("/sales-orders/order-1")).toBe(true);
    expect(JSON.parse(String(deleted?.body))).toEqual({ reason: "客户取消订单" });
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已删除销售单 DL260170"))).toBe(true));
    expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("留下 3 张孤立单据"))).toBe(true);
  });

  it("预览接口失败时把原因 toast 出来，不弹确认框、不发 DELETE", async () => {
    const calls = openSalesOrders(apiErr(404, "SALES_ORDER_NOT_FOUND", "销售单已删除或不存在，请刷新后重试"));
    await screen.findByTestId("page-sales-orders");
    await userEvent.click(await screen.findByTestId("order-delete-DL260170"));

    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已删除或不存在"))).toBe(true));
    expect(screen.queryByTestId("action-dialog")).toBeNull();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });
});

// ---------------------------------------------------------------- 下游列表 / 详情的「孤立」徽章

/** 两张采购单：一张父销售单已删（orphaned），一张正常 —— 徽章只能出现在前者。 */
const purchaseOrders = [
  { id: "po-1", purchaseOrderNo: "CG20261001", orderNo: "DL260170", status: "ordered", currency: "CNY", totalAmount: "1200.0000", orphaned: true, extensionData: {}, supplier: { name: "某某五金厂" }, items: [] },
  { id: "po-2", purchaseOrderNo: "CG20261002", orderNo: "DL260171", status: "ordered", currency: "CNY", totalAmount: "800.0000", orphaned: false, extensionData: {}, supplier: { name: "某某五金厂" }, items: [] },
];

describe("孤立徽章：采购单列表只标 orphaned 的行", () => {
  it("父销售单已删的采购单在订单号旁显示「孤立」，同表正常行没有", async () => {
    stubApi((url) => (url.endsWith("/purchase-orders") ? apiOk(purchaseOrders) : apiOk([])));
    render(<PurchaseOrdersPage />);
    await screen.findByTestId("page-procurement-orders");

    await waitFor(() => expect(screen.getByText("CG20261001")).toBeVisible());
    const orphanRow = screen.getByText("CG20261001").closest("tr")!;
    expect(within(orphanRow).getByTestId("orphan-badge")).toHaveTextContent("孤立");
    // 另一张单（orphaned=false）不能被误标 —— 判定只认后端字段，不按单号推断。
    expect(within(screen.getByText("CG20261002").closest("tr")!).queryByTestId("orphan-badge")).toBeNull();
  });
});

describe("孤立徽章：采购单详情顶部提示", () => {
  it("orphaned 的采购单详情在顶部说明「销售单已被删除、单据保留」，订单号旁有徽章", async () => {
    stubApi((url) => (url.endsWith("/purchase-orders/po-1") ? apiOk({ ...purchaseOrders[0], items: [] }) : apiOk([])));
    render(<PurchaseOrderDetailPage />);

    await screen.findByTestId("page-procurement-orders-detail");
    const hint = await screen.findByTestId("purchase-order-orphan-hint");
    expect(hint).toHaveTextContent("已被删除");
    expect(hint).toHaveTextContent("原样保留为「孤立单据」");
    expect(screen.getByTestId("orphan-badge")).toHaveTextContent("孤立");
  });
});

describe("孤立徽章：生产单表", () => {
  it("父销售单已删的生产单在订单号旁显示「孤立」", async () => {
    stubApi((url) => {
      if (url.includes("/production/orders")) return apiOk([
        { id: "mo-1", productionOrderNo: "MO-2026-001", orderNo: "DL260170", executionMode: "in_house", status: "in_progress", plannedQuantity: "100", orphaned: true, executionLocation: { id: "loc-1", name: "一号车间", locationType: "workshop", isActive: true }, operations: [], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
        { id: "mo-2", productionOrderNo: "MO-2026-002", orderNo: "DL260171", executionMode: "in_house", status: "draft", plannedQuantity: "50", orphaned: false, executionLocation: { id: "loc-1", name: "一号车间", locationType: "workshop", isActive: true }, operations: [], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
      ]);
      return apiOk([]);
    });
    render(<ProductionPage />);

    await screen.findByTestId("production-order-table");
    await waitFor(() => expect(screen.getByText("MO-2026-001")).toBeVisible());
    expect(within(screen.getByText("MO-2026-001").closest("tr")!).getByTestId("orphan-badge")).toHaveTextContent("孤立");
    expect(within(screen.getByText("MO-2026-002").closest("tr")!).queryByTestId("orphan-badge")).toBeNull();
  });
});

// ---------------------------------------------------------------- 孤立单据汇总页

const orphanDocument = (overrides: Record<string, unknown>) => ({
  id: "doc-1", type: "purchase_order", label: "采购单", document_no: "CG20261001", order_no: "DL260170",
  status: "ordered", amount: "1200.0000", currency: "CNY", occurred_at: "2026-10-02T00:00:00.000Z",
  sales_order_id: "so-1", ...overrides,
});
const orphanGroup = (overrides: Record<string, unknown>) => ({
  sales_order_id: "so-1", order_no: "DL260170", status: "confirmed", deleted_at: "2026-11-03T10:00:00.000Z",
  deleted_by_name: "张三", documents: [{ key: "purchase_order", label: "采购单", count: 2 }], document_total: 2, ...overrides,
});
/** 契约 §3.3 的完整信封。 */
const orphansPayload = (overrides: Record<string, unknown> = {}) => ({
  orders: [orphanGroup({})],
  documents: [
    orphanDocument({}),
    orphanDocument({ id: "doc-2", document_no: "CG20261002", amount: "800.0000" }),
  ],
  by_type: [{ key: "purchase_order", label: "采购单", count: 2 }],
  totals: { orders: 1, documents: 2 },
  truncated: false,
  ...overrides,
});

function renderOrphans(payload: unknown) {
  const calls = stubApi((url) => (url.endsWith("/sales-orders/orphans") ? apiOk(payload) : apiOk([])));
  render(<SalesOrphansPage />);
  return calls;
}

describe("孤立单据汇总页", () => {
  it("按被删销售单分组：组头有销售单号与删除时间，组内列出单据明细（单号/状态/金额）", async () => {
    renderOrphans(orphansPayload());

    expect(await screen.findByTestId("page-sales-orphans")).toBeVisible();
    await waitFor(() => expect(screen.getByTestId("orphans-totals")).toHaveTextContent("被删销售单 1 张"));
    expect(screen.getByTestId("orphans-totals")).toHaveTextContent("遗留孤立单据 2 张");
    expect(screen.getByTestId("orphan-group-so-1")).toHaveTextContent("DL260170");
    expect(screen.getByTestId("orphan-group-so-1")).toHaveTextContent("2026-11-03 18:00");
    expect(screen.getByTestId("orphan-group-so-1")).toHaveTextContent("张三");
    // 单据明细：单号 + 状态（中文）+ 金额与币种。
    expect(screen.getByText("CG20261001")).toBeVisible();
    expect(screen.getByText("CG20261002")).toBeVisible();
    expect(screen.getAllByText("已下单")).toHaveLength(2);
    expect(screen.getByText("1200.0000 CNY")).toBeVisible();
  });

  it("按 sales_order_id 分组而不是按单号：同号的两张被删销售单各自列出自己的单据", async () => {
    renderOrphans(orphansPayload({
      orders: [
        orphanGroup({ sales_order_id: "so-1", order_no: "DL260170" }),
        orphanGroup({ sales_order_id: "so-2", order_no: "DL260170", deleted_by_name: null }),
      ],
      documents: [
        orphanDocument({ id: "doc-old", order_no: "DL260170", sales_order_id: "so-1", document_no: "CG-OLD" }),
        orphanDocument({ id: "doc-new", order_no: "DL260170", sales_order_id: "so-2", document_no: "CG-NEW" }),
      ],
      totals: { orders: 2, documents: 2 },
    }));

    await screen.findByTestId("page-sales-orphans");
    const groups = await screen.findAllByTestId(/^orphan-group-/);
    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getByText("CG-OLD")).toBeVisible();
    expect(within(groups[0]).queryByText("CG-NEW")).toBeNull();
    expect(within(groups[1]).getByText("CG-NEW")).toBeVisible();
  });

  it("空态提示「没有孤立单据」", async () => {
    renderOrphans({ orders: [], documents: [], by_type: [], totals: { orders: 0, documents: 0 }, truncated: false });
    await screen.findByTestId("page-sales-orphans");
    expect(await screen.findByTestId("empty-state")).toHaveTextContent("没有孤立单据");
  });

  it("明细被 1000 行上限截断时明说，而不是让人以为少了几张单", async () => {
    renderOrphans(orphansPayload({ documents: [], totals: { orders: 1, documents: 2 }, truncated: true }));
    await screen.findByTestId("page-sales-orphans");
    expect(await screen.findByTestId("orphans-truncated")).toHaveTextContent("最多显示 1000 行");
    // 组内明细一行都没返回，但统计说这张单留下 2 张 —— 必须说清是「未包含」，不能说「没有单据」。
    expect(screen.getByTestId("orphan-group-so-1")).toHaveTextContent("未包含在本次返回里");
    expect(screen.getByTestId("orphan-group-so-1")).not.toHaveTextContent("没有留下下游单据");
  });
});
