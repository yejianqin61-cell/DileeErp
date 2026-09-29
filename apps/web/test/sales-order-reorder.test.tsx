// 返单前端（T06）：入口、预填与来源提示。
//
// 老板原话：「以后客户返单，从系统里面调取，返单客户货号不变」。
// 设计：docs/design/reorder-item-no-and-summary-2026-09-26.md §四.3、§五
//
// 钉住四件事：
//   1. 带 `?reorder_from_order_no=` 进来时工艺口径被**一次性**预填（标量 + 明细 + 材料引用）；
//   2. 必须重填的四格（订单号/下单日/数量/交期）**留空**并标「返单必填」——绝不沿用上一批的数量与交期；
//   3. 来源横幅说清「从哪张单返的」，并能跳到来源单；
//   4. 预览失败时是**错误态**，不是空表单（空表单会被销售当成「本来就没工艺要求」直接存下去）。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SalesOrderEditor } from "../components/sales/sales-order-editor";
import { apiOk, apiErr, stubApi, type StubbedCall } from "./helpers/api-stub";

const routerPush = vi.fn();
/** `useSearchParams` 的返回值由测试改（`vi.hoisted` 保证 mock 工厂能安全引用它）。 */
const state = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => state.searchParams,
}));

const customer = { id: "customer-1", customerCode: "C001", name: "FLOWER1", isActive: true, currency: "USD", contacts: [] };

