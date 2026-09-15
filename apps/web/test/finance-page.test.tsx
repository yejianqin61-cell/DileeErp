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
import { describe, expect, it } from "vitest";
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
  customers: "/api/v1/customers",
  suppliers: "/api/v1/suppliers",
  salesOrders: "/api/v1/sales-orders",
  currencies: "/api/v1/dictionaries/currency/items",
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
  it("展示 7 个入口，并分别指向二级页地址", async () => {
    stubFinance();
    render(<FinanceBoardIndex />);
    expect(screen.getByTestId("page-finance")).toBeInTheDocument();
    for (const [key, title] of [["receivable", "应收管理"], ["payable", "应付管理"], ["salary", "工资管理"], ["banks", "银行账户"], ["cash-flow", "收支管理"], ["reports", "财务报表"], ["voucher", "凭证管理"]] as const) {
      const card = screen.getByTestId(`finance-board-${key}`);
      expect(card).toHaveAttribute("href", `/finance/${key}`);
      expect(within(card).getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByTestId("finance-board-grid").querySelectorAll("a")).toHaveLength(7);
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

  it("确认应收走 POST /:id/confirm（不带 body）", async () => {
    const calls = stubFinance({ receivables: [source()] });
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "确认应收" }));
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")).toHaveLength(1));
    const call = callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")[0];
    expect(call.method).toBe("POST");
    expect(call.body).toBeNull();
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
      reconciliations: [receivableReconciliation(), receivableReconciliation({ id: "recon-2", reconciliationNo: "REC-002", status: "matched", difference: "0.0000" })],
    });
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    const table = panel("应收对账单");
    expect(table.getByText("REC-001")).toBeInTheDocument();
    expect(table.getByText("有差异")).toBeInTheDocument();
    expect(table.getByText("已对平")).toBeInTheDocument();

    fireEvent.click(table.getByRole("button", { name: "处理差异" }));
    setValue("action-field-remark", "客户确认差异为折让");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/reconciliations/recon-1/resolve")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/reconciliations/recon-1/resolve")[0]).resolution_remark).toBe("客户确认差异为折让");

    fireEvent.click(panel("应收对账单").getByRole("button", { name: "一键确认应收" }));
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/reconciliations/recon-2/confirm-receivables")).toHaveLength(1));
    expect(callsTo(calls, "/api/v1/finance/reconciliations/recon-2/confirm-receivables")[0].method).toBe("POST");
  });

  it("待创建对账按客户+月份分组，创建对账时把客户与期间自动带入表单", async () => {
    const calls = stubFinance({ receivables: [source()], customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }] });
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    const groups = panel("待创建对账的条目");
    expect(groups.getByText("香港迪礼")).toBeInTheDocument();
    expect(groups.getByText("2026-09")).toBeInTheDocument();
    expect(groups.getByText("1 条")).toBeInTheDocument();

    fireEvent.click(groups.getByRole("button", { name: "创建对账" }));
    // 客户与期间由分组自动带入，只需要填外部余额
    expect((screen.getByTestId("action-field-period_start") as HTMLInputElement).value).toBe("2026-09-01");
    expect((screen.getByTestId("action-field-period_end") as HTMLInputElement).value).toBe("2026-09-30");
    setValue("action-field-external_balance", "100");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/reconciliations").filter((call) => call.method === "POST")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/api/v1/finance/reconciliations").filter((call) => call.method === "POST")[0]);
    expect(body).toMatchObject({ customer_id: "customer-1", period_start: "2026-09-01", period_end: "2026-09-30", external_balance: "100" });
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
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/supplier-payable-reconciliations/srecon-1/confirm-payables")).toHaveLength(1));
  });

  it("待创建对账按供应商+月份分组并可一键带入表单", async () => {
    const calls = stubFinance({ payables: [payableEntry()], suppliers: [{ id: "supplier-1", name: "绍兴纺织", supplierCode: "S001" }] });
    await open(<PayableWorkspace tab="reconciliations" testId="page-finance-payable" />, "page-finance-payable");
    const groups = panel("待创建对账");
    expect(groups.getByText("绍兴纺织")).toBeInTheDocument();
    expect(groups.getByText("2026-09")).toBeInTheDocument();
    fireEvent.click(groups.getByRole("button", { name: "创建对账" }));
    expect((screen.getByTestId("action-field-period_start") as HTMLInputElement).value).toBe("2026-09-01");
    setValue("action-field-external_balance", "50");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/supplier-payable-reconciliations").filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/supplier-payable-reconciliations").filter((call) => call.method === "POST")[0])).toMatchObject({ supplier_id: "supplier-1", period_start: "2026-09-01", external_balance: "50" });
  });

  it("确认应付是台账视图：草稿可确认/编辑，已确认可付款/回退，付款核销带 allocations", async () => {
    const calls = stubFinance({
      payables: [payableEntry(), payableEntry({ id: "pe-2", payableNo: "AP-002", status: "confirmed", outstanding_amount: "50.0000" })],
      supplierPayments: [supplierPayment(), supplierPayment({ id: "sp-2", paymentNo: "PY-002", status: "posted" })],
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

    fireEvent.click(panel("确认应付").getByRole("button", { name: "登记付款" }));
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/supplier-payments").filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/supplier-payments").filter((call) => call.method === "POST")[0])).toMatchObject({ supplier_id: "supplier-1", amount: "50.0000" });
    // 付款建单同样必须带幂等键（与收款侧对称）。
    const payableCreateBody = bodyOf(callsTo(calls, "/api/v1/finance/supplier-payments").filter((call) => call.method === "POST")[0]) as Record<string, unknown>;
    expect(String(payableCreateBody.idempotency_key)).toMatch(/^web-payment-\d+-[a-z0-9]+$/);

    fireEvent.click(panel("付款").getByRole("button", { name: "过账/核销" }));
    await pickOption("action-field-entry_id", /AP-002/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/supplier-payments/sp-1/post")).toHaveLength(1));
    const post = bodyOf(callsTo(calls, "/api/v1/finance/supplier-payments/sp-1/post")[0]) as { allocations: Array<{ payable_entry_id: string }> };
    expect(post.allocations[0].payable_entry_id).toBe("pe-2");

    fireEvent.click(panel("付款").getByRole("button", { name: "冲销" }));
    setValue("action-field-reason", "重复付款");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/supplier-payments/sp-2/reverse")).toHaveLength(1));
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
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/payable-entries/pe-1/confirm")).toHaveLength(1));
    expect(callsTo(calls, "/api/v1/finance/payable-entries/pe-1/confirm")[0].method).toBe("POST");
  });
});

