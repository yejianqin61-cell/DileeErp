// 银行账户池（/finance/banks → components/finance/bank-workspace.tsx）的**行为**测试。
//
// 为什么补这一页：这套接口（GET/POST/PATCH/PATCH toggle/DELETE /finance/banks）此前只有后端，
// 前端只在应付付款/对账里把它当**下拉数据源**，于是用户看不到池子里有什么、也建不了账户
// （2026-09-15 反馈「银行池在哪？我咋没看见」）。
//
// 数据契约（全部来自组件源码）：
//   GET    /api/v1/finance/banks              账户池
//   POST   /api/v1/finance/banks              新建
//   PATCH  /api/v1/finance/banks/:id          编辑
//   PATCH  /api/v1/finance/banks/:id/toggle   启用/停用（body: {is_active}）
//   DELETE /api/v1/finance/banks/:id          删除（软删除，必须二次确认）
//   GET    /api/v1/dictionaries/currency/items 币种下拉
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BankWorkspace from "../components/finance/bank-workspace";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = { banks: "/api/v1/finance/banks", currencies: "/api/v1/dictionaries/currency/items" } as const;

type Handler = (url: string, call: StubbedCall) => Response | undefined | Promise<Response | undefined>;

function stubBanks(banks: unknown[] = [], extra?: Handler) {
  return stubApi(async (url, call) => {
    const injected = await extra?.(url, call);
    if (injected) return injected;
    if (url.startsWith(EP.currencies)) return apiOk([]);
    if (url.startsWith(EP.banks)) return call.method === "GET" ? apiOk(banks) : apiOk({});
    return apiOk({});
  });
}

async function openBanks(banks: unknown[] = [], extra?: Handler) {
  const calls = stubBanks(banks, extra);
  render(<><BankWorkspace /><Toaster /></>);
  await screen.findByTestId("page-finance-banks");
  return calls;
}

const bodyOf = (call: StubbedCall) => JSON.parse(String(call.body)) as Record<string, unknown>;
const setValue = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

const bank = (overrides: Record<string, unknown> = {}) => ({
  id: "bank-1", bankCode: "ABC-5706", bankName: "农业银行", accountName: "迪礼贸易有限公司", accountNumber: "5706",
  currency: "CNY", swiftCode: null, isActive: true, remark: null, ...overrides,
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

  it("没有账户时给出空态并说明它会被用在哪里", async () => {
    await openBanks([]);
    expect(screen.getByText("还没有银行账户")).toBeVisible();
    expect(screen.getByText(/付款、应付对账的「支付银行」下拉/)).toBeVisible();
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
    expect(bodyOf(post)).toMatchObject({ bank_code: "ABC-5706", bank_name: "农业银行", account_name: "迪礼贸易有限公司", account_number: "5706", currency: "CNY" });
    await waitFor(() => expect(screen.getAllByTestId("toast-item").some((item) => item.textContent?.includes("银行账户已创建"))).toBe(true));
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
    expect(within(confirm).getByText(/已引用它的付款单与对账单仍会显示这个账户名称/)).toBeVisible();

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

describe("银行账户池：失败态", () => {
  it("列表 403 落到错误态并给出重试入口", async () => {
    await openBanks([], (url, call) => (call.method === "GET" && url.startsWith(EP.banks) ? apiErr(403, "FORBIDDEN", "无权访问银行账户") : undefined));
    expect(screen.getByTestId("error-state")).toHaveTextContent("无权访问银行账户");
    expect(screen.queryByRole("heading", { name: "银行账户池" })).toBeNull();
  });
});
