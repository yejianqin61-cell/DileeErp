// 财务模块的**行为**测试：真实渲染 + 真实点击 + 断言真实发出的请求。
//
// 2026-09-14 重构后财务分为「一级 4 板块 + 二级子栏目」，页面组件直接接收 tab，
// 因此这里渲染组件（而不渲染 async 的 Server Component 页面文件）。
//
// 本文件继承旧财务页测试（原 apps/web/test/finance-page.test.tsx 与
// lib/finance-draft-edit-method.test.mjs）的三条意图，并改成运行时断言：
//   1) 应收 / 收款 / 付款 / 应付四个草稿「编辑」必须发出 PATCH（用 POST 会 404）；
//   2) 过账 / 核销 / 确认 / 回退 / 取消 / 冲销 / 接收应对仍然走 POST；
//   3) 每个入口的 URL 指向 /:id 而不是集合根。
// 桩会复刻真实 API 的注册形状（草稿编辑只认 PATCH，POST 返回 404），所以一旦回归成 POST，
// 用户看到的"操作失败"会在测试里重现（成功提示不会出现）。
//
// 说明：动作结果是通过 toast 呈现的（notifySuccess / notifyError），因此渲染时一并挂 <Toaster />。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FinanceBoardIndex from "../components/finance/finance-board-index";
import ReceivableWorkspace from "../components/finance/receivable-workspace";
import PayableWorkspace from "../components/finance/payable-workspace";
import VoucherWorkspace from "../components/finance/voucher-workspace";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 前缀是 api-client 拼的 /api/v1。 */
const EP = {
  receivables: "/api/v1/finance/receivable-sources",
  customerPayments: "/api/v1/finance/customer-payments",
  reconciliations: "/api/v1/finance/reconciliations",
  payableSources: "/api/v1/payable-sources",
  outsourceSources: "/api/v1/production/outsource-logistics-batches/payable-sources",
  payables: "/api/v1/finance/payable-entries",
  supplierPayments: "/api/v1/finance/supplier-payments",
  supplierReconciliations: "/api/v1/finance/supplier-payable-reconciliations",
  banks: "/api/v1/finance/banks",
  cashFlowEntries: "/api/v1/finance/cash-flow-entries",
  vouchers: "/api/v1/finance/vouchers",
  customers: "/api/v1/customers",
  suppliers: "/api/v1/suppliers",
  salesOrders: "/api/v1/sales-orders",
  currencies: "/api/v1/dictionaries/currency/items",
  cashFlowItems: "/api/v1/dictionaries/cash_flow_item/items",
} as const;

type Handler = (url: string, call: StubbedCall) => Response | undefined;

/**
 * 桩：每个已知列表路径各回自己那一份数据（默认空），extra 优先执行，用于注入详情 / 403 / 404。
 * 返回 fetch 调用记录，供 callsTo(...) 断言 method / url / body。
 */
function stubFinance(data: Partial<Record<keyof typeof EP, unknown>> = {}, extra?: Handler) {
  return stubApi((url, call) => {
    const injected = extra?.(url, call);
    if (injected) return injected;
    for (const [key, path] of Object.entries(EP) as Array<[keyof typeof EP, string]>) {
      if (url.endsWith(path)) return apiOk(data[key] ?? []);
    }
    return apiOk([]);
  });
}

/**
 * 复刻真实 API 的注册形状：草稿编辑只有 PATCH（finance.controller.ts 的 @Patch(".../:id")），
 * POST 到同一个 /:id 会 404。只匹配集合下的单条路径（/:id），不匹配 /:id/confirm、/:id/post 这类动作路径。
 */
const draftEditIsPatchOnly: Handler = (url, call) =>
  /\/finance\/(receivable-sources|customer-payments|supplier-payments|payable-entries)\/[^/]+$/.test(url) && call.method !== "PATCH"
    ? apiErr(404, "NOT_FOUND", `Cannot ${call.method} ${url}`)
    : undefined;

/** 渲染并等到数据加载完成（页面根出现）。 */
async function open(node: React.ReactElement, testId: string) {
  render(<>{node}<Toaster /></>);
  await screen.findByTestId(testId);
}

