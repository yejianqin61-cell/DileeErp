// 财务报表页（components/finance/finance-report-workspace.tsx）行为测试。
//
// 这一页的核心承诺是**「页面里看到的」与「导出的」是同一批数据、同一套筛选**，
// 因此测试的重点不是"渲染了表格"，而是：
//   1) 查询用的是服务端筛选参数（不是本地过滤）；
//   2) 导出带的是**已生效**的筛选条件，而不是输入框里还没查询的草稿；
//   3) 留空的格子显示为「-」（系统没有这个字段），而不是看起来像坏了；
//   4) 导出的文件名、行数提示、合计与后端返回一致。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FinanceReportWorkspace from "../components/finance/finance-report-workspace";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, stubApi, type StubbedCall } from "./helpers/api-stub";

const EP = {
  sales: "/api/v1/finance/reports/sales-reconciliation-detail",
  purchase: "/api/v1/finance/reports/purchase-reconciliation-detail",
  summary: "/api/v1/finance/reports/sales-reconciliation-summary",
  profit: "/api/v1/finance/reports/sales-gross-profit",
  cashDetail: "/api/v1/finance/reports/cash-flow-detail",
  cashSummary: "/api/v1/finance/reports/cash-flow-summary",
  forex: "/api/v1/finance/reports/forex-receipts",
  subjects: "/api/v1/finance/accounting-subjects",
  customers: "/api/v1/customers",
  suppliers: "/api/v1/suppliers",
  currencies: "/api/v1/dictionaries/currency/items",
};

/**
 * 报表端点一律带查询串，所以不能用 helpers 里的 `callsTo`（它按 `endsWith` 匹配）。
 * `previews` 只数预览请求，`xlsxCalls` 只数导出请求。
 */
const previews = (calls: StubbedCall[], endpoint: string) => calls.filter((call) => call.url.includes(endpoint) && !call.url.includes(".xlsx"));
const xlsxCalls = (calls: StubbedCall[]) => calls.filter((call) => call.url.includes(".xlsx"));

/** 后端预览返回的形状（与导出共用同一份 ReportTable）。 */
function salesTable(overrides: Record<string, unknown> = {}) {
  return {
    sheet_name: "销售对账明细",
    columns: [
      { header: "日期", num_fmt: null, align: null },
      { header: "销售单号", num_fmt: null, align: null },
      { header: "产品代码", num_fmt: null, align: null },
      { header: "金额", num_fmt: "0.####", align: null },
      { header: "金额(本)", num_fmt: "0.####", align: null },
    ],
    rows: [
      ["2026-09-07", "XSDD2026090700001", null, 1862.024, 12475.56],
      ["2026-09-14", "XSDD2026091400001", null, 9600, 9600],
    ],
    total_columns: [3, 4],
    totals: ["合计", null, null, 11462.024, 22075.56],
    footnotes: [],
    ...overrides,
  };
}

function purchaseTable() {
  return {
    sheet_name: "采购对账明细",
    columns: [
      { header: "日期", num_fmt: null, align: null },
      { header: "采购单号", num_fmt: null, align: null },
      { header: "金额", num_fmt: "0.####", align: null },
    ],
    rows: [["2026-09-08", "CGDH1319", 4158]],
    total_columns: [2],
    totals: ["合计", null, 4158],
    footnotes: [],
  };
}

/** 二期：销售对账汇总表（按销售单汇总）。 */
function summaryTable() {
  return {
    sheet_name: "销售对账汇总",
    columns: [
      { header: "日期", num_fmt: null, align: null },
      { header: "客户名称", num_fmt: null, align: null },
      { header: "单号", num_fmt: null, align: null },
      { header: "销售金额", num_fmt: "0.####", align: null },
      { header: "调整金额", num_fmt: "0.####", align: null },
      { header: "税额", num_fmt: "0.####", align: null },
      { header: "已收金额", num_fmt: "0.####", align: null },
      { header: "开票金额", num_fmt: "0.####", align: null },
      { header: "欠款", num_fmt: "0.####", align: null },
    ],
    rows: [["2026-09-30", "中谷ZG", "XSDD2026060500002", 24525, -500, null, 10000, null, 14025]],
    total_columns: [3, 4, 6, 8],
    totals: ["合计", null, null, 24525, -500, null, 10000, null, 14025],
    footnotes: [],
  };
}

