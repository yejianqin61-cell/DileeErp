// 质检模块（/qc）的行为测试。
//
// 为什么需要它：QC 从「采购 / 仓库 / 成品仓储」三个页面拆到独立模块后，
// 页面级组合、深链自动开单、以及每条质检动作打到的端点都属于「拆完就看不见」的契约——
// 源码正则守卫（lib/finished-goods-storage.test.mjs）只能证明代码里有这些字符串，
// 证明不了点下去真的发出正确请求、或者深链真的把弹窗打开。
//
// 全部用真实 render + userEvent 驱动，只断言渲染结果与真实网络调用。
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QcPage from "../app/qc/page";
import { IncomingInspectionsPanel } from "../components/qc/incoming-inspections-panel";
import { FinishedGoodsQcPanel } from "../components/qc/finished-goods-qc-panel";
import { QcInboundPanel } from "../components/qc/qc-inbound-panel";
import { Toaster } from "../components/ui/toaster";
import { apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

// next/navigation 桩：深链参数由每个用例设置。
const params = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => params.current }));

const postCalls = (calls: StubbedCall[], suffix: string) => calls.filter((call) => call.method === "POST" && call.url.endsWith(suffix));
const bodyOf = (call: StubbedCall | undefined) => JSON.parse(String(call?.body ?? "{}"));

const receipt = { id: "r-1", receiptNo: "RC-1", quantity: "100", status: "received", batchSequence: 1, inspections: [] };
const purchaseOrder = {
  id: "po-1",
  purchaseOrderNo: "PO-1",
  orderNo: "SO-1",
  status: "ordered",
  items: [{ id: "i-1", quantity: "100", material: { materialCode: "M-1", name: "面料" }, unit: { name: "米" }, receipts: [receipt] }],
};
const inspection = {
  id: "insp-1",
  orderNo: "SO-1",
  purchase_order_no: "PO-1",
  material_name: "面料",
  status: "accepted",
  qcResult: "all_inbound",
  batchSequence: 1,
  inspectedQuantity: "100",
  acceptedQuantity: "100",
  conditionalQuantity: "0",
  rejectedQuantity: "0",
  downstream_exists: false,
};
const qcAvailable = {
  qc_id: "qc-1",
  qc_no: "QC-1",
  order_no: "SO-1",
  submission_id: "sub-1",
  source_type: "finished_goods_inbound_notice",
  qualified_quantity: "10",
  conditional_accept_quantity: "0",
  rejected_quantity: "2",
  available_for_inbound_quantity: "10",
  available_for_defective_quantity: "2",
  unit: "件",
};

/** /qc 组合页所需的全部分支：任何未知端点都返回空数组，避免用例被无关请求干扰。 */
function stubQcModule(overrides: { inspections?: unknown[]; purchaseOrders?: unknown[]; notices?: unknown[]; notificationStatuses?: string[] } = {}) {
  return stubApi((url: string) => {
    if (url.endsWith("/purchase-orders")) return apiOk(overrides.purchaseOrders ?? [purchaseOrder]);
    if (url.endsWith("/incoming-inspections")) return apiOk(overrides.inspections ?? [inspection]);
    if (url.includes("/incoming-inspections")) return apiOk([]);
    if (url.endsWith("/raw-material-inbounds")) return apiOk([]);
    if (url.endsWith("/raw-material-inbound-notices")) return apiOk(overrides.notices ?? []);
    if (url.includes("/raw-material-inbounds/")) return apiOk({});
    if (url.includes("/raw-material-inbound-notices")) return apiOk({});
    if (url.includes("/finished-goods/qc-records/available-inbound-sources")) return apiOk([qcAvailable]);
    if (url.includes("/finished-goods/defectives")) return apiOk([]);
    if (url.includes("/finished-goods/qc/sources")) return apiOk([]);
    if (url.includes("/finished-goods/inspection-submissions")) return apiOk([]);
    return apiOk([]);
  });
}

