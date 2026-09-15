// 应付管理（/finance/payable?tab=…）的**行为**测试：真实渲染 + 真实点击 + 断言真实请求。
//
// 为什么专门测这条链路：用户反馈「点接受应付没有反应，没有流转到应付对账」「对账创建完也没有流转到
// 确认付款去」——流转的每一步必须看得见、点得动。本文件钉住三件事：
//   1. 四步流转看板给出当前卡在哪一步（数量 + 入口链接）；
//   2. 对账列表用**列表接口**的 flow 摘要显示 订单号 / 采购物料 / 待确认条数，并给出一键「确认 N 条应付」；
//   3. 接收应付与创建对账各自的请求契约与下一步提示。
//
// 数据契约（全部来自组件源码）：
//   GET  /api/v1/payable-sources                                          原料入库应付来源
//   GET  /api/v1/production/outsource-logistics-batches/payable-sources    外加工签收应付来源
//   GET  /api/v1/finance/payable-entries                                  应付条目（草稿/已确认）
//   GET  /api/v1/finance/supplier-payments                                供应商付款
//   GET  /api/v1/finance/supplier-payable-reconciliations                 应付对账单（含 flow 摘要）
//   GET  /api/v1/suppliers | /api/v1/sales-orders | /api/v1/finance/banks  下拉主数据
//   POST /api/v1/finance/payable-entries/from-source                     接收应付来源 → 应付草稿
//   POST /api/v1/finance/supplier-payable-reconciliations                 创建应付对账
//   POST /api/v1/finance/supplier-payable-reconciliations/:id/confirm-payables  对账后批量确认应付
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PayableWorkspace from "../components/finance/payable-workspace";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  sources: "/api/v1/payable-sources",
  outsource: "/api/v1/production/outsource-logistics-batches/payable-sources",
  entries: "/api/v1/finance/payable-entries",
  payments: "/api/v1/finance/supplier-payments",
  reconciliations: "/api/v1/finance/supplier-payable-reconciliations",
  suppliers: "/api/v1/suppliers",
  orders: "/api/v1/sales-orders",
  banks: "/api/v1/finance/banks",
  currencies: "/api/v1/dictionaries/currency/items",
} as const;

type Handler = (url: string, call: StubbedCall) => Response | undefined | Promise<Response | undefined>;
type Data = Partial<Record<"sources" | "outsource" | "entries" | "payments" | "reconciliations" | "suppliers" | "orders" | "banks", unknown[]>>;

function stubPayable(data: Data = {}, extra?: Handler) {
  return stubApi(async (url, call) => {
    const injected = await extra?.(url, call);
    if (injected) return injected;
    if (url.startsWith(EP.outsource)) return apiOk(data.outsource ?? []);
    if (url.startsWith(EP.sources)) return apiOk(data.sources ?? []);
    if (url.startsWith(EP.entries)) return apiOk(data.entries ?? []);
    if (url.startsWith(EP.payments)) return apiOk(data.payments ?? []);
    if (url.startsWith(EP.reconciliations)) return call.method === "GET" ? apiOk(data.reconciliations ?? []) : apiOk({ confirmed_count: 2, confirmed_amount: "800.0000", skipped_count: 0 });
    if (url.startsWith(EP.suppliers)) return apiOk(data.suppliers ?? []);
    if (url.startsWith(EP.orders)) return apiOk(data.orders ?? []);
    if (url.startsWith(EP.banks)) return apiOk(data.banks ?? []);
    if (url.startsWith(EP.currencies)) return apiOk([]);
    return apiOk({});
  });
}

