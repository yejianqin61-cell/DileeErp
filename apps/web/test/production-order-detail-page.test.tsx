// 生产单详情页（components/production/production-order-detail-page.tsx）的真实行为测试。
//
// 本文件取代下面这些"源码正则"遗留文件里与生产单详情页相关的断言意图（改为真实渲染 + 真实事件 + 网络调用断言）：
//   - lib/collapsible-panel.test.mjs 第 4 例：工序与进度面板真能收展、按钮文案随状态变化、收起时连内容一起隐藏；
//   - lib/production-material-issue-entry.test.mjs：详情页挂载领料面板并传 productionOrderId / bomId，
//     且只有「厂内 + 生产中」可领料；
//   - lib/refresh-policy.test.mjs 第 5 例：工序更新事件触发的后台刷新必须静默（不能切整页 loading）；
//   - lib/format-rate.test.mjs 第 4 例：工序完成率必须走统一格式化，不能渲染比率原值；
//   - lib/finished-goods-storage.test.mjs 第 6 例：详情页挂载成品面板并透传 executionMode / orderStatus。
//
// 纪律：不 readFileSync、不正则匹配源码、不断言 className；只断言 DOM 文本/可见性/disabled 与 callsTo(...) 记录到的请求。
//
// 三个重量级子面板（日报 / 成品 / 外加工）在本文件里用最薄替身隔离：它们是各自独立的被测单元，
// 这里只验证"何时挂载、传了什么 props"。领料面板保持真实渲染 —— 本页的门禁（issuable）正落在它的按钮上。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";
import { ProductionOrderDetailPage } from "../components/production/production-order-detail-page";
import { Toaster } from "../components/ui/toaster";

vi.mock("../components/production/daily-reports-panel", () => ({
  DailyReportsPanel: ({ productionOrderId }: { productionOrderId?: string }) => (
    <div data-testid="stub-daily-reports-panel" data-order-id={productionOrderId ?? ""} />
  ),
}));

vi.mock("../components/production/finished-goods-panel", () => ({
  FinishedGoodsPanel: ({ productionOrderId, executionMode, orderStatus }: { productionOrderId: string; executionMode: string; orderStatus: string }) => (
    <div data-testid="stub-finished-goods-panel" data-order-id={productionOrderId} data-execution-mode={executionMode} data-order-status={orderStatus} />
  ),
}));

vi.mock("../components/production/outsource-logistics-panel", () => ({
  OutsourceLogisticsPanel: ({ scope }: { scope?: { orderNo: string; productionOrderId: string } }) => (
    <div data-testid="stub-outsource-logistics-panel" data-order-no={scope?.orderNo ?? ""} data-order-id={scope?.productionOrderId ?? ""} />
  ),
}));

type Operation = {
  id: string;
  operationCatalogId?: string;
  operationNameSnapshot: string;
  sequenceNo?: number;
  targetQuantity: string;
  status: string;
  unitId?: string;
  unit?: { name?: string };
};

type OverviewOrder = {
  id: string;
  productionOrderNo: string;
  orderNo: string;
  bomId?: string | null;
  bom?: { id: string } | null;
  executionMode: "in_house" | "outsourced";
  status: string;
  plannedQuantity: string;
  unit?: { name: string };
  executionLocation?: { name: string };
  operations: Operation[];
};

type MeasurementRow = { operation_id: string; operation_name?: string; source_type?: string; planned_quantity?: string; actual_quantity?: string; difference_quantity?: string; completion_rate?: string };

const baseOperations: Operation[] = [
  // 后端创建生产单工序时写入的 status 就是 "active"（production-orders.service.ts:171），已取消才是 "cancelled"。
  { id: "opr-1", operationCatalogId: "op-1", operationNameSnapshot: "裁剪", sequenceNo: 1, targetQuantity: "120", status: "active", unitId: "unit-1" },
  { id: "opr-2", operationCatalogId: "op-2", operationNameSnapshot: "缝制", sequenceNo: 2, targetQuantity: "110", status: "cancelled", unit: { name: "件" } },
];

const baseOrder: OverviewOrder = {
  id: "po-1",
  productionOrderNo: "MO-2026-001",
  orderNo: "SO-2026-009",
  bomId: "bom-1",
  executionMode: "in_house",
  status: "in_progress",
  plannedQuantity: "120",
  unit: { name: "件" },
  executionLocation: { name: "一号车间" },
  operations: baseOperations,
};

const orderWith = (overrides: Partial<OverviewOrder>): OverviewOrder => ({ ...baseOrder, ...overrides });

const measurements: MeasurementRow[] = [
  { operation_id: "opr-1", operation_name: "裁剪", source_type: "operation_report", planned_quantity: "120", actual_quantity: "100", difference_quantity: "-20", completion_rate: "0.6666666666666666" },
  { operation_id: "opr-2", operation_name: "缝制", source_type: "operation_report", planned_quantity: "110", actual_quantity: "115", difference_quantity: "5", completion_rate: "1.0454545454545454" },
];

