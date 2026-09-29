// 采购单页瘦身之后的行为（2026-09-27，口径 11）。
//
// 用户原话：「采购单模块就是所有已经经过供应商收束下单的采购单了。」
//
// 这一页原来那套「草稿工作区」（新建采购单 → 带入 BOM 明细 → 逐行填供应商 → 保存草稿 / 收束下单）
// 整体搬去了 `/procurement/plans`。本文件钉住搬运之后**这一页还剩下什么**：
//   1. 出去的东西**真的不在了**：新建采购单、草稿筛选 tab、编辑明细、下单；
//   2. **退回采购计划**在：弹窗必填原因 → `POST /purchase-orders/:id/revert-to-plan`；
//   3. 打印信息 / 导出 / 到货跟踪还在（那三样另有专测，见 procurement-order-print.test.tsx）。
//
// 为什么"出去的东西不在了"值得单独钉：留着入口就是给死代码续命 —— 点下去必然 404/422，
// 而用户会以为是系统坏了。
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PurchaseOrdersPage from "../app/procurement/orders/page";
import { apiOk, stubApi } from "./helpers/api-stub";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/procurement/orders",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

const order = (overrides: Record<string, unknown> = {}) => ({
  id: "po-1", purchaseOrderNo: "PO-1", orderNo: "DL260001-1", status: "ordered", currency: "CNY", totalAmount: "10.0000",
  supplier: { name: "某某五金厂" }, items: [{ id: "poi-1", materialId: "m-1", quantity: "5", unit: { name: "个" }, receipts: [] }],
  createdAt: "2026-09-10T01:20:00Z", updatedAt: "2026-09-10T02:40:00Z", createdBy: "u-1", updatedBy: "u-1",
  ...overrides,
});

describe("采购单页：瘦身之后只剩凭证层的事", () => {
  it("出去的东西真的不在了：没有新建采购单、没有草稿 tab、没有编辑/下单", async () => {
    stubApi(() => apiOk([order()]));
    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-1");

    expect(screen.queryByRole("button", { name: "新建采购单" })).toBeNull();
    expect(screen.queryByTestId("order-status-draft")).toBeNull();
    expect(screen.queryByTestId("order-edit-PO-1")).toBeNull();
    expect(screen.queryByTestId("purchase-save-draft")).toBeNull();
    expect(screen.queryByTestId("purchase-save-order")).toBeNull();
  });

  it("退回采购计划：必填原因，提交到 revert-to-plan（供应商做不了的出口）", async () => {
    const calls = stubApi((url) => (url.includes("revert-to-plan") ? apiOk({ purchaseOrderNo: "PO-1" }) : apiOk([order()])));
    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-1");

    await userEvent.click(screen.getByTestId("order-revert-to-plan-PO-1"));
    expect(await screen.findByTestId("action-dialog")).toBeVisible();
    // 原因必填：不填就提交，弹窗自己拦下来（不发请求）
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写退回原因");
    expect(calls.some((call) => call.url.includes("revert-to-plan"))).toBe(false);

    await userEvent.type(screen.getByTestId("action-field-reason"), "供应商说这批做不了");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/purchase-orders/po-1/revert-to-plan"))).toBe(true));
  });

  it("已有到货事实的单不给「退回采购计划」入口（要改内容走质检/退货那条线）", async () => {
    stubApi(() => apiOk([order({ status: "partially_arrived", items: [{ id: "poi-1", materialId: "m-1", quantity: "5", unit: { name: "个" }, receipts: [{ id: "gr-1", receiptNo: "GR-1", quantity: "2" }] }] })]));
    render(<PurchaseOrdersPage />);
    await screen.findByText("PO-1");

    expect(screen.queryByTestId("order-revert-to-plan-PO-1")).toBeNull();
    // 但到货跟踪与打印信息照旧在
    expect(screen.getByRole("link", { name: "到货跟踪" })).toBeTruthy();
    expect(screen.getByTestId("order-print-info-PO-1")).toBeTruthy();
  });
});