/** 已接收（仓库会同时自动建出入库草稿）的入库通知：只有这时质检侧才谈得上建草稿。 */
const acknowledgedNotice = { id: "n-1", noticeNo: "RMIN-1", incomingInspectionId: "insp-1", status: "acknowledged", notifiedQuantity: "100" };
/** 已通知但仓库还没接收：此时建草稿一定 422（INBOUND_NOTICE_NOT_ACKNOWLEDGED），页面不得给出按钮。 */
const pendingNotice = { id: "n-2", noticeNo: "RMIN-2", incomingInspectionId: "insp-1", status: "pending", notifiedQuantity: "100" };

describe("质检模块页（/qc）", () => {
  it("一个页面同时挂载来料质检、成品质检、质检合格待入库/次品登记三块", async () => {
    params.current = new URLSearchParams();
    stubQcModule();

    render(<><QcPage /><Toaster /></>);

    expect(await screen.findByTestId("page-qc")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "来料质检" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "成品质检" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "质检合格待入库 / 次品登记" })).toBeVisible();
    // 二级去向都在页面上给出来（原料/成品的实际出入库回到仓库模块）
    expect(screen.getByRole("link", { name: "去原料仓储情况过账入库" })).toHaveAttribute("href", "/warehouse/raw-material-storage");
    expect(screen.getByRole("link", { name: "去成品仓储情况过账入库" })).toHaveAttribute("href", "/warehouse/finished-goods-storage");
  });
});

