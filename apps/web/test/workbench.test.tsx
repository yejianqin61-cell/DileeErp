// 工作台（订单全链路）的**行为**测试：真实渲染 + 真实事件 + fetch 桩。
//
// 取代的遗留“源码正则”断言（apps/web/lib/*.test.mjs 里读 .tsx 源码做正则的部分）：
//   1) lib/format-rate.test.mjs 第 4 例 —— 它断言 workbench.tsx 源码里必须出现
//      `accessor("completion_rate", { …, cell: (info) => formatCompletionRate(info.getValue()) })`。
//      那是把 JSX 的书写形式当契约：改个变量名就误红，而“表格里到底显示什么”一律漏过。
//      这里继承其意图（完成率必须显示成 1 位小数百分数、空值显示占位符、不得泄漏原始比率），
//      改为渲染生产计量表后断言单元格文本。
//   2) lib/finished-goods-storage.test.mjs 第 9 例 —— 它断言源码里必须出现
//      `成品存量 {summary.stock_quantity}` 等文本。
//      这里继承其意图，改为塞入真实汇总数字后断言卡片上真的渲染出「成品存量 12 / 待入库 5 / 已出库 3」，
//      并断言次品为 0 时**不**显示「次品」。
//
// 断言纪律：只断言渲染结果与网络调用；不断言 className，不读源码文本。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WorkbenchPage from "../app/workbench";
import { formatCompletionRate } from "../lib/format-rate";
import { apiErr, apiOk, callsTo, stubApi } from "./helpers/api-stub";

// ---------------------------------------------------------------------------
// 被测接口的 DTO 形状（照 app/workbench.tsx 的类型声明抄写，便于构造最小可渲染数据）
// ---------------------------------------------------------------------------
type Summary = {
  status: string;
  label: string;
  counts: { records: number };
  source_ids: string[];
  missing: boolean;
  amounts?: { amount: string; currency: string };
  quantity_delta?: string;
  rejected_quantity?: string;
  stock_quantity?: string;
  pending_inbound_quantity?: string;
  defective_stock_quantity?: string;
  outbound_quantity?: string;
};
type Blocker = { code: string; label: string; suggestion: string };
type Order = {
  order_no: string;
  customer: Record<string, unknown>;
  sales_status: string;
  bom_status: string;
  procurement_summary: Summary;
  raw_material_inventory_summary: Summary;
  production_summary: Summary;
  finished_goods_qc_summary: Summary;
  finished_goods_inventory_summary: Summary;
  shipping_summary: Summary;
  receivable_summary: Summary;
  payable_summary: Summary;
  overall_status: string;
  overall_status_label: string;
  blockers: Blocker[];
  updated_at: string;
};
type Measurement = {
  order_no: string;
  operation_id: string | null;
  operation_name: string | null;
  source_type: string;
  source_ids: string[];
  source_dates: string[];
  unit: string;
  execution_mode: string;
  planned_quantity: string;
  actual_quantity: string;
  difference_quantity: string;
  over_order_quantity: string;
  completion_rate: string | null;
  status: string;
};

function summary(overrides: Partial<Summary> = {}): Summary {
  return { status: "posted", label: "已过账", counts: { records: 2 }, source_ids: [], missing: false, ...overrides };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    order_no: "SO-2026-001",
    customer: { name: "甲客户" },
    sales_status: "confirmed",
    bom_status: "ready",
    procurement_summary: summary({ status: "received", label: "已收货" }),
    raw_material_inventory_summary: summary(),
    production_summary: summary({ status: "in_production", label: "生产中" }),
    finished_goods_qc_summary: summary(),
    finished_goods_inventory_summary: summary({ stock_quantity: "12", pending_inbound_quantity: "5", outbound_quantity: "3", defective_stock_quantity: "0" }),
    shipping_summary: summary({ missing: true, counts: { records: 0 } }),
    receivable_summary: summary({ amounts: { amount: "1000.00", currency: "CNY" } }),
    payable_summary: summary(),
    overall_status: "in_production",
    overall_status_label: "生产中",
    blockers: [],
    updated_at: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}

