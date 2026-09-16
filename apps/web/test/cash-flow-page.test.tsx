// 收支管理页（components/finance/cash-flow-workspace.tsx）行为测试。
//
// 这一页是老表「收支明细表 / 收支汇总表」的录入侧，测试重点是三条业务约束：
//   1. 金额一律填正数，收/支由「收支方向」决定（库层还有 amount > 0 的 CHECK 兜底）；
//   2. 更正只对生效中的流水开放；冲销必须填原因，且冲销后报表不再计入；
//   3. 收支项目是可配置字典 —— 能新增、能停用，且停用后仍列在维护面板里（否则无法再启用）。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import CashFlowWorkspace from "../components/finance/cash-flow-workspace";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  entries: "/api/v1/finance/cash-flow-entries",
  items: "/api/v1/dictionaries/cash_flow_item/items",
  accounts: "/api/v1/dictionaries/settlement_account/items",
  dictionaryItem: "/api/v1/dictionaries/items/",
  currencies: "/api/v1/dictionaries/currency/items",
  banks: "/api/v1/finance/banks",
};

/** 银行账户池（财务 → 银行账户）：流水的「银行账户」下拉只能从这里选。 */
const BANKS = [
  { id: "bank-1", bankCode: "ABC-5706", bankName: "农业银行", accountName: "迪礼贸易有限公司", accountNumber: "5706", currency: "CNY", isActive: true },
  { id: "bank-dead", bankCode: "OLD-0001", bankName: "已停用银行", accountName: "迪礼贸易有限公司", accountNumber: "0001", currency: "CNY", isActive: false },
];

const ENTRIES = [
  {
    id: "cf-1",
    entryNo: "CF-20260914-AAAA1111",
    entryDate: "2026-09-14T00:00:00.000Z",
    counterpartyName: "兴田",
    direction: "expense",
    amount: "2900.0000",
    currency: "CNY",
    item: { id: "item-2", label: "货款" },
    settlementMethod: "转账",
    settlementAccount: { id: "acct-1", label: "农业银行5706" },
    bank: { id: "bank-1", bankCode: "ABC-5706", bankName: "农业银行", accountNumber: "5706", currency: "CNY" },
    status: "posted",
    remark: null,
  },
  {
    id: "cf-2",
    entryNo: "CF-20260914-BBBB2222",
    entryDate: "2026-09-14T00:00:00.000Z",
    counterpartyName: "中谷ZG",
    direction: "income",
    amount: "1000.0000",
    currency: "USD",
    item: { id: "item-2", label: "货款" },
    settlementMethod: "转账",
    settlementAccount: { id: "acct-2", label: "中国银行（美元）7624" },
    bank: null,
    status: "reversed",
    remark: null,
  },
];

const ITEMS = [
  { id: "item-1", key: "备用金", label: "备用金", isActive: true },
  { id: "item-2", key: "货款", label: "货款", isActive: true },
  { id: "item-3", key: "旧项目", label: "旧项目", isActive: false },
];

const ACCOUNTS = [{ id: "acct-1", key: "农业银行5706", label: "农业银行5706", isActive: true }];

type Handler = (url: string, call: StubbedCall) => Response | undefined;

function stubCashFlow(extra?: Handler) {
  const calls = stubApi((url, call) => {
    const injected = extra?.(url, call);
    if (injected) return injected;
    if (url.includes(EP.currencies)) return apiOk([{ key: "CNY", label: "人民币" }, { key: "USD", label: "美元" }]);
    if (url.includes(EP.entries)) return apiOk(ENTRIES);
    if (url.includes(EP.items)) return apiOk(ITEMS);
    if (url.includes(EP.accounts)) return apiOk(ACCOUNTS);
    if (url.includes(EP.banks)) return apiOk(BANKS);
    return apiOk([]);
  });
  return { calls, listCalls: () => calls.filter((call) => call.url.includes(EP.entries)) };
}

async function open() {
  render(<><CashFlowWorkspace /><Toaster /></>);
  await screen.findByTestId("page-finance-cash-flow");
  await screen.findByText("兴田");
}