describe("来料质检面板", () => {
  it("深链 receipt_id：直接打开该到货批次的送检登记，数量默认剩余可送检量，提交 body 带该批次", async () => {
    const calls = stubQcModule();

    render(<><IncomingInspectionsPanel receiptId="r-1" /><Toaster /></>);

    expect(await screen.findByRole("heading", { name: "登记来料质检：PO-1 / 第 1 批" })).toBeVisible();
    expect(screen.getByTestId("action-field-quantity")).toHaveValue(100);

    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postCalls(calls, "/incoming-inspections")).toHaveLength(1));
    expect(bodyOf(postCalls(calls, "/incoming-inspections")[0])).toEqual({
      purchase_receipt_id: "r-1",
      inspected_quantity: "100",
      qc_result: "all_inbound",
      accepted_quantity: "100",
      conditional_quantity: "0",
      rejected_quantity: "0",
    });
  });

  it("未知 receipt_id 明确指出批次不存在（不再静默，用户不会以为页面坏了）", async () => {
    stubQcModule();

    render(<IncomingInspectionsPanel receiptId="r-does-not-exist" />);

    expect(await screen.findByText("面料")).toBeVisible();
    expect(screen.queryByTestId("action-dialog")).toBeNull();
    expect(await screen.findByText(/未找到该到货批次/)).toBeVisible();
  });

  it("深链默认送检量 = 到货量 − 已送检量（列表接口不给 inspections，必须用质检记录算）", async () => {
    // 到货 100，已有一张送检 40 的质检单 → 深链默认本次只能送 60。
    // 这正是旧实现（用 receipt.inspections 算剩余）必然踩中的 422：列表接口不返回该字段。
    const calls = stubQcModule({ inspections: [{ ...inspection, inspectedQuantity: "40", acceptedQuantity: "40", purchaseReceipt: { id: "r-1" } }] });

    render(<><IncomingInspectionsPanel receiptId="r-1" /><Toaster /></>);

    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByTestId("action-field-quantity")).toHaveValue(60);

    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postCalls(calls, "/incoming-inspections")).toHaveLength(1));
    expect(bodyOf(postCalls(calls, "/incoming-inspections")[0])).toMatchObject({ purchase_receipt_id: "r-1", inspected_quantity: "60", accepted_quantity: "60" });
  });

  it("深链指向已送检完毕的批次：不弹空表单，直接提示去编辑/回退重判", async () => {
    stubQcModule({ inspections: [{ ...inspection, inspectedQuantity: "100", acceptedQuantity: "100", purchaseReceipt: { id: "r-1" } }] });

    render(<IncomingInspectionsPanel receiptId="r-1" />);

    expect(await screen.findByText(/已送检完毕/)).toBeVisible();
    expect(screen.queryByTestId("action-dialog")).toBeNull();
  });

  it("深链指向已整批退货（cancelled）的批次：提示重新登记到货，而不是让用户去点没有的按钮", async () => {
    stubQcModule({ inspections: [{ ...inspection, status: "cancelled", inspectedQuantity: "100", acceptedQuantity: "0", rejectedQuantity: "100", purchaseReceipt: { id: "r-1" } }] });

    render(<IncomingInspectionsPanel receiptId="r-1" />);

    expect(await screen.findByText(/已整批退货/)).toBeVisible();
    expect(screen.queryByTestId("action-dialog")).toBeNull();
  });

  it("全部批次都已送检完毕时点「登记来料质检」：说明真实原因，不说「先去采购登记到货」", async () => {
    stubQcModule({ inspections: [{ ...inspection, inspectedQuantity: "100", acceptedQuantity: "100", purchaseReceipt: { id: "r-1" } }] });

    render(<IncomingInspectionsPanel />);

    await userEvent.click(await screen.findByRole("button", { name: "登记来料质检" }));

    expect(await screen.findByTestId("qc-hint")).toHaveTextContent("所有到货批次都已送检完毕");
    expect(screen.queryByTestId("action-dialog")).toBeNull();
  });

  it("空 receipt_id 等同于没有深链：不弹窗也不报错", async () => {
    stubQcModule();

    render(<IncomingInspectionsPanel receiptId="" />);

    expect(await screen.findByText("面料")).toBeVisible();
    expect(screen.queryByTestId("action-dialog")).toBeNull();
    expect(screen.queryByTestId("qc-hint")).toBeNull();
  });

  it("窗口重新获得焦点时静默重拉（仓库在别的页面接收通知后回来就能看到最新状态）", async () => {
    const calls = stubQcModule();

    render(<IncomingInspectionsPanel />);
    await screen.findByText("面料");
    const before = calls.filter((call) => call.url.endsWith("/incoming-inspections")).length;

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(calls.filter((call) => call.url.endsWith("/incoming-inspections")).length).toBeGreaterThan(before));
  });

  it("静默刷新不会清掉深链提示（提示与错误分开存）", async () => {
    stubQcModule();

    render(<IncomingInspectionsPanel receiptId="r-missing" />);
    expect(await screen.findByTestId("qc-hint")).toHaveTextContent("未找到该到货批次");

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(screen.getByTestId("qc-hint")).toHaveTextContent("未找到该到货批次"));
  });

  it("送检数量不配平时原地报错、不发请求、弹窗保持打开", async () => {
    const calls = stubQcModule();

    render(<><IncomingInspectionsPanel /><Toaster /></>);

    await userEvent.click(await screen.findByRole("button", { name: "登记来料质检" }));
    const dialog = await screen.findByTestId("action-dialog");
    await userEvent.click(within(dialog).getByTestId("action-field-receipt_id"));
    await userEvent.click(await screen.findByRole("option", { name: /PO-1/ }));

    const accepted = within(dialog).getByTestId("action-field-accepted_quantity");
    await userEvent.clear(accepted);
    await userEvent.type(accepted, "2");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("数量不配平");
    expect(postCalls(calls, "/incoming-inspections")).toHaveLength(0);
    expect(screen.getByTestId("action-dialog")).toBeVisible();
  });

  it("拒收：拆分按后端规则写成 合格 0 / 条件 0 / 不合格 = 送检量（不是把送检量写进两列）", async () => {
    const calls = stubQcModule();

    render(<><IncomingInspectionsPanel receiptId="r-1" /><Toaster /></>);

    const dialog = await screen.findByTestId("action-dialog");
    await userEvent.click(within(dialog).getByTestId("action-field-qc_result"));
    await userEvent.click(await screen.findByRole("option", { name: "拒收" }));
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postCalls(calls, "/incoming-inspections")).toHaveLength(1));
    expect(bodyOf(postCalls(calls, "/incoming-inspections")[0])).toEqual({
      purchase_receipt_id: "r-1",
      inspected_quantity: "100",
      qc_result: "rejected",
      accepted_quantity: "0",
      conditional_quantity: "0",
      rejected_quantity: "100",
    });
  });

  it("判定完成后：先通知入库；仓库接收（acknowledged）后才给「按剩余量入库」入口", async () => {
    const calls = stubQcModule();

    render(<><IncomingInspectionsPanel /><Toaster /></>);

    // 通知阶段：只给「通知入库」，不给建草稿入口（未接收时后端 422 INBOUND_NOTICE_NOT_ACKNOWLEDGED）
    const notify = await screen.findByRole("button", { name: "通知入库" });
    expect(screen.queryByRole("button", { name: "按剩余量入库" })).toBeNull();
    expect(screen.queryByRole("button", { name: "部分入库" })).toBeNull();
    await userEvent.click(notify);
    await waitFor(() => expect(postCalls(calls, "/raw-material-inbound-notices")).toHaveLength(1));
    expect(bodyOf(postCalls(calls, "/raw-material-inbound-notices")[0])).toEqual({ inspection_id: "insp-1" });
  });

  it("仓库接收通知后：按剩余量建原料入库草稿（未接收前该按钮不存在）", async () => {
    const calls = stubQcModule({ notices: [acknowledgedNotice] });

    render(<><IncomingInspectionsPanel /><Toaster /></>);

    expect(await screen.findByText(/RMIN-1/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "通知入库" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "按剩余量入库" }));
    await waitFor(() => expect(postCalls(calls, "/raw-material-inbounds")).toHaveLength(1));
    expect(bodyOf(postCalls(calls, "/raw-material-inbounds")[0])).toEqual({
      incoming_inspection_id: "insp-1",
      quantity: "100",
      inventory_category: "raw_material",
    });
  });

  it("通知存在但仍是 pending（仓库未接收）时不得给出建草稿按钮：那正是点下去必然 422 的场景", async () => {
    stubQcModule({ notices: [pendingNotice] });

    render(<><IncomingInspectionsPanel /><Toaster /></>);

    // 通知已经在，所以不该再给「通知入库」；也还没接收，所以不该给建草稿入口
    expect(await screen.findByText(/RMIN-2/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "通知入库" })).toBeNull();
    expect(screen.queryByRole("button", { name: "按剩余量入库" })).toBeNull();
    expect(screen.queryByRole("button", { name: "部分入库" })).toBeNull();
    expect(screen.getByText(/待仓库接收通知/)).toBeVisible();
  });

  it("判定为 accepted（正常送检结果）也能回退重判，不必走整批退货", async () => {
    const calls = stubQcModule();

    render(<><IncomingInspectionsPanel /><Toaster /></>);

    await userEvent.click(await screen.findByRole("button", { name: "回退重判" }));
    const dialog = await screen.findByTestId("action-dialog");
    await userEvent.type(within(dialog).getByTestId("action-field-reason"), "判定填错");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/incoming-inspections/insp-1/status"))).toHaveLength(1));
    expect(bodyOf(calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/status"))[0])).toEqual({ target: "pending", reason: "判定填错" });
  });
});

