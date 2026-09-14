// app/finance/page.tsx 的**行为**测试：真实渲染 + 真实点击 + 断言真实发出的请求。
//
// 取代 apps/web/lib/finance-draft-edit-method.test.mjs（readFileSync + 正则读源码）：
//   那份遗留测试断言的是源码的**书写形式** —— `method: "post" | "patch" = "post"`、
//   `apiPatch(path, body ?? {})`、以及每个编辑入口行尾的 `, "patch") }); }`。
//   它既不能证明"点编辑→保存"真的发出 PATCH（正则匹配的是声明，不是运行结果），
//   也不能证明请求路径与请求体里的值来自用户输入；任何等价重写都会误红。
//   本文件继承它的三条意图，并改成运行时断言：
//     1) 应收 / 收款 / 付款 / 应付四个草稿「编辑」必须发出 PATCH（用 POST 会 404）；
//     2) 过账 / 核销 / 确认 / 回退 / 取消 / 冲销 / 接收应对仍然走 POST（不能被一起改成 PATCH）；
//     3) 每个入口的 URL 指向 /:id 而不是集合根。
//   并且桩会复刻真实 API 的注册形状（草稿编辑只认 PATCH，POST 返回 404），
//   所以一旦回归成 POST，用户看到的"操作失败"会在测试里重现（成功提示不会出现）。
//
// 说明：动作结果是通过 toast 呈现的（notifySuccess / notifyError），因此渲染时一并挂 <Toaster />。
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FinancePage from "../app/finance/page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 页面 useEffect 里 Promise.all 的 11 个 GET + 币种字典 1 个 GET（前缀是 api-client 拼的 /api/v1）。 */
const EP = {
  receivables: "/api/v1/finance/receivable-sources",
  customerPayments: "/api/v1/finance/customer-payments",
  payables: "/api/v1/finance/payable-entries",
  payableSources: "/api/v1/payable-sources",
  outsourceSources: "/api/v1/production/outsource-logistics-batches/payable-sources",
  supplierPayments: "/api/v1/finance/supplier-payments",
  reconciliations: "/api/v1/finance/reconciliations",
  supplierReconciliations: "/api/v1/finance/supplier-payable-reconciliations",
  customers: "/api/v1/customers",
  suppliers: "/api/v1/suppliers",
  salesOrders: "/api/v1/sales-orders",
  // 收款/付款/对账的币种下拉来自可配置字典（lib/currency-options.ts），随首屏一起拉取。
  currencies: "/api/v1/dictionaries/currency/items",
} as const;
const ALL_LISTS = Object.values(EP);

type Handler = (url: string, call: StubbedCall) => Response | undefined;

/**
 * 桩：11 个 GET 各回自己那一份数据（默认空），extra 优先执行，用于注入 403 / 404 等特例。
 * 返回 fetch 调用记录，供 callsTo(...) 断言 method / url / body。
 */