/** 取某个面板（section）的作用域，避免同名文本/按钮跨表歧义。 */
function panel(title: string) {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (!section) throw new Error(`找不到面板：${title}`);
  return within(section as HTMLElement);
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const setValue = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const submitDialog = () => fireEvent.click(screen.getByTestId("action-dialog-submit"));
/** Radix Select 必须真实点开再点选项，否则必填校验会拦住提交。 */
async function pickOption(testId: string, optionName: RegExp) {
  await userEvent.click(screen.getByTestId(testId));
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

// ------------------------------------------------------------------ 夹具

const source = (over: Record<string, unknown> = {}) => ({
  id: "rec-1", sourceNo: "AR-001", orderNo: "SO-1", customerId: "customer-1", outboundId: "ob-1",
  quantity: "10.0000", unit: "个", unitPrice: "12.0000", taxRate: null, amount: "120.0000", currency: "USD",
  amountReason: null, status: "draft", dueDate: null, invoiceNo: null, invoiceDate: null, signedAtSnapshot: null,
  remark: null, createdAt: "2026-09-02T03:00:00.000Z",
  customer_name: "香港迪礼", customer_code: "C001", outbound_no: "OUT-001", product_name: "折叠伞", product_specification: "黑胶",
  allocated_amount: "0.0000", outstanding_amount: "120.0000",
  allocations: [],
  ...over,
});
const confirmedSource = source({ id: "rec-2", sourceNo: "AR-002", orderNo: "SO-2", status: "confirmed", allocated_amount: "20.0000", outstanding_amount: "100.0000" });
const payment = (over: Record<string, unknown> = {}) => ({
  id: "cp-1", paymentNo: "RC-001", customerId: "customer-1", orderNo: "SO-1", paymentDate: "2026-09-05T00:00:00.000Z",
  amount: "50.0000", currency: "USD", paymentMethod: "银行转账", bankReference: null, payerName: null,
  status: "draft", remark: null, customer_name: "香港迪礼", customer_code: "C001", allocated_amount: "0.0000", allocations: [],
  ...over,
});
const receivableReconciliation = (over: Record<string, unknown> = {}) => ({
  id: "recon-1", reconciliationNo: "REC-001", orderNo: null, customerId: "customer-1",
  periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-09-30T00:00:00.000Z",
  receivableAmountSnapshot: "120.0000", paymentAmountSnapshot: "0.0000", adjustmentAmountSnapshot: "0.0000",
  systemBalance: "120.0000", externalBalance: "100.0000", difference: "20.0000", currency: "USD",
  status: "difference", resolutionRemark: null, remark: null, createdAt: "2026-09-30T00:00:00.000Z",
  customer: { id: "customer-1", name: "香港迪礼", customerCode: "C001" },
  // 流转摘要由列表接口给出（2026-09-16 起）：差异中的对账默认没有可确认的草稿
  flow: { entry_count: 1, draft_count: 1, draft_amount: "120.0000", can_confirm_receivables: false, order_nos: ["SO-1"], product_names: ["折叠伞"], product_specifications: ["黑胶"] },
  ...over,
});
const inboundSource = (over: Record<string, unknown> = {}) => ({
  id: "ps-1", orderNo: "SO-1", quantity: "10.0000", unitPrice: "5.0000", taxRate: null, amount: "50.0000", currency: "CNY",
  status: "pending_finance", createdAt: "2026-09-03T00:00:00.000Z", qcResult: "accepted", actualInboundQuantity: "10.0000",
  acceptedQuantity: "10.0000", conditionalQuantity: null, rejectedQuantity: "0.0000",
  settlementUnitPrice: null, settlementTotalAmount: null, settlementAmountReason: null,
  purchase_order_no: "PO-1", batch_sequence: 2, material_name: "涤纶布", material_code: "M001",
  material_specification: "150D", material_color: "本白", unit_name: "米",
  rawMaterialInbound: { inboundNo: "IN-001", status: "posted" }, purchaseReceipt: { receiptNo: "GR-001" },
  purchaseOrder: { purchaseOrderNo: "PO-1" }, supplier: { id: "supplier-1", name: "绍兴纺织", supplierCode: "S001" },
  ...over,
});
const outsourceSource = (over: Record<string, unknown> = {}) => ({
  id: "os-1", orderNo: "SO-1", quantity: "8.0000", unitPrice: "3.0000", taxRate: null, amount: "24.0000", currency: "CNY",
  status: "pending_finance", createdAt: "2026-09-04T00:00:00.000Z", material_name: "拉链", material_specification: "5#",
  material_color: null, unit_name: "条", purchaseOrder: { purchaseOrderNo: "PO-2" },
  logisticsBatch: { batchNo: "OB-001" }, outsourceReceipt: { id: "11112222-3333-4444-5555-666677778888" },
  supplier: { id: "supplier-2", name: "义乌配件", supplierCode: "S002" },
  ...over,
});
const payableEntry = (over: Record<string, unknown> = {}) => ({
  id: "pe-1", payableNo: "AP-001", orderNo: "SO-1", supplierId: "supplier-1", sourceType: "raw_material_inbound",
  sourceNoSnapshot: "IN-001", quantity: "10.0000", unitPrice: "5.0000", taxRate: null, amount: "50.0000", currency: "CNY",
  confirmationDate: "2026-09-03T00:00:00.000Z", status: "draft", remark: null, createdAt: "2026-09-03T00:00:00.000Z",
  source_no: "IN-001", purchase_order_no: "PO-1", batch_sequence: 2, material_name: "涤纶布", material_specification: "150D",
  material_color: "本白", unit_name: "米", supplier_name: "绍兴纺织", supplier_code: "S001",
  paid_amount: "0.0000", outstanding_amount: "50.0000", allocations: [],
  ...over,
});
const supplierPayment = (over: Record<string, unknown> = {}) => ({
  id: "sp-1", paymentNo: "PY-001", supplierId: "supplier-1", orderNo: "SO-1", paymentDate: "2026-09-06T00:00:00.000Z",
  amount: "30.0000", currency: "CNY", paymentMethod: "银行转账", bankReference: null, payeeName: null,
  status: "draft", remark: null, supplier_name: "绍兴纺织", supplier_code: "S001", allocated_amount: "0.0000", allocations: [],
  ...over,
});
const supplierReconciliation = (over: Record<string, unknown> = {}) => ({
  id: "srecon-1", reconciliationNo: "APREC-001", orderNo: null, supplierId: "supplier-1",
  periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-09-30T00:00:00.000Z",
  payableAmountSnapshot: "50.0000", paymentAmountSnapshot: "0.0000", adjustmentAmountSnapshot: "0.0000",
  systemBalance: "50.0000", externalBalance: "50.0000", difference: "0.0000", currency: "CNY",
  status: "matched", resolutionRemark: null, remark: null, createdAt: "2026-09-30T00:00:00.000Z",
  supplier: { id: "supplier-1", name: "绍兴纺织", supplierCode: "S001" },
  ...over,
});

// ------------------------------------------------------------------ 一级页

describe("财务一级页：板块入口", () => {
  it("展示 8 个入口，并分别指向二级页地址", async () => {
    stubFinance();
    render(<FinanceBoardIndex />);
    expect(screen.getByTestId("page-finance")).toBeInTheDocument();
    for (const [key, title] of [["receivable", "应收管理"], ["payable", "应付管理"], ["salary", "工资管理"], ["banks", "银行账户"], ["bank-transfers", "银行余额互转"], ["cash-flow", "收支管理"], ["reports", "财务报表"], ["voucher", "凭证管理"]] as const) {
      const card = screen.getByTestId(`finance-board-${key}`);
      expect(card).toHaveAttribute("href", `/finance/${key}`);
      expect(within(card).getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByTestId("finance-board-grid").querySelectorAll("a")).toHaveLength(8);
  });
});

// ------------------------------------------------------------------ 应收管理

describe("应收管理 · 成品出库条目", () => {
  it("展示客户/出库单/未收余额与待确认合计，并给出三个子栏目", async () => {
    stubFinance({ receivables: [source()] });
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    const table = panel("成品出库条目");
    expect(table.getByText("AR-001")).toBeInTheDocument();
    expect(table.getByText("香港迪礼")).toBeInTheDocument();
    expect(table.getByText("OUT-001")).toBeInTheDocument();
    // 应收金额与未收两列都是 120.0000 USD（该条草稿还没有任何收款）
    expect(table.getAllByText("120.0000 USD")).toHaveLength(2);
    expect(table.getByText("草稿")).toBeInTheDocument();
    expect(screen.getByText(/待确认应收 1 笔 \/ 合计 120\.00/)).toBeInTheDocument();
    // 三个子栏目都是真实链接（可收藏），地址带 tab 参数
    for (const [key, title] of [["outbound-entries", "成品出库条目"], ["reconciliations", "应收对账"], ["confirmed", "确认应收"]] as const) {
      const link = screen.getByTestId(`finance-tab-${key}`);
      expect(link).toHaveAttribute("href", `/finance/receivable?tab=${key}`);
      expect(within(link).getByText(title)).toBeInTheDocument();
    }
  });

  it("双击行弹出居中详情弹窗，按 :id 拉详情并展示全部字段与操作", async () => {
    const detail = source({ customer: { id: "customer-1", name: "香港迪礼", customerCode: "C001" }, amountReason: "无销售单价，按合同价" });
    const calls = stubFinance({ receivables: [source()] }, (url) => (url.endsWith("/api/v1/finance/receivable-sources/rec-1") ? apiOk(detail) : undefined));
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");

    fireEvent.doubleClick(screen.getAllByTestId("data-table-row")[0]);

    const dialog = await screen.findByTestId("finance-record-detail");
    await waitFor(() => expect(within(dialog).getByText("香港迪礼")).toBeInTheDocument());
    expect(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1")).toHaveLength(1);
    for (const label of ["应收来源编号", "客户", "出库单号", "产品", "数量", "单价", "应收金额", "已收金额", "未收金额", "金额原因", "到期日期", "创建时间"]) {
      expect(within(dialog).getByText(label)).toBeInTheDocument();
    }
    expect(within(dialog).getByText("无销售单价，按合同价")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认应收" })).toBeInTheDocument();
  });

  it("逐条确认应收改走弹窗（确认即记账，先问清入账银行/收支项目），提交后 POST /:id/confirm", async () => {
    const calls = stubFinance({ receivables: [source()] });
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "确认应收" }));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应收：AR-001")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-bank_id")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-cash_flow_item_id")).toBeInTheDocument();
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")).toHaveLength(1));
    const call = callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")[0];
    expect(call.method).toBe("POST");
    // 银行留空 → 显式送 null：后端按「未指定账户」记账并回 bank_missing（上面会警告）
    expect(bodyOf(call)).toEqual({ bank_id: null });
  });

  it("编辑应收草稿走 PATCH /:id 并带上用户改后的金额", async () => {
    const calls = stubFinance({ receivables: [source()] }, draftEditIsPatchOnly);
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "编辑" }));
    setValue("action-field-amount", "150.5");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1")).toHaveLength(1));
    const call = callsTo(calls, "/api/v1/finance/receivable-sources/rec-1")[0];
    expect(call.method).toBe("PATCH");
    expect(bodyOf(call).amount).toBe("150.5");
  });

  it("取消应收必须填原因，走 POST /:id/cancel", async () => {
    const calls = stubFinance({ receivables: [source()] });
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "取消" }));
    submitDialog();
    expect(screen.getByTestId("action-dialog-error")).toHaveTextContent("请填写取消原因");
    setValue("action-field-reason", "客户取消订单");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/cancel")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/cancel")[0]).reason).toBe("客户取消订单");
  });
});

