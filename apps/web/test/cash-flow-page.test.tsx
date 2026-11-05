// 收支管理页（components/finance/cash-flow-workspace.tsx）行为测试。
//
// 这一页是老表「收支明细表 / 收支汇总表」的录入侧。测试重点是四条业务约束：
//   1. 金额一律填正数，收/支由「收支方向」决定（库层还有 amount > 0 的 CHECK 兜底）；
//   2. 更正只对生效中的流水开放；冲销必须填原因，且冲销后报表不再计入；
//   3. **分类口径来自会计科目**（2026-09-17 用户口径：分类 = 科目类别，项目 = 科目名称，
//      来源 `example/财务/科目表(2).xls`）—— 流水必须能按分类筛，也必须在列表里看到分类；
//   4. 子栏目是「收支流水 / 会计科目」两个，**没有**独立的「收支项目维护」——
//      用户要求两者合并成一个（会计科目维护的用例见 accounting-subject-page.test.tsx）。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import CashFlowWorkspace from "../components/finance/cash-flow-workspace";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  entries: "/api/v1/finance/cash-flow-entries",
  subjects: "/api/v1/finance/accounting-subjects",
  categories: "/api/v1/finance/accounting-subjects/categories",
  accounts: "/api/v1/dictionaries/settlement_account/items",
  currencies: "/api/v1/dictionaries/currency/items",
  banks: "/api/v1/finance/banks",
};

/** 银行账户池（财务 → 银行账户）：流水的「银行账户」下拉只能从这里选。 */
const BANKS = [
  { id: "bank-1", bankCode: "ABC-5706", bankName: "农业银行", accountName: "迪礼贸易有限公司", accountNumber: "5706", currency: "CNY", isActive: true },
  { id: "bank-dead", bankCode: "OLD-0001", bankName: "已停用银行", accountName: "迪礼贸易有限公司", accountNumber: "0001", currency: "CNY", isActive: false },
];

/** 会计科目（分类 = 科目类别，项目 = 科目名称）。 */
const SUBJECTS = [
  { id: "sub-1", category: "资产类", name: "库存现金（备用金）", balanceDirection: "借", sortOrder: 10, isActive: true },
  { id: "sub-2", category: "损益类", name: "主营业务收入", balanceDirection: "借", sortOrder: 770, isActive: true },
  { id: "sub-3", category: "损益类", name: "旧科目", balanceDirection: "借", sortOrder: 1220, isActive: false },
  // 2026-11-05 报障那条链上的两个科目：主科目（对方科目）与业务科目（收支类目）。
  { id: "sub-ap", category: "负债类", name: "应付账款", balanceDirection: "贷", sortOrder: 560, isActive: true },
  { id: "sub-mgmt", category: "损益类", name: "管理费用", balanceDirection: "借", sortOrder: 800, isActive: true },
];

const REVENUE = { id: "sub-2", category: "损益类", name: "主营业务收入", balanceDirection: "借" };
const EXPENSE = { id: "sub-1", category: "资产类", name: "库存现金（备用金）", balanceDirection: "借" };

const ENTRIES = [
  {
    id: "cf-1",
    entryNo: "CF-20260914-AAAA1111",
    entryDate: "2026-09-14T00:00:00.000Z",
    counterpartyName: "兴田",
    direction: "expense",
    amount: "2900.0000",
    currency: "CNY",
    subject: EXPENSE,
    settlementMethod: "转账",
    settlementAccount: { id: "acct-1", label: "农业银行5706" },
    bank: { id: "bank-1", bankCode: "ABC-5706", bankName: "农业银行", accountNumber: "5706", currency: "CNY" },
    status: "posted",
    // 支出行不标款项性质（性质是收入侧的口径），订单号也不填。
    paymentNature: null,
    orderNo: null,
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
    subject: REVENUE,
    settlementMethod: "转账",
    settlementAccount: { id: "acct-2", label: "中国银行（美元）7624" },
    bank: null,
    status: "reversed",
    // 定金在出货前收到，那时还没有应收来源可挂，所以只能靠订单号归集（见外汇一览表）。
    paymentNature: "deposit",
    orderNo: "DL260002",
    remark: null,
  },
  {
    // 生效中的收入行：用来验证「更正」弹窗会把款项性质与订单号预填出来。
    // （cf-2 是已冲销的，更正按钮是禁用的，所以不能拿它来测弹窗。）
    id: "cf-3",
    entryNo: "CF-20260914-CCCC3333",
    entryDate: "2026-09-14T00:00:00.000Z",
    counterpartyName: "中谷ZG",
    direction: "income",
    amount: "620.0000",
    currency: "USD",
    subject: REVENUE,
    settlementMethod: "转账",
    settlementAccount: { id: "acct-2", label: "中国银行（美元）7624" },
    bank: null,
    status: "posted",
    paymentNature: "deposit",
    orderNo: "DL260002",
    remark: null,
  },
];

