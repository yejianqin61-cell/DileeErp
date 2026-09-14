// 外加工物流面板（components/production/outsource-logistics-panel.tsx）的真实行为测试。
//
// 纪律：真实 render + 真实交互（userEvent / fireEvent）+ 只断言 DOM 可见结果与 callsTo(...) 记录到的请求。
// 不 readFileSync、不正则匹配源码、不断言 className；「加载中 / 禁用」这类状态也只通过 disabled / 文本 / 可见性表达。
//
// 覆盖重点（任务书）：
//   批次列表 —— 列与行、状态中文化、编号回落、两个列表各自的空态、scope 过滤；
//   派遣 / 签收 / 删除入口 —— 对话框字段、必填校验、请求 body、成功提示、失败后的重新拉取策略；
//   退货与直发来源 —— 余料回厂 / 成品回厂 / 直装柜三个入口与各自 DTO 的键裁剪；
//   错误态 —— 加载失败（服务端原因 + 非 ApiClientError 回落）、操作被拒绝、短收 422。
//
// 两条 KNOWN_DEFECT 用例钉住本面板真实存在的缺陷（只记录、不修复），详见各用例注释：
//   1) 基础资料未加载完成就打开对话框 → 采购明细下拉被永久快照为空（同 master-data-pool-page 已修的那类缺陷）；
//   2) 签收对话框没有「差异原因」字段 → 后端短收能力（service.ts:106）在前端不可达。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";
import { OutsourceLogisticsPanel } from "../components/production/outsource-logistics-panel";
import { Toaster } from "../components/ui/toaster";

/** 可手动控制兑现时机的 Promise：用于把面板稳定停在「数据未返回」状态。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/* ---------------------------------------------------------------- fixtures */

// 形状对齐后端 OutsourceLogisticsService.list()（apps/api/src/modules/production/outsource-logistics.service.ts:15）。
const batches = [
  { id: "ob-1", batchNo: "OB-20260101-AAAA", orderNo: "SO-2026-009", status: "draft", plannedQuantity: "100", dispatchedQuantity: "0", receipts: [] },
  { id: "ob-2", batchNo: "OB-20260102-BBBB", orderNo: "SO-2026-009", status: "dispatched", plannedQuantity: "200", dispatchedQuantity: "200", receipts: [{ quantity: "50", status: "received" }] },
];

// listReturns / listDirectShipments：两张表在前端合并成一条列表，靠 transferNo / shipmentNo 区分呈现。
const returns = [
  { id: "rt-1", transferNo: "RT-20260103-CCCC", transferType: "material_return", orderNo: "SO-2026-009", quantity: "10", status: "draft" },
  { id: "rt-2", transferType: "finished_goods_return", orderNo: "SO-2026-009", quantity: "20", status: "pending_qc" },
];
const directShipments = [{ id: "os-1", shipmentNo: "OS-20260104-DDDD", transferType: "outsource_direct_shipment", orderNo: "SO-2026-009", quantity: "30", status: "dispatched" }];

const orders = [
  { id: "po-1", productionOrderNo: "MO-2026-001", orderNo: "SO-2026-009", status: "in_progress" },
  { id: "po-2", productionOrderNo: "MO-2026-002", orderNo: "SO-2026-010", status: "completed" },
  { id: "po-3", productionOrderNo: "MO-2026-003", orderNo: "SO-2026-011", status: "draft" },
];

const materials = [{ id: "m-1", materialCode: "RM-1", name: "面料A" }];
const units = [
  { id: "u-1", name: "件", isActive: true },
  { id: "u-2", name: "套", isActive: false },
];
const purchaseOrders = [{ purchaseOrderNo: "PO-2026-001", orderNo: "SO-2026-009", items: [{ id: "pi-1", material: { name: "面料A" } }] }];

const scope = { orderNo: "SO-2026-009", productionOrderId: "po-1" };

/* ------------------------------------------------------------------ stubs */