describe("应收管理 · 应收对账", () => {
  it("列出手动对账单（含客户与差异），并支持处理差异 / 一键确认应收", async () => {
    const calls = stubFinance({
      receivables: [source()],
      reconciliations: [
        receivableReconciliation(),
        // flow 是**列表**接口给的流转摘要：只有范围内确实还有草稿时才给「一键确认应收」
        receivableReconciliation({ id: "recon-2", reconciliationNo: "REC-002", status: "matched", difference: "0.0000", flow: { entry_count: 2, draft_count: 2, draft_amount: "240.0000", can_confirm_receivables: true, order_nos: ["SO-1", "SO-2"], product_names: ["折叠伞"], product_specifications: ["黑胶"] } }),
      ],
    });
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    const table = panel("应收对账单");
    expect(table.getByText("REC-001")).toBeInTheDocument();
    expect(table.getByText("有差异")).toBeInTheDocument();
    expect(table.getByText("已对平")).toBeInTheDocument();
    // 新列来自 flow 摘要：订单号 / 产品 / 规格型号 / 待确认条数
    const matchedRow = within(screen.getByTestId("reconciliation-confirm-recon-2").closest("tr") as HTMLElement);
    expect(matchedRow.getByText("SO-1、SO-2")).toBeInTheDocument();
    expect(matchedRow.getByText("折叠伞")).toBeInTheDocument();
    expect(matchedRow.getByText("黑胶")).toBeInTheDocument();
    expect(matchedRow.getByText("2 条 / 240.0000")).toBeInTheDocument();

    fireEvent.click(table.getByRole("button", { name: "处理差异" }));
    setValue("action-field-remark", "客户确认差异为折让");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/reconciliations/recon-1/resolve")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/reconciliations/recon-1/resolve")[0]).resolution_remark).toBe("客户确认差异为折让");

    // 一键确认应收现在先弹「确认应收：<对账单号>」：确认会**同时把钱记进账**，
    // 必须先问清入账银行与收支项目（不再是点一下就直接 POST）。
    fireEvent.click(screen.getByTestId("reconciliation-confirm-recon-2"));
    const confirmDialog = await screen.findByTestId("action-dialog");
    expect(within(confirmDialog).getByText("确认应收：REC-002")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-bank_id")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-cash_flow_item_id")).toBeInTheDocument();
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/reconciliations/recon-2/confirm-receivables")).toHaveLength(1));
    expect(callsTo(calls, "/api/v1/finance/reconciliations/recon-2/confirm-receivables")[0].method).toBe("POST");
  });

  it("对平但范围内没有草稿时不给「一键确认应收」，改为说明文字（按钮点了只会空转 0 条）", async () => {
    stubFinance({ reconciliations: [receivableReconciliation({ status: "matched", difference: "0.0000", flow: { entry_count: 0, draft_count: 0, draft_amount: "0.0000", can_confirm_receivables: false, order_nos: [], product_names: [], product_specifications: [] } })] });
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    const actions = within(screen.getByTestId("reconciliation-actions-recon-1"));
    expect(actions.queryByRole("button", { name: /一键确认应收/ })).toBeNull();
    expect(actions.getByText("范围内没有待确认应收")).toBeVisible();
  });

  it("待创建对账逐条列出未覆盖的草稿（含产品与规格型号），并按该条的客户+月份带入表单", async () => {
    const calls = stubFinance({ receivables: [source()], customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }] });
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    const pending = within(screen.getByTestId("receivable-pending-entries"));
    // 逐条：一眼看到「这条条目」在不在
    expect(pending.getByText("AR-001")).toBeInTheDocument();
    expect(pending.getByText("香港迪礼")).toBeInTheDocument();
    expect(pending.getByText("2026-09")).toBeInTheDocument();
    expect(pending.getByText("OUT-001")).toBeInTheDocument();
    expect(pending.getByText("折叠伞")).toBeInTheDocument();
    expect(pending.getByText("黑胶")).toBeInTheDocument();
    expect(screen.getByTestId("receivable-pending-summary")).toHaveTextContent("1 条 / 合计 120.00");

    fireEvent.click(pending.getByRole("button", { name: "创建对账" }));
    // 客户与期间由该条自动带入，只需要填外部余额
    expect((screen.getByTestId("action-field-period_start") as HTMLInputElement).value).toBe("2026-09-01");
    expect((screen.getByTestId("action-field-period_end") as HTMLInputElement).value).toBe("2026-09-30");
    setValue("action-field-external_balance", "100");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/reconciliations").filter((call) => call.method === "POST")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/api/v1/finance/reconciliations").filter((call) => call.method === "POST")[0]);
    expect(body).toMatchObject({ customer_id: "customer-1", period_start: "2026-09-01", period_end: "2026-09-30", external_balance: "100" });
  });

  it("已纳入对账单的草稿从待创建对账移出，并在说明里点名去向", async () => {
    const covered = source({ id: "rec-9", sourceNo: "AR-009", reconciliation: { id: "recon-1", reconciliation_no: "REC-001", status: "matched", period_start: "2026-09-01T00:00:00.000Z", period_end: "2026-09-30T00:00:00.000Z" } });
    stubFinance({ receivables: [source(), covered] });
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    const pending = within(screen.getByTestId("receivable-pending-entries"));
    expect(pending.getByText("AR-001")).toBeInTheDocument();
    expect(pending.queryByText("AR-009")).toBeNull();
    expect(screen.getByTestId("receivable-covered-drafts")).toHaveTextContent("另有 1 条出库条目已纳入对账单、不在此重复对账：AR-009（REC-001）");
  });

  it("双击已创建对账单，弹窗里展示这批货的产品与规格型号", async () => {
    const detail = receivableReconciliation({
      flow: { entry_count: 1, draft_count: 1, draft_amount: "120.0000", can_confirm_receivables: true, order_nos: ["SO-1"], product_names: ["折叠伞"], product_specifications: ["黑胶"] },
      details: { entries: [source()], draft_entries: [source()], entry_count: 1, draft_count: 1, draft_amount: "120.0000", can_confirm_receivables: true },
    });
    const calls = stubFinance({ reconciliations: [receivableReconciliation()] }, (url) => (url.endsWith("/api/v1/finance/reconciliations/recon-1") ? apiOk(detail) : undefined));
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.doubleClick(screen.getAllByTestId("data-table-row")[0]);
    const dialog = await screen.findByTestId("finance-record-detail");
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/reconciliations/recon-1")).toHaveLength(1));
    // 字段区与「纳入对账的应收条目」明细表都有这两列/字段，按「至少出现一次」断言
    expect(within(dialog).getAllByText("产品").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("折叠伞").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("规格型号").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("黑胶").length).toBeGreaterThan(0);
  });
});

describe("应收管理 · 确认应收与收款", () => {
  it("确认应收是台账视图（草稿可确认、已确认可收款），并可登记收款 / 核销过账 / 冲销", async () => {
    const calls = stubFinance({
      receivables: [source(), confirmedSource],
      customerPayments: [payment(), payment({ id: "cp-2", paymentNo: "RC-002", status: "posted", amount: "88.0000" })],
      customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }],
    });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    const confirmed = panel("确认应收");
    expect(confirmed.getByText("AR-001")).toBeInTheDocument();
    expect(confirmed.getByRole("button", { name: "确认应收" })).toBeInTheDocument();
    expect(confirmed.getByText("AR-002")).toBeInTheDocument();
    expect(confirmed.getByText("已确认")).toBeInTheDocument();

    // 登记收款：从已确认应收行内发起，客户/订单/金额都应该预填
    fireEvent.click(confirmed.getByRole("button", { name: "登记收款" }));
    expect((screen.getByTestId("action-field-amount") as HTMLInputElement).value).toBe("100.0000");
    setValue("action-field-amount", "100");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/customer-payments").filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/customer-payments").filter((call) => call.method === "POST")[0])).toMatchObject({ customer_id: "customer-1", order_no: "SO-2", amount: "100" });
    // 建单必须带幂等键：否则网络重试/双击会重复落草稿收款单（2026-09-15 一个订单出现过 4 张相同的草稿）。
    const createBody = bodyOf(callsTo(calls, "/api/v1/finance/customer-payments").filter((call) => call.method === "POST")[0]) as Record<string, unknown>;
    expect(String(createBody.idempotency_key)).toMatch(/^web-receipt-\d+-[a-z0-9]+$/);

    // 草稿收款：编辑走 PATCH，过账核销走 POST 且带 allocations
    const payments = panel("收款");
    fireEvent.click(payments.getByRole("button", { name: "编辑" }));
    setValue("action-field-amount", "55");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/customer-payments/cp-1")).toHaveLength(1));
    expect(callsTo(calls, "/api/v1/finance/customer-payments/cp-1")[0].method).toBe("PATCH");

    fireEvent.click(panel("收款").getByRole("button", { name: "过账/核销" }));
    await pickOption("action-field-source_id", /AR-002/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/customer-payments/cp-1/post")).toHaveLength(1));
    const post = bodyOf(callsTo(calls, "/api/v1/finance/customer-payments/cp-1/post")[0]) as { allocations: Array<{ receivable_source_id: string; amount: string }> };
    expect(post.allocations[0].receivable_source_id).toBe("rec-2");

    fireEvent.click(panel("收款").getByRole("button", { name: "冲销" }));
    setValue("action-field-reason", "银行退回");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/customer-payments/cp-2/reverse")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/customer-payments/cp-2/reverse")[0]).reason).toBe("银行退回");
  });

  it("收款核销的「应收来源」只列同客户 + 同币种（不再摆出必然 422 的选项）", async () => {
    // 历史缺陷：下拉给的是**全库**还能收的来源，于是 DL260122 / CNY 的收款单里会列出
    // DL260123 / USD 的应收来源，选中必然被服务端 422（客户或币种不一致）。
    stubFinance({
      receivables: [
        confirmedSource,                                                                                  // 同客户 + 同币种 → 保留
        source({ id: "rec-3", sourceNo: "AR-003", orderNo: "SO-3", customerId: "customer-9", status: "confirmed", outstanding_amount: "500.0000" }), // 别的客户
        source({ id: "rec-4", sourceNo: "AR-004", orderNo: "SO-4", status: "confirmed", currency: "CNY", outstanding_amount: "700.0000" }),         // 别的币种
        source({ id: "rec-5", sourceNo: "AR-005", orderNo: "SO-5", status: "confirmed", outstanding_amount: "0.0000" }),                            // 已收完
      ],
      customerPayments: [payment()],
      customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }],
    });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    fireEvent.click(panel("收款").getByRole("button", { name: "过账/核销" }));
    await userEvent.click(screen.getByTestId("action-field-source_id"));
    const labels = (await screen.findAllByRole("option")).map((option) => option.textContent ?? "");
    expect(labels.some((text) => text.includes("AR-002"))).toBe(true);
    expect(labels.some((text) => text.includes("AR-003"))).toBe(false); // 别的客户：服务端必拒
    expect(labels.some((text) => text.includes("AR-004"))).toBe(false); // 别的币种：服务端必拒
    expect(labels.some((text) => text.includes("AR-005"))).toBe(false); // 已收完，没有可核销余额
  });

  it("收款过账可以人工指定收支项目（「差旅费」这类归不进默认候选的项目）", async () => {
    const calls = stubFinance({
      receivables: [confirmedSource],
      customerPayments: [payment()],
      customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }],
      cashFlowItems: [{ id: "item-travel", key: "差旅费", label: "差旅费", isActive: true }],
    });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    fireEvent.click(panel("收款").getByRole("button", { name: "过账/核销" }));
    await pickOption("action-field-source_id", /AR-002/);
    await pickOption("action-field-cash_flow_item_id", /差旅费/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/customer-payments/cp-1/post")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/customer-payments/cp-1/post")[0])).toMatchObject({ cash_flow_item_id: "item-travel" });
  });

  // 2026-09-16（用户要求「应收侧对应的问题也都改」）：确认应收的收款部分同样要能折叠收纳。
  it("收款面板可折叠收纳：收起后连表格一起隐藏，展开恢复，并把选择记在本机", async () => {
    window.localStorage.removeItem("dilee:panel:receivable-payments");
    stubFinance({ receivables: [confirmedSource], customerPayments: [payment()] });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    const toggle = screen.getByTestId("receivable-payments-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("收起");
    expect(panel("收款").getByText("RC-001")).toBeVisible();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("展开");
    expect(panel("收款").queryByText("RC-001")).toBeNull();
    // 收起只影响收款面板，应收台账还在
    expect(panel("确认应收").getByText("AR-002")).toBeVisible();
    expect(window.localStorage.getItem("dilee:panel:receivable-payments")).toBe("collapsed");

    // 展开回去，避免影响同文件里的其他用例（jsdom 的 localStorage 是共享的）
    await userEvent.click(screen.getByTestId("receivable-payments-toggle"));
    expect(panel("收款").getByText("RC-001")).toBeVisible();
    expect(window.localStorage.getItem("dilee:panel:receivable-payments")).toBe("expanded");
  });
});

