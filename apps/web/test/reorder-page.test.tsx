// 返单与总结页面（T11）的行为测试。
//
// 老板要求：「可以调取该货号。查看当时该批货号的采购，生产，QC 的所有表单，信息」，
// 加上建议「可以直接左边的栏加一个 tab 叫做返单与总结」。
// 设计：docs/design/reorder-item-no-and-summary-2026-09-26.md §四.2
//
// 钉住四件事：
//   1. 三个状态走 URL（可分享/可回退）：/reorder → ?item_no= → &order_no=；
//   2. 分行展示（数量按单位、金额按币种）与 null 合格率显示 -（没有事实 ≠ 全部不合格）；
//   3. 「能不能返单」只读服务端的判定（前端自己拼条件会出现"按钮亮着、点了 422"）；
//   4. 失败时**不把上一批的数据留在屏幕上**。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ReorderPage from "../app/reorder/page";
import { SessionContext } from "../lib/session-context";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 两个范围的栏目集合（与后端 surfaceSectionsOf 算出来的一样）：用来验证金额按表面权限过滤。 */
const FULL_SECTIONS = ["dashboard", "production", "procurement", "qc", "warehouse", "sales", "reorder", "customers", "reports", "finance", "hr", "account"];
const GENERAL_SECTIONS = ["dashboard", "production", "procurement", "qc", "warehouse", "sales", "reorder", "customers", "reports", "account"];

/** 带上会话档案渲染：毛利那块靠 `surface_sections` 决定显不显示。 */
function session(node: React.ReactElement, sections: string[]) {
  return (
    <SessionContext.Provider value={{ id: "u-1", username: "boss", display_name: "老板", surface_sections: sections, surface_roles: [], role_keys: [], module_keys: [], surface_scope: "full" } as never}>
      {node}
    </SessionContext.Provider>
  );
}

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), searchParams: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: router.push, replace: router.replace, refresh: router.refresh, back: router.back }),
  useSearchParams: () => router.searchParams,
}));

const article = (overrides: Record<string, unknown> = {}) => ({
  item_no: "27621 流水花扇", item_no_key: "27621流水花扇", order_count: 3, order_nos: ["DL260001-1", "DL260140-1", "DL260233-1"],
  customer_names: ["FLOWER1"], first_order_date: "2026-05-01T00:00:00.000Z", last_order_date: "2026-09-20T00:00:00.000Z",
  last_delivery_date: "2026-10-15T00:00:00.000Z", open_order_count: 1,
  quantities: [{ unit: "支", quantity: "5880" }],
  purchase_amounts: [{ currency: "CNY", amount: "37036.8" }],
  receivable_amounts: [{ currency: "USD", amount: "7056" }],
  qc: { inspected: "5880", qualified: "5790", conditional: "0", rejected: "90", qualified_rate: "0.9847" },
  ...overrides,
});

const batch = (overrides: Record<string, unknown> = {}) => ({
  sales_order_id: "so-1", order_no: "DL260001-1", order_date: "2026-05-01T00:00:00.000Z", delivery_date: "2026-06-30T00:00:00.000Z",
  status: "closed", quantity: "1960", unit: "支", customer: { id: "c-1", name: "FLOWER1" }, current_version: 2, bom_versions: [1, 2],
  purchase_order_count: 2, production_order_count: 1, qc_qualified_quantity: "1930", qc_rejected_quantity: "30",
  finished_inbound_quantity: "1930", outbound_quantity: "1930", reorder_from_order_no: null,
  can_reorder: true, can_reorder_reason: null, workbench_href: "/?order_no=DL260001-1",
  ...overrides,
});

const detail = (overrides: Record<string, unknown> = {}) => ({
  ...article(),
  customers: [{ customer_id: "c-1", name: "FLOWER1", order_count: 3 }],
  orders: [
    batch({ delivery: { promised_date: "2026-06-30T00:00:00.000Z", actual_date: "2026-06-25T00:00:00.000Z", verdict: "early", verdict_label: "提前", days_delta: -5 } }),
    batch({ sales_order_id: "so-2", order_no: "DL260140-1", order_date: "2026-07-01T00:00:00.000Z", status: "draft", can_reorder: false, can_reorder_reason: "草稿单不能作为返单来源", delivery: { promised_date: null, actual_date: null, verdict: "no_promise", verdict_label: "无交期", days_delta: null } }),
  ],
  delivery_summary: { early: 1, on_time: 0, late: 0, not_shipped: 0, no_promise: 1 },
  quality_trend: [],
  gross_margin: null,
  ...overrides,
});

