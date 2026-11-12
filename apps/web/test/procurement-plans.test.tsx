// 采购计划的前端行为（2026-09-27）。
//
// 覆盖任务文档 T09/T10 的验收点：14 列与列名、只读的地址/联系人、供应商下拉里快速新建、
// 保存带乐观锁与冲突保留本地改动、已下单行的只读与两个例外、勾选默认全选、
// 未选供应商的行单独成组并阻断下单、币种按组发出、下单后行还在并显示 PO 号、
// 行总价与按币种分列的计划合计（2026-09-30 价格字段）。
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
  quantity: "5.0000", unitPrice: "3.5000", currency: "CNY", bomItemId: "bi-1", supplierId: null, supplierName: null,
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

describe("采购计划明细：14 列一次展示（口径 5/9）", () => {
  it("14 列都在、顺序与 §6.2 一致，且「需求量」已改名「本次采购量」", async () => {
    renderSheet();
    await screen.findByRole("button", { name: "保存计划" });

    // 2026-09-30 加了「行总价」（用户：「添加价格字段，单价，总价」）：紧挨单价右侧，
    // 只读派生（数量 × 单价），本地即时算 —— 改一次数量或单价就能看见钱变了。
    expect(headers()).toEqual(["", "名称", "型号", "下单状态", "本次采购量", "当前库存量", "单位", "单价", "行总价", "供应商", "供应商地址", "联系人", "预计到货", "操作"]);
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

  /**
   * 自动收束（2026-10-13，用户：「如果相同的供应商的不同物料没有同时下单，下单之后也要自动收束
   * 在一个采购单里」）。
   *
   * 「并 or 新建」有**四条判据**（认据/供应商/币种/有没有到货），所以它**有时候并不了**。
   * 而"采购员以为收束了、实际多出一张单"是最难查的一类坏 —— 预览里每组必须明写落点。
   */
  it("收束预览写明落点：这家已有未到货的已下单单 → 「并入 PO-xxx（已有 N 行）」", async () => {
    stubApi((url, call) => {
      if (url.includes("/purchase-orders/bom-item-status")) return apiOk([]);
      if (url.includes("/inventory/raw-material-balances")) return apiOk([]);
      if (url.endsWith("/suppliers") && call.method === "GET") return apiOk(suppliers);
      // 详情接口多下发一条 `openPurchaseOrders`（这份计划下还能并入的单）
      if (url.includes("/purchase-plans/plan-1")) return apiOk({
        ...planDetail([planItem({ supplierId: "s-1" })]),
        openPurchaseOrders: [{ id: "po-1", purchaseOrderNo: "PO-EXISTING", supplierId: "s-1", currency: "CNY", itemCount: 4, totalAmount: "100.0000" }],
      });
      return apiOk([]);
    });
    render(<PlanDetailSheet planId="plan-1" materials={materials} units={units} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} />);
    await screen.findByRole("button", { name: "保存计划" });

    expect(screen.getByTestId("plan-merge-into-s-1").textContent).toContain("并入 PO-EXISTING");
    expect(screen.getByTestId("plan-merge-into-s-1").textContent).toContain("已有 4 行");
    expect(screen.queryByTestId("plan-merge-new-s-1")).toBeNull();
  });

  it("收束预览：没有可并入的单时明写「新建一张」（不静默地有时候并、有时候不并）", async () => {
    renderSheet({ items: [planItem({ supplierId: "s-1" })] });
    await screen.findByRole("button", { name: "保存计划" });

    expect(screen.getByTestId("plan-merge-new-s-1").textContent).toContain("新建一张");
    expect(screen.queryByTestId("plan-merge-into-s-1")).toBeNull();
  });

  it("币种对不上时不算「能并入」：同一家但 USD 组没有可并入的单", async () => {
    stubApi((url, call) => {
      if (url.includes("/purchase-orders/bom-item-status")) return apiOk([]);
      if (url.includes("/inventory/raw-material-balances")) return apiOk([]);
      if (url.endsWith("/suppliers") && call.method === "GET") return apiOk(suppliers);
      if (url.includes("/purchase-plans/plan-1")) return apiOk({
        ...planDetail([planItem({ supplierId: "s-1" })]),
        openPurchaseOrders: [{ id: "po-1", purchaseOrderNo: "PO-CNY", supplierId: "s-1", currency: "CNY", itemCount: 4, totalAmount: "100.0000" }],
      });
      return apiOk([]);
    });
    render(<PlanDetailSheet planId="plan-1" materials={materials} units={units} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} />);
    await screen.findByRole("button", { name: "保存计划" });

    // 默认组币种是 CNY → 就是那张 PO-CNY
    expect(screen.getByTestId("plan-merge-into-s-1").textContent).toContain("PO-CNY");
    // 改成美元之后，那张人民币的单**不再是**落点（一张单只能有一个币种）
    await userEvent.click(within(screen.getByTestId("plan-group-s-1")).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: /美元/ }));

    expect(screen.getByTestId("plan-merge-new-s-1").textContent).toContain("新建一张");
    expect(screen.queryByTestId("plan-merge-into-s-1")).toBeNull();
  });

  it("下单成功的提示分开说「并入了哪张单」与「新建了哪张单」（落点是两件不同的事）", async () => {
    const calls = renderSheet({
      items: [planItem({ supplierId: "s-1" })],
      onOrder: () => apiOk({ orders: [{ purchaseOrderNo: "PO-EXISTING", merged: true, lineCount: 1 }] }),
    });
    await screen.findByRole("button", { name: "保存计划" });

    await userEvent.click(screen.getByTestId("plan-order"));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/purchase-plans/plan-1/order"))).toBe(true));
    expect(await screen.findByText(/并入 PO-EXISTING（1 行）/)).toBeTruthy();
  });
});