// ------------------------------------------------------------------ 应付管理

describe("应付管理 · 来源条目", () => {
  it("原料入库条目只取原料入库来源，采购到货来源不混进来", async () => {
    stubFinance({
      payableSources: [inboundSource(), inboundSource({ id: "ps-legacy", rawMaterialInbound: null, purchaseReceipt: { receiptNo: "GR-LEGACY" } })],
    });
    await open(<PayableWorkspace tab="raw-inbound-entries" testId="page-finance-payable" />, "page-finance-payable");
    const table = panel("原料入库条目");
    expect(table.getByText("IN-001")).toBeInTheDocument();
    expect(table.getByText("绍兴纺织")).toBeInTheDocument();
    expect(table.getByText("涤纶布（150D / 本白）")).toBeInTheDocument();
    expect(table.getByText("第 2 批")).toBeInTheDocument();
    expect(table.queryByText("GR-LEGACY")).not.toBeInTheDocument();
  });

  it("接收应付走 POST /finance/payable-entries/from-source 且 source_type 正确", async () => {
    const calls = stubFinance({ payableSources: [inboundSource()] });
    await open(<PayableWorkspace tab="raw-inbound-entries" testId="page-finance-payable" />, "page-finance-payable");
    fireEvent.click(panel("原料入库条目").getByRole("button", { name: "接收应付" }));
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/payable-entries/from-source")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/payable-entries/from-source")[0])).toMatchObject({ source_type: "raw_material_inbound", source_id: "ps-1" });
  });

  it("外加工签收单独成栏，接收时 source_type 是 outsource_receipt", async () => {
    const calls = stubFinance({ outsourceSources: [outsourceSource()] });
    await open(<PayableWorkspace tab="outsource-entries" testId="page-finance-payable" />, "page-finance-payable");
    const table = panel("外加工签收");
    expect(table.getByText("OB-001")).toBeInTheDocument();
    fireEvent.click(table.getByRole("button", { name: "接收应付" }));
    setValue("action-field-amount", "24");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/payable-entries/from-source")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/payable-entries/from-source")[0])).toMatchObject({ source_type: "outsource_receipt", source_id: "os-1" });
  });

  it("双击应付来源行弹出详情弹窗（来源没有 :id 接口，用行数据）", async () => {
    const calls = stubFinance({ payableSources: [inboundSource()] });
    await open(<PayableWorkspace tab="raw-inbound-entries" testId="page-finance-payable" />, "page-finance-payable");
    fireEvent.doubleClick(screen.getAllByTestId("data-table-row")[0]);
    const dialog = await screen.findByTestId("finance-record-detail");
    expect(within(dialog).getByText("质检结论")).toBeInTheDocument();
    expect(within(dialog).getByText("accepted")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "接收应付" })).toBeInTheDocument();
    // 不应为来源详情发起 :id 请求（后端没有这个端点）
    expect(calls.filter((call) => call.url.endsWith("/api/v1/payable-sources/ps-1"))).toHaveLength(0);
  });
});