function stubFinance(data: Partial<Record<keyof typeof EP, unknown[]>> = {}, extra?: Handler) {
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
 * POST 到同一个 /:id 会 404。用它做桩，回归成 POST 时页面会真的报错，测试随之变红。
 * 只匹配集合下的单条路径（/:id），不匹配 /:id/confirm、/:id/post 这类动作路径。
 */
const draftEditIsPatchOnly: Handler = (url, call) =>
  /\/finance\/(receivable-sources|customer-payments|supplier-payments|payable-entries)\/[^/]+$/.test(url) && call.method !== "PATCH"
    ? apiErr(404, "NOT_FOUND", `Cannot ${call.method} ${url}`)
    : undefined;

/** 渲染财务页（连带 Toaster：动作结果只经 toast 呈现，页面本身没有动作错误区）。 */
function renderFinance() {
  return render(
    <>
      <FinancePage />
      <Toaster />
    </>
  );
}

/** 渲染并等到数据加载完成（页面根出现）。 */
async function openFinance() {
  renderFinance();
  await screen.findByTestId("page-finance");
}

/** 取某个面板（section）的作用域，避免同名文本/按钮跨表歧义。 */
function panel(title: string) {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (!section) throw new Error(`找不到面板：${title}`);
  return within(section as HTMLElement);
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
/** 直接读 input.value：number/date 输入用 toHaveValue 会走 valueAsNumber，容易误判。 */
const valueOf = (testId: string) => (screen.getByTestId(testId) as HTMLInputElement).value;
/** 日期输入在 jsdom 里按 locale 分段编辑不可靠，直接写入合法日期字符串。 */
const setDate = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

const receivableDraft = { id: "rec-1", sourceNo: "AR-001", orderNo: "SO-1", amount: "120.00", currency: "USD", status: "draft" };
const receivableConfirmed = { id: "rec-2", sourceNo: "AR-002", orderNo: "SO-2", amount: "80.00", currency: "USD", status: "confirmed" };
const customerPaymentDraft = { id: "cp-1", paymentNo: "RC-001", orderNo: "SO-1", amount: "50.00", currency: "USD", status: "draft", paymentDate: "2026-03-05T08:00:00.000Z" };
const customerPaymentPosted = { id: "cp-2", paymentNo: "RC-002", orderNo: "SO-1", amount: "88.00", currency: "USD", status: "posted", paymentDate: "2026-03-06T08:00:00.000Z" };
const supplierPaymentDraft = { id: "sp-2", paymentNo: "FK-002", orderNo: "SO-1", amount: "60.00", currency: "CNY", status: "draft", paymentDate: "2026-03-07T08:00:00.000Z" };
const supplierPaymentPosted = { id: "sp-1", paymentNo: "FK-001", orderNo: "SO-1", amount: "70.00", currency: "CNY", status: "posted", paymentDate: "2026-03-08T08:00:00.000Z" };
const payableDraft = { id: "pe-1", payableNo: "AP-001", orderNo: "SO-1", amount: "300.00", currency: "CNY", status: "draft", sourceType: "purchase_receipt", purchase_order_no: "PO-9", batch_sequence: 2, source_no: "RC-9" };
const payableConfirmed = { id: "pe-2", payableNo: "AP-002", orderNo: "SO-2", amount: "400.00", currency: "CNY", status: "confirmed", sourceType: "raw_material_inbound" };
/** 原料入库来源：后端只给 rawMaterialInbound + snake_case 字段，页面要自己映射成 sourceType/batchSequence/purchaseOrder。 */
const rawMaterialSource = {
  id: "ps-1", orderNo: "SO-1", quantity: "10", amount: "100.00", currency: "CNY", status: "pending_finance", sourceType: "purchase_receipt",
  material_name: "面料A", material_code: "M-1", material_specification: "180g", material_color: "藏青", unit_name: "米",
  rawMaterialInbound: { inboundNo: "IN-1" }, batch_sequence: 3, purchase_order_no: "PO-1", supplier: { name: "供应商甲" },
};
const outsourceSource = {
  id: "ps-2", orderNo: "SO-1", quantity: "5", amount: "60.00", currency: "CNY", status: "received", sourceType: "outsource_receipt",
  outsourceReceipt: { id: "os-12345678" }, batchSequence: 1, purchaseOrder: { purchaseOrderNo: "PO-2" }, supplier: { name: "外协厂乙" },
};
const reconciliationOpen = { id: "re-1", orderNo: "SO-1", status: "open", periodStart: "2026-01-01T00:00:00.000Z", periodEnd: "2026-01-31T00:00:00.000Z", externalBalance: "1000.00", currency: "USD" };
const supplierReconciliationDiff = { id: "sre-1", reconciliationNo: "SR-001", orderNo: "SO-1", purchaseOrder: { purchaseOrderNo: "PO-9" }, status: "difference", systemBalance: "10.00", externalBalance: "12.00", difference: "2.00", currency: "CNY", supplier: { name: "供应商甲" } };

describe("财务页：加载门禁与各区块列表渲染", () => {
  it("加载中只渲染加载态（无页面根、无操作入口）；完成后页面根出现且 11 个数据接口 + 币种字典各被 GET 一次", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls = stubApi(async (url) => {
      if (url.endsWith(EP.receivables)) { await gate; return apiOk([]); }
      return apiOk([]);
    });

    renderFinance();

    expect(screen.getByTestId("loading-state")).toBeVisible();
    expect(screen.queryByTestId("page-finance")).toBeNull();
    // 数据没到之前入口不能存在：否则对话框会把空的客户/订单选项快照进去（历史缺陷成因）
    expect(screen.queryByRole("button", { name: "登记收款" })).toBeNull();

    release();

    expect(await screen.findByTestId("page-finance")).toBeVisible();
    await waitFor(() => expect(calls).toHaveLength(ALL_LISTS.length));
    expect(calls.map((call) => call.url).sort()).toEqual([...ALL_LISTS].sort());
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(screen.queryByTestId("loading-state")).toBeNull();
  });

  it("加载完成后 7 个区块各自按后端数据渲染（含金额币种、日期截断、批次/来源/采购单映射）", async () => {
    stubFinance({
      receivables: [receivableDraft, receivableConfirmed],
      customerPayments: [customerPaymentDraft],
      supplierPayments: [supplierPaymentPosted],
      payables: [payableDraft, payableConfirmed],
      payableSources: [rawMaterialSource],
      outsourceSources: [outsourceSource],
      reconciliations: [reconciliationOpen],
      supplierReconciliations: [supplierReconciliationDiff],
    });
    await openFinance();

    const receivables = panel("应收来源");
    expect(receivables.getByText("AR-001")).toBeVisible();
    expect(receivables.getByText("120.00 USD")).toBeVisible();
    // 状态列渲染的是后端原值（accessorKey 列经 flexRender 后是 React 元素，不走 displayText 中文化）
    expect(receivables.getByText("draft")).toBeVisible();
    expect(receivables.getByText("confirmed")).toBeVisible();
    // 待收款提醒：只统计 draft，并按金额求和（成品出库过账自动生成草稿的业务提示）
    expect(receivables.getByText(/待确认收款 1 笔 \/ 合计 120\.00/)).toBeVisible();

    expect(panel("收款").getByText("RC-001")).toBeVisible();
    expect(panel("收款").getByText("2026-03-05")).toBeVisible();

    const sources = panel("原料入库 / 外加工应付来源");
    // 「原料」列要给出物料名 + 规格/颜色，而不是只有批次号
    expect(sources.getByText("面料A（180g / 藏青）")).toBeVisible();
    expect(sources.getByText("10 米")).toBeVisible();
    // 原料入库来源被识别为 raw_material_inbound，并带上采购单号与批次
    expect(sources.getByText("IN-1 / raw_material_inbound")).toBeVisible();
    expect(sources.getByText("第 3 批")).toBeVisible();
    expect(sources.getByText("PO-1")).toBeVisible();
    expect(sources.getByText("供应商甲")).toBeVisible();
    expect(sources.getByText("pending_finance")).toBeVisible();
    // 外加工来源（另一个接口）走 outsource_receipt 分支
    expect(sources.getByText("os-12345 / outsource_receipt")).toBeVisible();
    expect(sources.getByText("第 1 批")).toBeVisible();
    expect(sources.getByRole("button", { name: "接收应付" })).toBeVisible();
    expect(sources.getByText("已接收")).toBeVisible();

    const payables = panel("应付条目");
    expect(payables.getByText("AP-001")).toBeVisible();
    expect(payables.getByText("PO-9")).toBeVisible();
    expect(payables.getByText("第 2 批")).toBeVisible();
    expect(payables.getByText("RC-9")).toBeVisible();
    expect(payables.getByText("300.00 CNY")).toBeVisible();

    expect(panel("付款").getByText("FK-001")).toBeVisible();
    expect(panel("付款").getByText("2026-03-08")).toBeVisible();

    const reconciliations = panel("普通对账");
    expect(reconciliations.getByText("2026-01-01 至 2026-01-31")).toBeVisible();
    expect(reconciliations.getByText("1000.00 USD")).toBeVisible();
    expect(reconciliations.getByText("open")).toBeVisible();

    const supplierReconciliations = panel("供应商应付对账");
    expect(supplierReconciliations.getByText("SR-001")).toBeVisible();
    expect(supplierReconciliations.getByText("供应商甲")).toBeVisible();
    expect(supplierReconciliations.getByText("2.00")).toBeVisible();
  });

  it("所有列表为空时各区块回落到空态（不留加载态、不渲染空表格）", async () => {
    stubFinance();
    await openFinance();

    for (const title of ["暂无应收来源", "暂无收款记录", "暂无待接收应付来源", "暂无应付条目", "暂无付款记录", "暂无对账记录", "暂无应付对账记录"]) {
      expect(screen.getByText(title)).toBeVisible();
    }
    expect(screen.queryByTestId("data-table")).toBeNull();
    expect(screen.queryByTestId("loading-state")).toBeNull();
  });
});

describe("财务页：草稿编辑必须走 PATCH（legacy finance-draft-edit-method 的运行时版本）", () => {
  it("应收草稿「编辑」：弹窗预填当前金额，保存发出 PATCH /finance/receivable-sources/:id 且带用户改后的值", async () => {
    const calls = stubFinance({ receivables: [receivableDraft] }, draftEditIsPatchOnly);
    await openFinance();

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("heading", { name: "编辑应收草稿" })).toBeVisible();
    expect(valueOf("action-field-amount")).toBe("120.00");

    await userEvent.clear(screen.getByTestId("action-field-amount"));
    await userEvent.type(screen.getByTestId("action-field-amount"), "99.5");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    // 一次点击 = 一次请求：提交瞬间弹窗关闭，不存在二次提交路径
    expect(screen.queryByTestId("action-dialog")).toBeNull();

    await waitFor(() => expect(callsTo(calls, `${EP.receivables}/rec-1`)).toHaveLength(1));
    const edit = callsTo(calls, `${EP.receivables}/rec-1`)[0];
    expect(edit.method).toBe("PATCH");
    expect(bodyOf(edit)).toEqual({ amount: "99.5" });
    expect(await screen.findByText("应收草稿已更新")).toBeVisible();
    // 成功后重新拉取列表（数据流闭环）
    await waitFor(() => expect(callsTo(calls, EP.receivables)).toHaveLength(2));
  });

  it("收款草稿「编辑」走 PATCH /finance/customer-payments/:id", async () => {
    const calls = stubFinance({ customerPayments: [customerPaymentDraft] }, draftEditIsPatchOnly);
    await openFinance();

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("heading", { name: "编辑收款草稿" })).toBeVisible();
    expect(valueOf("action-field-amount")).toBe("50.00");
    expect(valueOf("action-field-payment_date")).toBe("2026-03-05");

    await userEvent.clear(screen.getByTestId("action-field-amount"));
    await userEvent.type(screen.getByTestId("action-field-amount"), "77");
    await userEvent.type(screen.getByTestId("action-field-payment_method"), "电汇");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, `${EP.customerPayments}/cp-1`)).toHaveLength(1));
    const edit = callsTo(calls, `${EP.customerPayments}/cp-1`)[0];
    expect(edit.method).toBe("PATCH");
    expect(bodyOf(edit)).toEqual({ amount: "77", payment_date: "2026-03-05", payment_method: "电汇" });
    expect(await screen.findByText("草稿已更新")).toBeVisible();
  });

  it("付款草稿「编辑」走 PATCH /finance/supplier-payments/:id", async () => {
    const calls = stubFinance({ supplierPayments: [supplierPaymentDraft] }, draftEditIsPatchOnly);
    await openFinance();

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("heading", { name: "编辑付款草稿" })).toBeVisible();

    await userEvent.type(screen.getByTestId("action-field-payment_method"), "银行承兑");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, `${EP.supplierPayments}/sp-2`)).toHaveLength(1));
    const edit = callsTo(calls, `${EP.supplierPayments}/sp-2`)[0];
    expect(edit.method).toBe("PATCH");
    expect(bodyOf(edit)).toEqual({ amount: "60.00", payment_date: "2026-03-07", payment_method: "银行承兑" });
    expect(await screen.findByText("草稿已更新")).toBeVisible();
  });

  it("应付草稿「编辑」走 PATCH /finance/payable-entries/:id", async () => {
    const calls = stubFinance({ payables: [payableDraft] }, draftEditIsPatchOnly);
    await openFinance();

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("heading", { name: "编辑应付草稿" })).toBeVisible();
    expect(valueOf("action-field-amount")).toBe("300.00");
    // 确认日期是必填且没有默认值：不填就直接提交会停在「请填写确认日期」，不会发出请求
    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("请填写确认日期");
    expect(callsTo(calls, `${EP.payables}/pe-1`)).toHaveLength(0);

    await userEvent.clear(screen.getByTestId("action-field-amount"));
    await userEvent.type(screen.getByTestId("action-field-amount"), "288.8");
    setDate("action-field-confirmation_date", "2026-03-09");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, `${EP.payables}/pe-1`)).toHaveLength(1));
    const edit = callsTo(calls, `${EP.payables}/pe-1`)[0];
    expect(edit.method).toBe("PATCH");
    expect(bodyOf(edit)).toEqual({ amount: "288.8", confirmation_date: "2026-03-09" });
    expect(await screen.findByText("应付草稿已更新")).toBeVisible();
  });
});

