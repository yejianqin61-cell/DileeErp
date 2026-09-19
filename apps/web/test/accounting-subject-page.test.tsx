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
import { afterEach, describe, expect, it, vi } from "vitest";
import AccountingSubjectWorkspace from "../components/finance/accounting-subject-workspace";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  subjects: "/api/v1/finance/accounting-subjects",
  categories: "/api/v1/finance/accounting-subjects/categories",
};

const SUBJECTS = [
  { id: "sub-1", category: "资产类", name: "库存现金（备用金）", balanceDirection: "借", sortOrder: 10, isActive: true },
  { id: "sub-2", category: "损益类", name: "主营业务收入", balanceDirection: "借", sortOrder: 770, isActive: true },
  { id: "sub-3", category: "损益类", name: "销售费 运费", balanceDirection: null, sortOrder: 850, isActive: false },
];

const CATEGORIES = ["资产类", "负债类", "成本类", "所有者权益类", "损益类"];

function stubSubjects(extra?: (url: string, call: StubbedCall) => Response | undefined) {
  const calls = stubApi((url, call) => {
    const injected = extra?.(url, call);
    if (injected) return injected;
    // categories 必须排在 subjects 前面判断：它的地址以 subjects 为前缀。
    if (url.includes(EP.categories)) return apiOk(CATEGORIES);
    if (url.includes(EP.subjects)) return apiOk(SUBJECTS);
    return apiOk([]);
  });
  return { calls };
}

async function open() {
  render(<><AccountingSubjectWorkspace /><Toaster /></>);
  await screen.findByText("主营业务收入");
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
    expect(calls.some((call) => call.url.endsWith(EP.categories))).toBe(true);

    const table = screen.getByTestId("data-table");
    const row = within(table).getAllByTestId("data-table-row")[0];
    expect(within(row).getByText("资产类")).toBeInTheDocument();
    expect(within(row).getByText("库存现金（备用金）")).toBeInTheDocument();
    expect(within(row).getByText("借")).toBeInTheDocument();
    expect(within(row).getByText("启用")).toBeInTheDocument();
  });

  it("停用的科目仍然列出来（否则历史流水上的科目名会消失）；没有余额方向的显示 -", async () => {
    stubSubjects();
    await open();
    const table = screen.getByTestId("data-table");
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
    await waitFor(() => expect(within(screen.getByTestId("data-table")).getAllByTestId("data-table-row")).toHaveLength(2));
    expect(within(screen.getByTestId("data-table")).queryByText("库存现金（备用金）")).toBeNull();

    fireEvent.change(screen.getByTestId("accounting-subject-search"), { target: { value: "销售费" } });
    await waitFor(() => expect(within(screen.getByTestId("data-table")).getAllByTestId("data-table-row")).toHaveLength(1));
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