describe("应付管理 · 应付对账与确认应付", () => {
  it("应付对账单支持处理差异，并对平后给出「确认 N 条应付」入口", async () => {
    const calls = stubFinance({
      payables: [payableEntry()],
      // flow 是**列表**接口给的流转摘要（2026-09-15 起）：列表行上要能直接确认，不能只靠详情里的 details。
      supplierReconciliations: [supplierReconciliation({ flow: { entry_count: 1, draft_count: 1, draft_amount: "50", can_confirm_payables: true, order_nos: ["SO-1"], purchase_order_nos: ["PO-1"], material_names: ["涤纶布"] } }), supplierReconciliation({ id: "srecon-2", reconciliationNo: "APREC-002", status: "difference", difference: "5.0000" })],
    });
    await open(<PayableWorkspace tab="reconciliations" testId="page-finance-payable" />, "page-finance-payable");
    const table = panel("已创建对账单");
    expect(table.getByText("APREC-002")).toBeInTheDocument();
    // 对账行上的新列（订单号 / 采购物料 / 待确认条数）都来自列表接口的 flow 摘要。
    // 用行作用域断言：同一个 section 里还有「待创建对账」表，未收窄会命中重复文本。
    const matchedRow = within(screen.getByTestId("reconciliation-confirm-srecon-1").closest("tr") as HTMLElement);
    expect(matchedRow.getByText("SO-1")).toBeInTheDocument();
    expect(matchedRow.getByText("涤纶布")).toBeInTheDocument();
    expect(matchedRow.getByText("1 条 / 50")).toBeInTheDocument();
    fireEvent.click(table.getByRole("button", { name: "处理差异" }));
    setValue("action-field-remark", "供应商确认差异为运费");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/supplier-payable-reconciliations/srecon-2/resolve")).toHaveLength(1));

    await userEvent.click(screen.getByTestId("reconciliation-confirm-srecon-1"));
    // 确认应付现在也走「确认应付：<对账单号>」弹窗（确认会同时写一笔支出流水），提交后才发请求。
    const confirmDialog = await screen.findByTestId("action-dialog");
    expect(within(confirmDialog).getByText("确认应付：APREC-001")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-bank_id")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-cash_flow_item_id")).toBeInTheDocument();
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/supplier-payable-reconciliations/srecon-1/confirm-payables")).toHaveLength(1));
  });

  it("待创建对账逐条列出未覆盖的草稿，并可按该条的供应商+月份一键带入表单", async () => {
    const calls = stubFinance({ payables: [payableEntry()], suppliers: [{ id: "supplier-1", name: "绍兴纺织", supplierCode: "S001" }] });
    await open(<PayableWorkspace tab="reconciliations" testId="page-finance-payable" />, "page-finance-payable");
    const pending = panel("待创建对账");
    // 逐条：应付单号 / 供应商 / 月份 / 订单号 / 采购单号 / 物料 / 规格型号
    expect(pending.getByText("AP-001")).toBeInTheDocument();
    expect(pending.getByText("绍兴纺织")).toBeInTheDocument();
    expect(pending.getByText("2026-09")).toBeInTheDocument();
    expect(pending.getByText("PO-1")).toBeInTheDocument();
    expect(pending.getByText("涤纶布")).toBeInTheDocument();
    expect(pending.getByText("150D")).toBeInTheDocument();
    expect(screen.getByTestId("payable-pending-summary")).toHaveTextContent("1 条 / 合计 50.00");

    fireEvent.click(pending.getByRole("button", { name: "创建对账" }));
    expect((screen.getByTestId("action-field-period_start") as HTMLInputElement).value).toBe("2026-09-01");
    setValue("action-field-external_balance", "50");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/supplier-payable-reconciliations").filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/supplier-payable-reconciliations").filter((call) => call.method === "POST")[0])).toMatchObject({ supplier_id: "supplier-1", period_start: "2026-09-01", external_balance: "50" });
  });

  it("已纳入对账单的草稿从待创建对账移出，并在说明里点名去向（不能无声消失）", async () => {
    const covered = payableEntry({ id: "pe-9", payableNo: "AP-009", reconciliation: { id: "srecon-1", reconciliation_no: "APREC-001", status: "matched", period_start: "2026-09-01T00:00:00.000Z", period_end: "2026-09-30T00:00:00.000Z" } });
    stubFinance({ payables: [payableEntry(), covered], supplierReconciliations: [supplierReconciliation()] });
    await open(<PayableWorkspace tab="reconciliations" testId="page-finance-payable" />, "page-finance-payable");
    const pending = panel("待创建对账");
    expect(pending.getByText("AP-001")).toBeInTheDocument();
    expect(pending.queryByText("AP-009")).toBeNull();
    expect(pending.getByTestId("payable-covered-drafts")).toHaveTextContent("另有 1 条草稿已纳入对账单、不在此重复对账：AP-009（APREC-001）");
  });

  it("确认应付是台账视图：草稿可确认/编辑，已确认可回退", async () => {
    const calls = stubFinance({
      payables: [payableEntry(), payableEntry({ id: "pe-2", payableNo: "AP-002", status: "confirmed", outstanding_amount: "50.0000" })],
    });
    await open(<PayableWorkspace tab="confirmed" testId="page-finance-payable" />, "page-finance-payable");
    const table = panel("确认应付");
    expect(table.getByText("AP-001")).toBeInTheDocument();
    expect(table.getByText("AP-002")).toBeInTheDocument();
    expect(table.getByRole("button", { name: "确认应付" })).toBeInTheDocument();

    fireEvent.click(table.getByRole("button", { name: "回退" }));
    setValue("action-field-reason", "金额有误");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/payable-entries/pe-2/reopen")).toHaveLength(1));

    // 确认即记账：台账行内不再有「登记付款」这第二步（再登记一次就是把同一笔钱扣两次）
    expect(panel("确认应付").queryByRole("button", { name: "登记付款" })).toBeNull();
  });

  it("勾选批量确认：勾选多条草稿 → 一次 POST batch-confirm（不再需要登记付款）", async () => {
    const calls = stubFinance(
      { payables: [payableEntry(), payableEntry({ id: "pe-2", payableNo: "AP-002", amount: "80.0000" })] },
      (url, call) => (call.method === "POST" && url.endsWith("/finance/payable-entries/batch-confirm")
        ? apiOk({ confirmed_count: 2, skipped_count: 0, amounts: [{ currency: "CNY", amount: "130.0000" }], bank_missing: false })
        : undefined),
    );
    await open(<PayableWorkspace tab="confirmed" testId="page-finance-payable" />, "page-finance-payable");
    fireEvent.click(screen.getByTestId("payable-select-all"));
    expect(screen.getByTestId("payable-selected-count")).toHaveTextContent("已选 2 条");
    fireEvent.click(screen.getByTestId("payable-batch-confirm"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认 2 条草稿应付（合计 130.0000 CNY）")).toBeInTheDocument();
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/payable-entries/batch-confirm")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/payable-entries/batch-confirm")[0])).toEqual({ ids: ["pe-1", "pe-2"], bank_id: null });
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已确认 2 条应付（130.0000 CNY）"))).toBe(true));
  });

  it("应付草稿编辑走 PATCH（用 POST 会 404），逐条确认走 POST", async () => {
    const calls = stubFinance({ payables: [payableEntry()] }, draftEditIsPatchOnly);
    await open(<PayableWorkspace tab="confirmed" testId="page-finance-payable" />, "page-finance-payable");
    const table = panel("确认应付");
    fireEvent.click(table.getByRole("button", { name: "编辑" }));
    setValue("action-field-amount", "48");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/payable-entries/pe-1")).toHaveLength(1));
    const patch = callsTo(calls, "/api/v1/finance/payable-entries/pe-1")[0];
    expect(patch.method).toBe("PATCH");
    expect(bodyOf(patch).amount).toBe("48");

    fireEvent.click(panel("确认应付").getByRole("button", { name: "确认应付" }));
    // 逐条确认应付同样改成弹窗（确认即记账，要先问清支付银行与收支项目）
    const confirmDialog = await screen.findByTestId("action-dialog");
    expect(within(confirmDialog).getByText("确认应付：AP-001")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-bank_id")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-cash_flow_item_id")).toBeInTheDocument();
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/payable-entries/pe-1/confirm")).toHaveLength(1));
    expect(callsTo(calls, "/api/v1/finance/payable-entries/pe-1/confirm")[0].method).toBe("POST");
  });
});

// ------------------------------------------------------------------ 币种与银行（银行账户池）

/**
 * 2026-09-15 用户要求：
 *   1) 「所有应收管理，都要选择银行，从银行池里选择」；
 *   2) 「排查所有的应收管理、应付管理，都要支持选择币种，编辑币种」。
 * 这里断言的是**前端真的把选择发出去**：银行下拉的选项只来自 `GET /finance/banks`（停用的不出现），
 * 且编辑草稿时币种/银行都随 PATCH 一起提交。
 */
const bank = (over: Record<string, unknown> = {}) => ({
  id: "bank-1", bankCode: "B001", bankName: "农业银行", accountName: "迪礼公司", accountNumber: "5706",
  currency: "CNY", isActive: true, swiftCode: null, remark: null,
  ...over,
});
const bankLink = { id: "bank-1", bankName: "农业银行", accountNumber: "5706" };

describe("应收管理 · 银行账户池与币种", () => {
  it("收款表格展示到账银行，登记收款只能从银行池（启用）里选", async () => {
    const calls = stubFinance({
      receivables: [confirmedSource],
      customerPayments: [payment({ bank: bankLink })],
      customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }],
      banks: [bank(), bank({ id: "bank-dead", bankCode: "B002", bankName: "中国银行", accountNumber: "7624", isActive: false })],
    });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");
    expect(panel("收款").getByText("农业银行（5706）")).toBeInTheDocument();

    fireEvent.click(panel("确认应收").getByRole("button", { name: "登记收款" }));
    await userEvent.click(screen.getByTestId("action-field-bank_id"));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent).join("|")).toContain("农业银行");
    expect(options.map((option) => option.textContent).join("|")).not.toContain("中国银行");
    await userEvent.click(options.find((option) => option.textContent?.includes("农业银行"))!);
    setValue("action-field-amount", "100");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, EP.customerPayments).filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, EP.customerPayments).filter((call) => call.method === "POST")[0])).toMatchObject({ bank_id: "bank-1" });
  });

  it("编辑收款草稿可改币种与银行，也能把银行清空（送 null）", async () => {
    const calls = stubFinance({
      customerPayments: [payment({ bank: bankLink })],
      banks: [bank()],
    });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    fireEvent.click(panel("收款").getByRole("button", { name: "编辑" }));
    await pickOption("action-field-currency", /USD/);
    await pickOption("action-field-bank_id", /农业银行/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, `${EP.customerPayments}/cp-1`)).toHaveLength(1));
    const patch = callsTo(calls, `${EP.customerPayments}/cp-1`)[0];
    expect(patch.method).toBe("PATCH");
    expect(bodyOf(patch)).toMatchObject({ currency: "USD", bank_id: "bank-1" });

    // 选错了要能去掉：清空走哨兵值 → 提交 null（后端按「清空」处理）。
    fireEvent.click(panel("收款").getByRole("button", { name: "编辑" }));
    await pickOption("action-field-bank_id", /不指定银行/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, `${EP.customerPayments}/cp-1`)).toHaveLength(2));
    expect(bodyOf(callsTo(calls, `${EP.customerPayments}/cp-1`)[1]).bank_id).toBeNull();
  });

  it("应收对账展示回款银行，创建对账时可从银行池选银行", async () => {
    const calls = stubFinance({
      receivables: [source()],
      reconciliations: [receivableReconciliation({ bank: bankLink })],
      customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }],
      banks: [bank()],
    });
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    expect(panel("应收对账单").getByText("农业银行（5706）")).toBeInTheDocument();

    fireEvent.click(panel("待创建对账的条目").getByRole("button", { name: "创建对账" }));
    setValue("action-field-external_balance", "100");
    await pickOption("action-field-bank_id", /农业银行/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, EP.reconciliations).filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, EP.reconciliations).filter((call) => call.method === "POST")[0])).toMatchObject({ bank_id: "bank-1" });
  });

  it("应收来源草稿可编辑币种（随 PATCH 提交）", async () => {
    const calls = stubFinance({ receivables: [source()] });
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "编辑" }));
    await pickOption("action-field-currency", /USD/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, `${EP.receivables}/rec-1`)).toHaveLength(1));
    const patch = callsTo(calls, `${EP.receivables}/rec-1`)[0];
    expect(patch.method).toBe("PATCH");
    expect(bodyOf(patch)).toMatchObject({ currency: "USD" });
  });
});

