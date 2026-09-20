// 采购单「收束」与「编辑」的行为测试（用户 2026-09-17 的四条采购要求）。
//
// 覆盖四件事：
//   1. 新建采购单里多一列「下单状态」：已下单足量 / 部分下单 / 草稿中 / 未下单，带累计数量与采购单号；
//   2. 「BOM 外新增原因」：后端要求逐行给 `outside_bom_reason`，界面以前根本给不出这个值，
//      于是「添加行 → 保存草稿」在选了 BOM 的情况下必然失败；
//   3. 换掉物料必须把 `bom_item_id` 一起清掉，否则后端以 PURCHASE_BOM_ITEM_MISMATCH 拒绝整张单；
//   4. 「已经建好的采购单也能编辑」：草稿与「已下单但无到货」都能打开编辑，
//      收束一张已存在的单走 POST /purchase-orders/:id/split，已下单的保存必须填原因。
//
// 纪律：真实渲染页面 + 真实点击 + 真实 fetch 桩；只断言 DOM 文本与 stubApi 记录到的 method + URL + body。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PurchaseOrdersPage from "../app/procurement/orders/page";
import { Toaster } from "../components/ui/toaster";
import { apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  purchaseOrders: "/api/v1/purchase-orders",
  bomItemStatus: "/api/v1/purchase-orders/bom-item-status",
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
  { id: "bi-2", materialId: "m-2", materialName: "面料B", requiredQuantity: "5", unit: "米", unitId: "u-1", materialSnapshot: {} },
  { id: "bi-3", materialId: "m-3", materialName: "拉链", requiredQuantity: "5", unit: "米", unitId: "u-1", materialSnapshot: {} },
];
/** 三行的下单情况故意各不相同：已下单足量 / 部分下单 / 草稿中。 */
const bomStatuses = [
  { bom_item_id: "bi-1", required_quantity: "5.0000", ordered_quantity: "5.0000", draft_quantity: "0.0000", state: "ordered", ordered_purchase_order_nos: ["PO-77"], draft_purchase_order_nos: [] },
  { bom_item_id: "bi-2", required_quantity: "5.0000", ordered_quantity: "2.0000", draft_quantity: "0.0000", state: "partial", ordered_purchase_order_nos: ["PO-78"], draft_purchase_order_nos: [] },
  { bom_item_id: "bi-3", required_quantity: "5.0000", ordered_quantity: "0.0000", draft_quantity: "3.0000", state: "draft", ordered_purchase_order_nos: [], draft_purchase_order_nos: ["PO-79"] },
];

/** 一张已经建好的采购单（供「编辑」用例用）。 */
function existingOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "po-1", purchaseOrderNo: "PO-1", orderNo: "SO-1", bomId: "bom-1", supplierId: "s-1", currency: "CNY",
    totalAmount: "10.0000", status: "draft", expectedDate: null, supplier: { name: "甲供应商" },
    createdAt: "2026-09-10T02:00:00.000Z", updatedAt: "2026-09-10T02:00:00.000Z",
    items: [
      { id: "poi-1", materialId: "m-1", unitId: "u-1", bomItemId: "bi-1", supplierId: "s-1", model: "A-1", quantity: "2", unitPrice: "3", expectedDate: "2026-09-20T00:00:00.000Z", extensionData: {}, receipts: [] },
      { id: "poi-2", materialId: "m-2", unitId: "u-1", bomItemId: "bi-2", supplierId: "s-1", model: "B-1", quantity: "1", unitPrice: "4", expectedDate: "2026-09-20T00:00:00.000Z", extensionData: {}, receipts: [] },
    ],
    ...overrides,
  };
}

