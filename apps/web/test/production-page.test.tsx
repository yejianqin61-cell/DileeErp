// app/production/page.tsx（生产单列表页）的**行为**测试：真实渲染 + 真实点击 + 断言真实发出的请求。
//
// 纪律：不 readFileSync、不正则匹配源码、不断言 className；只断言**渲染出的文本 + 可见性/禁用态 + 网络调用**。
// 每条断言都对着"能被真实回归打红"的事实：
//   - 5 个列表接口的完整 URL（少一个 / 路径写错 → 红）；
//   - 可见行的过滤字段（订单号 / 生产单号 / 状态原值）与计数（去掉任一字段 → 红）；
//   - 建单 POST 的完整 body（字段改名、BOM 取旧版本、单位解析退化 → 红）；
//   - 行内「启动」的 method + /:id/transition 路径 + body（改成集合根或 PATCH → 红）。
//
// 只 mock 框架上下文 next/navigation（useRouter / useSearchParams 在 App Router 之外没有实现，
// 且深链与跳转目标正是被测行为），与 test/material-slip-editor.test.tsx 同一做法；
// 子组件与 API 一律真实：API 走 helpers/api-stub 的 fetch 桩（禁止 vi.mock 模块）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProductionPage from "../app/production/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 深链 ?order_no= 的桩：每个用例的 beforeEach 重置为空。 */
let mockSearchParams = new URLSearchParams();
const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => "/production",
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

/** 页面 useEffect 里 Promise.all 的 6 个 GET（前缀是 api-client 拼的 /api/v1）。 */
const EP = {
  sales: "/api/v1/sales-orders?status=confirmed&page=1&page_size=200",
  locations: "/api/v1/production/locations",
  operations: "/api/v1/production/operations",
  orders: "/api/v1/production/orders",
  units: "/api/v1/units",
  // BOM 表由采购与生产共同维护：本页要能用物料池打开/新建 BOM（lib 里的候选提示也指向本页入口）。
  materials: "/api/v1/materials",
} as const;
const ALL_LISTS = Object.values(EP);

// ---------------------------------------------------------------- 测试数据（形状对齐后端）

type SalesOrder = { id?: string; orderNo: string; quantity: string; unit?: string; status: string; boms: Array<{ id: string; version: number; status?: string }> };
type LocationRow = { id: string; name: string; locationType: "workshop" | "outsource_site"; isActive: boolean };
type OperationRow = { id: string; operationName: string; defaultUnitId?: string | null; isActive: boolean };
type UnitRow = { id: string; name: string; isActive: boolean };
type OrderRow = {
  id: string;
  productionOrderNo: string;
  orderNo: string;
  executionMode: "in_house" | "outsourced";
  status: string;
  plannedQuantity: string;
  executionLocation?: { name: string } | null;
  operations: Array<{ id: string; operationNameSnapshot: string; targetQuantity: string; status: string }>;
};

/** 已确认 + 已建 BOM：唯一能出现在「订单号」下拉里的形状。 */
const candidate = (orderNo: string, quantity: string, unit?: string, boms: SalesOrder["boms"] = [{ id: `bom-${orderNo}`, version: 1 }]): SalesOrder => ({ id: `so-${orderNo}`, orderNo, quantity, unit, status: "confirmed", boms });
/** 已确认但没建 BOM：候选里必然缺席，且必须给出原因说明。 */
const awaitingBom = (orderNo: string, quantity = "80"): SalesOrder => ({ id: `so-${orderNo}`, orderNo, quantity, status: "confirmed", boms: [] });

const workshopLocation: LocationRow = { id: "loc-1", name: "一号车间", locationType: "workshop", isActive: true };
const outsourceSiteLocation: LocationRow = { id: "loc-2", name: "协作厂", locationType: "outsource_site", isActive: true };
const inactiveLocation: LocationRow = { id: "loc-9", name: "已停用车间", locationType: "workshop", isActive: false };

