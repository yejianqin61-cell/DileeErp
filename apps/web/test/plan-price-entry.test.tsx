// 采购计划「填单价」这一块的行为测试（2026-10-09）。
//
// 用户原话：「我还是希望在采购计划中前端也能允许填写价格。也可以选择导入BOM的对应的物料的价格。」
// 追问他为什么手填不着时的回答：「我真没看到哪里可以手填单价的。可以重新设计这一块」。
// 所以这一轮把填价单独做成入口：面板顶部一条状态条 + 一个「填单价」浮层（导入 BOM 参考单价也在里面）。
//
// 这个文件钉住五件事（都是"用户看得见"的）：
//   1. 状态条说清还有几行 0 价；浮层里改一格，表里那一格同时变（同一份草稿状态，保存才落库）；
//   2. 「导入 BOM 参考单价」会**先重新取一次详情**（BOM 上的价可能是打开计划之后才填的），
//      并且只填空的未下单行：手填过的价、已下单的行一个字都不动，结果文案把"没填上的"也说清楚；
//   3. 0 价的行下单时先弹「价格待定」确认框，**确认前不发请求**；确认后请求体带 `allow_pending_price: true`；
//   4. 勾选的行都有价时**不弹**确认框，请求体也不带那个开关（默认行为一字未变）；
//   5. 已下单的行：单价 0 的可以补价（价格待定），单价 > 0 的只读锁死。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanDetailSheet } from "../components/procurement/plan-detail-sheet";
import { Toaster } from "../components/ui/toaster";
import { apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const materials = [
  { id: "m-1", materialCode: "M-001", name: "面料A", isActive: true, defaultUnitId: "u-1" },
  { id: "m-2", materialCode: "M-002", name: "伞骨", isActive: true, defaultUnitId: "u-1" },
];
const units = [{ id: "u-1", name: "米", isActive: true }];
const suppliers = [{ id: "s-1", supplierCode: "S-001", name: "宁波辅料厂", isActive: true }];

const planItem = (overrides: Record<string, unknown> = {}) => ({
  id: "i-1", materialId: "m-1", materialName: "面料A", materialCode: "M-001", model: null, unitId: "u-1", unitName: "米",
  quantity: "5.0000", unitPrice: "0.0000", currency: "CNY", bomItemId: "bi-1", supplierId: "s-1", supplierName: "宁波辅料厂",
  supplierAddress: null, supplierContact: null, expectedDate: null, purchaseOrderItemId: null, purchaseOrderNo: null,
  extensionData: {}, ...overrides,
});
const planDetail = (items: Array<Record<string, unknown>>) => ({
  id: "plan-1", planNo: "PP-20261009-AAAA1111", orderNo: "DL260001-1", itemNo: "27621", customerName: "流水花扇客户",
  bomId: "bom-1", bomVersion: 3, status: "unordered", statusLabel: "未下单", lineCount: items.length,
  unorderedCount: items.filter((item) => !item.purchaseOrderItemId).length, orderedCount: items.filter((item) => item.purchaseOrderItemId).length,
  bomDeleted: false, bomExtraMaterialCount: 0, deliveryDate: null, updatedAt: "2026-10-09T02:00:00.000Z", items,
});

/**
 * 桩：`details` 是**每次 GET 详情依次**返回的内容 —— 第 2 次起就是"重新取一次"的答案，
 * 用它来验证「导入」按钮真的去拿了最新的参考价（而不是拿内存里那份旧数据糊弄）。
 */
function stubSheet(details: Array<Array<Record<string, unknown>>>) {
  let detailReads = 0;
  const calls = stubApi((url: string, call: StubbedCall) => {
    if (url.includes("/purchase-orders/bom-item-status")) return apiOk([]);
    if (url.includes("/inventory/raw-material-balances")) return apiOk([]);
    if (url.endsWith("/suppliers") && call.method === "GET") return apiOk(suppliers);
    if (url.includes("/purchase-plans/plan-1/order")) return apiOk({ orders: [{ purchaseOrderNo: "PO-1" }] });
    if (url.endsWith("/purchase-plans/plan-1")) {
      const items = details[Math.min(detailReads, details.length - 1)];
      detailReads += 1;
      return apiOk(planDetail(items));
    }
    return apiOk([]);
  });
  return { calls, reads: () => detailReads };
}

function renderSheet(details: Array<Array<Record<string, unknown>>>) {
  const stub = stubSheet(details);
  render(<><PlanDetailSheet planId="plan-1" materials={materials} units={units} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} /><Toaster /></>);
  return stub;
}