/** 与 `GET /sales-orders/reorder-preview` 同形状（服务端给什么，这里就照什么）。 */
const preview = {
  source_order_no: "DL260001-1",
  source_order_id: "source-1",
  item_no: "27621 流水花扇",
  customer_id: "customer-1",
  contact_id: null,
  copy: {
    product_name: "50cm*5K 三折手开碳纤维伞",
    product_spec: "50cm*5K",
    unit: "支",
    currency: "USD",
    unit_price: "1.2",
    settlement_unit_price: "1.15",
    tax_rate: "0.13",
    settlement_method: "tt",
    rib_spec: "双碳纤骨",
    qc_requirement: "所有材料都要质检报告",
    fabric_usage_canopy: "1.2",
    spec_details: [{ group_name: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: null, quantity: "100", unit: "pcs", sort_order: 0 }],
    material_refs: [{ spec_key: "rib_spec", material_id: "material-1", material: { id: "material-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "58cm", color: null, image: null } }],
  },
  must_fill: ["order_no", "order_date", "quantity", "delivery_date"],
  warnings: ["单价沿用上次（1.2 USD），请复核"],
};

const existingOrder = {
  id: "order-1", orderNo: "DL260300-1", status: "draft", itemNo: "27621 流水花扇", reorderFromOrderNo: "DL260001-1",
  customer: { id: "customer-1" }, contact: null, productName: "三折伞", quantity: "2500", unit: "支", currency: "USD",
  orderDate: "2026-09-26T00:00:00.000Z", specDetails: [], materialRefs: [], boms: [], versions: [],
};

function stub(handlers: Record<string, () => Response> = {}): StubbedCall[] {
  return stubApi((url) => {
    for (const [fragment, handler] of Object.entries(handlers)) if (url.includes(fragment)) return handler();
    if (url.includes("/sales-orders/reorder-preview")) return apiOk(preview);
    if (url.includes("/sales-orders/order-1")) return apiOk(existingOrder);
    if (url.includes("/customers")) return apiOk([customer]);
    if (url.includes("/units")) return apiOk([{ id: "unit-1", name: "支" }]);
    if (url.includes("/dictionaries/currency/items")) return apiOk({ data: [] });
    if (url.includes("/sales-orders/item-nos")) return apiOk([]);
    if (url.includes("/materials")) return apiOk([{ id: "material-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "58cm", color: null, image: null, isActive: true }]);
    return apiOk({});
  });
}

/** 切到「以 DL260001-1 返单」的入口。 */
function openReorder() {
  state.searchParams = new URLSearchParams({ reorder_from_order_no: "DL260001-1" });
}

describe("返单：预填与必填提示", () => {
  it("带来源单号进来时，工艺口径被预填（标量 + 明细 + 材料引用）", async () => {
    openReorder();
    stub();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");

    await waitFor(() => expect(screen.getByTestId("sales-spec-rib_spec")).toHaveValue("双碳纤骨"));
    expect(screen.getByTestId("sales-spec-qc_requirement")).toHaveValue("所有材料都要质检报告");
    expect(screen.getByTestId("sales-spec-fabric_usage_canopy")).toHaveValue("1.2");
    expect(screen.getByTestId("sales-base-product_name")).toHaveValue("50cm*5K 三折手开碳纤维伞");
    expect(screen.getByTestId("sales-base-unit_price")).toHaveValue("1.2");
    expect(screen.getByTestId("sales-base-item_no")).toHaveValue("27621 流水花扇");
    // 明细行与材料引用一起带过来
    expect(screen.getByDisplayValue("27621 流水花扇PKGY")).toBeTruthy();
    expect(screen.getByTestId("sales-material-ref-rib_spec")).toHaveTextContent("伞骨");
  });

  it("必须重填的四格留空，并都标上「返单必填」", async () => {
    openReorder();
    stub();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await waitFor(() => expect(screen.getByTestId("reorder-must-fill-order_no")).toBeTruthy());

    for (const key of ["order_no", "order_date", "quantity", "delivery_date"]) {
      expect(screen.getByTestId(`reorder-must-fill-${key}`)).toHaveTextContent("返单必填");
      expect(screen.getByTestId(`sales-base-${key}`), `${key} 必须留空`).toHaveValue("");
    }
  });

  it("金额三兄弟**不**预填：它们由数量派生，抄过来必然与新数量矛盾", async () => {
    openReorder();
    stub();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await waitFor(() => expect(screen.getByTestId("sales-base-unit_price")).toHaveValue("1.2"));

    for (const key of ["total_amount", "receivable_amount", "local_currency_amount"]) {
      expect(screen.getByTestId(`sales-base-${key}`), `${key} 不该被预填`).toHaveValue("");
    }
  });

  it("预览失败 → 错误态 + 说明去哪里重试，而不是一张空白表单", async () => {
    openReorder();
    stub({ "/sales-orders/reorder-preview": () => apiErr(422, "REORDER_SOURCE_ITEM_NO_MISSING", "来源单 DL260001-1 没有货号：请先给它补货号，再返单") });
    render(<SalesOrderEditor />);

    const alert = await screen.findByText(/没有货号：请先给它补货号/);
    expect(alert).toBeTruthy();
    // 错误态里不该出现任何可编辑的工艺字段 —— 空表单会被当成「本来就没工艺要求」。
    expect(screen.queryByTestId("sales-spec-rib_spec")).toBeNull();
  });
});

describe("返单：来源横幅", () => {
  it("显示来源单号与同货号，并给出「查看来源单」", async () => {
    openReorder();
    stub();
    render(<SalesOrderEditor />);
    const banner = await screen.findByTestId("reorder-source-banner");
    await waitFor(() => expect(banner).toHaveTextContent("DL260001-1"));
    expect(banner).toHaveTextContent("27621 流水花扇");
    expect(screen.getByTestId("reorder-source-link")).toHaveAttribute("href", "/sales/orders/source-1/edit");
  });

  it("改了货号就提示「会归到新的货号下」——返单分组的前提是货号不变", async () => {
    openReorder();
    stub();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await waitFor(() => expect(screen.getByTestId("reorder-source-banner")).toBeTruthy());
    expect(screen.queryByTestId("reorder-item-no-changed")).toBeNull();

    fireEvent.change(screen.getByTestId("sales-base-item_no"), { target: { value: "88001 新版" } });
    expect(screen.getByTestId("reorder-item-no-changed")).toHaveTextContent("不再与 DL260001-1 同组");
  });

  it("编辑一张由返单来的单：只读展示来源，不给「换来源」的入口", async () => {
    state.searchParams = new URLSearchParams();
    stub();
    render(<SalesOrderEditor orderId="order-1" />);
    const banner = await screen.findByTestId("reorder-source-banner");
    await waitFor(() => expect(banner).toHaveTextContent("DL260001-1"));
    expect(screen.queryByTestId("reorder-source-link")).toBeNull();
  });

  it("普通新建单没有横幅（不是返单就别显示返单的东西）", async () => {
    state.searchParams = new URLSearchParams();
    stub();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    expect(screen.queryByTestId("reorder-source-banner")).toBeNull();
  });
});

describe("返单：保存载荷", () => {
  it("带 reorder_from_order_no，且不含金额三兄弟（没预填就不会发出去）", async () => {
    openReorder();
    const calls = stub();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await waitFor(() => expect(screen.getByTestId("sales-base-unit_price")).toHaveValue("1.2"));

    // 补上必须重填的四格
    fireEvent.change(screen.getByTestId("sales-base-order_no"), { target: { value: "DL260300-1" } });
    fireEvent.change(screen.getByTestId("sales-base-order_date"), { target: { value: "2026-09-26" } });
    fireEvent.change(screen.getByTestId("sales-base-quantity"), { target: { value: "2500" } });
    fireEvent.change(screen.getByTestId("sales-base-delivery_date"), { target: { value: "2026-11-30" } });
    await userEvent.click(screen.getByTestId("sales-order-save"));

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    const body = JSON.parse(String(calls.find((call) => call.method === "POST")?.body));
    expect(body.reorder_from_order_no).toBe("DL260001-1");
    expect(body.item_no).toBe("27621 流水花扇");
    expect(body.quantity).toBe("2500");
    expect(body.rib_spec).toBe("双碳纤骨");
    expect(body.material_refs).toEqual([{ spec_key: "rib_spec", material_id: "material-1" }]);
    for (const key of ["total_amount", "receivable_amount", "local_currency_amount"]) {
      expect(key in body, `${key} 不该被发出去`).toBe(false);
    }
  });
});
