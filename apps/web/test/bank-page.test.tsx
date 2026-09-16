// 银行账户池（/finance/banks → components/finance/bank-workspace.tsx）的**行为**测试。
//
// 为什么补这一页：这套接口（GET/POST/PATCH/PATCH toggle/DELETE /finance/banks）此前只有后端，
// 前端只在应付付款/对账里把它当**下拉数据源**，于是用户看不到池子里有什么、也建不了账户
// （2026-09-15 反馈「银行池在哪？我咋没看见」）。
//
// 数据契约（全部来自组件源码）：
//   GET    /api/v1/finance/banks              账户池
//   POST   /api/v1/finance/banks              新建（含期初余额 opening_balance）
//   PATCH  /api/v1/finance/banks/:id          编辑
//   PATCH  /api/v1/finance/banks/:id/toggle   启用/停用（body: {is_active}）
//   DELETE /api/v1/finance/banks/:id          删除（软删除，必须二次确认）
//   GET    /api/v1/finance/banks/balances     期初/收支/互转/当前余额（余额 = 期初 + 收入 − 支出 + 转入 − 转出）
//   GET    /api/v1/dictionaries/currency/items 币种下拉
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BankWorkspace from "../components/finance/bank-workspace";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = { banks: "/api/v1/finance/banks", balances: "/api/v1/finance/banks/balances", currencies: "/api/v1/dictionaries/currency/items" } as const;

type Handler = (url: string, call: StubbedCall) => Response | undefined | Promise<Response | undefined>;

function stubBanks(banks: unknown[] = [], extra?: Handler, balances: unknown[] = []) {
  return stubApi(async (url, call) => {
    const injected = await extra?.(url, call);
    if (injected) return injected;
    if (url.startsWith(EP.currencies)) return apiOk([]);
    // 余额路由必须排在账户路由之前：/finance/banks/balances 也 startsWith("/finance/banks")。
    if (url.startsWith(EP.balances)) return apiOk(balances);
    if (url.startsWith(EP.banks)) return call.method === "GET" ? apiOk(banks) : apiOk({});
    return apiOk({});
  });
}