describe("财务页：非编辑动作仍然走 POST", () => {
  it("应收「确认」直接 POST /:id/confirm，不打开弹窗", async () => {
    const calls = stubFinance({ receivables: [receivableDraft] }, draftEditIsPatchOnly);
    await openFinance();

    await userEvent.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => expect(callsTo(calls, `${EP.receivables}/rec-1/confirm`)).toHaveLength(1));
    const confirm = callsTo(calls, `${EP.receivables}/rec-1/confirm`)[0];
    expect(confirm.method).toBe("POST");
    expect(confirm.body).toBeNull();
    expect(await screen.findByText("应收已确认")).toBeVisible();
    // 编辑入口没有被误触发
    expect(callsTo(calls, `${EP.receivables}/rec-1`)).toHaveLength(0);
  });

  it("应收「取消」：原因为空时不发请求并给出可读提示，填写后 POST /:id/cancel 带上原因", async () => {
    const calls = stubFinance({ receivables: [receivableDraft] });
    await openFinance();

    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findByRole("heading", { name: "取消应收：AR-001" })).toBeVisible();

    await userEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent("请填写取消原因");
    expect(callsTo(calls, "/cancel")).toHaveLength(0);

    await userEvent.type(screen.getByTestId("action-field-reason"), "客户已线下结清");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, `${EP.receivables}/rec-1/cancel`)).toHaveLength(1));
    const cancel = callsTo(calls, `${EP.receivables}/rec-1/cancel`)[0];
    expect(cancel.method).toBe("POST");
    expect(bodyOf(cancel)).toEqual({ reason: "客户已线下结清" });
    expect(await screen.findByText("应收已取消")).toBeVisible();
  });

  it("已确认应收「回退草稿」走 POST /:id/reopen", async () => {
    const calls = stubFinance({ receivables: [receivableConfirmed] }); 
    await openFinance();

    await userEvent.click(screen.getByRole("button", { name: "回退草稿" }));
    await screen.findByRole("heading", { name: "应收回退草稿" });
    await userEvent.type(screen.getByTestId("action-field-reason"), "金额录错");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, `${EP.receivables}/rec-2/reopen`)).toHaveLength(1));
    expect(callsTo(calls, `${EP.receivables}/rec-2/reopen`)[0].method).toBe("POST");
    expect(bodyOf(callsTo(calls, `${EP.receivables}/rec-2/reopen`)[0])).toEqual({ reason: "金额录错" });
  });

  it("已过账收款「冲销」走 POST /:id/reverse", async () => {
    const calls = stubFinance({ customerPayments: [customerPaymentPosted] });
    await openFinance();

    await userEvent.click(screen.getByRole("button", { name: "冲销" }));
    await screen.findByRole("heading", { name: "冲销支付" });
    await userEvent.type(screen.getByTestId("action-field-reason"), "重复收款");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, `${EP.customerPayments}/cp-2/reverse`)).toHaveLength(1));
    const reverse = callsTo(calls, `${EP.customerPayments}/cp-2/reverse`)[0];
    expect(reverse.method).toBe("POST");
    expect(bodyOf(reverse)).toEqual({ reason: "重复收款" });
    expect(await screen.findByText("支付已冲销")).toBeVisible();
  });

  it("待接收应付来源「接收应付」走 POST /finance/payable-entries/from-source，并带上映射后的 source_type", async () => {
    const calls = stubFinance({ payableSources: [rawMaterialSource] });
    await openFinance();

    await userEvent.click(screen.getByRole("button", { name: "接收应付" }));
    expect(await screen.findByRole("heading", { name: "接收应付：IN-1" })).toBeVisible();
    expect(valueOf("action-field-amount")).toBe("100.00");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/finance/payable-entries/from-source")).toHaveLength(1));
    const receive = callsTo(calls, "/finance/payable-entries/from-source")[0];
    expect(receive.method).toBe("POST");
    // rawMaterialInbound 的存在被映射成 raw_material_inbound（否则后端取不到来源）
    expect(bodyOf(receive)).toEqual({ source_type: "raw_material_inbound", source_id: "ps-1", amount: "100.00" });
    expect(await screen.findByText("应付已接收")).toBeVisible();
  });

  it("对账「处理」与供应商应付对账「处理」各自 POST 到 /:id/resolve 并带上处理说明", async () => {
    const calls = stubFinance({ reconciliations: [reconciliationOpen], supplierReconciliations: [supplierReconciliationDiff] });
    await openFinance();

    await userEvent.click(panel("普通对账").getByRole("button", { name: "处理" }));
    await screen.findByRole("heading", { name: "处理对账" });
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, `${EP.reconciliations}/re-1/resolve`)).toHaveLength(1));
    const resolve = callsTo(calls, `${EP.reconciliations}/re-1/resolve`)[0];
    expect(resolve.method).toBe("POST");
    expect(bodyOf(resolve)).toEqual({ resolution_remark: "已核对" });
    expect(await screen.findByText("对账已处理")).toBeVisible();

    await userEvent.click(panel("供应商应付对账").getByRole("button", { name: "处理" }));
    await screen.findByRole("heading", { name: "处理应付对账差异" });
    await userEvent.type(screen.getByTestId("action-field-remark"), "差异为运费");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, `${EP.supplierReconciliations}/sre-1/resolve`)).toHaveLength(1));
    const resolveSupplier = callsTo(calls, `${EP.supplierReconciliations}/sre-1/resolve`)[0];
    expect(resolveSupplier.method).toBe("POST");
    expect(bodyOf(resolveSupplier)).toEqual({ resolution_remark: "差异为运费" });
  });
});