type Routes = {
  batches?: () => Response;
  returns?: () => Response;
  directShipments?: () => Response;
  orders?: () => Response;
  materials?: () => Response;
  units?: () => Response;
  purchaseOrders?: () => Response | Promise<Response>;
  /** 兜底钩子：拦截任意变更类请求（dispatch / receipts / DELETE / 回厂 / 直装柜）。 */
  mutation?: (url: string, call: StubbedCall) => Response | undefined;
};

/** 按 URL 分派的 mock 后端；返回被记录下来的请求列表。 */
function stubPanelApi(routes: Routes = {}) {
  return stubApi((url, call) => {
    const intercepted = routes.mutation?.(url, call);
    if (intercepted) return intercepted;
    if (url.includes("/outsource-logistics-batches/returns")) return routes.returns?.() ?? apiOk(returns);
    if (url.includes("/outsource-logistics-batches/direct-shipments")) return routes.directShipments?.() ?? apiOk(directShipments);
    if (url.includes("/outsource-logistics-batches")) {
      if (call.method === "GET") return routes.batches?.() ?? apiOk(batches);
      return apiOk({ id: "mutation-result" });
    }
    if (url.endsWith("/production/orders")) return routes.orders?.() ?? apiOk(orders);
    if (url.includes("/production/orders/")) return routes.orders?.() ?? apiOk(orders[0]);
    if (url.endsWith("/materials")) return routes.materials?.() ?? apiOk(materials);
    if (url.endsWith("/units")) return routes.units?.() ?? apiOk(units);
    if (url.endsWith("/purchase-orders")) return routes.purchaseOrders?.() ?? apiOk(purchaseOrders);
    return apiErr(404, "NOT_FOUND", `测试未打桩的请求：${call.method} ${url}`);
  });
}

function renderPanel(scopeProp?: { orderNo: string; productionOrderId: string }) {
  return render(
    <>
      <OutsourceLogisticsPanel scope={scopeProp} />
      <Toaster />
    </>
  );
}

/** 挂载并等到批次行渲染出来（初始 load 的 Promise.all 已兑现）。 */
async function mountLoaded(options: { scope?: { orderNo: string; productionOrderId: string }; routes?: Routes } = {}) {
  const calls = stubPanelApi(options.routes ?? {});
  renderPanel(options.scope);
  await screen.findByText(batches[0].batchNo);
  return calls;
}

/* ---------------------------------------------------------------- helpers */

const bodyOf = (call: StubbedCall | undefined) => {
  if (!call) throw new Error("没有记录到该请求");
  return JSON.parse(String(call.body)) as Record<string, unknown>;
};

/** 只取 GET，按 URL 片段筛。 */
const gets = (calls: StubbedCall[], fragment: string) => calls.filter((call) => call.method === "GET" && call.url.includes(fragment));

/** 批次列表自身的 GET（排除共用前缀的 returns / direct-shipments）。 */
const batchListGets = (calls: StubbedCall[]) =>
  gets(calls, "/outsource-logistics-batches").filter((call) => !call.url.includes("/returns") && !call.url.includes("/direct-shipments"));

/**
 * 批次列表自身的 POST（新建直发批次）。
 * 必须按 method 收窄：`callsTo(calls, "/api/v1/production/outsource-logistics-batches")` 是**后缀**匹配，
 * 会把挂载时的初始 GET 与新建成功后的重新拉取 GET 一起算进来（一次新建共 3 次调用），
 * 用它断言"只发了 1 次"会永远为假，取 `[0]` 拿到的还会是初始 GET 而不是 POST。
 */
const batchListPosts = (calls: StubbedCall[]) =>
  calls.filter((call) => call.method === "POST" && call.url === "/api/v1/production/outsource-logistics-batches");

/** 两张表：[0] 批次，[1] 回厂与直装柜。 */
function tableAt(index: number) {
  const tables = screen.getAllByTestId("data-table");
  if (!tables[index]) throw new Error(`没有第 ${index + 1} 张表（当前 ${tables.length} 张）`);
  return tables[index];
}

function rowsOf(table: HTMLElement) {
  return within(table).queryAllByTestId("data-table-row");
}