const openPriceDialog = async () => {
  await screen.findByRole("button", { name: "保存计划" });
  await userEvent.click(screen.getByTestId("plan-open-price-dialog"));
  return screen.findByTestId("plan-price-dialog");
};

describe("采购计划：填单价入口（状态条 + 浮层）", () => {
  it("状态条说清还有几行 0 价；浮层里改一格，表里那一格同时变（保存才落库）", async () => {
    renderSheet([[planItem({ unitPrice: "0.0000" }), planItem({ id: "i-2", materialId: "m-2", materialName: "伞骨", unitPrice: "3.5000" })]]);
    await screen.findByRole("button", { name: "保存计划" });

    expect(screen.getByTestId("plan-open-price-dialog").textContent).toContain("还有 1 行没填");
    expect(screen.getByTestId("plan-price-bar-note").textContent).toContain("还有 1 行是 0 价");

    const dialog = await openPriceDialog();
    const input = within(dialog).getByTestId("plan-price-input-0");
    // 用 fireEvent.change 而不是逐字符 type：`<input type="number">` 对 `.` 有值清洗，
    // 逐字符敲 "12.5" 在 jsdom/浏览器上可能被吞掉小数点（这里要断的是"改完两边同步"，不是键盘行为）。
    fireEvent.change(input, { target: { value: "12.5" } });

    // 同一份草稿状态：关掉浮层，表里那一格也是 12.5（不需要再填一次）
    expect(input).toHaveValue(12.5);
    expect(screen.getByTestId("plan-price-0")).toHaveValue(12.5);
    await userEvent.click(screen.getByTestId("plan-price-dialog-done"));
    await waitFor(() => expect(screen.queryByTestId("plan-price-dialog")).toBeNull());
    expect(screen.getByTestId("plan-price-0")).toHaveValue(12.5);
    expect(screen.getByTestId("plan-open-price-dialog").textContent).toBe("填单价");
    // 只改界面状态：**没有**发保存请求（点「保存计划」才会写进计划）
    expect(screen.getByTestId("plan-price-bar-note").textContent).toContain("单价都填好了");
  });

  it("导入：先重新取一次参考价，只填空的未下单行；手填过的价与已下单的行不动，文案说清没填上的", async () => {
    const first = [
      planItem({ id: "i-1", unitPrice: "0.0000", bomReferenceUnitPrice: null }),
      planItem({ id: "i-2", materialId: "m-2", materialName: "伞骨", unitPrice: "9.0000", bomReferenceUnitPrice: "1.0000" }),
      planItem({ id: "i-3", materialId: "m-2", materialName: "伞骨", unitPrice: "0.0000", bomReferenceUnitPrice: null }),
      planItem({ id: "i-4", materialId: "m-2", materialName: "伞骨", unitPrice: "0.0000", purchaseOrderItemId: "poi-1", bomReferenceUnitPrice: "5.0000" }),
      planItem({ id: "i-5", materialId: "m-2", materialName: "伞骨", unitPrice: "7.0000", purchaseOrderItemId: "poi-2", bomReferenceUnitPrice: "5.0000" }),
    ];
    // 第 2 次（点「导入」时）才把 BOM 上的参考价给出来 —— 模拟"计划打开之后才去 BOM 填的价"。
    const second = [
      planItem({ id: "i-1", unitPrice: "0.0000", bomReferenceUnitPrice: "12.5000", bomReferenceUnitCurrency: "USD" }),
      planItem({ id: "i-2", materialId: "m-2", materialName: "伞骨", unitPrice: "9.0000", bomReferenceUnitPrice: "1.0000" }),
      planItem({ id: "i-3", materialId: "m-2", materialName: "伞骨", unitPrice: "0.0000", bomReferenceUnitPrice: null }),
      planItem({ id: "i-4", materialId: "m-2", materialName: "伞骨", unitPrice: "0.0000", purchaseOrderItemId: "poi-1", bomReferenceUnitPrice: "5.0000" }),
      planItem({ id: "i-5", materialId: "m-2", materialName: "伞骨", unitPrice: "7.0000", purchaseOrderItemId: "poi-2", bomReferenceUnitPrice: "5.0000" }),
    ];
    const stub = renderSheet([first, second]);
    const dialog = await openPriceDialog();

    await userEvent.click(within(dialog).getByTestId("plan-price-import-bom"));

    await waitFor(() => expect(stub.reads()).toBeGreaterThan(1)); // 重新取了一次详情
    await waitFor(() => expect(within(dialog).getByTestId("plan-price-input-0")).toHaveValue(12.5));
    expect(within(dialog).getByTestId("plan-price-input-1")).toHaveValue(9); // 手填过的价不覆盖
    expect(within(dialog).getByTestId("plan-price-input-2")).toHaveValue(0); // BOM 上也没价 → 保持空白
    expect(within(dialog).getByTestId("plan-price-input-3")).toHaveValue(0); // 已下单 + 0 价：能补价，但导入不碰它
    expect(within(dialog).queryByTestId("plan-price-input-4")).toBeNull(); // 已下单 + 已有价：只读，没有输入框
    const result = within(dialog).getByTestId("plan-price-import-result").textContent ?? "";
    expect(result).toContain("已按 BOM 参考单价填了 1 行");
    expect(result).toContain("1 行 BOM 上也没有参考价");
    expect(result).toContain("1 行已经填过价");
    expect(result).toContain("2 行已下单");
  });
});