const documentGroups = () => ([
  { document_type: "purchase_order", label: "采购单", documents: [{ document_no: "PO-1", date: "2026-05-03T00:00:00.000Z", date_source: "business", quantity: null, unit: null, status: "ordered", status_label: "已下单", source_id: "po-1", extra: {} }] },
  { document_type: "raw_material_inbound", label: "原料入库", documents: [{ document_no: "IN-1", date: "2026-05-22T03:00:00.000Z", date_source: "created_at", quantity: "1200", unit: "根", status: "posted", status_label: "已过账", source_id: "in-1", extra: {} }] },
  { document_type: "finished_qc", label: "成品 QC", documents: [] },
  { document_type: "incoming_inspection", label: "来料质检", documents: [{ document_no: "RC-1 质检", date: "2026-05-21T00:00:00.000Z", date_source: "created_at", quantity: "1200", unit: null, status: "accepted", status_label: "全部入库", source_id: "ins-1", extra: { receipt_id: "rc-1" } }] },
]);

function stub(handlers: Record<string, () => Response> = {}): StubbedCall[] {
  return stubApi((url) => {
    for (const [fragment, handler] of Object.entries(handlers)) if (url.includes(fragment)) return handler();
    if (url.includes("/documents")) return apiOk({ order_no: "DL260001-1", item_no: "27621 流水花扇", groups: documentGroups() });
    if (url.includes("/reorder/articles/")) return apiOk(detail());
    if (url.includes("/reorder/articles")) return apiOk([article()], { total: 1 });
    return apiOk([]);
  });
}

beforeEach(() => { router.push.mockClear(); router.searchParams = new URLSearchParams(); });

describe("返单与总结：货号清单", () => {
  it("首屏拉货号清单并渲染（含条数文案）", async () => {
    const calls = stub();
    render(<ReorderPage />);
    await screen.findByTestId("reorder-article-table");
    expect(screen.getByTestId("reorder-count")).toHaveTextContent("共 1 个货号");
    expect(screen.getByText("27621 流水花扇")).toBeTruthy();
    expect(calls.some((call) => call.url.includes("/reorder/articles?page_size=50"))).toBe(true);
  });

  it("搜索防抖：连敲 3 个字符只多发 1 次请求（每次请求都要跑一遍聚合）", async () => {
    vi.useFakeTimers();
    const calls = stub();
    render(<ReorderPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    const before = calls.filter((call) => call.url.includes("/reorder/articles?")).length;

    const box = screen.getByTestId("reorder-q");
    fireEvent.change(box, { target: { value: "2" } });
    fireEvent.change(box, { target: { value: "27" } });
    fireEvent.change(box, { target: { value: "276" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    const after = calls.filter((call) => call.url.includes("/reorder/articles?")).length;
    expect(after - before).toBe(1);
    vi.useRealTimers();
  });

  it("点击货号：URL 带 item_no 并拉该货号详情", async () => {
    const calls = stub();
    render(<ReorderPage />);
    fireEvent.click(await screen.findByTestId("reorder-article-27621流水花扇"));
    await screen.findByTestId("reorder-detail");
    expect(router.push).toHaveBeenCalledWith(`/reorder?item_no=${encodeURIComponent("27621 流水花扇")}`);
    await waitFor(() => expect(calls.some((call) => call.url.includes(`/reorder/articles/${encodeURIComponent("27621 流水花扇")}`))).toBe(true));
  });

  it("直接带 ?item_no= 进来（分享链接）也能拉到详情", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇" });
    stub();
    render(<ReorderPage />);
    await screen.findByTestId("reorder-detail");
    expect(screen.getByTestId("reorder-batch-table")).toBeTruthy();
  });

  it("切换货号会**清掉 order_no**（否则会停在上一批的单据上）", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇", order_no: "DL260001-1" });
    stub();
    render(<ReorderPage />);
    await screen.findByTestId("reorder-article-table");
    fireEvent.click(screen.getByTestId("reorder-article-27621流水花扇"));
    expect(router.push).toHaveBeenCalledWith("/reorder?item_no=27621%20%E6%B5%81%E6%B0%B4%E8%8A%B1%E6%89%87");
    const lastCall = router.push.mock.calls[router.push.mock.calls.length - 1][0];
    expect(lastCall).not.toContain("order_no");
  });
});

describe("返单与总结：汇总与批次", () => {
  it("数量按单位分行、金额按币种分行，绝不跨单位/跨币种相加", async () => {
    stub({ "/reorder/articles/": () => apiOk(detail({
      quantities: [{ unit: "支", quantity: "5880" }, { unit: "打", quantity: "120" }],
      purchase_amounts: [{ currency: "CNY", amount: "37036.8" }, { currency: "USD", amount: "30" }],
    })) });
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇" });
    render(<ReorderPage />);
    const summary = await screen.findByTestId("reorder-summary");
    expect(summary).toHaveTextContent("5880 支、120 打");
    expect(summary).toHaveTextContent("37036.8 CNY、30 USD");
  });

  it("合格率为 null 时显示 -（没有质检事实 ≠ 全部不合格）", async () => {
    stub({ "/reorder/articles": () => apiOk([article({ qc: { inspected: "0", qualified: "0", conditional: "0", rejected: "0", qualified_rate: null } })], { total: 1 }) });
    render(<ReorderPage />);
    await screen.findByTestId("reorder-article-table");
    const row = screen.getByTestId("reorder-article-table").querySelector("tbody tr") as HTMLElement;
    expect(within(row).getAllByRole("cell").at(-1)?.textContent).toBe("-");
  });

  it("批次按服务端给的顺序渲染（前端不二次排序）", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇" });
    stub();
    render(<ReorderPage />);
    const table = await screen.findByTestId("reorder-batch-table");
    const orderNos = [...table.querySelectorAll("tbody tr td:first-child")].map((cell) => cell.textContent);
    expect(orderNos[0]).toContain("DL260001-1");
    expect(orderNos[1]).toContain("DL260140-1");
  });

  it("「以此返单」跳到新建销售单并带上来源单号（编码过）", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇" });
    stub();
    render(<ReorderPage />);
    fireEvent.click(await screen.findByTestId("reorder-repeat-DL260001-1"));
    expect(router.push).toHaveBeenCalledWith(`/sales/orders/new?reorder_from_order_no=${encodeURIComponent("DL260001-1")}`);
  });

  it("不能返单的批次：按钮禁用，理由来自服务端（前端不自己拼条件）", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇" });
    stub();
    render(<ReorderPage />);
    const disabled = await screen.findByTestId("reorder-repeat-DL260140-1");
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveAttribute("title", "草稿单不能作为返单来源");
    expect(screen.getByTestId("reorder-repeat-DL260001-1")).not.toBeDisabled();
  });
});