const inHouseDraft: OrderRow = {
  id: "po-1",
  productionOrderNo: "MO-2026-001",
  orderNo: "SO-2026-001",
  executionMode: "in_house",
  status: "draft",
  plannedQuantity: "120",
  executionLocation: { name: "一号车间" },
  operations: [
    { id: "opr-1", operationNameSnapshot: "裁剪", targetQuantity: "120", status: "active" },
    { id: "opr-2", operationNameSnapshot: "缝制", targetQuantity: "110", status: "active" },
  ],
};
const outsourcedInProgress: OrderRow = {
  id: "po-2",
  productionOrderNo: "MO-2026-002",
  orderNo: "SO-2026-002",
  executionMode: "outsourced",
  status: "in_progress",
  plannedQuantity: "50",
  executionLocation: null,
  operations: [],
};

// ---------------------------------------------------------------- 桩与辅助函数

type Handler = (url: string, call: StubbedCall) => Response | Promise<Response> | undefined;

type Fixture = {
  salesOrders?: SalesOrder[];
  locations?: LocationRow[];
  operations?: OperationRow[];
  records?: OrderRow[];
  units?: UnitRow[];
  materials?: Array<{ id: string; materialCode?: string; name: string; materialType?: string; isActive?: boolean }>;
  boms?: Record<string, unknown>;
};

/**
 * 桩：6 个 GET 各回自己那一份数据（默认空），变更类请求默认成功（apiOk({})），
 * 未打桩的 GET 直接 404 —— 免得页面多打一个接口时被静默当成空数据。
 * extra 优先执行，用于注入 403 / 409 / 搜索端点等特例。
 */
function stubProduction(fixture: Fixture = {}, extra?: Handler) {
  return stubApi((url, call) => {
    const injected = extra?.(url, call);
    if (injected) return injected;
    if (url.endsWith(EP.sales)) return apiOk(fixture.salesOrders ?? []);
    if (url.endsWith(EP.locations)) return apiOk(fixture.locations ?? []);
    if (url.endsWith(EP.operations)) return apiOk(fixture.operations ?? []);
    if (url.endsWith(EP.orders)) return apiOk(fixture.records ?? []);
    if (url.endsWith(EP.units)) return apiOk(fixture.units ?? []);
    if (url.endsWith(EP.materials)) return apiOk(fixture.materials ?? []);
    // BOM 详情：生产页的 BOM 工作区会 GET /boms/:id
    const bom = /\/boms\/([^/]+)$/.exec(url);
    if (bom && call.method === "GET") return apiOk(fixture.boms?.[bom[1]] ?? { id: bom[1], orderNo: "", status: "draft", version: 1, updatedAt: "2026-09-14T02:00:00.000Z", items: [] });
    if (call.method !== "GET") return apiOk({});
    return apiErr(404, "NOT_FOUND", `测试未打桩的请求：${url}`);
  });
}

/** 渲染生产单列表页（连带 Toaster：动作结果只经 toast 呈现）。 */
function renderProduction() {
  return render(
    <>
      <ProductionPage />
      <Toaster />
    </>
  );
}

/** 渲染并等到加载完成（三个业务面板都在了）。 */
async function openProduction() {
  renderProduction();
  await screen.findByRole("heading", { name: "生产单查找" });
}

/** 取本页生产单表的行（空态时 data-table 整个不渲染，只能 queryAll）。 */
function rows() {
  return within(screen.getByTestId("production-order-table")).queryAllByTestId("data-table-row");
}

