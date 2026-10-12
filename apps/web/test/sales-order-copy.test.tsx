// 销售单「普通复制」前端（列表入口 + 新建页 copy 模式）。
//
// 用户原话：「销售单这边添加一个复制，把别的单的所有详情可以整单导入。就是订单描述基本差不多，
// 可以直接用原有的复制，然后我们改下单号和里面的细节就行了」。
//
// 钉住五件事：
//   1. 列表每行都有「复制」入口，链接是 `?copy_from_id=<id>`（**任何状态**都有，含草稿/已关闭）；
//   2. 带 `?copy_from_id=` 进来时详情被**一次性**预填（标量 + 明细 + 材料引用 + 「其它」行）；
//   3. 必须重填的四格（订单号/下单日/数量/交期）**留空**并标「复制后必填」，金额三兄弟不预填；
//   4. 横幅说清「由谁复制」，并**明说新单不记来源**（否则销售会去返单分组里找这张单）；
//   5. 保存载荷**不含** `reorder_from_order_no` —— 这是本功能与「返单」的分界线，写错了新单会被
//      归进返单分组、被当成客户返单；快照失败时是**错误态**，不是一张空白表单。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SalesOrdersList from "../components/sales/sales-orders-list";
import { SalesOrderEditor } from "../components/sales/sales-order-editor";
import { apiOk, apiErr, stubApi, type StubbedCall } from "./helpers/api-stub";

const routerPush = vi.fn();
const state = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => state.searchParams,
}));

const customer = { id: "customer-1", customerCode: "C001", name: "FLOWER1", isActive: true, currency: "USD", contacts: [] };