function makeMeasurement(overrides: Partial<Measurement> = {}): Measurement {
  return {
    order_no: "SO-2026-001",
    operation_id: "op-1",
    operation_name: "缝制",
    source_type: "in_house_completion",
    source_ids: [],
    source_dates: [],
    unit: "件",
    execution_mode: "in_house",
    planned_quantity: "140",
    actual_quantity: "120",
    difference_quantity: "20",
    over_order_quantity: "0",
    completion_rate: "0.857",
    status: "recorded",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 渲染与查询辅助
// ---------------------------------------------------------------------------
type StubOptions = {
  orders: Order[];
  measurements?: Measurement[];
  /** 覆盖单个订单详情的响应；不提供则详情一律 404。 */
  detail?: (orderNo: string) => Response | Promise<Response>;
};

const ORDERS_PATH = "/order-workbench/orders?page_size=200";
const MEASUREMENTS_PATH = "/production-progress/measurements?page_size=200";

function stubWorkbench({ orders, measurements = [], detail }: StubOptions) {
  return stubApi((url) => {
    if (url.includes("/order-workbench/orders/")) {
      const orderNo = decodeURIComponent(url.slice(url.indexOf("/order-workbench/orders/") + "/order-workbench/orders/".length));
      return detail ? detail(orderNo) : apiErr(404, "NOT_FOUND", "详情未打桩");
    }
    if (url.includes("/order-workbench/orders?")) return apiOk(orders);
    if (url.includes("/production-progress/measurements")) return apiOk(measurements);
    return apiErr(404, "NOT_FOUND", `未预期的请求：${url}`);
  });
}

/** 渲染工作台并等到首批加载结束（loading 态消失）。 */
async function mount(options: StubOptions) {
  const calls = stubWorkbench(options);
  render(<WorkbenchPage />);
  await waitFor(() => expect(screen.queryByTestId("loading-state")).toBeNull());
  return calls;
}

/** 取包含指定文本的表格行，断言范围限定在该行内，避免跨表串味。 */
function rowOf(text: string) {
  const row = screen.getByText(text).closest("tr");
  if (!row) throw new Error(`未找到包含「${text}」的表格行`);
  return within(row as HTMLElement);
}

/** 点击某订单行的「查看详情」并等到详情面板出现。 */
async function openDetail(orderNo: string) {
  await userEvent.click(rowOf(orderNo).getByRole("button", { name: "查看详情" }));
  return screen.findByRole("heading", { name: new RegExp(orderNo.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")) });
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
describe("工作台：订单全链路加载与渲染", () => {
  it("挂载时并行拉取订单与计量两个只读端点，加载态先出现、随后被订单表替换", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const calls = stubApi(async (url) => {
      if (url.includes("/order-workbench/orders?")) { await waiting; return apiOk([makeOrder()]); }
      return apiOk([makeMeasurement()]);
    });

    render(<WorkbenchPage />);

    // 初始渲染必须是可读的加载态，而不是空表
    expect(screen.getByTestId("loading-state")).toHaveTextContent("正在加载订单推进状态");
    expect(screen.queryByText("SO-2026-001")).toBeNull();

    // 两个端点必须在同一轮并发发出（Promise.all）：否则页面会出现二次跳变
    await waitFor(() => expect(calls).toHaveLength(2));

    expect(callsTo(calls, ORDERS_PATH).map((call) => [call.method, call.url])).toEqual([["GET", `/api/v1${ORDERS_PATH}`]]);
    expect(callsTo(calls, MEASUREMENTS_PATH)).toHaveLength(1);

    release();
    expect(await screen.findByText("SO-2026-001")).toBeVisible();
    expect(screen.queryByTestId("loading-state")).toBeNull();
    expect(screen.getByRole("heading", { name: "工作台" })).toBeVisible();
  });

  it("订单行渲染订单号、总体状态、销售状态（后端原值，未中文化）与阻塞原因", async () => {
    await mount({
      orders: [
        makeOrder({ order_no: "SO-A", sales_status: "confirmed", blockers: [{ code: "procurement_pending", label: "采购未到货", suggestion: "跟进供应商交期" }] }),
        makeOrder({ order_no: "SO-B", sales_status: "draft", overall_status: "ready_to_ship", overall_status_label: "待发货" }),
      ],
    });

    const first = rowOf("SO-A");
    // 总体状态走 StatusBadge + 服务端 status_label → 中文
    expect(first.getByText("生产中")).toBeVisible();
    // 「销售」列是裸 accessor("sales_status")（workbench.tsx:52），表格直接渲染后端枚举原值，
    // 与计量状态列同一口径（tests/e2e/production-daily-report.spec.mjs:210 同样断言原值 over_order）；
    // 中文标签只出现在 StatusBadge 包装过的列上。
    expect(first.getByText("confirmed")).toBeVisible();
    expect(first.getByText("采购未到货")).toHaveAttribute("title", "跟进供应商交期");

    const second = rowOf("SO-B");
    expect(second.getByText("待发货")).toBeVisible();
    expect(second.getByText("draft")).toBeVisible();
    // 没有阻塞原因时给出明确文案，而不是留空
    expect(second.getByText("无")).toBeVisible();
  });

  it("订单列表为空时给出空态，而不是渲染空表", async () => {
    await mount({ orders: [] });

    expect(screen.getByTestId("empty-state")).toHaveTextContent("暂无订单");
    expect(screen.getByText("建立销售单后，这里会显示订单全链路状态。")).toBeVisible();
  });

  it("筛选输入框在已加载订单上本地过滤（订单号/阻塞原因），且不额外发起请求", async () => {
    const calls = await mount({
      orders: [
        makeOrder({ order_no: "SO-A", blockers: [{ code: "procurement_pending", label: "采购未到货", suggestion: "跟进供应商交期" }] }),
        makeOrder({ order_no: "SO-B", overall_status: "ready_to_ship", overall_status_label: "待发货" }),
      ],
    });
    const requestsAfterMount = calls.length;

    const filter = screen.getByLabelText("筛选订单");
    await userEvent.type(filter, "SO-B");

    expect(screen.queryByText("SO-A")).toBeNull();
    expect(screen.getByText("SO-B")).toBeVisible();
    // 过滤是纯客户端的可见性变化：不得因此再打接口
    expect(calls).toHaveLength(requestsAfterMount);

    // 清空后恢复全量
    await userEvent.clear(filter);
    expect(screen.getByText("SO-A")).toBeVisible();

    // 阻塞原因同样参与匹配（用户按“为什么卡住”来找单）
    await userEvent.type(filter, "采购未到货");
    expect(screen.getByText("SO-A")).toBeVisible();
    expect(screen.queryByText("SO-B")).toBeNull();
  });

  it("筛选无命中时显示空态，且原有请求不发生", async () => {
    const calls = await mount({ orders: [makeOrder({ order_no: "SO-A" })] });

    await userEvent.type(screen.getByLabelText("筛选订单"), "不存在的订单");

    expect(screen.getByTestId("empty-state")).toHaveTextContent("暂无订单");
    expect(callsTo(calls, ORDERS_PATH)).toHaveLength(1);
  });
});

describe("工作台：查看详情与模块状态", () => {
  it("点击「查看详情」按订单号拉取详情，并渲染模块状态与生产计量面板", async () => {
    const calls = await mount({
      orders: [makeOrder({ order_no: "SO-A", blockers: [{ code: "qc_pending", label: "待质检", suggestion: "安排成品质检" }] })],
      measurements: [makeMeasurement({ order_no: "SO-A" })],
      detail: (orderNo) => apiOk(makeOrder({ order_no: orderNo, blockers: [{ code: "qc_pending", label: "待质检", suggestion: "安排成品质检" }] })),
    });

    await openDetail("SO-A");

    const detailRequests = callsTo(calls, "/order-workbench/orders/SO-A");
    expect(detailRequests.map((call) => [call.method, call.url])).toEqual([["GET", "/api/v1/order-workbench/orders/SO-A"]]);

    expect(screen.getByRole("heading", { name: /SO-A · 生产中/ })).toBeVisible();
    expect(screen.getByText("销售状态：confirmed")).toBeVisible();
    // 阻塞原因在详情里带出处理建议。「待质检」在订单列表行和详情面板各出现一次，
    // 所以把详情断言限定在详情 section 内，避免 strict-mode 多匹配。
    const detailSection = screen.getByRole("heading", { name: /SO-A · 生产中/ }).closest("section");
    if (!detailSection) throw new Error("未找到订单详情面板");
    const detail = within(detailSection as HTMLElement);
    expect(detail.getByText("待质检")).toBeVisible();
    expect(detail.getByText("安排成品质检")).toBeVisible();
    expect(screen.getByRole("heading", { name: "模块状态" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "生产计量" })).toBeVisible();
  });

  it("模块卡片把订单号编码进 query，可点进入对应业务模块", async () => {
    await mount({
      orders: [makeOrder({ order_no: "SO/2026 001" })],
      detail: (orderNo) => apiOk(makeOrder({ order_no: orderNo })),
    });

    await openDetail("SO/2026 001");

    // 详情路径必须编码，否则带 / 与空格的订单号会打到别的路由上
    expect(screen.getByRole("link", { name: /成品库存/ })).toHaveAttribute("href", "/warehouse?order_no=SO%2F2026%20001");
    expect(screen.getByRole("link", { name: /采购 \/ 应付/ })).toHaveAttribute("href", "/procurement?order_no=SO%2F2026%20001");
    expect(screen.getByRole("link", { name: /应收/ })).toHaveAttribute("href", "/finance?order_no=SO%2F2026%20001");
  });

  it("编码后的详情请求路径与订单号一致（含 / 与空格）", async () => {
    const calls = await mount({
      orders: [makeOrder({ order_no: "SO/2026 001" })],
      detail: (orderNo) => apiOk(makeOrder({ order_no: orderNo })),
    });

    await openDetail("SO/2026 001");

    expect(callsTo(calls, "/order-workbench/orders/SO%2F2026%20001")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: /SO\/2026 001 · 生产中/ })).toBeVisible();
    // 该订单没有计量来源时给出空态
    expect(screen.getByTestId("empty-state")).toHaveTextContent("暂无计量来源");
  });

  it("成品库存卡片显示成品存量/待入库/已出库，次品为 0 时不显示次品", async () => {
    await mount({
      orders: [makeOrder({ order_no: "SO-A" })],
      measurements: [makeMeasurement({ order_no: "SO-A" })],
      detail: (orderNo) => apiOk(makeOrder({
        order_no: orderNo,
        finished_goods_inventory_summary: summary({ status: "posted", label: "已过账", counts: { records: 4 }, stock_quantity: "12", pending_inbound_quantity: "5", outbound_quantity: "3", defective_stock_quantity: "0" }),
        receivable_summary: summary({ amounts: { amount: "1000.00", currency: "CNY" } }),
      })),
    });

    await openDetail("SO-A");

    const inventoryCard = screen.getByRole("link", { name: /成品库存/ });
    expect(inventoryCard).toHaveTextContent("4 条记录");
    expect(inventoryCard).toHaveTextContent("成品存量 12");
    expect(inventoryCard).toHaveTextContent("待入库 5");
    expect(inventoryCard).toHaveTextContent("已出库 3");
    // 次品为 0 时不应出现「次品」这一噪声标签
    expect(inventoryCard).not.toHaveTextContent("次品");

    // amounts 存在时要显示金额与币种
    expect(screen.getByRole("link", { name: /应收/ })).toHaveTextContent("1000.00 CNY");
    // missing 的模块显示“尚未建立事实”，而不是 0 条记录
    expect(screen.getByRole("link", { name: /发货/ })).toHaveTextContent("尚未建立事实");
  });

  it("选中订单没有阻塞时，详情面板显示「当前没有待处理阻塞」", async () => {
    await mount({
      orders: [makeOrder({ order_no: "SO-A", blockers: [] })],
      detail: (orderNo) => apiOk(makeOrder({ order_no: orderNo, blockers: [] })),
    });

    await openDetail("SO-A");

    expect(screen.getByText("当前没有待处理阻塞。")).toBeVisible();
  });
});

describe("工作台：生产计量表的完成率展示（取代 format-rate 的源码正则断言）", () => {
  it("生产计量表把比率格式化成 1 位小数百分数，并保留原始比率不下发", async () => {
    await mount({
      orders: [makeOrder({ order_no: "SO-A" })],
      measurements: [
        makeMeasurement({ order_no: "SO-A", operation_name: "缝制", completion_rate: "0.857", actual_quantity: "120" }),
        makeMeasurement({ order_no: "SO-A", operation_id: "op-2", operation_name: "整烫", completion_rate: "1.0030303030303030303", actual_quantity: "140.5" }),
        makeMeasurement({ order_no: "SO-A", operation_id: "op-3", operation_name: "定型", completion_rate: null }),
      ],
      detail: (orderNo) => apiOk(makeOrder({ order_no: orderNo })),
    });

    await openDetail("SO-A");

    expect(rowOf("缝制").getByText("85.7%")).toBeVisible();
    // 接口返回的长小数必须先四舍五入到 1 位小数
    expect(rowOf("整烫").getByText("100.3%")).toBeVisible();
    expect(rowOf("整烫").queryByText("1.0030303030303030303")).toBeNull();
    // 空值回落为占位符，绝不能出现 NaN%
    expect(rowOf("定型").getByText("-")).toBeVisible();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("工序/来源列缺工序名时有中文兜底文案，计量状态列渲染后端原值", async () => {
    await mount({
      orders: [makeOrder({ order_no: "SO-A" })],
      measurements: [
        makeMeasurement({ order_no: "SO-A", operation_id: null, operation_name: null, source_type: "outsource_direct_shipment" }),
        makeMeasurement({ order_no: "SO-A", operation_id: null, operation_name: null, source_type: "finished_goods_return" }),
      ],
      detail: (orderNo) => apiOk(makeOrder({ order_no: orderNo })),
    });

    await openDetail("SO-A");

    expect(screen.getByText("外加工直装柜")).toBeVisible();
    expect(screen.getByText("外加工成品回厂")).toBeVisible();
    // 「计量状态」列是裸 accessor("status")（workbench.tsx:53），表格渲染后端枚举原值 recorded
    // —— 与 E2E 契约一致（tests/e2e/production-daily-report.spec.mjs:210 断言计量状态单元格为 over_order）。
    expect(rowOf("外加工直装柜").getByText("recorded")).toBeVisible();
  });

  it("只展示当前选中订单的计量行（不串单）", async () => {
    await mount({
      orders: [makeOrder({ order_no: "SO-A" }), makeOrder({ order_no: "SO-B" })],
      measurements: [
        makeMeasurement({ order_no: "SO-A", operation_name: "A-缝制" }),
        makeMeasurement({ order_no: "SO-B", operation_name: "B-缝制" }),
      ],
      detail: (orderNo) => apiOk(makeOrder({ order_no: orderNo })),
    });

    await openDetail("SO-A");
    expect(screen.getByText("A-缝制")).toBeVisible();
    expect(screen.queryByText("B-缝制")).toBeNull();

    await openDetail("SO-B");
    expect(screen.getByText("B-缝制")).toBeVisible();
    expect(screen.queryByText("A-缝制")).toBeNull();
  });
});

describe("工作台：完成率展示口径（formatCompletionRate 真实取值）", () => {
  it("比率 → 1 位小数百分数", () => {
    expect(formatCompletionRate("0.857")).toBe("85.7%");
    expect(formatCompletionRate(1)).toBe("100.0%");
    expect(formatCompletionRate("1.0030303030303030303")).toBe("100.3%");
    expect(formatCompletionRate("0.6666666666666666")).toBe("66.7%");
    expect(formatCompletionRate("0")).toBe("0.0%");
    expect(formatCompletionRate("1.25")).toBe("125.0%");
  });

  it("空值/非数字回落为占位符，允许调用方自定义", () => {
    expect(formatCompletionRate(null)).toBe("-");
    expect(formatCompletionRate(undefined)).toBe("-");
    expect(formatCompletionRate("")).toBe("-");
    expect(formatCompletionRate("not-a-number")).toBe("-");
    expect(formatCompletionRate(Number.NaN)).toBe("-");
    expect(formatCompletionRate(Number.POSITIVE_INFINITY)).toBe("-");
    expect(formatCompletionRate(null, "—")).toBe("—");
  });
});

describe("工作台：刷新、错误态与已知缺陷", () => {
  it("刷新按钮重新拉取两个端点；被选中订单不在新结果里时清空详情", async () => {
    let round = 0;
    const calls = stubApi((url) => {
      if (url.includes("/order-workbench/orders/")) return apiOk(makeOrder({ order_no: "SO-A" }));
      if (url.includes("/order-workbench/orders?")) {
        round += 1;
        return apiOk(round === 1 ? [makeOrder({ order_no: "SO-A" }), makeOrder({ order_no: "SO-B" })] : [makeOrder({ order_no: "SO-B" })]);
      }
      return apiOk([]);
    });

    render(<WorkbenchPage />);
    await screen.findByText("SO-A");
    await openDetail("SO-A");
    expect(screen.getByRole("heading", { name: /SO-A · 生产中/ })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => expect(callsTo(calls, ORDERS_PATH)).toHaveLength(2));
    expect(callsTo(calls, MEASUREMENTS_PATH)).toHaveLength(2);
    // SO-A 已从服务端结果消失：详情必须清空，不能留下指向已不存在的订单的面板
    await waitFor(() => expect(screen.queryByRole("heading", { name: /SO-A · 生产中/ })).toBeNull());
    expect(screen.getByText("SO-B")).toBeVisible();
  });

  it("订单列表加载失败时展示服务端 message（role=alert）", async () => {
    stubApi((url) => (url.includes("/production-progress/measurements") ? apiOk([]) : apiErr(500, "INTERNAL", "工作台聚合失败，请稍后重试")));

    render(<WorkbenchPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("工作台聚合失败，请稍后重试");
    expect(screen.queryByTestId("loading-state")).toBeNull();
  });

  it("非 ApiClientError（网络层失败）时展示通用文案", async () => {
    stubApi(() => { throw new TypeError("Failed to fetch"); });

    render(<WorkbenchPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("工作台数据加载失败");
  });

  it("详情加载失败时展示服务端 message，且不渲染详情面板", async () => {
    await mount({
      orders: [makeOrder({ order_no: "SO-A" })],
      detail: () => apiErr(500, "INTERNAL", "订单详情聚合失败"),
    });

    await userEvent.click(rowOf("SO-A").getByRole("button", { name: "查看详情" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("订单详情聚合失败");
    expect(screen.queryByRole("heading", { name: /SO-A · 生产中/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "生产计量" })).toBeNull();
  });

  // KNOWN_DEFECT（真实缺陷，未修）：详情加载失败前就 setSelectedOrderNo(orderNo)（workbench.tsx:43），
  // 于是 selectedOrder 还停在上一个订单，而 selectedMeasurements 已按新订单号过滤：
  // 详情面板写着 A，下面的生产计量表却是 B 的行。
  // 期望：详情面板与计量表始终指向同一个订单（失败时保持原选中，或不提前改 selectedOrderNo）。
  it("KNOWN_DEFECT：详情失败后详情面板仍是旧订单，而计量表已切到新订单", async () => {
    await mount({
      orders: [makeOrder({ order_no: "SO-A" }), makeOrder({ order_no: "SO-B" })],
      measurements: [
        makeMeasurement({ order_no: "SO-A", operation_name: "A-缝制" }),
        makeMeasurement({ order_no: "SO-B", operation_name: "B-缝制" }),
      ],
      detail: (orderNo) => (orderNo === "SO-A" ? apiOk(makeOrder({ order_no: "SO-A" })) : apiErr(500, "INTERNAL", "SO-B 详情聚合失败")),
    });

    await openDetail("SO-A");
    expect(screen.getByText("A-缝制")).toBeVisible();

    await userEvent.click(rowOf("SO-B").getByRole("button", { name: "查看详情" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("SO-B 详情聚合失败");

    // 现状（缺陷）：标题仍是 SO-A，计量表却换成了 SO-B 的行
    expect(screen.getByRole("heading", { name: /SO-A · 生产中/ })).toBeVisible();
    expect(screen.getByText("B-缝制")).toBeVisible();
    expect(screen.queryByText("A-缝制")).toBeNull();
  });

  // KNOWN_DEFECT（真实缺陷，未修）：selectOrder 没有请求序号/取消守卫（workbench.tsx:43）。
  // 先点 A（慢）再点 B（快）时，A 的迟到响应会覆盖 B，标题回到 A，而计量表仍按 B 过滤。
  // 期望：后发起的请求胜出（或取消前一个），详情面板与计量表始终一致。
  it("KNOWN_DEFECT：慢响应覆盖后发起的详情请求（无请求序号守卫）", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    await mount({
      orders: [makeOrder({ order_no: "SO-A" }), makeOrder({ order_no: "SO-B" })],
      measurements: [
        makeMeasurement({ order_no: "SO-A", operation_name: "A-缝制" }),
        makeMeasurement({ order_no: "SO-B", operation_name: "B-缝制" }),
      ],
      detail: async (orderNo) => {
        if (orderNo === "SO-A") { await gateA; return apiOk(makeOrder({ order_no: "SO-A" })); }
        return apiOk(makeOrder({ order_no: "SO-B" }));
      },
    });

    await userEvent.click(rowOf("SO-A").getByRole("button", { name: "查看详情" }));
    await openDetail("SO-B");
    expect(screen.getByText("B-缝制")).toBeVisible();

    releaseA();

    // 现状（缺陷）：迟到 A 的响应把标题改回 SO-A，计量表却还是 SO-B 的
    expect(await screen.findByRole("heading", { name: /SO-A · 生产中/ })).toBeVisible();
    expect(screen.getByText("B-缝制")).toBeVisible();
  });

  // KNOWN_DEFECT（次要，未修）：「刷新」按钮在加载中不禁用，load() 也没有 in-flight 守卫
  // （workbench.tsx:49 的 <Button> 缺 disabled={loading}，workbench.tsx:37 load() 无去重）。
  // 期望：加载中禁用刷新（或复用进行中的请求），一次点击不应放大成 N 次全链路聚合查询。
  it("KNOWN_DEFECT：加载中「刷新」仍可点，连点会重复发起同一批请求", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const calls = stubApi(async (url) => {
      if (url.includes("/order-workbench/orders?")) { await waiting; return apiOk([makeOrder({ order_no: "SO-A" })]); }
      return apiOk([]);
    });

    render(<WorkbenchPage />);
    expect(screen.getByTestId("loading-state")).toBeVisible();

    const refresh = screen.getByRole("button", { name: "刷新" });
    expect(refresh).toBeEnabled();

    await userEvent.click(refresh);
    await userEvent.click(refresh);
    expect(callsTo(calls, ORDERS_PATH)).toHaveLength(3);
    expect(callsTo(calls, MEASUREMENTS_PATH)).toHaveLength(3);

    release();
    await screen.findByText("SO-A");
  });
});