function rowFor(text: string) {
  const row = rows().find((item) => item.textContent?.includes(text));
  if (!row) throw new Error(`未找到包含「${text}」的生产单行`);
  return row;
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const getsTo = (calls: StubbedCall[], url: string) => callsTo(calls, url).filter((call) => call.method === "GET");
const postsTo = (calls: StubbedCall[], url: string) => callsTo(calls, url).filter((call) => call.method === "POST");
const searchInput = () => screen.getByPlaceholderText("输入关键词");

/** 打开「新建生产单」对话框（打开时页面会再拉一次 /sales-orders 作为最新候选）。 */
async function openCreateDialog() {
  await openProduction();
  await userEvent.click(screen.getByTestId("production-create-order"));
  await screen.findByTestId("action-dialog");
}

async function pickOrder(label: string) {
  const trigger = screen.getByTestId("action-field-order_no").querySelector("button");
  if (!trigger) throw new Error("订单号下拉没有触发按钮");
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

async function pickLocation(label: string) {
  await userEvent.click(screen.getByTestId("action-field-execution_location_id"));
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockSearchParams = new URLSearchParams();
});

describe("生产单列表页：加载门禁与列表接口契约", () => {
  it("数据未返回时只有加载态：入口禁用、业务面板与表格都不存在；完成后 6 个接口各被 GET 一次（完整 URL）", async () => {
    const gate = deferred<Response>();
    const calls = stubApi((url) => (url.endsWith(EP.orders) ? gate.promise : apiOk([])));

    renderProduction();

    expect(screen.getByTestId("loading-state")).toBeVisible();
    // 本页根节点（app/production/page.tsx:124）是无条件渲染的外壳，真正的门禁在内容与入口上：
    expect(screen.getByTestId("page-production")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "生产单查找" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "生产基础资料" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "生产工序导出表" })).toBeNull();
    expect(screen.queryByTestId("data-table")).toBeNull();
    // 建单入口在基础资料到达前必须禁用（否则对话框会快照进空的「执行地点」下拉）
    expect(screen.getByTestId("production-create-order")).toBeDisabled();

    gate.resolve(apiOk([]));

    expect(await screen.findByRole("heading", { name: "生产单查找" })).toBeVisible();
    await waitFor(() => expect(calls).toHaveLength(ALL_LISTS.length));
    expect(calls.map((call) => call.url).sort()).toEqual([...ALL_LISTS].sort());
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(screen.getByTestId("production-create-order")).toBeEnabled();
    expect(screen.queryByTestId("loading-state")).toBeNull();
  });

  it("某接口 403：呈现后端 message、不渲染任何数据表；点「重新加载」后恢复渲染并重新请求", async () => {
    let failing = true;
    const calls = stubProduction({ records: [inHouseDraft] }, (url) => {
      if (url.endsWith(EP.orders) && failing) {
        failing = false;
        return apiErr(403, "FORBIDDEN", "无权查看生产单");
      }
      return undefined;
    });

    renderProduction();

    expect(await screen.findByTestId("error-state")).toHaveTextContent("无权查看生产单");
    // 加载失败不能退化成"正常空表"：表格与行都不该出现
    expect(screen.queryByTestId("data-table")).toBeNull();
    expect(screen.queryByText("MO-2026-001")).toBeNull();
    expect(screen.queryByRole("heading", { name: "生产单查找" })).toBeNull();

    await userEvent.click(screen.getByTestId("error-state-retry"));

    expect(await screen.findByRole("heading", { name: "生产单查找" })).toBeVisible();
    expect(screen.queryByTestId("error-state")).toBeNull();
    expect(rowFor("MO-2026-001")).toBeVisible();
    expect(getsTo(calls, EP.orders)).toHaveLength(2);
  });
});

