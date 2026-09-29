// 采购计划的前端行为（2026-09-27）。
//
// 覆盖任务文档 T09/T10 的验收点：13 列与列名、只读的地址/联系人、供应商下拉里快速新建、
// 保存带乐观锁与冲突保留本地改动、已下单行的只读与两个例外、勾选默认全选、
// 未选供应商的行单独成组并阻断下单、币种按组发出、下单后行还在并显示 PO 号。
//
// 渲染方式：Sheet 相关的用例**直接渲染 `PlanDetailSheet`**（它自己取详情、下单状态、库存、供应商池），
// 不走列表页 —— 列表页那几个请求与这些断言无关，混在一起只会让失败原因难查。
// 列表页自己的用例（新建、深链）单独一组。
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PurchasePlansPage from "../app/procurement/plans/page";
import { PlanDetailSheet } from "../components/procurement/plan-detail-sheet";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const route = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => route.searchParams,
  usePathname: () => "/procurement/plans",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

const materials = [
  { id: "m-1", materialCode: "M-001", name: "面料A", isActive: true, defaultUnitId: "u-1" },
  { id: "m-2", materialCode: "M-002", name: "伞骨", isActive: true, defaultUnitId: "u-1" },
];
const units = [{ id: "u-1", name: "米", isActive: true }];
const suppliers = [
  { id: "s-1", supplierCode: "S-001", name: "宁波辅料厂", contactName: "张伟", phone: "13800000000", isActive: true },
  { id: "s-2", supplierCode: "S-002", name: "绍兴纺织", isActive: true },
];

/** 计划详情：两行未下单（一行有供应商与地址联系人，一行没有），一行已下单。 */
const planItem = (overrides: Record<string, unknown> = {}) => ({
  id: "i-1", materialId: "m-1", materialName: "面料A", materialCode: "M-001", model: "A-1", unitId: "u-1", unitName: "米",
  quantity: "5.0000", unitPrice: "3.5000", bomItemId: "bi-1", supplierId: null, supplierName: null,
  supplierAddress: null, supplierContact: null, expectedDate: null, purchaseOrderItemId: null, purchaseOrderNo: null,
  extensionData: {}, ...overrides,
});
const planDetail = (items: Array<Record<string, unknown>> = [planItem()]) => ({
  id: "plan-1", planNo: "PP-20260927-AAAA1111", orderNo: "DL260001-1", itemNo: "27621", customerName: "流水花扇客户",
  bomId: "bom-1", bomVersion: 3, status: "unordered", statusLabel: "未下单", lineCount: items.length,
  unorderedCount: items.filter((item) => !item.purchaseOrderItemId).length, orderedCount: items.filter((item) => item.purchaseOrderItemId).length,
  bomDeleted: false, bomExtraMaterialCount: 0, deliveryDate: null, updatedAt: "2026-09-27T02:00:00.000Z", items,
});

/** Sheet 用例的桩：只回答 Sheet 真正会打的四个请求。 */
function stubSheet(options: { items?: Array<Record<string, unknown>>; orderStatus?: Array<Record<string, unknown>>; onPatch?: (call: StubbedCall) => Response; onOrder?: (call: StubbedCall) => Response } = {}) {
  const items = options.items ?? [planItem()];
  return stubApi((url, call) => {
    if (url.includes("/purchase-orders/bom-item-status")) return apiOk(options.orderStatus ?? []);
    if (url.includes("/inventory/raw-material-balances")) return apiOk([{ material_id: "m-1", unit_id: "u-1", quantity: "12.0000" }]);
    if (url.endsWith("/suppliers") && call.method === "GET") return apiOk(suppliers);
    if (url.endsWith("/suppliers") && call.method === "POST") return apiOk({ id: "s-new", supplierCode: "S-003", name: "新厂家", isActive: true });
    if (url.includes("/purchase-plans/plan-1") && call.method === "PATCH") return options.onPatch ? options.onPatch(call) : apiOk(planDetail(items));
    if (url.includes("/purchase-plans/plan-1/order")) return options.onOrder ? options.onOrder(call) : apiOk({ orders: [{ purchaseOrderNo: "PO-1" }] });
    if (url.endsWith("/purchase-plans/plan-1")) return apiOk(planDetail(items));
    // 其余（列表、候选、物料、单位、币种字典）一律给空数组：
    // 列表类请求拿到 `{}` 会让页面把它当数组用（`data.length`），空数组最安全。
    return apiOk([]);
  });
}

