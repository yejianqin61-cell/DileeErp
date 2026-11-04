// 超收（到货 > 订购）与「按实收登记」的前端行为测试（2026-11-04）。
//
// 用户口径：采购伞布 1500 码、供应商实际送到 1600 码 —— 「供应商会多送原料，但是系统不允许
// 到货的大于订购数量。这点要允许。」
//
// 这里钉住两个真的会回归的地方：
//   1. 采购单详情「编辑到货批次」必须能填并提交超收原因（此前弹窗没有这个字段，PATCH 也不发，
//      于是 1500→1600 的修正在界面上根本走不通）；
//   2. 超收的到货批次在到货列要能看出「超收」，而不是混在正常批次里。
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PurchaseOrderDetailPage from "../app/procurement/orders/[id]/page";
import { Toaster } from "../components/ui/toaster";
import { apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useParams: () => ({ id: "po-1" }),
}));

const inspection = { id: "i-1", status: "pending", inspectedQuantity: "0", acceptedQuantity: "0", conditionalQuantity: "0", rejectedQuantity: "0" };

/** 采购 1500 码；默认到货也先登记 1500 码，`overReceipt` 时换成实收 1600 码的超收批次。 */
function purchaseOrder({ overReceipt = false }: { overReceipt?: boolean } = {}) {
  return {
    id: "po-1",
    purchaseOrderNo: "CG20261101",
    orderNo: "DL260180",
    status: "arrived_complete",
    currency: "CNY",
    totalAmount: "1500.0000",
    extensionData: {},
    supplier: { name: "绍兴伞布厂" },
    items: [{
      id: "item-1",
      materialId: "m-1",
      unitId: "u-1",
      quantity: "1500",
      material: { materialCode: "M-01", name: "伞布" },
      unit: { name: "码" },
      supplier: { name: "绍兴伞布厂" },
      receipts: [{
        id: "r-1",
        receiptNo: "GR-1",
        quantity: overReceipt ? "1600" : "1500",
        status: "received",
        receivedDate: "2026-11-04T00:00:00.000Z",
        batchSequence: 1,
        extensionData: overReceipt ? { over_receipt: true, over_receipt_reason: "供应商多送 100 码" } : { over_receipt: false },
        inspections: [inspection],
        rawMaterialInbounds: [],
      }],
    }],
  };
}

const patchCalls = (calls: StubbedCall[]) =>
  calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/purchase-orders/receipts/r-1"));

describe("采购单详情：超收与按实收修改到货", () => {
  it("编辑到货批次：能填超收原因，PATCH 同时发数量、超收原因和修改原因", async () => {
    const calls = stubApi((url) => (url.endsWith("/purchase-orders/po-1") ? apiOk(purchaseOrder()) : apiOk([])));
    render(<><PurchaseOrderDetailPage /><Toaster /></>);

    await screen.findByTestId("page-procurement-orders-detail");
    await userEvent.click(await screen.findByRole("button", { name: "编辑到货" }));

    expect(await screen.findByText("超收原因（到货超过采购数量时填写，选填）")).toBeVisible();

    const quantity = screen.getByTestId("action-field-quantity");
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "1600");
    await userEvent.type(screen.getByTestId("action-field-over_receipt_reason"), "供应商多送 100 码");
    await userEvent.type(screen.getByTestId("action-field-reason"), "实收 1600 码");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(patchCalls(calls)).toHaveLength(1));
    expect(JSON.parse(String(patchCalls(calls)[0].body))).toMatchObject({
      quantity: "1600",
      over_receipt_reason: "供应商多送 100 码",
      reason: "实收 1600 码",
    });
  });

  it("超收的到货批次在到货列标出「超收」", async () => {
    stubApi((url) => (url.endsWith("/purchase-orders/po-1") ? apiOk(purchaseOrder({ overReceipt: true })) : apiOk([])));

    render(<><PurchaseOrderDetailPage /><Toaster /></>);

    await screen.findByTestId("page-procurement-orders-detail");
    const badge = await screen.findByText(/超收/);
    expect(badge).toBeVisible();
    expect(badge.closest("td")).toHaveTextContent("1600");
  });
});
