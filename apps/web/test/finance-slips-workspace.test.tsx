// 收付款单存档页（/finance/slips → components/finance/finance-slips-workspace.tsx）的**行为**测试。
//
// 为什么补这一页：用户 2026-09-26 只说了六个字——「付款单要有填写汇率的地方，**保存键**」。
// 保存这个动作在界面上必须回答「存下来的单子去哪了」，否则保存只是往库里丢一条没人再看到的记录。
// 所以本文件钉住三件事：
//   1. 列表把存档里要紧的字段都显示出来（编号 / 日期 / 对方 / 币种 / 汇率 / 折合人民币 / 合计 / 行数）；
//   2. 「打开」回到同一个编辑器，且**再保存是覆盖那一张**（PATCH 而不是 POST）——
//      点两次保存得到两张一样的单子，是这一轮最容易犯的错；
//   3. 「导出」走的是与编辑器**同一个**导出接口（列表里不打开也能出文件）、「作废」必须填原因。
//
// 数据契约（全部来自组件源码）：
//   GET    /api/v1/finance/slips?kind=payment&page_size=20    存档列表（meta.total）
//   POST   /api/v1/finance/slips                              新建存档
//   PATCH  /api/v1/finance/slips/:id                          覆盖存档
//   DELETE /api/v1/finance/slips/:id                          作废（body: {reason}）
//   POST   /api/v1/finance/payment-slips.xlsx                导出（downloadPost，**裸 fetch**）
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FinanceSlipsWorkspace from "../components/finance/finance-slips-workspace";
import FinanceSlipEditor from "../components/finance/finance-slip-editor";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

/** 下载三件套（与 payable-page.test.tsx 同一套）：只关心 URL 与文件名。 */
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

const EP = { slips: "/api/v1/finance/slips", exportXlsx: "/api/v1/finance/payment-slips.xlsx" } as const;

type Handler = (url: string, call: StubbedCall) => Response | undefined | Promise<Response | undefined>;

/** 一张已保存的付款单（后端 `SavedFinanceSlip` 的形状：预填的字段 + 存档信息）。 */
const record = (overrides: Record<string, unknown> = {}) => ({
  id: "slip-1",
  kind: "payment",
  slip_no: "FK-202609-001",
  slip_date: "2026-09-26",
  slip_method: "银行转账",
  counterparty_name: "富雨鑫",
  our_bank_name: "中国银行",
  our_bank_account: "7624",
  counterparty_bank_name: "中国农业银行",
  counterparty_bank_account: "4039 0001 0400 45706",
  currency: "USD",
  exchange_rate: "7.12345678",
  amount_cny: "1064.44",
  attachment_count: 1,
  remark: "月结 30 天",
  maker: "小叶",
  lines: [
    { summary: "支付富雨鑫材料款", general_subject: "原材料", detail_subject: "", debit: "149.50", credit: "", remark: "" },
    { summary: "支付富雨鑫款项合计", general_subject: "银行存款", detail_subject: "中国银行", debit: "", credit: "149.50", remark: "" },
  ],
  source_entry_ids: ["entry-1"],
  created_at: "2026-09-26T02:00:00.000Z",
  updated_at: "2026-09-26T03:00:00.000Z",
  ...overrides,
});