async function openPayable(tab: "raw-inbound-entries" | "reconciliations" | "confirmed" = "reconciliations") {
  render(<><PayableWorkspace tab={tab} testId="page-finance-payable" /><Toaster /></>);
  return screen.findByTestId("page-finance-payable");
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const postsTo = (calls: StubbedCall[], suffix: string) => callsTo(calls, suffix).filter((call) => call.method === "POST");
const setValue = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

// ------------------------------------------------------------------ 夹具

const inboundSource = {
  id: "source-1", orderNo: "SO-1", quantity: "100", unitPrice: "5", taxRate: null, amount: "500", currency: "CNY",
  status: "pending_finance", createdAt: "2026-09-10T00:00:00.000Z",
  supplier: { id: "supplier-1", name: "晋江大田" }, material_name: "涤纶布", material_code: "M-001",
  rawMaterialInbound: { inboundNo: "IN-001", status: "posted" }, purchase_order_no: "PO-1",
};
const draftEntry = {
  id: "entry-1", payableNo: "AP-001", orderNo: "SO-1", supplierId: "supplier-1", sourceType: "raw_material_inbound", sourceNoSnapshot: "IN-001",
  quantity: "100", unitPrice: "5", taxRate: null, amount: "500.0000", currency: "CNY", confirmationDate: "2026-09-10T00:00:00.000Z",
  status: "draft", remark: null, createdAt: "2026-09-10T00:00:00.000Z",
  material_name: "涤纶布", supplier_name: "晋江大田", paid_amount: "0", outstanding_amount: "500.0000",
};
const confirmedEntry = { ...draftEntry, id: "entry-2", payableNo: "AP-002", status: "confirmed", paid_amount: "500.0000", outstanding_amount: "0.0000" };
/** 已对平、范围内还有 2 条待确认草稿的对账单（flow 来自列表接口）。 */
const matchedReconciliation = {
  id: "recon-1", reconciliationNo: "APREC-001", orderNo: null, supplierId: "supplier-1",
  periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-09-30T00:00:00.000Z",
  payableAmountSnapshot: "800.0000", paymentAmountSnapshot: "0.0000", adjustmentAmountSnapshot: "0.0000", systemBalance: "800.0000",
  externalBalance: "800.0000", difference: "0.0000", currency: "CNY", status: "matched", resolutionRemark: null, remark: null, createdAt: "2026-09-30T00:00:00.000Z",
  supplier: { id: "supplier-1", name: "晋江大田" },
  flow: { entry_count: 2, draft_count: 2, draft_amount: "800.0000", can_confirm_payables: true, order_nos: ["SO-1", "SO-2"], purchase_order_nos: ["PO-1"], material_names: ["涤纶布", "拉链"] },
};
const differenceReconciliation = { ...matchedReconciliation, id: "recon-2", reconciliationNo: "APREC-002", status: "difference", difference: "-200.0000", flow: { ...matchedReconciliation.flow, can_confirm_payables: false } };

// ------------------------------------------------------------------ 流转看板

describe("应付管理：流转看板", () => {
  it("四步流转各自给出数量与入口，卡住的那一步高亮", async () => {
    stubPayable({ sources: [inboundSource], entries: [draftEntry, confirmedEntry], reconciliations: [matchedReconciliation] });
    await openPayable();
    const flow = within(screen.getByTestId("payable-flow"));
    expect(flow.getByTestId("payable-flow-receive")).toHaveTextContent("待接收来源 1 条");
    expect(flow.getByTestId("payable-flow-reconcile")).toHaveTextContent("待确认应付草稿 1 条（500.00）");
    expect(flow.getByTestId("payable-flow-confirm")).toHaveTextContent("已对平待确认 2 条");
    expect(flow.getByTestId("payable-flow-pay")).toHaveTextContent("已确认未付 500.00");
    // 「去对账」「去确认」都指到应付对账子栏目
    expect(within(flow.getByTestId("payable-flow-reconcile")).getByRole("link")).toHaveAttribute("href", "/finance/payable?tab=reconciliations");
    expect(within(flow.getByTestId("payable-flow-pay")).getByRole("link")).toHaveAttribute("href", "/finance/payable?tab=confirmed");
    expect(flow.getByTestId("payable-flow-confirm").className).toContain("flow-step-active");
  });
});

// ------------------------------------------------------------------ 应付对账

describe("应付管理：应付对账", () => {
  it("待创建对账按供应商 + 月份分组，并显示该批原料的订单号与采购物料", async () => {
    stubPayable({ entries: [draftEntry, { ...draftEntry, id: "entry-3", orderNo: "SO-2", material_name: "拉链", material_code: "M-002" }] });
    await openPayable("reconciliations");
    const row = screen.getByText("晋江大田").closest("tr") as HTMLElement;
    expect(within(row).getByText("2026-09")).toBeVisible();
    expect(within(row).getByText("SO-1、SO-2")).toBeVisible();
    expect(within(row).getByText("涤纶布、拉链")).toBeVisible();
    expect(within(row).getByText("2 条")).toBeVisible();
  });

  it("已创建对账单用列表的 flow 摘要显示订单号/采购单号/物料/待确认条数", async () => {
    stubPayable({ reconciliations: [matchedReconciliation] });
    await openPayable("reconciliations");
    const row = within(screen.getByTestId("reconciliation-actions-recon-1")).getByText("确认 2 条应付").closest("tr") as HTMLElement;
    expect(within(row).getByText("SO-1、SO-2")).toBeVisible();
    expect(within(row).getByText("PO-1")).toBeVisible();
    expect(within(row).getByText("涤纶布、拉链")).toBeVisible();
    expect(within(row).getByText("2 条 / 800.0000")).toBeVisible();
    expect(within(row).getByText("已对平")).toBeVisible();
  });

  it("对平且有草稿时行内「确认 N 条应付」→ POST confirm-payables 并提示实际条数", async () => {
    const calls = stubPayable({ reconciliations: [matchedReconciliation] });
    await openPayable("reconciliations");
    await userEvent.click(screen.getByTestId("reconciliation-confirm-recon-1"));
    await waitFor(() => expect(postsTo(calls, "/finance/supplier-payable-reconciliations/recon-1/confirm-payables")).toHaveLength(1));
    expect(postsTo(calls, "/finance/supplier-payable-reconciliations/recon-1/confirm-payables")[0].body).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("APREC-001 已确认 2 条应付"))).toBe(true));
  });

  it("有差异时只给「处理差异」，不给批量确认（金额没核对清楚不能记成负债）", async () => {
    stubPayable({ reconciliations: [differenceReconciliation] });
    await openPayable("reconciliations");
    const actions = within(screen.getByTestId("reconciliation-actions-recon-2"));
    expect(actions.getByRole("button", { name: "处理差异" })).toBeVisible();
    expect(actions.queryByRole("button", { name: /确认 \d+ 条应付/ })).toBeNull();
  });

  it("已对平但范围内没有草稿时给出说明文字（不再显示会误导的「确认 0 条」）", async () => {
    stubPayable({ reconciliations: [{ ...matchedReconciliation, flow: { ...matchedReconciliation.flow, draft_count: 0, draft_amount: "0.0000", can_confirm_payables: false } }] });
    await openPayable("reconciliations");
    expect(within(screen.getByTestId("reconciliation-actions-recon-1")).getByText("范围内没有待确认应付")).toBeVisible();
  });

  it("创建对账：POST /finance/supplier-payable-reconciliations 且带供应商/期间/外部余额/币种", async () => {
    const calls = stubPayable({ entries: [draftEntry], reconciliations: [], suppliers: [{ id: "supplier-1", name: "晋江大田", supplierCode: "S-001" }] });
    await openPayable("reconciliations");
    // 待创建对账分组行上的「创建对账」会把供应商与月份预填进弹窗
    await userEvent.click(screen.getByRole("button", { name: "创建对账" }));
    expect((screen.getByTestId("action-field-period_start") as HTMLInputElement).value).toBe("2026-09-01");
    setValue("action-field-external_balance", "800");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, EP.reconciliations)).toHaveLength(1));
    expect(bodyOf(postsTo(calls, EP.reconciliations)[0])).toMatchObject({ supplier_id: "supplier-1", period_start: "2026-09-01", period_end: "2026-09-30", external_balance: "800", currency: "CNY" });
  });
});