/**
 * 2026-09（应收侧新增能力）：收支项目建单即持久化 + 确认应收要真的记账。
 *
 * 两件事都有「看着成功、其实钱没归位」的风险，所以这里钉住**请求体**：
 *   1) 建单（对账 / 收款）时选的收支项目必须随 POST 发出去，否则单据上永远只有后端猜的那个；
 *   2) 确认应收不再是无 body 直接打：必须先问清入账银行与收支项目，且后端回 `bank_missing`
 *      时要给「钱记进流水了、但没进任何账户」的警告，而不是一句成功。
 */
describe("应收管理 · 收支项目与确认应收入账", () => {
  const travelItem = { id: "item-travel", key: "差旅费", label: "差旅费", isActive: true };
  const matchedRecon = () => receivableReconciliation({
    id: "recon-2", reconciliationNo: "REC-002", status: "matched", difference: "0.0000",
    flow: { entry_count: 2, draft_count: 2, draft_amount: "240.0000", can_confirm_receivables: true, order_nos: ["SO-1"], product_names: ["折叠伞"], product_specifications: ["黑胶"] },
  });
  const confirmPath = "/api/v1/finance/reconciliations/recon-2/confirm-receivables";

  it("创建对账把选中的收支项目随 POST 发出去", async () => {
    const calls = stubFinance({
      receivables: [source()],
      customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }],
      cashFlowItems: [travelItem],
    });
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("待创建对账的条目").getByRole("button", { name: "创建对账" }));
    setValue("action-field-external_balance", "100");
    await pickOption("action-field-cash_flow_item_id", /差旅费/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, EP.reconciliations).filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, EP.reconciliations).filter((call) => call.method === "POST")[0])).toMatchObject({ cash_flow_item_id: "item-travel" });
  });

  it("登记收款把选中的收支项目随建单 POST 发出去", async () => {
    const calls = stubFinance({
      receivables: [confirmedSource],
      customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }],
      cashFlowItems: [travelItem],
    });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("确认应收").getByRole("button", { name: "登记收款" }));
    await pickOption("action-field-cash_flow_item_id", /差旅费/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, EP.customerPayments).filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, EP.customerPayments).filter((call) => call.method === "POST")[0])).toMatchObject({ cash_flow_item_id: "item-travel" });
  });

  it("编辑收款草稿：默认带出单据上的收支项目（不会清掉），选「不指定收支项目」才送 null", async () => {
    const calls = stubFinance({ customerPayments: [payment({ cashFlowItemId: "item-travel" })], cashFlowItems: [travelItem] });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    // 只改金额、不动收支项目：PATCH 里仍是单据上原来的项目，既不是 null 也没被抹掉。
    fireEvent.click(panel("收款").getByRole("button", { name: "编辑" }));
    setValue("action-field-amount", "55");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, `${EP.customerPayments}/cp-1`)).toHaveLength(1));
    expect(bodyOf(callsTo(calls, `${EP.customerPayments}/cp-1`)[0]).cash_flow_item_id).toBe("item-travel");

    // 明确清空：哨兵值翻译成 null，后端才按「清空」处理。
    fireEvent.click(panel("收款").getByRole("button", { name: "编辑" }));
    await pickOption("action-field-cash_flow_item_id", /不指定收支项目/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, `${EP.customerPayments}/cp-1`)).toHaveLength(2));
    expect(bodyOf(callsTo(calls, `${EP.customerPayments}/cp-1`)[1]).cash_flow_item_id).toBeNull();
  });

  /**
   * 逐条确认应收 / 按订单批量确认应收：与「一键确认应收」同一件事的两条**行级**入口，
   * 用户要求「一旦确认应收，金额就要进入对应的账户」——所以都要收集入账银行 + 收支项目，
   * 并且都要在 `bank_missing` 时给出警告。
   */
  it("逐条确认应收：行内按钮打开弹窗，提交 { bank_id, cash_flow_item_id }", async () => {
    const calls = stubFinance(
      { receivables: [source()], banks: [bank()], cashFlowItems: [travelItem] },
      (url) => (url.endsWith("/api/v1/finance/receivable-sources/rec-1/confirm") ? apiOk({ ...source(), amount: "120.0000", currency: "USD", cash_flow_entry_id: "cf-1", bank_missing: false }) : undefined),
    );
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "确认应收" }));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应收 AR-001：120.0000 USD")).toBeInTheDocument();
    await pickOption("action-field-bank_id", /农业银行/);
    await pickOption("action-field-cash_flow_item_id", /差旅费/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")[0])).toEqual({ bank_id: "bank-1", cash_flow_item_id: "item-travel" });
  });

  it("逐条确认应收没指定银行时同样给出警告，而不是一句成功", async () => {
    const calls = stubFinance(
      { receivables: [source()] },
      (url) => (url.endsWith("/api/v1/finance/receivable-sources/rec-1/confirm") ? apiOk({ ...source(), amount: "120.0000", currency: "USD", cash_flow_entry_id: "cf-1", bank_missing: true }) : undefined),
    );
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "确认应收" }));
    await screen.findByTestId("action-dialog");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("未指定入账银行"))).toBe(true));
    const warning = screen.getAllByTestId("toast-item").find((item) => item.textContent?.includes("未指定入账银行")) as HTMLElement;
    expect(warning).toHaveClass("ui-toast-error");
    expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("金额已记入所选银行账户"))).toBe(false);
  });

  it("按订单批量确认应收同样问清入账银行与收支项目（服务端每条应收各写一条流水）", async () => {
    const calls = stubFinance(
      { receivables: [source()], banks: [bank()], cashFlowItems: [travelItem] },
      (url) => (url.endsWith("/api/v1/finance/receivable-sources/batch-confirm-by-order") ? apiOk({ orderNo: "SO-1", count: 1, ids: ["rec-1"], cash_flow_entry_ids: ["cf-1"], bank_missing: false }) : undefined),
    );
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("按订单批量确认").getByRole("button", { name: /批量确认/ }));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("批量确认应收：SO-1")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-bank_id")).toBeInTheDocument();
    await pickOption("action-field-bank_id", /农业银行/);
    await pickOption("action-field-cash_flow_item_id", /差旅费/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/batch-confirm-by-order")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/receivable-sources/batch-confirm-by-order")[0])).toEqual({ order_no: "SO-1", bank_id: "bank-1", cash_flow_item_id: "item-travel" });
  });

  it("确认应收先弹窗问清入账银行与收支项目，提交后按选定值记账", async () => {
    const calls = stubFinance(
      { reconciliations: [matchedRecon()], banks: [bank()], cashFlowItems: [travelItem] },
      (url) => (url.endsWith(confirmPath) ? apiOk({ reconciliation_id: "recon-2", status: "matched", confirmed_count: 2, confirmed_amount: "240.0000", currency: "USD", bank_id: "bank-1", cash_flow_item_id: "item-travel", cash_flow_entry_id: "cf-9", bank_missing: false }) : undefined),
    );
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(screen.getByTestId("reconciliation-confirm-recon-2"));

    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应收：REC-002")).toBeInTheDocument();
    // 将要确认的条数与金额写在 info 行里（金额要进账，点之前必须看得见）
    expect(within(dialog).getByText(/2 条草稿应收（合计 240\.0000 USD）/)).toBeInTheDocument();

    await pickOption("action-field-bank_id", /农业银行/);
    await pickOption("action-field-cash_flow_item_id", /差旅费/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, confirmPath)).toHaveLength(1));
    const call = callsTo(calls, confirmPath)[0];
    expect(call.method).toBe("POST");
    // 请求体就是入账银行 + 收支项目这两项（确认金额由后端按范围内的草稿算）
    expect(bodyOf(call)).toEqual({ bank_id: "bank-1", cash_flow_item_id: "item-travel" });
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("REC-002 已确认 2 条应收"))).toBe(true));
  });

  it("确认应收没指定银行时给出「钱记了但没进任何账户」的警告，而不是一句成功", async () => {
    const calls = stubFinance(
      { reconciliations: [matchedRecon()] },
      (url) => (url.endsWith(confirmPath) ? apiOk({ reconciliation_id: "recon-2", status: "matched", confirmed_count: 2, confirmed_amount: "240.0000", currency: "USD", bank_id: null, cash_flow_item_id: null, cash_flow_entry_id: "cf-9", bank_missing: true }) : undefined),
    );
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(screen.getByTestId("reconciliation-confirm-recon-2"));
    await screen.findByTestId("action-dialog");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, confirmPath)).toHaveLength(1));

    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("未指定入账银行"))).toBe(true));
    const warning = screen.getAllByTestId("toast-item").find((item) => item.textContent?.includes("未指定入账银行")) as HTMLElement;
    expect(warning).toHaveTextContent("已记入收支流水，但不会体现在任何银行账户余额里");
    // 警告必须与「成功」区分得开（错误态样式），并且**不能**同时出现「金额已入账」的成功文案
    expect(warning).toHaveClass("ui-toast-error");
    expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("金额已记入所选银行账户"))).toBe(false);
  });

  it("对账单详情里的「一键确认应收」打开同一个确认弹窗", async () => {
    const detail = receivableReconciliation({ details: { entries: [source()], draft_entries: [source()], entry_count: 1, draft_count: 1, draft_amount: "120.0000", can_confirm_receivables: true } });
    stubFinance({ reconciliations: [receivableReconciliation()] }, (url) => (url.endsWith("/api/v1/finance/reconciliations/recon-1") ? apiOk(detail) : undefined));
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.doubleClick(screen.getAllByTestId("data-table-row")[0]);
    const detailDialog = await screen.findByTestId("finance-record-detail");
    fireEvent.click(within(detailDialog).getByRole("button", { name: /一键确认应收/ }));

    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应收：REC-001")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-bank_id")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-cash_flow_item_id")).toBeInTheDocument();
  });

  it("对账单列表与详情都用字典还原收支项目名（字典查不到的显示 -）", async () => {
    const detail = receivableReconciliation({ cashFlowItemId: "item-gone", details: { entries: [], draft_entries: [], entry_count: 0, draft_count: 0, draft_amount: "0.0000", can_confirm_receivables: false } });
    stubFinance(
      { reconciliations: [receivableReconciliation({ cashFlowItemId: "item-travel" })], cashFlowItems: [travelItem] },
      (url) => (url.endsWith("/api/v1/finance/reconciliations/recon-1") ? apiOk(detail) : undefined),
    );
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    const table = panel("应收对账单");
    expect(table.getByText("收支项目")).toBeInTheDocument();
    expect(table.getByText("差旅费")).toBeInTheDocument();

    // 项目被删/停用（或字典没拉到时）：详情里显示 -，不能让整页崩在查标签上
    fireEvent.doubleClick(screen.getAllByTestId("data-table-row")[0]);
    const dialog = await screen.findByTestId("finance-record-detail");
    await waitFor(() => expect(within(dialog).getByText("收支项目")).toBeInTheDocument());
    expect(within(dialog).getAllByText("-").length).toBeGreaterThan(0);
  });
});

