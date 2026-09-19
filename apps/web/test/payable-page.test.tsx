// 应付管理（/finance/payable?tab=…）的**行为**测试：真实渲染 + 真实点击 + 断言真实请求。
//
// 为什么专门测这条链路：用户反馈「点接受应付没有反应，没有流转到应付对账」「对账创建完也没有流转到
// 确认付款去」——流转的每一步必须看得见、点得动。本文件钉住三件事：
//   1. 四步流转看板给出当前卡在哪一步（数量 + 入口链接）；
//   2. 对账列表用**列表接口**的 flow 摘要显示 订单号 / 采购物料 / 待确认条数，并给出一键「确认 N 条应付」；
//   3. 接收应付与创建对账各自的请求契约与下一步提示。
//
// 数据契约（全部来自组件源码）：
//   GET  /api/v1/payable-sources                                          原料入库应付来源（只展示待接收的）
//   GET  /api/v1/production/outsource-logistics-batches/payable-sources    外加工签收应付来源（只展示待接收的）
//   GET  /api/v1/finance/payable-entries                                  应付条目（草稿/已确认）
//   GET  /api/v1/finance/supplier-payable-reconciliations                 应付对账单（含 flow 摘要）
//   GET  /api/v1/suppliers | /api/v1/sales-orders | /api/v1/finance/banks  下拉主数据
//   POST /api/v1/finance/payable-entries/from-source                     接收应付来源 → 应付草稿
//   POST /api/v1/finance/payable-entries/batch-confirm                   勾选多条草稿一次确认（确认即记账）
//   POST /api/v1/finance/supplier-payable-reconciliations                 创建应付对账
//   POST /api/v1/finance/supplier-payable-reconciliations/:id/confirm-payables  对账后批量确认应付
//
// 2026-09-16（用户要求）：确认应付这边不再有「登记付款 → 过账核销」这第二遍流程
// （确认应付本身就把钱从账户支出去了），改成**勾选 + 批量确认**；两个「待接收」列表里
// 不再出现已接收的来源。后续又加了两件事：已付的条目默认不出现在确认页（可用「付款情况」切出来），
// 以及按确认日期区间筛选 + 导出 Excel。
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PayableWorkspace from "../components/finance/payable-workspace";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 下载三件套（与 finance-report-page.test.tsx 同一套）：只关心 URL 与文件名。 */
let anchorClicks: Array<{ download: string; href: string }> = [];
function captureDownloads() {
  anchorClicks = [];
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:http://localhost/${anchorClicks.length + 1}`),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    anchorClicks.push({ download: this.getAttribute("download") ?? "", href: this.getAttribute("href") ?? "" });
  });
}
afterEach(() => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

const EP = {
  sources: "/api/v1/payable-sources",
  outsource: "/api/v1/production/outsource-logistics-batches/payable-sources",
  entries: "/api/v1/finance/payable-entries",
  batchConfirm: "/api/v1/finance/payable-entries/batch-confirm",
  reconciliations: "/api/v1/finance/supplier-payable-reconciliations",
  suppliers: "/api/v1/suppliers",
  orders: "/api/v1/sales-orders",
  banks: "/api/v1/finance/banks",
  currencies: "/api/v1/dictionaries/currency/items",
  subjects: "/api/v1/finance/accounting-subjects",
} as const;

type Handler = (url: string, call: StubbedCall) => Response | undefined | Promise<Response | undefined>;
type Data = Partial<Record<"sources" | "outsource" | "entries" | "reconciliations" | "suppliers" | "orders" | "banks" | "subjects" | "createdEntry", unknown>>;

function stubPayable(data: Data = {}, extra?: Handler) {
  return stubApi(async (url, call) => {
    const injected = await extra?.(url, call);
    if (injected) return injected;
    if (url.startsWith(EP.outsource)) return apiOk(data.outsource ?? []);
    if (url.startsWith(EP.sources)) return apiOk(data.sources ?? []);
    // 接收应付：真实后端返回**新建或复用的那张应付条目**（响应体决定提示文案），这里照实回一条。
    if (call.method === "POST" && url.startsWith(`${EP.entries}/from-source`)) return apiOk(data.createdEntry ?? { ...draftEntry, id: "entry-new", payableNo: "AP-NEW" });
    if (call.method === "POST" && url.startsWith(EP.batchConfirm)) return apiOk({ confirmed_count: 1, skipped_count: 0, amounts: [{ currency: "CNY", amount: "500.0000" }], bank_missing: false });
    if (url.startsWith(EP.entries)) return apiOk(data.entries ?? []);
    if (url.startsWith(EP.reconciliations)) return call.method === "GET" ? apiOk(data.reconciliations ?? []) : apiOk({ confirmed_count: 2, confirmed_amount: "800.0000", skipped_count: 0 });
    if (url.startsWith(EP.suppliers)) return apiOk(data.suppliers ?? []);
    if (url.startsWith(EP.orders)) return apiOk(data.orders ?? []);
    if (url.startsWith(EP.banks)) return apiOk(data.banks ?? []);
    if (url.startsWith(EP.currencies)) return apiOk([]);
    // 会计科目表也要回**数组**：确认页加载时就会拉它，回对象会让科目下拉的派生直接抛错。
    if (url.startsWith(EP.subjects)) return apiOk(data.subjects ?? []);
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

/** 断言某条 toast 出现过（自动导入也会产生 toast，不能用 getByTestId 单数）。 */
async function expectToast(text: string) {
  await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes(text))).toBe(true));
}
/** 打开 Radix Select 并选中某一项（选项文案即可读值）。 */
async function pickOption(testId: string, optionName: string | RegExp) {
  await userEvent.click(screen.getByTestId(testId));
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

// ------------------------------------------------------------------ 夹具

const inboundSource = {
  id: "source-1", orderNo: "SO-1", quantity: "100", unitPrice: "5", taxRate: null, amount: "500", currency: "CNY",
  status: "pending_finance", createdAt: "2026-09-10T00:00:00.000Z",
  supplier: { id: "supplier-1", name: "晋江大田" }, material_name: "涤纶布", material_code: "M-001",
  rawMaterialInbound: { inboundNo: "IN-001", status: "posted" }, purchase_order_no: "PO-1",
  payable_entry: null,
};
const draftEntry = {
  id: "entry-1", payableNo: "AP-001", orderNo: "SO-1", supplierId: "supplier-1", sourceType: "raw_material_inbound", sourceNoSnapshot: "IN-001",
  quantity: "100", unitPrice: "5", taxRate: null, amount: "500.0000", currency: "CNY", confirmationDate: "2026-09-10T00:00:00.000Z",
  status: "draft", remark: null, createdAt: "2026-09-10T00:00:00.000Z",
  source_no: "IN-001", purchase_order_no: "PO-1", material_name: "涤纶布", material_specification: "150D / 本白",
  supplier_name: "晋江大田", paid_amount: "0", outstanding_amount: "500.0000", reconciliation: null,
};
const confirmedEntry = { ...draftEntry, id: "entry-2", payableNo: "AP-002", status: "confirmed", paid_amount: "500.0000", outstanding_amount: "0.0000" };
/** 已对平、范围内还有 2 条待确认草稿的对账单（flow 来自列表接口）。 */
const matchedReconciliation = {
  id: "recon-1", reconciliationNo: "APREC-001", orderNo: null, supplierId: "supplier-1",
  periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-09-30T00:00:00.000Z",
  payableAmountSnapshot: "800.0000", paymentAmountSnapshot: "0.0000", adjustmentAmountSnapshot: "0.0000", systemBalance: "800.0000",
  externalBalance: "800.0000", difference: "0.0000", currency: "CNY", status: "matched", resolutionRemark: null, remark: null, createdAt: "2026-09-30T00:00:00.000Z",
  supplier: { id: "supplier-1", name: "晋江大田" },
  flow: { entry_count: 2, draft_count: 2, draft_amount: "800.0000", can_confirm_payables: true, order_nos: ["SO-1", "SO-2"], purchase_order_nos: ["PO-1"], material_names: ["涤纶布", "拉链"], material_specifications: ["150D", "5#"] },
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
    expect(flow.getByTestId("payable-flow-pay")).toHaveTextContent("已确认 1 条");
    // 「去对账」「去确认」都指到应付对账子栏目
    expect(within(flow.getByTestId("payable-flow-reconcile")).getByRole("link")).toHaveAttribute("href", "/finance/payable?tab=reconciliations");
    expect(within(flow.getByTestId("payable-flow-pay")).getByRole("link")).toHaveAttribute("href", "/finance/payable?tab=confirmed");
    expect(flow.getByTestId("payable-flow-confirm").className).toContain("flow-step-active");
  });
});

