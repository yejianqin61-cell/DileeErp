// app/procurement/page.tsx 采购草稿工作区的**行为**测试。
//
// 只覆盖本轮整改新加的两条链路，避免重复已有模块测试：
//   1. 带入 BOM 明细后逐行复选框 → 批量移除：只改本地草稿，**不写 BOM**（BOM 是工程主数据）；
//   2. 一张销售订单 → 多张采购单：按供应商分组，一次 POST /purchase-orders/split。
//
// 纪律：真实渲染页面 + 真实点击 + 真实 fetch 桩；只断言 DOM 文本与 stubApi 记录到的 method + URL + body。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProcurementPage from "../app/procurement/page";
import { Toaster } from "../components/ui/toaster";
import { apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  purchaseOrders: "/api/v1/purchase-orders",
  inbounds: "/api/v1/raw-material-inbounds",
  payableSources: "/api/v1/payable-sources",
  payableEntries: "/api/v1/finance/payable-entries",
  materials: "/api/v1/materials",
  units: "/api/v1/units",
  suppliers: "/api/v1/suppliers",
  boms: "/api/v1/boms",
  salesOrders: "/api/v1/sales-orders",
  currencies: "/api/v1/dictionaries/currency/items",
  balances: "/api/v1/inventory/raw-material-balances",
} as const;

const materials = [
  { id: "m-1", materialCode: "M-001", name: "面料A", defaultUnitId: "u-1", isActive: true, materialType: "raw_material" },
  { id: "m-2", materialCode: "M-002", name: "面料B", defaultUnitId: "u-1", isActive: true, materialType: "raw_material" },
  { id: "m-3", materialCode: "M-003", name: "拉链", defaultUnitId: "u-1", isActive: true, materialType: "raw_material" },
];
const units = [{ id: "u-1", name: "米", isActive: true }];
const suppliers = [
  { id: "s-1", supplierCode: "S-001", name: "甲供应商", isActive: true },
  { id: "s-2", supplierCode: "S-002", name: "乙供应商", isActive: true },
];
const salesOrders = [{ id: "so-1", orderNo: "SO-1", status: "confirmed" }];
const boms = [{ id: "bom-1", orderNo: "SO-1", salesOrderId: "so-1", bomNo: "BOM-1" }];
const bomItems = [
  { id: "bi-1", materialId: "m-1", materialName: "面料A", requiredQuantity: "5", unit: "米", unitId: "u-1", materialSnapshot: {} },
  { id: "bi-2", materialId: "m-2", materialName: "面料B", requiredQuantity: "7", unit: "米", unitId: "u-1", materialSnapshot: {} },
  { id: "bi-3", materialId: "m-3", materialName: "拉链", requiredQuantity: "9", unit: "米", unitId: "u-1", materialSnapshot: {} },
];

function stubProcurement() {
  return stubApi((url) => {
    if (url === EP.purchaseOrders) return apiOk([]);
    if (url === EP.inbounds) return apiOk([]);
    if (url === EP.payableSources) return apiOk([]);
    if (url === EP.payableEntries) return apiOk([]);
    if (url === EP.materials) return apiOk(materials);
    if (url === EP.units) return apiOk(units);
    if (url === EP.suppliers) return apiOk(suppliers);
    if (url === EP.salesOrders) return apiOk(salesOrders);
    if (url === EP.currencies) return apiOk([{ key: "CNY", label: "人民币", sortOrder: 10 }, { key: "USD", label: "美元", sortOrder: 20 }]);
    if (url.startsWith(EP.balances)) return apiOk([]);
    if (url === `${EP.boms}/bom-1`) return apiOk({ id: "bom-1", orderNo: "SO-1", salesOrderId: "so-1", status: "confirmed", version: 1, items: bomItems });
    if (url === EP.boms) return apiOk(boms);
    return apiOk([]);
  });
}

/** 打开采购草稿并带入 BOM 明细（销售单 SO-1 → BOM-1 → 3 行明细）。 */
async function openDraftWithBomItems() {
  const calls = stubProcurement();
  render(<><ProcurementPage /><Toaster /></>);
  await screen.findByTestId("page-procurement");

  await userEvent.click(screen.getByRole("button", { name: "新建采购单" }));
  // 草稿编辑器里的前三个下拉依次是：销售单 / BOM表 / 币种
  await pickSelect(0, "SO-1");
  await pickSelect(1, "SO-1");
  await waitFor(() => expect(rows()).toHaveLength(3));
  return calls;
}

