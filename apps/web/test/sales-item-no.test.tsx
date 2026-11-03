// 销售单「货号」字段的前端行为测试（老板 2026-09-26：「每个销售单多一个字段，叫做货号。
// 以后客户返单，从系统里面调取，返单客户货号不变」）。
//
// 钉住三件事：
//   1. 货号输入框**既能挑既有、也能直接输新的**（输新货号不能被建议列表挡住）；
//   2. 空串的语义是「清除货号」（发 null），不是「不动」—— 与 37 个细化标量同一条口径；
//   3. 销售单列表能看出货号、能按货号搜、能筛出「未填货号」的历史单。
//
// 纪律：真实渲染组件 + 真实输入 + 断言渲染出的行为，不 mock 业务模块。
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ItemNoInput, type ItemNoSuggestion } from "../components/sales/item-no-input";
import { SalesOrderEditor } from "../components/sales/sales-order-editor";
import SalesOrdersList from "../components/sales/sales-orders-list";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi } from "./helpers/api-stub";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const suggestions = [
  { item_no: "27621 流水花扇", item_no_key: "27621流水花扇", order_count: 5 },
  { item_no: "27621", item_no_key: "27621", order_count: 3 },
  { item_no: "DL27621", item_no_key: "DL27621", order_count: 1 },
];

const box = () => screen.getByTestId("sales-base-item_no");

/**
 * 受控壳：`ItemNoInput` 是纯受控组件（值由父组件持有），所以「输入后框里有没有这个字」
 * 必须由一个真的持有 state 的父组件来验证 —— 直接 render 一个 `onChange={() => {}}`
 * 的桩只会看到永远为空的框，测出来的是测试自己的问题。
 */
function Controlled({ initial = "", suggestions: items = suggestions, onChange }: { initial?: string; suggestions?: ItemNoSuggestion[]; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return <ItemNoInput value={value} onChange={(next) => { setValue(next); onChange?.(next); }} suggestions={items} />;
}

// ------------------------------------------------------------------ 输入框本身

describe("货号输入框：可挑可输", () => {
  it("聚焦就列出既有货号，带上「几单」，并按单数降序（服务端已排序）", async () => {
    render(<ItemNoInput value="" onChange={() => {}} suggestions={suggestions} />);
    await userEvent.click(box());
    const options = screen.getAllByTestId("item-no-suggestion");
    expect(options.map((option) => option.textContent)).toEqual(["27621 流水花扇5 单", "276213 单", "DL276211 单"]);
  });

  it("过滤用**包含**匹配（输 27621 会连 DL27621 一起列出）——与服务端 q 的语义一致", async () => {
    render(<ItemNoInput value="" onChange={() => {}} suggestions={suggestions} />);
    await userEvent.type(box(), "27621");
    const options = screen.getAllByTestId("item-no-suggestion").map((option) => option.textContent);
    // 三条都含 "27621"：流水花扇（单数最多，排最前）、27621 本身、DL27621。
    // 包含匹配是有意的：货号常常只记得尾巴；要精确找一个货号请直接输完整值。
    expect(options).toHaveLength(3);
    expect(options[0]).toContain("流水花扇");
    expect(options.some((text) => text?.startsWith("DL27621"))).toBe(true);
  });

  it("全角/大小写差异也算同一个货号：输全角空格能命中原值", async () => {
    render(<ItemNoInput value="" onChange={() => {}} suggestions={[{ item_no: "27621\u3000流水花扇", item_no_key: "27621流水花扇", order_count: 2 }]} />);
    await userEvent.type(box(), "27621 流水");
    expect(screen.getAllByTestId("item-no-suggestion")).toHaveLength(1);
  });

  it("选中建议时**原样写入原值**（不写匹配键、不改大小写）", async () => {
    const onChange = vi.fn();
    render(<ItemNoInput value="" onChange={onChange} suggestions={suggestions} />);
    await userEvent.click(box());
    await userEvent.click(screen.getAllByTestId("item-no-suggestion")[0]);
    expect(onChange).toHaveBeenCalledWith("27621 流水花扇");
  });

  it("系统里没有的货号照常输入，并明确告知「将新建一个」", async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    await userEvent.type(box(), "NEW-9527");
    expect(box()).toHaveValue("NEW-9527");
    expect(screen.getByTestId("item-no-suggestions-empty")).toHaveTextContent("系统里还没有这个货号，将新建一个");
    // 没有高亮项时按 Enter 不该被「替换成建议」——那是输新货号最常见的误伤。
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("NEW-9527");
  });

  it("键盘：↓ 高亮、Enter 采用；Esc 关掉列表但不改值", async () => {
    const onChange = vi.fn();
    render(<ItemNoInput value="" onChange={onChange} suggestions={suggestions} />);
    await userEvent.click(box());
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("27621");
    await userEvent.click(box());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("item-no-suggestions")).toBeNull();
  });

  it("候选再多也只列 8 条，不会把页面顶下去", async () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ item_no: `A-${index}`, item_no_key: `A-${index}`, order_count: 1 }));
    render(<ItemNoInput value="" onChange={() => {}} suggestions={many} />);
    await userEvent.click(box());
    expect(screen.getAllByTestId("item-no-suggestion")).toHaveLength(8);
  });
});

