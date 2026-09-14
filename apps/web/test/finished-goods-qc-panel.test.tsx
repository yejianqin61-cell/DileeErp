// 成品质检面板（components/qc/finished-goods-qc-panel.tsx）的行为测试。
// 该面板已随质检模块迁到 QC 模块（/qc），仍由本文件覆盖。
//
// 取代对象：apps/web/lib/finished-goods-storage.test.mjs 中针对本面板的源码正则断言
//   （「来源标签要包含入库通知」「header: 入库通知/批次」「header: 包装工序」）。
//   那些断言把 JSX 的书写形式当契约：改一行写法就误红，而"来源列表根本没渲染出来"
//   "创建送检打错端点"这类真实运行时缺陷一律漏过。
// 本文件全部用 真实 render + userEvent 点击/输入 驱动，只断言渲染结果与真实网络调用
//   （DOM 文本、可见/禁用、以及 callsTo/url/body），不读源码、不断言 className。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FinishedGoodsQcPanel } from "../components/qc/finished-goods-qc-panel";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 面板用 new Date().toISOString().slice(0, 10) 生成默认日期，期望值用同一算法。 */
const today = () => new Date().toISOString().slice(0, 10);

/** 可控 deferred：把面板稳定停在详情加载态上做断言。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// 三个 DTO 形状照抄实现里的类型：来源与质检记录是 snake_case，送检单是 camelCase。
function sourceFixture(overrides: Record<string, unknown> = {}) {
  return {
    source_id: "src-1",
    source_type: "finished_goods_inbound_notice",
    order_no: "SO-1001",
    production_order_no: "MO-1001",
    production_order_id: "po-1",
    unit: "件",
    available_quantity: "120",
    source_status: "available",
    product_name: "连衣裙",
    product_specification: "M",
    notice_id: "notice-1",
    notice_no: "FGIN-001",
    batch_no: "B-01",
    packaging_operation_name: "包装",
    ...overrides,
  };
}

function submissionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    submissionNo: "FGIS-001",
    orderNo: "SO-1001",
    productionOrderId: "po-1",
    productionOrderNoSnapshot: "MO-1001",
    sourceType: "finished_goods_inbound_notice",
    sourceId: "src-1",
    submittedQuantity: "100",
    submissionDate: "2024-05-01",
    remark: null,
    version: 3,
    status: "submitted",
    unitNameSnapshot: "件",
    productNameSnapshot: "连衣裙",
    productSpecificationSnapshot: "M",
    qcRecords: [],
    ...overrides,
  };
}

function qcFixture(overrides: Record<string, unknown> = {}) {
  return {
    qc_id: "qc-1",
    qc_no: "QC-001",
    order_no: "SO-1001",
    submission_id: "sub-1",
    status: "passed",
    source_type: "finished_goods_inbound_notice",
    source_id: "src-1",
    unit: "件",
    qualified_quantity: "90",
    conditional_accept_quantity: "5",
    available_for_inbound_quantity: "95",
    conditionally_accepted: true,
    ...overrides,
  };
}

type StubOptions = {
  sources?: unknown[];
  submissions?: unknown[];
  detailSources?: unknown[];
  detailSubmissions?: unknown[];
  detailQc?: unknown[];
  onCreate?: (call: StubbedCall) => Response;
  onSubmit?: (call: StubbedCall) => Response;
  onPatch?: (call: StubbedCall) => Response;
  onQcRecord?: (call: StubbedCall) => Response;
};

/** 按 endpoint 分发真实信封；未桩化的请求返回 404 并带上 url，便于定位。 */
function stubQcApi(options: StubOptions = {}) {
  const { sources = [], submissions = [], detailSources, detailSubmissions, detailQc = [] } = options;
  return stubApi((url, call) => {
    if (call.method === "POST" && url.endsWith("/submit")) return options.onSubmit?.(call) ?? apiOk({});
    if (call.method === "POST" && url.endsWith("/finished-goods/qc-records")) return options.onQcRecord?.(call) ?? apiOk({});
    if (call.method === "POST" && url.endsWith("/finished-goods/inspection-submissions")) return options.onCreate?.(call) ?? apiOk(submissionFixture());
    if (call.method === "PATCH") return options.onPatch?.(call) ?? apiOk({});
    if (url.includes("/finished-goods/qc-records/available-inbound-sources")) return apiOk(detailQc);
    if (url.includes("/finished-goods/qc/sources")) return apiOk(url.includes("order_no=") ? detailSources ?? sources : sources);
    if (url.includes("/finished-goods/inspection-submissions")) return apiOk(url.includes("order_no=") ? detailSubmissions ?? submissions : submissions);
    return apiErr(404, "NOT_FOUND", `未桩化的请求：${url}`);
  });
}