async function openBanks(banks: unknown[] = [], extra?: Handler, balances: unknown[] = []) {
  const calls = stubBanks(banks, extra, balances);
  render(<><BankWorkspace /><Toaster /></>);
  await screen.findByTestId("page-finance-banks");
  return calls;
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const setValue = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

const bank = (overrides: Record<string, unknown> = {}) => ({
  id: "bank-1", bankCode: "ABC-5706", bankName: "农业银行", accountName: "迪礼贸易有限公司", accountNumber: "5706",
  currency: "CNY", swiftCode: null, isActive: true, remark: null, openingBalance: "0.0000", ...overrides,
});

/** `GET /finance/banks/balances` 的一行（金额都是 4 位小数字符串）。 */
const balanceRow = (overrides: Record<string, unknown> = {}) => ({
  id: "bank-1", bank_code: "ABC-5706", bank_name: "农业银行", account_name: "迪礼贸易有限公司", account_number: "5706",
  currency: "CNY", is_active: true, opening_balance: "0.0000", cash_in: "3000.0000", cash_out: "500.0000",
  transfer_in: "0.0000", transfer_out: "0.0000", balance: "2500.0000", cash_flow_count: 2, ...overrides,
});

describe("银行账户池：列表与筛选", () => {
  it("列出账户的关键字段：编码/名称/账户名/账号/币种/SWIFT/状态/备注", async () => {
    await openBanks([bank(), bank({ id: "bank-2", bankCode: "BOC-7624", bankName: "中国银行", accountNumber: "7624", currency: "USD", swiftCode: "BKCHCNBJ", isActive: false, remark: "美元户" })]);
    const row = screen.getByText("ABC-5706").closest("tr") as HTMLElement;
    expect(within(row).getByText("农业银行")).toBeVisible();
    expect(within(row).getByText("迪礼贸易有限公司")).toBeVisible();
    expect(within(row).getByText("5706")).toBeVisible();
    expect(within(row).getByText("启用")).toBeVisible();
    const usd = screen.getByText("BOC-7624").closest("tr") as HTMLElement;
    expect(within(usd).getByText("BKCHCNBJ")).toBeVisible();
    expect(within(usd).getByText("已停用")).toBeVisible();
    expect(screen.getByText(/共 2 个账户（启用 1 个）/)).toBeVisible();
  });

  it("搜索按编码/名称/账号/币种本地过滤，不发新请求", async () => {
    const calls = await openBanks([bank(), bank({ id: "bank-2", bankCode: "BOC-7624", bankName: "中国银行", accountNumber: "7624", currency: "USD" })]);
    const before = callsTo(calls, EP.banks).filter((call) => call.method === "GET").length;
    setValue("bank-filter", "usd");
    expect(screen.queryByText("ABC-5706")).toBeNull();
    expect(screen.getByText("BOC-7624")).toBeVisible();
    expect(callsTo(calls, EP.banks).filter((call) => call.method === "GET")).toHaveLength(before);
  });

  it("没有账户时给出空态", async () => {
    await openBanks([]);
    expect(screen.getByText("还没有银行账户")).toBeVisible();
  });
});

describe("银行账户池：新建 / 编辑", () => {
  it("新建：必填校验 + POST /finance/banks（币种默认取币种字典）", async () => {
    const calls = await openBanks([]);
    await userEvent.click(screen.getByTestId("bank-create"));
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(screen.getByTestId("action-dialog-error")).toHaveTextContent("请填写银行编码");
    expect(callsTo(calls, EP.banks).filter((call) => call.method === "POST")).toHaveLength(0);

    setValue("action-field-bank_code", "ABC-5706");
    setValue("action-field-bank_name", "农业银行");
    setValue("action-field-account_name", "迪礼贸易有限公司");
    setValue("action-field-account_number", "5706");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, EP.banks).filter((call) => call.method === "POST")).toHaveLength(1));
    const post = callsTo(calls, EP.banks).filter((call) => call.method === "POST")[0];
    expect(bodyOf(post)).toMatchObject({ bank_code: "ABC-5706", bank_name: "农业银行", account_name: "迪礼贸易有限公司", account_number: "5706", currency: "CNY", opening_balance: "0" });
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("银行账户已创建"))).toBe(true));
  });

  it("新建：期初余额（建账时账户里已有的钱）按填写的值提交", async () => {
    const calls = await openBanks([]);
    await userEvent.click(screen.getByTestId("bank-create"));
    setValue("action-field-bank_code", "ABC-5706");
    setValue("action-field-bank_name", "农业银行");
    setValue("action-field-account_name", "迪礼贸易有限公司");
    setValue("action-field-account_number", "5706");
    setValue("action-field-opening_balance", "1234.5");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, EP.banks).filter((call) => call.method === "POST")).toHaveLength(1));
    expect(bodyOf(callsTo(calls, EP.banks).filter((call) => call.method === "POST")[0]).opening_balance).toBe("1234.5");
  });

  it("编辑：期初余额预填当前值，改动后随 PATCH 提交", async () => {
    const calls = await openBanks([bank({ openingBalance: "500.0000" })]);
    await userEvent.click(within(screen.getByTestId("bank-actions-bank-1")).getByRole("button", { name: "编辑" }));
    expect((screen.getByTestId("action-field-opening_balance") as HTMLInputElement).value).toBe("500.0000");
    setValue("action-field-opening_balance", "800");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, `${EP.banks}/bank-1`)).toHaveLength(1));
    expect(bodyOf(callsTo(calls, `${EP.banks}/bank-1`)[0]).opening_balance).toBe("800");
  });

  it("编辑：弹窗预填当前值，保存发出 PATCH /finance/banks/:id", async () => {
    const calls = await openBanks([bank({ swiftCode: "ABOCCNBJ", remark: "主账户" })]);
    await userEvent.click(within(screen.getByTestId("bank-actions-bank-1")).getByRole("button", { name: "编辑" }));
    expect((screen.getByTestId("action-field-bank_code") as HTMLInputElement).value).toBe("ABC-5706");
    expect((screen.getByTestId("action-field-swift_code") as HTMLInputElement).value).toBe("ABOCCNBJ");
    setValue("action-field-account_name", "迪礼（福建）贸易有限公司");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(callsTo(calls, `${EP.banks}/bank-1`)).toHaveLength(1));
    expect(callsTo(calls, `${EP.banks}/bank-1`)[0].method).toBe("PATCH");
    expect(bodyOf(callsTo(calls, `${EP.banks}/bank-1`)[0])).toMatchObject({ account_name: "迪礼（福建）贸易有限公司", remark: "主账户" });
  });

  it("新建失败时把后端原因显示在弹窗里（不静默关闭）", async () => {
    await openBanks([], (url, call) => (call.method === "POST" && url.startsWith(EP.banks) ? apiErr(422, "BANK_CODE_EXISTS", "银行编码 ABC-5706 已存在") : undefined));
    await userEvent.click(screen.getByTestId("bank-create"));
    setValue("action-field-bank_code", "ABC-5706");
    setValue("action-field-bank_name", "农业银行");
    setValue("action-field-account_name", "迪礼贸易有限公司");
    setValue("action-field-account_number", "5706");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(screen.getByTestId("action-dialog-error")).toHaveTextContent("银行编码 ABC-5706 已存在"));
    expect(screen.getByTestId("action-dialog")).toBeInTheDocument();
  });
});

