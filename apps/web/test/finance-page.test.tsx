// 财务模块的**行为**测试：真实渲染 + 真实点击 + 断言真实发出的请求。
//
// 2026-09-14 重构后财务分为「一级 4 板块 + 二级子栏目」，页面组件直接接收 tab，
// 因此这里渲染组件（而不渲染 async 的 Server Component 页面文件）。
//
// 本文件继承旧财务页测试（原 apps/web/test/finance-page.test.tsx 与
// lib/finance-draft-edit-method.test.mjs）的三条意图，并改成运行时断言：
//   1) 应收来源 / 应付条目两种草稿「编辑」必须发出 PATCH（用 POST 会 404）；
//   2) 确认 / 回退 / 取消 / 冲销 / 接收应付 / 勾选批量确认仍然走 POST；
//   3) 每个入口的 URL 指向 /:id 而不是集合根。
// 桩会复刻真实 API 的注册形状（草稿编辑只认 PATCH，POST 返回 404），所以一旦回归成 POST，
// 用户看到的"操作失败"会在测试里重现（成功提示不会出现）。
//
// 2026-09-16 的「确认即记账」口径已被 2026-09-24 的「确认 = 挂账」取代：
// 确认不再动现金，应收 / 应付两侧都是「勾选 + 批量确认」；2026-11-09 D4 起，
// 真正的收/付款回归为**整单结清**的「合并收款 / 合并付款」（核销金额只读、金额必须等于核销合计）。
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
  reconciliations: "/api/v1/finance/reconciliations",
  payableSources: "/api/v1/payable-sources",
  outsourceSources: "/api/v1/production/outsource-logistics-batches/payable-sources",
  payables: "/api/v1/finance/payable-entries",
  supplierReconciliations: "/api/v1/finance/supplier-payable-reconciliations",
  banks: "/api/v1/finance/banks",
  cashFlowEntries: "/api/v1/finance/cash-flow-entries",
  vouchers: "/api/v1/finance/vouchers",
  customers: "/api/v1/customers",
  suppliers: "/api/v1/suppliers",
  salesOrders: "/api/v1/sales-orders",
  currencies: "/api/v1/dictionaries/currency/items",
  subjects: "/api/v1/finance/accounting-subjects",
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
      // 列表地址可能带查询串（会计科目要 `?include_inactive=true`），所以按「路径 + 可选查询串」匹配；
      // 但必须排除 `/accounting-subjects/categories`、`/:id` 这类**子路径**，否则它们会被当成列表。
      if (url === path || url.startsWith(`${path}?`)) return apiOk(data[key] ?? []);
    }
    return apiOk([]);
  });
}

/**
 * 复刻真实 API 的注册形状：草稿编辑只有 PATCH（finance.controller.ts 的 @Patch(".../:id")），
 * POST 到同一个 /:id 会 404。只匹配集合下的单条路径（/:id），不匹配 /:id/confirm 这类动作路径。
 *
 * 因此这里只剩应收来源与应付条目两种可编辑草稿。
 */
const draftEditIsPatchOnly: Handler = (url, call) =>
  /\/finance\/(receivable-sources|payable-entries)\/[^/]+$/.test(url) && call.method !== "PATCH"
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
/** 只数 PATCH 的调用：分录编辑器打开时会先按 id GET 一次详情，同一个地址两类请求会混在一起。 */
const patchesTo = (calls: StubbedCall[], suffix: string) => calls.filter((call) => call.method === "PATCH" && call.url.includes(suffix));
/**
 * 只数 POST 的调用，且用 `endsWith` 而不是 `includes`：
 * 新建凭证是 `POST /finance/vouchers`，而过账是 `POST /finance/vouchers/:id/post` ——
 * 用 includes 时前者会把后者也算进来（而 `patchesTo` 用的是 includes，那是它的历史写法）。
 */
const postsTo = (calls: StubbedCall[], suffix: string) => calls.filter((call) => call.method === "POST" && call.url.endsWith(suffix));
const setValue = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const submitDialog = () => fireEvent.click(screen.getByTestId("action-dialog-submit"));
/** 断言某条 toast 出现过（自动导入也会产生 toast，不能用 getByTestId 单数）。 */
const expectToast = async (text: string) => {
  await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes(text))).toBe(true));
};
/**
 * 下拉必须真实点开再点选项，否则必填校验会拦住提交。
 *
 * 两种实现都要能点开：Radix `Select`（testid 就在 trigger 按钮上）与 `SearchableSelect`
 * （2026-09-20 起会计科目用它，testid 落在根 div 上，里面的 button 才是 trigger）。
 */
async function pickOption(testId: string, optionName: RegExp) {
  const root = screen.getByTestId(testId);
  await userEvent.click((root.querySelector("button") ?? root) as HTMLElement);
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
/** 一条已确认、未收余额 80 的应收：R2-6 的「整单结清」用例就勾它。 */
const settleSource = (over: Record<string, unknown> = {}) => source({ id: "rec-8", sourceNo: "AR-008", status: "confirmed", amount: "80.0000", allocated_amount: "0.0000", outstanding_amount: "80.0000", ...over });
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
  it("展示 9 个入口，并分别指向二级页地址", async () => {
    stubFinance();
    render(<FinanceBoardIndex />);
    expect(screen.getByTestId("page-finance")).toBeInTheDocument();
    // 第 9 个是「收付款单」（2026-09-26 的存档页）：保存过的收/付款单在那里找回、再导出、作废。
    for (const [key, title] of [["receivable", "应收管理"], ["payable", "应付管理"], ["salary", "工资管理"], ["slips", "收付款单"], ["banks", "银行账户"], ["bank-transfers", "银行余额互转"], ["cash-flow", "收支管理"], ["reports", "财务报表"], ["voucher", "凭证管理"]] as const) {
      const card = screen.getByTestId(`finance-board-${key}`);
      expect(card).toHaveAttribute("href", `/finance/${key}`);
      expect(within(card).getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByTestId("finance-board-grid").querySelectorAll("a")).toHaveLength(9);
  });
});

// ------------------------------------------------------------------ 应收管理

describe("应收管理 · 成品出库条目", () => {
  it("展示客户/出库单/未收余额与待确认合计，并给出两个子栏目（对账与确认已合并）", async () => {
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
    // 2026-09-20（用户要求）：应收对账与确认应收合并成一个页签，所以只剩两个子栏目，
    // 且都是真实链接（可收藏），地址带 tab 参数。
    for (const [key, title] of [["outbound-entries", "成品出库条目"], ["reconciliations", "应收对账与确认"]] as const) {
      const link = screen.getByTestId(`finance-tab-${key}`);
      expect(link).toHaveAttribute("href", `/finance/receivable?tab=${key}`);
      expect(within(link).getByText(title)).toBeInTheDocument();
    }
    // 合并前的旧页签值不再是页签，但仍能被解析到合并视图（`RECEIVABLE_TAB_ALIASES`）
    expect(screen.queryByTestId("finance-tab-confirmed")).toBeNull();
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

  it("逐条确认应收改走弹窗（确认 = 挂账，只问会计科目/款项性质），提交后 POST /:id/confirm", async () => {
    const calls = stubFinance({ receivables: [source()] });
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "确认应收" }));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应收：AR-001")).toBeInTheDocument();
    // 确认 = 挂账：弹窗不再问「入账银行」，只留挂账信息 + 会计科目 + 款项性质
    expect(screen.queryByTestId("action-field-bank_id")).toBeNull();
    expect(screen.getByTestId("action-field-subject_id")).toBeInTheDocument();
    expect(within(dialog).getByText(/确认后生成挂账凭证：借 应收账款、贷 收入；钱未到账/)).toBeInTheDocument();
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")).toHaveLength(1));
    const call = callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")[0];
    expect(call.method).toBe("POST");
    // 确认不写现金：请求体只剩款项性质（会计科目未选 → 不发），不再带 bank_id。
    // 款项性质默认「货款」并一起送出去：外汇一览表按它分列。
    expect(bodyOf(call)).toEqual({ payment_nature: "balance" });
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

    // 一键确认应收也是**挂账**：弹窗只说清「生成挂账凭证」，只问会计科目与款项性质（不再问入账银行）。
    fireEvent.click(screen.getByTestId("reconciliation-confirm-recon-2"));
    const confirmDialog = await screen.findByTestId("action-dialog");
    expect(within(confirmDialog).getByText("确认应收：REC-002")).toBeInTheDocument();
    expect(screen.queryByTestId("action-field-bank_id")).toBeNull();
    expect(screen.getByTestId("action-field-subject_id")).toBeInTheDocument();
    expect(within(confirmDialog).getByText(/确认后生成挂账凭证：借 应收账款、贷 收入；钱未到账/)).toBeInTheDocument();
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

describe("应收管理 · 确认应收", () => {
  it("确认应收是台账视图：草稿可勾选/确认，已确认可回退，行内不再有「登记收款」", async () => {
    const calls = stubFinance({
      receivables: [source(), confirmedSource],
      customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }],
    });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    const confirmed = panel("确认应收");
    expect(confirmed.getByText("AR-001")).toBeInTheDocument();
    expect(confirmed.getByRole("button", { name: "确认应收" })).toBeInTheDocument();
    // 已收 = 收清了；已确认只是挂账（钱还没进账），所以它和草稿一起留在默认的「未收」清单里
    expect(confirmed.getByText("AR-002")).toBeInTheDocument();
    await pickOption("receivable-payment-filter", /已收（0）/);
    expect(confirmed.queryByText("AR-002")).toBeNull();
    await pickOption("receivable-payment-filter", /未收（2）/);
    expect(confirmed.getByText("AR-002")).toBeInTheDocument();
    expect(confirmed.getByText("已确认")).toBeInTheDocument();
    // 确认 = 挂账：行内不放「登记收款」——收款是整单结清的批量动作（勾选 →「合并收款」），
    // 逐条按钮会诱导出一条应收一张收款单。
    expect(confirmed.queryByRole("button", { name: "登记收款" })).toBeNull();

    fireEvent.click(confirmed.getByRole("button", { name: "回退草稿" }));
    setValue("action-field-reason", "金额有误");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/rec-2/reopen")).toHaveLength(1));
  });

  it("勾选批量确认应收：勾选多条草稿 → 一次 POST batch-confirm（已确认的另走合并收款）", async () => {
    const second = source({ id: "rec-3", sourceNo: "AR-003", orderNo: "SO-3", amount: "90.0000" });
    const calls = stubFinance(
      { receivables: [source(), second, confirmedSource], customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }] },
      (url) => (url.endsWith("/finance/receivable-sources/batch-confirm")
        ? apiOk({ confirmed_count: 2, skipped_count: 0, amounts: [{ currency: "USD", amount: "210.0000" }], bank_missing: false })
        : undefined),
    );
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    // 勾选对两条流程开放：草稿（批量确认）+ 已确认且有未收余额的应收（合并收款）。
    expect(screen.getByTestId("receivable-select-rec-1")).toBeInTheDocument();
    expect(screen.getByTestId("receivable-select-rec-2")).toBeInTheDocument();
    expect(screen.getByTestId("receivable-batch-confirm")).toBeDisabled();
    expect(screen.getByTestId("receivable-merge-receipt")).toBeDisabled();

    fireEvent.click(screen.getByTestId("receivable-select-all"));
    // 全选覆盖 3 条：2 条草稿可确认 + 1 条已确认可收款
    expect(screen.getByTestId("receivable-selected-count")).toHaveTextContent("已选 3 条（可确认 2 / 可收款 1）");
    fireEvent.click(screen.getByTestId("receivable-batch-confirm"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认 2 条草稿应收（合计 210.0000 USD）")).toBeInTheDocument();
    // 批量确认不问入账银行（确认只挂账）
    expect(screen.queryByTestId("action-field-bank_id")).toBeNull();
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/batch-confirm")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/receivable-sources/batch-confirm")[0])).toEqual({ ids: ["rec-1", "rec-3"], payment_nature: "balance" });
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已确认 2 条应收（210.0000 USD）"))).toBe(true));
  });
});