/** 二期：销售利润报表(毛利)，带表尾说明。 */
function profitTable(footnotes: string[] = []) {
  return {
    sheet_name: "销售利润(毛利)",
    columns: [
      { header: "日期", num_fmt: null, align: null },
      { header: "单号", num_fmt: null, align: null },
      { header: "客户名称", num_fmt: null, align: null },
      { header: "销售金额", num_fmt: "0.####", align: null },
      { header: "成本金额", num_fmt: "0.####", align: null },
      { header: "销售利润", num_fmt: "0.####", align: null },
    ],
    rows: [["2026-06-05", "XSDD2026060500002", "中谷ZG", 24525, 10000, 14525]],
    total_columns: [3, 4, 5],
    totals: ["合计", null, null, 24525, 10000, 14525],
    footnotes,
  };
}

/** 三期：收支明细表（一行一条流水，收入/支出两列，没有的那边写 0）。 */
function cashDetailTable() {
  return {
    sheet_name: "收支明细",
    columns: [
      { header: "日期", num_fmt: null, align: null },
      { header: "对方名称", num_fmt: null, align: null },
      { header: "币种", num_fmt: null, align: null },
      { header: "收入", num_fmt: "0.####", align: null },
      { header: "支出", num_fmt: "0.####", align: null },
      { header: "结算方式", num_fmt: null, align: null },
    ],
    rows: [
      ["2026-09-14", "兴田", "人民币", 0, 2900, "转账--农业银行5706"],
      ["2026-09-14", "中谷ZG", "美元", 1000, 0, "转账--中国银行（美元）7624"],
    ],
    total_columns: [],
    totals: null,
    footnotes: [],
  };
}

/** 三期：收支汇总表（项目 × 币种，每个币种段末给该币种合计）。 */
function cashSummaryTable() {
  return {
    sheet_name: "收支汇总",
    columns: [
      { header: "项目", num_fmt: null, align: null },
      { header: "币种", num_fmt: null, align: null },
      { header: "收入", num_fmt: "0.####", align: null },
      { header: "支出", num_fmt: "0.####", align: null },
    ],
    rows: [
      ["备用金", "人民币", 0, 0],
      ["货款", "人民币", 0, 2900],
      ["合计", "人民币", 0, 2900],
      ["货款", "美元", 5428, 0],
      ["合计", "美元", 5428, 0],
    ],
    total_columns: [],
    totals: null,
    footnotes: ["本表按币种分行、不跨币种相加：每个币种一段，段末的「合计」只统计该币种。"],
  };
}

/**
 * 四期：外汇一览表（老表 `example/财务/外汇一览表.xlsx`）。
 *
 * 导出文件里有两张工作表，页面只预览明细那张 —— 所以响应里带 `extra_sheets`，
 * 页面必须把它显示出来（不提示的话财务会以为导出的文件只有明细一张表）。
 */
function forexTable() {
  return {
    sheet_name: "外汇一览",
    columns: [
      { header: "客户", num_fmt: null, align: null },
      { header: "币种", num_fmt: null, align: null },
      { header: "订单号", num_fmt: null, align: null },
      { header: "跟单", num_fmt: null, align: null },
      { header: "货款金额", num_fmt: "0.####", align: null },
      { header: "定金金额", num_fmt: "0.####", align: null },
      { header: "汇入总金额", num_fmt: "0.####", align: null },
      { header: "欠尾款", num_fmt: "0.####", align: null },
      { header: "是否完结", num_fmt: null, align: null },
    ],
    rows: [
      ["中谷", "美元", "DL260002", null, 3100, 620, 620, 2480, "未结清"],
      ["家百纳", "美元", "DL260022", null, 45063.55, null, 45063.55, 0, "结清"],
    ],
    total_columns: [],
    totals: null,
    footnotes: ["本表按币种分行、不跨币种相加（同一客户既有美元又有人民币时会出现多行）。"],
    extra_sheets: [{ sheet_name: "客户汇总", row_count: 3 }],
  };
}