describe("应付管理 · 币种与银行", () => {
  it("确认应付弹窗里的支付银行来自银行池，并把银行随请求发出去", async () => {
    const calls = stubFinance({
      payables: [payableEntry()],
      banks: [bank()],
    });
    await open(<PayableWorkspace tab="confirmed" testId="page-finance-payable" />, "page-finance-payable");
    fireEvent.click(panel("确认应付").getByRole("button", { name: "确认应付" }));
    await pickOption("action-field-bank_id", /农业银行/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, `${EP.payables}/pe-1/confirm`)).toHaveLength(1));
    expect(callsTo(calls, `${EP.payables}/pe-1/confirm`)[0].method).toBe("POST");
    expect(bodyOf(callsTo(calls, `${EP.payables}/pe-1/confirm`)[0])).toMatchObject({ bank_id: "bank-1" });
  });

  it("编辑应付草稿可改币种", async () => {
    const calls = stubFinance({ payables: [payableEntry()] });
    await open(<PayableWorkspace tab="confirmed" testId="page-finance-payable" />, "page-finance-payable");
    fireEvent.click(panel("确认应付").getByRole("button", { name: "编辑" }));
    await pickOption("action-field-currency", /USD/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, `${EP.payables}/pe-1`)).toHaveLength(1));
    expect(bodyOf(callsTo(calls, `${EP.payables}/pe-1`)[0])).toMatchObject({ currency: "USD" });
  });
});

// ------------------------------------------------------------------ 凭证管理（从收支流水生成）

/**
 * 2026-09-15 用户口径：「凭证管理，从收支流水中 fetch，每条收支条目都可以生成对应的条目」。
 *
 * 关于「凭证做一个图片返回来？」——这里断言的是**不做图片**的那条路：
 * 凭证是结构化分录（借/贷），页面按记账凭证纸排版，出纸方式是浏览器打印 / 另存 PDF。
 */
const flowEntry = (over: Record<string, unknown> = {}) => ({
  id: "cf-1", entryNo: "CF-20260915-0001", entryDate: "2026-09-15T00:00:00.000Z", counterpartyName: "香港迪礼",
  direction: "income", amount: "14310.0000", currency: "USD", status: "posted", settlementMethod: "转账--农业银行5706",
  remark: null, item: { id: "item-1", key: "货款", label: "货款" }, settlementAccount: { id: "acc-1", key: "农业银行5706", label: "农业银行5706" },
  ...over,
});
const voucher = (over: Record<string, unknown> = {}) => ({
  id: "voucher-1", voucherNo: "记-2026-09-0001", voucherDate: "2026-09-15T00:00:00.000Z", period: "2026-09",
  sourceType: "cash_flow_entry", sourceId: "cf-1", summary: "香港迪礼 · 货款", currency: "USD",
  debitTotal: "14310.0000", creditTotal: "14310.0000", status: "draft", remark: null, createdBy: "user-1",
  source_entry: { id: "cf-1", entryNo: "CF-20260915-0001", status: "posted" },
  lines: [
    { id: "line-1", lineNo: 1, direction: "debit", subjectKey: "银行存款", subjectLabel: "银行存款", summary: "香港迪礼 · 货款", amount: "14310.0000", currency: "USD" },
    { id: "line-2", lineNo: 2, direction: "credit", subjectKey: "货款", subjectLabel: "货款", summary: "香港迪礼 · 货款", amount: "14310.0000", currency: "USD" },
  ],
  ...over,
});
/** 详情接口（凭证纸要用带分录的详情，列表里的行本身没有 lines）。 */
const voucherDetail: Handler = (url, call) => (call.method === "GET" && url.endsWith("/api/v1/finance/vouchers/voucher-1") ? apiOk(voucher()) : undefined);

/**
 * 「一键导出 PNG」走的是「SVG 组版 + 浏览器栅格化」，jsdom 里没有 canvas，
 * 所以这里把 lib 打桩，只断言**接线**：按钮把当前凭证（含分录与来源）交给导出函数，
 * 成功与失败都要有反馈。SVG 组版本身由 lib/voucher-image.test.mjs 覆盖。
 */
const pngMock = vi.hoisted(() => ({ exportVoucherPng: vi.fn(async (_input?: unknown) => "记账凭证-记-2026-09-0001.png") }));
vi.mock("../lib/voucher-image", () => ({ exportVoucherPng: pngMock.exportVoucherPng }));