// ------------------------------------------------------------------ 应付对账

describe("应付管理：应付对账", () => {
  // 2026-09-16（用户反馈）：
  //   「某条条目我点击接受应付，为什么没有在待创建对账中看见这条条目」→ 待创建对账改为**逐条**列出；
  //   「对某条条目创建对账单之后，待创建对账就不该继续展示这条条目了」→ 已被覆盖的草稿不再出现，
  //    而是点名说明它进了哪张对账单（不能让它不声不响地消失）。
  it("待创建对账逐条列出未被对账覆盖的草稿，并显示订单号 / 采购单号 / 物料 / 规格型号", async () => {
    stubPayable({ entries: [draftEntry, { ...draftEntry, id: "entry-3", payableNo: "AP-003", orderNo: "SO-2", material_name: "拉链", material_specification: "5#", purchase_order_no: "PO-2" }] });
    await openPayable("reconciliations");
    const table = within(screen.getByTestId("payable-pending-entries"));
    // 两条草稿各占一行：能逐条看到「这条条目」到底在不在
    expect(table.getAllByTestId("data-table-row")).toHaveLength(2);
    expect(table.getByText("AP-001")).toBeVisible();
    expect(table.getByText("AP-003")).toBeVisible();
    expect(table.getAllByText("2026-09")).toHaveLength(2);
    expect(table.getByText("PO-1")).toBeVisible();
    expect(table.getByText("涤纶布")).toBeVisible();
    expect(table.getByText("150D / 本白")).toBeVisible();
    expect(table.getByText("拉链")).toBeVisible();
    expect(table.getByText("5#")).toBeVisible();
    expect(table.getAllByRole("button", { name: "创建对账" })).toHaveLength(2);
    expect(screen.getByTestId("payable-pending-summary")).toHaveTextContent("2 条 / 合计 1000.00");
  });

  it("已被对账单覆盖的草稿不再出现在待创建对账，并点名说明它在哪张对账单里", async () => {
    stubPayable({
      entries: [
        draftEntry,
        { ...draftEntry, id: "entry-9", payableNo: "AP-009", reconciliation: { id: "recon-1", reconciliation_no: "APREC-001", status: "matched", period_start: "2026-09-01T00:00:00.000Z", period_end: "2026-09-30T00:00:00.000Z" } },
      ],
      reconciliations: [matchedReconciliation],
    });
    await openPayable("reconciliations");
    // 待创建对账里只剩没被覆盖的那条
    const pending = within(screen.getByTestId("payable-pending-entries"));
    expect(pending.getByText("AP-001")).toBeVisible();
    expect(pending.queryByText("AP-009")).toBeNull();
    // 被覆盖的那条必须能查到去向（否则用户会以为「点了接收应付没流转过去」）
    expect(screen.getByTestId("payable-covered-drafts")).toHaveTextContent("另有 1 条草稿已纳入对账单、不在此重复对账：AP-009（APREC-001）");
  });

  it("已创建对账单用列表的 flow 摘要显示订单号/采购单号/物料/规格型号/待确认条数", async () => {
    stubPayable({ reconciliations: [matchedReconciliation] });
    await openPayable("reconciliations");
    const row = within(screen.getByTestId("reconciliation-actions-recon-1")).getByText("确认 2 条应付").closest("tr") as HTMLElement;
    expect(within(row).getByText("SO-1、SO-2")).toBeVisible();
    expect(within(row).getByText("PO-1")).toBeVisible();
    expect(within(row).getByText("涤纶布、拉链")).toBeVisible();
    expect(within(row).getByText("150D、5#")).toBeVisible();
    expect(within(row).getByText("2 条 / 800.0000")).toBeVisible();
    expect(within(row).getByText("已对平")).toBeVisible();
  });

  it("双击已创建对账单，弹窗里展示该订单的物料名称与规格型号", async () => {
    const detail = { ...matchedReconciliation, details: { payable_entries: [{ id: "entry-1", payableNo: "AP-001", sourceType: "raw_material_inbound", sourceNoSnapshot: "IN-001", orderNo: "SO-1", quantity: "100", amount: "500.0000", currency: "CNY", status: "draft", confirmationDate: "2026-09-10T00:00:00.000Z", material_name: "涤纶布", material_specification: "150D", unit_name: "米", purchase_order_no: "PO-1" }], draft_entries: [], entry_count: 1, draft_count: 1, draft_amount: "500.0000", can_confirm_payables: true, pending_sources: [] } };
    const calls = stubPayable({ reconciliations: [matchedReconciliation] }, (url) => (url.endsWith("/api/v1/finance/supplier-payable-reconciliations/recon-1") ? apiOk(detail) : undefined));
    await openPayable("reconciliations");
    fireEvent.doubleClick(screen.getAllByTestId("data-table-row")[0]);
    const dialog = await screen.findByTestId("finance-record-detail");
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/supplier-payable-reconciliations/recon-1")).toHaveLength(1));
    // 字段区与「纳入对账的应付条目」明细表都有这两列/字段，所以按「至少出现一次」断言。
    expect((await within(dialog).findAllByText("采购物料")).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("涤纶布").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("规格型号").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("150D").length).toBeGreaterThan(0);
  });

  it("对平且有草稿时行内「确认 N 条应付」→ 弹窗问清支付银行/会计科目后 POST confirm-payables 并提示实际条数", async () => {
    const calls = stubPayable({ reconciliations: [matchedReconciliation] });
    await openPayable("reconciliations");
    await userEvent.click(screen.getByTestId("reconciliation-confirm-recon-1"));
    // 确认应付现在会同时把钱记进账，所以先弹「确认应付：<对账单号>」问清账户与会计科目。
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应付：APREC-001")).toBeVisible();
    expect(screen.getByTestId("action-field-bank_id")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-subject_id")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/finance/supplier-payable-reconciliations/recon-1/confirm-payables")).toHaveLength(1));
    // 未指定银行时显式送 null（后端按「不指定」处理），而不是不带 body
    expect(bodyOf(postsTo(calls, "/finance/supplier-payable-reconciliations/recon-1/confirm-payables")[0])).toEqual({ bank_id: null });
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

/**
 * 2026-09（应付侧与应收侧镜像的新能力）：会计科目建单即持久化 + 确认应付要真的记账。
 *
 * 钉住**请求体**的理由与应收侧相同：建单时选的科目必须发出去，否则单据上只有后端猜的那个；
 * 确认应付不再是无 body 直接打 —— 它现在同时写一笔支出流水，必须先问清支付银行与会计科目，
 * 且后端回 `bank_missing` 时要给「钱记进流水了、但没进任何账户」的警告，而不是一句成功。
 */
describe("应付管理：会计科目与确认应付入账", () => {
  const travelSubject = { id: "subject-travel", category: "损益类", name: "主营业务收入", balanceDirection: "贷", sortOrder: 1, isActive: true };
  const bank = { id: "bank-1", bankCode: "B001", bankName: "农业银行", accountName: "迪礼公司", accountNumber: "5706", currency: "CNY", isActive: true, swiftCode: null, remark: null };
  const confirmPath = "/finance/supplier-payable-reconciliations/recon-1/confirm-payables";

  it("创建对账把选中的会计科目随 POST 发出去", async () => {
    const calls = stubPayable({ entries: [draftEntry], reconciliations: [], suppliers: [{ id: "supplier-1", name: "晋江大田", supplierCode: "S-001" }], subjects: [travelSubject] });
    await openPayable("reconciliations");
    await userEvent.click(screen.getByRole("button", { name: "创建对账" }));
    setValue("action-field-external_balance", "800");
    await pickOption("action-field-subject_id", /损益类 \/ 主营业务收入/);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, EP.reconciliations)).toHaveLength(1));
    expect(bodyOf(postsTo(calls, EP.reconciliations)[0])).toMatchObject({ subject_id: "subject-travel" });
  });

  // 2026-09-16（用户要求「不要又是登记付款又是确认应付，直接就是支持勾选，批量确认」）：
  //   确认应付这边只保留一条路 —— 勾选若干草稿 → 一次确认。整批共用一个账户与一个科目，
  //   请求体里带 ids 列表（后端仍逐条写流水）。
  it("勾选两条草稿 → 批量确认把 ids + 银行 + 会计科目一次发出去，并在确认前显示条数与合计", async () => {
    const second = { ...draftEntry, id: "entry-2", payableNo: "AP-002", amount: "300.0000" };
    const calls = stubPayable(
      { entries: [draftEntry, second], banks: [bank], subjects: [travelSubject] },
      (url, call) => (call.method === "POST" && url.startsWith(EP.batchConfirm)
        ? apiOk({ confirmed_count: 2, skipped_count: 0, amounts: [{ currency: "CNY", amount: "800.0000" }], bank_missing: false })
        : undefined),
    );
    await openPayable("confirmed");
    // 表头全选把可确认的草稿一次勾上
    await userEvent.click(screen.getByTestId("payable-select-all"));
    expect(screen.getByTestId("payable-selected-count")).toHaveTextContent("已选 2 条");
    await userEvent.click(screen.getByTestId("payable-batch-confirm"));

    const dialog = await screen.findByTestId("action-dialog");
    // 确认前先看得见「几条、合计多少」（是数据，不是说明文）
    expect(within(dialog).getByText("确认 2 条草稿应付（合计 800.0000 CNY）")).toBeVisible();
    await pickOption("action-field-bank_id", /农业银行/);
    await pickOption("action-field-subject_id", /损益类 \/ 主营业务收入/);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, EP.batchConfirm)).toHaveLength(1));
    expect(bodyOf(postsTo(calls, EP.batchConfirm)[0])).toEqual({ ids: ["entry-1", "entry-2"], bank_id: "bank-1", subject_id: "subject-travel" });
    await expectToast("已确认 2 条应付（800.0000 CNY）");
  });

  it("勾选只对草稿开放：已确认的条目没有勾选框，没勾选时批量确认按钮不可点", async () => {
    stubPayable({ entries: [draftEntry, confirmedEntry] });
    await openPayable("confirmed");
    expect(screen.getByTestId("payable-select-entry-1")).toBeInTheDocument();
    expect(screen.queryByTestId("payable-select-entry-2")).toBeNull();
    expect(screen.getByTestId("payable-batch-confirm")).toBeDisabled();

    await userEvent.click(screen.getByTestId("payable-select-all"));
    expect(screen.getByTestId("payable-selected-count")).toHaveTextContent("已选 1 条");
    expect(screen.getByTestId("payable-batch-confirm")).toBeEnabled();
  });

  it("批量确认：没指定银行时给警告并点名跳过的条数，而不是一句成功", async () => {
    const calls = stubPayable(
      { entries: [draftEntry] },
      (url, call) => (call.method === "POST" && url.startsWith(EP.batchConfirm)
        ? apiOk({ confirmed_count: 1, skipped_count: 2, amounts: [{ currency: "CNY", amount: "500.0000" }], bank_missing: true })
        : undefined),
    );
    await openPayable("confirmed");
    await userEvent.click(screen.getByTestId("payable-select-entry-1"));
    await userEvent.click(screen.getByTestId("payable-batch-confirm"));
    await screen.findByTestId("action-dialog");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, EP.batchConfirm)).toHaveLength(1));
    // 未指定银行时显式送 null（后端按「不指定」处理），而不是不带这个字段
    expect(bodyOf(postsTo(calls, EP.batchConfirm)[0])).toEqual({ ids: ["entry-1"], bank_id: null });

    await expectToast("未指定支付银行");
    const warning = screen.getAllByTestId("toast-item").find((item) => item.textContent?.includes("未指定支付银行")) as HTMLElement;
    expect(warning).toHaveClass("ui-toast-error");
  });

  /**
   * 逐条确认应付（行内按钮）：与「勾选批量确认」「确认 N 条应付」（对账级）是同一件事的三条入口，
   * 用户要求「一旦确认应付，金额就要转出对应的账户」——所以同样要收集支付银行 + 会计科目，
   * 并在 `bank_missing` 时给出警告。
   */
  it("逐条确认应付：行内按钮打开弹窗，提交 { bank_id, subject_id }", async () => {
    const calls = stubPayable(
      { entries: [draftEntry], banks: [bank], subjects: [travelSubject] },
      (url, call) => (call.method === "POST" && url.endsWith("/finance/payable-entries/entry-1/confirm") ? apiOk({ ...draftEntry, cash_flow_entry_id: "cf-2", bank_missing: false }) : undefined),
    );
    await openPayable("confirmed");
    await userEvent.click(screen.getByRole("button", { name: "确认应付" }));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应付：AP-001")).toBeVisible();
    expect(within(dialog).getByText("确认应付 AP-001：500.0000 CNY")).toBeVisible();
    await pickOption("action-field-bank_id", /农业银行/);
    await pickOption("action-field-subject_id", /损益类 \/ 主营业务收入/);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/finance/payable-entries/entry-1/confirm")).toHaveLength(1));
    expect(bodyOf(postsTo(calls, "/finance/payable-entries/entry-1/confirm")[0])).toEqual({ bank_id: "bank-1", subject_id: "subject-travel" });
  });

  it("逐条确认应付没指定银行时同样给出警告，而不是一句成功", async () => {
    const calls = stubPayable(
      { entries: [draftEntry] },
      (url, call) => (call.method === "POST" && url.endsWith("/finance/payable-entries/entry-1/confirm") ? apiOk({ ...draftEntry, cash_flow_entry_id: "cf-2", bank_missing: true }) : undefined),
    );
    await openPayable("confirmed");
    await userEvent.click(screen.getByRole("button", { name: "确认应付" }));
    await screen.findByTestId("action-dialog");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/finance/payable-entries/entry-1/confirm")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("未指定支付银行"))).toBe(true));
    const warning = screen.getAllByTestId("toast-item").find((item) => item.textContent?.includes("未指定支付银行")) as HTMLElement;
    expect(warning).toHaveClass("ui-toast-error");
    expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("金额已记入所选银行账户"))).toBe(false);
  });

  it("确认应付先弹窗问清支付银行与会计科目，提交后按选定值记账", async () => {
    const calls = stubPayable({ reconciliations: [matchedReconciliation], banks: [bank], subjects: [travelSubject] });
    await openPayable("reconciliations");
    await userEvent.click(screen.getByTestId("reconciliation-confirm-recon-1"));

    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应付：APREC-001")).toBeVisible();
    // 将要确认的条数与金额写在 info 行里（金额要进账，点之前必须看得见）
    expect(within(dialog).getByText(/2 条草稿应付（合计 800\.0000 CNY）/)).toBeVisible();

    await pickOption("action-field-bank_id", /农业银行/);
    await pickOption("action-field-subject_id", /损益类 \/ 主营业务收入/);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, confirmPath)).toHaveLength(1));
    // 请求体就是支付银行 + 会计科目这两项（确认金额由后端按范围内的草稿算）
    expect(bodyOf(postsTo(calls, confirmPath)[0])).toEqual({ bank_id: "bank-1", subject_id: "subject-travel" });
  });

  it("确认应付没指定银行时给出「钱记了但没进任何账户」的警告，而不是一句成功", async () => {
    const calls = stubPayable(
      { reconciliations: [matchedReconciliation] },
      (url, call) => (call.method === "POST" && url.includes("/confirm-payables")
        ? apiOk({ reconciliation_id: "recon-1", status: "matched", confirmed_count: 2, confirmed_amount: "800.0000", currency: "CNY", bank_id: null, subject_id: null, cash_flow_entry_id: "cf-7", bank_missing: true, skipped_count: 0 })
        : undefined),
    );
    await openPayable("reconciliations");
    await userEvent.click(screen.getByTestId("reconciliation-confirm-recon-1"));
    await screen.findByTestId("action-dialog");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, confirmPath)).toHaveLength(1));

    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("未指定支付银行"))).toBe(true));
    const warning = screen.getAllByTestId("toast-item").find((item) => item.textContent?.includes("未指定支付银行")) as HTMLElement;
    expect(warning).toHaveTextContent("已记入收支流水，但不会体现在任何银行账户余额里");
    // 警告必须与「成功」区分得开（错误态样式），并且**不能**同时出现「金额已入账」的成功文案
    expect(warning).toHaveClass("ui-toast-error");
    expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("金额已记入所选银行账户"))).toBe(false);
  });

  it("对账单详情里的「确认应付」打开同一个确认弹窗", async () => {
    const detail = { ...matchedReconciliation, details: { payable_entries: [], draft_entries: [], entry_count: 2, draft_count: 2, draft_amount: "800.0000", can_confirm_payables: true, pending_sources: [] } };
    stubPayable({ reconciliations: [matchedReconciliation] }, (url) => (url.endsWith("/api/v1/finance/supplier-payable-reconciliations/recon-1") ? apiOk(detail) : undefined));
    await openPayable("reconciliations");
    fireEvent.doubleClick(screen.getAllByTestId("data-table-row")[0]);
    const detailDialog = await screen.findByTestId("finance-record-detail");
    fireEvent.click(within(detailDialog).getByRole("button", { name: /确认应付/ }));

    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应付：APREC-001")).toBeVisible();
    expect(screen.getByTestId("action-field-bank_id")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-subject_id")).toBeInTheDocument();
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
    // 新建成功后提示带应付单号，并指明下一步去对账
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("已接收为应付草稿 AP-NEW；下一步：到「应付对账」"))).toBe(true));
  });

  it("重复接收（该来源此前已接收过）如实说明未新建，并指出它现在在哪张对账单里", async () => {
    const calls = stubPayable({
      // 来源列表还没带出应付单关联（例如另一个窗口刚接收过），所以按钮仍在
      sources: [inboundSource],
      // 后端是幂等的：返回的正是台账里已有的那条应付单，而台账里它已被对账单覆盖
      createdEntry: draftEntry,
      entries: [{ ...draftEntry, reconciliation: { id: "recon-1", reconciliation_no: "APREC-001", status: "matched", period_start: "2026-09-01T00:00:00.000Z", period_end: "2026-09-30T00:00:00.000Z" } }],
    });
    await openPayable("raw-inbound-entries");
    fireEvent.click(screen.getByRole("button", { name: "接收应付" }));
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/finance/payable-entries/from-source")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("该来源此前已接收（AP-001 / 应付草稿），未重复创建；已纳入对账单 APREC-001"))).toBe(true));
  });

  it("来源已生成应付单时不再出现在待接收列表里（它已经是应付草稿了）", async () => {
    stubPayable({ sources: [{ ...inboundSource, status: "received", payable_entry: { id: "entry-1", payableNo: "AP-001", status: "confirmed" } }] });
    await openPayable("raw-inbound-entries");
    expect(screen.queryByRole("button", { name: "接收应付" })).toBeNull();
    expect(screen.queryAllByTestId("data-table-row")).toHaveLength(0);
    // 计数里点名「已接收 N 条」，不让它不声不响地消失
    expect(screen.getByText("待接收 0 条 · 已接收 1 条")).toBeVisible();
    expect(within(screen.getByTestId("payable-flow")).getByTestId("payable-flow-receive")).toHaveTextContent("待接收来源 0 条");
  });

  it("历史数据（来源状态仍是 pending_finance 但已有应付单）同样不再出现在待接收列表", async () => {
    stubPayable({ sources: [{ ...inboundSource, payable_entry: { id: "entry-1", payableNo: "AP-001", status: "draft" } }] });
    await openPayable("raw-inbound-entries");
    expect(screen.queryByRole("button", { name: "接收应付" })).toBeNull();
    expect(screen.queryAllByTestId("data-table-row")).toHaveLength(0);
    expect(within(screen.getByTestId("payable-flow")).getByTestId("payable-flow-receive")).toHaveTextContent("待接收来源 0 条");
  });
});