function xlsxResponse(bytes: number[] = [0x50, 0x4b, 0x03, 0x04]) {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  });
}

type Download = { blob: Blob; url: string };
let downloads: Download[] = [];
let revokedUrls: string[] = [];
let anchorClicks: Array<{ download: string; href: string }> = [];

/** 与 payroll-export-panel.test.tsx 同一套下载断言三件套。 */
function captureDownloads() {
  downloads = [];
  revokedUrls = [];
  anchorClicks = [];
  let seq = 0;
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      const url = `blob:http://localhost/${++seq}`;
      downloads.push({ blob, url });
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => { revokedUrls.push(url); }),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    anchorClicks.push({ download: this.getAttribute("download") ?? "", href: this.getAttribute("href") ?? "" });
  });
}

afterEach(() => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

type Handler = (url: string) => Response | undefined;

function stubReports(options: { sales?: unknown; purchase?: unknown; summary?: unknown; profit?: unknown; cashDetail?: unknown; cashSummary?: unknown; forex?: unknown; extra?: Handler } = {}) {
  return stubApi((url) => {
    const injected = options.extra?.(url);
    if (injected) return injected;
    if (url.includes("/finance/reports/") && url.includes(".xlsx")) return xlsxResponse();
    if (url.includes(EP.sales)) return apiOk(options.sales ?? salesTable());
    if (url.includes(EP.purchase)) return apiOk(options.purchase ?? purchaseTable());
    if (url.includes(EP.summary)) return apiOk(options.summary ?? summaryTable());
    if (url.includes(EP.profit)) return apiOk(options.profit ?? profitTable());
    if (url.includes(EP.cashDetail)) return apiOk(options.cashDetail ?? cashDetailTable());
    if (url.includes(EP.cashSummary)) return apiOk(options.cashSummary ?? cashSummaryTable());
    if (url.includes(EP.forex)) return apiOk(options.forex ?? forexTable());
    // 会计科目表（分类 = 科目类别，项目 = 科目名称）：报表筛选的「分类 / 会计科目」两个下拉都取自它。
    if (url.includes(EP.subjects)) return apiOk([
      { id: "subject-1", category: "损益类", name: "主营业务收入", balanceDirection: "贷", sortOrder: 1, isActive: true },
      { id: "subject-2", category: "资产类", name: "备用金", balanceDirection: "借", sortOrder: 2, isActive: true },
    ]);
    if (url.includes(EP.customers)) return apiOk([{ id: "c-1", name: "Matthew Jackson" }]);
    if (url.includes(EP.suppliers)) return apiOk([{ id: "s-1", name: "碧江" }]);
    if (url.includes(EP.currencies)) return apiOk([{ key: "USD", label: "美元" }, { key: "CNY", label: "人民币" }]);
    return apiOk([]);
  });
}

async function open(node: React.ReactElement, testId: string) {
  render(<>{node}<Toaster /></>);
  await screen.findByTestId(testId);
}

const exportButton = () => screen.getByTestId("finance-report-export");
const searchButton = () => screen.getByTestId("finance-report-search");

describe("财务报表 · 加载与预览", () => {
  it("进入页面按服务端筛选参数取数，并渲染列名与行", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.sales).length).toBe(1));

    const request = previews(calls, EP.sales)[0];
    expect(request.method).toBe("GET");
    expect(request.url).toContain("from=");
    expect(request.url).toContain("to=");

    await screen.findByText("XSDD2026090700001");
    expect(screen.getByRole("columnheader", { name: "金额" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "金额(本)" })).toBeInTheDocument();
    expect(screen.getByTestId("finance-report-row-count")).toHaveTextContent("共 2 行");
  });

  it("系统没有的字段（值为 null）显示为「-」，不写 0 也不留空格子", async () => {
    captureDownloads();
    stubReports();
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    const table = await screen.findByTestId("data-table");
    const firstRow = within(table).getAllByTestId("data-table-row")[0];
    expect(within(firstRow).getAllByText("-").length).toBe(1);
    expect(within(firstRow).getByText("1862.024")).toBeInTheDocument();
  });

  it("合计行与导出的合计同值，且只列声明了合计的列", async () => {
    captureDownloads();
    stubReports();
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    const totals = await screen.findByTestId("finance-report-totals");
    expect(totals).toHaveTextContent("金额 11462.024");
    expect(totals).toHaveTextContent("金额(本) 22075.56");
    expect(totals).not.toHaveTextContent("销售单号");
  });

  it("展示七个报表子栏目（老表 6 份 + 外汇一览表），地址可收藏", async () => {
    captureDownloads();
    stubReports();
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    for (const key of ["sales-reconciliation-detail", "sales-reconciliation-summary", "purchase-reconciliation-detail", "sales-gross-profit", "cash-flow-detail", "cash-flow-summary", "forex-receipts"]) {
      expect(screen.getByTestId(`finance-tab-${key}`)).toHaveAttribute("href", `/finance/reports?tab=${key}`);
    }
  });

  it("没有数据时给出空态与「导出只有表头」的说明", async () => {
    captureDownloads();
    stubReports({ sales: salesTable({ rows: [], totals: null }) });
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    expect(await screen.findByTestId("empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("finance-report-row-count")).toHaveTextContent("共 0 行");
    expect(screen.queryByTestId("finance-report-totals")).toBeNull();
  });

  it("采购 tab 用供应商筛选，并打到采购对账明细端点", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="purchase-reconciliation-detail" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.purchase).length).toBe(1));
    expect(screen.getByTestId("finance-report-supplier")).toBeInTheDocument();
    expect(screen.queryByTestId("finance-report-customer")).toBeNull();
    expect(await screen.findByText("CGDH1319")).toBeInTheDocument();
  });

  it("列表上方的主导航说明里没有子栏目时也不崩（公式占位：sheet 名进标题）", async () => {
    captureDownloads();
    stubReports();
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    expect(screen.getByRole("heading", { name: "销售对账明细表" })).toBeInTheDocument();
  });
});