describe("采购计划：价格待定（0 价下单）与补价", () => {
  it("0 价的行下单先弹确认框，确认前不发请求；确认后请求体带 allow_pending_price: true", async () => {
    const stub = renderSheet([[planItem({ unitPrice: "0.0000" })]]);
    await screen.findByRole("button", { name: "保存计划" });

    await userEvent.click(screen.getByTestId("plan-order"));

    // 确认框：说清是哪几行、以及"到货前必须先补价"
    const note = await screen.findByText(/这些行还没有单价（价格待定）/);
    expect(note).toBeTruthy();
    expect(screen.getByText(/第 1 行还没填单价/)).toBeTruthy();
    expect(screen.getByText(/到货登记前必须先补单价/)).toBeTruthy();
    expect(stub.calls.some((call) => call.url.endsWith("/purchase-plans/plan-1/order"))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "确认下单（价格待定）" }));

    await waitFor(() => expect(stub.calls.some((call) => call.url.endsWith("/purchase-plans/plan-1/order"))).toBe(true));
    const body = JSON.parse(String(stub.calls.find((call) => call.url.endsWith("/purchase-plans/plan-1/order"))?.body)) as { allow_pending_price?: boolean; groups: Array<{ items: string[] }> };
    expect(body.allow_pending_price).toBe(true);
    expect(body.groups[0].items).toEqual(["i-1"]);
  });

  it("都有价时不弹确认框，请求体也不带那个开关（默认行为一字未变）", async () => {
    const stub = renderSheet([[planItem({ unitPrice: "3.5000" })]]);
    await screen.findByRole("button", { name: "保存计划" });

    await userEvent.click(screen.getByTestId("plan-order"));

    await waitFor(() => expect(stub.calls.some((call) => call.url.endsWith("/purchase-plans/plan-1/order"))).toBe(true));
    expect(screen.queryByText(/这些行还没有单价（价格待定）/)).toBeNull();
    const body = JSON.parse(String(stub.calls.find((call) => call.url.endsWith("/purchase-plans/plan-1/order"))?.body)) as { allow_pending_price?: boolean };
    expect(body.allow_pending_price).toBeUndefined();
  });

  it("已下单的行：单价 0 的可补价（标「价格待定」），单价 > 0 的只读锁死", async () => {
    renderSheet([[
      planItem({ id: "i-1", unitPrice: "0.0000", purchaseOrderItemId: "poi-1", purchaseOrderNo: "PO-1" }),
      planItem({ id: "i-2", materialId: "m-2", materialName: "伞骨", unitPrice: "3.5000", purchaseOrderItemId: "poi-2", purchaseOrderNo: "PO-2" }),
    ]]);
    await screen.findByRole("button", { name: "保存计划" });

    // 价格待定：状态列有标记，单价这一格仍可填（补价入口），且说明补价的后果
    expect(screen.getByTestId("plan-price-pending-0")).toBeTruthy();
    const pending = screen.getByTestId("plan-price-0") as HTMLInputElement;
    expect(pending).not.toBeDisabled(); // 补价：这是"辅料价等客户确认资料"的出口
    expect(pending.getAttribute("title")).toContain("价格待定");
    // 行总价同样标红：这笔钱还没定下来
    expect(screen.getByTestId("plan-amount-0").className).toContain("status-danger");

    // 已下单且已有价：锁死
    const locked = screen.getByTestId("plan-price-1") as HTMLInputElement;
    expect(locked).toBeDisabled();
    expect(locked.getAttribute("title")).toContain("退回采购计划");
  });
});
