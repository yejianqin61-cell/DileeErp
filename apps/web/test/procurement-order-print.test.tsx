// 采购单页（app/procurement/orders/page.tsx）的两件事的行为测试（2026-09-16 用户要求）：
//
//   1.「需要允许导出 excel 采购单出来」—— 单张导出的接口与版式一直都有，但**页面上没有入口**
//      （`exportPurchaseOrder()` 定义了却没人调用，拆枢纽页时丢的）。本文件钉住每行都有「导出」，
//      且请求打到 `/procurement/reports/purchase-order.xlsx?purchase_order_id=…`。
//   2.「系统中采购单也要支持对（打印表上的）这些字段进行填写和设置」—— 「打印信息」弹窗：
//      付款方式（月结30天/月结60天/当月付款，可清空）、交货日期、交期条款、交货地址、
//      厂家回签意见 / 厂家回签 / 主管签字、备注，PATCH 到 `/purchase-orders/:id/print-fields`。
//      失败必须留在弹窗里并显示原因（用户填的几行字不能丢）。
//
// 纪律：真实渲染页面 + 真实点击 + 真实 fetch 桩；只断言 DOM 文本与 stubApi 记录到的 method + URL + body。
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PurchaseOrdersPage from "../app/procurement/orders/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 下载三件套（与 payable-page.test.tsx 同一套）：只关心 URL 与文件名。 */
let anchorClicks: Array<{ download: string; href: string }> = [];
function captureDownloads() {
  anchorClicks = [];
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:http://localhost/${anchorClicks.length + 1}`),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    anchorClicks.push({ download: this.getAttribute("download") ?? "", href: this.getAttribute("href") ?? "" });
  });
}
afterEach(() => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

const EP = {
  purchaseOrders: "/api/v1/purchase-orders",
  exportOne: "/api/v1/procurement/reports/purchase-order.xlsx",
  materials: "/api/v1/materials",
  units: "/api/v1/units",
  suppliers: "/api/v1/suppliers",
  boms: "/api/v1/boms",
  salesOrders: "/api/v1/sales-orders",
  currencies: "/api/v1/dictionaries/currency/items",
} as const;

/** 已下单的一张采购单：付款方式只填了一半，交货地址与回签都还空着。 */
const order = {
  id: "po-1",
  purchaseOrderNo: "PO-20260916-0001",
  orderNo: "DL260001",
  bomId: "bom-1",
  supplierId: "s-1",
  purchaseDate: "2026-09-10T00:00:00.000Z",
  expectedDate: "2026-09-25T00:00:00.000Z",
  status: "ordered",
  currency: "CNY",
  totalAmount: "3460.0000",
  paymentTerms: "月结30天",
  deliveryTerms: null,
  deliveryAddress: null,
  supplierReply: null,
  supplierSigned: null,
  supervisorSignature: null,
  remark: "含税价",
  extensionData: {},
  supplier: { name: "某某五金厂" },
  items: [{ id: "item-1", materialId: "m-1", unitId: "u-1", supplierId: "s-1", model: "58cm", quantity: "1200", unitPrice: "1.25", expectedDate: "2026-09-18T00:00:00.000Z", material: { materialCode: "M-001", name: "伞骨" }, unit: { name: "根" }, supplier: { name: "某某五金厂" }, receipts: [] }],
};

function stub(data: { orders?: unknown } = {}, extra?: (url: string, call: StubbedCall) => Response | undefined) {
  return stubApi((url, call) => {
    const fromExtra = extra?.(url, call);
    if (fromExtra) return fromExtra;
    if (url.startsWith(EP.exportOne)) return new Response(new Uint8Array([0x50, 0x4b]), { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
    if (url === EP.purchaseOrders) return apiOk(data.orders ?? [order]);
    if (url === EP.materials) return apiOk([{ id: "m-1", materialCode: "M-001", name: "伞骨", defaultUnitId: "u-1", isActive: true }]);
    if (url === EP.units) return apiOk([{ id: "u-1", name: "根", isActive: true }]);
    if (url === EP.suppliers) return apiOk([{ id: "s-1", supplierCode: "S-001", name: "某某五金厂", isActive: true }]);
    if (url === EP.salesOrders) return apiOk([]);
    if (url === EP.currencies) return apiOk([{ key: "CNY", label: "人民币", sortOrder: 10 }]);
    return apiOk([]);
  });
}

async function open() {
  render(<><PurchaseOrdersPage /><Toaster /></>);
  await screen.findByTestId("page-procurement-orders");
  await screen.findByText("PO-20260916-0001");
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;

describe("采购单导出：每行都有入口（2026-09-16 之前定义了却没有按钮）", () => {
  it("点「导出」→ 拉单张导出接口并按采购单号命名文件", async () => {
    captureDownloads();
    const calls = stub();
    await open();

    await userEvent.click(screen.getByTestId("order-export-PO-20260916-0001"));

    await waitFor(() => expect(calls.some((call) => call.url.startsWith(EP.exportOne))).toBe(true));
    const exported = calls.find((call) => call.url.startsWith(EP.exportOne))!;
    expect(exported.url).toBe(`${EP.exportOne}?purchase_order_id=po-1`);
    expect(anchorClicks).toHaveLength(1);
    expect(anchorClicks[0].download).toBe("采购订单-PO-20260916-0001.xlsx");
  });

  it("导出失败时给出错误提示，不假装成功", async () => {
    captureDownloads();
    stub({}, (url) => (url.startsWith(EP.exportOne) ? apiErr(500, "REQUEST_ERROR", "导出失败：服务端异常") : undefined));
    await open();

    await userEvent.click(screen.getByTestId("order-export-PO-20260916-0001"));

    await waitFor(() => expect(screen.getByText("导出失败：服务端异常")).toBeVisible());
    expect(anchorClicks).toHaveLength(0);
  });
});

describe("采购单打印信息：付款方式 / 交期条款 / 交货地址 / 回签三格", () => {
  async function openDialog() {
    const calls = stub();
    await open();
    await userEvent.click(screen.getByTestId("order-print-info-PO-20260916-0001"));
    await screen.findByTestId("action-dialog");
    return calls;
  }

  it("弹窗字段齐全，并带出采购单上的现值", async () => {
    await openDialog();

    // 表头/表尾要印的字都要能在这里填
    for (const label of ["付款方式", "交货日期（打印在表头；留空则按明细行日期）", "交期条款", "交货地址", "厂家回签意见（存系统；导出仍留空供手写）", "厂家回签（经办人 / 日期）", "主管签字", "备注"]) {
      expect(screen.getByText(label)).toBeVisible();
    }
    expect(screen.getByTestId("action-field-payment_terms")).toHaveTextContent("月结30天");
    expect(screen.getByTestId("action-field-delivery_address")).toHaveValue("");
    expect(screen.getByTestId("action-field-expected_date")).toHaveValue("2026-09-25");
    expect(screen.getByTestId("action-field-remark")).toHaveValue("含税价");
  });

  it("保存：PATCH 只发这 8 个键，未填的文本发空串、交货日期空发 null", async () => {
    const calls = await openDialog();

    await userEvent.click(screen.getByTestId("action-field-payment_terms"));
    await userEvent.click(await screen.findByRole("option", { name: "月结60天" }));
    await userEvent.type(screen.getByTestId("action-field-delivery_address"), "浙江省绍兴市柯桥区迪礼厂区 1 号仓");
    await userEvent.type(screen.getByTestId("action-field-supplier_signed"), "李经理 2026-09-12");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/purchase-orders/po-1/print-fields"))).toBe(true));
    const patched = calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/purchase-orders/po-1/print-fields")).at(-1)!;
    expect(bodyOf(patched)).toEqual({
      payment_terms: "月结60天",
      delivery_terms: "",
      delivery_address: "浙江省绍兴市柯桥区迪礼厂区 1 号仓",
      expected_date: "2026-09-25",
      remark: "含税价",
      supplier_reply: "",
      supplier_signed: "李经理 2026-09-12",
      supervisor_signature: "",
    });
    // 成功后 ActionDialog 自己关窗
    await waitFor(() => expect(screen.queryByTestId("action-dialog")).toBeNull());
  });

  it("清空付款方式（选「（不填）」）也发得出去：空串表示「清除这一格」", async () => {
    const calls = await openDialog();

    await userEvent.click(screen.getByTestId("action-field-payment_terms"));
    await userEvent.click(await screen.findByRole("option", { name: "（不填）" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/purchase-orders/po-1/print-fields"))).toBe(true));
    const patched = calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/purchase-orders/po-1/print-fields")).at(-1)!;
    expect(bodyOf(patched).payment_terms).toBe("");
  });

  it("保存失败：弹窗保持打开、显示服务端原因，用户填的字还在", async () => {
    const calls = stub({}, (url, call) => (call.method === "PATCH" && url.endsWith("/purchase-orders/po-1/print-fields")
      ? apiErr(422, "PURCHASE_ORDER_NOT_EDITABLE", "已取消的采购单不能修改打印信息")
      : undefined));
    await open();
    await userEvent.click(screen.getByTestId("order-print-info-PO-20260916-0001"));
    await screen.findByTestId("action-dialog");

    await userEvent.type(screen.getByTestId("action-field-delivery_terms"), "合同签订后 15 天内交货");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH" && call.url.endsWith("/purchase-orders/po-1/print-fields"))).toBe(true));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("已取消的采购单不能修改打印信息");
    expect(screen.getByTestId("action-dialog")).toBeVisible();
    expect(screen.getByTestId("action-field-delivery_terms")).toHaveValue("合同签订后 15 天内交货");
  });

  it("任何状态都能填（已下单的单子也显示入口）", async () => {
    stub({ orders: [{ ...order, status: "arrived_complete", extensionData: { arrival_closed: true } }] });
    await open();

    expect(screen.getByTestId("order-print-info-PO-20260916-0001")).toBeEnabled();
    expect(screen.getByTestId("order-export-PO-20260916-0001")).toBeEnabled();
  });
});