/** 与 `GET /sales-orders/:id/copy-snapshot` 同形状（服务端给什么，这里就照什么）。 */
const snapshot = {
  source_order_no: "DL260001-1",
  source_order_id: "source-1",
  source_status: "draft",
  customer_id: "customer-1",
  contact_id: null,
  copy: {
    item_no: "27621 流水花扇",
    product_name: "50cm*5K 三折手开碳纤维伞",
    product_spec: "50cm*5K",
    unit: "支",
    currency: "USD",
    customer_po_no: "PO#32366-1",
    external_contract_no: "EXT-1",
    unit_price: "1.2",
    settlement_unit_price: "1.15",
    tax_rate: "0.13",
    settlement_method: "tt",
    extension_data: { source: "老单" },
    rib_spec: "双碳纤骨",
    qc_requirement: "所有材料都要质检报告",
    spec_details: [{ group_name: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: null, quantity: "100", unit: "pcs", sort_order: 0 }],
    material_refs: [{ spec_key: "rib_spec", material_id: "material-1", material: { id: "material-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "58cm", color: null, image: null } }],
    material_extras: [{ label: "弹簧", content: "5cm 不锈钢", material_id: "material-1", sort_order: 0, material: { id: "material-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "58cm", color: null, image: null } }],
    spec_detail_labels: { name: "品番" },
  },
  must_fill: ["order_no", "order_date", "quantity", "delivery_date"],
  dropped: { material_refs: ["handle_spec"], material_extras: [] },
  warnings: ["单价沿用上次（1.2 USD），请复核"],
};

const order = { id: "order-1", orderNo: "DL260134", status: "draft", productName: "雨伞", quantity: "10", unit: "支", customer: { id: "c-1", name: "家百纳", isActive: true, contacts: [] }, boms: [] };

function stub(handlers: Record<string, () => Response> = {}): StubbedCall[] {
  return stubApi((url) => {
    for (const [fragment, handler] of Object.entries(handlers)) if (url.includes(fragment)) return handler();
    if (url.includes("/copy-snapshot")) return apiOk(snapshot);
    if (url.includes("/sales-orders/finished-goods-summary")) return apiOk({ production_order_count: 0, groups: [], totals: [] });
    if (url.includes("/sales-orders/item-nos")) return apiOk([]);
    if (url.includes("/products/units") || url.includes("/units")) return apiOk([{ id: "unit-1", name: "支" }]);
    if (url.includes("/dictionaries/currency/items")) return apiOk({ data: [] });
    if (url.includes("/customers")) return apiOk([customer]);
    if (url.includes("/materials")) return apiOk([{ id: "material-1", materialCode: "MAT-1", name: "伞骨", specificationModel: "58cm", color: null, image: null, isActive: true }]);
    if (url.includes("/sales-orders")) return apiOk([order]);
    return apiOk({});
  });
}

/** 切到「以 source-1 复制」的新建页。 */
function openCopy() {
  state.searchParams = new URLSearchParams({ copy_from_id: "source-1" });
}

describe("复制：列表入口", () => {
  it("每一行都有「复制」，链接指向 /sales/orders/new?copy_from_id=<id>", async () => {
    state.searchParams = new URLSearchParams();
    stub();
    render(<SalesOrdersList />);
    const link = await screen.findByTestId("order-copy-DL260134");
    expect(link).toHaveAttribute("href", "/sales/orders/new?copy_from_id=order-1");
  });

  it("已关闭的单也能复制（普通复制不限状态，与返单的三条门槛相反）", async () => {
    state.searchParams = new URLSearchParams();
    stubApi((url) => {
      if (url.includes("/sales-orders/finished-goods-summary")) return apiOk({ production_order_count: 0, groups: [], totals: [] });
      if (url.includes("/sales-orders/item-nos")) return apiOk([]);
      if (url.includes("/sales-orders")) return apiOk([{ ...order, status: "closed" }]);
      return apiOk([]);
    });
    render(<SalesOrdersList />);
    expect(await screen.findByTestId("order-copy-DL260134")).toHaveAttribute("href", "/sales/orders/new?copy_from_id=order-1");
  });
});

describe("复制：预填", () => {
  it("带 copy_from_id 进来时，详情被一次性预填（标量 + 明细 + 材料引用 +「其它」行）", async () => {
    openCopy();
    stub();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");

    await waitFor(() => expect(screen.getByTestId("sales-spec-rib_spec")).toHaveValue("双碳纤骨"));
    expect(screen.getByTestId("sales-spec-qc_requirement")).toHaveValue("所有材料都要质检报告");
    expect(screen.getByTestId("sales-base-product_name")).toHaveValue("50cm*5K 三折手开碳纤维伞");
    expect(screen.getByTestId("sales-base-unit_price")).toHaveValue("1.2");
    expect(screen.getByTestId("sales-base-item_no")).toHaveValue("27621 流水花扇");
    expect(screen.getByDisplayValue("27621 流水花扇PKGY")).toBeTruthy();
    expect(screen.getByTestId("sales-material-ref-rib_spec")).toHaveTextContent("伞骨");
    expect(screen.getByTestId("sales-material-extra-label-0")).toHaveValue("弹簧");
    // 明细列名的自定义覆盖也跟着来源单（列名属于工艺口径的一部分）。
    expect(screen.getByTestId("sales-detail-head-name")).toHaveTextContent("品番");
  });

  it("必须重填的四格留空，并都标上「复制后必填」", async () => {
    openCopy();
    stub();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await waitFor(() => expect(screen.getByTestId("copy-must-fill-order_no")).toBeTruthy());

    for (const key of ["order_no", "order_date", "quantity", "delivery_date"]) {
      expect(screen.getByTestId(`copy-must-fill-${key}`)).toHaveTextContent("复制后必填");
      expect(screen.getByTestId(`sales-base-${key}`), `${key} 必须留空`).toHaveValue("");
    }
  });

  it("金额三兄弟**不**预填：它们由数量派生，抄过来必然与新数量矛盾", async () => {
    openCopy();
    stub();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await waitFor(() => expect(screen.getByTestId("sales-base-unit_price")).toHaveValue("1.2"));

    for (const key of ["total_amount", "receivable_amount", "local_currency_amount"]) {
      expect(screen.getByTestId(`sales-base-${key}`), `${key} 不该被预填`).toHaveValue("");
    }
  });

  it("快照失败 → 错误态 + 说明去哪里重试，而不是一张空白表单", async () => {
    openCopy();
    stub({ "/copy-snapshot": () => apiErr(404, "COPY_SOURCE_NOT_FOUND", "复制来源销售单不存在（可能已被删除）") });
    render(<SalesOrderEditor />);

    expect(await screen.findByText(/复制来源销售单不存在/)).toBeTruthy();
    // 错误态里不该出现任何可编辑的工艺字段 —— 空表单会被当成「本来就没工艺要求」。
    expect(screen.queryByTestId("sales-spec-rib_spec")).toBeNull();
  });
});

describe("复制：横幅", () => {
  it("显示「由 X 复制」与「查看来源单」，并明说新单不记来源（不会被当成返单）", async () => {
    openCopy();
    stub();
    render(<SalesOrderEditor />);
    const banner = await screen.findByTestId("copy-source-banner");
    await waitFor(() => expect(banner).toHaveTextContent("DL260001-1"));
    expect(banner).toHaveTextContent("复制");
    expect(banner).toHaveTextContent("不记来源");
    expect(banner).toHaveTextContent("返单分组");
    expect(screen.getByTestId("copy-source-link")).toHaveAttribute("href", "/sales/orders/source-1/edit");
    // 失效引用被剔掉时要当面说明（否则那一格的图片没了看起来像坏了）。
    expect(screen.getByTestId("copy-dropped-materials")).toHaveTextContent("handle_spec");
    // 复制模式不该出现返单横幅（两条路的分组语义不同）。
    expect(screen.queryByTestId("reorder-source-banner")).toBeNull();
  });

  it("普通新建单没有复制横幅", async () => {
    state.searchParams = new URLSearchParams();
    stub();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    expect(screen.queryByTestId("copy-source-banner")).toBeNull();
  });
});

describe("复制：保存载荷", () => {
  it("**不含 reorder_from_order_no**，且带上了复制过来的详情", async () => {
    openCopy();
    const calls = stub();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await waitFor(() => expect(screen.getByTestId("sales-base-unit_price")).toHaveValue("1.2"));

    // 补上必须重填的四格
    fireEvent.change(screen.getByTestId("sales-base-order_no"), { target: { value: "DL260300-2" } });
    fireEvent.change(screen.getByTestId("sales-base-order_date"), { target: { value: "2026-10-12" } });
    fireEvent.change(screen.getByTestId("sales-base-quantity"), { target: { value: "2500" } });
    fireEvent.change(screen.getByTestId("sales-base-delivery_date"), { target: { value: "2026-12-30" } });
    await userEvent.click(screen.getByTestId("sales-order-save"));

    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    const body = JSON.parse(String(calls.find((call) => call.method === "POST")?.body));
    // 这条断言是「复制」与「返单」的分界线：一旦带上来源，新单会被归进返单分组。
    expect("reorder_from_order_no" in body).toBe(false);
    expect(body.order_no).toBe("DL260300-2");
    expect(body.quantity).toBe("2500");
    expect(body.item_no).toBe("27621 流水花扇");
    expect(body.currency).toBe("USD");
    expect(body.rib_spec).toBe("双碳纤骨");
    expect(body.material_refs).toEqual([{ spec_key: "rib_spec", material_id: "material-1" }]);
    expect(body.spec_detail_labels).toEqual({ name: "品番" });
    expect(body.extension_data).toEqual({ source: "老单" });
    for (const key of ["total_amount", "receivable_amount", "local_currency_amount"]) {
      expect(key in body, `${key} 不该被发出去`).toBe(false);
    }
  });

  it("订单号留空点保存 → 当场拦下（新单订单号必填，与新建销售单一致）", async () => {
    openCopy();
    const calls = stub();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    await waitFor(() => expect(screen.getByTestId("sales-base-product_name")).toHaveValue("50cm*5K 三折手开碳纤维伞"));

    fireEvent.change(screen.getByTestId("sales-base-order_date"), { target: { value: "2026-10-12" } });
    fireEvent.change(screen.getByTestId("sales-base-quantity"), { target: { value: "2500" } });
    await userEvent.click(screen.getByTestId("sales-order-save"));

    expect(await screen.findByText("订单号必填")).toBeTruthy();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});