describe("财务报表 · 四期：外汇一览表", () => {
  it("外汇一览表：用客户筛选打到外汇端点，展示跟单留空的「-」与是否完结", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="forex-receipts" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.forex).length).toBe(1));

    // 期间按收款日期、客户是收束维度，所以用客户筛选（不是供应商、也没有收支方向的分类下拉）。
    expect(screen.getByTestId("finance-report-customer")).toBeInTheDocument();
    expect(screen.queryByTestId("finance-report-supplier")).toBeNull();
    expect(screen.queryByTestId("finance-report-category")).toBeNull();

    const table = await screen.findByTestId("data-table");
    expect(within(table).getByText("DL260002")).toBeInTheDocument();
    expect(within(table).getByText("未结清")).toBeInTheDocument();
    expect(within(table).getByText("结清")).toBeInTheDocument();
    // 「跟单」系统没有字段 → 第一行那一格是空的，页面显示「-」而不是看起来坏了。
    const firstRow = within(table).getAllByTestId("data-table-row")[0];
    expect(within(firstRow).getByText("-")).toBeInTheDocument();
    expect(screen.getByTestId("finance-report-row-count")).toHaveTextContent("共 2 行");
    // 没有合计列（一行一个币种，跨币种相加没有意义），所以不显示合计条。
    expect(screen.queryByTestId("finance-report-totals")).toBeNull();
  });

  it("导出文件里还有一张工作表时页面上要说清楚（否则以为导出只有明细）", async () => {
    captureDownloads();
    stubReports();
    await open(<FinanceReportWorkspace tab="forex-receipts" />, "page-finance-reports");
    const note = await screen.findByTestId("finance-report-extra-sheets");
    expect(note).toHaveTextContent("客户汇总");
    expect(note).toHaveTextContent("3 行");
  });

  it("导出外汇一览表：URL 带已生效的筛选，文件名是「迪礼ERP-外汇一览表.xlsx」", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="forex-receipts" />, "page-finance-reports");
    fireEvent.click(exportButton());
    await waitFor(() => expect(xlsxCalls(calls).length).toBe(1));
    expect(xlsxCalls(calls)[0].url).toContain(`${EP.forex}.xlsx`);
    await waitFor(() => expect(anchorClicks.length).toBe(1));
    expect(anchorClicks[0].download).toBe("迪礼ERP-外汇一览表.xlsx");
  });

  it("外汇一览表的表尾说明在页面上也看得到（不跨币种相加、跟单/手续费恒空）", async () => {
    captureDownloads();
    stubReports();
    await open(<FinanceReportWorkspace tab="forex-receipts" />, "page-finance-reports");
    const footnotes = await screen.findByTestId("finance-report-footnotes");
    expect(footnotes).toHaveTextContent("不跨币种相加");
  });

  it("没有其它工作表时不显示多 sheet 提示（普通报表不该多出一行）", async () => {
    captureDownloads();
    stubReports();
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    await screen.findByTestId("data-table");
    expect(screen.queryByTestId("finance-report-extra-sheets")).toBeNull();
  });
});