const detailUrl = (path: string, orderNo = "SO-1001") => `/api/v1${path}?order_no=${orderNo}`;

/** 点订单号入口，等三张表出现（详情三个请求都已返回）。 */
async function openOrder(orderNo = "SO-1001") {
  await userEvent.click(await screen.findByRole("button", { name: orderNo }));
  expect(await screen.findByRole("heading", { name: `订单详情：${orderNo}` })).toBeVisible();
}

/**
 * 打开「录入成品质检」弹窗：走订单详情里的「为此订单录入质检」入口。
 * 面板顶部的「录入质检」（先选订单号）入口已在 2026-09 修复（见「按订单号选择后直接打开该订单的成品质检表单」用例），
 * 这里仍走订单详情入口，避免两个入口在同一批用例里互相干扰。
 */
async function openQcDialog(orderNo = "SO-1001") {
  await openOrder(orderNo);
  await userEvent.click(screen.getByRole("button", { name: "为此订单录入质检" }));
  expect(await screen.findByRole("heading", { name: `录入成品质检：${orderNo}` })).toBeVisible();
}

/** 在质检弹窗内选择订单内送检批次（Radix Select）。 */
async function chooseSubmission(name: RegExp) {
  await userEvent.click(screen.getByTestId("action-field-submission_id"));
  await userEvent.click(await screen.findByRole("option", { name }));
}

/** 覆盖某个字段的当前值（数字/文本均可）。 */
async function fillField(label: RegExp, value: string) {
  const input = screen.getByLabelText(label);
  await userEvent.clear(input);
  if (value) await userEvent.type(input, value);
}

const fieldValue = (label: RegExp) => (screen.getByLabelText(label) as HTMLInputElement).value;
const postCalls = (calls: StubbedCall[]) => calls.filter((call) => call.method === "POST");
const patchCalls = (calls: StubbedCall[]) => calls.filter((call) => call.method === "PATCH");