describe("生产单列表页：行渲染、计数与搜索过滤", () => {
  it("行渲染：执行方式中文化、地点缺失回落 -、工序名拼接、状态被映射为中文而不是后端原值", async () => {
    stubProduction({ records: [inHouseDraft, outsourcedInProgress] });
    await openProduction();

    expect(rows()).toHaveLength(2);

    const inHouse = rowFor("MO-2026-001");
    expect(inHouse).toHaveTextContent("SO-2026-001");
    // 执行方式列自己拼中文（in_house → 厂内）；若改成 displayText 会变成「厂内生产」整词
    expect(inHouse).toHaveTextContent("厂内");
    expect(inHouse).not.toHaveTextContent("厂内生产");
    expect(inHouse).toHaveTextContent("一号车间");
    expect(inHouse).toHaveTextContent("120");
    expect(inHouse).toHaveTextContent("裁剪、缝制");
    // 状态列经 DataTable 的 displayText 落成中文（draft → 草稿），英文原值不再透给用户
    expect(inHouse).toHaveTextContent("草稿");
    expect(inHouse).not.toHaveTextContent("draft");

    const outsourced = rowFor("MO-2026-002");
    expect(outsourced).toHaveTextContent("外加工");
    // 缺少 executionLocation 时回落为 -
    expect(outsourced).toHaveTextContent("-");
    expect(outsourced).toHaveTextContent("50");
    expect(outsourced).toHaveTextContent("进行中");
    expect(outsourced).not.toHaveTextContent("in_progress");

    expect(screen.getByRole("heading", { name: "生产工序导出表" })).toBeVisible();
  });

  it("工序为空的生产单在「工序」列显示「未配置」", async () => {
    stubProduction({ records: [outsourcedInProgress] });
    await openProduction();

    expect(rowFor("MO-2026-002")).toHaveTextContent("未配置");
  });

  it("搜索按生产单号 / 订单号 / 状态原值过滤，清空后恢复全量", async () => {
    stubProduction({ records: [inHouseDraft, outsourcedInProgress] });
    await openProduction();

    await userEvent.type(searchInput(), "SO-2026-002");
    expect(rows()).toHaveLength(1);
    expect(rowFor("MO-2026-002")).toBeVisible();

    await userEvent.clear(searchInput());
    await userEvent.type(searchInput(), "MO-2026-001");
    expect(rows()).toHaveLength(1);
    expect(rowFor("MO-2026-001")).toBeVisible();

    // 过滤串里必须含 status（去掉它就只剩单号可搜）
    await userEvent.clear(searchInput());
    await userEvent.type(searchInput(), "draft");
    expect(rows()).toHaveLength(1);
    expect(rowFor("MO-2026-001")).toBeVisible();

    await userEvent.clear(searchInput());
    expect(rows()).toHaveLength(2);

    await userEvent.type(searchInput(), "不存在的单号");
    expect(rows()).toHaveLength(0);
    expect(screen.getByText("暂无生产单")).toBeVisible();
  });

  it("KNOWN_DEFECT：按界面上显示的中文状态搜索返回空结果（过滤用的是后端英文枚举）", async () => {
    stubProduction({ records: [inHouseDraft, outsourcedInProgress] });
    await openProduction();

    // 前提：状态列对用户显示的就是中文「草稿」（displayText 映射，见上一条用例）
    expect(rowFor("MO-2026-001")).toHaveTextContent("草稿");

    await userEvent.type(searchInput(), "草稿");

    // 期望：标签写的是「搜索生产单、订单号或状态」，用户输入界面上看到的状态「草稿」应命中该行。
    // 实际：visible 的过滤串是 `${productionOrderNo} ${orderNo} ${status}`，status 为后端原值 "draft"，
    //      中文「草稿」匹配不到任何一行 → 表格回落到空态「暂无生产单」，用户会以为生产单不存在。
    // 责任文件：app/production/page.tsx:64（过滤器直接拼接 item.status，未用显示值 displayText）。
    expect(rows()).toHaveLength(0);
    expect(screen.getByText("暂无生产单")).toBeVisible();
  });

  it("深链 ?order_no= 预填搜索框并立即过滤列表", async () => {
    mockSearchParams = new URLSearchParams("order_no=SO-2026-002");
    stubProduction({ records: [inHouseDraft, outsourcedInProgress] });
    await openProduction();

    expect((searchInput() as HTMLInputElement).value).toBe("SO-2026-002");
    expect(rows()).toHaveLength(1);
    expect(rowFor("MO-2026-002")).toBeVisible();
  });

  it("生产基础资料：只统计启用项（工序/地点/单位），并给出各管理页入口的真实 href", async () => {
    stubProduction({
      operations: [
        { id: "op-1", operationName: "裁剪", isActive: true },
        { id: "op-2", operationName: "已停用工序", isActive: false },
      ],
      locations: [workshopLocation, inactiveLocation],
      units: [
        { id: "u-1", name: "打", isActive: true },
        { id: "u-2", name: "个", isActive: false },
      ],
    });
    await openProduction();

    expect(screen.getByRole("link", { name: "工序池（1 个启用）" })).toHaveAttribute("href", "/production/operations");
    expect(screen.getByRole("link", { name: "加工地点池（1 个启用）" })).toHaveAttribute("href", "/production/locations");
    // 单位池的计数只含 isActive 的单位（停用的「个」不计）
    expect(screen.getByRole("link", { name: "单位池（1 个启用）" })).toHaveAttribute("href", "/production/units");
    expect(screen.getByRole("link", { name: "领料/补料单（按工序）" })).toHaveAttribute("href", "/production/material-issues");
  });

  it("候选为空时说明原因：已确认但缺 BOM 的销售单不被静默丢弃，且下拉里确实没有它", async () => {
    stubProduction({ salesOrders: [awaitingBom("SO-2026-002")], locations: [workshopLocation] });
    await openCreateDialog();

    // Radix 模态对话框会给外部内容加 aria-hidden，此时 role 查询不可见，改按文案断言提示条内容
    expect(screen.getByText("有 1 张已确认销售单尚未建立 BOM（SO-2026-002），请在本页【BOM表】或【采购 → BOM表】为其建立 BOM 后再建生产单。")).toBeVisible();
    // 订单号下拉的占位符也点明"暂无可建生产单的销售单"
    expect(screen.getByText("暂无可建生产单的销售单")).toBeVisible();
    await userEvent.click(screen.getByTestId("action-field-order_no").querySelector("button") as HTMLElement);
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("部分候选被缺 BOM 挡住时给出「另有 N 张…」提示，且下拉里只有已建 BOM 的销售单", async () => {
    stubProduction({
      salesOrders: [candidate("SO-2026-001", "120", "打"), awaitingBom("SO-2026-002"), awaitingBom("SO-2026-003", "60")],
      locations: [workshopLocation],
    });
    await openCreateDialog();

    // 同上：对话框打开时外部内容被 aria-hidden，按文案断言
    expect(screen.getByText("另有 2 张已确认销售单因缺少 BOM 未出现在候选列表中（SO-2026-002、SO-2026-003），可在本页【BOM表】或【采购 → BOM表】建立。")).toBeVisible();

    const trigger = screen.getByTestId("action-field-order_no").querySelector("button") as HTMLElement;
    await userEvent.click(trigger);
    const options = screen.getAllByTestId("searchable-select-option").map((item) => item.textContent);
    expect(options).toEqual(["SO-2026-001 / 120 打"]);
  });

  it("所有销售单都已建 BOM 时不渲染任何提示条", async () => {
    stubProduction({ salesOrders: [candidate("SO-2026-001", "120", "打")], locations: [workshopLocation] });
    await openProduction();

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/缺少 BOM/)).toBeNull();
  });
});