describe("财务报表 · 二期：销售对账汇总表与销售利润报表", () => {
  it("销售对账汇总表：打到汇总端点、用客户筛选、展示欠款列", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="sales-reconciliation-summary" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.summary).length).toBe(1));
    expect(screen.getByTestId("finance-report-customer")).toBeInTheDocument();
    expect(await screen.findByText("XSDD2026060500002")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "欠款" })).toBeInTheDocument();
    expect(screen.getByTestId("finance-report-totals")).toHaveTextContent("欠款 14025");
  });

  it("销售对账汇总表：系统没有的字段（税额/开票金额）在页面上显示为「-」", async () => {
    captureDownloads();
    stubReports();
    await open(<FinanceReportWorkspace tab="sales-reconciliation-summary" />, "page-finance-reports");
    const table = await screen.findByTestId("data-table");
    const row = within(table).getAllByTestId("data-table-row")[0];
    expect(within(row).getAllByText("-")).toHaveLength(2);
  });

  it("销售利润报表：打到利润端点、展示成本与利润列，并导出为对应文件名", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="sales-gross-profit" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.profit).length).toBe(1));
    expect(await screen.findByText("14525")).toBeInTheDocument();
    expect(screen.getByTestId("finance-report-totals")).toHaveTextContent("成本金额 10000");

    fireEvent.click(exportButton());
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(anchorClicks[0].download).toBe("迪礼ERP-销售利润报表(毛利).xlsx");
    expect(xlsxCalls(calls)[0].url.startsWith(`${EP.profit}.xlsx`)).toBe(true);
  });

  it("销售利润报表：缺采购价物料这类表尾说明必须在页面上也看得到（不能只在导出文件里）", async () => {
    captureDownloads();
    const footnotes = [
      "缺采购价物料（成本按 0 计入，毛利偏高）（1-1/1）：WPTM9 未知料",
      "没有 BOM 或 BOM 无明细的销售单（成本按 0 计入，毛利偏高）（1-1/1）：XSDD2026091500001",
    ];
    stubReports({ profit: profitTable(footnotes) });
    await open(<FinanceReportWorkspace tab="sales-gross-profit" />, "page-finance-reports");
    const block = await screen.findByTestId("finance-report-footnotes");
    expect(within(block).getByTestId("finance-report-footnote-0")).toHaveTextContent("WPTM9 未知料");
    expect(within(block).getByTestId("finance-report-footnote-1")).toHaveTextContent("没有 BOM");
  });

  it("没有表尾说明时不渲染说明区块", async () => {
    captureDownloads();
    stubReports();
    await open(<FinanceReportWorkspace tab="sales-gross-profit" />, "page-finance-reports");
    await screen.findByText("14525");
    expect(screen.queryByTestId("finance-report-footnotes")).toBeNull();
  });
});