// ------------------------------------------------------------------ 顺手新建供应商（编码自动/手动）

describe("应付管理：新建供应商支持自动生成与手动填写编码", () => {
  /** 「创建对账」弹窗里供应商字段旁的「新增类目」→ 新建供应商弹窗。 */
  async function openSupplierDialog() {
    await userEvent.click(screen.getByRole("button", { name: "创建对账" }));
    await userEvent.click(await screen.findByRole("button", { name: "新增类目" }));
  }

  it("编码方式默认自动生成：提交带 code_mode=auto 且不带 supplier_code，并回报生成的编码", async () => {
    const calls = stubPayable({ entries: [draftEntry], suppliers: [] }, (url, call) => (call.method === "POST" && url.startsWith(EP.suppliers) ? apiOk({ id: "supplier-9", name: "新供应商", supplierCode: "SUP-0007" }) : undefined));
    await openPayable("reconciliations");
    await openSupplierDialog();
    expect(screen.getByTestId("action-field-code_mode")).toHaveTextContent("自动生成");
    setValue("action-field-name", "新供应商");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, EP.suppliers)).toHaveLength(1));
    const body = bodyOf(postsTo(calls, EP.suppliers)[0]);
    expect(body).toMatchObject({ code_mode: "auto", name: "新供应商" });
    expect(body.supplier_code).toBeUndefined();
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("SUP-0007"))).toBe(true));
  });

  it("手动填写模式必须填编码：留空时本地拦下，不发请求；填了才提交", async () => {
    const calls = stubPayable({ entries: [draftEntry], suppliers: [] });
    await openPayable("reconciliations");
    await openSupplierDialog();
    await pickOption("action-field-code_mode", "手动填写");
    setValue("action-field-name", "新供应商");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await expectToast("手动编码模式必须填写供应商编码");
    expect(postsTo(calls, EP.suppliers)).toHaveLength(0);

    setValue("action-field-supplier_code", "SUP-0099");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, EP.suppliers)).toHaveLength(1));
    expect(bodyOf(postsTo(calls, EP.suppliers)[0])).toMatchObject({ code_mode: "manual", supplier_code: "SUP-0099" });
  });
});