describe("财务页：新建收付款与失败态", () => {
  it("「登记收款」：客户选项来自 /customers，提交把所选客户与金额 POST 到 /finance/customer-payments", async () => {
    const calls = stubFinance({ customers: [{ id: "c-1", name: "客户甲", customerCode: "C-1" }], salesOrders: [{ id: "o-1", name: "SO-1", orderNo: "SO-1" }] });
    await openFinance();

    await userEvent.click(screen.getByRole("button", { name: "登记收款" }));
    expect(await screen.findByRole("heading", { name: "登记收款" })).toBeVisible();
    expect(valueOf("action-field-payment_method")).toBe("银行转账");

    await userEvent.click(screen.getByTestId("action-field-customer_id"));
    await userEvent.click(await screen.findByRole("option", { name: "C-1 / 客户甲" }));
    await userEvent.type(screen.getByTestId("action-field-amount"), "500");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, EP.customerPayments).filter((call) => call.method === "POST")).toHaveLength(1));
    const created = callsTo(calls, EP.customerPayments).filter((call) => call.method === "POST")[0];
    expect(created.method).toBe("POST");
    const body = bodyOf(created);
    expect(body).toEqual(expect.objectContaining({ customer_id: "c-1", amount: "500", currency: "USD", payment_method: "银行转账" }));
    expect(String(body.payment_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await screen.findByText("收款草稿已创建")).toBeVisible();
  });

  it("加载失败：显示后端错误文案并可重试；重试成功后正常渲染", async () => {
    let failing = true;
    const calls = stubApi((url) => {
      if (url.endsWith(EP.receivables)) {
        if (failing) { failing = false; return apiErr(403, "FORBIDDEN", "无权访问应收来源"); }
        return apiOk([receivableDraft]);
      }
      return apiOk([]);
    });

    renderFinance();

    expect(await screen.findByTestId("error-state")).toHaveTextContent("无权访问应收来源");
    // 加载失败后页面外壳照常渲染（finance/page.tsx:60 的 page-finance + :63 的错误面板），
    // 但一条列表数据都没有：不能把"没加载到"当成"正常空表"渲染成数据表。
    expect(screen.queryByTestId("data-table")).toBeNull();
    expect(screen.queryByText("AR-001")).toBeNull();

    await userEvent.click(screen.getByTestId("error-state-retry"));

    expect(await screen.findByTestId("page-finance")).toBeVisible();
    expect(screen.queryByTestId("error-state")).toBeNull();
    expect(screen.getByText("AR-001")).toBeVisible();
    expect(callsTo(calls, EP.receivables)).toHaveLength(2);
  });

  it("客户/供应商/销售单无权限（403）时留空选项，财务数据照常渲染而不是整页报错", async () => {
    stubApi((url) => {
      if (url.endsWith(EP.customers) || url.endsWith(EP.suppliers) || url.endsWith(EP.salesOrders)) return apiErr(403, "FORBIDDEN", "无权限");
      if (url.endsWith(EP.receivables)) return apiOk([receivableDraft]);
      return apiOk([]);
    });
    await openFinance();

    expect(screen.queryByTestId("error-state")).toBeNull();
    expect(screen.getByText("AR-001")).toBeVisible();
    // 选项为空：单据入口仍在，只是下拉里没有可选项
    await userEvent.click(screen.getByRole("button", { name: "登记收款" }));
    expect(await screen.findByRole("heading", { name: "登记收款" })).toBeVisible();
    await userEvent.click(screen.getByTestId("action-field-customer_id"));
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("动作失败时通过 toast 暴露后端消息（不是静默失败）", async () => {
    stubFinance({ receivables: [receivableDraft] }, (url, call) =>
      /\/finance\/receivable-sources\/rec-1$/.test(url) && call.method === "PATCH" ? apiErr(409, "RECEIVABLE_NOT_DRAFT", "只有草稿应收可以编辑") : undefined
    );
    await openFinance();

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await screen.findByRole("heading", { name: "编辑应收草稿" });
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByText("只有草稿应收可以编辑")).toBeVisible();
    expect(screen.queryByText("应收草稿已更新")).toBeNull();
  });
});

