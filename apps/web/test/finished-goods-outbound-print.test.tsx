// 成品出库单「打印 / 导出 Excel」（用户 2026-11-02：「针对系统中的出库单，要支持导出 excel，支持打印」）。
//
// 本文件钉住四件事：
//   ① 成品出库单表每行都有「出库单」（打印）与「导出」两个入口；
//   ② 打印弹窗里是**纸面版式**（标题带状态、单号、客户、数量、签字栏），数据来自 slip-document；
//   ③ 「打印 / 另存 PDF」走浏览器打印（window.print），打印时只留这张纸（CSS 有守卫，见 globals.css）；
//   ④ 「导出」打到 `.../export.xlsx` 并提示已导出（下载走 fetch + blob，不新开窗口）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FinishedGoodsStoragePage from "../app/warehouse/finished-goods-storage/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const printSpy = vi.fn();
beforeEach(() => {
  printSpy.mockClear();
  Object.defineProperty(window, "print", { value: printSpy, writable: true, configurable: true });
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:xlsx"), writable: true, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true, configurable: true });
});

const draftOutbound = {
  id: "ob-1",
  outboundNo: "FGO-1",
  orderNo: "DL260134",
  quantity: "60",
  status: "draft",
  productNameSnapshot: "连衣裙",
  productSpecificationSnapshot: "M",
  shipmentDate: null,
  carrier: null,
  trackingNo: null,
  packingListNo: null,
  invoiceNo: null,
  unit: { name: "件" },
  salesOrder: { currency: "USD", unitPrice: "10", settlementUnitPrice: null, customer: { name: "客户A" } },
  outboundNotice: { id: "n-1", noticeNo: "OGN-1", status: "outbound_created" },
};

/** slip-document：与后端 `buildDocument` 同形的打印件数据。 */
const slipDocument = {
  outboundNo: "FGO-1",
  status: "draft",
  statusLabel: "待出库",
  orderNo: "DL260134",
  customerName: "客户A",
  productName: "连衣裙",
  productSpecification: "M",
  implementationOrderNo: "MO-1",
  outboundNoticeNo: "OGN-1",
  outboundDate: "2026-11-02",
  quantity: "60",
  unitName: "件",
  shipmentDate: "",
  carrier: "",
  trackingNo: "",
  packingListNo: "",
  invoiceNo: "",
  signedDate: "",
  signatureReference: "",
  remark: "分两车",
  riskReason: "",
  makerName: "张三",
  printedAt: "2026-11-02 10:00:00",
};

function stubPageApi(overrides: { slipDocument?: () => Response | Promise<Response>; exportXlsx?: () => Response | Promise<Response> } = {}) {
  return stubApi((url, call: StubbedCall) => {
    if (url.endsWith("/slip-document")) return overrides.slipDocument?.() ?? apiOk(slipDocument);
    if (url.endsWith("/export.xlsx")) return overrides.exportXlsx?.() ?? new Response("xlsx-bytes", { status: 200 });
    if (url.includes("/finished-goods/outbounds")) return apiOk([draftOutbound]);
    if (url.includes("/inventory/balances")) return apiOk([]);
    if (url.includes("/finished-goods/")) return apiOk([]);
    return apiErr(404, "NOT_FOUND", `未打桩的请求：${call.method} ${url}`);
  });
}

async function renderPage(overrides = {}) {
  const calls = stubPageApi(overrides);
  render(<><Toaster /><FinishedGoodsStoragePage /></>);
  await screen.findByRole("heading", { name: "成品出库单" });
  return calls;
}

const outboundRow = () => {
  const row = screen.getByText("FGO-1").closest('[data-testid="data-table-row"]');
  if (!row) throw new Error("没有找到成品出库单行 FGO-1");
  return within(row as HTMLElement);
};

describe("成品出库单：打印与导出", () => {
  it("每行都有「出库单」与「导出」入口", async () => {
    await renderPage();
    await screen.findByText("FGO-1");
    expect(outboundRow().getByRole("button", { name: "出库单" })).toBeEnabled();
    expect(outboundRow().getByRole("button", { name: "导出" })).toBeEnabled();
  });

  it("「出库单」打开纸面版式：标题带状态、单号/客户/数量/签字栏都在；点打印调 window.print", async () => {
    await renderPage();
    await screen.findByText("FGO-1");
    await userEvent.click(outboundRow().getByRole("button", { name: "出库单" }));

    const dialog = await screen.findByTestId("outbound-slip-dialog");
    const sheet = await within(dialog).findByTestId("outbound-slip-sheet");
    expect(within(sheet).getByRole("heading", { name: "成品出库单（待出库）" })).toBeVisible();
    expect(within(sheet).getByTestId("outbound-slip-no")).toHaveTextContent("FGO-1");
    expect(sheet).toHaveTextContent("客户A");
    expect(within(sheet).getByTestId("outbound-slip-quantity")).toHaveTextContent("60 件");
    expect(sheet).toHaveTextContent("仓库经办：");
    expect(sheet).toHaveTextContent("制单：张三");

    await userEvent.click(within(dialog).getByTestId("outbound-slip-print"));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it("「导出」打到 export.xlsx 并提示已导出（blob 下载，不新开窗口）", async () => {
    const calls = await renderPage();
    await screen.findByText("FGO-1");
    await userEvent.click(outboundRow().getByRole("button", { name: "导出" }));

    await waitFor(() => expect(callsTo(calls, "/finished-goods/outbounds/ob-1/export.xlsx")).toHaveLength(1));
    expect(callsTo(calls, "/finished-goods/outbounds/ob-1/export.xlsx")[0].method).toBe("GET");
    expect(await screen.findByText("出库单 FGO-1 已导出")).toBeVisible();
  });

  it("打印数据取不到：错误留在弹窗里（不显示空纸）", async () => {
    await renderPage({ slipDocument: () => apiErr(404, "FINISHED_GOODS_OUTBOUND_NOT_FOUND", "成品出库单不存在") });
    await screen.findByText("FGO-1");
    await userEvent.click(outboundRow().getByRole("button", { name: "出库单" }));
    const dialog = await screen.findByTestId("outbound-slip-dialog");
    expect(await within(dialog).findByText("成品出库单不存在")).toBeVisible();
    expect(screen.queryByTestId("outbound-slip-sheet")).toBeNull();
  });
});