function stubProcurement(order: Record<string, unknown> | null = null) {
  return stubApi((url) => {
    if (url === EP.purchaseOrders) return apiOk(order ? [order] : []);
    if (url.startsWith(EP.bomItemStatus)) return apiOk(bomStatuses);
    if (url === `${EP.purchaseOrders}/po-1`) return apiOk(order);
    if (url === EP.materials) return apiOk(materials);
    if (url === EP.units) return apiOk(units);
    if (url === EP.suppliers) return apiOk(suppliers);
    if (url === EP.salesOrders) return apiOk(salesOrders);
    if (url === EP.currencies) return apiOk([{ key: "CNY", label: "人民币", sortOrder: 10 }]);
    if (url.startsWith(EP.balances)) return apiOk([]);
    if (url === `${EP.boms}/bom-1`) return apiOk({ id: "bom-1", orderNo: "SO-1", salesOrderId: "so-1", status: "confirmed", version: 1, items: bomItems });
    if (url === EP.boms) return apiOk(boms);
    return apiOk([]);
  });
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

/** 打开「新建采购单」并带入 BOM 明细（销售单 SO-1 → BOM-1 → 3 行明细）。 */
async function openNewDraftWithBom(order: Record<string, unknown> | null = null) {
  const calls = stubProcurement(order);
  render(<><PurchaseOrdersPage /><Toaster /></>);
  await screen.findByTestId("page-procurement-orders");
  await userEvent.click(screen.getByRole("button", { name: "新建采购单" }));
  await pickSelect(0, "SO-1");
  await pickSelect(1, "SO-1");
  await waitFor(() => expect(rows()).toHaveLength(3));
  return calls;
}

/** 打开一张已存在的采购单进入编辑工作区。 */
async function openExistingOrder(order: Record<string, unknown>) {
  const calls = stubProcurement(order);
  render(<><PurchaseOrdersPage /><Toaster /></>);
  await screen.findByTestId("page-procurement-orders");
  await userEvent.click(await screen.findByTestId("order-edit-PO-1"));
  await waitFor(() => expect(rows()).toHaveLength((order.items as unknown[]).length));
  return calls;
}

describe("新建采购单：「下单状态」列", () => {
  it("按 BOM 行显示四态，带累计数量与采购单号", async () => {
    await openNewDraftWithBom();

    const cells = rows().map((row) => row.children[3].textContent ?? "");
    expect(cells[0]).toContain("已下单 5");
    expect(cells[0]).toContain("PO-77");
    expect(cells[1]).toContain("部分下单 2 / 需求 5");
    expect(cells[2]).toContain("草稿中 3");
    expect(cells[2]).toContain("PO-79");
  });

  it("草稿不算已下单，但要标出「草稿中」，避免同一行被重复开单", async () => {
    await openNewDraftWithBom();

    // 第 3 行只有草稿覆盖：既不是「未下单」也不是「已下单」
    const cell = rows()[2].children[3];
    expect(cell.textContent).toContain("草稿中");
    expect(cell.textContent).not.toContain("未下单");
  });

  it("手工添加的行（不在 BOM 表上）显示「BOM 外新增」", async () => {
    await openNewDraftWithBom();

    await userEvent.click(screen.getByRole("button", { name: "添加行" }));

    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(rows()[3].children[3].textContent).toContain("BOM 外新增");
  });
});

describe("新建采购单：BOM 外新增原因", () => {
  it("有 BOM 外的行却没填原因时不给保存，填了才落库", async () => {
    const calls = await openNewDraftWithBom();
    await userEvent.click(screen.getByRole("button", { name: "添加行" }));
    await waitFor(() => expect(rows()).toHaveLength(4));

    // 四行都要有供应商，否则会先撞上「还没选供应商」那条校验
    for (const row of rows()) await pickRowSelect(row, 2, "S-001 / 甲供应商");

    const reason = await screen.findByLabelText("BOM 外新增原因");
    await userEvent.click(screen.getByTestId("purchase-save-draft"));
    expect(await screen.findByText(/不在 BOM 表中/)).toBeVisible();
    expect(callsTo(calls, "/purchase-orders/split")).toEqual([]);

    fireEvent.change(reason, { target: { value: "原 BOM 物料缺货，改用替代料" } });
    await userEvent.click(screen.getByTestId("purchase-save-draft"));

    await waitFor(() => expect(callsTo(calls, "/purchase-orders/split")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/purchase-orders/split")[0]);
    const groups = body.groups as Array<{ items: Array<{ bom_item_id?: string; extension_data?: { outside_bom_reason?: string } }> }>;
    const flat = groups.flatMap((group) => group.items);
    expect(flat).toHaveLength(4);
    // 只有手工添加的那一行带原因，BOM 内的三行不带
    const withReason = flat.filter((item) => item.extension_data?.outside_bom_reason);
    expect(withReason).toHaveLength(1);
    expect(withReason[0].extension_data?.outside_bom_reason).toBe("原 BOM 物料缺货，改用替代料");
    expect(withReason[0].bom_item_id).toBeUndefined();
  });
});

describe("新建采购单：换掉物料就不再是 BOM 上那一行", () => {
  it("换物料后清掉 bom_item_id，并按 BOM 外新增要求填原因", async () => {
    const calls = await openNewDraftWithBom();

    // 第 1 行本来是 BOM 上的面料A（bi-1），换成面料B
    await pickRowSelect(rows()[0], 0, "M-002 / 面料B");

    // 换掉之后这一行就成了 BOM 外的行：状态列与原因输入框都要跟着变
    expect(rows()[0].children[3].textContent).toContain("BOM 外新增");
    const reason = await screen.findByLabelText("BOM 外新增原因");

    for (const row of rows()) await pickRowSelect(row, 2, "S-001 / 甲供应商");
    fireEvent.change(reason, { target: { value: "替代料" } });
    await userEvent.click(screen.getByTestId("purchase-save-draft"));

    await waitFor(() => expect(callsTo(calls, "/purchase-orders/split")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/purchase-orders/split")[0]);
    const groups = body.groups as Array<{ items: Array<{ material_id: string; bom_item_id?: string; extension_data?: { outside_bom_reason?: string } }> }>;
    const flat = groups.flatMap((group) => group.items);
    const changed = flat.find((item) => item.material_id === "m-2" && item.extension_data?.outside_bom_reason === "替代料");
    expect(changed, "换过物料的第 1 行必须作为 BOM 外新增发出去").toBeTruthy();
    expect(changed?.bom_item_id).toBeUndefined();
  });
});

describe("编辑已经建好的采购单", () => {
  it("草稿可以打开编辑，收束时落成草稿（place_order=false）", async () => {
    const calls = await openExistingOrder(existingOrder());

    expect(screen.getByText("编辑采购单：PO-1")).toBeVisible();
    // 两行都是供应商 s-1 → 只有一组，不显示收束预览，按钮上也不写张数
    expect(screen.queryByTestId("purchase-split-preview")).toBeNull();
    await userEvent.click(screen.getByTestId("purchase-save-draft"));

    await waitFor(() => expect(callsTo(calls, "/purchase-orders/po-1/split")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/purchase-orders/po-1/split")[0]);
    expect(body.place_order).toBe(false);
    expect(body.groups).toHaveLength(1);
    // 草稿不需要原因：改动原因只在编辑「已下单」的单时才必填
    expect(body.reason).toBeUndefined();
    // 收束一张已存在的单走 :id/split，不再新建
    expect(callsTo(calls, "/purchase-orders/split")).toEqual([]);
  });

  it("改成两家供应商后收束：一张单变两张，预览写明张数", async () => {
    const calls = await openExistingOrder(existingOrder());

    await pickRowSelect(rows()[1], 2, "S-002 / 乙供应商");

    const preview = await screen.findByTestId("purchase-split-preview");
    expect(within(preview).getByText(/共 2 张/)).toBeVisible();
    expect(within(preview).getByText(/甲供应商 · 1 行/)).toBeVisible();
    expect(within(preview).getByText(/乙供应商 · 1 行/)).toBeVisible();
    // 沿用原单单号这件事要写在界面上，否则「第一组去哪了」没人知道
    expect(within(preview).getByText(/第 1 组（甲供应商）沿用本单单号 PO-1/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "收束下单（2 张）" }));

    await waitFor(() => expect(callsTo(calls, "/purchase-orders/po-1/split")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/purchase-orders/po-1/split")[0]);
    expect(body.place_order).toBe(true);
    expect((body.groups as Array<{ supplier_id: string }>).map((group) => group.supplier_id)).toEqual(["s-1", "s-2"]);
  });

  it("已下单但无到货的单也能打开编辑，保存必须填原因", async () => {
    const calls = await openExistingOrder(existingOrder({ status: "ordered" }));

    // 已下单的单：没有「收束下单」按钮（它已经下过单），改为「保存修改」+ 必填原因
    expect(screen.getByLabelText("修改原因")).toBeVisible();
    expect(screen.queryByTestId("purchase-save-order")).toBeNull();

    await userEvent.click(screen.getByTestId("purchase-save"));
    expect(await screen.findByText(/修改已下单的采购单必须填写原因/)).toBeVisible();
    expect(callsTo(calls, "/purchase-orders/po-1/split")).toEqual([]);

    fireEvent.change(screen.getByLabelText("修改原因"), { target: { value: "单价录错" } });
    await userEvent.click(screen.getByTestId("purchase-save"));

    await waitFor(() => expect(callsTo(calls, "/purchase-orders/po-1/split")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/purchase-orders/po-1/split")[0]);
    expect(body.reason).toBe("单价录错");
    // 已下单的单收束后仍是已下单：不能靠「保存」把它退回草稿（由后端保证，这里钉住请求语义）
    expect(body.place_order).toBe(true);
  });

  it("有到货的已下单单不给编辑入口", async () => {
    const order = existingOrder({ status: "ordered" });
    (order.items as Array<{ receipts: unknown[] }>)[0].receipts = [{ id: "r-1", receiptNo: "R-1", quantity: "1" }];

    stubProcurement(order as unknown as Record<string, unknown>);
    render(<><PurchaseOrdersPage /><Toaster /></>);
    await screen.findByTestId("page-procurement-orders");

    expect(screen.queryByTestId("order-edit-PO-1")).toBeNull();
  });

  it("未选择供应商的行：保存草稿放行，收束下单阻断并指出是第几行", async () => {
    const order = existingOrder({ supplierId: null });
    // 表头供应商与行供应商都为空时，这一行才是真的没选供应商
    // （行上没值时页面的既有口径是回落到表头供应商，所以这里必须把两者都清掉）
    (order.items as Array<{ supplierId: string | null }>)[0].supplierId = "s-1";
    (order.items as Array<{ supplierId: string | null }>)[1].supplierId = null;

    const calls = await openExistingOrder(order as unknown as Record<string, unknown>);

    // 下单要求每行都有供应商（一个供应商一张单，没收束的行没有落脚处）
    await userEvent.click(screen.getByTestId("purchase-save-order"));
    expect(await screen.findByText(/第 2 行明细还没选供应商，不能下单/)).toBeVisible();
    expect(callsTo(calls, "/purchase-orders/po-1/split")).toEqual([]);

    // 但草稿必须存得下来：用户 2026-09-17「导入 BOM 明细，也视为对采购单的编辑，允许保存」
    await userEvent.click(screen.getByTestId("purchase-save-draft"));

    await waitFor(() => expect(callsTo(calls, "/purchase-orders/po-1/split")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/purchase-orders/po-1/split")[0]);
    expect(body.place_order).toBe(false);
    const groups = body.groups as Array<{ supplier_id?: string; items: Array<{ supplier_id?: string }> }>;
    expect(groups).toHaveLength(2);
    // 未选供应商的那一组不能带 supplier_id —— DTO 上是 @IsOptional() @IsUUID()，空串会被判非法
    expect(groups[1].supplier_id).toBeUndefined();
    expect(groups[1].items.every((entry) => entry.supplier_id === undefined)).toBe(true);
  });
});

describe("刚导入 BOM 明细：还没选供应商也能存草稿", () => {
  it("三行都没有供应商时，保存草稿落成一张「还没有供应商」的草稿", async () => {
    const calls = await openNewDraftWithBom();

    // 导入之后每一行都没有供应商，界面明说这一组会被先存起来
    const preview = await screen.findByTestId("purchase-split-preview");
    expect(within(preview).getByText(/还没有任何一行选了供应商/)).toBeVisible();
    expect(within(preview).getByText(/未选择供应商 · 3 行/)).toBeVisible();
    expect(within(preview).getByText(/保存草稿会把它们先存进一张「还没有供应商」的草稿/)).toBeVisible();

    await userEvent.click(screen.getByTestId("purchase-save-draft"));

    await waitFor(() => expect(callsTo(calls, "/purchase-orders/split")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/purchase-orders/split")[0]);
    expect(body.place_order).toBe(false);
    const groups = body.groups as Array<{ supplier_id?: string; items: Array<{ supplier_id?: string; bom_item_id?: string }> }>;
    expect(groups).toHaveLength(1);
    expect(groups[0].supplier_id).toBeUndefined();
    expect(groups[0].items).toHaveLength(3);
    // BOM 行号仍然带出去，这样回来继续填的时候「下单状态」列还是有意义的
    expect(groups[0].items.map((entry) => entry.bom_item_id)).toEqual(["bi-1", "bi-2", "bi-3"]);
  });

  it("同一批导入里，下单仍然要求每行都选了供应商", async () => {
    const calls = await openNewDraftWithBom();

    await userEvent.click(screen.getByTestId("purchase-save-order"));

    expect(await screen.findByText(/第 1 行明细还没选供应商，不能下单/)).toBeVisible();
    expect(callsTo(calls, "/purchase-orders/split")).toEqual([]);
  });

  it("一行明细都没有的空草稿走普通建单接口（选定销售单即可保存）", async () => {
    const calls = stubProcurement();
    render(<><PurchaseOrdersPage /><Toaster /></>);
    await screen.findByTestId("page-procurement-orders");

    await userEvent.click(screen.getByRole("button", { name: "新建采购单" }));
    await pickSelect(0, "SO-1");
    await userEvent.click(screen.getByTestId("purchase-save-draft"));

    // 没有明细就没有供应商可分组，收束接口会以「至少需要一个分组」拒绝，所以走 POST /purchase-orders
    await waitFor(() => expect(callsTo(calls, "/purchase-orders").filter((call) => call.method === "POST")).toHaveLength(1));
    expect(callsTo(calls, "/purchase-orders/split")).toEqual([]);
    const body = bodyOf(callsTo(calls, "/purchase-orders").filter((call) => call.method === "POST")[0]);
    expect(body.order_no).toBe("SO-1");
    expect(body.items).toEqual([]);
  });
});
