// 行级退回的入口（2026-11-12）。
//
// 用户原话：「下了采购单之后，如果需要临时修改BOM表的一些信息，需要整批采购单全部回退再修改，
// 再下单。说明我们系统的拆分性，回溯性不够灵活。」
//
// 审计 `docs/audit/procurement-audit-2026-11-12.md` §2.1 B4：**已有到货的行连整单退都退不了**，
// 于是"这 100 个只要 80"在系统里说不出口。后端已经有了行级退回（Phase 2），
// 这一组钉的是**界面上够得着**：零到货的行才有按钮，点了能收原因、请求打到对的地方。
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PurchaseOrderDetailPage from "../app/procurement/orders/[id]/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const params = vi.hoisted(() => ({ id: "po-1" }));
vi.mock("next/navigation", () => ({
  useParams: () => params,
  usePathname: () => "/procurement/orders/po-1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

/** 一行零到货（可退）、一行有到货（不可退）。 */
const item = (overrides: Record<string, unknown>) => ({
  id: "poi-1", materialId: "m-1", unitId: "u-1", supplierId: "s-1", expectedDate: null, model: null,
  quantity: "100.0000", material: { materialCode: "M-001", name: "伞布" }, unit: { name: "米" },
  supplier: { name: "绍兴纺织" }, receipts: [], ...overrides,
});

const order = (overrides: Record<string, unknown> = {}) => ({
  id: "po-1", purchaseOrderNo: "PO-20260910-AAAA", orderNo: "DL260001-1", status: "ordered", currency: "CNY",
  totalAmount: "1000.0000", supplier: { name: "绍兴纺织" }, orphaned: false,
  items: [
    item({ id: "poi-1", material: { materialCode: "M-001", name: "伞布" } }),
    item({ id: "poi-2", material: { materialCode: "M-002", name: "伞骨" }, quantity: "200.0000", receipts: [{ id: "gr-1", receiptNo: "GR-1", quantity: "200.0000", extensionsData: {} }] }),
  ],
  ...overrides,
});

function stubDetail(options: { onRevert?: (call: StubbedCall) => Response } = {}) {
  return stubApi((url, call) => {
    if (url.includes("/revert-to-plan") && call.method === "POST") {
      return options.onRevert ? options.onRevert(call) : apiOk({ purchaseOrderNo: "PO-20260910-AAAA", remainingLineCount: 1, orderCancelled: false });
    }
    if (url.includes("/purchase-orders/po-1")) return apiOk(order());
    return apiOk([]);
  });
}

const blocks = () => Array.from(document.querySelectorAll(".purchase-item-block")) as HTMLElement[];

describe("采购单详情：行级退回入口", () => {
  it("只有零到货的那一行出现「退回这一行」（有到货的按下去注定被拒）", async () => {
    stubDetail();
    render(<><PurchaseOrderDetailPage /><Toaster /></>);

    await screen.findByText("PO-20260910-AAAA");
    await waitFor(() => expect(blocks()).toHaveLength(2));

    expect(within(blocks()[0]).getByRole("button", { name: "退回这一行" })).toBeTruthy();
    expect(within(blocks()[1]).queryByRole("button", { name: "退回这一行" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "退回这一行" })).toHaveLength(1);
  });

  it("点它收原因，提交到这一行的行级退回端点（不是整单那个）", async () => {
    const calls = stubDetail();
    render(<><PurchaseOrderDetailPage /><Toaster /></>);
    await screen.findByText("PO-20260910-AAAA");
    await waitFor(() => expect(blocks()).toHaveLength(2));

    await userEvent.click(within(blocks()[0]).getByRole("button", { name: "退回这一行" }));
    await userEvent.type(await screen.findByTestId("action-field-reason"), "客户减量，这一行先不买");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((call) => call.url.includes("/revert-to-plan"))).toBe(true));
    const call = calls.find((candidate) => candidate.url.includes("/revert-to-plan"));
    expect(call?.url).toContain("/purchase-orders/po-1/items/poi-1/revert-to-plan");
    expect(call?.url).not.toMatch(/\/purchase-orders\/po-1\/revert-to-plan$/);
    expect(JSON.parse(String(call?.body))).toEqual({ reason: "客户减量，这一行先不买" });
  });

  it("服务端说这一行不能退（已有到货）时，把那句话显示出来而不是静默失败", async () => {
    stubDetail({ onRevert: () => apiErr(422, "PURCHASE_ORDER_ITEM_NOT_REVERTIBLE", "这一行已经有到货事实，不能退回采购计划") });
    render(<><PurchaseOrderDetailPage /><Toaster /></>);
    await screen.findByText("PO-20260910-AAAA");
    await waitFor(() => expect(blocks()).toHaveLength(2));

    await userEvent.click(within(blocks()[0]).getByRole("button", { name: "退回这一行" }));
    await userEvent.type(await screen.findByTestId("action-field-reason"), "试试");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/已经有到货事实/)).toBeTruthy();
  });
});
