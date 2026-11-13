"use client";

// 财务报表二级页：/finance/reports?tab=<销售对账明细表 | 采购对账明细表>。
//
// 这一页的唯一职责是把「老系统的报表版式」搬到系统里：**页面预览与导出 XLSX 用的是同一份数据**
// —— 都由后端 `ReportTable` 渲染（预览走 JSON，导出走 ExcelJS），列名、列序、合计值、
// 哪些格子留空都来自同一处，因此不可能出现「看到的和导出的不是一批」。
//
// 为什么筛选不在本地过滤：老表是「按期间/客户/供应商取数」的对账表，行数是任意的，
// 本地过滤既拿不到全量也无法分页；服务端取数和导出必须用**同一套筛选条件**
// （导出按钮直接把当前筛选带上，见 exportXlsx）。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { DataTable } from "../data/data-table";
// 搜索语义全站统一（空格分词的 AND、忽略大小写与空白、空查询不过滤），见 lib/fuzzy-search.ts。
import { fuzzyMatch } from "../../lib/fuzzy-search";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SearchableSelect } from "../ui/searchable-select";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet } from "../../lib/api-client";
import { ACCOUNTING_SUBJECTS_PATH, subjectOptionLabel, type AccountingSubject } from "../../lib/accounting-subjects";
import { fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { downloadFile } from "../../lib/download";
import { FINANCE_REPORT_TABS, OVERHEAD_REPORT_TAB_KEY, type FinanceReportTabKey } from "../../lib/finance-sections";
import { notifyError, notifySuccess } from "../ui/toaster";
import { FinanceTabs } from "./finance-tabs";
import OverheadAllocationPanel from "./overhead-allocation-panel";

/** 后端预览返回的列定义（与导出共用）。`num_fmt` 有值即为数值列。 */
type ReportColumn = { header: string; num_fmt: string | null; align: "left" | "center" | "right" | null };
type ReportCell = string | number | null;
type ReportTable = {
  sheet_name: string;
  columns: ReportColumn[];
  rows: ReportCell[][];
  total_columns: number[];
  totals: ReportCell[] | null;
  footnotes: string[];
  /** 导出文件里除本页预览这张以外的其它工作表（只给名字与行数）。 */
  extra_sheets?: Array<{ sheet_name: string; row_count: number }>;
};
type ReportRow = { id: number; cells: ReportCell[] };
type Reference = { id: string; name: string };
/** 会计科目（分类 = 科目类别，项目 = 科目名称）。`isActive` 用来在选项上标出已停用科目。 */
type SubjectOption = Pick<AccountingSubject, "id" | "category" | "name" | "isActive">;
type Filters = { from: string; to: string; orderNo: string; currency: string; customerId: string; supplierId: string; includeDraft: boolean; subjectId: string; category: string; direction: string };

const ALL = "__all";
const DIRECTIONS: Array<{ value: string; label: string }> = [
  { value: "income", label: "收入" },
  { value: "expense", label: "支出" },
];

const today = () => new Date().toISOString().slice(0, 10);
const firstDayOfMonth = () => `${new Date().toISOString().slice(0, 7)}-01`;
const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

/**
 * 报表预览表的**建议列宽**：按「列名里含哪个关键字」查表，命中第一条就返回。
 *
 * 为什么要按列名匹配、而不是像别的页那样逐列写死 `meta.width`：
 * 这张表的列**由后端下发**（`ReportTable.columns`，见下面 columns 的 useMemo），前端只负责渲染。
 * 一共 11 张报表共用这一个 DataTable（销售对账明细 23 列 / 采购对账明细 17 列 / 三大报表 4~8 列 …），
 * 列名与列序由 `finance-report.tables.ts`、`finance-report-forex.tables.ts`、
 * `finance-three-statements.tables.ts` 决定 —— 逐列写死等于把后端列定义抄一份到前端，
 * 后端一改列（2026-09-17 采购对账明细就插过一列「订单号」、2026-09-20 又调过顺序）就静默错位。
 * 按列名匹配的代价只是「关键字表里要维护几个词」，换来的是一列都不必跟后端对齐。
 *
 * ⚠️ 后端 `ReportColumn.width`（finance-report.tables.ts 每列上的 `width: 12` 之类）**不是这里的宽度**：
 * 它是**导出 XLSX 的 Excel 列宽**，只写进 xlsx 的 `<col>` 定义、**不参与页面布局**。
 * 页面宽度与它无关，两边也刻意不追求数字一致（一个以字符为单位、一个是容器百分比）。
 * 别因为「后端已经写了 width」就把这张表删掉 —— 删了页面就退回「各列均分」。
 *
 * 为什么必须有兜底：2026-10-09 起 `DataTable` **一律** `table-layout: fixed`
 * （components/data/data-table.tsx），**没写 `width` 的列由浏览器均分容器宽度**。
 * 23 列均分到 1366 屏每列只剩约 45px（扣掉左右内边距 8+8 只剩 29px），金额列会被折成 2~3 行。
 * 所以「未识别的列」也要给一个宽度，不能留空。
 *
 * 这一页在 `.finance-page` 内，`globals.css` 的 `.finance-page .ui-table.data-table-fixed`
 * 三条（260-264）把它放回「自动布局 + 换行」：因此这里给的是**建议宽度**，
 * 浏览器会在内容与建议宽度之间再分配一次 —— 金额和客户名靠换行仍然看得全（不会省略号截断）。
 * 也正因为是自动布局，**不追求总和精确等于 100%**：自动布局下总和 ≠ 100% 只会被浏览器
 * 按比例伸缩（不溢出、不留空），为了让「金额/名称」这类内容多的列拿到更接近内容的宽度，
 * 这里把已知列的建议宽度之和放在 100% 上下 —— 强凑 100% 反而会让某些关键字列被迫取整成难看的数字。
 */
const REPORT_COLUMN_WIDTH: ReadonlyArray<readonly [keyword: string, width: string]> = [
  // ① 「本币」列（汇率折算出来的那几列）必须先于它们的不带 (本) 版本匹配，
  //    否则「含税单价(本)」会先命中「单价」、拿到不带本币列的宽度。
  ["调整金额(本)", "7%"],
  ["含税金额(本)", "8%"],
  ["单价(本)", "6%"],
  ["含税单价(本)", "7%"],
  ["税额(本)", "6%"],
  ["金额(本)", "8%"],
  // ② 原币的金额类：含税在前，避免被「金额」先吃掉。
  ["含税金额", "8%"],
  ["含税单价", "7%"],
  ["金额", "8%"],
  ["盈余", "8%"], // 现金流量表的「现金及现金等价物净增加额」等不带「金额」二字
  ["税额", "6%"],
  ["税", "6%"], // 兜底：「含税/税率/税额」以外的税相关列名
  ["调整", "7%"],
  ["折扣", "6%"],
  ["汇率", "6%"],
  // ③ 名称类（长文本）与单号类（订单号 / 采购单号 / 销售单号 / 对账单号…）。
  ["客户", "11%"],
  ["供应商", "11%"],
  ["对方名称", "11%"],
  ["产品", "11%"], // 产品名称 / 产品代码
  ["规格", "8%"],
  ["单位", "6%"],
  ["项目", "11%"],
  ["科目", "10%"],
  ["银行", "11%"], // 银行账户 / 银行手续费（后者本可用金额类，但「银行」在前，给宽更安全）
  ["结算", "11%"], // 结算方式（对账表里是「方式--账户标签」，很长）
  ["单号", "9%"],
  ["订单", "8%"],
  ["来源", "8%"],
  ["币种", "6%"],
  ["数量", "6%"],
  ["单价", "6%"],
  ["收入", "7%"],
  ["支出", "7%"],
  ["成本", "8%"],
  ["利润", "8%"],
  ["管理费", "7%"],
  ["占比", "7%"],
  ["备注", "9%"],
  ["说明", "9%"],
  ["摘要", "11%"],
  ["分类", "8%"],
  // ④ 日期类与状态类（短，给少）。
  ["日期", "7%"],
  ["期间", "7%"],
  ["月份", "6%"],
  ["本期", "7%"],
  ["状态", "6%"],
  ["方向", "5%"],
  ["行次", "4%"],
];

/** 未识别的列：给一个不比日期窄的默认值（6%），保证 fixed 布局下不会退化成「均分」。 */
const REPORT_COLUMN_WIDTH_FALLBACK = "6%";

/** 一列的建议宽度：列名里含宽度表的哪个关键字就用哪个，都不含时用兜底值。 */
function reportColumnWidth(header: string): string {
  const name = header.trim();
  for (const [keyword, width] of REPORT_COLUMN_WIDTH) if (name.includes(keyword)) return width;
  return REPORT_COLUMN_WIDTH_FALLBACK;
}

/** 一个月份（`YYYY-MM`）覆盖的日期区间。核算表的管理费是按月登记的，所以它的期间控件是月份。 */
function monthRange(month: string): { from: string; to: string } {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

/** 空值在页面上显示为「-」：留空是「系统没有这个数据」，页面必须让人看得出这一点而不是格子坏掉。 */
function textOf(value: ReportCell): string {
  if (value === null || value === undefined) return "-";
  return String(value);
}

function queryOf(filters: Filters, scope: string): string {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.currency) params.set("currency", filters.currency);
  if (scope === "period") {
    // 三大报表只吃期间与币种（取的是凭证，按期间切片）：多带参数只会让人以为筛选生效了。
    return params.toString();
  }
  if (scope === "cash") {
    // 收支流水没有订单号，也没有草稿态：带上这两个参数只会让人以为筛选生效了。
    if (filters.category) params.set("category", filters.category);
    if (filters.subjectId) params.set("subject_id", filters.subjectId);
    if (filters.direction) params.set("direction", filters.direction);
  } else {
    if (filters.orderNo.trim()) params.set("order_no", filters.orderNo.trim());
    if (filters.customerId) params.set("customer_id", filters.customerId);
    if (filters.supplierId) params.set("supplier_id", filters.supplierId);
    if (filters.includeDraft) params.set("include_draft", "true");
  }
  return params.toString();
}

const emptyFilters = (): Filters => ({ from: firstDayOfMonth(), to: today(), orderNo: "", currency: "", customerId: "", supplierId: "", includeDraft: false, subjectId: "", category: "", direction: "" });

export default function FinanceReportWorkspace({ tab, testId = "page-finance-reports" }: { tab: FinanceReportTabKey; testId?: string }) {
  // 输入中的筛选条件（表单态）与已生效的筛选条件（查询态）分开：
  // 否则每敲一个字符都会打一次对账查询。
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [applied, setApplied] = useState<Filters>(emptyFilters);
  /**
   * 表内关键字搜索（2026-11-13，用户：「所有表单是否都有搜索功能搜索框……因为现在单子多了，查找比较麻烦」）。
   *
   * 与上面那个「查询」按钮**分工不同**：查询是把筛选条件发给服务端重新取数（日期/币种/客户…），
   * 这里是在**已经取回来的这张表里**按关键字找一行（「我记得这单是 DL2600…」「供应商名字里有这个字」）。
   * 11 张报表共用这一个 DataTable，列由后端下发、前端不知道每列是什么，所以按**整行所有单元格**匹配 ——
   * 这与「只搜看得见的列」并不冲突：整行的每一格本来就都显示在表里。
   * 合计不参与过滤：它是单独一段（`finance-report-totals`），永远跟着表走。
   */
  const [keyword, setKeyword] = useState("");
  const [table, setTable] = useState<ReportTable | null>(null);
  const [rowCount, setRowCount] = useState(0);
  const [customers, setCustomers] = useState<Reference[]>([]);
  const [suppliers, setSuppliers] = useState<Reference[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  const activeTab = FINANCE_REPORT_TABS.find((item) => item.key === tab);
  // 筛选条长什么样由 tab 定义里的 scope 决定（数据驱动，加新表不用改组件）。
  const scope = activeTab?.scope ?? "customer";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const suffix = queryOf(applied, scope);
      const result = await apiGet<ReportTable>(`/finance/reports/${tab}${suffix ? `?${suffix}` : ""}`);
      setTable(result.data);
      setRowCount(Number(result.meta.row_count ?? result.data.rows.length));
    } catch (cause) {
      setError(messageOf(cause, "报表取数失败"));
      setTable(null);
    } finally {
      setLoading(false);
    }
  }, [tab, applied, scope]);

  // 首次进入、切换 tab、点「查询」（setApplied 换了一个新对象）都会走到这里。
  useEffect(() => { void load(); }, [load]);

  // 筛选下拉的选项：任何一项拉不到都不应让整页报错（选项留空即可）。
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      apiGet<Reference[]>("/customers").catch(() => ({ data: [] as Reference[], meta: {} })),
      apiGet<Reference[]>("/suppliers").catch(() => ({ data: [] as Reference[], meta: {} })),
      // 科目下拉**要停用的**：报表本身会把停用科目的行列出来（标注「（已停用）」），
      // 下拉里选不到它们的话，财务就没法把那些行单独筛出来核对。
      apiGet<SubjectOption[]>(`${ACCOUNTING_SUBJECTS_PATH}?include_inactive=true`).catch(() => ({ data: [] as SubjectOption[], meta: {} })),
      fetchCurrencyOptions(),
    ]).then(([customerResult, supplierResult, subjectResult, currencyOptions]) => {
      if (cancelled) return;
      setCustomers(customerResult.data);
      setSuppliers(supplierResult.data);
      setSubjects(subjectResult.data);
      setCurrencies(currencyOptions);
    });
    return () => { cancelled = true; };
  }, []);

  // 宽度**只**看列名（不看下标）：后端可以插列、换序（2026-09-17 采购对账明细插过「订单号」），
  // 下标一移位，按下标配的宽度就会安到旁边那一列上，而表面上完全看不出来。
  // 不写 `ellipsis`：2026-10-09 起它已是默认（数据表自己的注释里写了），而且这一页是自动布局 + 换行，
  // 显式写 `ellipsis: true` 反而会和 `.finance-page` 那三条豁免打架。
  const columns = useMemo<ColumnDef<ReportRow>[]>(
    () => (table?.columns ?? []).map((column, index) => ({
      id: `col-${index}`,
      header: column.header,
      meta: { width: reportColumnWidth(column.header) },
      cell: ({ row }) => textOf(row.original.cells[index]),
    })),
    [table],
  );

  const data = useMemo<ReportRow[]>(() => (table?.rows ?? []).map((cells, index) => ({ id: index, cells })), [table]);

  /** 关键字过滤后的行（空查询 = 全量；只改显示，不动合计与导出）。 */
  const visibleData = useMemo(
    () => (keyword.trim() ? data.filter((row) => fuzzyMatch(keyword, row.cells)) : data),
    [data, keyword],
  );

  async function exportXlsx() {
    setExporting(true);
    try {
      const suffix = queryOf(applied, scope);
      const label = activeTab?.title ?? "财务报表";
      // 用**已生效**的筛选导出（不是输入框里的草稿），保证导出的就是当前表里看到的这一批。
      await downloadFile(`/api/v1/finance/reports/${tab}.xlsx${suffix ? `?${suffix}` : ""}`, `迪礼ERP-${label}.xlsx`);
      notifySuccess(`已导出${label}`);
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  return <div className="page-root finance-page" data-testid={testId}>
    <PageHeader title="财务报表">
      <Button variant="secondary" asChild><a href="/finance">返回财务</a></Button>
    </PageHeader>

    <FinanceTabs basePath="/finance/reports" tabs={FINANCE_REPORT_TABS} active={tab} />

    {/* 核算表要在同屏先录「本月管理费」再出表（用户 2026-09-20 第 4 条）。
        它只在核算表这个 tab 上出现：其余报表与月度管理费无关，多一块面板只会让人以为填了会影响它们。
        期间与筛选条同源（起始日期所在的月份），所以面板里改月份会把筛选条一起切过去。 */}
    {tab === OVERHEAD_REPORT_TAB_KEY && /^\d{4}-\d{2}$/.test((applied.from || applied.to).slice(0, 7)) && <OverheadAllocationPanel
      period={(applied.from || applied.to).slice(0, 7)}
      onMonthChange={(month) => { const range = monthRange(month); const next = { ...draft, ...range }; setDraft(next); setApplied(next); }}
      onSaved={() => void load()}
    />}

    <section className="panel">
      <div className="panel-body filter-bar">
        <label>起始日期<Input data-testid="finance-report-from" type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
        <label>截止日期<Input data-testid="finance-report-to" type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
        <label>币种
          <Select value={draft.currency || ALL} onValueChange={(value) => setDraft({ ...draft, currency: value === ALL ? "" : value })}>
            <SelectTrigger data-testid="finance-report-currency"><SelectValue placeholder="全部币种" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部币种</SelectItem>
              {currencies.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        {scope === "cash" && <>
          <label>分类
            {/* 分类来自会计科目表（会变长），带搜索。币种与收支方向是固定枚举，保持紧凑。 */}
            <SearchableSelect
              id="finance-report-category"
              testId="finance-report-category"
              value={draft.category || ALL}
              options={[{ value: ALL, label: "全部分类" }, ...[...new Set(subjects.map((subject) => subject.category))].map((category) => ({ value: category, label: category }))]}
              placeholder="全部分类"
              label="分类"
              searchPlaceholder="搜索分类"
              noResultsText="没有匹配的分类"
              onChange={(value) => setDraft({ ...draft, category: value === ALL ? "" : value })}
            />
          </label>
          <label>会计科目
            {/* 带搜索框的下拉（用户 2026-09-20 第 1 条）：这张筛选器列的是**全量**科目
                （含已停用，标注「（已停用）」），121 条里滚动找一条几乎不可用。 */}
            <SearchableSelect
              id="finance-report-subject"
              testId="finance-report-subject"
              value={draft.subjectId || ALL}
              options={[{ value: ALL, label: "全部科目" }, ...subjects.map((subject) => ({ value: subject.id, label: `${subjectOptionLabel(subject)}${subject.isActive === false ? "（已停用）" : ""}` }))]}
              placeholder="全部科目"
              label="会计科目"
              onChange={(value) => setDraft({ ...draft, subjectId: value === ALL ? "" : value })}
            />
          </label>
          <label>收支方向
            <Select value={draft.direction || ALL} onValueChange={(value) => setDraft({ ...draft, direction: value === ALL ? "" : value })}>
              <SelectTrigger data-testid="finance-report-direction"><SelectValue placeholder="收入与支出" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>收入与支出</SelectItem>
                {DIRECTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </>}
        {scope === "customer" && <>
          <label>订单号<Input data-testid="finance-report-order-no" value={draft.orderNo} onChange={(event) => setDraft({ ...draft, orderNo: event.target.value })} placeholder="可选" /></label>
          <label>客户
            {/* 客户清单会长长（用户 2026-11-13：「所有下拉列表、所有表单……都要有搜索功能」）：用带搜索的下拉，
                财务记得的是客户名，不是它排在第几行。 */}
            <SearchableSelect
              id="finance-report-customer"
              testId="finance-report-customer"
              value={draft.customerId || ALL}
              options={[{ value: ALL, label: "全部客户" }, ...customers.map((item) => ({ value: item.id, label: item.name }))]}
              placeholder="全部客户"
              label="客户"
              searchPlaceholder="搜索客户名称"
              noResultsText="没有匹配的客户"
              onChange={(value) => setDraft({ ...draft, customerId: value === ALL ? "" : value })}
            />
          </label>
        </>}
        {scope === "supplier" && <>
          <label>订单号<Input data-testid="finance-report-order-no" value={draft.orderNo} onChange={(event) => setDraft({ ...draft, orderNo: event.target.value })} placeholder="可选" /></label>
          <label>供应商
            {/* 同客户：供应商清单也会长，筛选器带搜索。 */}
            <SearchableSelect
              id="finance-report-supplier"
              testId="finance-report-supplier"
              value={draft.supplierId || ALL}
              options={[{ value: ALL, label: "全部供应商" }, ...suppliers.map((item) => ({ value: item.id, label: item.name }))]}
              placeholder="全部供应商"
              label="供应商"
              searchPlaceholder="搜索供应商名称"
              noResultsText="没有匹配的供应商"
              onChange={(value) => setDraft({ ...draft, supplierId: value === ALL ? "" : value })}
            />
          </label>
        </>}
        {/* 三大报表（scope: "period"）不吃「草稿」这一项：它们取的是**已过账凭证**，
            草稿凭证不是账，摆一个永远无效的开关只会让人以为选了它数字会变。 */}
        {scope !== "cash" && scope !== "period" && <label>草稿
          <Select value={draft.includeDraft ? "true" : "false"} onValueChange={(value) => setDraft({ ...draft, includeDraft: value === "true" })}>
            <SelectTrigger data-testid="finance-report-include-draft"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="false">不含草稿</SelectItem>
              <SelectItem value="true">含草稿</SelectItem>
            </SelectContent>
          </Select>
        </label>}
        <Button variant="secondary" data-testid="finance-report-search" onClick={() => setApplied({ ...draft })}>查询</Button>
        {/* 表内关键字（不等服务端）：取回来的这一批里找一行。与「查询」按钮分开，两个动作互不改写对方。 */}
        <label>表内搜索任意列
          <Input data-testid="finance-report-keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入关键词，空格分隔多个词" />
        </label>
        {keyword.trim() ? <span className="panel-note" data-testid="finance-report-keyword-count">筛选后 {visibleData.length} / {data.length} 行</span> : null}
        {keyword.trim() ? <Button variant="secondary" onClick={() => setKeyword("")}>清除搜索</Button> : null}
      </div>
    </section>

    <section className="panel">
      <div className="panel-heading">
        <h2>{activeTab?.title ?? "财务报表"}</h2>
        <div className="page-actions">
          <span className="panel-note" data-testid="finance-report-row-count">共 {rowCount} 行</span>
          <Button data-testid="finance-report-export" disabled={exporting || loading || Boolean(error)} onClick={() => void exportXlsx()}>
            {exporting ? "导出中..." : "导出 XLSX"}
          </Button>
        </div>
      </div>
      {error && <div className="panel-body"><ErrorState message={error} onRetry={() => void load()} /></div>}
      {!error && loading && <LoadingState />}
      {!error && !loading && table && <>
        <div className="panel-body">
          <DataTable columns={columns} data={visibleData} empty={keyword.trim() ? <EmptyState title={`表里没有匹配“${keyword.trim()}”的行`} description={`当前筛选共 ${data.length} 行，换个关键词或清空搜索框。`} /> : <EmptyState title="当前筛选没有数据" />} />
        </div>
        {/* 导出文件里还有别的表时必须说清楚：外汇一览表的「客户汇总」不在页面上渲染，
            不提示的话财务会把导出的文件当成只有明细一张表。 */}
        {table.extra_sheets?.length ? <p className="panel-note panel-body" data-testid="finance-report-extra-sheets">
          导出文件还包含：{table.extra_sheets.map((sheet) => `「${sheet.sheet_name}」（${sheet.row_count} 行）`).join("、")}
        </p> : null}
        {table.totals && <p className="panel-note panel-body" data-testid="finance-report-totals">
          合计（与导出一致）：{table.total_columns.map((index) => `${table.columns[index].header} ${textOf(table.totals?.[index] ?? null)}`).join("　")}
        </p>}
        {/* 表尾说明必须在页面上也看得到：利润表的「缺采购价物料 → 毛利偏高」如果只在导出文件里，
            看页面的人会以为毛利就是这么多。 */}
        {table.footnotes.length > 0 && <div className="panel-body" data-testid="finance-report-footnotes">
          <p className="panel-note">导出文件附带的说明：</p>
          <ul className="panel-note">
            {table.footnotes.map((note, index) => <li key={note} data-testid={`finance-report-footnote-${index}`}>{note}</li>)}
          </ul>
        </div>}
      </>}
    </section>
  </div>;
}