describe("返单与总结：单据清单", () => {
  it("点「查看单据」→ URL 带 order_no 并渲染分组（空组显示「未建立」）", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇" });
    const calls = stub();
    render(<ReorderPage />);
    fireEvent.click(await screen.findByTestId("reorder-documents-DL260001-1"));

    expect(router.push).toHaveBeenCalledWith(`/reorder?item_no=${encodeURIComponent("27621 流水花扇")}&order_no=DL260001-1`);
    await screen.findByTestId("reorder-documents");
    await waitFor(() => expect(calls.some((call) => call.url.includes("/documents?order_no=DL260001-1"))).toBe(true));
    expect(screen.getByTestId("document-group-purchase_order")).toHaveTextContent("PO-1");
    // 空组也要显示：老板问的正是"当时有没有做 QC"。
    expect(screen.getByTestId("document-empty-finished_qc")).toHaveTextContent("未建立");
  });

  it("回落 createdAt 的日期要标「（登记时间）」——否则会被当成真实业务日期", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇", order_no: "DL260001-1" });
    stub();
    render(<ReorderPage />);
    const inbound = (await screen.findByTestId("document-group-raw_material_inbound")).textContent ?? "";
    expect(inbound).toContain("2026-05-22（登记时间）");
    const purchase = screen.getByTestId("document-group-purchase_order").textContent ?? "";
    expect(purchase).toContain("2026-05-03");
    expect(purchase).not.toContain("登记时间");
  });

  it("来料质检的跳转带 receipt_id（那是它唯一能定位到批次的参数）", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇", order_no: "DL260001-1" });
    stub();
    render(<ReorderPage />);
    const link = await screen.findByTestId("document-link-incoming_inspection");
    expect(link).toHaveAttribute("href", "/qc/incoming?receipt_id=rc-1");
  });
});

describe("返单与总结：待补录入口", () => {
  it("「未填货号（补录）」默认收起，点开才展开待办面板", async () => {
    stub();
    render(<ReorderPage />);
    expect(screen.queryByTestId("unassigned-panel")).toBeNull();
    fireEvent.click(await screen.findByTestId("reorder-toggle-unassigned"));
    await screen.findByTestId("unassigned-panel");
  });
});

