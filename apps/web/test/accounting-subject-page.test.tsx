// 会计科目维护页（components/finance/accounting-subject-workspace.tsx）行为测试。
//
// 这一页就是用户说的「收支项目维护和会计科目合并成一个」之后的**唯一**分类维护入口
// （渲染在 `/finance/cash-flow?tab=subjects`），所以这里守住四条：
//   1. 全量列表（含停用）：停用的科目必须还看得见，否则历史流水上的科目名会消失；
//   2. 新增必须带分类（分类 = 科目类别，是科目表的必填维度，没有它报表落不进任何分类小计）；
//   3. 停用/启用走 PATCH is_active，改名换分类也走 PATCH；
//   4. 已被引用的科目删除会被后端拒（ACCOUNTING_SUBJECT_IN_USE），页面要把原因说出来，
//      并引导财务改用停用 —— 而不是静默失败。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AccountingSubjectWorkspace from "../components/finance/accounting-subject-workspace";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

/**
 * 下拉必须真实点开再点选项（与 finance-page.test.tsx 同一套）。
 *
 * 弹层渲染在 portal 里（不在 panel 内），所以选项要从 `screen` 上找；
 * `SearchableSelect` 的 testid 落在根 div 上，里面的 button 才是 trigger。
 */
async function pickOption(scope: ReturnType<typeof within>, testId: string, optionName: RegExp) {
  const root = scope.getByTestId(testId);
  await userEvent.click((root.querySelector("button") ?? root) as HTMLElement);
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

const EP = {
  subjects: "/api/v1/finance/accounting-subjects",
  // 旧派生清单接口（2026-11-07 起页面不再调用，保留在桩里用于断言「没有回退」）。
  categories: "/api/v1/finance/accounting-subjects/categories",
  subjectCategories: "/api/v1/finance/accounting-subject-categories",
  openings: "/api/v1/finance/opening-balances",
  rates: "/api/v1/finance/exchange-rates",
};

const SUBJECTS = [
  { id: "sub-1", category: "资产类", name: "库存现金（备用金）", balanceDirection: "借", sortOrder: 10, isActive: true },
  { id: "sub-2", category: "损益类", name: "主营业务收入", balanceDirection: "借", sortOrder: 770, isActive: true },
  { id: "sub-3", category: "损益类", name: "销售费 运费", balanceDirection: null, sortOrder: 850, isActive: false },
];

const CATEGORIES = ["资产类", "负债类", "成本类", "所有者权益类", "损益类"];

/**
 * 科目类目（GET /finance/accounting-subject-categories 的真实形状）：
 * 内置五类在前、自建类目接后、id=null 的历史类目最后；科目数分「启用 / 共」两个字段。
 */
const CATEGORY_ROWS = [
  { id: "cat-1", name: "资产类", sortOrder: 10, isSystem: true, subjectCount: 1, activeSubjectCount: 1, createdBy: "u-1", updatedBy: "u-1", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", created_by_name: "系统", updated_by_name: "系统" },
  { id: "cat-2", name: "负债类", sortOrder: 20, isSystem: true, subjectCount: 0, activeSubjectCount: 0, created_by_name: "系统", updated_by_name: "系统" },
  { id: "cat-3", name: "成本类", sortOrder: 30, isSystem: true, subjectCount: 0, activeSubjectCount: 0, created_by_name: "系统", updated_by_name: "系统" },
  { id: "cat-4", name: "所有者权益类", sortOrder: 40, isSystem: true, subjectCount: 0, activeSubjectCount: 0, created_by_name: "系统", updated_by_name: "系统" },
  { id: "cat-5", name: "损益类", sortOrder: 50, isSystem: true, subjectCount: 2, activeSubjectCount: 1, created_by_name: "系统", updated_by_name: "系统" },
  { id: "cat-custom", name: "共同类", sortOrder: 60, isSystem: false, subjectCount: 0, activeSubjectCount: 0, created_by_name: "李四", updated_by_name: "李四" },
  // id=null：只存在于历史科目行上的分类，没有实体可改名/删除。
  { id: null, name: "未分类", sortOrder: 999, isSystem: false, subjectCount: 0, activeSubjectCount: 0, created_by_name: null, updated_by_name: null },
];

function stubSubjects(extra?: (url: string, call: StubbedCall) => Response | undefined) {
  const calls = stubApi((url, call) => {
    const injected = extra?.(url, call);
    if (injected) return injected;
    // categories 必须排在 subjects 前面判断：它的地址以 subjects 为前缀。
    if (url.endsWith(EP.categories)) return apiOk(CATEGORIES);
    if (url.includes(EP.subjectCategories)) return apiOk(CATEGORY_ROWS);
    if (url.includes(EP.subjects)) return apiOk(SUBJECTS);
    if (url.includes(EP.openings)) return apiOk(OPENINGS);
    if (url.includes(EP.rates)) return apiOk(RATES);
    return apiOk([]);
  });
  return { calls };
}

/** 科目表作用域：页面上多了「科目类目」表，不能再按全局 `data-table` 取第一张。 */
const subjectTable = () => within(screen.getByTestId("accounting-subject-table"));
const categoryPanel = () => within(screen.getByTestId("accounting-subject-category-panel"));

/** 按类目名找类目表里的行（类目名在说明文字里也会出现，必须从行里找而不是全页 getByText）。 */
function categoryRow(name: string) {
  const row = categoryPanel().getAllByTestId("data-table-row").find((element) => element.textContent?.includes(name));
  if (!row) throw new Error(`类目表里没有「${name}」`);
  return within(row);
}

/** 期末汇率（2026-09-24）：面板与科目表在同一页。 */
const RATES = {
  period: "2026-09",
  rows: [{ currency: "USD", rate: "7.1234", remark: "中国银行" }],
  periods: ["2026-09"],
};

/** 建账期初余额（2026-09-24）：面板与科目表在同一页。 */
const OPENINGS = {
  as_of_date: "2026-09-01",
  currency: "CNY",
  rows: [
    { subject_key: "资产类/库存现金（备用金）", subject_label: "库存现金（备用金）", direction: "debit", amount: "3000" },
    { subject_key: "所有者权益类/实收资本", subject_label: "实收资本", direction: "credit", amount: "3000" },
  ],
  totals: { debit: "3000", credit: "3000", difference: "0", balanced: true },
};

async function open() {
  render(<><AccountingSubjectWorkspace /><Toaster /></>);
  await screen.findByText("主营业务收入");
}

/** 可控 deferred：把类目接口稳定停在 pending 上，断言首屏的加载态。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("会计科目 · 列表", () => {
  it("拉全量列表（include_inactive=true）与分类清单，并展示分类/项目/余额方向/状态", async () => {
    const { calls } = stubSubjects();
    await open();
    const listCall = calls.find((call) => call.url.includes(EP.subjects) && !call.url.includes("/categories"))!;
    expect(listCall.method).toBe("GET");
    expect(listCall.url).toContain("include_inactive=true");
    // 2026-11-07：类目清单改走新接口（带科目数/内置标记，可维护），旧的派生接口不再调用。
    expect(calls.some((call) => call.url.endsWith(EP.subjectCategories))).toBe(true);
    expect(calls.some((call) => call.url.endsWith(EP.categories))).toBe(false);

    const table = screen.getByTestId("accounting-subject-table");
    const row = within(table).getAllByTestId("data-table-row")[0];
    expect(within(row).getByText("资产类")).toBeInTheDocument();
    expect(within(row).getByText("库存现金（备用金）")).toBeInTheDocument();
    expect(within(row).getByText("借")).toBeInTheDocument();
    expect(within(row).getByText("启用")).toBeInTheDocument();
  });

  it("停用的科目仍然列出来（否则历史流水上的科目名会消失）；没有余额方向的显示 -", async () => {
    stubSubjects();
    await open();
    const table = screen.getByTestId("accounting-subject-table");
    const rows = within(table).getAllByTestId("data-table-row");
    expect(rows).toHaveLength(3);
    const stopped = rows.find((row) => row.textContent?.includes("销售费 运费"))!;
    expect(within(stopped).getByText("已停用")).toBeInTheDocument();
    expect(within(stopped).getByText("-")).toBeInTheDocument();
    expect(screen.getByTestId("accounting-subject-toggle-sub-3")).toHaveTextContent("启用");
    expect(screen.getByTestId("accounting-subject-count")).toHaveTextContent("共 3 条（启用 2 / 已停用 1）");
  });

  it("分类筛选与搜索都是本地过滤（科目表只有一百多条，往返一次反而会闪）", async () => {
    const { calls } = stubSubjects();
    await open();
    const before = calls.filter((call) => call.url.includes(EP.subjects)).length;

    fireEvent.click(screen.getByTestId("accounting-subject-filter-category"));
    fireEvent.click(await screen.findByRole("option", { name: "损益类" }));
    await waitFor(() => expect(subjectTable().getAllByTestId("data-table-row")).toHaveLength(2));
    expect(subjectTable().queryByText("库存现金（备用金）")).toBeNull();

    fireEvent.change(screen.getByTestId("accounting-subject-search"), { target: { value: "销售费" } });
    await waitFor(() => expect(subjectTable().getAllByTestId("data-table-row")).toHaveLength(1));
    expect(screen.getByTestId("accounting-subject-count")).toHaveTextContent("共 1 条（启用 0 / 已停用 1）");

    // 一个额外请求都没发：筛选完全在本地完成。
    expect(calls.filter((call) => call.url.includes(EP.subjects)).length).toBe(before);
  });

  it("本地过滤筛空时给出专门的空状态（不是让人以为科目丢了）", async () => {
    stubSubjects();
    await open();
    fireEvent.change(screen.getByTestId("accounting-subject-search"), { target: { value: "根本不存在的科目" } });
    expect(await screen.findByText("没有符合条件的会计科目")).toBeInTheDocument();
  });
});

describe("会计科目 · 新增", () => {
  it("新增必须带分类：POST 到科目端点，body 是分类 + 项目名（+ 可选余额方向）", async () => {
    const { calls } = stubSubjects();
    await open();
    fireEvent.click(screen.getByTestId("accounting-subject-create"));
    await screen.findByTestId("action-dialog");
    // 分类是必填维度，弹窗里预填第一个分类，避免财务建出「没有分类」的科目。
    expect(screen.getByTestId("action-field-category")).toHaveTextContent("资产类");
    fireEvent.change(screen.getByTestId("action-field-name"), { target: { value: "展会物料费" } });
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.endsWith(EP.subjects)).length).toBe(1));
    const posted = calls.find((call) => call.method === "POST" && call.url.endsWith(EP.subjects))!;
    expect(JSON.parse(String(posted.body))).toEqual({ category: "资产类", name: "展会物料费" });
  });

  it("选了余额方向才带上该字段（不填就不传，由后端存 null）", async () => {
    const { calls } = stubSubjects();
    await open();
    fireEvent.click(screen.getByTestId("accounting-subject-create"));
    await screen.findByTestId("action-dialog");
    fireEvent.change(screen.getByTestId("action-field-name"), { target: { value: "展会物料费" } });
    fireEvent.click(screen.getByTestId("action-field-balance_direction"));
    fireEvent.click(await screen.findByRole("option", { name: "贷" }));
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.endsWith(EP.subjects)).length).toBe(1));
    const posted = calls.find((call) => call.method === "POST" && call.url.endsWith(EP.subjects))!;
    expect(JSON.parse(String(posted.body))).toEqual({ category: "资产类", name: "展会物料费", balance_direction: "贷" });
  });

  it("重名时把后端的 422 原因显示在弹窗里", async () => {
    stubSubjects((url, call) => (call.method === "POST" && url.endsWith(EP.subjects) ? apiErr(422, "ACCOUNTING_SUBJECT_DUPLICATED", "「资产类」下已经有「备用金」这个科目") : undefined));
    await open();
    fireEvent.click(screen.getByTestId("accounting-subject-create"));
    await screen.findByTestId("action-dialog");
    fireEvent.change(screen.getByTestId("action-field-name"), { target: { value: "备用金" } });
    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("已经有「备用金」这个科目");
  });
});

describe("会计科目 · 编辑与停用", () => {
  it("编辑预填当前值，PATCH 到该科目地址（改名 + 换分类 + 改余额方向）", async () => {
    const { calls } = stubSubjects();
    await open();
    fireEvent.click(screen.getByTestId("accounting-subject-edit-sub-2"));
    await screen.findByTestId("action-dialog");
    expect(screen.getByTestId("action-field-category")).toHaveTextContent("损益类");
    expect(screen.getByTestId("action-field-name")).toHaveValue("主营业务收入");

    fireEvent.change(screen.getByTestId("action-field-name"), { target: { value: "主营业务收入（出口）" } });
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").length).toBe(1));
    const patched = calls.find((call) => call.method === "PATCH")!;
    expect(patched.url).toContain(`${EP.subjects}/sub-2`);
    expect(JSON.parse(String(patched.body))).toEqual({ category: "损益类", name: "主营业务收入（出口）", balance_direction: "借" });
  });

  it("余额方向选「（不填）」时送空串（后端按清空处理，undefined 会被当成不改）", async () => {
    const { calls } = stubSubjects();
    await open();
    fireEvent.click(screen.getByTestId("accounting-subject-edit-sub-2"));
    await screen.findByTestId("action-dialog");
    fireEvent.click(screen.getByTestId("action-field-balance_direction"));
    fireEvent.click(await screen.findByRole("option", { name: "（不填）" }));
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").length).toBe(1));
    expect(JSON.parse(String(calls.find((call) => call.method === "PATCH")!.body)).balance_direction).toBe("");
  });

  it("停用科目：PATCH is_active=false，并说明历史流水仍显示这个科目", async () => {
    const { calls } = stubSubjects();
    await open();
    fireEvent.click(screen.getByTestId("accounting-subject-toggle-sub-2"));
    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").length).toBe(1));
    const patched = calls.find((call) => call.method === "PATCH")!;
    expect(patched.url).toContain(`${EP.subjects}/sub-2`);
    expect(JSON.parse(String(patched.body))).toEqual({ is_active: false });
  });

  it("非管理员停用科目：把后端 403 提示出来（维护科目仅管理员可用）", async () => {
    stubSubjects((url, call) => (call.method === "PATCH" && url.includes(EP.subjects) ? apiErr(403, "FORBIDDEN", "需要管理员权限") : undefined));
    await open();
    fireEvent.click(screen.getByTestId("accounting-subject-toggle-sub-2"));
    expect(await screen.findByText(/需要管理员权限/)).toBeInTheDocument();
  });
});

describe("会计科目 · 删除", () => {
  it("删除未被引用的科目：DELETE 到该科目地址", async () => {
    const { calls } = stubSubjects();
    await open();
    fireEvent.click(screen.getByTestId("accounting-subject-delete-sub-3"));
    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE").length).toBe(1));
    expect(calls.find((call) => call.method === "DELETE")!.url).toContain(`${EP.subjects}/sub-3`);
  });

  it("已被业务单据引用时删除被拒：把「请改为停用」的原因原样告诉财务", async () => {
    stubSubjects((url, call) => (call.method === "DELETE" && url.includes(EP.subjects) ? apiErr(422, "ACCOUNTING_SUBJECT_IN_USE", "该科目已被业务单据引用，不能删除；请改为停用") : undefined));
    await open();
    fireEvent.click(screen.getByTestId("accounting-subject-delete-sub-2"));
    expect(await screen.findByText(/该科目已被业务单据引用，不能删除；请改为停用/)).toBeInTheDocument();
  });
});

/**
 * 建账期初余额（2026-09-24：用户「1,3,4 都要」的第 ③ 件）。
 *
 * 三条：读出来的是已有期初（含日期与试算平衡）、整批保存走 PUT（没出现的行由服务层软删）、
 * 借贷不平**不拦**（财务可能分批录）但差额必须显示出来。
 */
describe("会计科目 · 建账期初余额", () => {
  it("列出已有期初（建账日期 / 科目 / 借或贷 / 金额）并显示借贷合计", async () => {
    stubSubjects();
    await open();
    const panel = within(screen.getByTestId("opening-balance-panel"));
    expect((panel.getByTestId("opening-balance-date") as HTMLInputElement).value).toBe("2026-09-01");
    expect(panel.getByTestId("opening-balance-row-0")).toBeInTheDocument();
    expect(panel.getByTestId("opening-balance-totals")).toHaveTextContent("借方合计 3000");
    expect(panel.getByTestId("opening-balance-totals")).toHaveTextContent("借贷平衡");
  });

  it("整批保存：新增一行后 PUT 出去，请求体带建账日期、币种与**全部**行", async () => {
    const { calls } = stubSubjects((url, call) => (call.method === "PUT" && url.includes(EP.openings)
      ? apiOk({ as_of_date: "2026-09-01", currency: "CNY", saved: 3, removed: 0, totals: { debit: "3000", credit: "3000", difference: "0", balanced: true } })
      : undefined));
    await open();
    const panel = within(screen.getByTestId("opening-balance-panel"));

    await userEvent.click(panel.getByTestId("opening-balance-add"));
    await pickOption(panel, "opening-balance-subject-2", /损益类 \/ 主营业务收入/);
    fireEvent.change(panel.getByTestId("opening-balance-amount-2"), { target: { value: "500" } });
    fireEvent.click(panel.getByTestId("opening-balance-save"));

    await waitFor(() => expect(calls.filter((call) => call.method === "PUT").length).toBe(1));
    const body = JSON.parse(String(calls.find((call) => call.method === "PUT")!.body));
    expect(body.as_of_date).toBe("2026-09-01");
    expect(body.currency).toBe("CNY");
    expect(body.rows).toHaveLength(3);
    expect(body.rows[2]).toMatchObject({ subject_key: "损益类/主营业务收入", direction: "debit", amount: "500" });
  });

  it("缺科目或金额拦在保存前（一次说完）；整行都没填的空行直接丢掉、不挡保存", async () => {
    const { calls } = stubSubjects();
    await open();
    const panel = within(screen.getByTestId("opening-balance-panel"));

    // 整行空着的新行：与收/付款单、凭证编辑器同一约定 —— 丢掉，不报「第 3 行请选科目」。
    await userEvent.click(panel.getByTestId("opening-balance-add"));
    fireEvent.click(panel.getByTestId("opening-balance-save"));
    await waitFor(() => expect(calls.filter((call) => call.method === "PUT").length).toBe(1));
    expect(JSON.parse(String(calls.find((call) => call.method === "PUT")!.body)).rows).toHaveLength(2);
  });

  it("填了金额却没选科目：拦在保存前并指名第几行（不发注定 422 的请求）", async () => {
    const { calls } = stubSubjects();
    await open();
    const panel = within(screen.getByTestId("opening-balance-panel"));

    await userEvent.click(panel.getByTestId("opening-balance-add"));
    fireEvent.change(panel.getByTestId("opening-balance-amount-2"), { target: { value: "500" } });
    fireEvent.click(panel.getByTestId("opening-balance-save"));

    expect(await panel.findByTestId("opening-balance-error")).toHaveTextContent("第 3 行请选择会计科目");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });
});

/**
 * 期末汇率（2026-09-24：用户「1,3,4 都要」的第 ④ 件）。
 *
 * 三条：读出来的是这一期已维护的汇率与「报表会回退用哪一期」的提示、整批保存走 PUT
 * （没出现的币种由服务层软删）、本币与重复币种拦在保存前（不发注定 422 的请求）。
 */
describe("会计科目 · 期末汇率", () => {
  it("列出这一期已维护的汇率，并说明没维护时会回退用哪一期折算", async () => {
    stubSubjects();
    await open();
    const panel = within(screen.getByTestId("exchange-rate-panel"));
    expect((panel.getByTestId("exchange-rate-period") as HTMLInputElement).value).toBe("2026-09");
    expect((panel.getByTestId("exchange-rate-currency-0") as HTMLInputElement).value).toBe("USD");
    expect((panel.getByTestId("exchange-rate-rate-0") as HTMLInputElement).value).toBe("7.1234");
    expect(panel.getByTestId("exchange-rate-summary")).toHaveTextContent("本期 1 个币种");
    expect(panel.getByTestId("exchange-rate-periods")).toHaveTextContent("已维护：2026-09");
    expect(panel.getByTestId("exchange-rate-note")).toHaveTextContent("2026-09 的汇率已维护");
  });

  it("整批保存：新增一个币种后 PUT 出去，请求体带期间与**全部**币种（没出现的由服务层软删）", async () => {
    const { calls } = stubSubjects((url, call) => (call.method === "PUT" && url.includes(EP.rates)
      ? apiOk({ period: "2026-09", saved: 2, removed: 0, rows: [] })
      : undefined));
    await open();
    const panel = within(screen.getByTestId("exchange-rate-panel"));

    await userEvent.click(panel.getByTestId("exchange-rate-add"));
    fireEvent.change(panel.getByTestId("exchange-rate-currency-1"), { target: { value: "hkd" } });
    fireEvent.change(panel.getByTestId("exchange-rate-rate-1"), { target: { value: "0.91" } });
    fireEvent.click(panel.getByTestId("exchange-rate-save"));

    await waitFor(() => expect(calls.filter((call) => call.method === "PUT").length).toBe(1));
    const body = JSON.parse(String(calls.find((call) => call.method === "PUT")!.body));
    expect(body.period).toBe("2026-09");
    expect(body.rows).toHaveLength(2);
    expect(body.rows[1]).toMatchObject({ currency: "HKD", rate: "0.91" });
  });

  it("本币不需要汇率、同币种不许重复：拦在保存前并指名第几行", async () => {
    const { calls } = stubSubjects();
    await open();
    const panel = within(screen.getByTestId("exchange-rate-panel"));

    await userEvent.click(panel.getByTestId("exchange-rate-add"));
    fireEvent.change(panel.getByTestId("exchange-rate-currency-1"), { target: { value: "usd" } });
    fireEvent.change(panel.getByTestId("exchange-rate-rate-1"), { target: { value: "7.2" } });
    await userEvent.click(panel.getByTestId("exchange-rate-add"));
    fireEvent.change(panel.getByTestId("exchange-rate-currency-2"), { target: { value: "CNY" } });
    fireEvent.change(panel.getByTestId("exchange-rate-rate-2"), { target: { value: "1" } });
    fireEvent.click(panel.getByTestId("exchange-rate-save"));

    const error = await panel.findByTestId("exchange-rate-error");
    expect(error).toHaveTextContent("第 2 行币种 USD 重复了");
    expect(error).toHaveTextContent("第 3 行是本币 CNY：本币不需要汇率");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });
});

/**
 * 科目类目管理（2026-11-07 用户：「允许用户自行对会计科目的类目进行增删改查」）。
 *
 * 类目从「科目行上的一个字符串」升级成一等实体，页面多一块面板：内置五类只读（三大报表按名字硬编码
 * 匹配，改名会让报表静默变空）、自建类目可改名/删除（有科目时后端拒绝）、id=null 的历史类目只可见。
 * 同时科目筛选与科目弹窗的分类下拉都改为读这份新清单（含历史类目）。
 */
describe("会计科目 · 类目管理", () => {
  it("类目面板渲染类目/科目数/类型/审计列，并显示类目总数", async () => {
    stubSubjects();
    await open();

    expect(screen.getByTestId("accounting-subject-category-panel")).toBeInTheDocument();
    expect(screen.getByTestId("accounting-subject-category-count")).toHaveTextContent("共 7 个类目");
    // 新面板在会计科目表格之前（财务先维护清单、再维护科目）。
    const categoryTable = categoryPanel().getByTestId("data-table");
    const subjectTableElement = screen.getByTestId("accounting-subject-table");
    expect(categoryTable.compareDocumentPosition(subjectTableElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(categoryPanel().getAllByRole("columnheader").map((header) => header.textContent)).toEqual(
      ["类目", "科目数", "类型", "创建人", "最后修改人", "操作"],
    );
    // 科目数 = 「启用 x / 共 y」：停用科目也占类目，财务要看得出「真的空」还是「只剩停用」。
    expect(categoryRow("资产类").getByText("启用 1 / 共 1")).toBeInTheDocument();
    expect(categoryRow("资产类").getByText("内置")).toBeInTheDocument();
    expect(categoryRow("损益类").getByText("启用 1 / 共 2")).toBeInTheDocument();
    expect(categoryRow("共同类").getByText("自建")).toBeInTheDocument();
    // 审计列由 auditColumns() 提供（守卫要求）：创建人 / 最后修改人两列都能取到「系统」。
    expect(categoryRow("资产类").getAllByText("系统").length).toBeGreaterThan(0);
  });

  it("内置五类没有改名/删除按钮，只显示「不可改」标签", async () => {
    stubSubjects();
    await open();

    const builtIn = categoryRow("资产类");
    expect(builtIn.queryByRole("button")).toBeNull();
    expect(builtIn.getByTestId("accounting-subject-category-system-资产类")).toHaveTextContent("不可改");

    // 自建类目才有操作按钮。
    expect(categoryRow("共同类").getByTestId("accounting-subject-category-rename-cat-custom")).toHaveTextContent("改名");
    expect(categoryRow("共同类").getByTestId("accounting-subject-category-delete-cat-custom")).toHaveTextContent("删除");
  });

  it("新增类目：POST 到新接口、body 只有 name，成功后提示并重新拉取清单", async () => {
    const { calls } = stubSubjects();
    await open();

    fireEvent.click(screen.getByTestId("accounting-subject-category-create"));
    await screen.findByTestId("action-dialog");
    expect(screen.getByRole("heading", { name: "新增科目类目" })).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("action-field-name"), { target: { value: "共同类2" } });
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    const postCategory = () => calls.find((call) => call.method === "POST" && call.url.endsWith(EP.subjectCategories));
    await waitFor(() => expect(postCategory()).toBeDefined());
    expect(JSON.parse(String(postCategory()!.body))).toEqual({ name: "共同类2" });
    expect(await screen.findByText("已新增科目类目「共同类2」")).toBeInTheDocument();
    // 成功后必须重新拉取类目清单：GET 被调用 2 次（首屏 + 新增后；POST 同地址，按 method 区分）。
    await waitFor(() => expect(calls.filter((call) => call.method === "GET" && call.url.endsWith(EP.subjectCategories))).toHaveLength(2));
  });

  it("改名：预填当前名称，PATCH 到类目 /:id（只带 name）", async () => {
    const { calls } = stubSubjects();
    await open();

    fireEvent.click(screen.getByTestId("accounting-subject-category-rename-cat-custom"));
    await screen.findByTestId("action-dialog");
    expect(screen.getByRole("heading", { name: "改名科目类目：共同类" })).toBeInTheDocument();
    expect(screen.getByTestId("action-field-name")).toHaveValue("共同类");
    fireEvent.change(screen.getByTestId("action-field-name"), { target: { value: "共同类（新）" } });
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    const patchCategory = () => calls.find((call) => call.method === "PATCH" && call.url.includes(EP.subjectCategories));
    await waitFor(() => expect(patchCategory()).toBeDefined());
    expect(patchCategory()!.url).toContain(`${EP.subjectCategories}/cat-custom`);
    expect(JSON.parse(String(patchCategory()!.body))).toEqual({ name: "共同类（新）" });
    expect(await screen.findByText("已将类目「共同类」改名为「共同类（新）」")).toBeInTheDocument();
  });

  it("删除：二次确认（说明有科目时先改类目）后 DELETE 到 /:id，成功提示", async () => {
    const { calls } = stubSubjects();
    await open();

    fireEvent.click(screen.getByTestId("accounting-subject-category-delete-cat-custom"));
    await screen.findByTestId("action-dialog");
    expect(screen.getByRole("heading", { name: "删除科目类目：共同类" })).toBeInTheDocument();
    expect(screen.getByTestId("action-dialog")).toHaveTextContent("只在类目下没有科目时可删");
    expect(screen.getByTestId("action-dialog-submit")).toHaveTextContent("删除");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    const deleteCategory = () => calls.find((call) => call.method === "DELETE" && call.url.includes(EP.subjectCategories));
    await waitFor(() => expect(deleteCategory()).toBeDefined());
    expect(deleteCategory()!.url).toContain(`${EP.subjectCategories}/cat-custom`);
    expect(await screen.findByText("已删除科目类目「共同类」")).toBeInTheDocument();
  });

  it("删除被拒：后端 422 的 message 原样提示（有科目请先改类目）", async () => {
    stubSubjects((url, call) => (call.method === "DELETE" && url.includes(EP.subjectCategories)
      ? apiErr(422, "ACCOUNTING_SUBJECT_CATEGORY_IN_USE", "类目「共同类」下还有 3 个科目，请先把这些科目改到其它类目")
      : undefined));
    await open();

    fireEvent.click(screen.getByTestId("accounting-subject-category-delete-cat-custom"));
    await screen.findByTestId("action-dialog");
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    // 不吞成「删除失败」：具体还有几个科目、下一步做什么，都在后端 message 里。
    expect(await screen.findByText("类目「共同类」下还有 3 个科目，请先把这些科目改到其它类目")).toBeInTheDocument();
  });

  it("id=null 的历史类目可见（否则旧科目选不到自己的分类），但没有操作按钮", async () => {
    stubSubjects();
    await open();

    const history = categoryRow("未分类");
    expect(history.getByText("历史")).toBeInTheDocument();
    expect(history.getByTestId("accounting-subject-category-history-未分类")).toBeInTheDocument();
    expect(history.queryByRole("button")).toBeNull();
  });

  it("分类筛选的选项来自新类目清单（含历史类目，顺序同接口）", async () => {
    stubSubjects();
    await open();

    fireEvent.click(screen.getByTestId("accounting-subject-filter-category"));
    const filterOptions = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(filterOptions).toEqual(["全部分类", "资产类", "负债类", "成本类", "所有者权益类", "损益类", "共同类", "未分类"]);
  });

  it("新增科目弹窗不出现历史类目（选中它必然被后端 422，不能给用户注定失败的选项）", async () => {
    stubSubjects();
    await open();

    fireEvent.click(screen.getByTestId("accounting-subject-create"));
    await screen.findByTestId("action-dialog");
    // 默认预填第一个「有实体」的类目，与清单顺序一致。
    expect(screen.getByTestId("action-field-category")).toHaveTextContent("资产类");
    fireEvent.click(screen.getByTestId("action-field-category"));
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual(["资产类", "负债类", "成本类", "所有者权益类", "损益类", "共同类"]);
    expect(options).not.toContain("未分类");
  });

  it("编辑历史类目上的科目时，分类下拉仍含历史类目（不换分类也能改名字/余额方向）", async () => {
    // 只在这一条用例里把「未分类」的历史科目加进列表：默认夹具保持 3 条，不影响既有计数断言。
    const historySubject = { id: "sub-9", category: "未分类", name: "历史科目", balanceDirection: null, sortOrder: 999, isActive: true };
    stubSubjects((url, call) => (call.method === "GET" && url.includes(EP.subjects) && !url.includes("/categories")
      ? apiOk([...SUBJECTS, historySubject])
      : undefined));
    await open();

    fireEvent.click(screen.getByTestId("accounting-subject-edit-sub-9"));
    await screen.findByTestId("action-dialog");
    // 编辑必须保留历史类目：旧科目不换分类也要能改名字/余额方向（后端 update 只在分类真的变了时才校验）。
    expect(screen.getByTestId("action-field-category")).toHaveTextContent("未分类");
    fireEvent.click(screen.getByTestId("action-field-category"));
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toContain("未分类");
  });

  it("首屏加载期间类目面板显示「加载中」，不闪「共 0 个类目」或「暂无科目类目」", async () => {
    const gate = deferred<Response>();
    stubApi((url) => {
      if (url.includes(EP.subjectCategories)) return gate.promise;
      if (url.includes(EP.subjects)) return apiOk(SUBJECTS);
      if (url.includes(EP.openings)) return apiOk(OPENINGS);
      if (url.includes(EP.rates)) return apiOk(RATES);
      return apiOk([]);
    });

    render(<><AccountingSubjectWorkspace /><Toaster /></>);

    expect(await screen.findByTestId("accounting-subject-category-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("accounting-subject-category-count")).toBeNull();
    expect(screen.queryByText("暂无科目类目")).toBeNull();

    gate.resolve(apiOk(CATEGORY_ROWS));
    await waitFor(() => expect(screen.getByTestId("accounting-subject-category-count")).toHaveTextContent("共 7 个类目"));
    expect(screen.queryByTestId("accounting-subject-category-loading")).toBeNull();
  });

  it("类目接口失败时面板显示错误原文，不显示「0 个类目」与迁移指引", async () => {
    stubApi(() => apiErr(500, "INTERNAL_ERROR", "服务器内部错误"));

    render(<><AccountingSubjectWorkspace /><Toaster /></>);

    expect(await screen.findByTestId("accounting-subject-category-error")).toHaveTextContent("服务器内部错误");
    expect(screen.queryByTestId("accounting-subject-category-count")).toBeNull();
    // 误导性文案（把网络/权限问题说成数据库没迁移）不能在失败态出现。
    expect(screen.queryByText("暂无科目类目")).toBeNull();
    expect(screen.queryByText(/请先执行数据库迁移/)).toBeNull();
  });
});