// ------------------------------------------------------------------ 编辑器

const customer = { id: "customer-1", customerCode: "C001", name: "家百纳", isActive: true, currency: "USD", contacts: [] };
const units = [{ id: "unit-1", name: "支" }];

/** 编辑态的行：接口给的是 Prisma **列名**（`itemNo`），货号必须能回填到输入框。 */
const existingOrder = {
  id: "order-1", orderNo: "DL260134", status: "draft", itemNo: "27621 流水花扇", customer: { id: "customer-1" }, contact: null,
  productName: "三折伞", quantity: "1960", unit: "支", currency: "USD", orderDate: "2026-06-18T00:00:00.000Z",
  specDetails: [], materialRefs: [], boms: [], versions: [],
};

function stubEditor(handlers: Record<string, () => Response> = {}) {
  return stubApi((url) => {
    for (const [fragment, handler] of Object.entries(handlers)) if (url.includes(fragment)) return handler();
    if (url.includes("/customers")) return apiOk([customer]);
    if (url.includes("/units")) return apiOk(units);
    if (url.includes("/dictionaries/currency/items")) return apiOk({ data: [] });
    // 建议接口要排在销售单详情之前：`/sales-orders/item-nos` 也包含 `/sales-orders`。
    if (url.includes("/sales-orders/item-nos")) return apiOk(suggestions);
    if (url.includes("/sales-orders/order-1")) return apiOk(existingOrder);
    if (url.includes("/materials")) return apiOk([]);
    return apiOk({});
  });
}

describe("销售单编辑器：货号字段", () => {
  it("基本信息里有货号输入框，建议来自 /sales-orders/item-nos", async () => {
    const calls = stubEditor();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    expect(box()).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.url.includes("/sales-orders/item-nos"))).toBe(true));
    await userEvent.click(box());
    expect(screen.getAllByTestId("item-no-suggestion")).toHaveLength(3);
  });

  it("保存时把货号发出去（新建）", async () => {
    const calls = stubEditor();
    render(<SalesOrderEditor />);
    await screen.findByText("材料明细");
    fireEvent.change(screen.getByTestId("sales-base-order_no"), { target: { value: "DL260134" } });
    fireEvent.change(screen.getByTestId("sales-base-product_name"), { target: { value: "三折伞" } });
    fireEvent.change(screen.getByTestId("sales-base-quantity"), { target: { value: "1960" } });
    fireEvent.change(box(), { target: { value: "27621 流水花扇" } });
    await pickSelect("sales-base-customer_id", "C001");
    await pickSelect("sales-base-unit", "支");
    await pickSelect("sales-base-currency", "美元");
    await userEvent.click(screen.getByTestId("sales-order-save"));
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/sales-orders"))).toBe(true));
    const posted = calls.find((call) => call.method === "POST" && call.url.endsWith("/sales-orders"));
    expect(JSON.parse(String(posted?.body)).item_no).toBe("27621 流水花扇");
  });

  it("把货号删空后保存 → 发 null（清除），不是「不动」", async () => {
    const calls = stubEditor();
    render(<SalesOrderEditor orderId="order-1" />);
    await screen.findByText("材料明细");
    // 编辑态：接口返回的行带 itemNo（Prisma 列名），货号必须能回填
    await waitFor(() => expect(box()).toHaveValue("27621 流水花扇"));
    fireEvent.change(box(), { target: { value: "  " } });
    await userEvent.click(screen.getByTestId("sales-order-save"));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const patched = calls.find((call) => call.method === "PATCH");
    expect(JSON.parse(String(patched?.body)).item_no).toBeNull();
  });
});