const ACCOUNTS = [{ id: "acct-1", key: "农业银行5706", label: "农业银行5706", isActive: true }];

type Handler = (url: string, call: StubbedCall) => Response | undefined;

function stubCashFlow(extra?: Handler) {
  const calls = stubApi((url, call) => {
    const injected = extra?.(url, call);
    if (injected) return injected;
    if (url.includes(EP.currencies)) return apiOk([{ key: "CNY", label: "人民币" }, { key: "USD", label: "美元" }]);
    if (url.includes(EP.entries)) return apiOk(ENTRIES);
    // categories 必须排在 subjects 前面判断：它的地址以 subjects 为前缀。
    if (url.includes(EP.categories)) return apiOk(["资产类", "负债类", "成本类", "所有者权益类", "损益类"]);
    if (url.includes(EP.subjects)) return apiOk(SUBJECTS);
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

/**
 * 弹窗里的下拉：点开 trigger 再点选项。
 *
 * 两种下拉都要能点开：Radix `Select`（testid 在 trigger 按钮上）与 `SearchableSelect`
 * （会计科目在 2026-09-20 换成了带搜索框的它，testid 落在根 div 上，里面的 button 才是 trigger）。
 */
async function pickOption(name: string, optionName: string | RegExp) {
  const root = screen.getByTestId(`action-field-${name}`);
  fireEvent.click((root.querySelector("button") ?? root) as HTMLElement);
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

/**
 * 等一个宏任务，让 Radix 的「关闭后把焦点还给自己的 trigger」先结算完。
 *
 * Radix Select 关闭时会**延迟**（onCloseAutoFocus）把焦点还给它的 trigger。测试里两次操作之间
 * 没有真实用户的间隔，于是那个延迟回调会落在「刚打开下一个控件」之后 ——
 * 它把 `SearchableSelect` 搜索框的焦点抢走，触发搜索框的 blur 关闭，弹层刚开就自己关了。
 * 真实用户点两次之间隔几百毫秒，不会碰到这件事。
 *
 * 2026-09-20 起会计科目从 Radix Select 换成了带搜索框的 `SearchableSelect`（用户第 1 条），
 * 它不参与 Radix 的焦点管理，所以「先选一个 Radix 下拉、紧接着打开它」这个顺序在测试里要显式等一拍。
 */
const settleFocus = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  // setup.ts 会自动清理 render 与 fetch 桩；这里只兜底清掉可能的 mock。
  vi.restoreAllMocks();
});

describe("收支管理 · 子栏目", () => {
  it("给两个子栏目标签：收支流水与会计科目（不再有独立的收支项目维护）", async () => {
    stubCashFlow();
    await open();
    expect(screen.getByTestId("finance-tab-entries")).toHaveAttribute("href", "/finance/cash-flow?tab=entries");
    expect(screen.getByTestId("finance-tab-subjects")).toHaveAttribute("href", "/finance/cash-flow?tab=subjects");
    expect(screen.queryByTestId("finance-tab-items")).toBeNull();
    // 流水子栏目上不再有「收支项目维护」按钮：维护已经并进会计科目子栏目。
    expect(screen.queryByTestId("cash-flow-open-dictionary")).toBeNull();
  });
});

describe("收支管理 · 列表与筛选", () => {
  it("按服务端参数取流水，并展示日期/对方名称/收支/金额/分类/项目/款项性质/订单号/结算方式/状态", async () => {
    const { calls, listCalls } = stubCashFlow();
    await open();
    const request = listCalls()[0];
    expect(request.method).toBe("GET");
    expect(request.url).toContain("from=");
    expect(request.url).toContain("to=");
    expect(request.url).not.toContain("include_reversed=true");

    const table = screen.getByTestId("data-table");
    const rows = within(table).getAllByTestId("data-table-row");
    const row = rows[0];
    expect(within(row).getByText("兴田")).toBeInTheDocument();
    expect(within(row).getByText("支出")).toBeInTheDocument();
    expect(within(row).getByText("2900.0000")).toBeInTheDocument();
    // 分类 = 科目类别，项目 = 「分类 / 科目名称」（同名科目要能分得清，所以带上分类前缀）。
    expect(within(row).getByText("资产类")).toBeInTheDocument();
    expect(within(row).getByText("资产类 / 库存现金（备用金）")).toBeInTheDocument();
    expect(within(row).getByText("转账--农业银行5706")).toBeInTheDocument();
    // 「银行账户」是算余额的那一个（老表「结算账户」只是字典文本）
    expect(within(row).getByText("农业银行 / 5706")).toBeInTheDocument();
    // 支出行不显示款项性质：性质是收入侧的口径，显示一个没有意义的标签比显示 "-" 更糟。
    // 这一行的款项性质与订单号都是空的（银行账户有值），所以正好两个 "-"。
    expect(within(row).getAllByText("-")).toHaveLength(2);
    // 收入行：款项性质与订单号都要看得见 —— 老表「外汇一览表」正是按这两列把收款收束起来的。
    expect(within(rows[1]).getByText("定金")).toBeInTheDocument();
    expect(within(rows[1]).getByText("DL260002")).toBeInTheDocument();
    // 没指定银行账户的行回落 "-"（这一行只有银行账户一个 "-"）。
    expect(within(rows[1]).getByText("-")).toBeInTheDocument();
    expect(screen.getByTestId("cash-flow-count")).toHaveTextContent("共 3 条（收入 2 / 支出 1）");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("按分类筛选：把科目类别作为 category 参数发给服务端", async () => {
    const { listCalls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-category-filter"));
    fireEvent.click(await screen.findByRole("option", { name: "损益类" }));
    await waitFor(() => expect(listCalls().length).toBe(2));
    expect(listCalls()[1].url).toContain("category=");
    expect(decodeURIComponent(listCalls()[1].url)).toContain("category=损益类");
  });

  it("按会计科目筛选：把 subject_id 参数发给服务端", async () => {
    const { listCalls } = stubCashFlow();
    await open();
    // 这个筛选器是 SearchableSelect：testid 在根 div 上，trigger 是它里面的 button。
    fireEvent.click(screen.getByTestId("cash-flow-subject-filter").querySelector("button") as HTMLElement);
    fireEvent.click(await screen.findByRole("option", { name: "损益类 / 主营业务收入" }));
    await waitFor(() => expect(listCalls().length).toBe(2));
    expect(listCalls()[1].url).toContain("subject_id=sub-2");
  });

  it("改为「一起看已冲销」后重新取数并带上参数", async () => {
    const { listCalls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-include-reversed"));
    fireEvent.click(await screen.findByRole("option", { name: "一起看" }));
    await waitFor(() => expect(listCalls().length).toBe(2));
    expect(listCalls()[1].url).toContain("include_reversed=true");
  });

  it("科目下拉只列启用科目（停用的科目不能再选，但历史流水仍显示它）", async () => {
    stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-create"));
    await screen.findByTestId("action-dialog");
    // SearchableSelect：testid 在根 div 上，trigger 是里面的 button。
    await userEvent.click(screen.getByTestId("action-field-subject_id").querySelector("button") as HTMLElement);
    const options = await screen.findAllByRole("option");
    const text = options.map((option) => option.textContent).join("|");
    expect(text).toContain("损益类 / 主营业务收入");
    expect(text).not.toContain("旧科目");
  });
});

describe("收支管理 · 新增与更正", () => {
  it("新增流水：提交正数金额、方向与会计科目，POST 到流水端点", async () => {
    const { calls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-create"));
    await screen.findByTestId("action-dialog");

    fireEvent.change(screen.getByTestId("action-field-counterparty_name"), { target: { value: "碧江" } });
    fireEvent.change(screen.getByTestId("action-field-amount"), { target: { value: "4158" } });
    fireEvent.change(screen.getByTestId("action-field-settlement_method"), { target: { value: "转账" } });
    await pickOption("subject_id", "损益类 / 主营业务收入");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.includes(EP.entries)).length).toBe(1));
    const posted = calls.find((call) => call.method === "POST" && call.url.includes(EP.entries))!;
    const body = JSON.parse(String(posted.body));
    expect(body.counterparty_name).toBe("碧江");
    expect(body.amount).toBe("4158");
    expect(body.subject_id).toBe("sub-2");
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
    await pickOption("subject_id", "损益类 / 主营业务收入");
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
    expect(screen.getByTestId("action-field-subject_id")).toHaveTextContent("资产类 / 库存现金（备用金）");

    await pickOption("bank_id", /不指定银行/);
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").length).toBe(1));
    const patched = calls.find((call) => call.method === "PATCH")!;
    // 清空要显式送 null（undefined 会被后端当成「不更新该字段」，银行就永远去不掉了）
    expect(JSON.parse(String(patched.body)).bank_id).toBeNull();
  });

  // 款项性质与订单号：老表「外汇一览表」按这两列把收款拆成「定金/货款」并按订单收束。
  // 定金是**出货前**收到的钱，那一刻系统里还没有应收来源可挂，所以订单号必须能手填。
  it("新增收入流水：款项性质与订单号随 POST 一起提交", async () => {
    const { calls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-create"));
    await screen.findByTestId("action-dialog");

    fireEvent.change(screen.getByTestId("action-field-counterparty_name"), { target: { value: "中谷" } });
    fireEvent.change(screen.getByTestId("action-field-amount"), { target: { value: "620" } });
    await pickOption("direction", "收入");
    await settleFocus();
    await pickOption("subject_id", "损益类 / 主营业务收入");
    await pickOption("payment_nature", "定金");
    fireEvent.change(screen.getByTestId("action-field-order_no"), { target: { value: "DL260002" } });
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.includes(EP.entries)).length).toBe(1));
    const body = JSON.parse(String(calls.find((call) => call.method === "POST" && call.url.includes(EP.entries))!.body));
    expect(body.payment_nature).toBe("deposit");
    expect(body.order_no).toBe("DL260002");
  });

  it("更正流水：款项性质预填当前值，选「（不标注）」按空串提交（否则永远清不掉标错的性质）", async () => {
    const { calls } = stubCashFlow();
    await open();
    // cf-3 是生效中的收入行，带 paymentNature=deposit：下拉要能把它显示出来。
    fireEvent.click(screen.getByTestId("cash-flow-edit-cf-3"));
    await screen.findByTestId("action-dialog");
    expect(screen.getByTestId("action-field-payment_nature")).toHaveTextContent("定金");
    expect(screen.getByTestId("action-field-order_no")).toHaveValue("DL260002");

    await pickOption("payment_nature", "（不标注）");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").length).toBe(1));
    const body = JSON.parse(String(calls.find((call) => call.method === "PATCH")!.body));
    // 空串 = 清空（后端按「空串 = 清空」处理，见 payment-nature.ts 的 PAYMENT_NATURE_FORM_KEYS）。
    expect(body.payment_nature).toBe("");
    // 没改订单号就原样带上（不然「只改性质」会顺手把订单号清掉）
    expect(body.order_no).toBe("DL260002");
  });

  it("款项性质下拉只有定金/货款/尾款/其他四个取值（不给「其他」兜底乱标的机会）", async () => {
    stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-create"));
    await screen.findByTestId("action-dialog");
    await userEvent.click(screen.getByTestId("action-field-payment_nature"));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["（不标注）", "定金", "货款", "尾款", "其他"]);
  });

  it("新增失败时把后端原因显示在弹窗内（不是关掉弹窗只弹一条通知）", async () => {
    stubCashFlow((url, call) => (call.method === "POST" && url.includes(EP.entries) ? apiErr(422, "INVALID_CASH_FLOW_AMOUNT", "收支金额必须是大于零的十进制数") : undefined));
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-create"));
    await screen.findByTestId("action-dialog");
    fireEvent.change(screen.getByTestId("action-field-counterparty_name"), { target: { value: "碧江" } });
    fireEvent.change(screen.getByTestId("action-field-amount"), { target: { value: "0" } });
    await pickOption("subject_id", "损益类 / 主营业务收入");
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

/**
 * 2026-11-05 用户报障：确认应付里选的会计科目（损益类/管理费用）到了收支流水里变成「应付账款」。
 *
 * 线上实例 CF-20261105-9CFB412B（确认应付 APO-20261027-CE78BFBC 的付款）：
 * 主科目 `subject` = 负债类/应付账款（现金分录的对方科目，生成凭证用），
 * 收支类目 `categorySubject` = 损益类/管理费用（财务在确认应付时选的那个）。
 * 列表的「分类 / 项目」必须显示后者；前者只在悬停里作为「记账对方科目」出现，不丢信息。
 */
const AUTO_ENTRY = {
  id: "cf-9",
  entryNo: "CF-20261105-9CFB412B",
  entryDate: "2026-11-05T00:00:00.000Z",
  counterpartyName: "拼多多",
  direction: "expense",
  amount: "27.2000",
  currency: "CNY",
  subject: { id: "sub-ap", category: "负债类", name: "应付账款", balanceDirection: "贷" },
  categorySubject: { id: "sub-mgmt", category: "损益类", name: "管理费用", balanceDirection: "借" },
  settlementMethod: "转账",
  settlementAccount: { id: "acct-1", label: "农业银行5706" },
  bank: { id: "bank-1", bankCode: "ABC-5706", bankName: "农业银行", accountNumber: "5706", currency: "CNY" },
  status: "posted",
  paymentNature: null,
  orderNo: null,
  remark: null,
};

async function openEntries(entries: unknown[]) {
  stubCashFlow((url) => (url.includes(EP.entries) ? apiOk(entries) : undefined));
  render(<><CashFlowWorkspace /><Toaster /></>);
  await screen.findByTestId("page-finance-cash-flow");
  await screen.findByText("拼多多");
}

describe("收支管理 · 会计科目口径（确认应付选的科目不能在流水里变成应付账款）", () => {
  it("「分类 / 项目」显示业务科目（收支类目），记账对方科目只挂在悬停提示上", async () => {
    await openEntries([AUTO_ENTRY]);
    const table = screen.getByTestId("data-table");
    const row = within(table).getAllByTestId("data-table-row")[0];
    expect(within(row).getByText("损益类")).toBeInTheDocument();
    expect(within(row).getByText("损益类 / 管理费用")).toBeInTheDocument();
    // 负债类/应付账款不再占据「分类 / 项目」两列，但也没有消失：项目格的 title 写着它是记账对方科目。
    expect(within(row).queryByText("负债类")).toBeNull();
    expect(within(row).queryByText("负债类 / 应付账款")).toBeNull();
    expect(within(row).getByTitle("记账对方科目：负债类 / 应付账款")).toHaveTextContent("损益类 / 管理费用");
  });

  it("更正自动写入的流水：改的是收支类目（category_subject_id），不是记账对方科目", async () => {
    const { calls } = stubCashFlow((url) => (url.includes(EP.entries) ? apiOk([AUTO_ENTRY]) : undefined));
    render(<><CashFlowWorkspace /><Toaster /></>);
    await screen.findByTestId("page-finance-cash-flow");
    await screen.findByText("拼多多");

    fireEvent.click(screen.getByTestId("cash-flow-edit-cf-9"));
    await screen.findByTestId("action-dialog");
    // 弹窗里预填的是财务看到的「会计科目」（收支类目），并说明对方科目由来源单据决定。
    expect(screen.getByTestId("action-field-category_subject_id")).toHaveTextContent("损益类 / 管理费用");
    expect(screen.getByText(/记账对方科目：负债类 \/ 应付账款/)).toBeInTheDocument();

    await pickOption("category_subject_id", "损益类 / 主营业务收入");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").length).toBe(1));
    const body = JSON.parse(String(calls.find((call) => call.method === "PATCH")!.body));
    expect(body.category_subject_id).toBe("sub-2");
    expect(body.subject_id).toBeUndefined();
  });

  it("手工录入的流水没有收支类目：显示与更正仍然走主科目（同一套规则的兜底）", async () => {
    const { calls } = stubCashFlow();
    await open();
    fireEvent.click(screen.getByTestId("cash-flow-edit-cf-1"));
    await screen.findByTestId("action-dialog");
    expect(screen.getByTestId("action-field-subject_id")).toHaveTextContent("资产类 / 库存现金（备用金）");
    expect(screen.queryByTestId("action-field-category_subject_id")).toBeNull();
    await pickOption("subject_id", "损益类 / 主营业务收入");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").length).toBe(1));
    const body = JSON.parse(String(calls.find((call) => call.method === "PATCH")!.body));
    expect(body.subject_id).toBe("sub-2");
    expect(body.category_subject_id).toBeUndefined();
  });
});