describe("生产单列表页：新建生产单的请求契约", () => {
  it("打开对话框会用最新候选重建下拉：选项标签为「订单号 / 数量 单位」，执行方式默认厂内，地点只含启用项", async () => {
    const calls = stubProduction({
      salesOrders: [candidate("SO-2026-001", "120", "打"), awaitingBom("SO-2026-002")],
      locations: [workshopLocation, outsourceSiteLocation, inactiveLocation],
      units: [{ id: "u-1", name: "打", isActive: true }],
    });
    await openCreateDialog();

    // 打开对话框前会重新拉一次候选（避免用挂载时的旧快照建单）
    expect(getsTo(calls, EP.sales)).toHaveLength(2);

    const trigger = screen.getByTestId("action-field-order_no").querySelector("button") as HTMLElement;
    await userEvent.click(trigger);
    expect(screen.getAllByTestId("searchable-select-option").map((item) => item.textContent)).toEqual(["SO-2026-001 / 120 打"]);

    expect(screen.getByText("厂内生产")).toBeVisible();
    await userEvent.click(screen.getByTestId("action-field-execution_location_id"));
    expect(screen.getByRole("option", { name: "一号车间 / 厂内" })).toBeVisible();
    expect(screen.getByRole("option", { name: "协作厂 / 外加工" })).toBeVisible();
    // 停用地点不出现在可选项里
    expect(screen.queryByRole("option", { name: "已停用车间 / 厂内" })).toBeNull();
  });

  it("提交建单：必填门禁先拦住，再 POST /production/orders，带上最新 BOM 版本与按名称解析的启用单位", async () => {
    const calls = stubProduction({
      salesOrders: [candidate("SO-2026-001", "120", "打", [{ id: "bom-1", version: 1 }, { id: "bom-v9", version: 9 }])],
      locations: [workshopLocation, outsourceSiteLocation],
      units: [
        { id: "u-1", name: "打", isActive: true },
        { id: "u-2", name: "个", isActive: false },
      ],
    });
    await openCreateDialog();

    // 未选订单 → 校验失败且不发请求
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写订单号");
    expect(postsTo(calls, EP.orders)).toHaveLength(0);

    await pickOrder("SO-2026-001 / 120 打");

    // 订单选好后仍缺执行地点 → 依旧不发请求
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写执行地点");
    expect(postsTo(calls, EP.orders)).toHaveLength(0);

    await userEvent.click(screen.getByTestId("action-field-execution_mode"));
    await userEvent.click(await screen.findByRole("option", { name: "外加工" }));
    await pickLocation("协作厂 / 外加工");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    // 提交瞬间弹窗关闭：一次点击不可能再触发第二次提交
    expect(screen.queryByTestId("action-dialog")).toBeNull();

    await waitFor(() => expect(postsTo(calls, EP.orders)).toHaveLength(1));
    const created = postsTo(calls, EP.orders)[0];
    expect(created.method).toBe("POST");
    expect(bodyOf(created)).toEqual({
      order_no: "SO-2026-001",
      // 同单多版本 BOM 必须取版本最大的（取错会被后端以 BOM_VERSION_CHANGED 拒绝）
      bom_id: "bom-v9",
      bom_version: 9,
      execution_mode: "outsourced",
      execution_location_id: "loc-2",
      planned_quantity: "120",
      // 单位按销售单上的名称匹配启用单位表（u-2「个」已停用，不能被选中）
      unit_id: "u-1",
    });
    expect(await screen.findByText("生产单草稿已创建")).toBeVisible();
    // 成功后重新拉取列表（数据流闭环）
    await waitFor(() => expect(getsTo(calls, EP.orders)).toHaveLength(2));
  });

  it("订单无单位时回退到启用工序的默认单位（停用工序的默认单位不参与）", async () => {
    const calls = stubProduction({
      salesOrders: [candidate("SO-2026-004", "30")],
      locations: [workshopLocation],
      operations: [
        { id: "op-off", operationName: "已停用工序", defaultUnitId: "u-9", isActive: false },
        { id: "op-on", operationName: "裁剪", defaultUnitId: "u-2", isActive: true },
      ],
      units: [
        { id: "u-2", name: "码", isActive: true },
        { id: "u-9", name: "打", isActive: true },
      ],
    });
    await openCreateDialog();

    await pickOrder("SO-2026-004 / 30");
    await pickLocation("一号车间 / 厂内");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postsTo(calls, EP.orders)).toHaveLength(1));
    expect(bodyOf(postsTo(calls, EP.orders)[0]).unit_id).toBe("u-2");
  });

  it("既无单位可匹配又无工序默认单位：不发 POST，页面给出可操作的单位说明", async () => {
    const calls = stubProduction({
      salesOrders: [candidate("SO-2026-005", "10", "打")],
      locations: [workshopLocation],
      operations: [{ id: "op-1", operationName: "裁剪", isActive: true }],
      units: [{ id: "u-2", name: "个", isActive: false }],
    });
    await openCreateDialog();

    await pickOrder("SO-2026-005 / 10 打");
    await pickLocation("一号车间 / 厂内");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("error-state")).toHaveTextContent("无法确定订单 SO-2026-005 的生产单位：请先在【采购】物料清单的单位中选择「打 / 个 / 码」等单位，或为工序设置默认单位。");
    expect(postsTo(calls, EP.orders)).toHaveLength(0);
  });

  it("订单下拉的搜索走真实端点：250ms 防抖后只发一次，URL 带 search 关键词", async () => {
    const calls = stubProduction({ salesOrders: [candidate("SO-1", "120", "打")], locations: [workshopLocation] }, (url) =>
      url.includes("search=") ? apiOk([candidate("SO-9", "5")]) : undefined
    );
    await openCreateDialog();

    const trigger = screen.getByTestId("action-field-order_no").querySelector("button") as HTMLElement;
    await userEvent.click(trigger);
    await userEvent.type(screen.getByTestId("searchable-select-search"), "SO-9");

    // 服务端返回的候选替换掉本地选项
    expect(await screen.findByRole("option", { name: "SO-9 / 5" })).toBeVisible();

    const searchCalls = calls.filter((call) => call.url.includes("search="));
    expect(searchCalls).toHaveLength(1);
    // 4 次 keystroke 只能落成 1 次请求，且带的是完整关键词（去掉 clearTimeout 会退化成逐键请求）
    expect(searchCalls[0].url).toBe("/api/v1/sales-orders?status=confirmed&page=1&page_size=200&search=SO-9");
  });
});