/**
 * 2026-11-09 D4（应收侧）：收款整单结清。
 *
 * 每条应收的核销金额 = 该条未收余额（**只读**），收款金额默认 = Σ核销金额，且提交前必须相等；
 * 不等就前端阻断（后端同样 422 PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION）。
 */
describe("应收管理 · 合并收款（整单结清）", () => {
  const stubPayments = () => stubFinance(
    { receivables: [settleSource()], banks: [bank()] },
    (url, call) => {
      if (call.method === "POST" && url.endsWith("/finance/customer-payments")) return apiOk({ id: "cpay-1", paymentNo: "SK-1" });
      if (call.method === "POST" && url.endsWith("/finance/customer-payments/cpay-1/post")) return apiOk({ id: "cpay-1", status: "posted" });
      return undefined;
    },
  );

  it("勾选已确认应收 80 → 核销金额只读 80、收款金额只读派生 80；提交按未收余额整单核销", async () => {
    const calls = stubPayments();
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    fireEvent.click(screen.getByTestId("receivable-select-rec-8"));
    await waitFor(() => expect(screen.getByTestId("receivable-merge-receipt")).toBeEnabled());
    expect(screen.getByTestId("receivable-merge-hint")).toHaveTextContent("未收余额合计 80");
    fireEvent.click(screen.getByTestId("receivable-merge-receipt"));

    const dialog = await screen.findByTestId("receivable-merge-dialog");
    expect(within(dialog).getByText("合并收款：香港迪礼 / USD，1 条应收")).toBeInTheDocument();
    // 核销金额只读（不是输入框），就是该条未收余额
    const row = screen.getByTestId("receivable-merge-row-rec-8");
    expect(within(row).getByTestId("receivable-merge-amount-rec-8")).toHaveTextContent("80.0000 USD");
    expect(within(row).queryByRole("textbox")).toBeNull();
    // 收款金额是**只读派生** = Σ核销金额（不是第二个可编辑输入）
    const receiptAmount = within(dialog).getByTestId("receivable-merge-receipt-amount");
    expect(receiptAmount.tagName).toBe("SPAN");
    expect(receiptAmount).toHaveTextContent("收款金额 80 USD（只读派生 = 核销合计）");
    expect(within(dialog).getByTestId("receivable-merge-total")).toHaveTextContent("核销合计 80 USD");

    fireEvent.click(within(dialog).getByTestId("receivable-merge-submit"));
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/customer-payments")).toHaveLength(1));
    const create = callsTo(calls, "/api/v1/finance/customer-payments")[0];
    expect(create.method).toBe("POST");
    expect(bodyOf(create)).toMatchObject({ customer_id: "customer-1", amount: "80", currency: "USD", bank_id: "bank-1", payment_method: "银行转账" });
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/customer-payments/cpay-1/post")).toHaveLength(1));
    // 过账核销：每条应收按未收余额整笔核销
    expect(bodyOf(callsTo(calls, "/api/v1/finance/customer-payments/cpay-1/post")[0])).toEqual({ allocations: [{ receivable_source_id: "rec-8", amount: "80.0000" }], payment_nature: "balance" });
    await expectToast("已收款并核销 1 条应收（80 USD）");
  });

  it("收款金额只读派生（无可编辑金额输入）；后端 PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION 原样展示", async () => {
    const calls = stubFinance(
      { receivables: [settleSource()], banks: [bank()] },
      (url, call) => {
        if (call.method === "POST" && url.endsWith("/finance/customer-payments")) return apiOk({ id: "cpay-1", paymentNo: "SK-1" });
        // 防御校验的兜底：即使前端派生值正常，后端 D4 守卫仍可能拒；message 必须原样展示
        if (call.method === "POST" && url.endsWith("/finance/customer-payments/cpay-1/post")) {
          return apiErr(422, "PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION", "收款金额必须等于核销合计");
        }
        return undefined;
      },
    );
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    fireEvent.click(screen.getByTestId("receivable-select-rec-8"));
    await waitFor(() => expect(screen.getByTestId("receivable-merge-receipt")).toBeEnabled());
    fireEvent.click(screen.getByTestId("receivable-merge-receipt"));
    const dialog = await screen.findByTestId("receivable-merge-dialog");

    // 收款金额与核销金额都只读：没有第二个金额输入框
    const receiptAmount = within(dialog).getByTestId("receivable-merge-receipt-amount");
    expect(receiptAmount.tagName).toBe("SPAN");
    expect(receiptAmount).toHaveTextContent("只读派生");
    expect(within(dialog).getByTestId("receivable-merge-row-rec-8").querySelector("input")).toBeNull();
    expect(within(dialog).queryByTestId("receivable-merge-reset")).toBeNull();

    fireEvent.click(within(dialog).getByTestId("receivable-merge-submit"));
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/customer-payments/cpay-1/post")).toHaveLength(1));
    // 建单成功但核销被后端 D4 守卫拒：草稿单号与后端 message 必须留在弹窗里（不能只闪一条 toast）
    await waitFor(() => expect(screen.getByTestId("receivable-merge-draft-notice")).toHaveTextContent("收款金额必须等于核销合计"));
    expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已收款并核销"))).toBe(false);
  });
});

/**
 * 2026-11-09 R3-13（应收侧）：挂账状态展示 + 按来源重算。
 *
 * 后端 list/get 返回 `accrual_status`；只有 **reversed（挂账已红冲）** 才有「按来源重算」入口，
 * 调 POST /finance/receivables/:id/reaccrue，成功后刷新并 toast 新凭证号。
 */