/** ActionDialog 里的下拉：点开 trigger 再点选项。 */
async function pickOption(name: string, optionName: string | RegExp) {
  fireEvent.click(screen.getByTestId(`action-field-${name}`));
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

afterEach(() => {
  // setup.ts 会自动清理 render 与 fetch 桩；这里只兜底清掉可能的 mock。
  vi.restoreAllMocks();
});

describe("收支管理 · 列表与筛选", () => {
  it("按服务端参数取流水，并展示日期/对方名称/收支/金额/项目/结算方式/状态", async () => {
    const { calls, listCalls } = stubCashFlow();
    await open();
    const request = listCalls()[0];
    expect(request.method).toBe("GET");
    expect(request.url).toContain("from=");
    expect(request.url).toContain("to=");
    expect(request.url).not.toContain("include_reversed=true");

    const table = screen.getByTestId("data-table");
    const row = within(table).getAllByTestId("data-table-row")[0];
    expect(within(row).getByText("兴田")).toBeInTheDocument();
    expect(within(row).getByText("支出")).toBeInTheDocument();
    expect(within(row).getByText("2900.0000")).toBeInTheDocument();
    expect(within(row).getByText("货款")).toBeInTheDocument();
    expect(within(row).getByText("转账--农业银行5706")).toBeInTheDocument();
    // 「银行账户」是算余额的那一个（老表「结算账户」只是字典文本）；没指定的行回落 "-"
    expect(within(row).getByText("农业银行 / 5706")).toBeInTheDocument();
    expect(within(within(table).getAllByTestId("data-table-row")[1]).getByText("-")).toBeInTheDocument();
    expect(screen.getByTestId("cash-flow-count")).toHaveTextContent("共 2 条（收入 1 / 支出 1）");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("改为「一起看已冲销」后重新取数并带上参数", async () => {
    const { listCalls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-include-reversed"));
    fireEvent.click(await screen.findByRole("option", { name: "一起看" }));
    await waitFor(() => expect(listCalls().length).toBe(2));
    expect(listCalls()[1].url).toContain("include_reversed=true");
  });

  it("停用的项目仍列在维护面板里（否则停用后就无法再启用）", async () => {
    stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-open-dictionary"));
    // 维护面板用的是通用 Dialog（不是 ActionDialog），所以直接等面板里的行按钮出现。
    const toggle = await screen.findByTestId("cash-flow-item-toggle-item-3");
    expect(toggle).toHaveTextContent("启用");
    expect(screen.getByText("旧项目")).toBeInTheDocument();
    expect(screen.getByTestId("cash-flow-item-toggle-item-2")).toHaveTextContent("停用");
  });
});

describe("收支管理 · 新增与更正", () => {
  it("新增流水：提交正数金额与方向，POST 到流水端点", async () => {
    const { calls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-create"));
    await screen.findByTestId("action-dialog");

    fireEvent.change(screen.getByTestId("action-field-counterparty_name"), { target: { value: "碧江" } });
    fireEvent.change(screen.getByTestId("action-field-amount"), { target: { value: "4158" } });
    fireEvent.change(screen.getByTestId("action-field-settlement_method"), { target: { value: "转账" } });
    await pickOption("item_id", "货款");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.includes(EP.entries)).length).toBe(1));
    const posted = calls.find((call) => call.method === "POST" && call.url.includes(EP.entries))!;
    const body = JSON.parse(String(posted.body));
    expect(body.counterparty_name).toBe("碧江");
    expect(body.amount).toBe("4158");
    expect(body.item_id).toBe("item-2");
    expect(body.direction).toBe("expense");
    expect(body.currency).toBe("CNY");
    expect(body.entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("新增流水：指定银行账户后随 POST 提交", async () => {
    const { calls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-create"));
    await screen.findByTestId("action-dialog");

    fireEvent.change(screen.getByTestId("action-field-counterparty_name"), { target: { value: "碧江" } });
    fireEvent.change(screen.getByTestId("action-field-amount"), { target: { value: "4158" } });
    await pickOption("item_id", "货款");
    await pickOption("bank_id", /农业银行/);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.includes(EP.entries)).length).toBe(1));
    const posted = calls.find((call) => call.method === "POST" && call.url.includes(EP.entries))!;
    expect(JSON.parse(String(posted.body)).bank_id).toBe("bank-1");
  });

  it("银行账户下拉只列启用账户（停用的账户后端不认，指定了也不加减余额）", async () => {
    stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-create"));
    await screen.findByTestId("action-dialog");
    await userEvent.click(screen.getByTestId("action-field-bank_id"));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent).join("|")).toContain("农业银行");
    expect(options.map((option) => option.textContent).join("|")).not.toContain("已停用银行");
  });

  it("更正流水：银行账户预填当前值，选「不指定银行」按清空提交（送 null）", async () => {
    const { calls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-edit-cf-1"));
    await screen.findByTestId("action-dialog");
    expect(screen.getByTestId("action-field-bank_id")).toHaveTextContent("农业银行");

    await pickOption("bank_id", /不指定银行/);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").length).toBe(1));
    const patched = calls.find((call) => call.method === "PATCH")!;
    // 清空要显式送 null（undefined 会被后端当成「不更新该字段」，银行就永远去不掉了）
    expect(JSON.parse(String(patched.body)).bank_id).toBeNull();
  });

  it("新增失败时把后端原因显示在弹窗内（不是关掉弹窗只弹一条通知）", async () => {
    stubCashFlow((url, call) => (call.method === "POST" && url.includes(EP.entries) ? apiErr(422, "INVALID_CASH_FLOW_AMOUNT", "收支金额必须是大于零的十进制数") : undefined));
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-create"));
    await screen.findByTestId("action-dialog");
    fireEvent.change(screen.getByTestId("action-field-counterparty_name"), { target: { value: "碧江" } });
    fireEvent.change(screen.getByTestId("action-field-amount"), { target: { value: "0" } });
    await pickOption("item_id", "货款");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("收支金额必须是大于零的十进制数");
    expect(screen.getByTestId("action-dialog")).toBeInTheDocument();
  });

  it("更正已生效的流水：PATCH 到该条流水的地址", async () => {
    const { calls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-edit-cf-1"));
    await screen.findByTestId("action-dialog");
    fireEvent.change(screen.getByTestId("action-field-amount"), { target: { value: "3000" } });
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").length).toBe(1));
    const patched = calls.find((call) => call.method === "PATCH")!;
    expect(patched.url).toContain(`${EP.entries}/cf-1`);
    expect(JSON.parse(String(patched.body)).amount).toBe("3000");
  });

  it("已冲销的流水不可更正、不可重复冲销（按钮禁用）", async () => {
    stubCashFlow();
    await open();
    expect(screen.getByTestId("cash-flow-edit-cf-2")).toBeDisabled();
    expect(screen.getByTestId("cash-flow-reverse-cf-2")).toBeDisabled();
    expect(screen.getByTestId("cash-flow-edit-cf-1")).not.toBeDisabled();
  });
});

describe("收支管理 · 冲销", () => {
  it("冲销必须填原因，成功后 POST 到 reverse 端点", async () => {
    const { calls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-reverse-cf-1"));
    await screen.findByTestId("action-dialog");
    fireEvent.change(screen.getByTestId("action-field-reason"), { target: { value: "对方名称填错，重新录入" } });
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.includes("/reverse")).length).toBe(1));
    const reversed = calls.find((call) => call.url.includes("/reverse"))!;
    expect(reversed.url).toContain(`${EP.entries}/cf-1/reverse`);
    expect(JSON.parse(String(reversed.body)).reason).toBe("对方名称填错，重新录入");
  });
});

describe("收支管理 · 收支项目维护", () => {
  it("新增项目：POST 到字典端点，key 与 label 都是项目名", async () => {
    const { calls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-open-dictionary"));
    fireEvent.change(await screen.findByTestId("cash-flow-item-new"), { target: { value: "展会物料费" } });
    fireEvent.click(screen.getByTestId("cash-flow-item-add"));

    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.includes(EP.items)).length).toBe(1));
    const posted = calls.find((call) => call.method === "POST" && call.url.includes(EP.items))!;
    expect(JSON.parse(String(posted.body))).toMatchObject({ key: "展会物料费", label: "展会物料费" });
  });

  it("空项目名不发请求", async () => {
    const { calls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-open-dictionary"));
    await screen.findByTestId("cash-flow-item-new");
    fireEvent.click(screen.getByTestId("cash-flow-item-add"));
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("停用项目：PATCH 字典项的 is_active", async () => {
    const { calls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-open-dictionary"));
    fireEvent.click(await screen.findByTestId("cash-flow-item-toggle-item-2"));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH" && call.url.includes(EP.dictionaryItem)).length).toBe(1));
    const patched = calls.find((call) => call.method === "PATCH" && call.url.includes(EP.dictionaryItem))!;
    expect(patched.url).toContain(`${EP.dictionaryItem}item-2`);
    expect(JSON.parse(String(patched.body))).toEqual({ is_active: false });
  });

  it("非管理员改字典：把后端 403 提示出来（写字典仅管理员可用）", async () => {
    stubCashFlow((url, call) => (call.method === "PATCH" && url.includes(EP.dictionaryItem) ? apiErr(403, "FORBIDDEN", "需要管理员权限") : undefined));
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-open-dictionary"));
    fireEvent.click(await screen.findByTestId("cash-flow-item-toggle-item-2"));
    expect(await screen.findByText(/需要管理员权限/)).toBeInTheDocument();
  });
});