describe("生产单列表页：行内动作、失败态与并发", () => {
  it("草稿行才有「启动」：POST /production/orders/:id/transition，带 target 与 reason，成功后提示并重新拉取", async () => {
    const calls = stubProduction({ records: [inHouseDraft, outsourcedInProgress] });
    await openProduction();

    // 非草稿（in_progress）行没有启动入口
    expect(within(rowFor("MO-2026-002")).queryByRole("button", { name: "启动" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "启动" })).toHaveLength(1);

    await userEvent.click(within(rowFor("MO-2026-001")).getByRole("button", { name: "启动" }));

    await waitFor(() => expect(postsTo(calls, "/production/orders/po-1/transition")).toHaveLength(1));
    const transition = postsTo(calls, "/production/orders/po-1/transition")[0];
    expect(transition.method).toBe("POST");
    expect(bodyOf(transition)).toEqual({ target: "in_progress", reason: "开始生产" });
    // 不能打到集合根（POST /production/orders 会被当成建单）
    expect(postsTo(calls, EP.orders)).toHaveLength(0);
    expect(await screen.findByText("生产单已启动")).toBeVisible();
    await waitFor(() => expect(getsTo(calls, EP.orders)).toHaveLength(2));
  });

  it("流转被服务端拒绝（409）：toast 呈现后端原因、不出现成功提示、列表不被清空", async () => {
    const calls = stubProduction({ records: [inHouseDraft] }, (url) =>
      url.endsWith("/transition") ? apiErr(409, "PRODUCTION_ORDER_NOT_DRAFT", "只有草稿生产单可以启动") : undefined
    );
    await openProduction();

    await userEvent.click(screen.getByRole("button", { name: "启动" }));

    expect(await screen.findByText("只有草稿生产单可以启动")).toBeVisible();
    expect(screen.queryByText("生产单已启动")).toBeNull();
    // 行内动作失败走 toast，不能把整页打成错误态
    expect(screen.queryByTestId("error-state")).toBeNull();
    expect(rowFor("MO-2026-001")).toBeVisible();
    expect(postsTo(calls, "/production/orders/po-1/transition")).toHaveLength(1);
  });

  it("KNOWN_DEFECT：请求在途时「启动」按钮不禁用、无 in-flight 守卫，连点两次发两次 POST", async () => {
    const gate = deferred<Response>();
    const calls = stubProduction({ records: [inHouseDraft] }, (url) => (url.endsWith("/transition") ? gate.promise : undefined));
    await openProduction();

    const button = screen.getByRole("button", { name: "启动" });
    await userEvent.click(button);
    // 第一次请求还没回来：按钮依然可点，也没有任何"提交中"状态
    expect(button).toBeEnabled();
    await userEvent.click(button);

    // 期望：一次用户意图（同一张生产单的「启动」）只发一次请求，在途期间按钮禁用或短路。
    // 实际：run() 没有 busy/in-flight 守卫（app/production/page.tsx:59-63、:118），
    //      两次点击各发一次 POST /production/orders/po-1/transition，第二次必然被后端以 409 拒绝，
    //      用户会先看到「生产单已启动」再看到一条失败 toast。
    expect(postsTo(calls, "/production/orders/po-1/transition")).toHaveLength(2);

    await waitFor(() => expect(callsTo(calls, "/transition")).toHaveLength(2));
    gate.resolve(apiOk({}));
  });
});

