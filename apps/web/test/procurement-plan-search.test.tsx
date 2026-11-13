// 采购计划里的两处表内搜索（2026-11-13）。
//
// 用户原话：「通览整个项目，统计所有下拉列表，所有表单是否都有搜索功能搜索框，如果没有，都需要加上搜索功能。
// 因为现在单子多了，查找比较麻烦。」口径确认过：**列表页/表格都要能搜**，语义全站只有一份
// （`lib/fuzzy-search.ts` 的 `fuzzyMatch`：空格分词 AND、忽略大小写与空白、空查询不过滤）。
//
// 这一个文件钉住计划模块的那两处，重点**不是"能筛出几行"**，而是那条别的列表页没有的约束：
// 这两张表都是**可编辑的草稿表**，行由原始下标认领（`updateRow(index)`、`plan-price-${index}`、
// `plan-price-input-${index}`）。过滤只能改"渲染哪几行"，绝不能重新编号 ——
// 否则过滤状态下改「第 3 行」的单价会落进另一行，而那要等点「保存计划」之后才会发现。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanDetailSheet } from "../components/procurement/plan-detail-sheet";
import { Toaster } from "../components/ui/toaster";
import { apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const materials = [
  { id: "m-1", materialCode: "M-001", name: "面料A", isActive: true, defaultUnitId: "u-1" },
  { id: "m-2", materialCode: "M-002", name: "伞骨", isActive: true, defaultUnitId: "u-1" },
  { id: "m-3", materialCode: "M-003", name: "拉链", isActive: true, defaultUnitId: "u-1" },
];
const units = [{ id: "u-1", name: "米", isActive: true }];
const suppliers = [
  { id: "s-1", supplierCode: "S-001", name: "宁波辅料厂", contactName: "张伟", phone: "13800000000", isActive: true },
  { id: "s-2", supplierCode: "S-002", name: "绍兴纺织", isActive: true },
];

const planItem = (overrides: Record<string, unknown> = {}) => ({
  id: "i-1", materialId: "m-1", materialName: "面料A", materialCode: "M-001", model: "A-1", unitId: "u-1", unitName: "米",
  quantity: "5.0000", unitPrice: "3.5000", currency: "CNY", bomItemId: "bi-1", supplierId: "s-1", supplierName: "宁波辅料厂",
  supplierAddress: null, supplierContact: null, expectedDate: null, purchaseOrderItemId: null, purchaseOrderNo: null,
  extensionData: {}, ...overrides,
});
const planDetail = (items: Array<Record<string, unknown>>) => ({
  id: "plan-1", planNo: "PP-20261113-AAAA1111", orderNo: "DL260001-1", itemNo: "27621", customerName: "流水花扇客户",
  bomId: "bom-1", bomVersion: 3, status: "unordered", statusLabel: "未下单", lineCount: items.length,
  unorderedCount: items.filter((item) => !item.purchaseOrderItemId).length, orderedCount: items.filter((item) => item.purchaseOrderItemId).length,
  bomDeleted: false, bomExtraMaterialCount: 0, deliveryDate: null, updatedAt: "2026-11-13T02:00:00.000Z", items,
});

/** 三行明细：搜索用「伞骨」能正好收窄到中间那一行（原始下标 1）。 */
const threeRows = () => [
  planItem({ id: "i-1", materialName: "面料A", materialCode: "M-001", model: "A-1", unitPrice: "3.5000" }),
  planItem({ id: "i-2", materialId: "m-2", materialName: "伞骨", materialCode: "M-002", model: "B-2", unitPrice: "1.0000", supplierId: "s-2" }),
  planItem({ id: "i-3", materialId: "m-3", materialName: "拉链", materialCode: "M-003", model: "C-3", unitPrice: "2.0000", supplierId: null }),
];

function stubSheet(items: Array<Record<string, unknown>>) {
  return stubApi((url: string, call: StubbedCall) => {
    if (url.includes("/purchase-orders/bom-item-status")) return apiOk([]);
    if (url.includes("/inventory/raw-material-balances")) return apiOk([]);
    if (url.endsWith("/suppliers") && call.method === "GET") return apiOk(suppliers);
    if (url.includes("/purchase-plans/plan-1") && call.method === "PATCH") return apiOk(planDetail(items));
    if (url.includes("/purchase-plans/plan-1/order")) return apiOk({ orders: [{ purchaseOrderNo: "PO-1" }] });
    if (url.endsWith("/purchase-plans/plan-1")) return apiOk(planDetail(items));
    return apiOk([]);
  });
}

function renderSheet(items: Array<Record<string, unknown>>) {
  const calls = stubSheet(items);
  render(<><PlanDetailSheet planId="plan-1" materials={materials} units={units} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} /><Toaster /></>);
  return calls;
}