function rowWith(table: HTMLElement, text: string) {
  const row = rowsOf(table).find((item) => item.textContent?.includes(text));
  if (!row) throw new Error(`未找到包含「${text}」的行`);
  return row;
}

/** Radix Select：点触发器再点候选项（与 finance-page / finished-goods-qc-panel 测试同一手法）。 */
async function pick(fieldTestId: string, optionName: string | RegExp) {
  await userEvent.click(screen.getByTestId(fieldTestId));
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

/** 表单输入统一走 fireEvent.change：jsdom 里对 date/number 输入用 type 键入不可靠。 */
function fill(fieldTestId: string, value: string) {
  fireEvent.change(screen.getByTestId(fieldTestId), { target: { value } });
}

/* ------------------------------------------------------------------ tests */

describe("外加工物流面板 · 加载与批次列表", () => {
  it("挂载后并行拉取批次 / 回厂 / 直装柜 / 生产单 / 物料 / 单位 / 采购单七个来源", async () => {
    const calls = stubPanelApi();
    renderPanel();

    await screen.findByText(batches[0].batchNo);

    const urls = calls.filter((call) => call.method === "GET").map((call) => call.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        "/api/v1/production/outsource-logistics-batches",
        "/api/v1/production/outsource-logistics-batches/returns",
        "/api/v1/production/outsource-logistics-batches/direct-shipments",
        "/api/v1/production/orders",
        "/api/v1/materials",
        "/api/v1/units",
        "/api/v1/purchase-orders",
      ])
    );
    // 没有 scope 时不得带上 order_no 过滤，否则列表会被悄悄缩小到某一个订单
    expect(urls.some((url) => url.includes("order_no="))).toBe(false);
  });

  it("批次表渲染批次号 / 订单号 / 状态 / 计划与直发数量，且只有草稿批次有删除入口", async () => {
    await mountLoaded();

    const table = tableAt(0);
    for (const header of ["批次", "订单号", "状态", "计划/直发", "操作"]) {
      expect(within(table).getByText(header)).toBeVisible();
    }
    expect(rowsOf(table)).toHaveLength(2);

    const draftRow = rowWith(table, "OB-20260101-AAAA");
    expect(draftRow).toHaveTextContent("SO-2026-009");
    // KNOWN_DEFECT：状态列渲染后端英文原值，而不是 display-text 里的中文。
    // 期望：draft → 「草稿」、dispatched → 「已发出」（lib/display-text.ts:2 两个映射都已定义，全站其余中文 UI 一致）。
    // 实际：DataTable 只对「cell 渲染结果本身是 string」的列应用 displayText（components/data/data-table.tsx:14），
    //   而 accessorKey 列渲染拿到的是 flexRender 产出的 React 元素 → 映射永不生效，
    //   本面板 batchColumns / transferColumns 的 status、transferType 两列因此漏英文原值。
    //   （同一缺陷已在 finished-goods-qc-panel.test.tsx:228-234、production-order-detail-page.test.tsx:455、
    //     finance-page.test.tsx:157 按现状钉住。）
    // 责任：components/data/data-table.tsx:14（判定方式）+ 本面板 :41（status 列未用自定义 cell 转 displayStatus）。
    expect(draftRow).toHaveTextContent("draft");
    expect(draftRow).toHaveTextContent("100 / 0");
    expect(within(draftRow).getByRole("button", { name: "直发" })).toBeVisible();
    expect(within(draftRow).getByRole("button", { name: "签收" })).toBeVisible();
    expect(within(draftRow).getByRole("button", { name: "删除" })).toBeVisible();

    const dispatchedRow = rowWith(table, "OB-20260102-BBBB");
    expect(dispatchedRow).toHaveTextContent("dispatched");
    expect(dispatchedRow).toHaveTextContent("200 / 200");
    expect(within(dispatchedRow).getByRole("button", { name: "直发" })).toBeVisible();
    expect(within(dispatchedRow).queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("回厂与直装柜记录合并在同一张表：编号按 transferNo → shipmentNo → - 回落，类型按状态列原值渲染", async () => {
    await mountLoaded();

    expect(screen.getByRole("heading", { name: "回厂与直装柜" })).toBeVisible();
    const table = tableAt(1);
    expect(rowsOf(table)).toHaveLength(3);

    // KNOWN_DEFECT（与上一条同源）：类型列渲染的是 material_return / finished_goods_return /
    // outsource_direct_shipment 这些后端原值，而不是「余料回厂 / 成品回厂 / 外加工直装柜」
    //（lib/display-text.ts:2 三个映射都已定义）。责任：components/data/data-table.tsx:14 + 本面板 :42。
    // 余料回厂：有 transferNo
    const materialReturn = rowWith(table, "RT-20260103-CCCC");
    expect(materialReturn).toHaveTextContent("material_return");
    expect(materialReturn).toHaveTextContent("10");

    // 成品回厂：既没有 transferNo 也没有 shipmentNo → 编号回落为 "-"（该行只能靠 transferType 定位）
    const finishedReturn = rowWith(table, "finished_goods_return");
    expect(finishedReturn).toHaveTextContent("-");
    expect(finishedReturn).toHaveTextContent("20");

    // 直装柜：只有 shipmentNo，也要显示出来（否则编号列整列空白）
    const shipment = rowWith(table, "OS-20260104-DDDD");
    expect(shipment).toHaveTextContent("outsource_direct_shipment");
    expect(shipment).toHaveTextContent("30");
  });

  it("两个列表各自的空态文案", async () => {
    stubPanelApi({ batches: () => apiOk([]), returns: () => apiOk([]), directShipments: () => apiOk([]) });
    renderPanel();

    expect(await screen.findByText("暂无外加工批次")).toBeVisible();
    expect(screen.getByText("暂无回厂或直装柜记录")).toBeVisible();
    expect(screen.queryAllByTestId("data-table")).toHaveLength(0);
  });

  it("scope 传入时三个列表请求都带 order_no，生产单改取单条详情", async () => {
    const calls = stubPanelApi();
    renderPanel(scope);

    await screen.findByText(batches[0].batchNo);

    expect(callsTo(calls, "/api/v1/production/outsource-logistics-batches?order_no=SO-2026-009")).toHaveLength(1);
    expect(callsTo(calls, "/production/outsource-logistics-batches/returns?order_no=SO-2026-009")).toHaveLength(1);
    expect(callsTo(calls, "/production/outsource-logistics-batches/direct-shipments?order_no=SO-2026-009")).toHaveLength(1);
    expect(callsTo(calls, "/api/v1/production/orders/po-1")).toHaveLength(1);
    expect(gets(calls, "/production/orders")).toHaveLength(1);
  });

  // 行为记录（非缺陷断言）：本面板没有 loading 态，数据未返回前直接显示空态。
  // 对照其他页面：生产单详情页在加载期渲染 LoadingState（components/feedback/states.tsx:9）。
  it("数据未返回前批次表直接回落到空态，返回后才渲染出行", async () => {
    const gate = deferred<Response>();
    stubApi((url) => {
      if (url.includes("/outsource-logistics-batches") && !url.includes("/returns") && !url.includes("/direct-shipments")) return gate.promise;
      if (url.endsWith("/units")) return apiOk(units);
      return apiOk([]);
    });

    renderPanel();

    expect(screen.getByText("暂无外加工批次")).toBeVisible();
    expect(screen.queryByTestId("loading-state")).toBeNull();

    gate.resolve(apiOk(batches));

    expect(await screen.findByText(batches[0].batchNo)).toBeVisible();
    expect(screen.queryByText("暂无外加工批次")).toBeNull();
  });

  it("加载失败时展示服务端原因，而不是白屏", async () => {
    stubPanelApi({ batches: () => apiErr(500, "INTERNAL_SERVER_ERROR", "外加工批次加载失败") });
    renderPanel();

    expect(await screen.findByText("外加工批次加载失败")).toBeVisible();
    expect(screen.queryByTestId("data-table")).toBeNull();
  });

  it("加载失败若不是 ApiClientError（网络异常）则回落到「外加工数据加载失败」", async () => {
    stubApi(() => {
      throw new Error("network down");
    });
    renderPanel();

    expect(await screen.findByText("外加工数据加载失败")).toBeVisible();
  });
});

describe("外加工物流面板 · 新建直发批次", () => {
  it("必填项为空时给出提示且不发请求", async () => {
    const calls = await mountLoaded();

    await userEvent.click(screen.getByRole("button", { name: "新建直发批次" }));
    expect(await screen.findByText("新建直发批次", { selector: "h2" })).toBeVisible();
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写外加工生产单");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("生产单选项只留 draft / in_progress，已完工的生产单不出现在下拉里", async () => {
    await mountLoaded();

    await userEvent.click(screen.getByRole("button", { name: "新建直发批次" }));
    await screen.findByTestId("action-dialog");

    await userEvent.click(screen.getByTestId("action-field-production_order_id"));
    expect(await screen.findByRole("option", { name: "MO-2026-001 / SO-2026-009" })).toBeVisible();
    expect(screen.getByRole("option", { name: "MO-2026-003 / SO-2026-011" })).toBeVisible();
    expect(screen.queryByRole("option", { name: /MO-2026-002/ })).toBeNull();
  });

  it("填好生产单与采购明细后提交：POST 只带三个字段，成功后提示并重新拉取", async () => {
    const calls = await mountLoaded();

    await userEvent.click(screen.getByRole("button", { name: "新建直发批次" }));
    await screen.findByTestId("action-dialog");
    await pick("action-field-production_order_id", "MO-2026-001 / SO-2026-009");
    await pick("action-field-purchase_order_item_id", "PO-2026-001 / SO-2026-009 / 面料A");
    fill("action-field-planned_quantity", "60");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(batchListPosts(calls)).toHaveLength(1));
    const [created] = batchListPosts(calls);
    expect(created.method).toBe("POST");
    // 采购明细选项来自 /purchase-orders 的 items 摊平（purchaseOrderNo / orderNo 回填到条目上）
    expect(bodyOf(created)).toEqual({ production_order_id: "po-1", purchase_order_item_id: "pi-1", planned_quantity: "60" });

    expect(await screen.findByText("新建直发批次已完成")).toBeVisible();
    expect(batchListGets(calls)).toHaveLength(2);
  });

  it("KNOWN_DEFECT：基础资料未加载完成就打开对话框，采购明细下拉永久为空", async () => {
    // 期望：与仓库里已修的同类缺陷保持一致（docs/test/dialog-entry-loading-guard.test.tsx：入口在 loading 期间
    //   disabled）——要么「新建直发批次」在 /purchase-orders 返回前不可点，要么对话框选项随数据到达重建。
    // 实际：open() 在点击瞬间把当时的 purchaseItems 快照进 dialog.fields，数据到达后
    //   fields 引用不变 → 采购明细下拉永远是空的，只能关掉弹窗重开。
    // 责任文件：apps/web/components/production/outsource-logistics-panel.tsx:27（createBatch 的快照）
    //   与同文件 :43（按钮无 disabled 门禁）。
    const gate = deferred<Response>();
    stubPanelApi({ purchaseOrders: () => gate.promise });
    renderPanel();

    const trigger = screen.getByRole("button", { name: "新建直发批次" });
    expect(trigger).toBeEnabled();
    await userEvent.click(trigger);
    await screen.findByTestId("action-dialog");

    gate.resolve(apiOk(purchaseOrders));
    // 等到初始 load 真正结束（批次行渲染出来 = Promise.all 已兑现）
    await screen.findByText(batches[0].batchNo);

    await userEvent.click(screen.getByTestId("action-field-purchase_order_item_id"));
    await waitFor(() => expect(screen.getByTestId("action-field-purchase_order_item_id")).toHaveAttribute("aria-expanded", "true"));
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    // 对照：加载完成后重新打开时同一个下拉就有选项（见上一个用例的 pick 断言）
  });
});

describe("外加工物流面板 · 直发与签收", () => {
  it("登记直发：标题与三个必填字段，空提交给提示且不发请求", async () => {
    const calls = await mountLoaded();

    const row = rowWith(tableAt(0), "OB-20260101-AAAA");
    await userEvent.click(within(row).getByRole("button", { name: "直发" }));

    expect(await screen.findByText("登记直发", { selector: "h2" })).toBeVisible();
    expect(screen.getByTestId("action-field-quantity")).toBeVisible();
    expect(screen.getByTestId("action-field-dispatch_date")).toBeVisible();
    expect(screen.getByTestId("action-field-proof_remark")).toBeVisible();

    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写直发数量");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("登记直发提交：POST 到该批次的 /dispatch，成功后提示、关闭弹窗并重新拉取", async () => {
    const calls = await mountLoaded();

    const row = rowWith(tableAt(0), "OB-20260101-AAAA");
    await userEvent.click(within(row).getByRole("button", { name: "直发" }));
    await screen.findByTestId("action-dialog");

    fill("action-field-quantity", "20");
    fill("action-field-dispatch_date", "2026-01-05");
    await userEvent.type(screen.getByTestId("action-field-proof_remark"), "司机张三交接单号 A-1");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/outsource-logistics-batches/ob-1/dispatch")).toHaveLength(1));
    const [dispatch] = callsTo(calls, "/production/outsource-logistics-batches/ob-1/dispatch");
    expect(dispatch.method).toBe("POST");
    expect(bodyOf(dispatch)).toEqual({ quantity: "20", dispatch_date: "2026-01-05", proof_remark: "司机张三交接单号 A-1" });

    expect(await screen.findByText("登记直发已完成")).toBeVisible();
    expect(batchListGets(calls)).toHaveLength(2);
    // 提交成功后弹窗关闭，用户不会在旧表单里重复提交
    expect(screen.queryByTestId("action-dialog")).toBeNull();
  });

  it("直发被服务端拒绝：toast 展示服务端原因，列表不消失且不触发重新拉取", async () => {
    const calls = await mountLoaded({
      routes: { mutation: (url) => (url.includes("/ob-2/dispatch") ? apiErr(422, "OUTSOURCE_BATCH_NOT_DISPATCHABLE", "只有草稿批次可以直发") : undefined) },
    });

    const row = rowWith(tableAt(0), "OB-20260102-BBBB");
    await userEvent.click(within(row).getByRole("button", { name: "直发" }));
    await screen.findByTestId("action-dialog");
    fill("action-field-quantity", "5");
    fill("action-field-dispatch_date", "2026-01-08");
    fill("action-field-proof_remark", "补发");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByText("只有草稿批次可以直发")).toBeVisible();
    expect(screen.getByText(batches[0].batchNo)).toBeVisible();
    expect(screen.getByText(batches[1].batchNo)).toBeVisible();
    expect(batchListGets(calls)).toHaveLength(1);
  });

  it("登记签收：POST 到该批次的 /receipts，body 带上默认幂等键", async () => {
    const calls = await mountLoaded();

    const row = rowWith(tableAt(0), "OB-20260102-BBBB");
    await userEvent.click(within(row).getByRole("button", { name: "签收" }));
    expect(await screen.findByText("登记签收", { selector: "h2" })).toBeVisible();

    fill("action-field-quantity", "50");
    fill("action-field-receipt_date", "2026-01-09");
    fill("action-field-receiver_name", "李四");
    fill("action-field-proof_remark", "签收单 S-9");
    // 幂等键要预置且非空，否则后端 ReceiptDto（controller.ts:13）必然 400
    expect(screen.getByTestId<HTMLInputElement>("action-field-idempotency_key").value).toMatch(/^web-\d+$/);
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/outsource-logistics-batches/ob-2/receipts")).toHaveLength(1));
    const [receipt] = callsTo(calls, "/production/outsource-logistics-batches/ob-2/receipts");
    expect(receipt.method).toBe("POST");
    const body = bodyOf(receipt);
    expect(body).toMatchObject({ quantity: "50", receipt_date: "2026-01-09", receiver_name: "李四", proof_remark: "签收单 S-9" });
    expect(String(body.idempotency_key)).toMatch(/^web-\d+$/);
    expect(await screen.findByText("登记签收已完成")).toBeVisible();
    expect(batchListGets(calls)).toHaveLength(2);
  });

  it("KNOWN_DEFECT：签收对话框没有「差异原因」入口，body 永远不含 difference_reason", async () => {
    // 期望：短收必须能填差异原因（或在不允许短收时明确阻止提交）。
    // 实际：ReceiptDto 接受 difference_reason（apps/api/src/modules/production/outsource-logistics.controller.ts:13），
    //   且 service.ts:106 规定短收（quantity < 未签收数量）时必须填，否则 422 RECEIPT_DIFFERENCE_REASON_REQUIRED；
    //   但本面板 receipt() 的字段里没有该输入，提交时也构造不出这个键 → 后端短收能力在前端完全不可达，
    //   用户只能看到「短收必须填写差异原因」而无处可填。
    // 责任文件：apps/web/components/production/outsource-logistics-panel.tsx:29。
    const calls = await mountLoaded();

    const row = rowWith(tableAt(0), "OB-20260102-BBBB");
    await userEvent.click(within(row).getByRole("button", { name: "签收" }));
    await screen.findByTestId("action-dialog");

    expect(screen.queryByTestId("action-field-difference_reason")).toBeNull();
    expect(screen.queryByLabelText(/差异原因/)).toBeNull();

    fill("action-field-quantity", "20");
    fill("action-field-receipt_date", "2026-01-09");
    fill("action-field-proof_remark", "短收 20 件");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/outsource-logistics-batches/ob-2/receipts")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/production/outsource-logistics-batches/ob-2/receipts")[0])).not.toHaveProperty("difference_reason");
  });

  it("短收被服务端 422 拒绝时，用户只能看到错误提示（无补偿入口）", async () => {
    stubPanelApi({ mutation: (url) => (url.includes("/receipts") ? apiErr(422, "RECEIPT_DIFFERENCE_REASON_REQUIRED", "短收必须填写差异原因") : undefined) });
    renderPanel();
    await screen.findByText(batches[0].batchNo);

    const row = rowWith(tableAt(0), "OB-20260102-BBBB");
    await userEvent.click(within(row).getByRole("button", { name: "签收" }));
    await screen.findByTestId("action-dialog");
    fill("action-field-quantity", "20");
    fill("action-field-receipt_date", "2026-01-09");
    fill("action-field-proof_remark", "短收 20 件");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByText("短收必须填写差异原因")).toBeVisible();
    // 弹窗已关闭，表单里也没有可填的差异原因 → 这条路径无法完成（配合上一条 KNOWN_DEFECT）
    expect(screen.queryByTestId("action-dialog")).toBeNull();
  });

  it("草稿批次的删除是单次点击直达 DELETE，成功后提示并重新拉取", async () => {
    const calls = await mountLoaded();

    const draftRow = rowWith(tableAt(0), "OB-20260101-AAAA");
    await userEvent.click(within(draftRow).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(callsTo(calls, "/api/v1/production/outsource-logistics-batches/ob-1")).toHaveLength(1));
    const [removed] = callsTo(calls, "/api/v1/production/outsource-logistics-batches/ob-1");
    expect(removed.method).toBe("DELETE");
    expect(await screen.findByText("草稿已删除")).toBeVisible();
    expect(batchListGets(calls)).toHaveLength(2);
  });
});