describe("采购计划明细：不在物料池里的物料/单位仍要显示这一行的名字（用户 2026-09-30）", () => {
  /**
   * 用户原话：「采购计划那边，要展示相应的采购物料啊，有的地方没有显示相应的采购物料。」
   *
   * 真正会"有的行没有显示"的场景：物料被停用 / 软删 / 改成成品之后就不在 `GET /materials` 里了，
   * 而 Radix 的 `SelectValue` 只在选项列表里找得到对应项时才显示文字 —— 找不到就退回
   * 占位符「请选择物料」。计划里明明记着物料的那一格于是看起来是空的（像漏买了这个部件），
   * 而服务端的 `get()` 其实已经把物料名从快照里兜回来了。
   */
  const staleItem = planItem({ materialId: "m-gone", materialCode: "M-900", materialName: "停用的面料", unitId: "u-gone", unitName: "卷" });
  const renderStale = () => {
    stubSheet({ items: [staleItem] });
    render(<PlanDetailSheet planId="plan-1" materials={materials} units={units} onClose={() => undefined} onSaved={() => undefined} onDeleted={() => undefined} />);
  };

  it("名称格与单位格显示这一行的值（不再是「请选择物料」/ 空单位）", async () => {
    renderStale();
    await screen.findByRole("button", { name: "保存计划" });

    const row = screen.getByTestId("plan-row-0");
    // 行内顺序：物料下拉 → 单位下拉 → 供应商下拉（收起态都是 combobox）
    const triggers = within(row).getAllByRole("combobox") as HTMLButtonElement[];
    expect(triggers[0].textContent).toContain("停用的面料");
    expect(triggers[0].textContent).toContain("M-900");
    expect(triggers[1].textContent).toContain("卷");
    expect(within(row).queryByText("请选择物料")).toBeNull();
  });

  it("补回来的那一项是 disabled：显示得出来，但选不到别的行上（服务端也会拒）", async () => {
    renderStale();
    await screen.findByRole("button", { name: "保存计划" });

    await userEvent.click(within(screen.getByTestId("plan-row-0")).getAllByRole("combobox")[0]);
    const option = await screen.findByRole("option", { name: /停用的面料/ });

    expect(option.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("采购计划明细：行总价与按币种分列的计划合计（用户 2026-09-30）", () => {
  /**
   * 用户原话：「针对当前的采购计划，要求添加价格字段，单价，总价。不然财务没法付钱。」
   *
   * 单价本来就有（第 8 列），缺的是**总价**。这里钉住三件事：
   *   1. 行总价 = 数量 × 单价，且是**本地即时算**的（改一次单价就跟着变）；
   *   2. 合计**按币种分列**（金额不跨币种合计）+ 分出「其中未下单」；
   *   3. **单价 0 的行不能下单** —— 应付金额 = 入库数量 × 采购明细单价，0 单价就是 0 元应付，
   *      财务收到一张没法付的单而全链路不报错。前端先拦一次是为了把话说清楚。
   */
  it("行总价 = 数量 × 单价，改单价立刻跟着变（本地即时算，不用等服务端）", async () => {
    renderSheet({ items: [planItem({ quantity: "5.0000", unitPrice: "3.5000" })] });
    await screen.findByRole("button", { name: "保存计划" });

    expect(screen.getByTestId("plan-amount-0").textContent).toBe("17.50");

    // 行内 spinbutton 的顺序：数量、单价（其余是下拉与日期）
    const unitPrice = screen.getAllByRole("spinbutton")[1];
    await userEvent.clear(unitPrice);
    await userEvent.type(unitPrice, "4");

    expect(screen.getByTestId("plan-amount-0").textContent).toBe("20.00");
  });

  it("计划合计按币种分列，并分出「其中未下单」", async () => {
    renderSheet({
      items: [
        planItem({ id: "i-1", quantity: "5.0000", unitPrice: "3.5000", currency: "CNY" }),
        // 已下单的行按那张采购单的币种（美元）计 —— 合计不能把它和人民币加成一个数
        planItem({ id: "i-2", materialId: "m-2", materialName: "伞骨", materialCode: "M-002", quantity: "2.0000", unitPrice: "1.0000", currency: "USD", purchaseOrderItemId: "poi-1", purchaseOrderNo: "PO-1" }),
      ],
    });
    await screen.findByRole("button", { name: "保存计划" });

    const total = screen.getByTestId("plan-total");
    expect(total.textContent).toContain("CNY 17.50");
    expect(total.textContent).toContain("USD 2.00");
    // 「还要花多少钱」= 只有未下单的行（这里是人民币那一行）
    expect(screen.getByTestId("plan-total-unordered").textContent).toBe("CNY 17.50");
  });

  it("单价为 0 的行不能下单：直接拦住并说明，**不发**下单请求（2026-10-11：不再有「价格待定」放行）", async () => {
    const calls = renderSheet({ items: [planItem({ quantity: "5.0000", unitPrice: "0.0000", supplierId: "s-1" })] });
    await screen.findByRole("button", { name: "保存计划" });

    await userEvent.click(screen.getByTestId("plan-order"));

    // 用户 2026-10-11：「确定单价的能下单，没确定单价的先不下单」——
    // 所以这里没有"确认后照样下单"的出路了，只有"先去填单价"。
    // 断言限定在错误条里：页面上别处也有"第 1 行"这类文字，整页查会撞成多个命中。
    expect(await screen.findByText(/都还没有单价/)).toBeTruthy();
    expect(await screen.findByTestId("plan-error")).toHaveTextContent("第 1 行");
    expect(calls.some((call) => call.url.endsWith("/purchase-plans/plan-1/order"))).toBe(false);
  });

  it("单价 0 的行在表里标红（漏填报价最快的入口）", async () => {
    renderSheet({ items: [planItem({ unitPrice: "0.0000" }), planItem({ id: "i-2", materialId: "m-2", quantity: "2.0000", unitPrice: "1.5000" })] });
    await screen.findByRole("button", { name: "保存计划" });

    expect(screen.getByTestId("plan-amount-0").className).toContain("status-danger");
    expect(screen.getByTestId("plan-amount-1").className).not.toContain("status-danger");
    expect(screen.getByTestId("plan-amount-1").textContent).toBe("3.00");
  });
});

describe("采购计划明细：按 BOM 参考单价回填（用户 2026-10-08 第二轮）", () => {
  /**
   * 用户原话：「为什么BOM表保存了单价之后，采购计划显示不了单价，下单不了」。
   *
   * 根因：计划的明细是**建立时的快照**，从 BOM 预填单价只发生在"新建计划那一刻"——
   * 先建计划、后去 BOM 填价的人，计划永远停在 0 价，而 0 价不能下单。
   *
   * 修法：详情接口把**当前 BOM 的参考单价**随行下发，前端对「未下单 + 单价还是 0 + BOM 上有 > 0 的价」
   * 的行预填；只写进界面状态（`priceFromBom` 标出来源 + 面板说明），**点保存才落库**。
   * 谈过价的行、已下单的行一律不动 —— 那才是"跟供应商谈定了什么"。
   */
  it("未下单 + 单价 0 + BOM 上有参考价 → 自动带回那一格（含币种），并说明来源", async () => {
    renderSheet({
      items: [planItem({ unitPrice: "0.0000", bomReferenceUnitPrice: "12.5000", bomReferenceCurrency: "USD" })],
    });
    await screen.findByRole("button", { name: "保存计划" });

    const price = screen.getByTestId("plan-price-0");
    expect(price).toHaveValue(12.5);
    expect(price.closest("td")?.className).toContain("plan-price-from-bom");
    expect(price.getAttribute("title")).toContain("BOM");
    // 币种跟着这一格里的价走：预填的是美元价，留着人民币会让合计说谎
    expect(screen.getByTestId("plan-total").textContent).toContain("USD 62.50");
    // 页面上必须说清来源与"还没保存"，否则会被当成供应商报价
    const note = screen.getByTestId("plan-price-from-bom");
    expect(note.textContent).toContain("1 行");
    expect(note.textContent).toContain("参考单价");
    expect(note.textContent).toContain("保存计划后才会写进计划");
  });

  it("不改动谈过价的行（单价 > 0 时 BOM 参考价只是陪跑，不覆盖）", async () => {
    renderSheet({ items: [planItem({ unitPrice: "3.5000", bomReferenceUnitPrice: "12.5000", bomReferenceCurrency: "USD" })] });
    await screen.findByRole("button", { name: "保存计划" });

    expect(screen.getByTestId("plan-price-0")).toHaveValue(3.5);
    expect(screen.getByTestId("plan-price-0").closest("td")?.className).not.toContain("plan-price-from-bom");
    expect(screen.queryByTestId("plan-price-from-bom")).toBeNull();
  });

  it("已下单的行不预填（服务端把那些行硬锁，预填等于制造一次注定被拒的保存）", async () => {
    renderSheet({
      items: [planItem({ unitPrice: "0.0000", purchaseOrderItemId: "poi-1", purchaseOrderNo: "PO-1", bomReferenceUnitPrice: "12.5000", bomReferenceCurrency: "USD" })],
    });
    await screen.findByRole("button", { name: "保存计划" });

    expect(screen.getByTestId("plan-price-0")).toHaveValue(0);
    expect(screen.queryByTestId("plan-price-from-bom")).toBeNull();
  });

  it("BOM 上没填参考价（或填了 0）→ 不预填、也不出说明", async () => {
    renderSheet({ items: [planItem({ unitPrice: "0.0000", bomReferenceUnitPrice: null, bomReferenceCurrency: null })] });
    await screen.findByRole("button", { name: "保存计划" });

    expect(screen.getByTestId("plan-price-0")).toHaveValue(0);
    expect(screen.queryByTestId("plan-price-from-bom")).toBeNull();
  });

  it("用户一改那一格，标记就消失（这一格从此是他填的），保存时发出去的就是他改的值", async () => {
    const calls = renderSheet({ items: [planItem({ unitPrice: "0.0000", supplierId: "s-1", bomReferenceUnitPrice: "12.5000", bomReferenceCurrency: "USD" })] });
    await screen.findByRole("button", { name: "保存计划" });

    const price = screen.getByTestId("plan-price-0");
    await userEvent.clear(price);
    await userEvent.type(price, "9");
    expect(price.closest("td")?.className).not.toContain("plan-price-from-bom");

    await userEvent.click(screen.getByRole("button", { name: "保存计划" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const body = JSON.parse(String(calls.find((call) => call.method === "PATCH")?.body)) as { items: Array<Record<string, unknown>> };
    expect(body.items[0].unit_price).toBe("9");
  });

  it("预填之后可以直接下单：保存带过去的就是 BOM 参考单价（0 价那道路障不再拦它）", async () => {
    const calls = renderSheet({
      items: [planItem({ unitPrice: "0.0000", supplierId: "s-1", bomReferenceUnitPrice: "12.5000", bomReferenceCurrency: "CNY" })],
    });
    await screen.findByRole("button", { name: "保存计划" });

    await userEvent.click(screen.getByRole("button", { name: "保存计划" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const patched = JSON.parse(String(calls.find((call) => call.method === "PATCH")?.body)) as { items: Array<Record<string, unknown>> };
    expect(patched.items[0].unit_price).toBe("12.5");

    await userEvent.click(screen.getByTestId("plan-order"));
    expect(screen.queryByTestId("plan-error")).toBeNull();
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/purchase-plans/plan-1/order"))).toBe(true));
  });

  it("0 价被拦时把出路直接写出来（去哪填、以及留在计划里）", async () => {
    renderSheet({ items: [planItem({ unitPrice: "0.0000", supplierId: "s-1", bomReferenceUnitPrice: null })] });
    await screen.findByRole("button", { name: "保存计划" });

    await userEvent.click(screen.getByTestId("plan-order"));
    // 2026-10-11：0 价的行**不再下单**（留在计划里等补价），所以提示要说清"先去填单价"。
    const note = await screen.findByText(/都还没有单价/);
    expect(note.textContent).toContain("填单价");
    expect(note.textContent).toContain("第 1 行");
  });
});

describe("采购计划列表：一行 = 一条明细（2026-10-13 展平）", () => {
  /**
   * 用户 2026-10-13：「采购计划的那个页面，也要显示物料名称等等 column。都要显示」。
   *
   * 2026-09-27 那一版是「一行 = 一份计划」，只显示计划级信息 —— 想知道"这份计划里到底有哪些
   * 物料、哪条还没买"只能点进去。这一版**展平**成一行一条明细，13 列一次显示。
   *
   * 取舍（口径 7）：计划级汇总（未下单行数 / 计划金额 / 状态 / 最后更新）不再单独成列，
   * 挂在「计划编号」那一格的 `title` 上 —— 与 13 个明细列挤在同一张表里会变成 20+ 列。
   */
  const planLine = (overrides: Record<string, unknown> = {}) => ({
    id: "l-1", materialId: "m-1", materialCode: "M-001", materialName: "面料A", model: "A-1",
    unitName: "米", quantity: "5.0000", unitPrice: "3.5000", amount: "17.5000", currency: "CNY",
    supplierId: "s-1", supplierName: "宁波辅料厂", expectedDate: null, ordered: false, purchaseOrderNo: null,
    ...overrides,
  });
  const planSummary = (overrides: Record<string, unknown> = {}) => ({
    id: "plan-1", planNo: "PP-1", orderNo: "DL260001-1", itemNo: "27621", customerName: "流水花扇客户",
    bomId: "bom-1", bomVersion: 3, lineCount: 2, unorderedCount: 1, orderedCount: 1,
    amounts: [{ currency: "CNY", amount: "22.0000" }], unorderedAmounts: [{ currency: "CNY", amount: "4.0000" }],
    status: "partial", statusLabel: "部分下单", updatedByName: "张三",
    createdAt: "2026-09-27T01:00:00Z", updatedAt: "2026-09-27T02:00:00Z",
    lines: [planLine({ id: "l-1", ordered: true, purchaseOrderNo: "PO-20261001-1" }), planLine({ id: "l-2", materialId: "m-2", materialCode: "M-002", materialName: "伞骨", model: "", quantity: "2.0000", unitPrice: "2.0000", amount: "4.0000" })],
    ...overrides,
  });
  const stubList = (plans: Array<Record<string, unknown>>, candidates: Array<Record<string, unknown>> = []) => stubApi((url) => {
    if (url.includes("/purchase-plans/candidates")) return apiOk(candidates);
    if (url.includes("/purchase-plans")) return apiOk(plans);
    if (url.endsWith("/materials")) return apiOk(materials);
    if (url.endsWith("/units")) return apiOk(units);
    return apiOk({});
  });

  it("13 列都在、顺序固定：计划编号/销售单号/货号/客户/物料名称/型号/单位/本次采购量/单价/行总价/供应商/下单状态/预计到货", async () => {
    route.searchParams = new URLSearchParams();
    stubList([planSummary()]);
    render(<PurchasePlansPage />);
    await screen.findByTestId("page-procurement-plans");
    await waitFor(() => expect(screen.getAllByTestId("data-table-row").length).toBe(2));

    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent?.trim())).toEqual([
      "计划编号", "销售单号", "货号", "客户", "物料名称", "型号", "单位", "本次采购量", "单价", "行总价", "供应商", "下单状态", "预计到货",
    ]);
  });

  it("两行明细 = 两行；每行都带上物料名称/数量/单价/行总价/供应商/下单状态（含落在哪张 PO）", async () => {
    route.searchParams = new URLSearchParams();
    stubList([planSummary()]);
    render(<PurchasePlansPage />);
    await waitFor(() => expect(screen.getAllByTestId("data-table-row").length).toBe(2));

    // 第一行：已下单（要看得见落在哪张采购单上）
    const first = screen.getAllByTestId("data-table-row")[0];
    expect(within(first).getByText("面料A")).toBeTruthy();
    expect(within(first).getByText("17.50")).toBeTruthy();
    expect(within(first).getByText("宁波辅料厂")).toBeTruthy();
    expect(within(first).getByText("PO-20261001-1")).toBeTruthy();

    // 第二行：未下单（伞骨 2 × 2.00 = 4.00）
    const second = screen.getAllByTestId("data-table-row")[1];
    expect(within(second).getByText("伞骨")).toBeTruthy();
    expect(within(second).getByText("4.00")).toBeTruthy();
    expect(within(second).getByText("未下单")).toBeTruthy();

    // 同一份计划的两行都重复显示头部信息（展平的代价，用户已确认；换来的是"哪条还没买"一眼可见）
    expect(within(first).getByText("PP-1")).toBeTruthy();
    expect(within(second).getByText("PP-1")).toBeTruthy();
  });

  it("物料名称那一格 hover 能看到物料编码（13 列里没有编码的位置，但信息不能丢）", async () => {
    route.searchParams = new URLSearchParams();
    stubList([planSummary({ lines: [planLine({ materialCode: "M-001", materialName: "面料A" })] })]);
    render(<PurchasePlansPage />);
    await waitFor(() => expect(screen.getAllByTestId("data-table-row").length).toBe(1));

    expect(screen.getByText("面料A").getAttribute("title")).toBe("M-001 / 面料A");
  });

  it("计划级汇总挂在「计划编号」的 title 上（未下单行数 / 计划金额 / 最后更新人 + 北京时间）", async () => {
    route.searchParams = new URLSearchParams();
    stubList([planSummary()]);
    render(<PurchasePlansPage />);
    await waitFor(() => expect(screen.getAllByTestId("data-table-row").length).toBe(2));

    const title = screen.getAllByText("PP-1")[0].getAttribute("title") ?? "";
    expect(title).toContain("未下单 1 / 共 2 行");
    expect(title).toContain("计划金额 CNY 22.00（其中未下单 CNY 4.00）");
    // 时间固定北京时间（`lib/audit-time`）：02:00Z → 10:00
    expect(title).toContain("最后更新 张三 09-27 10:00");
  });

  it("一行明细都没有的计划**不会凭空消失**：补一行占位（它唯一的入口就是这一页）", async () => {
    route.searchParams = new URLSearchParams();
    stubList([planSummary({ planNo: "PP-EMPTY", lineCount: 0, unorderedCount: 0, orderedCount: 0, amounts: [], unorderedAmounts: [], status: "unordered", statusLabel: "未下单", lines: [] })]);
    render(<PurchasePlansPage />);

    expect(await screen.findByText("PP-EMPTY")).toBeTruthy();
    expect(screen.getByText("（这份计划一行都没有）")).toBeTruthy();
  });

  it("单价 0 的行在列表里也标红（0 价不下单，与详情表同一口径）", async () => {
    route.searchParams = new URLSearchParams();
    stubList([planSummary({ lines: [planLine({ id: "l-1", unitPrice: "0.0000", amount: "0.0000" }), planLine({ id: "l-2", materialName: "伞骨", unitPrice: "2.0000", amount: "4.0000" })] })]);
    render(<PurchasePlansPage />);
    await waitFor(() => expect(screen.getAllByTestId("data-table-row").length).toBe(2));

    expect(screen.getAllByTestId("data-table-row")[0].className).not.toContain("status-danger");
    expect(within(screen.getAllByTestId("data-table-row")[0]).getByText("0").className).toContain("status-danger");
  });

  it("点计划编号打开那份计划（展平后它是唯一的入口，没有单独的「操作」列）", async () => {
    route.searchParams = new URLSearchParams();
    stubApi((url, call) => {
      // ⚠️ 顺序：详情路径 `/purchase-plans/plan-1` 也命中 `includes("/purchase-plans")`，
      // 所以更具体的先判。
      if (url.includes("/purchase-plans/candidates")) return apiOk([]);
      if (url.includes("/purchase-plans/plan-1")) return apiOk(planDetail([planItem()]));
      if (url.includes("/purchase-plans")) return apiOk([planSummary({ lines: [planLine()] })]);
      if (url.includes("/purchase-orders/bom-item-status")) return apiOk([]);
      if (url.includes("/inventory/raw-material-balances")) return apiOk([]);
      if (url.endsWith("/suppliers") && call.method === "GET") return apiOk(suppliers);
      if (url.endsWith("/materials")) return apiOk(materials);
      if (url.endsWith("/units")) return apiOk(units);
      return apiOk([]);
    });
    render(<PurchasePlansPage />);
    const open = await screen.findAllByTestId("plan-open");

    expect(open[0].getAttribute("data-plan-no")).toBe("PP-1");
    await userEvent.click(open[0]);

    expect(await screen.findByText(/PP-20260927-AAAA1111/)).toBeTruthy();
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

/**
 * 「为什么选不到这张 BOM」（2026-11-12）。
 *
 * 用户原话：「采购计划有时候无法选中需要建立采购计划的BOM表」。
 * 审计（`docs/audit/procurement-audit-2026-11-12.md` §1.1 A7）指出：候选接口把不可建的 BOM
 * 静默滤掉，界面上只剩一个**空下拉**，用户看不到任何原因 —— 这就是"业务规则不明确"的典型形态。
 *
 * 现在接口把被拦下的那半边放在 `meta.blocked`，新建弹窗必须把它说出来，
 * 并且在「已有计划」时给出计划编号与出口（去那份计划里加一行）。
 */
describe("采购计划列表：新建弹窗说清「为什么选不到这张 BOM」", () => {
  const blockedEntry = (overrides: Record<string, unknown> = {}) => ({
    bomId: "bom-b1", orderNo: "DL260011-1", bomVersion: 1, itemNo: "27621", customerName: "客户乙", itemCount: 6,
    reasons: [{ code: "PLAN_ALREADY_EXISTS", message: "该 BOM 已有采购计划 PP-20260927-ZZZZ9999（已完成）：补料请打开这份计划、加一行，不要另建一份" }],
    existingPlan: { id: "plan-7", planNo: "PP-20260927-ZZZZ9999", status: "completed", statusLabel: "已完成" },
    ...overrides,
  });
  const stubCandidates = (candidates: Array<Record<string, unknown>>, blocked: Array<Record<string, unknown>>) => stubApi((url) => {
    if (url.includes("/purchase-plans/candidates")) return apiOk(candidates, { blocked });
    if (url.endsWith("/materials")) return apiOk(materials);
    if (url.endsWith("/units")) return apiOk(units);
    return apiOk([]);
  });

  it("已有计划被拦时，弹窗里看得到计划编号与「去那份计划加一行」这个出口", async () => {
    route.searchParams = new URLSearchParams();
    stubCandidates([], [blockedEntry()]);
    render(<PurchasePlansPage />);
    await screen.findByTestId("plan-create");

    await userEvent.click(screen.getByTestId("plan-create"));

    const shown = await screen.findByText(/已有采购计划 PP-20260927-ZZZZ9999/);
    expect(shown.textContent).toContain("加一行");
  });

  it("被拦下的 BOM 太多时只摆前三条（弹窗不是报表）", async () => {
    route.searchParams = new URLSearchParams();
    stubCandidates([], [1, 2, 3, 4].map((index) => blockedEntry({ bomId: `bom-b${index}`, orderNo: `DL26001${index}-1` })));
    render(<PurchasePlansPage />);
    await screen.findByTestId("plan-create");

    await userEvent.click(screen.getByTestId("plan-create"));

    await screen.findAllByText(/已有采购计划/);
    expect(screen.getAllByText(/已有采购计划/)).toHaveLength(3);
  });

  it("一张都没被拦时不摆原因（没有噪音）", async () => {
    route.searchParams = new URLSearchParams();
    stubCandidates([{ bomId: "bom-ok", orderNo: "DL260001-1", bomVersion: 1, itemNo: null, customerName: null, deliveryDate: null, itemCount: 2 }], []);
    render(<PurchasePlansPage />);
    await screen.findByTestId("plan-create");

    await userEvent.click(screen.getByTestId("plan-create"));

    expect(screen.queryByText(/已有采购计划/)).toBeNull();
    expect(screen.queryByText(/不能建计划/)).toBeNull();
  });

  it("能建的和不能建的都没有时，下拉占位符说清是「真的没有」", async () => {
    route.searchParams = new URLSearchParams();
    stubCandidates([], []);
    render(<PurchasePlansPage />);
    await screen.findByTestId("plan-create");

    await userEvent.click(screen.getByTestId("plan-create"));

    expect(await screen.findByText("没有可建计划的 BOM")).toBeTruthy();
  });
});