async function pickSelect(index: number, optionName: string) {
  await userEvent.click(screen.getAllByRole("combobox")[index]);
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

/** 草稿表格里的明细行（行首复选框是「选择第 N 行采购明细」，表头全选框不算明细行）。 */
function rows() {
  return screen.queryAllByLabelText(/^选择第 \d+ 行采购明细$/).map((box) => box.closest("tr")).filter((row): row is HTMLTableRowElement => Boolean(row));
}

/** 取某一行里的第 index 个下拉（0 物料 / 1 单位 / 2 供应商）。 */
async function pickRowSelect(row: HTMLTableRowElement, index: number, optionName: string) {
  await userEvent.click(within(row).getAllByRole("combobox")[index]);
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;

describe("采购草稿：带入 BOM 后逐行勾选批量移除", () => {
  it("勾选两行 → 批量移除只改草稿，BOM 表不产生任何写请求", async () => {
    const calls = await openDraftWithBomItems();

    // 全选复选框在表头，行复选框紧随其后
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);

    await userEvent.click(screen.getByLabelText("选择第 1 行采购明细"));
    await userEvent.click(screen.getByLabelText("选择第 3 行采购明细"));
    expect(screen.getByRole("button", { name: "移除选中 2 行" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "移除选中 2 行" }));

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByLabelText("选择第 2 行采购明细")).toBeNull();
    // 行选择在移除后清空
    expect(screen.getByRole("button", { name: "移除选中行" })).toBeDisabled();
    // BOM 是工程主数据：整条链路只允许读 BOM，不得出现任何写请求
    const bomWrites = calls.filter((call) => call.url.includes("/boms") && call.method !== "GET");
    expect(bomWrites).toEqual([]);
    // 关掉「带入 BOM表明细」后草稿不再等于 BOM 全量。
    // 注意按钮被 <label> 包裹：按 accname 规范，label 内嵌控件的文本会被跳过，
    // 因此页面显式给了 aria-label（否则无障碍名称为空），测试也按 aria-label 查询。
    expect(screen.getByRole("button", { name: "带入 BOM表明细" })).toHaveAttribute("aria-pressed", "false");
  });

  it("表头复选框可以全选与取消全选", async () => {
    await openDraftWithBomItems();

    await userEvent.click(screen.getByLabelText("全选采购明细"));
    expect(screen.getByRole("button", { name: "移除选中 3 行" })).toBeEnabled();

    await userEvent.click(screen.getByLabelText("全选采购明细"));
    expect(screen.getByRole("button", { name: "移除选中行" })).toBeDisabled();
  });
});

describe("采购草稿：一张订单按供应商拆分成多张采购单", () => {
  it("按供应商分组后一次提交 /purchase-orders/split，组内明细的供应商取组供应商", async () => {
    const calls = await openDraftWithBomItems();

    // 三行分别指定供应商：甲 / 乙 / 甲
    const all = rows();
    await pickRowSelect(all[0], 2, "S-001 / 甲供应商");
    await pickRowSelect(all[1], 2, "S-002 / 乙供应商");
    await pickRowSelect(all[2], 2, "S-001 / 甲供应商");
    // 下单前校验要求每行都有预计到货日期
    for (const input of screen.getAllByLabelText("预计到货日期")) {
      fireEvent.change(input, { target: { value: "2026-09-20" } });
    }

    // 两个供应商 → 出现分组预览
    const preview = await screen.findByTestId("purchase-split-preview");
    expect(within(preview).getByText(/共 2 张/)).toBeVisible();
    expect(within(preview).getByText(/甲供应商 · 2 行/)).toBeVisible();
    expect(within(preview).getByText(/乙供应商 · 1 行/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "按供应商拆分下单（2 张）" }));

    await waitFor(() => expect(callsTo(calls, "/purchase-orders/split")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/purchase-orders/split")[0]);
    expect(body.order_no).toBe("SO-1");
    expect(body.bom_id).toBe("bom-1");
    expect(body.place_order).toBe(true);
    expect(body.currency).toBe("CNY");
    const groups = body.groups as Array<{ supplier_id: string; items: Array<{ supplier_id: string; quantity: string }> }>;
    expect(groups.map((group) => group.supplier_id)).toEqual(["s-1", "s-2"]);
    expect(groups.map((group) => group.items.length)).toEqual([2, 1]);
    // 组内每行的供应商与组供应商一致（拆分语义：一组一个供应商）
    expect(groups[0].items.every((item) => item.supplier_id === "s-1")).toBe(true);
    expect(groups[1].items.every((item) => item.supplier_id === "s-2")).toBe(true);
    expect(groups[0].items.map((item) => item.quantity)).toEqual(["5", "9"]);
    // 单张下单接口不能被同时调用
    expect(callsTo(calls, "/purchase-orders").filter((call) => call.method === "POST")).toEqual([]);
  });

  it("只有一家供应商时不显示拆分入口（拆了也只有一张）", async () => {
    await openDraftWithBomItems();

    for (const row of rows()) await pickRowSelect(row, 2, "S-001 / 甲供应商");

    expect(screen.queryByTestId("purchase-split-preview")).toBeNull();
  });
});
