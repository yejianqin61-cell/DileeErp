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
  cashFlowItems: "/api/v1/dictionaries/cash_flow_item/items",
} as const;

type Handler = (url: string, call: StubbedCall) => Response | undefined | Promise<Response | undefined>;
type Data = Partial<Record<"sources" | "outsource" | "entries" | "payments" | "reconciliations" | "suppliers" | "orders" | "banks" | "cashFlowItems" | "createdEntry", unknown>>;

function stubPayable(data: Data = {}, extra?: Handler) {
  return stubApi(async (url, call) => {
    const injected = await extra?.(url, call);
    if (injected) return injected;
    if (url.startsWith(EP.outsource)) return apiOk(data.outsource ?? []);
    if (url.startsWith(EP.sources)) return apiOk(data.sources ?? []);
    // 接收应付：真实后端返回**新建或复用的那张应付条目**（响应体决定提示文案），这里照实回一条。
    if (call.method === "POST" && url.startsWith(`${EP.entries}/from-source`)) return apiOk(data.createdEntry ?? { ...draftEntry, id: "entry-new", payableNo: "AP-NEW" });
    if (url.startsWith(EP.entries)) return apiOk(data.entries ?? []);
    if (url.startsWith(EP.payments)) return apiOk(data.payments ?? []);
    if (url.startsWith(EP.reconciliations)) return call.method === "GET" ? apiOk(data.reconciliations ?? []) : apiOk({ confirmed_count: 2, confirmed_amount: "800.0000", skipped_count: 0 });
    if (url.startsWith(EP.suppliers)) return apiOk(data.suppliers ?? []);
    if (url.startsWith(EP.orders)) return apiOk(data.orders ?? []);
    if (url.startsWith(EP.banks)) return apiOk(data.banks ?? []);
    if (url.startsWith(EP.currencies)) return apiOk([]);
    // 收支项目字典也要回**数组**：付款页加载时就会拉它，回对象会让 cashFlowItems.filter 直接抛错。
    if (url.startsWith(EP.cashFlowItems)) return apiOk(data.cashFlowItems ?? []);
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
const supplierPayment = {
  id: "sp-1", paymentNo: "PY-001", supplierId: "supplier-1", orderNo: "SO-1", paymentDate: "2026-09-06T00:00:00.000Z",
  amount: "500.0000", currency: "CNY", paymentMethod: "银行转账", bankReference: null, payeeName: null,
  status: "draft", remark: null, supplier_name: "晋江大田", allocated_amount: "0.0000", allocations: [], bank: null,
};

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
    expect(screen.getByTestId("payable-covered-drafts")).toHaveTextContent("另有 1 条草稿已纳入对账单、不在此重复对账：AP-009（APREC-001，可在对账单行内一键确认）");
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

  it("对平且有草稿时行内「确认 N 条应付」→ 弹窗问清支付银行/收支项目后 POST confirm-payables 并提示实际条数", async () => {
    const calls = stubPayable({ reconciliations: [matchedReconciliation] });
    await openPayable("reconciliations");
    await userEvent.click(screen.getByTestId("reconciliation-confirm-recon-1"));
    // 确认应付现在会同时把钱记进账，所以先弹「确认应付：<对账单号>」问清账户与项目。
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应付：APREC-001")).toBeVisible();
    expect(screen.getByTestId("action-field-bank_id")).toBeInTheDocument();
    expect(screen.getByTestId("action-field-cash_flow_item_id")).toBeInTheDocument();
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
 * 2026-09（应付侧与应收侧镜像的新能力）：收支项目建单即持久化 + 确认应付要真的记账。
 *
 * 钉住**请求体**的理由与应收侧相同：建单时选的项目必须发出去，否则单据上只有后端猜的那个；
 * 确认应付不再是无 body 直接打 —— 它现在同时写一笔支出流水，必须先问清支付银行与收支项目，
 * 且后端回 `bank_missing` 时要给「钱记进流水了、但没进任何账户」的警告，而不是一句成功。
 */
describe("应付管理：收支项目与确认应付入账", () => {
  const travelItem = { id: "item-travel", key: "差旅费", label: "差旅费", isActive: true };
  const bank = { id: "bank-1", bankCode: "B001", bankName: "农业银行", accountName: "迪礼公司", accountNumber: "5706", currency: "CNY", isActive: true, swiftCode: null, remark: null };
  const confirmPath = "/finance/supplier-payable-reconciliations/recon-1/confirm-payables";

  it("创建对账把选中的收支项目随 POST 发出去", async () => {
    const calls = stubPayable({ entries: [draftEntry], reconciliations: [], suppliers: [{ id: "supplier-1", name: "晋江大田", supplierCode: "S-001" }], cashFlowItems: [travelItem] });
    await openPayable("reconciliations");
    await userEvent.click(screen.getByRole("button", { name: "创建对账" }));
    setValue("action-field-external_balance", "800");
    await pickOption("action-field-cash_flow_item_id", /差旅费/);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, EP.reconciliations)).toHaveLength(1));
    expect(bodyOf(postsTo(calls, EP.reconciliations)[0])).toMatchObject({ cash_flow_item_id: "item-travel" });
  });

  it("登记付款把选中的收支项目随建单 POST 发出去", async () => {
    const calls = stubPayable({ entries: [confirmedEntry], cashFlowItems: [travelItem] });
    await openPayable("confirmed");
    await userEvent.click(screen.getByRole("button", { name: "登记付款" }));
    await pickOption("action-field-cash_flow_item_id", /差旅费/);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, EP.payments)).toHaveLength(1));
    expect(bodyOf(postsTo(calls, EP.payments)[0])).toMatchObject({ cash_flow_item_id: "item-travel" });
  });

  it("编辑付款草稿：默认带出单据上的收支项目（不会清掉），选「不指定收支项目」才送 null", async () => {
    const calls = stubPayable({ payments: [{ ...supplierPayment, cashFlowItemId: "item-travel" }], cashFlowItems: [travelItem] });
    await openPayable("confirmed");

    // 只改金额、不动收支项目：PATCH 里仍是单据上原来的项目，没有被抹成 null。
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    setValue("action-field-amount", "480");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, `${EP.payments}/sp-1`)).toHaveLength(1));
    const first = callsTo(calls, `${EP.payments}/sp-1`)[0];
    expect(first.method).toBe("PATCH");
    expect(bodyOf(first).cash_flow_item_id).toBe("item-travel");

    // 明确清空：哨兵值翻译成 null，后端才按「清空」处理。
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await pickOption("action-field-cash_flow_item_id", /不指定收支项目/);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, `${EP.payments}/sp-1`)).toHaveLength(2));
    expect(bodyOf(callsTo(calls, `${EP.payments}/sp-1`)[1]).cash_flow_item_id).toBeNull();
  });

  /**
   * 逐条确认应付（行内按钮）：与「确认 N 条应付」（对账级）同一件事的另一条入口，
   * 用户要求「一旦确认应付，金额就要转出对应的账户」——所以同样要收集支付银行 + 收支项目，
   * 并在 `bank_missing` 时给出警告。
   */
  it("逐条确认应付：行内按钮打开弹窗，提交 { bank_id, cash_flow_item_id }", async () => {
    const calls = stubPayable(
      { entries: [draftEntry], banks: [bank], cashFlowItems: [travelItem] },
      (url, call) => (call.method === "POST" && url.endsWith("/finance/payable-entries/entry-1/confirm") ? apiOk({ ...draftEntry, cash_flow_entry_id: "cf-2", bank_missing: false }) : undefined),
    );
    await openPayable("confirmed");
    await userEvent.click(screen.getByRole("button", { name: "确认应付" }));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应付：AP-001")).toBeVisible();
    expect(within(dialog).getByText(/把该金额记入下面选定的银行账户/)).toBeVisible();
    await pickOption("action-field-bank_id", /农业银行/);
    await pickOption("action-field-cash_flow_item_id", /差旅费/);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, "/finance/payable-entries/entry-1/confirm")).toHaveLength(1));
    expect(bodyOf(postsTo(calls, "/finance/payable-entries/entry-1/confirm")[0])).toEqual({ bank_id: "bank-1", cash_flow_item_id: "item-travel" });
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

  it("确认应付先弹窗问清支付银行与收支项目，提交后按选定值记账", async () => {
    const calls = stubPayable({ reconciliations: [matchedReconciliation], banks: [bank], cashFlowItems: [travelItem] });
    await openPayable("reconciliations");
    await userEvent.click(screen.getByTestId("reconciliation-confirm-recon-1"));

    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByText("确认应付：APREC-001")).toBeVisible();
    // 将要确认的条数与金额写在 info 行里（金额要进账，点之前必须看得见）
    expect(within(dialog).getByText(/2 条草稿应付（合计 800\.0000 CNY）/)).toBeVisible();

    await pickOption("action-field-bank_id", /农业银行/);
    await pickOption("action-field-cash_flow_item_id", /差旅费/);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(postsTo(calls, confirmPath)).toHaveLength(1));
    // 请求体就是支付银行 + 收支项目这两项（确认金额由后端按范围内的草稿算）
    expect(bodyOf(postsTo(calls, confirmPath)[0])).toEqual({ bank_id: "bank-1", cash_flow_item_id: "item-travel" });
  });

  it("确认应付没指定银行时给出「钱记了但没进任何账户」的警告，而不是一句成功", async () => {
    const calls = stubPayable(
      { reconciliations: [matchedReconciliation] },
      (url, call) => (call.method === "POST" && url.includes("/confirm-payables")
        ? apiOk({ reconciliation_id: "recon-1", status: "matched", confirmed_count: 2, confirmed_amount: "800.0000", currency: "CNY", bank_id: null, cash_flow_item_id: null, cash_flow_entry_id: "cf-7", bank_missing: true, skipped_count: 0 })
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
    expect(screen.getByTestId("action-field-cash_flow_item_id")).toBeInTheDocument();
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

  it("来源已生成应付单时不再显示接收按钮，而是显示那张应付单与状态", async () => {
    stubPayable({ sources: [{ ...inboundSource, status: "received", payable_entry: { id: "entry-1", payableNo: "AP-001", status: "confirmed" } }] });
    await openPayable("raw-inbound-entries");
    expect(screen.queryByRole("button", { name: "接收应付" })).toBeNull();
    expect(screen.getByText("应付单 AP-001（应付已确认）")).toBeVisible();
    // 已有应付单的来源不计入「待接收来源」
    expect(within(screen.getByTestId("payable-flow")).getByTestId("payable-flow-receive")).toHaveTextContent("待接收来源 0 条");
  });

  it("历史数据（来源状态仍是 pending_finance 但已有应付单）也不重复提示接收", async () => {
    stubPayable({ sources: [{ ...inboundSource, payable_entry: { id: "entry-1", payableNo: "AP-001", status: "draft" } }] });
    await openPayable("raw-inbound-entries");
    expect(screen.queryByRole("button", { name: "接收应付" })).toBeNull();
    expect(within(screen.getByTestId("payable-flow")).getByTestId("payable-flow-receive")).toHaveTextContent("待接收来源 0 条");
  });
});

// ------------------------------------------------------------------ 顺手新建供应商（编码自动/手动）

describe("应付管理：新建供应商支持自动生成与手动填写编码", () => {
  /** 行内「登记付款」→ 弹窗里供应商字段旁的「新增类目」→ 新建供应商弹窗。 */
  async function openSupplierDialog() {
    await userEvent.click(screen.getByRole("button", { name: "登记付款" }));
    await userEvent.click(await screen.findByRole("button", { name: "新增类目" }));
  }

  it("编码方式默认自动生成：提交带 code_mode=auto 且不带 supplier_code，并回报生成的编码", async () => {
    const calls = stubPayable({ entries: [confirmedEntry], suppliers: [] }, (url, call) => (call.method === "POST" && url.startsWith(EP.suppliers) ? apiOk({ id: "supplier-9", name: "新供应商", supplierCode: "SUP-0007" }) : undefined));
    await openPayable("confirmed");
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
    const calls = stubPayable({ entries: [confirmedEntry], suppliers: [] });
    await openPayable("confirmed");
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

// ------------------------------------------------------------------ 付款折叠收纳

describe("应付管理：确认应付的「付款」可折叠收纳", () => {
  it("默认展开；点「收起」隐藏付款表，点「展开」恢复，并把选择记在本机", async () => {
    window.localStorage.removeItem("dilee:panel:payable-payments");
    stubPayable({ entries: [confirmedEntry], payments: [supplierPayment] });
    await openPayable("confirmed");

    const toggle = screen.getByTestId("payable-payments-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("收起");
    // 付款表与台账都在（付款单号 PY-001 只在付款表里出现）
    expect(screen.getByText("PY-001")).toBeVisible();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("展开");
    // 收起时连内容一起隐藏（不是只换个箭头），但应付台账仍在
    expect(screen.queryByText("PY-001")).toBeNull();
    expect(screen.getByText("AP-002")).toBeVisible();
    expect(window.localStorage.getItem("dilee:panel:payable-payments")).toBe("collapsed");

    // 展开回去，避免影响同文件里的其他用例（localStorage 在同一个 jsdom 里是共享的）
    await userEvent.click(screen.getByTestId("payable-payments-toggle"));
    expect(screen.getByText("PY-001")).toBeVisible();
    expect(window.localStorage.getItem("dilee:panel:payable-payments")).toBe("expanded");
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