describe("成品送检与质检面板", () => {
  it("打开面板即拉取来源与送检单列表，并按订单号去重渲染入口", async () => {
    const calls = stubQcApi({
      sources: [sourceFixture()],
      submissions: [submissionFixture(), submissionFixture({ id: "sub-9", submissionNo: "FGIS-009", orderNo: "SO-2002", sourceId: "src-9" })],
    });

    render(<FinishedGoodsQcPanel />);

    expect(await screen.findByRole("button", { name: "SO-1001" })).toBeVisible();
    expect(screen.getByRole("button", { name: "SO-2002" })).toBeVisible();
    // SO-1001 同时出现在来源与送检单里：入口必须去重，只出现一次
    expect(screen.getAllByRole("button", { name: /^SO-/ })).toHaveLength(2);

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "/api/v1/finished-goods/qc/sources"],
      ["GET", "/api/v1/finished-goods/inspection-submissions"],
    ]);
  });

  it("加载失败时显示服务端消息，点「刷新」重新拉取并清除错误", async () => {
    let failing = true;
    const calls = stubApi((url) => {
      if (failing) return apiErr(500, "INTERNAL_ERROR", "服务器内部错误");
      if (url.includes("/finished-goods/qc/sources")) return apiOk([sourceFixture()]);
      if (url.includes("/finished-goods/inspection-submissions")) return apiOk([submissionFixture()]);
      return apiErr(404, "NOT_FOUND", url);
    });

    render(<FinishedGoodsQcPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("服务器内部错误");

    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    expect(await screen.findByRole("button", { name: "SO-1001" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(callsTo(calls, "/finished-goods/qc/sources")).toHaveLength(2);
  });

  it("选择订单号后按订单号拉取三个列表，并渲染来源/送检/质检数据", async () => {
    const calls = stubQcApi({
      sources: [sourceFixture()],
      submissions: [submissionFixture()],
      detailSources: [sourceFixture()],
      detailSubmissions: [submissionFixture()],
      detailQc: [qcFixture()],
    });

    render(<FinishedGoodsQcPanel />);
    await openOrder("SO-1001");

    // 三个列表都带上订单号过滤，且顺序与 Promise.all 一致
    const scoped = calls.filter((call) => call.url.includes("order_no=SO-1001")).map((call) => call.url);
    expect(scoped).toEqual([
      detailUrl("/finished-goods/qc/sources"),
      detailUrl("/finished-goods/inspection-submissions"),
      detailUrl("/finished-goods/qc-records/available-inbound-sources"),
    ]);

    const tables = screen.getAllByTestId("data-table");
    expect(tables).toHaveLength(3);

    // 来源表：来源要能看出是「成品入库通知」，并显示入库通知/批次与包装工序（继承遗留断言意图）
    const sourceTable = within(tables[0]);
    expect(sourceTable.getByText("成品入库通知")).toBeVisible();
    expect(sourceTable.getByText("入库通知/批次")).toBeVisible();
    expect(sourceTable.getByText("包装工序")).toBeVisible();
    expect(sourceTable.getByText("FGIN-001 / B-01")).toBeVisible();
    expect(sourceTable.getByText("包装")).toBeVisible();
    expect(sourceTable.getByText("120")).toBeVisible();

    // 送检记录表：camelCase DTO 要正确落到列上（数量带单位）
    const submissionTable = within(tables[1]);
    expect(submissionTable.getByText("FGIS-001")).toBeVisible();
    expect(submissionTable.getByText("100 件")).toBeVisible();
    // KNOWN_DEFECT：状态列渲染英文原值。
    // 期望：submitted -> 「已提交」（lib/display-text.ts:2 已定义该映射）。
    // 实际：DataTable 只对「cell 渲染结果本身是 string」的列应用 displayText
    //   （components/data/data-table.tsx:14），accessorKey 列经 flexRender 后是 React 元素，
    //   映射永不生效 → 送检单状态/来源状态列漏英文原值，与全站中文状态不一致。
    // 责任：components/data/data-table.tsx:14（判定方式），以及本面板 :144/:143 的状态列未用自定义 cell。
    expect(submissionTable.getByText("submitted")).toBeVisible();

    // 质检记录表：净值列（可入库数量）来自质检记录接口
    const qcTable = within(tables[2]);
    expect(qcTable.getByText("可入库数量（净值）")).toBeVisible();
    expect(qcTable.getByText("QC-001")).toBeVisible();
    expect(qcTable.getByText("95")).toBeVisible();
    expect(qcTable.getByText("成品入库通知")).toBeVisible();
  });

  it("订单详情加载期间显示加载提示，数据到达后替换为表格", async () => {
    const gate = deferred<Response>();
    stubApi((url) => {
      if (url.includes("/finished-goods/qc/sources?order_no=")) return gate.promise;
      if (url.includes("/finished-goods/qc-records/available-inbound-sources")) return apiOk([qcFixture()]);
      if (url.includes("/finished-goods/inspection-submissions?order_no=")) return apiOk([submissionFixture()]);
      if (url.includes("/finished-goods/qc/sources")) return apiOk([sourceFixture()]);
      if (url.includes("/finished-goods/inspection-submissions")) return apiOk([submissionFixture()]);
      return apiErr(404, "NOT_FOUND", url);
    });

    render(<FinishedGoodsQcPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "SO-1001" }));

    // 悬挂中：必须给出加载态，否则用户看到的是"空订单"
    expect(screen.getByText("正在加载订单质检详情…")).toBeVisible();
    expect(screen.queryByTestId("data-table")).toBeNull();

    gate.resolve(apiOk([sourceFixture()]));

    await waitFor(() => expect(screen.queryByText("正在加载订单质检详情…")).toBeNull());
    expect(screen.getByText("FGIN-001 / B-01")).toBeVisible();
  });

  it("订单下三类数据都为空时，每张表回落到各自的空态", async () => {
    stubQcApi({
      sources: [sourceFixture()],
      submissions: [submissionFixture()],
      detailSources: [],
      detailSubmissions: [],
      detailQc: [],
    });

    render(<FinishedGoodsQcPanel />);
    await openOrder("SO-1001");

    expect(screen.getByText("暂无成品来源")).toBeVisible();
    expect(screen.getByText("暂无送检记录")).toBeVisible();
    expect(screen.getByText("暂无质检记录")).toBeVisible();
    expect(screen.getAllByTestId("empty-state")).toHaveLength(3);
    expect(screen.queryByTestId("data-table")).toBeNull();
  });

  it("点「创建送检」按该来源的可送检数量下单，并提示成功后刷新数据", async () => {
    const calls = stubQcApi({
      sources: [sourceFixture()],
      submissions: [submissionFixture()],
      detailSources: [sourceFixture()],
      detailSubmissions: [submissionFixture()],
      detailQc: [],
    });

    render(<FinishedGoodsQcPanel />);
    await openOrder("SO-1001");

    const sourceTable = within(screen.getAllByTestId("data-table")[0]);
    await userEvent.click(sourceTable.getByRole("button", { name: "创建送检" }));

    await waitFor(() => expect(postCalls(calls)).toHaveLength(1));
    const created = postCalls(calls)[0];
    expect(created.url).toBe("/api/v1/finished-goods/inspection-submissions");
    // 送检数量默认取来源的可送检量，日期取当天
    expect(JSON.parse(String(created.body))).toEqual({
      production_order_id: "po-1",
      source_type: "finished_goods_inbound_notice",
      source_id: "src-1",
      submitted_quantity: "120",
      submission_date: today(),
    });

    expect(await screen.findByRole("status")).toHaveTextContent("成品送检单已创建");

    // 成功后必须重新拉取：列表刷新 1 次 + 详情刷新 1 次（点击订单进入时已各拉 1 次）
    expect(callsTo(calls, "/finished-goods/qc/sources")).toHaveLength(2);
    expect(calls.filter((call) => call.url === detailUrl("/finished-goods/qc/sources"))).toHaveLength(2);
  });

  it("创建送检被服务端拒绝时显示错误，且不给出成功提示、不刷新", async () => {
    const calls = stubQcApi({
      sources: [sourceFixture()],
      submissions: [submissionFixture()],
      detailSources: [sourceFixture()],
      detailSubmissions: [submissionFixture()],
      onCreate: () => apiErr(422, "QUANTITY_EXCEEDED", "可送检数量不足"),
    });

    render(<FinishedGoodsQcPanel />);
    await openOrder("SO-1001");

    const sourceTable = within(screen.getAllByTestId("data-table")[0]);
    await userEvent.click(sourceTable.getByRole("button", { name: "创建送检" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("可送检数量不足");
    expect(screen.queryByRole("status")).toBeNull();
    expect(calls.filter((call) => call.url === detailUrl("/finished-goods/qc/sources"))).toHaveLength(1);
  });

  it("只有草稿送检单给出「编辑 / 提交送检」，已提交的没有写入口", async () => {
    stubQcApi({
      sources: [sourceFixture()],
      submissions: [submissionFixture({ status: "draft" })],
      detailSources: [],
      detailSubmissions: [submissionFixture({ id: "sub-1", submissionNo: "FGIS-001", status: "draft" }), submissionFixture({ id: "sub-2", submissionNo: "FGIS-002", status: "submitted" })],
      detailQc: [],
    });

    render(<FinishedGoodsQcPanel />);
    await openOrder("SO-1001");

    const rows = screen.getAllByTestId("data-table-row");
    const draftRow = rows.find((row) => row.textContent?.includes("FGIS-001"));
    const submittedRow = rows.find((row) => row.textContent?.includes("FGIS-002"));
    expect(draftRow).toBeDefined();
    expect(submittedRow).toBeDefined();

    // KNOWN_DEFECT：与上面同源 —— 草稿状态显示为英文原值 draft，而不是 display-text 里的「草稿」。
    // 写入口的挂载条件用的正是 status === "draft"，这里同时证明筛选逻辑用的是原始值。
    expect(within(draftRow!).getByText("draft")).toBeVisible();
    expect(within(draftRow!).getByRole("button", { name: "编辑" })).toBeVisible();
    expect(within(draftRow!).getByRole("button", { name: "提交送检" })).toBeVisible();
    // 已提交但尚未录入 QC 的送检单可以「取消送检」（后端 cancel 允许 draft / submitted 且无 QC 记录），
    // 但不能编辑，也不能重复提交。
    expect(within(submittedRow!).queryByRole("button", { name: "编辑" })).toBeNull();
    expect(within(submittedRow!).queryByRole("button", { name: "提交送检" })).toBeNull();
    expect(within(submittedRow!).getByRole("button", { name: "取消送检" })).toBeVisible();
  });

  it("点「提交送检」调用该送检单的 submit 端点并刷新列表", async () => {
    const calls = stubQcApi({
      sources: [sourceFixture()],
      submissions: [submissionFixture({ status: "draft" })],
      detailSources: [],
      detailSubmissions: [submissionFixture({ status: "draft" })],
      detailQc: [],
    });

    render(<FinishedGoodsQcPanel />);
    await openOrder("SO-1001");

    await userEvent.click(screen.getByRole("button", { name: "提交送检" }));

    await waitFor(() => expect(postCalls(calls)).toHaveLength(1));
    expect(postCalls(calls)[0].url).toBe("/api/v1/finished-goods/inspection-submissions/sub-1/submit");
    // 成功路径会重新 load()：列表接口被再次调用
    expect(callsTo(calls, "/finished-goods/inspection-submissions")).toHaveLength(2);
  });

  it("提交送检失败时弹出错误 toast，且不触发刷新", async () => {
    const calls = stubQcApi({
      sources: [sourceFixture()],
      submissions: [submissionFixture({ status: "draft" })],
      detailSources: [],
      detailSubmissions: [submissionFixture({ status: "draft" })],
      detailQc: [],
      onSubmit: () => apiErr(500, "INTERNAL_ERROR", "服务器内部错误"),
    });

    render(
      <>
        <FinishedGoodsQcPanel />
        <Toaster />
      </>
    );
    await openOrder("SO-1001");

    await userEvent.click(screen.getByRole("button", { name: "提交送检" }));

    expect(await screen.findByTestId("toast-item")).toHaveTextContent("服务器内部错误");
    expect(callsTo(calls, "/finished-goods/inspection-submissions")).toHaveLength(1);
    expect(postCalls(calls)).toHaveLength(1);
  });

  it("「编辑」打开送检单弹窗：预填当前值，修改原因必填，通过后 PATCH 带 expected_version", async () => {
    const calls = stubQcApi({
      sources: [sourceFixture()],
      submissions: [submissionFixture({ status: "draft" })],
      detailSources: [],
      detailSubmissions: [submissionFixture({ status: "draft", remark: "原备注" })],
      detailQc: [],
    });

    render(<FinishedGoodsQcPanel />);
    await openOrder("SO-1001");

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));

    expect(await screen.findByRole("heading", { name: "编辑送检单：FGIS-001" })).toBeVisible();
    expect(fieldValue(/送检数量/)).toBe("100");
    expect(fieldValue(/送检日期/)).toBe("2024-05-01");
    expect(fieldValue(/修改原因/)).toBe("");

    // 修改原因是必填：缺失时不得发请求（乐观锁改动必须留痕）
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写修改原因");
    expect(patchCalls(calls)).toHaveLength(0);

    await fillField(/送检数量/, "80");
    await fillField(/修改原因/, "客户要求改数量");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(patchCalls(calls)).toHaveLength(1));
    expect(patchCalls(calls)[0].url).toBe("/api/v1/finished-goods/inspection-submissions/sub-1");
    expect(JSON.parse(String(patchCalls(calls)[0].body))).toEqual({
      submitted_quantity: "80",
      submission_date: "2024-05-01",
      remark: "原备注",
      reason: "客户要求改数量",
      expected_version: 3,
    });
  });

  it("弹窗「取消」关闭弹窗且不发任何写请求", async () => {
    const calls = stubQcApi({
      sources: [sourceFixture()],
      submissions: [submissionFixture({ status: "draft" })],
      detailSources: [],
      detailSubmissions: [submissionFixture({ status: "draft" })],
      detailQc: [],
    });

    render(<FinishedGoodsQcPanel />);
    await openOrder("SO-1001");

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await screen.findByRole("heading", { name: "编辑送检单：FGIS-001" });

    await userEvent.click(screen.getByTestId("action-dialog-cancel"));

    await waitFor(() => expect(screen.queryByTestId("action-dialog")).toBeNull());
    expect(patchCalls(calls)).toHaveLength(0);
    expect(postCalls(calls)).toHaveLength(0);
  });

  it("录入质检：未选送检批次时必填拦截，不发请求", async () => {
    const calls = stubQcApi({ sources: [sourceFixture()], submissions: [submissionFixture()], detailSources: [sourceFixture()], detailSubmissions: [submissionFixture()] });

    render(<FinishedGoodsQcPanel />);
    await openQcDialog("SO-1001");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写订单内送检批次");
    expect(postCalls(calls)).toHaveLength(0);
  });

  it("录入质检数量配平门禁：不配平 / 不合格无原因都被拦下，配平后才写质检记录", async () => {
    const calls = stubQcApi({ sources: [sourceFixture()], submissions: [submissionFixture()], detailSources: [sourceFixture()], detailSubmissions: [submissionFixture()] });

    render(<FinishedGoodsQcPanel />);

    // 1) 本次检验 10 ≠ 合格 8 + 条件接收 0 + 不合格 0
    await openQcDialog();
    await chooseSubmission(/FGIS-001/);
    await fillField(/本次检验数量/, "10");
    await fillField(/^合格数量/, "8");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent("数量不配平：本次检验 10 ≠ 合格 8 + 条件接收 0 + 不合格 0（拆分合计 8）");
    expect(postCalls(calls)).toHaveLength(0);
    // 校验失败不关窗：用户刚填的数量还在，接着改就行（与全站 ActionDialog 约定一致）
    expect(screen.getByTestId("action-dialog")).toBeVisible();
    expect(fieldValue(/本次检验数量/)).toBe("10");
    expect(fieldValue(/^合格数量/)).toBe("8");

    // 2) 同一个弹窗里补上不合格数量 2（10 = 8 + 0 + 2），但不合格原因未填
    await fillField(/不合格数量/, "2");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent("存在不合格数量时必须填写「不合格原因」");
    expect(postCalls(calls)).toHaveLength(0);

    // 3) 补齐不合格原因后放行，body 必须是弹窗里的全部字段值
    await fillField(/不合格原因/, "外观瑕疵");

    const before = calls.length;
    const detailBefore = calls.filter((call) => call.url === detailUrl("/finished-goods/qc/sources")).length;
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postCalls(calls)).toHaveLength(1));
    expect(postCalls(calls)[0].url).toBe("/api/v1/finished-goods/qc-records");
    expect(JSON.parse(String(postCalls(calls)[0].body))).toEqual({
      submission_id: "sub-1",
      inspection_date: today(),
      inspected_quantity: "10",
      qualified_quantity: "8",
      conditional_accept_quantity: "0",
      rejected_quantity: "2",
      rejection_reason: "外观瑕疵",
    });
    // 保存成功后列表与订单详情都被重新拉取（run 里的 load() + loadOrder()）
    expect(callsTo(calls, "/finished-goods/qc/sources")).toHaveLength(2);
    expect(calls.filter((call) => call.url === detailUrl("/finished-goods/qc/sources"))).toHaveLength(detailBefore + 1);
    expect(calls.length).toBeGreaterThan(before);
  });

  it("录入质检：按订单号选择后直接打开该订单的成品质检表单", async () => {
    stubQcApi({ sources: [sourceFixture()], submissions: [submissionFixture()] });

    render(<FinishedGoodsQcPanel />);

    await userEvent.click(await screen.findByRole("button", { name: "录入质检" }));
    const picker = await screen.findByTestId("action-dialog");
    await userEvent.click(within(picker).getByRole("combobox"));
    await userEvent.click(await within(picker).findByRole("option", { name: "SO-1001" }));
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    // 选完订单号后必须出现该订单的质检表单：历史上这里同步打开第二个弹窗，
    // 被 ActionDialog 紧随其后的 onOpenChange(false) 一起清掉，入口完全不可用。
    expect(await screen.findByRole("heading", { name: "录入成品质检：SO-1001" })).toBeVisible();
    const form = screen.getByTestId("action-dialog");
    expect(within(form).getByTestId("action-field-inspected_quantity")).toBeVisible();
    expect(within(form).getByTestId("action-field-rejection_reason")).toBeVisible();
  });

  it("订单号搜索过滤入口，点「查询」按首个可见订单号加载详情", async () => {
    const calls = stubQcApi({
      sources: [sourceFixture()],
      submissions: [submissionFixture(), submissionFixture({ id: "sub-9", submissionNo: "FGIS-009", orderNo: "SO-2002", sourceId: "src-9" })],
    });

    render(<FinishedGoodsQcPanel />);
    expect(await screen.findByRole("button", { name: "SO-1001" })).toBeVisible();
    expect(screen.getByRole("button", { name: "SO-2002" })).toBeVisible();

    await userEvent.type(screen.getByPlaceholderText("输入订单号搜索"), "2002");
    expect(screen.queryByRole("button", { name: "SO-1001" })).toBeNull();
    expect(screen.getByRole("button", { name: "SO-2002" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "查询" }));

    expect(await screen.findByRole("heading", { name: "订单详情：SO-2002" })).toBeVisible();
    expect(calls.some((call) => call.url === detailUrl("/finished-goods/qc/sources", "SO-2002"))).toBe(true);
    expect(calls.some((call) => call.url.includes("order_no=SO-1001"))).toBe(false);
  });
});
