// 银行余额互转页（/finance/bank-transfers → components/finance/bank-transfer-workspace.tsx）的**行为**测试。
//
// 为什么单独一页：互转不是收入也不是支出（记成两笔流水会让收支汇总表凭空多出一收一支），
// 它只在 `GET /finance/banks/balances` 里以「转入 / 转出」参与余额。因此这一页要钉住四件事：
//   1) 本方账户余额表读的是 /finance/banks/balances（用户要知道自己能转多少）；
//   2) 用户点名的四项（本方账户 / 本方币种 / 对方账户 / 对方币种）必须原样提交，同币种不送对方金额；
//   3) 余额不足后端**只提示不拦截** —— 界面必须把「转出后余额为负」说出来；
//   4) 同账户自转、同币种金额不等这类注定 422 的输入在客户端就拦下，不浪费一次请求。
//
// 数据契约（全部来自组件源码）：
//   GET  /api/v1/finance/banks                   账户池（下拉与账户名）
//   GET  /api/v1/finance/banks/balances          期初 + 收 − 付 + 转入 − 转出 = 当前余额
//   GET  /api/v1/finance/bank-transfers          互转列表（from/to/bank_id 可选）
//   POST /api/v1/finance/bank-transfers          建单 → { data: { transfer, source_balance_before, source_balance_after, insufficient_balance } }
//   POST /api/v1/finance/bank-transfers/:id/reverse  body: { reason }
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BankTransferWorkspace from "../components/finance/bank-transfer-workspace";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  banks: "/api/v1/finance/banks",
  balances: "/api/v1/finance/banks/balances",
  transfers: "/api/v1/finance/bank-transfers",
  currencies: "/api/v1/dictionaries/currency/items",
} as const;

type Handler = (url: string, call: StubbedCall) => Response | undefined;

const BANKS = [
  { id: "bank-1", bankCode: "ABC-5706", bankName: "农业银行", accountName: "迪礼贸易有限公司", accountNumber: "5706", currency: "CNY", isActive: true, openingBalance: "1000.0000" },
  { id: "bank-2", bankCode: "ICBC-1234", bankName: "工商银行", accountName: "迪礼贸易有限公司", accountNumber: "1234", currency: "CNY", isActive: true, openingBalance: "0.0000" },
  { id: "bank-3", bankCode: "BOC-7624", bankName: "中国银行", accountName: "迪礼贸易有限公司", accountNumber: "7624", currency: "USD", isActive: true, openingBalance: "0.0000" },
  { id: "bank-dead", bankCode: "OLD-0001", bankName: "已停用银行", accountName: "迪礼贸易有限公司", accountNumber: "0001", currency: "CNY", isActive: false, openingBalance: "0.0000" },
];

/** `GET /finance/banks/balances` 的一行：金额都是 4 位小数字符串。 */
const balanceRow = (overrides: Record<string, unknown> = {}) => ({
  id: "bank-1", bank_code: "ABC-5706", bank_name: "农业银行", account_name: "迪礼贸易有限公司", account_number: "5706",
  currency: "CNY", is_active: true, opening_balance: "1000.0000", cash_in: "3000.0000", cash_out: "500.0000",
  transfer_in: "0.0000", transfer_out: "0.0000", balance: "3500.0000", cash_flow_count: 2, ...overrides,
});
const BALANCES = [
  balanceRow(),
  balanceRow({ id: "bank-2", bank_code: "ICBC-1234", bank_name: "工商银行", account_number: "1234", opening_balance: "0.0000", cash_in: "0.0000", cash_out: "0.0000", balance: "0.0000", cash_flow_count: 0 }),
  balanceRow({ id: "bank-3", bank_code: "BOC-7624", bank_name: "中国银行", account_number: "7624", currency: "USD", opening_balance: "200.0000", cash_in: "0.0000", cash_out: "0.0000", balance: "200.0000", cash_flow_count: 0 }),
];