describe("返单与总结：复盘增强（T14）", () => {
  const financeDetail = (overrides = {}) => detail({
    quality_trend: [
      { order_no: "DL260001-1", order_date: "2026-05-01T00:00:00.000Z", inspected: "1960", qualified: "1930", qualified_rate: "0.9847" },
      { order_no: "DL260140-1", order_date: "2026-07-01T00:00:00.000Z", inspected: "500", qualified: "480", qualified_rate: "0.96" },
    ],
    gross_margin: {
      batches: [
        { order_no: "DL260001-1", included: true, currency: "USD", sales_amount: "2352", cost_amount: "1200", gross_profit: "1152", cost_caveat: true },
        { order_no: "DL260140-1", included: false, currency: null, sales_amount: null, cost_amount: null, gross_profit: null, cost_caveat: false },
      ],
      totals: [{ currency: "USD", order_count: 1, sales_amount: "2352", cost_amount: "1200", gross_profit: "1152" }],
      footnotes: ["缺采购价物料（成本按 0 计入，毛利偏高）：MAT-9 伞骨"],
    },
    ...overrides,
  });

  it("交期：汇总五档都在，每批显示结论与天数（未出货/无交期不算准时）", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇" });
    stub();
    render(<ReorderPage />);
    const summary = await screen.findByTestId("reorder-delivery-summary");
    expect(summary).toHaveTextContent("提前 1");
    expect(summary).toHaveTextContent("未出货 0");
    expect(summary).toHaveTextContent("无交期 1");
    expect(screen.getByTestId("reorder-delivery-DL260001-1")).toHaveTextContent("提前（-5 天）");
    expect(screen.getByTestId("reorder-delivery-DL260140-1")).toHaveTextContent("无交期");
  });

  it("合格率趋势：不足两批就不显示那块（一批没有趋势可言）", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇" });
    stub();
    render(<ReorderPage />);
    await screen.findByTestId("reorder-batch-table");
    expect(screen.queryByTestId("reorder-quality-trend")).toBeNull();
  });

  it("毛利：有财务权限时显示汇总与缺价警告；「其他」角色看不到金额", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇" });
    stub({ "/reorder/articles/": () => apiOk(financeDetail()) });

    // ① 有财务权限（老板）：毛利与警告都要露出来，草稿单不计入也要说明
    const { unmount } = render(session(<ReorderPage />, FULL_SECTIONS));
    await screen.findByTestId("reorder-gross-margin");
    expect(screen.getByTestId("reorder-gross-margin")).toHaveTextContent("1152");
    expect(screen.getByTestId("reorder-gross-margin-footnotes")).toHaveTextContent("缺采购价物料");
    expect(screen.getByTestId("reorder-quality-trend")).toBeTruthy();
    unmount();

    // ② 无财务权限（其他）：金额类内容整块不显示，但交期与合格率趋势照常
    render(session(<ReorderPage />, GENERAL_SECTIONS));
    await screen.findByTestId("reorder-batch-table");
    expect(screen.queryByTestId("reorder-gross-margin")).toBeNull();
    expect(screen.getByTestId("reorder-quality-trend")).toBeTruthy();
  });

  it("导出按钮：有选中货号时才出现（导出的是这个货号的总结表）", async () => {
    stub();
    const { unmount } = render(<ReorderPage />);
    await screen.findByTestId("reorder-article-table");
    expect(screen.queryByTestId("reorder-export")).toBeNull();
    unmount();

    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇" });
    render(<ReorderPage />);
    await screen.findByTestId("reorder-detail");
    expect(screen.getByTestId("reorder-export")).toBeTruthy();
  });
});

describe("返单与总结：失败态", () => {
  it("详情接口失败 → 错误态，且**不留**上一批的数据", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇" });
    stub({ "/reorder/articles/": () => apiErr(404, "ARTICLE_NOT_FOUND", "没有找到货号「27621 流水花扇」的销售单") });
    render(<ReorderPage />);
    await screen.findByText(/没有找到货号/);
    expect(screen.queryByTestId("reorder-batch-table")).toBeNull();
  });

  it("单据接口失败 → 清空分组（上一批的单据留在屏幕上比加载中更危险）", async () => {
    router.searchParams = new URLSearchParams({ item_no: "27621 流水花扇", order_no: "DL260001-1" });
    stub({ "/documents": () => apiErr(404, "ORDER_NOT_IN_ARTICLE", "销售单 DL260001-1 不属于货号「27621 流水花扇」") });
    render(<ReorderPage />);
    await screen.findByText(/不属于货号/);
    expect(screen.queryByTestId("document-group-purchase_order")).toBeNull();
  });
});

afterEach(() => { vi.useRealTimers(); });