function stubSlips(rows: unknown[] = [], extra?: Handler) {
  return stubApi(async (url, call) => {
    const injected = await extra?.(url, call);
    if (injected) return injected;
    if (url.startsWith(EP.exportXlsx)) return new Response(new Blob(["xlsx"]), { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
    if (url.startsWith(EP.slips)) {
      if (call.method === "GET") return apiOk(rows, { page: 1, page_size: 20, total: rows.length });
      return apiOk({ slip: record() });
    }
    return apiOk({});
  });
}

async function openSlips(rows: unknown[] = [record()], extra?: Handler) {
  const calls = stubSlips(rows, extra);
  render(<><FinanceSlipsWorkspace kind="payment" /><Toaster /></>);
  await screen.findByTestId("page-finance-slips");
  await waitFor(() => expect(slipCalls(calls).length).toBeGreaterThan(0));
  return calls;
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const setValue = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
/**
 * 存档相关的调用。
 *
 * ⚠️ 列表那条带查询串（`/finance/slips?kind=payment&page_size=20`），所以**不能**用 `callsTo` 的
 * 「后缀匹配」去认它 —— 用后缀匹配的写法会静默返回空数组，测试于是「等一个永远不来的请求」。
 */
const slipCalls = (calls: StubbedCall[]) => calls.filter((call) => call.url.startsWith(EP.slips));

describe("收付款单存档：列表", () => {
  it("把存下来的单子显示全：编号 / 日期 / 对方 / 币种 / 汇率 / 折合人民币 / 合计 / 行数", async () => {
    await openSlips();
    const row = screen.getByText("FK-202609-001").closest("tr") as HTMLElement;
    expect(within(row).getByText("2026-09-26")).toBeVisible();
    expect(within(row).getByText("富雨鑫")).toBeVisible();
    expect(within(row).getByText("USD")).toBeVisible();
    // 汇率与折合人民币是**手填**的两格：留空就是 "-"，不是 0。
    expect(within(row).getByText("7.12345678")).toBeVisible();
    expect(within(row).getByText("1064.44")).toBeVisible();
    expect(screen.getByTestId("slip-total-slip-1")).toHaveTextContent("149.5");
    expect(within(row).getByText("2")).toBeVisible();
  });

  it("留空的两格显示为「-」，不显示 0（人民币付款本来就没有汇率）", async () => {
    await openSlips([record({ currency: "CNY", exchange_rate: "", amount_cny: "" })]);
    const row = screen.getByText("FK-202609-001").closest("tr") as HTMLElement;
    expect(within(row).getAllByText("-").length).toBeGreaterThanOrEqual(2);
  });

  it("没有存档时给空态，并说明单据从哪里来（这页刻意没有「新建」）", async () => {
    await openSlips([]);
    expect(screen.getByText("还没有保存过付款单")).toBeVisible();
    expect(screen.getByText(/在这里建不出来/)).toBeVisible();
  });

  it("列表请求带上种类；切到收款单是另一条真实链接", async () => {
    const calls = await openSlips();
    expect(calls[0].url).toContain("kind=payment");
    const receiptTab = screen.getByTestId("slip-kind-receipt");
    expect(receiptTab).toHaveAttribute("href", "/finance/slips?kind=receipt");
    expect(screen.getByTestId("slip-kind-payment")).toHaveAttribute("aria-current", "page");
  });

  it("加载失败时给出错误与重试，不是空白页", async () => {
    await openSlips([], async (url) => (url.startsWith(EP.slips) ? apiErr(500, "BOOM", "存档列表加载失败") : undefined));
    expect(await screen.findByText("存档列表加载失败")).toBeVisible();
  });
});

describe("收付款单存档：打开 → 覆盖保存", () => {
  it("「打开」把存档铺进编辑器（币种、汇率、折合人民币都在），按钮是「保存修改」", async () => {
    await openSlips();
    await userEvent.click(screen.getByTestId("slip-open-slip-1"));
    expect(await screen.findByTestId("payment-slip-editor")).toBeVisible();
    expect(screen.getByTestId("payment-slip-editor-currency")).toHaveValue("USD");
    expect(screen.getByTestId("payment-slip-editor-exchange-rate")).toHaveValue("7.12345678");
    expect(screen.getByTestId("payment-slip-editor-amount-cny")).toHaveValue("1064.44");
    expect(screen.getByTestId("payment-slip-editor-save")).toHaveTextContent("保存修改");
  });

  it("改一处再保存：走 PATCH /finance/slips/:id（覆盖那一张，不是再建一张），并刷新列表", async () => {
    const calls = await openSlips();
    await userEvent.click(screen.getByTestId("slip-open-slip-1"));
    await screen.findByTestId("payment-slip-editor");
    setValue("payment-slip-editor-remark", "改成月结 60 天");
    await userEvent.click(screen.getByTestId("payment-slip-editor-save"));

    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/slips/slip-1").length).toBe(1));
    const patch = callsTo(calls, "/api/v1/finance/slips/slip-1")[0];
    expect(patch.method).toBe("PATCH");
    const body = bodyOf(patch);
    expect(body.remark).toBe("改成月结 60 天");
    expect(body.exchange_rate).toBe("7.12345678");
    // 勾选信息跟着存档走（追溯用），但**保存不生成任何账务动作**：只打这一个接口。
    expect(body.source_entry_ids).toEqual(["entry-1"]);
    expect(callsTo(calls, EP.exportXlsx).length).toBe(0);
    // 列表被刷新（保存后要能马上看到新值）。
    await waitFor(() => expect(slipCalls(calls).filter((call) => call.method === "GET").length).toBeGreaterThan(1));
  });

  it("保存门槛比导出一档：没有编号 / 借贷不平也能存，但导出按钮是禁用的", async () => {
    // 借贷不平的那张（只留下借方那一行）。
    await openSlips([record({ slip_no: "", lines: [record().lines[0]] })]);
    await userEvent.click(screen.getByTestId("slip-open-slip-1"));
    await screen.findByTestId("payment-slip-editor");
    expect(screen.getByTestId("payment-slip-editor-save")).toBeEnabled();
    expect(screen.getByTestId("payment-slip-editor-export")).toBeDisabled();
    expect(screen.getByTestId("payment-slip-editor-blockers")).toHaveTextContent("请填写单据编号");
  });

  it("填了汇率但折合人民币空着时，把「系统不自动折算」写在界面上", async () => {
    await openSlips([record({ exchange_rate: "7.12", amount_cny: "" })]);
    await userEvent.click(screen.getByTestId("slip-open-slip-1"));
    await screen.findByTestId("payment-slip-editor");
    expect(screen.getByTestId("payment-slip-editor-cny-hint")).toHaveTextContent("不会按");
  });
});

/**
 * 编辑器直接渲染的一组用例（不经过存档页）。
 *
 * 为什么单独一组：**没有 id 的单子走 POST**（第一次保存）这条路在存档页里造不出来 ——
 * 那一页列出来的记录一定带 id。而它正是「预填 → 改 → 保存」的第一步，必须被钉住
 * （写反了就是「点保存没反应」或者「每次都新建一张」）。
 */
describe("收付款单编辑器：第一次保存是新建", () => {
  const draft = (overrides: Record<string, unknown> = {}) => ({
    kind: "payment" as const,
    slip_no: "FK-202609-001", slip_date: "2026-09-26", slip_method: "银行转账", counterparty_name: "富雨鑫",
    our_bank_name: "中国银行", our_bank_account: "7624", counterparty_bank_name: "农业银行", counterparty_bank_account: "4039",
    currency: "USD", exchange_rate: "7.12", amount_cny: "1064.44", attachment_count: 1, remark: "", maker: "小叶",
    source_entry_ids: ["entry-1"],
    lines: [
      { summary: "支付富雨鑫材料款", general_subject: "原材料", detail_subject: "", debit: "149.50", credit: "", remark: "" },
      { summary: "支付富雨鑫款项合计", general_subject: "银行存款", detail_subject: "中国银行", debit: "", credit: "149.50", remark: "" },
    ],
    ...overrides,
  });

  async function openEditor(overrides: Record<string, unknown> = {}) {
    const calls = stubSlips([]);
    render(<><FinanceSlipEditor kind="payment" open onOpenChange={() => {}} drafts={[draft(overrides)]} loading={false} error="" /><Toaster /></>);
    await screen.findByTestId("payment-slip-editor");
    return calls;
  }

  it("没有 id 时按钮是「保存这一张」，POST 到 /finance/slips，并把返回的 id 记下来（第二次变覆盖）", async () => {
    const calls = await openEditor();
    expect(screen.getByTestId("payment-slip-editor-save")).toHaveTextContent("保存这一张");
    await userEvent.click(screen.getByTestId("payment-slip-editor-save"));

    await waitFor(() => expect(slipCalls(calls).filter((call) => call.method === "POST").length).toBe(1));
    const post = slipCalls(calls).find((call) => call.method === "POST")!;
    expect(post.url).toBe("/api/v1/finance/slips");
    expect(bodyOf(post).slip_no).toBe("FK-202609-001");
    expect(bodyOf(post).source_entry_ids).toEqual(["entry-1"]);
    // 保存成功后按钮变成「保存修改」：id 已经记回队列，再点就是覆盖同一张
    // （写错的表现是财务点两次保存得到两张一模一样的单子）。
    await waitFor(() => expect(screen.getByTestId("payment-slip-editor-save")).toHaveTextContent("保存修改"));
  });

  it("保存失败时把后端的原因显示在弹窗里（不是静默什么都不发生）", async () => {
    const calls = stubSlips([], async (url, call) => (url.startsWith(EP.slips) && call.method === "POST" ? apiErr(422, "SLIP_DATE_INVALID", "付款日期无效（应为 YYYY-MM-DD）") : undefined));
    render(<><FinanceSlipEditor kind="payment" open onOpenChange={() => {}} drafts={[draft()]} loading={false} error="" /><Toaster /></>);
    await screen.findByTestId("payment-slip-editor");
    await userEvent.click(screen.getByTestId("payment-slip-editor-save"));
    expect(await screen.findByTestId("payment-slip-editor-error")).toHaveTextContent("付款日期无效");
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("收付款单存档：导出与作废", () => {
  it("列表里直接导出：走与编辑器同一个导出接口，文件名按单号", async () => {
    captureDownloads();
    const calls = await openSlips();
    await userEvent.click(screen.getByTestId("slip-export-slip-1"));
    await waitFor(() => expect(callsTo(calls, EP.exportXlsx).length).toBe(1));
    const post = callsTo(calls, EP.exportXlsx)[0];
    expect(post.method).toBe("POST");
    expect(bodyOf(post).slip_no).toBe("FK-202609-001");
    await waitFor(() => expect(anchorClicks.length).toBe(1));
    expect(anchorClicks[0].download).toBe("迪礼付款单-FK-202609-001.xlsx");
  });

  it("作废要求填原因（不填不发请求），填了才 DELETE 并把原因送出去", async () => {
    const calls = await openSlips();
    await userEvent.click(screen.getByTestId("slip-delete-slip-1"));
    const submit = await screen.findByTestId("action-dialog-submit");
    await userEvent.click(submit);
    expect(await screen.findByText("请填写作废原因（录错了请写清错在哪）")).toBeVisible();
    expect(callsTo(calls, "/api/v1/finance/slips/slip-1").length).toBe(0);

    fireEvent.change(screen.getByTestId("action-field-reason"), { target: { value: "对方单位填错了" } });
    await userEvent.click(submit);
    await waitFor(() => expect(callsTo(calls, "/api/v1/finance/slips/slip-1").length).toBe(1));
    const remove = callsTo(calls, "/api/v1/finance/slips/slip-1")[0];
    expect(remove.method).toBe("DELETE");
    expect(bodyOf(remove)).toEqual({ reason: "对方单位填错了" });
  });
});