// ------------------------------------------------------------------ 接收应付

describe("应付管理：接收应付来源", () => {
  it("点「接收应付」弹出金额确认，提交 POST /finance/payable-entries/from-source，并提示下一步去对账", async () => {
    const calls = stubPayable({ sources: [inboundSource] });
    await openPayable("raw-inbound-entries");
    await userEvent.click(screen.getByRole("button", { name: "接收应付" }));
    expect((screen.getByTestId("action-field-amount") as HTMLInputElement).value).toBe("500");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/finance/payable-entries/from-source")).toHaveLength(1));
    expect(bodyOf(postsTo(calls, "/finance/payable-entries/from-source")[0])).toMatchObject({ source_type: "raw_material_inbound", source_id: "source-1", amount: "500" });
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("下一步：到「应付对账」"))).toBe(true));
  });

  it("已接收的来源不再显示接收按钮", async () => {
    stubPayable({ sources: [{ ...inboundSource, status: "converted" }] });
    await openPayable("raw-inbound-entries");
    expect(screen.queryByRole("button", { name: "接收应付" })).toBeNull();
    expect(screen.getByText("已接收")).toBeVisible();
  });
});

// ------------------------------------------------------------------ 失败态

describe("应付管理：失败态", () => {
  it("列表 403 落到错误态并给出重试入口", async () => {
    stubPayable({}, (url, call) => (call.method === "GET" && url.startsWith(EP.entries) ? apiErr(403, "FORBIDDEN", "无权访问应付条目") : undefined));
    await openPayable();
    expect(screen.getByTestId("error-state")).toHaveTextContent("无权访问应付条目");
    expect(screen.queryByTestId("payable-flow")).toBeNull();
  });
});