// ------------------------------------------------------------------ 销售单列表

const orderRow = (overrides: Record<string, unknown>) => ({
  id: "order-1", orderNo: "DL260001-1", itemNo: "27621", productName: "三折伞", quantity: "1960", unit: "支",
  status: "confirmed", customer: { id: "customer-1", name: "FLOWER1" }, boms: [], createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z", createdBy: "u-1", updatedBy: "u-1", ...overrides,
});

async function openSales(orders: unknown[]) {
  stubApi((url) => {
    if (url.includes("/sales-orders/finished-goods-summary")) return apiOk({ production_order_count: 0, groups: [] });
    if (url.includes("/sales-orders?")) return apiOk(orders);
    if (url.includes("/customers")) return apiOk([]);
    if (url.includes("/units")) return apiOk([]);
    if (url.includes("/dictionaries/currency/items")) return apiOk({ data: [] });
    return apiOk([]);
  });
  render(<SalesOrdersList />);
  await screen.findByTestId("page-sales-orders");
}

const bodyRows = () => screen.queryAllByRole("row").map((row) => within(row).queryAllByRole("cell").map((cell) => cell.textContent ?? "").join(" | "));

describe("销售单列表：货号列、搜索与筛选", () => {
  it("列出货号；未填货号的历史单显示 -", async () => {
    await openSales([orderRow({}), orderRow({ id: "order-2", orderNo: "DL260002-1", itemNo: null })]);
    await waitFor(() => expect(screen.getByText("DL260001-1")).toBeTruthy());
    const rows = bodyRows();
    expect(rows.some((row) => row.includes("27621"))).toBe(true);
    expect(rows.some((row) => row.includes("DL260002-1") && row.includes("-"))).toBe(true);
  });

  it("搜索框能按货号命中（现场常常只记得货号）", async () => {
    await openSales([orderRow({}), orderRow({ id: "order-2", orderNo: "DL260002-1", itemNo: "88001" })]);
    await waitFor(() => expect(screen.getByText("DL260001-1")).toBeTruthy());
    const search = screen.getByPlaceholderText("输入关键词");
    await userEvent.type(search, "88001");
    await waitFor(() => expect(screen.queryByText("DL260001-1")).toBeNull());
    expect(screen.getByText("DL260002-1")).toBeTruthy();
  });

  it("「未填货号」筛选只留没填货号的单（历史单补录的入口）", async () => {
    await openSales([orderRow({}), orderRow({ id: "order-2", orderNo: "DL260002-1", itemNo: null })]);
    await waitFor(() => expect(screen.getByText("DL260001-1")).toBeTruthy());
    await pickSelect("sales-item-no-filter", "未填货号");
    await waitFor(() => expect(screen.queryByText("DL260001-1")).toBeNull());
    expect(screen.getByText("DL260002-1")).toBeTruthy();

    await pickSelect("sales-item-no-filter", "仅填了货号");
    await waitFor(() => expect(screen.queryByText("DL260002-1")).toBeNull());
    expect(screen.getByText("DL260001-1")).toBeTruthy();
  });
});

/** Radix Select：点开触发器再点选项（与 sales-order-editor.test.tsx 同一套动作）。 */
async function pickSelect(testid: string, optionText: string) {
  await userEvent.click(screen.getByTestId(testid));
  await userEvent.click(await screen.findByRole("option", { name: new RegExp(optionText) }));
}

