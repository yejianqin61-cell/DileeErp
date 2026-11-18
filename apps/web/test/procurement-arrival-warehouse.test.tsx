// 工单 T-0018：原料到货登记要能选择同安仓 / 晋江仓 / 大田仓。
//
// 钉住两个会直接影响用户的点：
//   1. 「登记到货」弹窗有入库地点下拉，选晋江仓后 POST 必须带上 warehouse_code；
//   2. 已登记的到货批次要能看见地点，编辑时地点回填，PATCH 也要带上 warehouse_code。
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

const warehouses = [
  { code: "tongan", name: "同安仓" },
  { code: "jinjiang", name: "晋江仓" },
  { code: "daitan", name: "大田仓" },
];

function purchaseOrder({ withReceipt = false }: { withReceipt?: boolean } = {}) {
  const receipt = {
    id: "r-1",
    receiptNo: "GR-1",
    quantity: "1500",
    status: "received",
    receivedDate: "2026-11-18T00:00:00.000Z",
    batchSequence: 1,
    extensionData: { over_receipt: false, warehouse_code: "daitan", warehouse_name: "大田仓" },
    warehouseCode: "daitan",
    warehouseName: "大田仓",
    inspections: [{ id: "i-1", status: "pending", inspectedQuantity: "0", acceptedQuantity: "0", conditionalQuantity: "0", rejectedQuantity: "0" }],
    rawMaterialInbounds: [],
  };
  return {
    id: "po-1",
    purchaseOrderNo: "CG20261118",
    orderNo: "DL260181",
    status: withReceipt ? "arrived_complete" : "ordered",
    currency: "CNY",
    totalAmount: "3000.0000",
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
      receipts: withReceipt ? [receipt] : [],
    }],
  };
}

function stubOrderPage(order: ReturnType<typeof purchaseOrder>) {
  return stubApi((url) => {
    if (url.endsWith("/purchase-orders/warehouses")) return apiOk(warehouses);
    if (url.endsWith("/purchase-orders/po-1")) return apiOk(order);
    return apiOk([]);
  });
}

async function pickSelect(testid: string, optionText: string) {
  await userEvent.click(screen.getByTestId(testid));
  await userEvent.click(await screen.findByRole("option", { name: optionText }));
}

const postReceiptCalls = (calls: StubbedCall[]) => calls.filter((call) => call.method === "POST" && call.url.endsWith("/purchase-orders/po-1/items/item-1/receipts"));
const patchReceiptCalls = (calls: StubbedCall[]) => calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/purchase-orders/receipts/r-1"));

describe("采购单详情：到货登记的入库地点", () => {
  it("登记到货可选晋江仓，提交时把 warehouse_code 一起发出去", async () => {
    const calls = stubOrderPage(purchaseOrder());
    render(<><PurchaseOrderDetailPage /><Toaster /></>);

    await screen.findByTestId("page-procurement-orders-detail");
    await userEvent.click(screen.getByRole("button", { name: "登记下一批到货" }));
    expect(await screen.findByText("入库地点")).toBeVisible();

    await pickSelect("action-field-warehouse_code", "晋江仓");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postReceiptCalls(calls)).toHaveLength(1));
    expect(JSON.parse(String(postReceiptCalls(calls)[0].body))).toMatchObject({ warehouse_code: "jinjiang" });
  });

  it("已登记的到货批次显示大田仓；编辑时回填并允许改成晋江仓", async () => {
    const calls = stubOrderPage(purchaseOrder({ withReceipt: true }));
    render(<><PurchaseOrderDetailPage /><Toaster /></>);

    await screen.findByTestId("page-procurement-orders-detail");
    expect(await screen.findByText(/大田仓/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "编辑到货" }));
    expect(screen.getByTestId("action-field-warehouse_code")).toHaveTextContent("大田仓");

    await pickSelect("action-field-warehouse_code", "晋江仓");
    await userEvent.type(screen.getByTestId("action-field-reason"), "货物改送晋江仓");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(patchReceiptCalls(calls)).toHaveLength(1));
    expect(JSON.parse(String(patchReceiptCalls(calls)[0].body))).toMatchObject({ warehouse_code: "jinjiang" });
  });
});