const bankLink = (id: string, bankName: string, accountNumber: string, currency: string) => ({ id, bankCode: id, bankName, accountNumber, currency });
const TRANSFERS = [
  {
    id: "bt-1", transferNo: "BTR-20260917-AAAAAAAA", transferDate: "2026-09-17T00:00:00.000Z",
    fromBankId: "bank-1", fromCurrency: "CNY", toBankId: "bank-2", toCurrency: "CNY",
    fromAmount: "5000.0000", toAmount: "5000.0000", exchangeRate: "1.000000", status: "posted",
    reversalReason: null, remark: "月末资金归集", createdAt: "2026-09-17T01:00:00.000Z",
    fromBank: bankLink("bank-1", "农业银行", "5706", "CNY"), toBank: bankLink("bank-2", "工商银行", "1234", "CNY"),
  },
  {
    id: "bt-2", transferNo: "BTR-20260916-BBBBBBBB", transferDate: "2026-09-16T00:00:00.000Z",
    fromBankId: "bank-3", fromCurrency: "USD", toBankId: "bank-1", toCurrency: "CNY",
    fromAmount: "700.0000", toAmount: "5000.0000", exchangeRate: "7.142857", status: "reversed",
    reversalReason: "账号选错", remark: null, createdAt: "2026-09-16T01:00:00.000Z",
    fromBank: bankLink("bank-3", "中国银行", "7624", "USD"), toBank: bankLink("bank-1", "农业银行", "5706", "CNY"),
  },
];

function stubTransferPage(extra?: Handler) {
  return stubApi((url, call) => {
    const injected = extra?.(url, call);
    if (injected) return injected;
    if (url.startsWith(EP.currencies)) return apiOk([{ key: "CNY", label: "人民币" }, { key: "USD", label: "美元" }]);
    // 余额路由必须排在账户路由之前：/finance/banks/balances 也 startsWith("/finance/banks")。
    if (url.startsWith(EP.balances)) return apiOk(BALANCES);
    if (url.startsWith(EP.banks)) return apiOk(BANKS);
    if (url.startsWith(EP.transfers)) return call.method === "GET" ? apiOk(TRANSFERS) : apiOk({ data: {} });
    return apiOk([]);
  });
}