describe("质检合格待入库 / 次品登记面板", () => {
  it("按 QC 净值登记成品入库与次品，端点与 body 正确", async () => {
    const calls = stubQcModule();

    render(<><QcInboundPanel /><Toaster /></>);

    await userEvent.click(await screen.findByRole("button", { name: "登记入库" }));
    const inboundDialog = await screen.findByTestId("action-dialog");
    expect(within(inboundDialog).getByTestId("action-field-quantity")).toHaveValue(10);
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postCalls(calls, "/finished-goods/inbounds")).toHaveLength(1));
    expect(bodyOf(postCalls(calls, "/finished-goods/inbounds")[0])).toEqual({ qc_record_id: "qc-1", quantity: "10" });

    await userEvent.click(await screen.findByRole("button", { name: "登记次品" }));
    const defectiveDialog = await screen.findByTestId("action-dialog");
    expect(within(defectiveDialog).getByTestId("action-field-quantity")).toHaveValue(2);
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postCalls(calls, "/finished-goods/defectives")).toHaveLength(1));
    expect(bodyOf(postCalls(calls, "/finished-goods/defectives")[0])).toEqual({ qc_record_id: "qc-1", quantity: "2" });
  });
});

describe("成品质检面板的订单号深链", () => {
  it("带 order_no 进入时直接展开该订单的质检详情", async () => {
    stubApi(() => apiOk([]));

    render(<FinishedGoodsQcPanel initialOrderNo="SO-9" />);

    expect(await screen.findByRole("heading", { name: "订单详情：SO-9" })).toBeVisible();
  });

  it("质检记录「更正」：预填原值、必须填更正原因，提交打 correct 端点", async () => {
    const qcRow = {
      qc_id: "qc-1", qc_no: "QC-1", order_no: "SO-9", submission_id: "sub-1", source_type: "finished_goods_inbound_notice", source_id: "src-1",
      qualified_quantity: "10", conditional_accept_quantity: "0", rejected_quantity: "2", available_for_inbound_quantity: "10",
      conditionally_accepted: false, inspected_quantity: "12", inspection_date: "2026-01-02T00:00:00.000Z", rejection_reason: "外观瑕疵", available_for_correction: true, unit: "件",
    };
    const calls = stubApi((url: string) => (url.includes("/finished-goods/qc-records/available-inbound-sources") ? apiOk([qcRow]) : apiOk([])));

    render(<><FinishedGoodsQcPanel initialOrderNo="SO-9" /><Toaster /></>);

    await userEvent.click(await screen.findByRole("button", { name: "更正" }));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByTestId("action-field-inspected_quantity")).toHaveValue(12);
    expect(within(dialog).getByTestId("action-field-qualified_quantity")).toHaveValue(10);
    expect(within(dialog).getByTestId("action-field-rejected_quantity")).toHaveValue(2);
    expect(within(dialog).getByTestId("action-field-inspection_date")).toHaveValue("2026-01-02");

    // 只改合格数量、不改检验数量：不配平必须就地拦下（弹窗保留，不发请求）
    await userEvent.clear(within(dialog).getByTestId("action-field-qualified_quantity"));
    await userEvent.type(within(dialog).getByTestId("action-field-qualified_quantity"), "11");
    await userEvent.type(within(dialog).getByTestId("action-field-reason"), "复核后修正");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("数量不配平");
    expect(postCalls(calls, "/correct")).toHaveLength(0);
    expect(screen.getByTestId("action-dialog")).toBeVisible();

    // 改回配平（11 → 10）后提交：body 是更正后的完整口径 + 更正原因
    await userEvent.clear(within(dialog).getByTestId("action-field-qualified_quantity"));
    await userEvent.type(within(dialog).getByTestId("action-field-qualified_quantity"), "10");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postCalls(calls, "/finished-goods/qc-records/qc-1/correct")).toHaveLength(1));
    expect(bodyOf(postCalls(calls, "/finished-goods/qc-records/qc-1/correct")[0])).toMatchObject({
      inspected_quantity: "12",
      qualified_quantity: "10",
      conditional_accept_quantity: "0",
      rejected_quantity: "2",
      rejection_reason: "外观瑕疵",
      reason: "复核后修正",
    });
  });
});

describe("同页跨面板刷新（否则刚写进去的数字一直是旧的）", () => {
  it("登记成品入库后，来料质检与成品质检两块会重新拉取自己的数据", async () => {
    const calls = stubQcModule();
    params.current = new URLSearchParams();

    render(<><QcPage /><Toaster /></>);
    await screen.findByRole("heading", { name: "质检合格待入库 / 次品登记" });
    const beforeInbounds = calls.filter((call) => call.url.endsWith("/incoming-inspections")).length;
    const beforeSources = calls.filter((call) => call.url.includes("/finished-goods/qc/sources")).length;

    await userEvent.click(await screen.findByRole("button", { name: "登记入库" }));
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postCalls(calls, "/finished-goods/inbounds")).toHaveLength(1));

    // 入库草稿会影响原料侧可入库量与成品质检的净值展示，两块必须重新拉取
    await waitFor(() => expect(calls.filter((call) => call.url.endsWith("/incoming-inspections")).length).toBeGreaterThan(beforeInbounds));
    await waitFor(() => expect(calls.filter((call) => call.url.includes("/finished-goods/qc/sources")).length).toBeGreaterThan(beforeSources));
  });
});