function renderSheet(options: { items?: Array<Record<string, unknown>>; orderStatus?: Array<Record<string, unknown>>; onPatch?: (call: StubbedCall) => Response; onOrder?: (call: StubbedCall) => Response } = {}) {
  const calls = stubSheet(options);
  render(<><PlanDetailSheet planId="plan-1" materials={materials} units={units} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} /><Toaster /></>);
  return calls;
}

const headers = () => screen.getAllByRole("columnheader").map((cell) => cell.textContent?.trim());
/** `SearchableSelect` 的根 div 带 testid，但**点它不会展开**（testid 不在按钮上）—— 要点里面的 combobox。 */
const openSelect = async (testId: string) => { await userEvent.click(within(await screen.findByTestId(testId)).getByRole("combobox")); };

describe("采购计划明细：13 列一次展示（口径 5/9）", () => {
  it("13 列都在、顺序与 §6.2 一致，且「需求量」已改名「本次采购量」", async () => {
    renderSheet();
    await screen.findByRole("button", { name: "保存计划" });

    expect(headers()).toEqual(["", "名称", "型号", "下单状态", "本次采购量", "当前库存量", "单位", "单价", "供应商", "供应商地址", "联系人", "预计到货", "操作"]);
    expect(headers()).not.toContain("需求量");
  });

  it("地址/联系人是只读派生：显示选中供应商的地址与「联系人 / 电话」，且不在提交体里", async () => {
    const calls = renderSheet({
      items: [planItem({ supplierId: "s-1", supplierName: "宁波辅料厂", supplierAddress: "浙江省金华市婺城区某路 1 号", supplierContact: "张伟 / 13800000000" })],
    });
    await screen.findByRole("button", { name: "保存计划" });

    expect(screen.getByText("浙江省金华市婺城区某路 1 号")).toBeTruthy();
    expect(screen.getByText("张伟 / 13800000000")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "保存计划" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const body = JSON.parse(String(calls.find((call) => call.method === "PATCH")?.body)) as { items: Array<Record<string, unknown>> };
    expect(Object.keys(body.items[0])).not.toContain("supplier_address");
    expect(Object.keys(body.items[0])).not.toContain("supplier_contact");
  });
});

describe("采购计划明细：保存与冲突（口径 7）", () => {
  it("保存带 expected_updated_at（乐观锁），并带上数量/单价/供应商", async () => {
    const calls = renderSheet({ items: [planItem({ supplierId: "s-1" })] });
    await screen.findByRole("button", { name: "保存计划" });

    const qty = screen.getAllByRole("spinbutton")[0];
    await userEvent.clear(qty);
    await userEvent.type(qty, "7");
    await userEvent.click(screen.getByRole("button", { name: "保存计划" }));

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const patch = calls.find((call) => call.method === "PATCH");
    const body = JSON.parse(String(patch?.body)) as { expected_updated_at: string; items: Array<Record<string, unknown>> };
    expect(body.expected_updated_at).toBe("2026-09-27T02:00:00.000Z");
    expect(body.items[0].quantity).toBe("7");
    expect(body.items[0].supplier_id).toBe("s-1");
  });

  it("冲突（PURCHASE_PLAN_UPDATE_CONFLICT）：提示 + **保留本地改动** + 给重新加载入口，不静默覆盖", async () => {
    const calls = renderSheet({ onPatch: () => apiErr(422, "PURCHASE_PLAN_UPDATE_CONFLICT", "这份采购计划已被他人修改") });
    await screen.findByRole("button", { name: "保存计划" });

    const qty = screen.getAllByRole("spinbutton")[0];
    await userEvent.clear(qty);
    await userEvent.type(qty, "9");
    await userEvent.click(screen.getByRole("button", { name: "保存计划" }));

    expect(await screen.findByTestId("plan-conflict")).toBeVisible();
    expect(screen.getByRole("button", { name: /重新加载最新版本/ })).toBeTruthy();
    // 本地改动还在屏幕上
    expect((screen.getAllByRole("spinbutton")[0] as HTMLInputElement).value).toBe("9");
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("新加的行还没保存过就不能下单（后端会拒），提示先保存", async () => {
    renderSheet({ items: [planItem({ supplierId: "s-1" })] });
    await screen.findByRole("button", { name: "添加行" });
    await userEvent.click(screen.getByRole("button", { name: "添加行" }));
    // 给新行也选上供应商 —— 否则下单按钮会因为"有行没选供应商"直接禁用，走不到这条校验
    await openSelect("plan-supplier-select-1");
    await userEvent.type(screen.getByTestId("searchable-select-search"), "宁波");
    await userEvent.click(screen.getAllByTestId("searchable-select-option")[0]);
    // 选中确实生效（收起态显示供应商名）—— 不然后面那句"下单按钮被禁用"会让本用例误判
    expect(within(screen.getByTestId("plan-supplier-select-1")).getByText("S-001 / 宁波辅料厂")).toBeTruthy();
    await userEvent.click(screen.getByTestId("plan-order"));

    expect(await screen.findByTestId("plan-error")).toHaveTextContent("请先「保存计划」");
  });
});

describe("采购计划明细：已下单行（口径 6 + 设计文档 §4.1）", () => {
  const orderedItems = [
    planItem({ id: "i-1", supplierId: "s-1", purchaseOrderItemId: "poi-1", purchaseOrderNo: "PO-20260927-1" }),
    // 未下单那行要给个供应商：否则它会单独成"未选供应商"一组，下单按钮直接禁用，
    // 就测不到"已下单行不参与本次下单"这件事了。
    planItem({ id: "i-2", materialId: "m-2", materialName: "伞骨", model: "", quantity: "2.0000", unitPrice: "1.0000", supplierId: "s-2", purchaseOrderItemId: null }),
  ];

  it("显示落在哪张 PO 上、删除禁用、内容列只读（下拉与输入都 disabled）", async () => {
    stubSheet({ items: orderedItems });
    render(<PlanDetailSheet planId="plan-1" materials={materials} units={units} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} />);
    await screen.findByRole("button", { name: "保存计划" });

    const orderedRow = screen.getByTestId("plan-row-0");
    expect(within(orderedRow).getByText("PO-20260927-1")).toBeTruthy();
    expect((within(orderedRow).getByRole("button", { name: "删除行" }) as HTMLButtonElement).disabled).toBe(true);
    // 数量与单价是 number input；物料/单位是 combobox；它们都该被禁用
    expect((within(orderedRow).getAllByRole("spinbutton")[0] as HTMLInputElement).disabled).toBe(true);
    expect((within(orderedRow).getAllByRole("combobox")[0] as HTMLButtonElement).disabled).toBe(true);
    // 但**预计到货可以改**（它的唯一通路）
    expect((within(orderedRow).getByLabelText("预计到货日期") as HTMLInputElement).disabled).toBe(false);

    // 未下单那一行照旧可编辑
    const freeRow = screen.getByTestId("plan-row-1");
    expect((within(freeRow).getAllByRole("spinbutton")[0] as HTMLInputElement).disabled).toBe(false);
  });

  it("勾选默认全选**未下单**行，已下单行不参与本次下单", async () => {
    const calls = stubSheet({ items: orderedItems });
    render(<PlanDetailSheet planId="plan-1" materials={materials} units={units} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} />);
    await screen.findByRole("button", { name: "保存计划" });

    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // 第 0 个是表头全选框；后面两个是行
    expect(boxes[1].checked).toBe(false);
    expect(boxes[1].disabled).toBe(true);
    expect(boxes[2].checked).toBe(true);

    await userEvent.click(screen.getByTestId("plan-order"));
    await waitFor(() => expect(calls.some((call) => call.url.includes("/order"))).toBe(true));
    const body = JSON.parse(String(calls.find((call) => call.url.includes("/order"))?.body)) as { groups: Array<{ items: string[] }> };
    expect(body.groups.flatMap((group) => group.items)).toEqual(["i-2"]);
  });
});

describe("采购计划明细：按供应商收束下单（口径 6/10）", () => {
  it("未选供应商的行单独成组并标红，下单按钮被禁用", async () => {
    renderSheet({ items: [planItem({ id: "i-1", supplierId: null })] });
    await screen.findByRole("button", { name: "保存计划" });

    expect(screen.getByTestId("plan-unassigned-note")).toHaveTextContent("还没选供应商");
    expect((screen.getByTestId("plan-order") as HTMLButtonElement).disabled).toBe(true);
  });

  it("币种按组发出（默认 CNY，可改成 USD），组内行数一并发出", async () => {
    const calls = renderSheet({
      items: [planItem({ id: "i-1", supplierId: "s-1" }), planItem({ id: "i-2", materialId: "m-2", materialName: "伞骨", supplierId: "s-1" })],
    });
    await screen.findByRole("button", { name: "保存计划" });

    // 一组 → 一个币种下拉（收起态是 combobox）
    const currency = within(screen.getByTestId("plan-group-s-1")).getByRole("combobox");
    await userEvent.click(currency);
    await userEvent.click(await screen.findByRole("option", { name: /美元/ }));
    await userEvent.click(screen.getByTestId("plan-order"));

    await waitFor(() => expect(calls.some((call) => call.url.includes("/order"))).toBe(true));
    const body = JSON.parse(String(calls.find((call) => call.url.includes("/order"))?.body)) as { groups: Array<{ supplier_id: string; currency: string; items: string[] }> };
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({ supplier_id: "s-1", currency: "USD", items: ["i-1", "i-2"] });
  });

  it("供应商下拉里能就地新建，建完自动选中该行", async () => {
    const calls = renderSheet();
    await screen.findByRole("button", { name: "保存计划" });

    await openSelect("plan-supplier-select-0");
    await userEvent.type(screen.getByTestId("searchable-select-search"), "新厂家");
    await userEvent.click(await screen.findByText("＋ 新建供应商「新厂家」"));
    await userEvent.click(await screen.findByRole("button", { name: "保存并选用" }));

    // 建完自动选中：保存请求里带上新 id
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/suppliers") && call.method === "POST")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "保存计划" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const body = JSON.parse(String(calls.find((call) => call.method === "PATCH")?.body)) as { items: Array<Record<string, unknown>> };
    expect(body.items[0].supplier_id).toBe("s-new");
  });
});

describe("采购计划列表：新建与深链（T09）", () => {
  const stubList = (candidates: Array<Record<string, unknown>> = []) => stubApi((url) => {
    if (url.includes("/purchase-plans/candidates")) return apiOk(candidates);
    if (url.includes("/purchase-plans")) return apiOk([{ id: "plan-1", planNo: "PP-1", orderNo: "DL260001-1", itemNo: "27621", customerName: "流水花扇客户", bomId: "bom-1", bomVersion: 3, lineCount: 4, unorderedCount: 2, orderedCount: 2, status: "partial", statusLabel: "部分下单", updatedByName: "张三", createdAt: "2026-09-27T01:00:00Z", updatedAt: "2026-09-27T02:00:00Z" }]);
    if (url.endsWith("/materials")) return apiOk(materials);
    if (url.endsWith("/units")) return apiOk(units);
    return apiOk({});
  });

  it("列表显示计划编号/销售单/货号/客户/未下单行数/状态/最后更新（人 + 时间）", async () => {
    route.searchParams = new URLSearchParams();
    stubList();
    render(<PurchasePlansPage />);

    expect(await screen.findByText("PP-1")).toBeTruthy();
    expect(screen.getByText("27621")).toBeTruthy();
    expect(screen.getByText("流水花扇客户")).toBeTruthy();
    expect(screen.getByText("张三")).toBeTruthy();
    expect(screen.getByTestId("page-procurement-plans")).toBeTruthy();
  });

  it("新建：只能选还没有计划的 BOM，建完直接打开计划", async () => {
    route.searchParams = new URLSearchParams();
    const calls = stubApi((url, call) => {
      if (url.includes("/purchase-plans/candidates")) return apiOk([{ bomId: "bom-9", orderNo: "DL260009-1", bomVersion: 1, itemNo: "27621", customerName: "客户甲", deliveryDate: null, itemCount: 4 }]);
      if (url.endsWith("/purchase-plans") && call.method === "POST") return apiOk({ id: "plan-9" });
      if (url.includes("/purchase-plans/plan-9")) return apiOk(planDetail([]));
      if (url.includes("/purchase-plans")) return apiOk([]);
      if (url.endsWith("/materials")) return apiOk(materials);
      if (url.endsWith("/units")) return apiOk(units);
      return apiOk({});
    });
    render(<PurchasePlansPage />);
    await screen.findByTestId("plan-create");

    await userEvent.click(screen.getByTestId("plan-create"));
    await openSelect("action-field-bom_id");
    await userEvent.click(await screen.findByText(/DL260009-1/));
    await userEvent.click(screen.getByRole("button", { name: "创建并打开" }));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/purchase-plans") && call.method === "POST")).toBe(true));
    const body = JSON.parse(String(calls.find((call) => call.method === "POST" && call.url.endsWith("/purchase-plans"))?.body)) as { bom_id: string };
    expect(body.bom_id).toBe("bom-9");
    // 建完直接打开计划（行已经带好了）
    expect(await screen.findByText(/PP-20260927-AAAA1111/)).toBeTruthy();
  });

  it("?plan_id= 深链直接打开那份计划", async () => {
    route.searchParams = new URLSearchParams({ plan_id: "plan-1" });
    stubSheet({ items: [planItem()] });
    render(<PurchasePlansPage />);

    expect(await screen.findByText(/PP-20260927-AAAA1111/)).toBeTruthy();
  });
});