// ------------------------------------------------------------------ 删除销售单（2026-11-03 改口径）
//
// 2026-10-01 那版是「只有草稿能删、不弹确认框不要原因」；2026-11-03 用户改口径：
// 「对应的采购单及其后续绑定的单据不删，而是显示孤立单据」——删除对所有状态开放，
// 删之前先预览会留下哪些下游单据，非草稿必须填原因。
// 确认框的内容 / 必填原因 / 孤立计数留在 sales-order-delete.test.tsx，这里只钉列表侧：
// 每个状态都有入口、先预览再删、预览失败不误删。
describe("销售单列表：删除入口对所有状态开放（2026-11-03）", () => {
  const previewOf = (overrides: Record<string, unknown> = {}) => ({
    sales_order_id: "order-1", order_no: "DL260001-1", status: "draft", reason_required: false, downstream: [], downstream_total: 0, ...overrides,
  });
  async function openWithToaster(orders: unknown[], preview: () => Response = () => apiOk(previewOf()), onDelete?: () => Response) {
    const calls = stubApi((url, call) => {
      if (url.includes("/sales-orders/finished-goods-summary")) return apiOk({ production_order_count: 0, groups: [] });
      if (url.includes("/delete-preview")) return preview();
      if (url.includes("/sales-orders?")) return apiOk(orders);
      if (call.method === "DELETE") return onDelete ? onDelete() : apiOk({ id: "order-1" });
      return apiOk([]);
    });
    render(<><SalesOrdersList /><Toaster /></>);
    await screen.findByTestId("page-sales-orders");
    return calls;
  }

  it("草稿、已确认、已关闭的行都有「删除」", async () => {
    await openWithToaster([orderRow({ status: "draft" }), orderRow({ id: "order-2", orderNo: "DL260002-1", status: "confirmed" }), orderRow({ id: "order-3", orderNo: "DL260003-1", status: "closed" })]);
    await waitFor(() => expect(screen.getByTestId("order-delete-DL260001-1")).toBeTruthy());
    expect(screen.getByTestId("order-delete-DL260002-1")).toBeTruthy();
    expect(screen.getByTestId("order-delete-DL260003-1")).toBeTruthy();
  });

  it("草稿：先读影响面再弹确认框（不要求原因），确认后发 DELETE 并重新拉列表", async () => {
    const calls = await openWithToaster([orderRow({ status: "draft" })]);
    await waitFor(() => expect(screen.getByTestId("order-delete-DL260001-1")).toBeTruthy());
    await userEvent.click(screen.getByTestId("order-delete-DL260001-1"));
    // 点删除只是预览，**不会立刻删**：确认框出现之前不该有 DELETE。
    expect(await screen.findByTestId("action-dialog")).toBeVisible();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(within(screen.getByTestId("action-dialog")).queryByTestId("action-field-reason")).toBeNull();
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
    const deleted = calls.find((call) => call.method === "DELETE");
    expect(deleted?.url.endsWith("/sales-orders/order-1")).toBe(true);
    // 草稿不填原因：body 里没有 reason（不是空串，而是整个 body 都不带）。
    expect(deleted?.body).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已删除销售单 DL260001-1"))).toBe(true));
    // 删完必须重新取列表：否则被删的单还留在屏幕上，用户会以为没删掉。
    await waitFor(() => expect(calls.filter((call) => call.method === "GET" && call.url.includes("/sales-orders?")).length).toBeGreaterThanOrEqual(2));
  });

  it("预览失败时把原因 toast 出来，也不发 DELETE（不能因为问不到就直接删）", async () => {
    const calls = await openWithToaster([orderRow({ status: "draft" })], () => apiErr(404, "SALES_ORDER_NOT_FOUND", "销售单已删除或不存在，请刷新后重试"));
    await waitFor(() => expect(screen.getByTestId("order-delete-DL260001-1")).toBeTruthy());
    await userEvent.click(screen.getByTestId("order-delete-DL260001-1"));
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已删除或不存在"))).toBe(true));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