async function open() {
  render(<><BankTransferWorkspace /><Toaster /></>);
  await screen.findByTestId("page-finance-bank-transfers");
  await screen.findByTestId("bank-transfer-count");
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const setValue = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const toastText = () => screen.getAllByTestId("toast-item").map((item) => item.textContent ?? "").join("|");
/** 列表 GET 带查询串（?from=...），所以按 includes 过滤而不是 callsTo 的 endsWith。 */
const listCalls = (calls: StubbedCall[]) => calls.filter((call) => call.method === "GET" && call.url.includes(EP.transfers));
const postCalls = (calls: StubbedCall[]) => callsTo(calls, EP.transfers).filter((call) => call.method === "POST");

/** Radix Select 必须真实点开再点选项，否则必填校验会拦住提交。 */
async function pickOption(testId: string, optionName: RegExp) {
  await userEvent.click(screen.getByTestId(testId));
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

/** 弹窗里字段的 DOM 顺序（用户点名了四个字段的顺序，顺序本身就是需求）。 */
function fieldOrder() {
  return Array.from(screen.getByTestId("action-dialog").querySelectorAll("[data-testid^='action-field-']"))
    .map((element) => element.getAttribute("data-testid")!.replace("action-field-", ""));
}

describe("银行余额互转 · 余额与列表", () => {
  it("展示「本方账户余额」：期初 / 收 / 付 / 转入 / 转出 / 当前余额都来自 /finance/banks/balances", async () => {
    const calls = stubTransferPage();
    await open();
    expect(callsTo(calls, EP.balances)).toHaveLength(1);

    const panel = within(screen.getByTestId("bank-transfer-balances"));
    expect(panel.getByTestId("bank-transfer-balance-bank-1")).toHaveTextContent("3500.0000");
    const row = panel.getByTestId("bank-transfer-balance-bank-1").closest("tr") as HTMLElement;
    expect(within(row).getByText("1000.0000")).toBeVisible();  // 期初余额
    expect(within(row).getByText("3000.0000")).toBeVisible();  // 收入
    expect(within(row).getByText("500.0000")).toBeVisible();   // 支出
    // 停用账户不能互转，因此不进「本方账户余额」表（后端 requireActiveBank 也会拒），但必须点名去向
    expect(panel.queryByText("已停用银行")).toBeNull();
    expect(panel.getByText(/另有 1 个已停用账户不参与互转/)).toBeVisible();
  });

  it("互转记录列出双方账户/币种/金额/汇率/状态/备注，并按期间与账户取数", async () => {
    const calls = stubTransferPage();
    await open();
    const list = within(screen.getByTestId("bank-transfer-list"));
    const posted = list.getByText("BTR-20260917-AAAAAAAA").closest("tr") as HTMLElement;
    expect(within(posted).getByText("农业银行 / 5706")).toBeVisible();
    expect(within(posted).getByText("工商银行 / 1234")).toBeVisible();
    expect(within(posted).getByText("1.000000")).toBeVisible();
    expect(within(posted).getByText("月末资金归集")).toBeVisible();
    expect(within(posted).getByText("生效")).toBeVisible();
    // 已冲销的行必须能看出冲销原因（不然只能去翻审计）
    expect(list.getByText("已冲销（账号选错）")).toBeVisible();
    expect(screen.getByTestId("bank-transfer-count")).toHaveTextContent("共 2 条");

    // 期间与账户是服务端参数，改了要重新取数
    setValue("bank-transfer-from", "2026-09-01");
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(listCalls(calls)[1].url).toContain("from=2026-09-01");
  });

  it("列表加载失败时给出错误态与重试入口", async () => {
    stubTransferPage((url, call) => (call.method === "GET" && url.startsWith(EP.transfers) ? apiErr(403, "FORBIDDEN", "无权查看银行互转") : undefined));
    render(<BankTransferWorkspace />);
    expect(await screen.findByTestId("error-state")).toHaveTextContent("无权查看银行互转");
  });
});

describe("银行余额互转 · 新建", () => {
  it("弹窗字段顺序就是用户点名的四项 + 金额 + 日期 + 备注", async () => {
    stubTransferPage();
    await open();
    fireEvent.click(screen.getByTestId("bank-transfer-create"));
    await screen.findByTestId("action-dialog");
    expect(fieldOrder()).toEqual(["from_bank_id", "from_currency", "to_bank_id", "to_currency", "from_amount", "to_amount", "transfer_date", "remark"]);
  });

  it("同币种互转：四个用户点名字段原样提交，对方金额不送（交给后端按本方金额入账）", async () => {
    const calls = stubTransferPage();
    await open();
    fireEvent.click(screen.getByTestId("bank-transfer-create"));
    await screen.findByTestId("action-dialog");

    await pickOption("action-field-from_bank_id", /农业银行/);
    await pickOption("action-field-from_currency", /CNY/);
    await pickOption("action-field-to_bank_id", /工商银行/);
    await pickOption("action-field-to_currency", /CNY/);
    setValue("action-field-from_amount", "5000");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postCalls(calls)).toHaveLength(1));
    // 精确断言整个 body：多送一个 to_amount（同币种会被后端 422）或多送空 remark 都算回归
    expect(bodyOf(postCalls(calls)[0])).toEqual({
      transfer_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      from_bank_id: "bank-1",
      from_currency: "CNY",
      to_bank_id: "bank-2",
      to_currency: "CNY",
      from_amount: "5000",
    });
    await waitFor(() => expect(toastText()).toContain("互转单已生效"));
  });

  it("跨币种互转：两个币种与对方金额（实际到账数）一起提交", async () => {
    const calls = stubTransferPage();
    await open();
    fireEvent.click(screen.getByTestId("bank-transfer-create"));
    await screen.findByTestId("action-dialog");

    await pickOption("action-field-from_bank_id", /农业银行/);
    await pickOption("action-field-from_currency", /CNY/);
    await pickOption("action-field-to_bank_id", /中国银行/);
    await pickOption("action-field-to_currency", /USD/);
    setValue("action-field-from_amount", "5000");
    setValue("action-field-to_amount", "700");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postCalls(calls)).toHaveLength(1));
    expect(bodyOf(postCalls(calls)[0])).toMatchObject({ from_currency: "CNY", to_currency: "USD", from_amount: "5000", to_amount: "700" });
  });

  it("本方账户与对方账户不能是同一个（本地拦下，不发请求）", async () => {
    const calls = stubTransferPage();
    await open();
    fireEvent.click(screen.getByTestId("bank-transfer-create"));
    await screen.findByTestId("action-dialog");

    await pickOption("action-field-from_bank_id", /农业银行/);
    await pickOption("action-field-to_bank_id", /农业银行/);
    setValue("action-field-from_amount", "100");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("本方账户与对方账户不能是同一个账户");
    expect(postCalls(calls)).toHaveLength(0);
    expect(screen.getByTestId("action-dialog")).toBeInTheDocument();
  });

  it("同币种两边金额不等 / 跨币种漏填对方金额都在本地拦下", async () => {
    const calls = stubTransferPage();
    await open();

    fireEvent.click(screen.getByTestId("bank-transfer-create"));
    await screen.findByTestId("action-dialog");
    await pickOption("action-field-from_bank_id", /农业银行/);
    await pickOption("action-field-to_bank_id", /工商银行/);
    setValue("action-field-from_amount", "5000");
    setValue("action-field-to_amount", "4000");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("本方金额与对方金额必须相等");
    expect(postCalls(calls)).toHaveLength(0);

    // 换成跨币种：对方账户选美元户、币种跟着改成 USD，对方金额（实际到账数）必填
    await pickOption("action-field-to_bank_id", /中国银行/);
    await pickOption("action-field-to_currency", /USD/);
    setValue("action-field-to_amount", "");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写对方金额");
    expect(postCalls(calls)).toHaveLength(0);
  });

  it("币种必须与所选账户的账户币种一致：选错就地提示（不发注定 422 的请求）", async () => {
    const calls = stubTransferPage();
    await open();
    fireEvent.click(screen.getByTestId("bank-transfer-create"));
    await screen.findByTestId("action-dialog");

    await pickOption("action-field-from_bank_id", /中国银行/);
    await pickOption("action-field-to_bank_id", /工商银行/);
    setValue("action-field-from_amount", "100");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("本方币种必须是中国银行的账户币种 USD");
    expect(postCalls(calls)).toHaveLength(0);
  });

  it("转出会把账户转成负数时给出「余额不足」警告（后端只提示不拦截）", async () => {
    const calls = stubTransferPage((url, call) => (call.method === "POST" && url.endsWith(EP.transfers)
      ? apiOk({ transfer: TRANSFERS[0], source_balance_before: "1000.0000", source_balance_after: "-4000.0000", insufficient_balance: true })
      : undefined));
    await open();
    fireEvent.click(screen.getByTestId("bank-transfer-create"));
    await screen.findByTestId("action-dialog");
    await pickOption("action-field-from_bank_id", /农业银行/);
    await pickOption("action-field-to_bank_id", /工商银行/);
    setValue("action-field-from_amount", "5000");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(postCalls(calls)).toHaveLength(1));
    await waitFor(() => expect(toastText()).toContain("余额不足提醒"));
    expect(toastText()).toContain("转出后农业银行的余额为 -4000.0000（已成负数）");
  });
});