// ------------------------------------------------------------------ 凭证管理（占位）

describe("凭证管理：占位与待生成凭证预览", () => {
  it("只统计已确认（含部分收付/已收付清）的应收与应付条目", async () => {
    stubFinance({
      receivables: [source(), confirmedSource, source({ id: "rec-3", sourceNo: "AR-003", status: "cancelled" })],
      payables: [payableEntry(), payableEntry({ id: "pe-2", payableNo: "AP-002", status: "confirmed" })],
    });
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    expect(screen.getByText("建设中：凭证单据编号规则、会计科目与期间结账尚未定义，因此这里只做预览，不提供任何写操作。")).toBeInTheDocument();
    expect(screen.getByTestId("voucher-receivable-preview")).toHaveTextContent("已确认应收 1 条，合计 120.00");
    expect(screen.getByTestId("voucher-payable-preview")).toHaveTextContent("已确认应付 1 条，合计 50.00");
    expect(screen.getByRole("button", { name: "生成单据（建设中）" })).toBeDisabled();
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

describe("应付管理 · 币种与银行", () => {
  it("编辑付款草稿可改币种与支付银行", async () => {
    const calls = stubFinance({
      supplierPayments: [supplierPayment({ bank: { id: "bank-1", bankCode: "B001", bankName: "农业银行", accountName: "迪礼公司", accountNumber: "5706", currency: "CNY", isActive: true, swiftCode: null, remark: null } })],
      banks: [bank()],
    });
    await open(<PayableWorkspace tab="confirmed" testId="page-finance-payable" />, "page-finance-payable");
    expect(panel("付款").getByText("农业银行（5706）")).toBeInTheDocument();

    fireEvent.click(panel("付款").getByRole("button", { name: "编辑" }));
    await pickOption("action-field-currency", /USD/);
    await pickOption("action-field-bank_id", /农业银行/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, `${EP.supplierPayments}/sp-1`)).toHaveLength(1));
    const patch = callsTo(calls, `${EP.supplierPayments}/sp-1`)[0];
    expect(patch.method).toBe("PATCH");
    expect(bodyOf(patch)).toMatchObject({ currency: "USD", bank_id: "bank-1" });
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

  it("动作失败经 toast 暴露后端消息", async () => {
    stubFinance({ receivables: [source()] }, (url) => (url.endsWith("/confirm") ? apiErr(409, "RECEIVABLE_SOURCE_NOT_CONFIRMABLE", "只有草稿应收来源可以确认") : undefined));
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "确认应收" }));
    await waitFor(() => expect(screen.getByTestId("toast-item")).toHaveTextContent("只有草稿应收来源可以确认"));
  });
});