describe("应收管理 · 挂账状态与按来源重算", () => {
  const confirmedSource = (over: Record<string, unknown> = {}) => source({ status: "confirmed", outstanding_amount: "120.0000", ...over });

  it("已挂账显示「已挂账」且没有重算按钮；无 accrual_status 的历史行按「未挂账」处理", async () => {
    stubFinance({ receivables: [confirmedSource({ accrual_status: "posted" }), source({ id: "rec-legacy", sourceNo: "AR-LEGACY", status: "confirmed" })] });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    expect(screen.getByTestId("receivable-accrual-rec-1")).toHaveTextContent("已挂账");
    expect(screen.getByTestId("receivable-accrual-rec-legacy")).toHaveTextContent("未挂账");
    expect(screen.queryByTestId("receivable-reaccrue-rec-1")).toBeNull();
    expect(screen.queryByTestId("receivable-reaccrue-rec-legacy")).toBeNull();
  });

  it("挂账已红冲：警示色 + 「按来源重算」→ POST /finance/receivables/:id/reaccrue、toast 新凭证号", async () => {
    const calls = stubFinance(
      { receivables: [confirmedSource({ accrual_status: "reversed" })] },
      (url, call) => (call.method === "POST" && url.endsWith("/finance/receivables/rec-1/reaccrue")
        ? apiOk({ id: "voucher-2", voucherNo: "记-2026-11-0200", status: "posted", replayed: false })
        : undefined),
    );
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    const badge = screen.getByTestId("receivable-accrual-rec-1");
    expect(badge).toHaveTextContent("挂账已红冲");
    expect(badge).toHaveClass("status-error");

    fireEvent.click(screen.getByTestId("receivable-reaccrue-rec-1"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText(/挂账凭证已红冲/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/finance/receivables/rec-1/reaccrue").filter((call) => call.method === "POST")).toHaveLength(1));
    // 原因可选：不填就不发 reason
    expect(bodyOf(callsTo(calls, "/finance/receivables/rec-1/reaccrue")[0])).toEqual({});
    await expectToast("记-2026-11-0200");
    await waitFor(() => expect(callsTo(calls, EP.receivables).filter((call) => call.method === "GET").length).toBeGreaterThanOrEqual(2));
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
    // 确认应付也走「确认应付：<对账单号>」弹窗，但确认 = 挂账（钱未支付）：只问会计科目，不问支付银行。
    const confirmDialog = await screen.findByTestId("action-dialog");
    expect(within(confirmDialog).getByText("确认应付：APREC-001")).toBeInTheDocument();
    expect(screen.queryByTestId("action-field-bank_id")).toBeNull();
    expect(screen.getByTestId("action-field-subject_id")).toBeInTheDocument();
    expect(within(confirmDialog).getByText(/确认后生成挂账凭证：借 成本\/费用科目、贷 应付账款；钱未支付/)).toBeInTheDocument();
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

  it("确认应付是台账视图：默认列未付（草稿 + 已确认挂账），已付清才要用筛选器切出来", async () => {
    const calls = stubFinance({
      payables: [payableEntry(), payableEntry({ id: "pe-2", payableNo: "AP-002", status: "confirmed", outstanding_amount: "50.0000" })],
    });
    await open(<PayableWorkspace tab="confirmed" testId="page-finance-payable" />, "page-finance-payable");
    const table = panel("确认应付");
    expect(table.getByText("AP-001")).toBeInTheDocument();
    expect(table.getByRole("button", { name: "确认应付" })).toBeInTheDocument();
    // 已确认只是挂账、钱还没付出（supplier-payable.service.ts:200-227），所以它在默认的未付清单里；
    // 已付档只留给付清的条目 —— 这里一条都没有。
    expect(table.getByText("AP-002")).toBeInTheDocument();
    await pickOption("payable-payment-filter", /已付（0）/);
    expect(table.queryByText("AP-002")).toBeNull();
    await pickOption("payable-payment-filter", /未付（2）/);
    expect(table.getByText("AP-002")).toBeInTheDocument();

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
    // 确认 = 挂账：没有支付银行字段（银行只在「合并付款」那一步选）
    expect(screen.queryByTestId("action-field-bank_id")).toBeNull();
    expect(within(dialog).getByText(/确认后生成挂账凭证/)).toBeInTheDocument();
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/payable-entries/batch-confirm")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/payable-entries/batch-confirm")[0])).toEqual({ ids: ["pe-1", "pe-2"] });
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已确认 2 条应付（130.0000 CNY）"))).toBe(true));
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已生成挂账凭证"))).toBe(true));
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
    // 逐条确认应付同样是「确认 = 挂账」：弹窗只问会计科目（挂账凭证借方），不问支付银行。
    const confirmDialog = await screen.findByTestId("action-dialog");
    expect(within(confirmDialog).getByText("确认应付：AP-001")).toBeInTheDocument();
    expect(screen.queryByTestId("action-field-bank_id")).toBeNull();
    expect(screen.getByTestId("action-field-subject_id")).toBeInTheDocument();
    expect(within(confirmDialog).getByText(/确认后生成挂账凭证：借 成本\/费用科目、贷 应付账款；钱未支付/)).toBeInTheDocument();
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
  it("合并收款弹窗的到账银行来自银行池，且只列启用账户", async () => {
    stubFinance({
      receivables: [settleSource()],
      banks: [bank(), bank({ id: "bank-dead", bankCode: "B002", bankName: "中国银行", accountNumber: "7624", isActive: false })],
    });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    fireEvent.click(screen.getByTestId("receivable-select-rec-8"));
    await userEvent.click(screen.getByTestId("receivable-merge-receipt"));
    const dialog = await screen.findByTestId("receivable-merge-dialog");
    await userEvent.click(within(dialog).getByTestId("receivable-merge-bank"));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent).join("|")).toContain("农业银行");
    expect(options.map((option) => option.textContent).join("|")).not.toContain("中国银行");
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
 * 应收侧的「会计科目 + 确认应收」：确认 = **挂账**（借 应收账款 / 贷 收入），钱未到账。
 *
 * 两件事都有「看着成功、其实钱没归位」的风险，所以这里钉住**请求体**：
 *   1) 建单（对账）时选的会计科目必须随 POST 发出去，否则单据上永远只有后端猜的那个；
 *   2) 确认应收只发 `subject_id` + `payment_nature` —— **不再发 bank_id**（确认不写现金，与应付同理），
 *      也不再出现「未指定入账银行 / 已记入收支流水」的旧口径警告。
 */
describe("应收管理 · 会计科目与确认应收入账", () => {
  const travelSubject = { id: "subject-travel", category: "损益类", name: "主营业务收入", balanceDirection: "贷", sortOrder: 1, isActive: true };
  const matchedRecon = () => receivableReconciliation({
    id: "recon-2", reconciliationNo: "REC-002", status: "matched", difference: "0.0000",
    flow: { entry_count: 2, draft_count: 2, draft_amount: "240.0000", can_confirm_receivables: true, order_nos: ["SO-1"], product_names: ["折叠伞"], product_specifications: ["黑胶"] },
  });
  const confirmPath = "/api/v1/finance/reconciliations/recon-2/confirm-receivables";

  it("创建对账把选中的会计科目随 POST 发出去", async () => {
    const calls = stubFinance({
      receivables: [source()],
      customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }],
      subjects: [travelSubject],
    });
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("待创建对账的条目").getByRole("button", { name: "创建对账" }));
    setValue("action-field-external_balance", "100");
    await pickOption("action-field-subject_id", /损益类 \/ 主营业务收入/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, EP.reconciliations).filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, EP.reconciliations).filter((call) => call.method === "POST")[0])).toMatchObject({ subject_id: "subject-travel" });
  });

  it("勾选批量确认应收把选中的会计科目随请求发出去", async () => {
    const calls = stubFinance(
      { receivables: [source()], customers: [{ id: "customer-1", name: "香港迪礼", customerCode: "C001" }], subjects: [travelSubject] },
      (url) => (url.endsWith("/finance/receivable-sources/batch-confirm") ? apiOk({ confirmed_count: 1, skipped_count: 0, amounts: [{ currency: "USD", amount: "120.0000" }], bank_missing: false }) : undefined),
    );
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(screen.getByTestId("receivable-select-rec-1"));
    fireEvent.click(screen.getByTestId("receivable-batch-confirm"));
    await screen.findByTestId("action-dialog");
    await pickOption("action-field-subject_id", /损益类 \/ 主营业务收入/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/batch-confirm")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/receivable-sources/batch-confirm")[0])).toMatchObject({ subject_id: "subject-travel" });
  });

  /**
   * 逐条确认应收 / 勾选批量确认应收：与「一键确认应收」同一件事的两条**行级**入口，
   * 都是**挂账**（钱没到账）——所以弹窗只收集会计科目 + 款项性质，不再问入账银行，
   * 也不再在 `bank_missing` 时报「钱记进流水了」。
   */
  it("逐条确认应收：行内按钮打开弹窗，只提交 { subject_id, payment_nature }（不再有入账银行）", async () => {
    const calls = stubFinance(
      { receivables: [source()], subjects: [travelSubject] },
      (url) => (url.endsWith("/api/v1/finance/receivable-sources/rec-1/confirm") ? apiOk({ ...source(), amount: "120.0000", currency: "USD", accrual_voucher_id: "v-1", bank_missing: false }) : undefined),
    );
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "确认应收" }));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应收 AR-001：120.0000 USD")).toBeInTheDocument();
    expect(screen.queryByTestId("action-field-bank_id")).toBeNull();
    await pickOption("action-field-subject_id", /损益类 \/ 主营业务收入/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")[0])).toEqual({ subject_id: "subject-travel", payment_nature: "balance" });
    await expectToast("已生成挂账凭证（借 应收账款，贷 收入）；钱未到账");
  });

  /**
   * 款项性质（定金 / 货款 / 尾款 / 其他）。
   *
   * 确认 = 挂账（确认这一步就记账），钱的性质就在这一步问清楚 —— 老表「外汇一览表」正是按这一列把收款拆成
   * 「定金 / 货款」两组。默认「货款」（绝大多数确认都是出货后收的货款），定金要手工选。
   */
  it("逐条确认应收：默认款项性质是货款，选「定金」后按定金记账", async () => {
    const calls = stubFinance(
      { receivables: [source()], banks: [bank()], subjects: [travelSubject] },
      (url) => (url.endsWith("/api/v1/finance/receivable-sources/rec-1/confirm") ? apiOk({ ...source(), bank_missing: false }) : undefined),
    );
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "确认应收" }));
    await screen.findByTestId("action-dialog");
    expect(screen.getByTestId("action-field-payment_nature")).toHaveTextContent("货款");
    await pickOption("action-field-payment_nature", /^定金$/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")[0])).toMatchObject({ payment_nature: "deposit" });
  });

  it("款项性质下拉四个取值都在（定金/货款/尾款/其他）", async () => {
    stubFinance({ receivables: [source()] });
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "确认应收" }));
    await screen.findByTestId("action-dialog");
    await userEvent.click(screen.getByTestId("action-field-payment_nature"));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["定金", "货款", "尾款", "其他"]);
  });

  it("逐条确认应收：旧响应带 bank_missing 时走中性兜底，不再提「入账银行 / 收支流水」", async () => {
    const calls = stubFinance(
      { receivables: [source()] },
      (url) => (url.endsWith("/api/v1/finance/receivable-sources/rec-1/confirm") ? apiOk({ ...source(), amount: "120.0000", currency: "USD", bank_missing: true }) : undefined),
    );
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(panel("成品出库条目").getByRole("button", { name: "确认应收" }));
    await screen.findByTestId("action-dialog");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receivable-sources/rec-1/confirm")).toHaveLength(1));
    await expectToast("请刷新核对");
    const warning = screen.getAllByTestId("toast-item").find((item) => item.textContent?.includes("请刷新核对")) as HTMLElement;
    expect(warning).toHaveClass("ui-toast-error");
    expect(warning).not.toHaveTextContent("未指定入账银行");
    expect(warning).not.toHaveTextContent("已记入收支流水");
    expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("金额已记入所选银行账户"))).toBe(false);
  });

  it("确认应收先弹窗说明挂账，只问会计科目/款项性质（不再问入账银行），提交后按选定科目挂账", async () => {
    const calls = stubFinance(
      { reconciliations: [matchedRecon()], subjects: [travelSubject] },
      (url) => (url.endsWith(confirmPath) ? apiOk({ reconciliation_id: "recon-2", status: "matched", confirmed_count: 2, confirmed_amount: "240.0000", currency: "USD", subject_id: "subject-travel", bank_missing: false }) : undefined),
    );
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(screen.getByTestId("reconciliation-confirm-recon-2"));

    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应收：REC-002")).toBeInTheDocument();
    // 将要确认的条数与金额写在 info 行里（点之前必须看得见）
    expect(within(dialog).getByText(/2 条草稿应收（合计 240\.0000 USD）/)).toBeInTheDocument();
    expect(screen.queryByTestId("action-field-bank_id")).toBeNull();
    expect(within(dialog).getByText(/确认后生成挂账凭证：借 应收账款、贷 收入；钱未到账/)).toBeInTheDocument();

    await pickOption("action-field-subject_id", /损益类 \/ 主营业务收入/);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, confirmPath)).toHaveLength(1));
    const call = callsTo(calls, confirmPath)[0];
    expect(call.method).toBe("POST");
    // 请求体只有会计科目 + 款项性质（确认金额由后端按范围内的草稿算），bank_id 已不在协议里
    expect(bodyOf(call)).toEqual({ subject_id: "subject-travel", payment_nature: "balance" });
    await expectToast("REC-002 已确认 2 条应收");
    await expectToast("已生成挂账凭证（借 应收账款，贷 收入）；钱未到账");
  });

  it("确认应收：旧响应带 bank_missing 时走中性兜底，不再报「钱记了但没进任何账户」", async () => {
    const calls = stubFinance(
      { reconciliations: [matchedRecon()] },
      (url) => (url.endsWith(confirmPath) ? apiOk({ reconciliation_id: "recon-2", status: "matched", confirmed_count: 2, confirmed_amount: "240.0000", currency: "USD", subject_id: null, bank_missing: true }) : undefined),
    );
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.click(screen.getByTestId("reconciliation-confirm-recon-2"));
    await screen.findByTestId("action-dialog");
    submitDialog();
    await waitFor(() => expect(callsTo(calls, confirmPath)).toHaveLength(1));

    await expectToast("请刷新核对");
    const warning = screen.getAllByTestId("toast-item").find((item) => item.textContent?.includes("请刷新核对")) as HTMLElement;
    // 警告必须与「成功」区分得开（错误态样式），并且**不能**再说钱进了流水 / 没进任何账户
    expect(warning).toHaveClass("ui-toast-error");
    expect(warning).not.toHaveTextContent("未指定入账银行");
    expect(warning).not.toHaveTextContent("已记入收支流水");
    expect(warning).not.toHaveTextContent("不会体现在任何银行账户余额里");
    expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("金额已记入所选银行账户"))).toBe(false);
  });

  it("对账单详情里的「一键确认应收」打开同一个确认弹窗（无入账银行、有挂账说明）", async () => {
    const detail = receivableReconciliation({ details: { entries: [source()], draft_entries: [source()], entry_count: 1, draft_count: 1, draft_amount: "120.0000", can_confirm_receivables: true } });
    stubFinance({ reconciliations: [receivableReconciliation()] }, (url) => (url.endsWith("/api/v1/finance/reconciliations/recon-1") ? apiOk(detail) : undefined));
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    fireEvent.doubleClick(screen.getAllByTestId("data-table-row")[0]);
    const detailDialog = await screen.findByTestId("finance-record-detail");
    fireEvent.click(within(detailDialog).getByRole("button", { name: /一键确认应收/ }));

    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应收：REC-001")).toBeInTheDocument();
    expect(screen.queryByTestId("action-field-bank_id")).toBeNull();
    expect(screen.getByTestId("action-field-subject_id")).toBeInTheDocument();
    expect(within(dialog).getByText(/确认后生成挂账凭证：借 应收账款、贷 收入；钱未到账/)).toBeInTheDocument();
  });

  it("对账单列表与详情都用会计科目表还原科目名（查不到的显示 -）", async () => {
    const detail = receivableReconciliation({ subjectId: "subject-gone", details: { entries: [], draft_entries: [], entry_count: 0, draft_count: 0, draft_amount: "0.0000", can_confirm_receivables: false } });
    const calls = stubFinance(
      { reconciliations: [receivableReconciliation({ subjectId: "subject-travel" })], subjects: [travelSubject] },
      (url) => (url.endsWith("/api/v1/finance/reconciliations/recon-1") ? apiOk(detail) : undefined),
    );
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    // 必须**带停用科目**取数：否则科目一停用，历史对账单上的科目名就显示成 "-"
    // （后端为此刻意保留了停用科目，报表也会把它们列出来）。
    // 这里不用 callsTo：它只认「以路径结尾」，而这次调用带查询串。
    const subjectCall = calls.find((call) => call.url.startsWith(`${EP.subjects}?`));
    expect(subjectCall?.url).toContain("include_inactive=true");
    const table = panel("应收对账单");
    expect(table.getByText("会计科目")).toBeInTheDocument();
    expect(table.getByText("损益类 / 主营业务收入")).toBeInTheDocument();

    // 科目被删/停用（或科目表没拉到时）：详情里显示 -，不能让整页崩在查标签上
    fireEvent.doubleClick(screen.getAllByTestId("data-table-row")[0]);
    const dialog = await screen.findByTestId("finance-record-detail");
    await waitFor(() => expect(within(dialog).getByText("会计科目")).toBeInTheDocument());
    expect(within(dialog).getAllByText("-").length).toBeGreaterThan(0);
  });
});