describe("银行余额互转 · 冲销", () => {
  it("冲销必须填原因，POST 到 reverse 端点；已冲销的行不能再冲销", async () => {
    const calls = stubTransferPage();
    await open();
    expect(screen.getByTestId("bank-transfer-reverse-bt-2")).toBeDisabled();

    fireEvent.click(screen.getByTestId("bank-transfer-reverse-bt-1"));
    await screen.findByTestId("action-dialog");
    fireEvent.change(screen.getByTestId("action-field-reason"), { target: { value: "账号选错，重新互转" } });
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, `${EP.transfers}/bt-1/reverse`)).toHaveLength(1));
    expect(bodyOf(callsTo(calls, `${EP.transfers}/bt-1/reverse`)[0])).toEqual({ reason: "账号选错，重新互转" });
    await waitFor(() => expect(toastText()).toContain("已冲销"));
  });

  it("冲销失败把后端原因留在弹窗里（不静默关闭）", async () => {
    stubTransferPage((url, call) => (call.method === "POST" && url.includes("/reverse") ? apiErr(422, "BANK_TRANSFER_NOT_REVERSIBLE", "只有生效中的互转可以冲销") : undefined));
    await open();
    fireEvent.click(screen.getByTestId("bank-transfer-reverse-bt-1"));
    await screen.findByTestId("action-dialog");
    fireEvent.change(screen.getByTestId("action-field-reason"), { target: { value: "重复冲销" } });
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("只有生效中的互转可以冲销");
    expect(screen.getByTestId("action-dialog")).toBeInTheDocument();
  });
});