const blockerDetails = [
  { code: "PACKAGING_MISSING", label: "缺少包装工序", suggestion: "请先补建包装工序" },
  { code: "NO_OPERATION" },
];

// 形状对齐后端 /production-progress/order-statuses（production-progress.service.ts:194 的 mergeOrderSummaries）：
// 订单级字段在顶层，每张生产单的进度对象挂在 production_orders 里，且两处都带 status_label / blocker_details。
// 详情页优先取本单那条（production-order-detail-page.tsx:37 的 flatMap(production_orders).find(production_order_id)），
// 所以 fixture 必须把 status_label / blocker_details 同时放进 production_orders 条目 —— 只放顶层会被那条空对象顶掉。
const blockerSummaries = [
  {
    status: "blocked",
    status_label: "存在阻塞",
    blocker_details: blockerDetails,
    production_orders: [{ production_order_id: "po-1", status: "blocked", status_label: "存在阻塞", blocker_details: blockerDetails }],
  },
];

const operationPool = [
  { id: "op-1", operationName: "裁剪", isActive: true },
  { id: "op-2", operationName: "缝制", isActive: true },
  { id: "op-3", operationName: "包装", isActive: true },
  { id: "op-4", operationName: "已停用工序", isActive: false },
];

type Fixture = {
  order?: OverviewOrder;
  measurements?: MeasurementRow[];
  summaries?: unknown[];
  operationPool?: Array<{ id: string; operationName: string; isActive: boolean }>;
  units?: Array<{ id: string; name: string; isActive?: boolean }>;
  bomItems?: Array<{ materialId: string; materialName: string; requiredQuantity: string; unit: string }>;
  /** 前 N 次 GET 生产单详情返回 500（用于加载失败 + 重试）。 */
  failOrderGets?: number;
  /** 让所有 PATCH 返回该错误（用于记录"服务端必然拒绝"的现状）。 */
  patchError?: { status: number; code: string; message: string };
  /** 让所有 POST 返回该错误。 */
  postError?: { status: number; code: string; message: string };
};

/** 按 URL 分派的 mock 后端；返回被记录下来的请求列表。 */
function stubDetailApi(fixture: Fixture = {}) {
  const order = fixture.order ?? baseOrder;
  let remainingOrderFailures = fixture.failOrderGets ?? 0;
  return stubApi((url, call) => {
    if (url.includes("/production-progress/measurements")) return apiOk(fixture.measurements ?? []);
    if (url.includes("/production-progress/order-statuses")) return apiOk(fixture.summaries ?? []);
    if (url.endsWith("/production/operations")) return apiOk(fixture.operationPool ?? []);
    if (url.endsWith("/units")) return apiOk(fixture.units ?? [{ id: "unit-1", name: "件", isActive: true }, { id: "unit-2", name: "套", isActive: true }]);
    if (url.includes("/production/material-movements?")) return apiOk([]);
    if (url.includes("/boms/")) return apiOk({ items: fixture.bomItems ?? [{ materialId: "mat-1", materialName: "面料A", requiredQuantity: "10", unit: "米" }] });
    if (url.endsWith("/materials")) return apiOk([]);
    if (url.endsWith(`/production/orders/${order.id}`)) {
      if (remainingOrderFailures > 0) {
        remainingOrderFailures -= 1;
        return apiErr(500, "INTERNAL_SERVER_ERROR", "生产单详情加载失败");
      }
      return apiOk(order);
    }
    if (call.method === "PATCH" && fixture.patchError) return apiErr(fixture.patchError.status, fixture.patchError.code, fixture.patchError.message);
    if (call.method === "POST" && fixture.postError) return apiErr(fixture.postError.status, fixture.postError.code, fixture.postError.message);
    if (call.method !== "GET") return apiOk({});
    return apiErr(404, "NOT_FOUND", `测试未打桩的请求：${url}`);
  });
}

function renderPage(orderId = "po-1") {
  return render(
    <>
      <ProductionOrderDetailPage orderId={orderId} />
      <Toaster />
    </>
  );
}

/** 挂载页面并等待概览出现（初始 load 完成）。 */
async function renderLoaded(fixture: Fixture = {}) {
  const calls = stubDetailApi(fixture);
  renderPage();
  await screen.findByTestId("order-overview");
  return calls;
}

// queryAllByTestId：空态（0 行）时 getAllByTestId 会直接抛错，取不到"零行"这个事实。
function operationsRows() {
  return within(screen.getByTestId("order-operations-panel")).queryAllByTestId("data-table-row");
}