describe("财务报表 · 三期：收支明细表与收支汇总表", () => {
  it("收支 tab 换成分类/会计科目/方向筛选：不带订单号与草稿（收支流水没有这两样）", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="cash-flow-detail" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.cashDetail).length).toBe(1));
    expect(screen.getByTestId("finance-report-subject")).toBeInTheDocument();
    expect(screen.getByTestId("finance-report-category")).toBeInTheDocument();
    expect(screen.getByTestId("finance-report-direction")).toBeInTheDocument();
    expect(screen.queryByTestId("finance-report-order-no")).toBeNull();
    expect(screen.queryByTestId("finance-report-include-draft")).toBeNull();
    expect(screen.queryByTestId("finance-report-customer")).toBeNull();
    expect(previews(calls, EP.cashDetail)[0].url).not.toContain("include_draft");
  });

  it("收支明细表：分类/会计科目按 category 与 subject_id 打到服务端（不再有 item_id）", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="cash-flow-detail" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.cashDetail).length).toBe(1));

    // 分类来自会计科目表的 category，会计科目的选项文案是「分类 / 科目名称」。
    fireEvent.click(screen.getByTestId("finance-report-category"));
    fireEvent.click(await screen.findByRole("option", { name: "损益类" }));
    fireEvent.click(screen.getByTestId("finance-report-subject"));
    fireEvent.click(await screen.findByRole("option", { name: "损益类 / 主营业务收入" }));
    fireEvent.click(searchButton());

    await waitFor(() => expect(previews(calls, EP.cashDetail).length).toBe(2));
    const query = previews(calls, EP.cashDetail)[1].url;
    expect(decodeURIComponent(query)).toContain("category=损益类");
    expect(query).toContain("subject_id=subject-1");
    expect(query).not.toContain("item_id");
  });

  it("收支明细表：收入/支出两列都在，没有的那一边显示 0（不是「-」）", async () => {
    captureDownloads();
    stubReports();
    await open(<FinanceReportWorkspace tab="cash-flow-detail" />, "page-finance-reports");
    const table = await screen.findByTestId("data-table");
    const first = within(table).getAllByTestId("data-table-row")[0];
    expect(within(first).getByText("2900")).toBeInTheDocument();
    expect(within(first).getAllByText("0").length).toBe(1);
    expect(screen.getByRole("columnheader", { name: "结算方式" })).toBeInTheDocument();
  });

  it("收支汇总表：按币种分行渲染，并显示「不跨币种相加」的说明；不出现跨币种合计", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="cash-flow-summary" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.cashSummary).length).toBe(1));
    const table = await screen.findByTestId("data-table");
    const rows = within(table).getAllByTestId("data-table-row");
    expect(rows).toHaveLength(5);
    expect(within(rows[2]).getByText("合计")).toBeInTheDocument();
    expect(within(rows[2]).getByText("2900")).toBeInTheDocument();
    expect(within(rows[4]).getByText("5428")).toBeInTheDocument();
    expect(screen.queryByTestId("finance-report-totals")).toBeNull();
    expect(screen.getByTestId("finance-report-footnotes")).toHaveTextContent("不跨币种相加");
  });

  it("收支汇总表导出：文件名对应，端点是 .xlsx", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="cash-flow-summary" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.cashSummary).length).toBe(1));
    fireEvent.click(exportButton());
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(anchorClicks[0].download).toBe("迪礼ERP-收支汇总表.xlsx");
    expect(xlsxCalls(calls)[0].url.startsWith(`${EP.cashSummary}.xlsx`)).toBe(true);
  });
});