describe("凭证管理：从收支流水生成凭证", () => {
  it("列出收支流水：未生成的显示「未生成」，已生成的显示凭证号与「查看凭证」", async () => {
    stubFinance(
      { cashFlowEntries: [flowEntry(), flowEntry({ id: "cf-2", entryNo: "CF-20260915-0002", direction: "expense", amount: "5200.0000", item: { id: "item-2", key: "原材料 成本", label: "原材料 成本" } })], vouchers: [voucher()] },
      voucherDetail,
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    const flow = panel("收支流水");
    expect(flow.getByText("CF-20260915-0001")).toBeInTheDocument();
    expect(flow.getByText("货款")).toBeInTheDocument();
    expect(flow.getByText("记-2026-09-0001")).toBeInTheDocument();
    expect(flow.getByText("未生成")).toBeInTheDocument();
    expect(flow.getByRole("button", { name: "查看凭证" })).toBeInTheDocument();
    expect(flow.getByRole("button", { name: "生成凭证" })).toBeInTheDocument();
    // 界面上不再有「凭证是结构化分录，而不是一张图片」这类说明段（2026-09-16 用户要求删掉全部说明性文字），
    // 产品口径改由 docs/design/accounting-vouchers-2026-09-15.md 承载。
    expect(screen.queryByTestId("voucher-policy-note")).toBeNull();
  });

  it("点「生成凭证」走 POST /finance/vouchers/from-cash-flow/:id，并随即打开凭证纸", async () => {
    const calls = stubFinance(
      { cashFlowEntries: [flowEntry()], vouchers: [] },
      (url, call) => (url.endsWith("/finance/vouchers/from-cash-flow/cf-1") ? apiOk(voucher()) : voucherDetail(url, call)),
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    fireEvent.click(panel("收支流水").getByRole("button", { name: "生成凭证" }));
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/vouchers/from-cash-flow/cf-1")).toHaveLength(1));
    expect(callsTo(calls, "/api/v1/finance/vouchers/from-cash-flow/cf-1")[0].method).toBe("POST");
    await waitFor(() => expect(screen.getByTestId("voucher-sheet")).toBeInTheDocument());
  });

  it("凭证纸展示借贷分录与合计，可打印（window.print）/ 另存 PDF", async () => {
    stubFinance({ cashFlowEntries: [flowEntry()], vouchers: [voucher()] }, voucherDetail);
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    fireEvent.click(panel("记账凭证").getByRole("button", { name: "凭证纸" }));
    await waitFor(() => expect(screen.getByTestId("voucher-sheet")).toBeInTheDocument());
    const sheet = within(screen.getByTestId("voucher-sheet"));
    expect(sheet.getByText("记账凭证")).toBeInTheDocument();
    expect(sheet.getByTestId("voucher-line-1")).toHaveTextContent("银行存款");
    expect(sheet.getByTestId("voucher-line-1")).toHaveTextContent("14310");
    expect(sheet.getByTestId("voucher-line-2")).toHaveTextContent("货款");
    expect(sheet.getByText("合计")).toBeInTheDocument();

    const print = vi.fn();
    Object.defineProperty(window, "print", { configurable: true, value: print });
    try {
      fireEvent.click(screen.getByTestId("voucher-print-button"));
      expect(print).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(window, "print");
    }
  });

  it("草稿可编辑（PATCH 整组分录）、过账与删除；已过账只给红冲", async () => {
    const calls = stubFinance(
      { cashFlowEntries: [flowEntry()], vouchers: [voucher(), voucher({ id: "voucher-2", voucherNo: "记-2026-09-0002", sourceId: "cf-2", status: "posted" })] },
      voucherDetail,
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    const table = panel("记账凭证");

    fireEvent.click(table.getAllByRole("button", { name: "编辑" })[0]);
    setValue("action-field-line_2_subject", "商品销售收入");
    setValue("action-field-line_2_amount", "14310");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/vouchers/voucher-1")).toHaveLength(1));
    const patch = callsTo(calls, "/api/v1/finance/vouchers/voucher-1")[0];
    expect(patch.method).toBe("PATCH");
    expect(bodyOf(patch)).toMatchObject({
      summary: "香港迪礼 · 货款",
      lines: [
        { direction: "debit", subject_label: "银行存款", amount: "14310.0000" },
        { direction: "credit", subject_label: "商品销售收入", amount: "14310" },
      ],
    });

    fireEvent.click(panel("记账凭证").getAllByRole("button", { name: "过账" })[0]);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/vouchers/voucher-1/post")).toHaveLength(1));

    fireEvent.click(panel("记账凭证").getAllByRole("button", { name: "删除" })[0]);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/vouchers/voucher-1")).toHaveLength(2));
    expect(callsTo(calls, "/api/v1/finance/vouchers/voucher-1")[1].method).toBe("DELETE");

    // 已过账的那张：只有红冲，没有编辑/过账/删除
    const posted = panel("记账凭证");
    expect(posted.getAllByRole("button", { name: "红冲" })).toHaveLength(1);
  });

  it("一键导出 PNG：把当前凭证（含分录与来源）交给导出函数，成功后提示文件名", async () => {
    pngMock.exportVoucherPng.mockClear();
    stubFinance({ cashFlowEntries: [flowEntry()], vouchers: [voucher()] }, voucherDetail);
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    fireEvent.click(panel("记账凭证").getByRole("button", { name: "凭证纸" }));
    await waitFor(() => expect(screen.getByTestId("voucher-sheet")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("voucher-png-button"));
    await waitFor(() => expect(pngMock.exportVoucherPng).toHaveBeenCalledTimes(1));
    const input = pngMock.exportVoucherPng.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({ voucherNo: "记-2026-09-0001", currency: "USD", debitTotal: "14310.0000", creditTotal: "14310.0000", sourceLabel: "收支流水 CF-20260915-0001" });
    expect((input.lines as unknown[])).toHaveLength(2);
    expect((input.lines as Array<Record<string, unknown>>)[1]).toMatchObject({ direction: "credit", subjectLabel: "货款", amount: "14310.0000" });
    await waitFor(() => expect(screen.getByTestId("toast-item")).toHaveTextContent("已导出 记账凭证-记-2026-09-0001.png"));
  });

  it("导出 PNG 失败时把可执行的原因 toast 出来（不静默）", async () => {
    pngMock.exportVoucherPng.mockClear();
    pngMock.exportVoucherPng.mockRejectedValueOnce(new Error("当前环境不支持导出图片（canvas 不可用），请改用「打印 / 另存 PDF」"));
    stubFinance({ cashFlowEntries: [flowEntry()], vouchers: [voucher()] }, voucherDetail);
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    fireEvent.click(panel("记账凭证").getByRole("button", { name: "凭证纸" }));
    await waitFor(() => expect(screen.getByTestId("voucher-sheet")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("voucher-png-button"));
    await waitFor(() => expect(screen.getByTestId("toast-item")).toHaveTextContent("改用「打印 / 另存 PDF」"));
    // 失败后按钮回到可用状态（不能让用户以为卡住了）
    await waitFor(() => expect(screen.getByTestId("voucher-png-button")).toHaveTextContent("导出 PNG"));
    expect(screen.getByTestId("voucher-sheet")).toBeInTheDocument();
  });

  it("红冲必须填原因：不填本地就拦住（不发请求），填了才提交", async () => {    const calls = stubFinance({ cashFlowEntries: [flowEntry()], vouchers: [voucher({ status: "posted" })] }, voucherDetail);
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    fireEvent.click(panel("记账凭证").getByRole("button", { name: "红冲" }));
    submitDialog();
    await waitFor(() => expect(screen.getByTestId("action-dialog-error")).toHaveTextContent("请填写红冲原因"));
    expect(callsTo(calls, "/api/v1/finance/vouchers/voucher-1/reverse")).toHaveLength(0);

    setValue("action-field-reason", "科目挂错");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/vouchers/voucher-1/reverse")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/vouchers/voucher-1/reverse")[0]).reason).toBe("科目挂错");
  });

  it("后端拒绝时弹窗不关，并把后端原因显示在弹窗里（不静默失败）", async () => {
    const calls = stubFinance(
      { cashFlowEntries: [flowEntry()], vouchers: [voucher({ status: "posted" })] },
      (url, call) => (url.endsWith("/finance/vouchers/voucher-1/reverse")
        ? apiErr(422, "VOUCHER_NOT_REVERSIBLE", "只有已过账的凭证可以红冲")
        : voucherDetail(url, call)),
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    fireEvent.click(panel("记账凭证").getByRole("button", { name: "红冲" }));
    setValue("action-field-reason", "科目挂错");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/vouchers/voucher-1/reverse")).toHaveLength(1));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("只有已过账的凭证可以红冲");
    expect(screen.getByTestId("action-dialog")).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ 失败态

describe("财务模块：失败态与权限降级", () => {
  it("列表接口 403 时显示错误态并可重试", async () => {
    let fail = true;
    const calls = stubFinance({}, (url) => (fail && url.endsWith("/api/v1/finance/receivable-sources") ? apiErr(403, "FORBIDDEN", "无财务模块权限") : undefined));
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    expect(screen.getByTestId("error-state")).toHaveTextContent("无财务模块权限");
    fail = false;
    fireEvent.click(screen.getByTestId("error-state-retry"));
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources")).toHaveLength(2));
    expect(screen.queryByTestId("error-state")).not.toBeInTheDocument();
  });

  it("客户/供应商/销售单接口 403 时留空选项，但财务数据照常渲染", async () => {
    stubFinance(
      { receivables: [source()] },
      (url) => (/\/api\/v1\/(customers|sales-orders|suppliers)$/.test(url) ? apiErr(403, "FORBIDDEN", "无销售模块权限") : undefined),
    );
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    expect(panel("成品出库条目").getByText("AR-001")).toBeInTheDocument();
    expect(screen.queryByTestId("error-state")).not.toBeInTheDocument();
  });

  it("动作失败经 toast 暴露后端消息，且弹窗留在原地显示原因（不静默关闭）", async () => {
    stubFinance({ receivables: [source()] }, (url) => (url.endsWith("/confirm") ? apiErr(409, "RECEIVABLE_SOURCE_NOT_CONFIRMABLE", "只有草稿应收来源可以确认") : undefined));
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "确认应收" }));
    await screen.findByTestId("action-dialog");
    submitDialog();
    await waitFor(() => expect(screen.getByTestId("toast-item")).toHaveTextContent("只有草稿应收来源可以确认"));
    // 确认失败时留在弹窗里（金额要进账，不能只弹一句 toast 就把弹窗关掉）
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("只有草稿应收来源可以确认");
  });
});