function operationsRowFor(name: string) {
  const row = operationsRows().find((item) => item.textContent?.includes(name));
  if (!row) throw new Error(`未找到包含「${name}」的工序行`);
  return row;
}

function jsonBody(call: StubbedCall | undefined) {
  if (!call) throw new Error("没有记录到该请求");
  return JSON.parse(String(call.body)) as Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  // 折叠状态存在 localStorage（dilee:panel:production-order-operations），不清理会串用例。
  window.localStorage.clear();
});

describe("生产单详情页 · 加载态与概览字段", () => {
  it("数据未返回时显示整页加载态，返回后渲染概览", async () => {
    const gate = deferred<Response>();
    stubApi((url) => (url.endsWith("/production/orders/po-1") ? gate.promise : apiOk([])));

    renderPage();

    expect(screen.getByTestId("loading-state")).toBeVisible();
    expect(screen.getByText("正在加载生产单详情...")).toBeVisible();
    // 加载态下不应该已经渲染出概览骨架
    expect(screen.queryByTestId("order-overview")).toBeNull();

    gate.resolve(apiOk(baseOrder));

    expect(await screen.findByTestId("order-overview")).toBeVisible();
    expect(screen.queryByTestId("loading-state")).toBeNull();
  });

  it("概览渲染销售订单、执行方式、执行地点、计划数量、状态与进度", async () => {
    await renderLoaded({ summaries: blockerSummaries });

    const overview = screen.getByTestId("order-overview");
    expect(within(overview).getByText("销售订单：SO-2026-009")).toBeVisible();
    expect(within(overview).getByText("执行方式：厂内生产")).toBeVisible();
    expect(within(overview).getByText("执行地点：一号车间")).toBeVisible();
    expect(within(overview).getByText("计划数量：120 件")).toBeVisible();
    // 状态经 StatusBadge + 中文映射呈现（in_progress → 生产中，不是英文原值）。
    // 「状态：」是 <p> 的直接文本节点、「生产中」在 StatusBadge 的 <span> 内，跨元素取不到整串文本，
    // 因此先定位该 <p>，再断言它可见文本里既有前缀又有中文状态值。
    const statusLine = within(overview).getByText("生产中").closest("p");
    expect(statusLine).toHaveTextContent("状态：生产中");
    expect(statusLine).not.toHaveTextContent("in_progress");
    // 进度取 order-statuses 汇总的 status_label
    expect(within(overview).getByText("进度：存在阻塞")).toBeVisible();
  });

  it("页头展示生产单号并给出返回列表与下级单据入口", async () => {
    await renderLoaded();

    expect(screen.getByRole("heading", { name: "生产单 MO-2026-001" })).toBeVisible();
    expect(screen.getByRole("link", { name: "返回生产单列表" })).toHaveAttribute("href", "/production");
    // 下级详情区的三个入口都要带上当前生产单 id，否则会开到别的单上。
    // 「新建补料单」在领料面板里还有一个同名链接（material-issues-panel.tsx:176），
    // 所以三个入口都限定在「生产单下级详情」区内断言。
    const subdocSection = screen.getByRole("heading", { name: "生产单下级详情" }).closest("section");
    if (!subdocSection) throw new Error("未找到生产单下级详情面板");
    const subdoc = within(subdocSection as HTMLElement);
    expect(subdoc.getByRole("link", { name: "新建领料单" })).toHaveAttribute("href", "/production/material-issues/new?production_order_id=po-1");
    expect(subdoc.getByRole("link", { name: "新建补料单" })).toHaveAttribute("href", "/production/material-issues/new?type=replenishment&production_order_id=po-1");
    expect(subdoc.getByRole("link", { name: "查看领料/补料单" })).toHaveAttribute("href", "/production/material-issues?production_order_id=po-1");
  });

  it("外加工生产单：执行方式显示外加工，缺失的执行地点与进度回落为 -", async () => {
    await renderLoaded({ order: orderWith({ executionMode: "outsourced", executionLocation: undefined, operations: [] }), summaries: [] });

    const overview = screen.getByTestId("order-overview");
    expect(within(overview).getByText("执行方式：外加工")).toBeVisible();
    expect(within(overview).getByText("执行地点：-")).toBeVisible();
    expect(within(overview).getByText("进度：-")).toBeVisible();
  });

  it("加载失败显示错误态，点「重新加载」会重新请求并恢复渲染", async () => {
    const calls = stubDetailApi({ failOrderGets: 1 });
    renderPage();

    expect(await screen.findByTestId("error-state")).toHaveTextContent("生产单详情加载失败");
    expect(screen.queryByTestId("order-overview")).toBeNull();

    await userEvent.click(screen.getByTestId("error-state-retry"));

    expect(await screen.findByTestId("order-overview")).toBeVisible();
    expect(callsTo(calls, "/production/orders/po-1").length).toBeGreaterThanOrEqual(2);
  });
});