// ------------------------------------------------------------------ 确认应付的筛选与导出

/**
 * 用户三条要求：①「如果是已付款的条目就不要出现在确认应付里」；
 * ②「支持按已付未付筛选」；③「支持按时间范围筛选」；外加「要支持导出 excel」。
 *
 * 默认「未付」：这一页是待办清单，已经确认过（钱已经从账户出去）的条目不占位置；
 * 筛选器上按**当前条件**给出各档条数，切档即可看到被隐藏的行。
 */
describe("应付管理：确认应付的付款情况 / 日期筛选与导出", () => {
  /** 取某个面板（section）的作用域，避免同名文本/按钮跨表歧义。 */
  const panelOf = (title: string) => {
    const section = screen.getByRole("heading", { name: title }).closest("section");
    if (!section) throw new Error(`找不到面板：${title}`);
    return within(section as HTMLElement);
  };
  const confirmedEntry = { ...draftEntry, id: "entry-2", payableNo: "AP-002", status: "confirmed", confirmationDate: "2026-09-20T00:00:00.000Z" };

  it("默认只列未付；筛选器按当前条件给条数，切到「已付 / 全部」才显示已确认的条目", async () => {
    stubPayable({ entries: [draftEntry, confirmedEntry] });
    await openPayable("confirmed");
    const table = panelOf("确认应付");
    expect(table.getByText("AP-001")).toBeVisible();
    expect(table.queryByText("AP-002")).toBeNull();
    expect(screen.getByText("共 1 条（未付 1 / 已付 1）")).toBeVisible();

    await pickOption("payable-payment-filter", /已付（1）/);
    expect(table.getByText("AP-002")).toBeVisible();
    expect(table.queryByText("AP-001")).toBeNull();

    await pickOption("payable-payment-filter", /全部（2）/);
    expect(table.getByText("AP-001")).toBeVisible();
    expect(table.getByText("AP-002")).toBeVisible();
  });

  it("按确认日期区间筛选：区间外的条目不出现，且切档计数跟着区间走", async () => {
    stubPayable({ entries: [draftEntry, { ...draftEntry, id: "entry-3", payableNo: "AP-003", confirmationDate: "2026-10-05T00:00:00.000Z" }] });
    await openPayable("confirmed");
    const table = panelOf("确认应付");
    expect(table.getByText("AP-001")).toBeVisible();
    expect(table.getByText("AP-003")).toBeVisible();

    setValue("payable-date-from", "2026-09-01");
    setValue("payable-date-to", "2026-09-30");
    expect(table.getByText("AP-001")).toBeVisible();
    expect(table.queryByText("AP-003")).toBeNull();
    expect(screen.getByText("共 1 条（未付 1 / 已付 0）")).toBeVisible();
  });

  it("导出 Excel：把当前筛选（付款情况 + 日期区间 + 关键字）原样拼进 xlsx 端点并触发下载", async () => {
    captureDownloads();
    const calls = stubPayable({ entries: [draftEntry] });
    await openPayable("confirmed");
    setValue("payable-date-from", "2026-09-01");
    await pickOption("payable-payment-filter", /未付（1）/);

    fireEvent.click(screen.getByTestId("payable-export"));
    await waitFor(() => expect(calls.filter((call) => call.url.includes("payable-entries.xlsx"))).toHaveLength(1));
    const url = calls.find((call) => call.url.includes("payable-entries.xlsx"))!.url;
    expect(url).toContain("/api/v1/finance/payable-entries.xlsx?");
    expect(url).toContain("payment=unpaid");
    expect(url).toContain("from=2026-09-01");
    expect(anchorClicks).toHaveLength(1);
    // 后端给了 Content-Disposition 之外的兜底名：桩里没有响应头，所以用兜底名
    expect(anchorClicks[0].download).toBe("迪礼ERP-应付台账.xlsx");
    await expectToast("已导出 1 条应付");
  });
});