describe("外加工物流面板 · 回厂与直装柜入口（DTO 键裁剪）", () => {
  it("余料回厂：直发批次与物料必填，body 精确等于 MaterialReturnDto 允许的键", async () => {
    const calls = await mountLoaded({ scope });

    await userEvent.click(screen.getByRole("button", { name: "余料回厂" }));
    expect(await screen.findByText("余料回厂", { selector: "h2" })).toBeVisible();

    // 空提交：第一个缺失的必填项是「直发批次」（生产单已由 scope 带出默认值）
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写直发批次");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);

    await pick("action-field-logistics_batch_id", "OB-20260101-AAAA / SO-2026-009");
    await pick("action-field-material_id", "RM-1 / 面料A");
    await pick("action-field-unit_id", "件");
    fill("action-field-quantity", "5");
    fill("action-field-transfer_date", "2026-01-06");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/outsource-logistics-batches/returns/material")).toHaveLength(1));
    const [materialReturn] = callsTo(calls, "/production/outsource-logistics-batches/returns/material");
    expect(materialReturn.method).toBe("POST");
    // 多余键（product_description / shipment_date / logistics_reference）一律不得发出：
    // 后端 forbidNonWhitelisted 会 400 任何 DTO 之外的键。
    expect(bodyOf(materialReturn)).toEqual({
      production_order_id: "po-1",
      logistics_batch_id: "ob-1",
      material_id: "m-1",
      unit_id: "u-1",
      quantity: "5",
      transfer_date: "2026-01-06",
    });
    expect(await screen.findByText("余料回厂已完成")).toBeVisible();
  });

  it("成品回厂：单位排除停用项，body 精确等于 FinishedReturnDto 允许的键（不带批次/物料）", async () => {
    const calls = await mountLoaded({ scope });

    await userEvent.click(screen.getByRole("button", { name: "成品回厂" }));
    await screen.findByTestId("action-dialog");

    await userEvent.click(screen.getByTestId("action-field-unit_id"));
    expect(await screen.findByRole("option", { name: "件" })).toBeVisible();
    // 停用单位不得成为新单据的单位
    expect(screen.queryByRole("option", { name: "套" })).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: "件" }));

    fill("action-field-product_description", "成品连衣裙 A");
    fill("action-field-quantity", "8");
    fill("action-field-transfer_date", "2026-01-06");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/outsource-logistics-batches/returns/finished-goods")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/production/outsource-logistics-batches/returns/finished-goods")[0]);
    expect(body).toEqual({ production_order_id: "po-1", unit_id: "u-1", product_description: "成品连衣裙 A", quantity: "8", transfer_date: "2026-01-06" });
    expect(body).not.toHaveProperty("logistics_batch_id");
    expect(body).not.toHaveProperty("material_id");
    expect(body).not.toHaveProperty("shipment_date");
    expect(await screen.findByText("成品回厂已完成")).toBeVisible();
  });

  it("直装柜：装柜日期与物流参考号必填，body 精确等于 DirectShipmentDto 允许的键", async () => {
    const calls = await mountLoaded({ scope });

    await userEvent.click(screen.getByRole("button", { name: "直装柜" }));
    await screen.findByTestId("action-dialog");

    await pick("action-field-unit_id", "件");
    fill("action-field-product_description", "成品连衣裙 A");
    fill("action-field-quantity", "8");
    fill("action-field-transfer_date", "2026-01-06");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写装柜日期");

    fill("action-field-shipment_date", "2026-01-07");
    fill("action-field-logistics_reference", "REF-2026-1");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/production/outsource-logistics-batches/direct-shipments")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/production/outsource-logistics-batches/direct-shipments")[0]);
    expect(body).toEqual({
      production_order_id: "po-1",
      unit_id: "u-1",
      product_description: "成品连衣裙 A",
      quantity: "8",
      shipment_date: "2026-01-07",
      logistics_reference: "REF-2026-1",
    });
    // 直装柜 DTO 没有 transfer_date，多带会被 400
    expect(body).not.toHaveProperty("transfer_date");
    expect(await screen.findByText("直装柜已完成")).toBeVisible();
  });

  it("对话框里的「新增类目」不建单，只在面板上提示去对应模块建立", async () => {
    const calls = await mountLoaded({ scope });

    await userEvent.click(screen.getByRole("button", { name: "余料回厂" }));
    await screen.findByTestId("action-dialog");

    // 「新增类目」按钮与它的下拉同属一个容器；物料与单位各有一个同名按钮，按容器限定。
    const materialSelect = screen.getByTestId("action-field-material_id");
    const container = materialSelect.parentElement;
    if (!container) throw new Error("未找到物料下拉容器");
    await userEvent.click(within(container).getByRole("button", { name: "新增类目" }));

    expect(await screen.findByText("物料为业务记录，请在对应模块建立")).toBeVisible();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
});