describe("生产单详情页 · 状态流转按钮与带原因的对话框", () => {
  it("草稿单只给出「启动生产」，点击打开要求填写原因的对话框", async () => {
    await renderLoaded({ order: orderWith({ status: "draft" }) });

    expect(screen.getByTestId("order-transition-in_progress")).toHaveTextContent("启动生产");
    expect(screen.queryByTestId("order-transition-completed")).toBeNull();
    expect(screen.queryByTestId("order-transition-paused")).toBeNull();

    await userEvent.click(screen.getByTestId("order-transition-in_progress"));

    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("启动生产")).toBeVisible();
    expect(screen.getByTestId("action-field-reason")).toBeVisible();
    expect(screen.getByText("操作原因")).toBeVisible();
  });

  it("原因必填：留空提交给出校验提示且不发请求", async () => {
    const calls = await renderLoaded({ order: orderWith({ status: "draft" }) });

    await userEvent.click(screen.getByTestId("order-transition-in_progress"));
    await screen.findByTestId("action-dialog");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写操作原因");
    expect(callsTo(calls, "/transition")).toHaveLength(0);
    // 校验失败不能关闭弹窗，否则用户填的原因会丢
    expect(screen.getByTestId("action-dialog")).toBeVisible();
  });

  it("填好原因提交：POST /transition 带 target 与 reason，成功后提示并重新拉取生产单", async () => {
    const calls = await renderLoaded({ order: orderWith({ status: "draft" }) });

    await userEvent.click(screen.getByTestId("order-transition-in_progress"));
    await screen.findByTestId("action-dialog");
    await userEvent.type(screen.getByTestId("action-field-reason"), "物料与工序已齐备");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/transition")).toHaveLength(1));
    const [transition] = callsTo(calls, "/transition");
    expect(transition.method).toBe("POST");
    expect(jsonBody(transition)).toEqual({ target: "in_progress", reason: "物料与工序已齐备" });

    expect(await screen.findByText("启动生产成功")).toBeVisible();
    // 成功后必须重新拉取（状态与可流转按钮要跟着变）
    expect(callsTo(calls, "/production/orders/po-1").length).toBeGreaterThanOrEqual(2);
  });

  it("生产中同时给出「暂停生产」与「标记完工」，各自提交正确的 target", async () => {
    const calls = await renderLoaded({ order: orderWith({ status: "in_progress" }) });

    expect(screen.getByTestId("order-transition-paused")).toHaveTextContent("暂停生产");
    expect(screen.getByTestId("order-transition-completed")).toHaveTextContent("标记完工");

    await userEvent.click(screen.getByTestId("order-transition-paused"));
    await screen.findByTestId("action-dialog");
    await userEvent.type(screen.getByTestId("action-field-reason"), "等待原料到货");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/transition")).toHaveLength(1));
    expect(jsonBody(callsTo(calls, "/transition")[0])).toEqual({ target: "paused", reason: "等待原料到货" });
    expect(await screen.findByText("暂停生产成功")).toBeVisible();
  });

  it("已完工的生产单给出「关闭生产单」与「重新打开」", async () => {
    await renderLoaded({ order: orderWith({ status: "completed" }) });

    expect(screen.getByTestId("order-transition-closed")).toHaveTextContent("关闭生产单");
    expect(screen.getByTestId("order-transition-in_progress")).toHaveTextContent("重新打开");
  });

  it("已关闭的生产单没有可流转动作，一个流转按钮都不渲染", async () => {
    await renderLoaded({ order: orderWith({ status: "closed" }) });

    expect(screen.queryByTestId("order-transition-in_progress")).toBeNull();
    expect(screen.queryByTestId("order-transition-paused")).toBeNull();
    expect(screen.queryByTestId("order-transition-completed")).toBeNull();
    expect(screen.queryByTestId("order-transition-closed")).toBeNull();
  });

  it("流转被服务端拒绝时提示服务端原因，页面不白屏", async () => {
    const calls = await renderLoaded({ order: orderWith({ status: "draft" }), postError: { status: 422, code: "PRODUCTION_OPERATIONS_REQUIRED", message: "厂内生产单启动前至少需要一道有效工序" } });

    await userEvent.click(screen.getByTestId("order-transition-in_progress"));
    await screen.findByTestId("action-dialog");
    await userEvent.type(screen.getByTestId("action-field-reason"), "直接启动");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByText("厂内生产单启动前至少需要一道有效工序")).toBeVisible();
    expect(screen.getByTestId("order-overview")).toBeVisible();
    expect(callsTo(calls, "/transition")).toHaveLength(1);
  });
});