describe("应付管理 · 币种与银行", () => {
  it("确认应付弹窗不再出现支付银行（银行只在付款那一步选），请求体也不带 bank_id", async () => {
    const calls = stubFinance({
      payables: [payableEntry({ subjectId: "subject-travel" })],
      banks: [bank()],
    });
    await open(<PayableWorkspace tab="confirmed" testId="page-finance-payable" />, "page-finance-payable");
    fireEvent.click(panel("确认应付").getByRole("button", { name: "确认应付" }));
    const dialog = await screen.findByTestId("action-dialog");
    // 银行池仍在加载（合并付款要用），但确认弹窗里没有支付银行：确认只挂账、不动银行
    expect(screen.queryByTestId("action-field-bank_id")).toBeNull();
    expect(within(dialog).getByTestId("action-field-subject_id")).toBeInTheDocument();
    expect(within(dialog).getByText(/确认后生成挂账凭证/)).toBeInTheDocument();
    submitDialog();
    await waitFor(() => expect(callsTo(calls, `${EP.payables}/pe-1/confirm`)).toHaveLength(1));
    expect(callsTo(calls, `${EP.payables}/pe-1/confirm`)[0].method).toBe("POST");
    expect(bodyOf(callsTo(calls, `${EP.payables}/pe-1/confirm`)[0])).not.toHaveProperty("bank_id");
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
  remark: null, subject: { id: "subject-1", category: "损益类", name: "主营业务收入" }, settlementAccount: { id: "acc-1", key: "农业银行5706", label: "农业银行5706" },
  ...over,
});
const voucher = (over: Record<string, unknown> = {}) => ({
  id: "voucher-1", voucherNo: "记-2026-09-0001", voucherDate: "2026-09-15T00:00:00.000Z", period: "2026-09",
  sourceType: "cash_flow_entry", sourceId: "cf-1", summary: "香港迪礼 · 货款", currency: "USD",
  debitTotal: "14310.0000", creditTotal: "14310.0000", status: "draft", remark: null, createdBy: "user-1", created_by_name: "张三",
  source_entry: { id: "cf-1", entryNo: "CF-20260915-0001", status: "posted" },
  lines: [
    { id: "line-1", lineNo: 1, direction: "debit", subjectKey: "银行存款", subjectLabel: "银行存款", summary: "香港迪礼 · 货款", amount: "14310.0000", currency: "USD" },
    { id: "line-2", lineNo: 2, direction: "credit", subjectKey: "货款", subjectLabel: "货款", summary: "香港迪礼 · 货款", amount: "14310.0000", currency: "USD" },
  ],
  ...over,
});
/**
 * 记账凭证模板（`GET /finance/vouchers/:id/templates`，财务 2026-09-20）。
 *
 * 两套结构照抄财务给的分录：工资计提「借 应付职工薪酬 / 贷 其他应付款 + 应交税费 + 银行存款」，
 * 原材料采购「借 原材料 + 应交税费-进项税 / 贷 应付账款」。金额一律留空（模板不带金额）。
 */
const voucherTemplates = () => [
  { key: "salary-accrual", name: "工资计提", description: "工资计提（金额由财务填写）", lines: [
    { direction: "debit", role: "business", summary: "计提工资（应发）", subject_id: "sub-salary", subject_label: "应付职工薪酬", subject_key: "负债类/应付职工薪酬", bank_id: null, bank_label: null },
    { direction: "credit", role: "business", summary: "代扣社保（个人部分）", subject_id: "sub-other", subject_label: "其他应付款", subject_key: "负债类/其他应付款", bank_id: null, bank_label: null },
    // 科目表里没有「应交个人所得税」，候选落空时给建议名（subject_id 为 null）。
    { direction: "credit", role: "business", summary: "代扣个人所得税", subject_id: null, subject_label: "应交税费——应交个人所得税", subject_key: "应交税费——应交个人所得税", bank_id: null, bank_label: null },
    { direction: "credit", role: "fund", summary: "实发工资", subject_id: null, subject_label: "银行存款", subject_key: "银行存款", bank_id: "bank-1", bank_label: "农业银行5706" },
  ] },
  { key: "raw-material-purchase", name: "原材料采购", description: "原材料采购（金额由财务填写）", lines: [
    { direction: "debit", role: "business", summary: "采购原材料", subject_id: "sub-material", subject_label: "原材料", subject_key: "资产类/原材料", bank_id: null, bank_label: null },
    { direction: "debit", role: "business", summary: "进项税额（取得专票时）", subject_id: "sub-input", subject_label: "应交税费-进项税", subject_key: "负债类/应交税费-进项税", bank_id: null, bank_label: null },
    { direction: "credit", role: "business", summary: "应付供应商货款", subject_id: "sub-payable", subject_label: "应付账款", subject_key: "负债类/应付账款", bank_id: null, bank_label: null },
  ] },
];
/** 详情接口（凭证纸与分录编辑器都要带分录的详情，列表里的行本身没有 lines）。 */
const voucherDetail: Handler = (url, call) => {
  if (call.method !== "GET") return undefined;
  // 模板路径要**先判**：它不以 `/voucher-1` 结尾，但用 `endsWith` 时不会互相吃掉 —— 顺序只是保险。
  if (url.endsWith("/api/v1/finance/vouchers/voucher-1/templates")) return apiOk(voucherTemplates());
  if (url.endsWith("/api/v1/finance/vouchers/voucher-1")) return apiOk(voucher());
  return undefined;
};

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
      { cashFlowEntries: [flowEntry(), flowEntry({ id: "cf-2", entryNo: "CF-20260915-0002", direction: "expense", amount: "5200.0000", subject: { id: "subject-2", category: "成本类", name: "原材料 成本" } })], vouchers: [voucher()] },
      voucherDetail,
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    const flow = panel("收支流水");
    expect(flow.getByText("CF-20260915-0001")).toBeInTheDocument();
    expect(flow.getByText("损益类 / 主营业务收入")).toBeInTheDocument();
    expect(flow.getByText("记-2026-09-0001")).toBeInTheDocument();
    expect(flow.getByText("未生成")).toBeInTheDocument();
    expect(flow.getByRole("button", { name: "查看凭证" })).toBeInTheDocument();
    expect(flow.getByRole("button", { name: "生成凭证" })).toBeInTheDocument();
    expect(flow.getByTestId("voucher-regenerate-from-entry-voucher-1")).toBeInTheDocument();
    // 界面上不再有「凭证是结构化分录，而不是一张图片」这类说明段（2026-09-16 用户要求删掉全部说明性文字），
    // 产品口径改由 docs/design/accounting-vouchers-2026-09-15.md 承载。
    expect(screen.queryByTestId("voucher-policy-note")).toBeNull();
  });

  /**
   * 2026-09-16（用户要求「现在要支持凭证重新生成」）：生成是幂等的，流水后来补了银行账户 / 改了项目
   * 就得能把凭证按现在的流水重算一遍。只对**草稿**开放（已过账的凭证是账务事实，只能红冲），
   * 并且弹窗里要先说清「手工改过的分录会被覆盖」。
   */
  it("草稿凭证可以按收支流水重新生成：POST /:id/regenerate，弹窗先说明会覆盖手工改动", async () => {
    const calls = stubFinance(
      { cashFlowEntries: [flowEntry()], vouchers: [voucher()] },
      (url, call) => (call.method === "POST" && url.endsWith("/finance/vouchers/voucher-1/regenerate")
        ? apiOk({ ...voucher(), regenerated: true })
        : voucherDetail(url, call)),
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    fireEvent.click(screen.getByTestId("voucher-regenerate-voucher-1"));

    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText(/手工改过的分录会被覆盖/)).toBeInTheDocument();
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/finance/vouchers/voucher-1/regenerate")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已按收支流水重新生成"))).toBe(true));
  });

  it("已过账的凭证不给「重新生成」（只能红冲）", async () => {
    stubFinance({ cashFlowEntries: [flowEntry()], vouchers: [voucher({ status: "posted" })] }, voucherDetail);
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    expect(screen.queryByTestId("voucher-regenerate-voucher-1")).toBeNull();
    expect(panel("记账凭证").getByRole("button", { name: "红冲" })).toBeInTheDocument();
  });

  /**
   * 2026-11-04 用户报障：财务把挂账凭证的分录手改成现金分录后，凭证页没有「重新生成」可用，
   * 只能红冲/删草稿，于是越改越乱。挂账凭证（来源 = 应付/应收确认）也要能按来源单据重建。
   */
  it("挂账凭证（来源应付单）也能重新生成：弹窗说明按来源重建「借业务科目/贷应付账款」", async () => {
    const accrual = voucher({
      id: "voucher-2",
      voucherNo: "记-2026-11-0002",
      sourceType: "supplier_payable",
      sourceId: "payable-1",
      source_entry: null,
      summary: "确认应付 APO-20261104-AC4E1120（厦门纳益） 挂账",
      currency: "CNY",
      lines: [
        { id: "l1", lineNo: 1, direction: "debit", subjectKey: "损益类/销售费 推广费", subjectLabel: "销售费 推广费", summary: "", amount: "2700.0000", currency: "CNY" },
        { id: "l2", lineNo: 2, direction: "credit", subjectKey: "资产类/银行存款 中国银行", subjectLabel: "银行存款 中国银行（人民币）", summary: "应付 APO-20261104-AC4E1120", amount: "2700.0000", currency: "CNY" },
      ],
    });
    const calls = stubFinance(
      { cashFlowEntries: [flowEntry()], vouchers: [accrual] },
      (url, call) => (call.method === "POST" && url.endsWith("/finance/vouchers/voucher-2/regenerate")
        ? apiOk({ ...accrual, regenerated: true })
        : voucherDetail(url, call)),
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");

    fireEvent.click(screen.getByTestId("voucher-regenerate-voucher-2"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText(/借 业务科目 \/ 贷 应付账款/)).toBeInTheDocument();
    expect(within(dialog).getByText(/手工改过的分录会被覆盖/)).toBeInTheDocument();
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/finance/vouchers/voucher-2/regenerate")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已按来源单据重新生成"))).toBe(true));
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

  /**
   * R3-7（2026-11-09）：流水/收付款自动生成的凭证**生成即过账**（D2/D6 收口）。
   * 成功提示按接口返回的 `status` 说真话：posted → 「已生成并过账」；存量草稿才提示人工过账。
   */
  it("生成凭证：响应 status=posted → 提示「已生成并过账」，不再说「草稿」", async () => {
    stubFinance(
      { cashFlowEntries: [flowEntry()], vouchers: [] },
      (url, call) => (url.endsWith("/finance/vouchers/from-cash-flow/cf-1") ? apiOk(voucher({ status: "posted" })) : voucherDetail(url, call)),
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    fireEvent.click(panel("收支流水").getByRole("button", { name: "生成凭证" }));
    await expectToast("已生成并过账：记-2026-09-0001");
    expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("草稿，需人工过账"))).toBe(false);
  });

  it("生成凭证：响应 status=draft（存量草稿）→ 提示「草稿，需人工过账」", async () => {
    stubFinance(
      { cashFlowEntries: [flowEntry()], vouchers: [] },
      (url, call) => (url.endsWith("/finance/vouchers/from-cash-flow/cf-1") ? apiOk(voucher({ status: "draft" })) : voucherDetail(url, call)),
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    fireEvent.click(panel("收支流水").getByRole("button", { name: "生成凭证" }));
    await expectToast("已生成凭证 记-2026-09-0001（草稿，需人工过账）");
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
    // 制单处必须是**姓名**，不能是 createdBy 那个 UUID：
    // 2026-09-16 之前这里渲染 `voucher.createdBy`，凭证纸与打印件上印的是「制单：user-1」。
    expect(sheet.getByText("制单：张三")).toBeInTheDocument();
    expect(sheet.queryByText(/制单：user-1/)).toBeNull();

    const print = vi.fn();
    Object.defineProperty(window, "print", { configurable: true, value: print });
    try {
      fireEvent.click(screen.getByTestId("voucher-print-button"));
      expect(print).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(window, "print");
    }
  });

  /**
   * R3-9（2026-11-09）：凭证纸显示「业务科目（辅助）」。
   *
   * 规则（brief 表 3 用例）：分录行有 `business_subject_label` 且与记账科目名**不同**才显示；
   * 没有业务科目不显示；业务科目与记账科目相同不重复显示。
   */
  const openVoucherSheet = async (detail: ReturnType<typeof voucher>) => {
    stubFinance(
      { cashFlowEntries: [flowEntry()], vouchers: [detail] },
      (url, call) => (call.method === "GET" && url.endsWith("/api/v1/finance/vouchers/voucher-1") ? apiOk(detail) : undefined),
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    fireEvent.click(panel("记账凭证").getByRole("button", { name: "凭证纸" }));
    await waitFor(() => expect(screen.getByTestId("voucher-sheet")).toBeInTheDocument());
    return within(screen.getByTestId("voucher-sheet"));
  };

  it("凭证纸：分录有业务科目且与记账科目不同 → 显示「业务科目（辅助）：房租费」", async () => {
    const sheet = await openVoucherSheet(voucher({ lines: [
      { id: "l1", lineNo: 1, direction: "debit", subjectKey: "损益类/管理费用", subjectLabel: "管理费用", subjectId: "sub-admin", businessSubjectId: "sub-rent", businessSubjectLabel: "房租费", summary: "办公室房租", amount: "100.0000", currency: "CNY" },
      { id: "l2", lineNo: 2, direction: "credit", subjectKey: "资产类/银行存款", subjectLabel: "银行存款", summary: "办公室房租", amount: "100.0000", currency: "CNY" },
    ] }));
    expect(sheet.getByTestId("voucher-line-business-1")).toHaveTextContent("业务科目（辅助）：房租费");
    // 没有业务科目的行不出现辅助说明（同一张凭证里逐行判定）
    expect(sheet.queryByTestId("voucher-line-business-2")).toBeNull();
  });

  it("凭证纸：分录没有业务科目 → 不显示「业务科目（辅助）」", async () => {
    const sheet = await openVoucherSheet(voucher());
    expect(sheet.queryByText(/业务科目（辅助）/)).toBeNull();
  });

  it("凭证纸：业务科目与记账科目相同 → 不重复显示", async () => {
    const sheet = await openVoucherSheet(voucher({ lines: [
      { id: "l1", lineNo: 1, direction: "debit", subjectKey: "损益类/管理费用", subjectLabel: "管理费用", subjectId: "sub-admin", businessSubjectId: "sub-admin", businessSubjectLabel: "管理费用", summary: "管理费用", amount: "100.0000", currency: "CNY" },
      { id: "l2", lineNo: 2, direction: "credit", subjectKey: "资产类/银行存款", subjectLabel: "银行存款", summary: "管理费用", amount: "100.0000", currency: "CNY" },
    ] }));
    expect(sheet.queryByTestId("voucher-line-business-1")).toBeNull();
    expect(sheet.queryByText(/业务科目（辅助）/)).toBeNull();
  });

  /**
   * 手工新增凭证（2026-09-24）：折旧 / 摊销 / 工资计提 / 结转成本这些**非现金分录**没有收支流水可挂 ——
   * 没有这条路，三大报表的固定资产/累计折旧/应付职工薪酬等行永远填不上。
   * 新建态与编辑态共用同一个编辑器：日期与币种在这里填、保存走 POST 集合路由。
   */
  it("新建凭证：编辑器给出一借一贷两条空行 + 日期/币种，填平后 POST /finance/vouchers", async () => {
    const calls = stubFinance(
      { cashFlowEntries: [flowEntry()], vouchers: [], subjects: [
        { id: "sub-expense", category: "损益类", name: "管理费用", balanceDirection: "借", sortOrder: 1, isActive: true },
        { id: "sub-dep", category: "资产类", name: "累计折旧", balanceDirection: "借", sortOrder: 2, isActive: true },
      ] },
      voucherDetail,
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");

    fireEvent.click(screen.getByTestId("voucher-create"));
    await screen.findByTestId("voucher-line-editor");
    // 新建态：两条空行（一借一贷），日期与币种可填，模板栏不出现（模板接口要凭证 id）
    expect(screen.getByTestId("voucher-editor-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("voucher-editor-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("voucher-editor-date")).toBeInTheDocument();
    expect((screen.getByTestId("voucher-editor-currency") as HTMLInputElement).value).toBe("CNY");
    expect(screen.queryByTestId("voucher-editor-templates")).toBeNull();
    // 没填平之前保存按钮是禁用的（新建一张不平的凭证等于往账上写错数）
    expect(screen.getByTestId("voucher-editor-save")).toBeDisabled();

    setValue("voucher-editor-summary", "计提 9 月折旧");
    setValue("voucher-editor-date", "2026-09-30");
    await pickOption("voucher-editor-subject-0", /管理费用/);
    setValue("voucher-editor-amount-0", "2500");
    await pickOption("voucher-editor-subject-1", /累计折旧/);
    setValue("voucher-editor-amount-1", "2500");
    await waitFor(() => expect(screen.getByTestId("voucher-editor-save")).toBeEnabled());

    fireEvent.click(screen.getByTestId("voucher-editor-save"));
    await waitFor(() => expect(postsTo(calls, "/api/v1/finance/vouchers")).toHaveLength(1));
    expect(bodyOf(postsTo(calls, "/api/v1/finance/vouchers")[0])).toMatchObject({
      voucher_date: "2026-09-30",
      currency: "CNY",
      summary: "计提 9 月折旧",
      // 分录带的是科目**编码与名称快照**（`分类/名称`），不是科目 id：凭证要留住记账当时的科目名。
      lines: [
        { direction: "debit", amount: "2500", subject_key: "损益类/管理费用", subject_label: "管理费用" },
        { direction: "credit", amount: "2500", subject_key: "资产类/累计折旧", subject_label: "累计折旧" },
      ],
    });
  });

  it("草稿可编辑分录（PATCH 整组）、过账与删除；已过账只给红冲", async () => {
    const calls = stubFinance(
      { cashFlowEntries: [flowEntry()], vouchers: [voucher(), voucher({ id: "voucher-2", voucherNo: "记-2026-09-0002", sourceId: "cf-2", status: "posted" })] },
      voucherDetail,
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    const table = panel("记账凭证");

    // 「编辑分录」先按 id 取一次详情再打开编辑器（列表行里没有分录）。
    fireEvent.click(table.getAllByRole("button", { name: "编辑分录" })[0]);
    await screen.findByTestId("voucher-line-editor");
    expect(screen.getByTestId("voucher-editor-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("voucher-editor-row-1")).toBeInTheDocument();
    // 原样带出已有的两行（科目、摘要、金额）
    expect(screen.getByTestId("voucher-editor-amount-0")).toHaveValue("14310.0000");
    expect(screen.getByTestId("voucher-editor-amount-1")).toHaveValue("14310.0000");

    setValue("voucher-editor-amount-0", "14000");
    setValue("voucher-editor-amount-1", "14000");
    fireEvent.click(screen.getByTestId("voucher-editor-save"));
    // 编辑器打开时会先按 id 取一次详情（GET 同一个地址），所以这里只数 PATCH。
    await waitFor(() => expect(patchesTo(calls, "/api/v1/finance/vouchers/voucher-1")).toHaveLength(1));
    const patch = patchesTo(calls, "/api/v1/finance/vouchers/voucher-1")[0];
    expect(patch.method).toBe("PATCH");
    expect(bodyOf(patch)).toMatchObject({
      summary: "香港迪礼 · 货款",
      lines: [
        { direction: "debit", subject_label: "银行存款", amount: "14000" },
        { direction: "credit", subject_label: "货款", amount: "14000" },
      ],
    });

    fireEvent.click(panel("记账凭证").getAllByRole("button", { name: "过账" })[0]);
    submitDialog();
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/vouchers/voucher-1/post")).toHaveLength(1));

    fireEvent.click(panel("记账凭证").getAllByRole("button", { name: "删除" })[0]);
    submitDialog();
    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE" && call.url.includes("/api/v1/finance/vouchers/voucher-1"))).toHaveLength(1));

    // 已过账的那张：只有红冲，没有编辑/过账/删除
    const posted = panel("记账凭证");
    expect(posted.getAllByRole("button", { name: "红冲" })).toHaveLength(1);
  });

  /**
   * 财务 2026-09-20：「我完整的一个工资是这样的：借 应付职工薪酬——工资（应发）；
   * 贷 其他应付款——社保（个人部分）、应交税费——应交个人所得税、银行存款（实发）。但是现在都不能改」
   * 「原材料的也是要加上应交税费」「现在自动生成的不能改、。这是什么意思？」
   *
   * 这条用例走完整条新路径：套模板 → 四行一借三贷 → 金额没填平之前保存按钮是禁用的 →
   * 填平之后 PATCH 整组发出去。原来是「一借一贷两行、不能增删行」，这三步一步也走不通。
   */
  it("套用「工资计提」模板得到四行一借三贷，金额不平不让保存，填平后 PATCH 整组发出去", async () => {
    // 科目下拉要有选项，编辑器才能把科目 id 显示成「分类 / 名称」（否则触发器会显示裸 id）。
    const calls = stubFinance(
      { cashFlowEntries: [flowEntry()], vouchers: [voucher()], subjects: [
        { id: "sub-salary", category: "负债类", name: "应付职工薪酬", balanceDirection: "贷", sortOrder: 1, isActive: true },
        { id: "sub-other", category: "负债类", name: "其他应付款", balanceDirection: "贷", sortOrder: 2, isActive: true },
      ] },
      voucherDetail,
    );
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    fireEvent.click(panel("记账凭证").getAllByRole("button", { name: "编辑分录" })[0]);
    await screen.findByTestId("voucher-line-editor");

    fireEvent.click(await screen.findByTestId("voucher-template-salary-accrual"));
    // 模板**替换**全部分录：四行，方向是 借 / 贷 / 贷 / 贷
    expect(screen.getByTestId("voucher-editor-row-3")).toBeInTheDocument();
    expect(screen.queryByTestId("voucher-editor-row-4")).toBeNull();
    expect(screen.getByTestId("voucher-editor-row-0")).toHaveTextContent("应付职工薪酬");
    expect(screen.getByTestId("voucher-editor-row-2")).toHaveTextContent("应交税费——应交个人所得税");
    // 金额留空（不按税率自动拆进项税/个税），此时借=贷=0，不允许保存
    expect(screen.getByTestId("voucher-editor-amount-0")).toHaveValue("");
    expect(screen.getByTestId("voucher-editor-save")).toBeDisabled();

    setValue("voucher-editor-amount-0", "12000");
    setValue("voucher-editor-amount-1", "1800");
    setValue("voucher-editor-amount-2", "200");
    setValue("voucher-editor-amount-3", "10000");
    // 一借三贷：12000 = 1800 + 200 + 10000
    expect(screen.getByTestId("voucher-editor-totals")).toHaveTextContent("借方合计 12000");
    expect(screen.getByTestId("voucher-editor-totals")).toHaveTextContent("贷方合计 12000");
    expect(screen.getByTestId("voucher-editor-save")).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("voucher-editor-save"));
    await waitFor(() => expect(patchesTo(calls, "/api/v1/finance/vouchers/voucher-1")).toHaveLength(1));
    expect(bodyOf(patchesTo(calls, "/api/v1/finance/vouchers/voucher-1")[0])).toMatchObject({
      lines: [
        { direction: "debit", subject_label: "应付职工薪酬", amount: "12000", bank_id: null },
        { direction: "credit", subject_label: "其他应付款", amount: "1800", bank_id: null },
        // 科目候选落空，保存的是模板给的**建议名**（财务可以在下拉里改选成科目表里的科目）
        { direction: "credit", subject_label: "应交税费——应交个人所得税", amount: "200", bank_id: null },
        // 资金行带上了后端给的那张卡：钱在哪张卡上是已确认的事实
        { direction: "credit", subject_label: "银行存款", amount: "10000", bank_id: "bank-1" },
      ],
    });
  });

  it("分录编辑器：借贷不平时给出差额并禁用保存（不让人走到「点了才被告知不平」）", async () => {
    stubFinance({ cashFlowEntries: [flowEntry()], vouchers: [voucher()] }, voucherDetail);
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");
    fireEvent.click(panel("记账凭证").getAllByRole("button", { name: "编辑分录" })[0]);
    await screen.findByTestId("voucher-line-editor");

    setValue("voucher-editor-amount-0", "100");
    setValue("voucher-editor-amount-1", "99.5");
    expect(screen.getByTestId("voucher-editor-totals")).toHaveTextContent("差额 0.5");
    expect(screen.getByTestId("voucher-editor-save")).toBeDisabled();
    // 金额非法（第 5 位小数）与「还没填完」也是不许保存的原因，且各自说明
    setValue("voucher-editor-amount-1", "abc");
    expect(screen.getByTestId("voucher-editor-save")).toBeDisabled();
    fireEvent.click(screen.getByTestId("voucher-editor-add"));
    expect(screen.getByTestId("voucher-editor-row-2")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("voucher-editor-remove-2"));
    expect(screen.queryByTestId("voucher-editor-row-2")).toBeNull();
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

  /**
   * 导出记账凭证 Excel（2026-10-13，用户：「财务模块，记账凭证中，摘要也要一并导出」）。
   *
   * 前缀断言**只到接线为止**：文件内容（一行一条分录、摘要/科目/借贷列）在后端
   * `voucher-workbook.test.cjs` 里逐格钉住 —— 前端要做对的只有"点哪个按钮、打哪个地址"。
   */
  it("导出 Excel：打 /finance/vouchers/export.xlsx 并触发下载（后端一行一条分录、带摘要）", async () => {
    const downloads: Array<{ download: string; href: string }> = [];
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:http://localhost/vouchers"), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ download: this.getAttribute("download") ?? "", href: this.getAttribute("href") ?? "" });
    });
    try {
      const calls = stubFinance({ cashFlowEntries: [flowEntry()], vouchers: [voucher()] }, voucherDetail);
      await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");

      fireEvent.click(screen.getByTestId("voucher-export"));

      await waitFor(() => expect(callsTo(calls, "/api/v1/finance/vouchers/export.xlsx")).toHaveLength(1));
      await waitFor(() => expect(downloads).toHaveLength(1));
      // 文件名优先取后端 Content-Disposition 里的那个（含生成时间与行数）
      expect(downloads[0].download).toContain("记账凭证");
      await waitFor(() => expect(screen.getByTestId("toast-item")).toHaveTextContent("已导出 1 张记账凭证"));
    } finally {
      click.mockRestore();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("一张凭证都没有时「导出 Excel」是灰的（不导一个空文件出来）", async () => {
    stubFinance({ cashFlowEntries: [], vouchers: [] });
    await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");

    expect(screen.getByTestId("voucher-export")).toBeDisabled();
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

  /**
   * 2026-10-16（用户报障）：「如果该笔应付选择的是备用金付款，该笔凭证的会计科目没法正常显示」——
   * 凭证纸上写着「借 应付账款 / 贷 库存现金」，她要的是「借 库存现金（备用金）/ 贷 银行存款」。
   *
   * 新口径已经不再挂账（voucher.service.ts 的 createAccrual）并把借方改成条目自己的科目，
   * 但**已经生成出来的凭证不会自己变** —— 这一组用例盯的是那个一次性纠正入口：
   * 先 GET 预览（要删几张、红冲几张、重算几张），财务看清了再 POST 执行。
   */
  describe("资金搬运（备用金取现）凭证纠正", () => {
    const preview = {
      payables: 2, accruals: 2, accruals_draft: 1, accruals_posted: 1,
      flows: 1, flows_without_voucher: 0, vouchers_draft: 1, vouchers_posted: 0, vouchers_reversed: 0, skipped: [],
      targets: [{ entry_no: "CF-20261016-0001", cash_flow_entry_id: "cf-1", payable_nos: ["APO-0001"], subject_label: "库存现金（备用金）", voucher_no: "记-2026-10-0002", voucher_status: "draft" }],
    };

    it("点按钮先 GET 预览：写清要删 / 红冲 / 重算几张，执行前一个字节都不写", async () => {
      const calls = stubFinance({ cashFlowEntries: [flowEntry()], vouchers: [voucher()] }, (url, call) =>
        url.endsWith("/finance/vouchers/cash-transfer-repair")
          ? (call.method === "POST" ? apiOk({ ...preview, rebuilt: 1, reopened: 0, without_voucher: 0 }) : apiOk(preview))
          : undefined);
      await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");

      fireEvent.click(screen.getByTestId("voucher-repair-cash-transfer"));
      const dialog = await screen.findByTestId("voucher-repair-dialog");
      const counts = await within(dialog).findByTestId("voucher-repair-counts");
      expect(counts).toHaveTextContent("挂账凭证 2 张：草稿 1 张会删除；已过账 1 张会红冲");
      expect(counts).toHaveTextContent("草稿 1 张直接按新口径重算");
      expect(within(dialog).getByText("CF-20261016-0001")).toBeInTheDocument();
      expect(within(dialog).getByText("库存现金（备用金）")).toBeInTheDocument();
      expect(postsTo(calls, "/finance/vouchers/cash-transfer-repair")).toHaveLength(0);
      expect(calls.filter((call) => call.url.endsWith("/finance/vouchers/cash-transfer-repair") && call.method === "GET")).toHaveLength(1);

      fireEvent.click(within(dialog).getByTestId("voucher-repair-apply"));
      await waitFor(() => expect(postsTo(calls, "/api/v1/finance/vouchers/cash-transfer-repair")).toHaveLength(1));
      await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已纠正"))).toBe(true));
      await waitFor(() => expect(screen.queryByTestId("voucher-repair-dialog")).toBeNull());
    });

    it("没有需要纠正的应付时直说，执行按钮点不动（不摆一个点了必然报错的按钮）", async () => {
      stubFinance({ cashFlowEntries: [flowEntry()], vouchers: [voucher()] }, (url) =>
        url.endsWith("/finance/vouchers/cash-transfer-repair")
          ? apiOk({ ...preview, payables: 0, accruals: 0, accruals_draft: 0, accruals_posted: 0, flows: 0, vouchers_draft: 0, vouchers_posted: 0, vouchers_reversed: 0, targets: [] })
          : undefined);
      await open(<VoucherWorkspace testId="page-finance-voucher" />, "page-finance-voucher");

      fireEvent.click(screen.getByTestId("voucher-repair-cash-transfer"));
      const dialog = await screen.findByTestId("voucher-repair-dialog");
      expect(await within(dialog).findByTestId("voucher-repair-empty")).toBeInTheDocument();
      expect(within(dialog).getByTestId("voucher-repair-apply")).toBeDisabled();
    });
  });
});

// ------------------------------------------------------------------ 对账与确认合并 + 收款单（2026-09-20）

/**
 * 用户 2026-09-20 两条：
 *   ①「应收管理中，应收对账和确认应收我们合并在一起。合并到一个视图里。但是仍然需要用户进行
 *     先创建对账，再确认的这两个动作。同样的，应付管理中，应付对账和确认应付也要合并在一起。」
 *   ②「应收，应付。支持勾选多选条目，进行收束集中收款付款。并提供付款单的编辑和导出。
 *     同理，收款单的编辑和导出。」
 *
 * ① 的两条都要钉住：**一个视图**（不用再切页签）与**两个动作都还在**（对账归对账、确认归确认）——
 * 只做前者就是把两步并成一步，那是账务上的越权。
 * ② 的收款单是付款单的**镜像**：预填请求勾的是应收来源（不是应付条目）、对方是客户、
 * 贷方一条一条应收、借方一行银行存款；入口与付款单完全对称（行内 + 勾选批量）。
 */
describe("应收管理：对账与确认合并成一个视图 + 收款单", () => {
  const receiptSlipDraft = {
    kind: "receipt", currency: "USD", slip_no: "SK-202609-001", slip_date: "2026-09-20", slip_method: "银行转账", counterparty_name: "香港迪礼",
    our_bank_name: "中国银行", our_bank_account: "7624", counterparty_bank_name: "招商银行", counterparty_bank_account: "6225", attachment_count: 1, remark: "", maker: "小叶",
    lines: [
      { summary: "收香港迪礼折叠伞款", general_subject: "主营业务收入", detail_subject: "", debit: "", credit: "120", remark: "" },
      { summary: "收香港迪礼款项合计", general_subject: "银行存款", detail_subject: "中国银行", debit: "120", credit: "", remark: "" },
    ],
  };
  /** 预填的第二张：另一个客户（一次集中收款拆出多张的常态）。 */
  const secondReceiptDraft = {
    kind: "receipt", currency: "USD", slip_no: "SK-202609-002", slip_date: "2026-09-20", slip_method: "银行转账", counterparty_name: "联晟",
    our_bank_name: "中国银行", our_bank_account: "7624", counterparty_bank_name: "招商银行", counterparty_bank_account: "6225", attachment_count: 1, remark: "", maker: "小叶",
    lines: [
      { summary: "收联晟直骨伞款", general_subject: "主营业务收入", detail_subject: "", debit: "", credit: "80", remark: "" },
      { summary: "收联晟款项合计", general_subject: "银行存款", detail_subject: "中国银行", debit: "80", credit: "", remark: "" },
    ],
  };
  const xlsxResponse = () => new Response(new Uint8Array([0x50, 0x4b]), { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  /** 下载三件套：只关心 URL 与文件名（与 payable-page.test.tsx 同一套）。 */
  let anchors: Array<{ download: string; href: string }> = [];
  const captureDownloads = () => {
    anchors = [];
    Object.assign(URL, { createObjectURL: vi.fn(() => `blob:http://localhost/${anchors.length + 1}`), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push({ download: this.getAttribute("download") ?? "", href: this.getAttribute("href") ?? "" });
    });
  };
  const slipStub = (data: Partial<Record<keyof typeof EP, unknown>> = {}, drafts: unknown = [receiptSlipDraft]) => stubFinance(data, (url, call) => {
    if (call.method !== "POST") return undefined;
    if (url.endsWith("/finance/receipt-slips/draft")) return drafts instanceof Response ? drafts : apiOk({ slips: drafts });
    if (url.endsWith("/finance/receipt-slips.xlsx")) return xlsxResponse();
    if (url.endsWith("/api/v1/finance/receipt-slips/batch.xlsx")) return xlsxResponse();
    return undefined;
  });
  /** 已对平、范围里还有一条草稿应收的对账单（列表接口给 flow）。 */
  const confirmableReconciliation = () => receivableReconciliation({
    status: "matched",
    flow: { entry_count: 1, draft_count: 1, draft_amount: "120.0000", can_confirm_receivables: true, order_nos: ["SO-1"], product_names: ["折叠伞"], product_specifications: ["黑胶"] },
  });

  it("合并页签里三张表同时在场，两个动作各自还在；旧的 ?tab=confirmed 也落在同一处", async () => {
    stubFinance({ receivables: [source()], reconciliations: [confirmableReconciliation()] });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    expect(screen.getByTestId("receivable-pending-entries")).toBeInTheDocument();
    expect(screen.getByTestId("receivable-reconciliations")).toBeInTheDocument();
    expect(screen.getByText("确认应收", { selector: "h2" })).toBeInTheDocument();
    expect(screen.getByTestId("receivable-batch-bar")).toBeInTheDocument();
    // 动作一：创建对账；动作二：按对账单确认 + 勾选批量确认
    expect(screen.getAllByRole("button", { name: "创建对账" }).length).toBeGreaterThan(0);
    expect(screen.getByTestId("reconciliation-confirm-recon-1")).toBeInTheDocument();
    expect(screen.getByTestId("receivable-batch-confirm")).toBeInTheDocument();
    // 合并之后「确认应收」不再是独立页签
    expect(screen.queryByTestId("finance-tab-confirmed")).toBeNull();
  });

  it("行内「收款单」→ 按这条应收预填 → 改金额 / 加行 / 写收款备注 → 提交出的就是改过的那张", async () => {
    captureDownloads();
    const calls = slipStub({ receivables: [source({ status: "confirmed" })] });
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");

    // 收款情况默认「未收」：已确认＝挂账（钱还没收到），所以这条就在默认视图里
    fireEvent.click(screen.getByTestId("receivable-slip-rec-1"));
    const editor = await screen.findByTestId("receipt-slip-editor");
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receipt-slips/draft")).toHaveLength(1));
    // 勾的是**应收来源**（不是 payable_entry_ids）：传错字段名会变成「勾了却查不到条目」
    expect(bodyOf(callsTo(calls, "/api/v1/finance/receipt-slips/draft")[0])).toEqual({ receivable_source_ids: ["rec-1"] });
    await waitFor(() => expect((within(editor).getByTestId("receipt-slip-editor-counterparty") as HTMLInputElement).value).toBe("香港迪礼"));
    expect(within(editor).getByTestId("receipt-slip-editor-totals")).toHaveTextContent("贷方合计 120");

    // 「本次实收 100」：改贷方行 + 自己加一行手续费，让借贷仍然相等
    setValue("receipt-slip-editor-credit-0", "98");
    await userEvent.click(within(editor).getByTestId("receipt-slip-editor-add"));
    setValue("receipt-slip-editor-summary-2", "银行手续费");
    setValue("receipt-slip-editor-general-2", "财务费用");
    setValue("receipt-slip-editor-credit-2", "2");
    setValue("receipt-slip-editor-debit-1", "100");
    setValue("receipt-slip-editor-remark", "本次实收 100（扣手续费 2）");
    await waitFor(() => expect(screen.queryByTestId("receipt-slip-editor-blockers")).toBeNull());

    fireEvent.click(screen.getByTestId("receipt-slip-editor-export"));
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receipt-slips.xlsx")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/api/v1/finance/receipt-slips.xlsx")[0]);
    expect(body).toMatchObject({ kind: "receipt", slip_no: "SK-202609-001", counterparty_name: "香港迪礼", remark: "本次实收 100（扣手续费 2）" });
    expect((body.lines as unknown[]).length).toBe(3);
    expect(anchors[0].download).toBe("迪礼收款单-SK-202609-001.xlsx");
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已导出收款单 SK-202609-001"))).toBe(true));
  });

  it("勾选多条跨两个客户 → 收款单**队列**（一次集中收款出多张），预填请求带全部应收 id", async () => {
    const calls = slipStub({ receivables: [source(), source({ id: "rec-2", sourceNo: "AR-002", customer_name: "联晟" })] }, [receiptSlipDraft, secondReceiptDraft]);
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");

    await userEvent.click(screen.getByTestId("receivable-select-all"));
    await userEvent.click(screen.getByTestId("receivable-slip-batch"));

    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receipt-slips/draft")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, "/api/v1/finance/receipt-slips/draft")[0])).toEqual({ receivable_source_ids: ["rec-1", "rec-2"] });
    const editor = await screen.findByTestId("receipt-slip-editor");
    expect(await within(editor).findByTestId("receipt-slip-editor-queue")).toBeVisible();
    expect(within(editor).getByTestId("receipt-slip-editor-queue-0")).toHaveTextContent("1. 香港迪礼（USD） 合计 120");
    expect(within(editor).getByTestId("receipt-slip-editor-queue-1")).toHaveTextContent("2. 联晟（USD） 合计 80");
  });

  it("收款侧也有「全部导出」（一个工作簿拿全）与「确认这 N 条（收款）」：收束收款与付款完全对称", async () => {
    captureDownloads();
    const calls = stubFinance(
      { receivables: [source(), source({ id: "rec-2", sourceNo: "AR-002", customer_name: "联晟" })] },
      (url, call) => {
        if (call.method !== "POST") return undefined;
        if (url.endsWith("/finance/receipt-slips/draft")) return apiOk({ slips: [receiptSlipDraft, secondReceiptDraft] });
        if (url.endsWith("/api/v1/finance/receipt-slips/batch.xlsx")) return xlsxResponse();
        if (url.endsWith("/finance/receivable-sources/batch-confirm")) return apiOk({ confirmed_count: 2, skipped_count: 0, amounts: [{ currency: "USD", amount: "200.0000" }], bank_missing: false });
        return undefined;
      },
    );
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");
    await userEvent.click(screen.getByTestId("receivable-select-all"));
    await userEvent.click(screen.getByTestId("receivable-slip-batch"));
    const editor = await screen.findByTestId("receipt-slip-editor");
    await within(editor).findByTestId("receipt-slip-editor-queue");

    // 这一批两条都还是草稿（钱还没进来）→ 底部给出「确认这 2 条（收款）」的出路
    const confirm = within(editor).getByTestId("receipt-slip-editor-confirm-pending");
    expect(confirm).toHaveTextContent("确认这 2 条（收款）");

    await userEvent.click(within(editor).getByTestId("receipt-slip-editor-export-all"));
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/receipt-slips/batch.xlsx")).toHaveLength(1));
    const body = bodyOf(callsTo(calls, "/api/v1/finance/receipt-slips/batch.xlsx")[0]) as { slips: Array<Record<string, unknown>> };
    expect(body.slips.map((slip) => slip.counterparty_name)).toEqual(["香港迪礼", "联晟"]);
    expect(anchors[0].download).toBe("迪礼收款单-2张.xlsx");
  });

  it("预填失败时弹窗仍然打开并把原因写出来，不让用户以为按钮坏了", async () => {
    slipStub({ receivables: [source({ status: "confirmed" })] }, apiErr(422, "RECEIPT_SLIP_ENTRY_NOT_FOUND", "勾选的应收条目里有不存在或已删除的，请刷新后重试"));
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");

    // 已确认＝挂账（钱还没收到），默认「未收」档里就有这条，不用切档
    fireEvent.click(screen.getByTestId("receivable-slip-rec-1"));
    const error = await screen.findByTestId("receipt-slip-editor-draft-error");
    expect(error).toHaveTextContent("勾选的应收条目里有不存在或已删除的，请刷新后重试");
    expect(screen.getByTestId("receipt-slip-editor-export")).toBeDisabled();
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

// ------------------------------------------------------------------ 应收：一个搜索框管本页所有表（2026-09-20）

/**
 * 用户 2026-09-20 第 7 条：「应收管理，应付管理全部表单可以加个查询，现在单少还可以查，多的时候就不好找了」。
 *
 * 应收侧的缺口比应付侧大：搜索框原来只画在「成品出库条目」那一段里，而它一直是「确认应收」页的
 * **实际**筛选器（`matchedSources` 就吃它）—— 用户切到确认页只能看到一个来路不明的关键字在生效，
 * 却找不到输入框；「应收对账」页则连一个筛选器都没有。
 */
describe("应收管理：一个搜索框管本页所有表", () => {
  it("应收对账页有搜索框，且同时过滤「待创建对账」与「应收对账单」两张表", async () => {
    stubFinance({
      receivables: [source(), source({ id: "rec-9", sourceNo: "AR-009", orderNo: "SO-9", customer_name: "联晟", product_name: "直骨伞" })],
      reconciliations: [
        receivableReconciliation(),
        receivableReconciliation({
          id: "recon-9", reconciliationNo: "REC-009", customer: { id: "customer-9", name: "联晟", customerCode: "C009" },
          flow: { entry_count: 1, draft_count: 1, draft_amount: "50.0000", can_confirm_receivables: false, order_nos: ["SO-9"], product_names: ["直骨伞"], product_specifications: ["银胶"] },
        }),
      ],
    });
    await open(<ReceivableWorkspace tab="reconciliations" testId="page-finance-receivable" />, "page-finance-receivable");

    // 这个页签原来**根本没有**筛选条（标题下方直接就是两张表）
    expect(screen.getByTestId("receivable-search")).toBeInTheDocument();
    // 待创建对账 2 行 + 应收对账单 2 行（合并之后这一页还有「确认应收」那张台账，
    // 所以按表定位，不数全页行数）
    const pending = within(screen.getByTestId("receivable-pending-entries"));
    const reconciliations = within(screen.getByTestId("receivable-reconciliations"));
    expect(pending.getAllByTestId("data-table-row")).toHaveLength(2);
    expect(reconciliations.getAllByTestId("data-table-row")).toHaveLength(2);

    setValue("receivable-search", "REC-009");

    // 待创建对账那两行看的是单据号/客户/产品，对账单号不在其中 → 全部被筛掉；对账单只剩 REC-009
    expect(pending.queryAllByTestId("data-table-row")).toHaveLength(0);
    expect(reconciliations.getAllByTestId("data-table-row")).toHaveLength(1);
    expect(reconciliations.getByText("REC-009")).toBeVisible();
    expect(screen.queryByText("REC-001")).toBeNull();
    // 面板上的条数也要跟着搜索走，否则「共 2 张」与表里 1 行对不上
    expect(screen.getByText(/共 1 张/)).toBeVisible();
  });

  it("「确认应收」页也能直接搜（原来那个关键字只能在成品出库条目页输入）", async () => {
    stubFinance({ receivables: [source(), source({ id: "rec-9", sourceNo: "AR-009", orderNo: "SO-9", customer_name: "联晟" })] });
    await open(<ReceivableWorkspace tab="confirmed" testId="page-finance-receivable" />, "page-finance-receivable");

    expect(screen.getByTestId("receivable-search")).toBeInTheDocument();
    // 合并之后 `tab="confirmed"` 落在「应收对账与确认」上：同一页里也有「待创建对账」那张表，
    // 所以把范围收在「确认应收」这张台账里数行数。
    const ledger = within(screen.getByText("确认应收", { selector: "h2" }).closest("section") as HTMLElement);
    expect(ledger.getAllByTestId("data-table-row")).toHaveLength(2);
    setValue("receivable-search", "AR-009");
    expect(ledger.getAllByTestId("data-table-row")).toHaveLength(1);
    expect(ledger.getByText("AR-009")).toBeVisible();
    setValue("receivable-search", "根本不存在的单号");
    expect(screen.queryAllByTestId("data-table-row")).toHaveLength(0);
  });

  it("关键字也覆盖产品与规格（成品出库条目页原来只搜到产品名）", async () => {
    stubFinance({ receivables: [source(), source({ id: "rec-9", sourceNo: "AR-009", product_name: "直骨伞", product_specification: "银胶" })] });
    await open(<ReceivableWorkspace tab="outbound-entries" testId="page-finance-receivable" />, "page-finance-receivable");
    setValue("receivable-search", "银胶");
    expect(screen.getAllByTestId("data-table-row")).toHaveLength(1);
    expect(screen.getByText("AR-009")).toBeVisible();
  });
});