describe("生产单列表页：行内跳转", () => {
  it("点生产单号按钮跳到 /production/orders/:id（用该行的 id，不是用单号）", async () => {
    stubProduction({ records: [inHouseDraft, outsourcedInProgress] });
    await openProduction();

    await userEvent.click(within(rowFor("MO-2026-002")).getByRole("button", { name: "MO-2026-002" }));

    expect(routerPush).toHaveBeenCalledWith("/production/orders/po-2");
    expect(routerPush).not.toHaveBeenCalledWith("/production/orders/MO-2026-002");
  });
});

// BOM 表现在由采购与生产两个模块共同维护：生产页必须有同等入口，且打开的是同一张表。
describe("生产单列表页：BOM 表入口（与采购共用同一套编辑工作区）", () => {
  it("已建 BOM 的订单显示「编辑BOM表」，缺 BOM 的显示「新建BOM表」", async () => {
    stubProduction({ salesOrders: [candidate("SO-2026-001", "120", "打"), awaitingBom("SO-2026-002")] });
    await openProduction();

    const panel = within(screen.getByTestId("production-bom-panel"));
    expect(panel.getByTestId("production-bom-SO-2026-001")).toHaveTextContent("编辑BOM表");
    expect(panel.getByTestId("production-bom-SO-2026-002")).toHaveTextContent("新建BOM表");
    expect(panel.getByText(/采购与生产共同维护/)).toBeVisible();
  });

  it("点「编辑BOM表」打开共享工作区并拉取该订单的 BOM 明细", async () => {
    const calls = stubProduction({
      salesOrders: [candidate("SO-2026-001", "120", "打")],
      materials: [{ id: "mat-1", materialCode: "M-001", name: "面料A", materialType: "raw_material", isActive: true }],
      boms: { "bom-SO-2026-001": { id: "bom-SO-2026-001", orderNo: "SO-2026-001", status: "draft", version: 1, updatedAt: "2026-09-14T02:00:00.000Z", items: [{ id: "bi-1", materialId: "mat-1", materialName: "面料A", model: "", requiredQuantity: "3", unit: "米", unitId: "u-1", materialSnapshot: {} }] } },
    });
    await openProduction();

    await userEvent.click(within(screen.getByTestId("production-bom-panel")).getByTestId("production-bom-SO-2026-001"));

    expect(await screen.findByDisplayValue("3")).toBeVisible();
    expect(callsTo(calls, "/boms/bom-SO-2026-001")).toHaveLength(1);
    // 生产模块不提供「新建物料」（物料池归采购），只提示入口
    expect(screen.queryByRole("button", { name: "新建物料" })).toBeNull();
    expect(screen.getByText(/物料池由【采购 → 物料清单】维护/)).toBeVisible();
  });

  it("点「新建BOM表」用销售单内部 id 下单接口，成功后自动打开同一张 BOM", async () => {
    const calls = stubProduction({ salesOrders: [awaitingBom("SO-2026-002", "80")] }, (url, call) =>
      url.endsWith("/boms/from-sales-order/so-SO-2026-002") && call.method === "POST"
        ? apiOk({ id: "bom-new", orderNo: "SO-2026-002", status: "draft", version: 1, updatedAt: "2026-09-14T02:00:00.000Z", items: [] })
        : undefined,
    );
    await openProduction();

    await userEvent.click(within(screen.getByTestId("production-bom-panel")).getByTestId("production-bom-SO-2026-002"));

    await waitFor(() => expect(callsTo(calls, "/boms/from-sales-order/so-SO-2026-002").filter((call) => call.method === "POST")).toHaveLength(1));
    expect(await screen.findByText(/这张 BOM 还没有明细行/)).toBeVisible();
  });
});