const openPriceDialog = async () => {
  await screen.findByRole("button", { name: "保存计划" });
  await userEvent.click(screen.getByTestId("plan-open-price-dialog"));
  return screen.findByTestId("plan-price-dialog");
};

describe("采购计划明细行：表内搜索（2026-11-13）", () => {
  it("按物料名收窄表格并给「筛选后 N / M 行」计数，且明确说勾选/合计/下单仍按全部行算", async () => {
    renderSheet(threeRows());
    await screen.findByRole("button", { name: "保存计划" });
    expect(screen.getByTestId("plan-row-0")).toBeTruthy();

    await userEvent.type(screen.getByTestId("plan-detail-search"), "伞骨");

    expect(screen.getByTestId("plan-row-1")).toBeTruthy();
    expect(screen.queryByTestId("plan-row-0")).toBeNull();
    expect(screen.queryByTestId("plan-row-2")).toBeNull();
    const count = screen.getByTestId("plan-detail-count");
    expect(count).toHaveTextContent("筛选后 1 / 3 行");
    // 过滤只改显示：这句话是防止"以为只会下 1 行的单"的唯一提示，不能省
    expect(count).toHaveTextContent("勾选、合计与收束下单仍按全部 3 行算");
    // 计划合计那一行照旧按全部行算（3 行）
    expect(screen.getByTestId("plan-total")).toHaveTextContent("（3 行）");
  });

  /**
   * 这一条是本次改动最该被钉住的行为：**过滤后仍按原始下标认行**。
   *
   * 过滤掉第 1、3 行之后表里只剩一条可见行；如果实现里按"过滤后的序号"渲染（0），
   * 那么给这一格填的价会写进第 1 行（面料A），而屏幕上看起来它写的是伞骨 ——
   * 保存之后才发现改错，且没有任何报错。请求体是唯一能证明"改对了行"的地方。
   */
  it("过滤后改价仍落在原始那一行：先筛到「伞骨」，填价后请求体里变的是第 2 行", async () => {
    const calls = renderSheet(threeRows());
    await screen.findByRole("button", { name: "保存计划" });

    await userEvent.type(screen.getByTestId("plan-detail-search"), "伞骨");
    const visibleRow = screen.getByTestId("plan-row-1");
    expect(screen.queryByTestId("plan-row-0")).toBeNull();

    const price = within(visibleRow).getByTestId("plan-price-1");
    await userEvent.clear(price);
    await userEvent.type(price, "7");
    await userEvent.click(screen.getByRole("button", { name: "保存计划" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const body = JSON.parse(String(calls.find((call) => call.method === "PATCH")?.body)) as { items: Array<{ id: string; unit_price: string }> };
    // 三行都还在请求里（过滤不会把行从保存里删掉），只有第 2 行的价变了
    expect(body.items).toHaveLength(3);
    expect(body.items.map((item) => item.id)).toEqual(["i-1", "i-2", "i-3"]);
    expect(body.items.map((item) => item.unit_price)).toEqual(["3.5", "7", "2"]);
  });

  it("也能按供应商名、采购单号、单价与型号搜到（不只是物料名）", async () => {
    renderSheet([
      planItem({ id: "i-1", materialName: "面料A", supplierId: "s-1" }),
      planItem({ id: "i-2", materialId: "m-2", materialName: "伞骨", materialCode: "M-002", model: "B-2", unitPrice: "1.0000", supplierId: "s-2" }),
    ]);
    await screen.findByRole("button", { name: "保存计划" });

    const search = screen.getByTestId("plan-detail-search");
    await userEvent.type(search, "绍兴");
    expect(screen.queryByTestId("plan-row-0")).toBeNull();
    expect(screen.getByTestId("plan-row-1")).toBeTruthy();

    await userEvent.clear(search);
    await userEvent.type(search, "B-2");
    expect(screen.getByTestId("plan-row-1")).toBeTruthy();
    expect(screen.queryByTestId("plan-row-0")).toBeNull();
  });

  it("不匹配时说「没有匹配」并把全量行数说出来，而不是装作这份计划是空的", async () => {
    renderSheet(threeRows());
    await screen.findByRole("button", { name: "保存计划" });

    await userEvent.type(screen.getByTestId("plan-detail-search"), "查无此料");

    const empty = screen.getByTestId("plan-detail-search-empty");
    expect(empty).toHaveTextContent("没有匹配“查无此料”的明细行");
    expect(empty).toHaveTextContent("这份计划共 3 行");
    // 表头还在（14 列没有因为筛空而消失）
    expect(screen.getAllByRole("columnheader")).toHaveLength(14);
  });

  it("本来就一行都没有时说「这份计划还没有明细行」，与搜空分开", async () => {
    renderSheet([]);
    await screen.findByRole("button", { name: "保存计划" });

    expect(screen.getByTestId("plan-detail-blank")).toHaveTextContent("这份计划还没有明细行");
    // 没有查询时不该出现计数与清除按钮
    expect(screen.queryByTestId("plan-detail-count")).toBeNull();
    // 空表不能把「添加行」藏掉：它是这份计划唯一的出口
    expect(screen.getByTestId("plan-add-row")).toBeTruthy();
  });

  it("「清除搜索」把表恢复成全量，计数与按钮一起消失", async () => {
    renderSheet(threeRows());
    await screen.findByRole("button", { name: "保存计划" });

    await userEvent.type(screen.getByTestId("plan-detail-search"), "伞骨");
    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));

    expect(screen.getByTestId("plan-row-0")).toBeTruthy();
    expect(screen.getByTestId("plan-row-1")).toBeTruthy();
    expect(screen.getByTestId("plan-row-2")).toBeTruthy();
    expect(screen.queryByTestId("plan-detail-count")).toBeNull();
  });
});

describe("填单价浮层：表内搜索（2026-11-13）", () => {
  it("筛到一行时「行」那一列显示的还是原始行号，「还有 N 行没填」仍按全部行算", async () => {
    renderSheet([
      planItem({ id: "i-1", materialName: "面料A", unitPrice: "0.0000" }),
      planItem({ id: "i-2", materialId: "m-2", materialName: "伞骨", materialCode: "M-002", unitPrice: "3.5000" }),
    ]);
    const dialog = await openPriceDialog();
    // 两行里只有 1 行是 0 价（这一句不跟着过滤变，它答的是"还有多少钱没定价"）
    expect(within(dialog).getByTestId("plan-price-import-result")).toHaveTextContent("还有 1 行没填");

    await userEvent.type(within(dialog).getByTestId("plan-price-search"), "伞骨");

    expect(within(dialog).getByTestId("plan-price-count")).toHaveTextContent("筛选后 1 / 2 行");
    // 原始行号：伞骨是第 2 行（不是过滤后的第 1 行）—— 与计划明细表、「第 N 行没填单价」的编号一致
    const rows = within(dialog).getAllByTestId("data-table-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("2");
    expect(rows[0]).toHaveTextContent("伞骨");
    expect(within(dialog).queryByTestId("plan-price-input-0")).toBeNull();
    expect(within(dialog).getByTestId("plan-price-input-1")).toBeTruthy();
    // 那张表自己的「还有 N 行没填」不受搜索影响
    expect(within(dialog).getByTestId("plan-price-import-result")).toHaveTextContent("还有 1 行没填");
  });

  it("过滤后填的价落进原始那一行（浮层与计划表是同一份草稿状态）", async () => {
    renderSheet([
      planItem({ id: "i-1", materialName: "面料A", unitPrice: "0.0000" }),
      planItem({ id: "i-2", materialId: "m-2", materialName: "伞骨", materialCode: "M-002", unitPrice: "0.0000" }),
    ]);
    const dialog = await openPriceDialog();

    await userEvent.type(within(dialog).getByTestId("plan-price-search"), "伞骨");
    // 用 fireEvent.change 而不是逐字符 type：`<input type="number">` 对 `.` 有值清洗，
    // 逐字符敲 "12.5" 在 jsdom 上会被吞成 "1"（这里要断的是"改对了行"，不是键盘行为）。
    fireEvent.change(within(dialog).getByTestId("plan-price-input-1"), { target: { value: "12.5" } });

    // 关掉浮层看计划表：变的是第 2 行（伞骨），第 1 行仍是 0
    await userEvent.click(within(dialog).getByTestId("plan-price-dialog-done"));
    await waitFor(() => expect(screen.queryByTestId("plan-price-dialog")).toBeNull());
    expect(screen.getByTestId("plan-price-1")).toHaveValue(12.5);
    expect(screen.getByTestId("plan-price-0")).toHaveValue(0);
  });

  it("不匹配时说「没有匹配」，「清除搜索」恢复全部行", async () => {
    renderSheet([planItem({ id: "i-1", materialName: "面料A" }), planItem({ id: "i-2", materialId: "m-2", materialName: "伞骨", materialCode: "M-002" })]);
    const dialog = await openPriceDialog();

    await userEvent.type(within(dialog).getByTestId("plan-price-search"), "查无此料");
    expect(within(dialog).getByTestId("empty-state")).toHaveTextContent("没有匹配“查无此料”的行");

    await userEvent.click(within(dialog).getByRole("button", { name: "清除搜索" }));
    expect(within(dialog).getAllByTestId("data-table-row")).toHaveLength(2);
    expect(within(dialog).queryByTestId("plan-price-count")).toBeNull();
  });
});