describe("财务页：已知缺陷", () => {
  it("KNOWN_DEFECT：从「登记收款」新增客户后，登记收款弹窗不会恢复（新客户也无法预选）", async () => {
    const calls = stubFinance({ customers: [] }, (url, call) =>
      url.endsWith(EP.customers) && call.method === "POST" ? apiOk({ id: "c-9", name: "新客户", customerCode: "C-9" }) : undefined
    );
    await openFinance();

    await userEvent.click(screen.getByRole("button", { name: "登记收款" }));
    await screen.findByRole("heading", { name: "登记收款" });
    await userEvent.click(screen.getByRole("button", { name: "新增类目" }));
    await screen.findByRole("heading", { name: "新建客户" });

    await userEvent.type(screen.getByTestId("action-field-customer_code"), "C-9");
    await userEvent.type(screen.getByTestId("action-field-name"), "新客户");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    // 客户创建本身是成功的
    expect(await screen.findByText("客户已创建")).toBeVisible();
    expect(callsTo(calls, EP.customers).filter((call) => call.method === "POST")).toHaveLength(1);

    // 期望（app/finance/page.tsx:38 的意图：setDialog({ ...pendingDialog, fields: ... }) 把新客户预选回「登记收款」）：
    //   登记收款弹窗重新出现且 customer_id 预选 c-9。
    // 实际：submit 闭包捕获的 pendingDialog 恒为 null（它在 createCustomerCategory 被调用的那次渲染里就是 null，
    //   而 setPendingDialog(dialog) 只影响后续渲染，改不了已捕获的闭包），于是恢复分支永远不执行，弹窗直接消失。
    expect(screen.queryByRole("heading", { name: "登记收款" })).toBeNull();
  });
});