// ------------------------------------------------------------------ 其他应付批量导入

// 用户 2026-09-16：「有一些非原料类的支出，也就是其他应付，现在要支持批量导入这类应付对账条目。
// 我们提供模板，用户填写上传，直接进入应付对账，然后再流转到确认应付。」
describe("应付管理：其他应付批量导入", () => {
  /** 打开导入弹窗（入口在「确认应付」的工具条上，紧挨着「新建其他应付」）。 */
  async function openImport() {
    await openPayable("confirmed");
    await userEvent.click(screen.getByTestId("payable-other-import"));
    return screen.findByTestId("payable-import-dialog");
  }

  it("入口在确认应付页（紧挨「新建其他应付」），弹窗里有模板下载与文件上传", async () => {
    stubPayable({ entries: [draftEntry] });
    const dialog = await openImport();

    expect(within(dialog).getByRole("button", { name: "下载模板" })).toBeVisible();
    expect(within(dialog).getByTestId("payable-import-file")).toBeVisible();
  });

  it("下载模板：拉 import-template.xlsx 并触发下载", async () => {
    captureDownloads();
    const calls = stubPayable({ entries: [draftEntry] }, (url) => (
      url.includes("payable-entries/import-template.xlsx")
        ? new Response(new Uint8Array([0x50, 0x4b]), { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } })
        : undefined
    ));
    await openImport();

    await userEvent.click(screen.getByTestId("payable-import-template"));

    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/finance/payable-entries/import-template.xlsx"))).toBe(true));
    expect(anchorClicks).toHaveLength(1);
    expect(anchorClicks[0].download).toBe("迪礼ERP-其他应付导入模板.xlsx");
  });

  it("上传文件：multipart 打到 import 端点，结果逐行回显（含自动建档的供应商与去处）", async () => {
    const partial = {
      status: "partial", total: 3, imported: 1, successCount: 1, errorCount: 2, headerRow: 1,
      errors: [
        { row: 3, field: "应付金额", reason: "应付金额必须大于 0" },
        { row: 4, reason: "与本文件第 2 行重复（同一供应商、金额、币种、日期与说明）" },
      ],
      missingColumns: [], ignoredColumns: ["摊销月份"], ignoredTrailingRows: 0,
      createdSuppliers: [{ name: "上海房东", supplierCode: "SUP-20260916-0002", rows: 1 }],
      hints: ["导入的是应付草稿：可在【应付对账 → 待创建对账】继续对账，也可直接在【确认应付】勾选批量确认"],
    };
    const calls = stubPayable({ entries: [draftEntry] }, (url, call) => (
      call.method === "POST" && url.endsWith("/finance/payable-entries/import") ? apiOk(partial) : undefined
    ));
    const dialog = await openImport();
    const before = callsTo(calls, EP.entries).filter((call) => call.method === "GET").length;

    const file = new File(["xlsx-bytes"], "其他应付导入.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await userEvent.upload(within(dialog).getByTestId("payable-import-file"), file);

    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.endsWith("/finance/payable-entries/import"))).toHaveLength(1));
    const posted = calls.find((call) => call.method === "POST" && call.url.endsWith("/finance/payable-entries/import"))!;
    // 上传必须走 multipart：body 是 FormData，且 file 字段就是选中的那个文件
    expect(posted.body).toBeInstanceOf(FormData);
    expect((posted.body as FormData).get("file")).toBe(file);

    const result = await screen.findByTestId("payable-import-result");
    expect(result).toHaveTextContent("共 3 行：成功 1 行 / 错误 2 行");
    expect(within(result).getByText("应付金额必须大于 0")).toBeVisible();
    expect(within(result).getByText(/与本文件第 2 行重复/)).toBeVisible();
    expect(within(result).getByText(/摊销月份/)).toBeVisible();
    expect(screen.getByTestId("payable-import-suppliers")).toHaveTextContent("上海房东（SUP-20260916-0002，1 条）");
    expect(within(result).getByRole("link", { name: "去应付对账 →" })).toHaveAttribute("href", "/finance/payable?tab=reconciliations");
    // 导入成功后列表要刷新（新草稿立刻出现在确认应付的未付清单里）
    await waitFor(() => expect(callsTo(calls, EP.entries).filter((call) => call.method === "GET").length).toBeGreaterThan(before));
  });

  it("整批失败（表头不对）时如实显示缺少的列，且不刷新列表", async () => {
    const calls = stubPayable({ entries: [draftEntry] }, (url, call) => (
      call.method === "POST" && url.endsWith("/finance/payable-entries/import")
        ? apiOk({ status: "failed", total: 0, imported: 0, successCount: 0, errorCount: 1, headerRow: -1, errors: [{ row: 0, reason: "缺少必需列：应付金额、费用说明" }], missingColumns: ["应付金额", "费用说明"], ignoredColumns: [], ignoredTrailingRows: 0, createdSuppliers: [], hints: [] })
        : undefined
    ));
    const dialog = await openImport();
    const before = callsTo(calls, EP.entries).filter((call) => call.method === "GET").length;

    await userEvent.upload(within(dialog).getByTestId("payable-import-file"), new File(["x"], "坏文件.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

    const result = await screen.findByTestId("payable-import-result");
    expect(result).toHaveTextContent("缺少必需列：应付金额、费用说明");
    expect(within(result).queryByRole("link", { name: "去应付对账 →" })).toBeNull();
    expect(callsTo(calls, EP.entries).filter((call) => call.method === "GET").length).toBe(before);
  });

  it("服务端拒绝导入时弹出错误，不留半份结果", async () => {
    stubPayable({ entries: [draftEntry] }, (url, call) => (
      call.method === "POST" && url.endsWith("/finance/payable-entries/import") ? apiErr(422, "PAYABLE_IMPORT_INVALID_FILE", "只支持 .xlsx / .xls 文件") : undefined
    ));
    const dialog = await openImport();

    await userEvent.upload(within(dialog).getByTestId("payable-import-file"), new File(["x"], "其他应付.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

    await expectToast("只支持 .xlsx / .xls 文件");
    expect(screen.queryByTestId("payable-import-result")).toBeNull();
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