describe("生产单详情页 · 工序与进度面板的展开/收起", () => {
  it("默认展开：按钮文案为「收起」，工序列表与完成率表都在 DOM 上", async () => {
    await renderLoaded({ measurements, summaries: blockerSummaries });

    const toggle = screen.getByRole("button", { name: "收起" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // 「裁剪」在工序表和下面的完成率表里各出现一次：限定到工序表的行内断言，避免跨表歧义
    expect(operationsRowFor("裁剪")).toBeVisible();
    expect(within(screen.getByTestId("order-operations-panel")).getAllByRole("table")).toHaveLength(2);
  });

  it("点「收起」后文案变「展开」，工序列表与完成率表一起从 DOM 上消失，并把选择写进 localStorage", async () => {
    await renderLoaded({ measurements });

    await userEvent.click(screen.getByRole("button", { name: "收起" }));

    const toggle = screen.getByRole("button", { name: "展开" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("裁剪")).toBeNull();
    expect(screen.queryByText("66.7%")).toBeNull();
    expect(within(screen.getByTestId("order-operations-panel")).queryAllByTestId("data-table-row")).toHaveLength(0);
    expect(window.localStorage.getItem("dilee:panel:production-order-operations")).toBe("collapsed");
  });

  it("记住用户选择：localStorage 里是 collapsed 时重新进入页面仍是收起，点「展开」才显示内容", async () => {
    window.localStorage.setItem("dilee:panel:production-order-operations", "collapsed");
    await renderLoaded({ measurements });

    expect(screen.getByRole("button", { name: "展开" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("裁剪")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "展开" }));

    expect(screen.getByRole("button", { name: "收起" })).toBeVisible();
    // 展开后「裁剪」同时出现在工序表与完成率表：限定到工序表行，避免 strict-mode 多匹配
    await waitFor(() => expect(operationsRowFor("裁剪")).toBeVisible());
    expect(window.localStorage.getItem("dilee:panel:production-order-operations")).toBe("expanded");
  });
});

describe("生产单详情页 · 工序列表渲染", () => {
  it("工序行渲染顺序、名称、目标数量、单位与状态（缺失单位回落为 -）", async () => {
    await renderLoaded();

    expect(operationsRows()).toHaveLength(2);

    const cut = operationsRowFor("裁剪");
    expect(cut).toHaveTextContent("1");
    expect(cut).toHaveTextContent("裁剪");
    expect(cut).toHaveTextContent("120");
    expect(cut).toHaveTextContent("-");

    const sew = operationsRowFor("缝制");
    expect(sew).toHaveTextContent("2");
    expect(sew).toHaveTextContent("110");
    expect(sew).toHaveTextContent("件");
    // KNOWN_DEFECT：工序状态列用错了映射表 —— 期望显示中文工序状态「已取消」，
    // 实际把后端原值 cancelled 直接渲染给用户（与下方「工序状态 active」用例同一缺陷）。
    // 责任文件：components/production/production-order-detail-page.tsx:74（status cell 复用只含生产单状态的
    //   statusLabel，见同文件 :27；cancelled 不在表里 → 回落到 row.original.status 原值）。
    expect(sew).toHaveTextContent("cancelled");
  });

  it("已取消的工序不给出「编辑」入口，未取消的工序给出", async () => {
    await renderLoaded();

    expect(within(operationsRowFor("裁剪")).getByRole("button", { name: "编辑" })).toBeVisible();
    expect(within(operationsRowFor("缝制")).queryByRole("button", { name: "编辑" })).toBeNull();
  });

  it("没有工序时工序表回落到空态", async () => {
    await renderLoaded({ order: orderWith({ operations: [] }) });

    expect(screen.getByText("暂无工序")).toBeVisible();
    expect(operationsRows()).toHaveLength(0);
  });

  it("KNOWN_DEFECT：工序状态 active 未中文化，原值 active 直接渲染给用户", async () => {
    // 期望：工序状态 active 应显示为中文（「启用 / 进行中」之类），而不是把后端枚举原值透给用户。
    // 实际：status cell 复用了只含**生产单**状态的 statusLabel（production-order-detail-page.tsx:27），
    //      没有 active 这一项 → 回落到 row.original.status 原值 "active"，用户看到英文 active。
    // 责任文件：components/production/production-order-detail-page.tsx:74（statusLabel 缺工序状态）。
    // 补充实测：components/data/data-table.tsx:14 的 displayText 兜底对 flexRender 产出的 React 元素不生效
    //      （函数型 cell 被当作组件渲染，text() 只处理字符串），所以原值不会经 lib/display-text.ts:2 的
    //      active →「在职」；渲染结果就是 "active"。本用例按现状钉住缺陷，不掩盖。
    await renderLoaded();

    expect(operationsRowFor("裁剪")).toHaveTextContent("active");
    expect(operationsRowFor("裁剪")).not.toHaveTextContent("在职");
    expect(operationsRowFor("裁剪")).not.toHaveTextContent("启用");
  });
});

describe("生产单详情页 · 进度阻塞项与计量行", () => {
  it("阻塞项逐条渲染 label：suggestion，缺失字段回落为 code / 默认建议", async () => {
    await renderLoaded({ summaries: blockerSummaries });

    const overview = screen.getByTestId("order-overview");
    expect(within(overview).getByText("当前阻塞")).toBeVisible();
    const blockerBox = within(overview).getByText("当前阻塞").closest("div");
    expect(blockerBox).not.toBeNull();
    expect(blockerBox).toHaveTextContent("缺少包装工序：请先补建包装工序");
    expect(blockerBox).toHaveTextContent("NO_OPERATION：请处理后重试");
  });

  it("没有阻塞项时不渲染「当前阻塞」区块", async () => {
    await renderLoaded({ summaries: [{ status: "ok", status_label: "正常", blocker_details: [] }] });

    expect(screen.queryByText("当前阻塞")).toBeNull();
    expect(screen.getByText("进度：正常")).toBeVisible();
  });

  it("计量行渲染工序/来源、计划、实际、差额，完成率走统一格式化（不出现比率原值）", async () => {
    await renderLoaded({ measurements });

    const panel = screen.getByTestId("order-operations-panel");
    const tables = within(panel).getAllByRole("table");
    const measureTable = tables[tables.length - 1];
    const rows = within(measureTable).getAllByRole("row");

    for (const header of ["工序/来源", "计划", "实际", "差额", "完成率"]) {
      expect(within(measureTable).getByText(header)).toBeVisible();
    }

    expect(rows[1]).toHaveTextContent("裁剪");
    expect(rows[1]).toHaveTextContent("120");
    expect(rows[1]).toHaveTextContent("100");
    expect(rows[1]).toHaveTextContent("-20");
    // 0.6666666666666666 → 66.7%，1.0454545454545454 → 104.5%
    expect(within(measureTable).getByText("66.7%")).toBeVisible();
    expect(within(measureTable).getByText("104.5%")).toBeVisible();
    expect(screen.queryByText("0.6666666666666666")).toBeNull();
  });
});

describe("生产单详情页 · 编辑工序", () => {
  it("草稿单编辑工序：不问原因，PATCH 只带目标数量与单位", async () => {
    const calls = await renderLoaded({ order: orderWith({ status: "draft" }) });

    await userEvent.click(within(operationsRowFor("裁剪")).getByRole("button", { name: "编辑" }));

    expect(await screen.findByText("编辑工序：裁剪")).toBeVisible();
    // 草稿单不进入 in_progress 分支，因此没有「修改原因」字段
    expect(screen.queryByTestId("action-field-reason")).toBeNull();
    expect(screen.getByTestId("action-field-target_quantity")).toHaveValue(120);

    await userEvent.clear(screen.getByTestId("action-field-target_quantity"));
    await userEvent.type(screen.getByTestId("action-field-target_quantity"), "150");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/orders/po-1/operations/opr-1")).toHaveLength(1));
    const [patchCall] = callsTo(calls, "/production/orders/po-1/operations/opr-1");
    expect(patchCall.method).toBe("PATCH");
    // unit_id 由工序原值作为默认值带出，不能被静默清空
    expect(jsonBody(patchCall)).toEqual({ target_quantity: "150", unit_id: "unit-1" });
    expect(await screen.findByText("工序已更新")).toBeVisible();
  });

  it("生产中编辑工序：必须填「修改原因」，原因随 PATCH 一起提交", async () => {
    const calls = await renderLoaded({ order: orderWith({ status: "in_progress" }) });

    await userEvent.click(within(operationsRowFor("裁剪")).getByRole("button", { name: "编辑" }));

    expect(await screen.findByText("编辑工序：裁剪")).toBeVisible();
    expect(screen.getByTestId("action-field-reason")).toBeVisible();

    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写修改原因");
    expect(callsTo(calls, "/operations/opr-1")).toHaveLength(0);

    await userEvent.clear(screen.getByTestId("action-field-target_quantity"));
    await userEvent.type(screen.getByTestId("action-field-target_quantity"), "130");
    await userEvent.type(screen.getByTestId("action-field-reason"), "客户追加数量");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/orders/po-1/operations/opr-1")).toHaveLength(1));
    expect(jsonBody(callsTo(calls, "/production/orders/po-1/operations/opr-1")[0])).toEqual({ target_quantity: "130", unit_id: "unit-1", reason: "客户追加数量" });
  });

  it("KNOWN_DEFECT：已暂停的生产单仍给出工序「编辑」入口，服务端必然 422", async () => {
    // 期望：paused 生产单不显示工序「编辑」按钮（后端 production-orders.service.ts:230 只允许 draft / in_progress 修改工序）。
    // 实际：前端在生产中、已暂停、草稿三种状态下都渲染按钮，paused 时点击保存必然被 422 拒绝。
    // 责任文件：components/production/production-order-detail-page.tsx:74（["draft","in_progress","paused"]）。
    const calls = await renderLoaded({ order: orderWith({ status: "paused" }), patchError: { status: 422, code: "PRODUCTION_OPERATION_NOT_EDITABLE", message: "已完工或关闭的生产单不能修改工序" } });

    expect(within(operationsRowFor("裁剪")).getByRole("button", { name: "编辑" })).toBeVisible();

    await userEvent.click(within(operationsRowFor("裁剪")).getByRole("button", { name: "编辑" }));
    await screen.findByTestId("action-dialog");
    await userEvent.clear(screen.getByTestId("action-field-target_quantity"));
    await userEvent.type(screen.getByTestId("action-field-target_quantity"), "99");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/orders/po-1/operations/opr-1")).toHaveLength(1));
    expect(await screen.findByText("已完工或关闭的生产单不能修改工序")).toBeVisible();
  });
});

describe("生产单详情页 · 添加生产工序", () => {
  it("已挂载的工序在多选里禁用并提示，已停用工序不出现在选项池", async () => {
    await renderLoaded({ operationPool });

    await userEvent.click(screen.getByTestId("order-add-operation"));
    await screen.findByText("添加生产工序");

    // opr-1（裁剪 / op-1）未取消 → 已在单上；opr-2 已取消 → 可以重新添加
    expect(within(screen.getByTestId("multi-checkbox-option-op-1")).getByRole("checkbox")).toBeDisabled();
    expect(screen.getByTestId("multi-checkbox-option-op-1")).toHaveTextContent("已在当前生产单");
    expect(within(screen.getByTestId("multi-checkbox-option-op-2")).getByRole("checkbox")).toBeEnabled();
    expect(screen.queryByTestId("multi-checkbox-option-op-4")).toBeNull();
    // 目标数量默认取生产单计划数量
    expect(screen.getByTestId("action-field-target_quantity")).toHaveValue(120);
  });

  it("多选后按工序池顺序批量提交，一次请求带上所有选中工序", async () => {
    const calls = await renderLoaded({ operationPool });

    await userEvent.click(screen.getByTestId("order-add-operation"));
    await screen.findByText("添加生产工序");

    // 故意先勾 op-3 再勾 op-2：提交顺序应按池顺序（op-2 在 op-3 前），与勾选顺序无关
    await userEvent.click(within(screen.getByTestId("multi-checkbox-option-op-3")).getByRole("checkbox"));
    await userEvent.click(within(screen.getByTestId("multi-checkbox-option-op-2")).getByRole("checkbox"));
    expect(screen.getByText("已选 2 / 3 项")).toBeVisible();

    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/orders/po-1/operations/batch")).toHaveLength(1));
    const [batch] = callsTo(calls, "/production/orders/po-1/operations/batch");
    expect(batch.method).toBe("POST");
    expect(jsonBody(batch)).toEqual({
      operations: [
        { operation_id: "op-2", target_quantity: "120" },
        { operation_id: "op-3", target_quantity: "120" },
      ],
    });
    expect(await screen.findByText("已添加 2 道工序")).toBeVisible();
  });

  it("一道工序都不选就提交：给出「请选择」提示且不发请求", async () => {
    const calls = await renderLoaded({ operationPool });

    await userEvent.click(screen.getByTestId("order-add-operation"));
    await screen.findByText("添加生产工序");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请选择选择工序（可多选）");
    expect(callsTo(calls, "/operations/batch")).toHaveLength(0);
  });
});

describe("生产单详情页 · 领料面板的可领料门禁", () => {
  function createIssueButton() {
    const section = screen.getByRole("heading", { name: "生产领料单" }).closest("section");
    if (!section) throw new Error("未找到生产领料单面板");
    return within(section).getByRole("button", { name: "新建领料单" });
  }

  it("厂内 + 生产中：可领料，且不显示「不可领料」提示", async () => {
    await renderLoaded({ order: orderWith({ status: "in_progress", executionMode: "in_house" }) });

    await waitFor(() => expect(createIssueButton()).toBeEnabled());
    expect(screen.queryByText("只有「生产中」的厂内生产单可以领料；请先启动生产（外加工生产单不在本厂领料）。")).toBeNull();
  });

  it("厂内 + 草稿：领料入口禁用并说明原因", async () => {
    await renderLoaded({ order: orderWith({ status: "draft", executionMode: "in_house" }) });

    await waitFor(() => expect(createIssueButton()).toBeDisabled());
    expect(screen.getByText("只有「生产中」的厂内生产单可以领料；请先启动生产（外加工生产单不在本厂领料）。")).toBeVisible();
  });

  it("外加工 + 生产中：仍不可领料（外加工单不在本厂领料）", async () => {
    await renderLoaded({ order: orderWith({ status: "in_progress", executionMode: "outsourced" }) });

    await waitFor(() => expect(createIssueButton()).toBeDisabled());
    expect(screen.getByText("只有「生产中」的厂内生产单可以领料；请先启动生产（外加工生产单不在本厂领料）。")).toBeVisible();
  });

  it("领料面板用本页生产单的 id 与 BOM 拉数据", async () => {
    const calls = await renderLoaded({ order: orderWith({ bomId: "bom-1" }) });

    expect(callsTo(calls, "/production/material-movements?production_order_id=po-1")).toHaveLength(1);
    expect(callsTo(calls, "/boms/bom-1")).toHaveLength(1);
  });
});

describe("生产单详情页 · 子面板挂载与静默刷新", () => {
  it("厂内生产单挂载日报与成品面板，并把 executionMode / orderStatus 透传下去", async () => {
    await renderLoaded({ order: orderWith({ executionMode: "in_house", status: "in_progress" }) });

    expect(screen.getByTestId("stub-daily-reports-panel")).toHaveAttribute("data-order-id", "po-1");
    const finished = screen.getByTestId("stub-finished-goods-panel");
    expect(finished).toHaveAttribute("data-order-id", "po-1");
    expect(finished).toHaveAttribute("data-execution-mode", "in_house");
    expect(finished).toHaveAttribute("data-order-status", "in_progress");
    expect(screen.queryByTestId("stub-outsource-logistics-panel")).toBeNull();
  });

  it("外加工生产单改挂外加工面板并带 scope，不挂日报面板", async () => {
    await renderLoaded({ order: orderWith({ executionMode: "outsourced", status: "in_progress" }) });

    const outsource = screen.getByTestId("stub-outsource-logistics-panel");
    expect(outsource).toHaveAttribute("data-order-no", "SO-2026-009");
    expect(outsource).toHaveAttribute("data-order-id", "po-1");
    expect(screen.queryByTestId("stub-daily-reports-panel")).toBeNull();
    expect(screen.getByTestId("stub-finished-goods-panel")).toHaveAttribute("data-execution-mode", "outsourced");
  });

  it("工序更新事件触发静默刷新：重新拉计量，但不切整页 loading、不卸载页面内容", async () => {
    const gate = deferred<Response>();
    let measurementCalls = 0;
    const calls = stubApi((url) => {
      if (url.includes("/production-progress/measurements")) {
        measurementCalls += 1;
        return measurementCalls === 1 ? apiOk(measurements) : gate.promise;
      }
      if (url.includes("/production-progress/order-statuses")) return apiOk([]);
      if (url.endsWith("/units")) return apiOk([]);
      if (url.includes("/production/material-movements?")) return apiOk([]);
      if (url.includes("/boms/")) return apiOk({ items: [] });
      if (url.endsWith("/materials")) return apiOk([]);
      if (url.endsWith("/production/orders/po-1")) return apiOk(baseOrder);
      if (url.endsWith("/production/operations")) return apiOk([]);
      return apiOk([]);
    });

    renderPage();
    await screen.findByTestId("order-overview");

    act(() => {
      window.dispatchEvent(new Event("production-order-operation-updated"));
    });

    await waitFor(() => expect(measurementCalls).toBe(2));
    // 后台刷新期间：整页 loading 绝不能出现（否则会卸载正在编辑的日报/领料草稿）
    expect(screen.queryByTestId("loading-state")).toBeNull();
    expect(screen.getByTestId("order-overview")).toBeVisible();
    expect(screen.getByTestId("order-operations-panel")).toBeVisible();
    expect(callsTo(calls, "/production/progress").length).toBe(0);

    await act(async () => {
      gate.resolve(apiOk(measurements));
    });

    // 重新拉到的计量行要渲染出来；「裁剪」在工序表与完成率表都有，限定到工序表行断言
    await waitFor(() => expect(operationsRowFor("裁剪")).toBeVisible());
  });

  it("刷新按钮走整页加载（与静默刷新区分开）", async () => {
    const calls = await renderLoaded({ order: orderWith({ status: "draft" }) });

    // 页头与「生产领料单」面板各有一个「刷新」（material-issues-panel.tsx:173）：
    // 这里要验证的是页头那个（整页 load），所以按页头操作区限定。
    const headerActions = screen.getByRole("link", { name: "返回生产单列表" }).closest("div");
    if (!headerActions) throw new Error("未找到页头操作区");
    await userEvent.click(within(headerActions as HTMLElement).getByRole("button", { name: "刷新" }));

    await waitFor(() => expect(callsTo(calls, "/production/orders/po-1").length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByTestId("order-overview")).toBeVisible();
  });
});