describe("财务报表 · 查询与导出", () => {
  it("改筛选后点「查询」才会重新取数（不会每敲一个字符打一次接口）", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.sales).length).toBe(1));

    fireEvent.change(screen.getByTestId("finance-report-order-no"), { target: { value: "SO-1" } });
    expect(previews(calls, EP.sales).length).toBe(1);

    fireEvent.click(searchButton());
    await waitFor(() => expect(previews(calls, EP.sales).length).toBe(2));
    expect(previews(calls, EP.sales)[1].url).toContain("order_no=SO-1");
  });

  it("导出带的是「已生效」的筛选条件，而不是输入框里还没查询的草稿", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.sales).length).toBe(1));

    fireEvent.change(screen.getByTestId("finance-report-order-no"), { target: { value: "SO-DRAFT" } });
    fireEvent.click(exportButton());
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    const exported = xlsxCalls(calls);
    expect(exported[0].url).not.toContain("order_no=SO-DRAFT");

    fireEvent.click(searchButton());
    await waitFor(() => expect(previews(calls, EP.sales).length).toBe(2));
    fireEvent.click(exportButton());
    await waitFor(() => expect(anchorClicks).toHaveLength(2));
    const second = xlsxCalls(calls)[1];
    expect(second.url).toContain("order_no=SO-DRAFT");
  });

  it("导出命中 xlsx 端点，文件名含报表名，下载后释放 blob 地址", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.sales).length).toBe(1));

    fireEvent.click(exportButton());
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    const exported = xlsxCalls(calls);
    expect(exported[0].url.startsWith(`${EP.sales}.xlsx?`)).toBe(true);
    expect(anchorClicks[0].download).toBe("迪礼ERP-销售对账明细表.xlsx");
    expect(downloads[0].blob.size).toBe(4);
    expect(revokedUrls).toEqual([downloads[0].url]);
  });

  it("含草稿开关会把 include_draft=true 带上（查询与导出都带）", async () => {
    captureDownloads();
    const calls = stubReports();
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    await waitFor(() => expect(previews(calls, EP.sales).length).toBe(1));

    fireEvent.click(screen.getByTestId("finance-report-include-draft"));
    const option = await screen.findByRole("option", { name: "含草稿" });
    fireEvent.click(option);
    fireEvent.click(searchButton());
    await waitFor(() => expect(previews(calls, EP.sales).length).toBe(2));
    expect(previews(calls, EP.sales)[1].url).toContain("include_draft=true");

    fireEvent.click(exportButton());
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(xlsxCalls(calls)[0].url).toContain("include_draft=true");
  });
});

describe("财务报表 · 错误与进行中状态", () => {
  it("取数失败：显示后端给的错误原因，导出按钮禁用（不能导出半截数据）", async () => {
    captureDownloads();
    stubReports({ extra: (url) => (url.includes(EP.sales) ? apiErr(422, "REPORT_TOO_LARGE", "导出范围过大（30000 行，上限 20000 行），请缩小期间或增加筛选条件") : undefined) });
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    expect(await screen.findByText(/导出范围过大/)).toBeInTheDocument();
    expect(exportButton()).toBeDisabled();
  });

  it("导出失败：把后端的错误信息以操作失败通知呈现，不产生下载", async () => {
    captureDownloads();
    stubReports({ extra: (url) => (url.includes(".xlsx") ? apiErr(403, "FORBIDDEN", "没有导出财务报表的权限") : undefined) });
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    await screen.findByText("XSDD2026090700001");

    fireEvent.click(exportButton());
    expect(await screen.findByText("没有导出财务报表的权限")).toBeInTheDocument();
    expect(anchorClicks).toHaveLength(0);
    await waitFor(() => expect(exportButton()).toHaveTextContent("导出 XLSX"));
  });

  it("导出中按钮禁用并改文案，且不会重复下载", async () => {
    captureDownloads();
    // 用对象持有 resolve：写成 `let release: (() => void) | null` 会被 TS 收窄成 never（赋值在闭包里）。
    const gate: { resolve: () => void } = { resolve: () => {} };
    const ready = new Promise<void>((resolve) => { gate.resolve = resolve; });
    const calls = stubReports({
      extra: (url) => {
        if (!url.includes(".xlsx")) return undefined;
        // 返回一个读得到但停止读出的响应：只有在 gate 放行后才 resolve。
        return new Response(new ReadableStream({ start: (controller) => { void ready.then(() => { controller.enqueue(new Uint8Array([1, 2])); controller.close(); }); } }), { status: 200 });
      },
    });
    await open(<FinanceReportWorkspace tab="sales-reconciliation-detail" />, "page-finance-reports");
    await screen.findByText("XSDD2026090700001");

    fireEvent.click(exportButton());
    expect(await screen.findByRole("button", { name: "导出中..." })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "导出中..." }));
    gate.resolve();
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(xlsxCalls(calls).length).toBe(1);
  });
});