describe("银行账户池：停用与删除", () => {
  it("停用/启用：PATCH /:id/toggle 带 is_active，并重新拉取列表", async () => {
    const calls = await openBanks([bank()]);
    await userEvent.click(screen.getByTestId("bank-toggle-bank-1"));
    await waitFor(() => expect(callsTo(calls, `${EP.banks}/bank-1/toggle`)).toHaveLength(1));
    expect(callsTo(calls, `${EP.banks}/bank-1/toggle`)[0].method).toBe("PATCH");
    expect(bodyOf(callsTo(calls, `${EP.banks}/bank-1/toggle`)[0])).toEqual({ is_active: false });
    expect(callsTo(calls, EP.banks).filter((call) => call.method === "GET")).toHaveLength(2);
  });

  it("删除必须二次确认：取消不发请求，确认才 DELETE /:id", async () => {
    const calls = await openBanks([bank()]);
    await userEvent.click(screen.getByTestId("bank-delete-bank-1"));
    const confirm = await screen.findByTestId("bank-delete-confirm");
    expect(within(confirm).getByText(/农业银行 5706/)).toBeVisible();
    expect(within(confirm).getByRole("button", { name: "确认删除" })).toBeVisible();

    await userEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(callsTo(calls, `${EP.banks}/bank-1`).filter((call) => call.method === "DELETE")).toHaveLength(0);

    await userEvent.click(screen.getByTestId("bank-delete-bank-1"));
    await userEvent.click(await screen.findByTestId("bank-delete-confirm-submit"));
    await waitFor(() => expect(callsTo(calls, `${EP.banks}/bank-1`).filter((call) => call.method === "DELETE")).toHaveLength(1));
  });

  it("删除失败时 toast 显示后端原因", async () => {
    await openBanks([bank()], (url, call) => (call.method === "DELETE" && url.startsWith(EP.banks) ? apiErr(404, "BANK_NOT_FOUND", "银行账户不存在") : undefined));
    await userEvent.click(screen.getByTestId("bank-delete-bank-1"));
    await userEvent.click(await screen.findByTestId("bank-delete-confirm-submit"));
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("银行账户不存在"))).toBe(true));
  });
});

describe("银行账户池：期初余额与当前余额", () => {
  it("期初余额与当前余额取自 /finance/banks/balances，并在行里给出余额构成", async () => {
    const calls = await openBanks([bank()], undefined, [balanceRow()]);
    expect(callsTo(calls, EP.balances)).toHaveLength(1);
    // 当前余额用稳定的 testid 暴露（余额是最容易算错、也最需要被钉住的一格）
    const cell = screen.getByTestId("bank-balance-bank-1");
    expect(cell).toHaveTextContent("2500.0000");
    const row = screen.getByText("ABC-5706").closest("tr") as HTMLElement;
    expect(within(row).getByText("0.0000")).toBeVisible();
    // 构成写全：期初 / 收 / 付 / 转入 / 转出 → 余额（用户要能自己对一遍账）
    expect(within(row).getByText("期初 0.0000 + 收 3000.0000 − 付 500.0000 + 转入 0.0000 − 转出 0.0000 = 2500.0000")).toBeVisible();
  });

  it("余额接口失败不影响账户列表：账户照常渲染，只是余额退回档案上的期初值", async () => {
    await openBanks([bank({ openingBalance: "700.0000" })], (url, call) => (call.method === "GET" && url.startsWith(EP.balances) ? apiErr(500, "BANK_BALANCE_FAILED", "余额计算失败") : undefined));
    expect(screen.getByText("农业银行")).toBeVisible();
    expect(screen.getByTestId("bank-balance-bank-1")).toHaveTextContent("700.0000");
    expect(screen.queryByTestId("error-state")).toBeNull();
  });
});

describe("银行账户池：失败态", () => {
  it("列表 403 落到错误态并给出重试入口", async () => {
    await openBanks([], (url, call) => (call.method === "GET" && url.startsWith(EP.banks) ? apiErr(403, "FORBIDDEN", "无权访问银行账户") : undefined));
    expect(screen.getByTestId("error-state")).toHaveTextContent("无权访问银行账户");
    expect(screen.queryByRole("heading", { name: "银行账户池" })).toBeNull();
  });
});
