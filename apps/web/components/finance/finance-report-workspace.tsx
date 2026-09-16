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
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet } from "../../lib/api-client";
import { fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { downloadFile } from "../../lib/download";
import { FINANCE_REPORT_TABS, CASH_FLOW_ITEM_DICTIONARY_KEY, type FinanceReportTabKey } from "../../lib/finance-sections";
import { notifyError, notifySuccess } from "../ui/toaster";
import { FinanceTabs } from "./finance-tabs";

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
};
type ReportRow = { id: number; cells: ReportCell[] };
type Reference = { id: string; name: string };
type DictionaryItemOption = { id: string; key: string; label: string };
type Filters = { from: string; to: string; orderNo: string; currency: string; customerId: string; supplierId: string; includeDraft: boolean; itemId: string; direction: string };

const ALL = "__all";
const DIRECTIONS: Array<{ value: string; label: string }> = [
  { value: "income", label: "收入" },
  { value: "expense", label: "支出" },
];

const today = () => new Date().toISOString().slice(0, 10);
const firstDayOfMonth = () => `${new Date().toISOString().slice(0, 7)}-01`;
const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

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
  if (scope === "cash") {
    // 收支流水没有订单号，也没有草稿态：带上这两个参数只会让人以为筛选生效了。
    if (filters.itemId) params.set("item_id", filters.itemId);
    if (filters.direction) params.set("direction", filters.direction);
  } else {
    if (filters.orderNo.trim()) params.set("order_no", filters.orderNo.trim());
    if (filters.customerId) params.set("customer_id", filters.customerId);
    if (filters.supplierId) params.set("supplier_id", filters.supplierId);
    if (filters.includeDraft) params.set("include_draft", "true");
  }
  return params.toString();
}

const emptyFilters = (): Filters => ({ from: firstDayOfMonth(), to: today(), orderNo: "", currency: "", customerId: "", supplierId: "", includeDraft: false, itemId: "", direction: "" });

export default function FinanceReportWorkspace({ tab, testId = "page-finance-reports" }: { tab: FinanceReportTabKey; testId?: string }) {
  // 输入中的筛选条件（表单态）与已生效的筛选条件（查询态）分开：
  // 否则每敲一个字符都会打一次对账查询。
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [applied, setApplied] = useState<Filters>(emptyFilters);
  const [table, setTable] = useState<ReportTable | null>(null);
  const [rowCount, setRowCount] = useState(0);
  const [customers, setCustomers] = useState<Reference[]>([]);
  const [suppliers, setSuppliers] = useState<Reference[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  const [items, setItems] = useState<DictionaryItemOption[]>([]);
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
      apiGet<DictionaryItemOption[]>(`/dictionaries/${CASH_FLOW_ITEM_DICTIONARY_KEY}/items`).catch(() => ({ data: [] as DictionaryItemOption[], meta: {} })),
      fetchCurrencyOptions(),
    ]).then(([customerResult, supplierResult, itemResult, currencyOptions]) => {
      if (cancelled) return;
      setCustomers(customerResult.data);
      setSuppliers(supplierResult.data);
      setItems(itemResult.data);
      setCurrencies(currencyOptions);
    });
    return () => { cancelled = true; };
  }, []);

  const columns = useMemo<ColumnDef<ReportRow>[]>(
    () => (table?.columns ?? []).map((column, index) => ({
      id: `col-${index}`,
      header: column.header,
      cell: ({ row }) => textOf(row.original.cells[index]),
    })),
    [table],
  );

  const data = useMemo<ReportRow[]>(() => (table?.rows ?? []).map((cells, index) => ({ id: index, cells })), [table]);

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

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="财务报表">
      <Button variant="secondary" asChild><a href="/finance">返回财务</a></Button>
    </PageHeader>

    <FinanceTabs basePath="/finance/reports" tabs={FINANCE_REPORT_TABS} active={tab} />

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
          <label>收支项目
            <Select value={draft.itemId || ALL} onValueChange={(value) => setDraft({ ...draft, itemId: value === ALL ? "" : value })}>
              <SelectTrigger data-testid="finance-report-item"><SelectValue placeholder="全部项目" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部项目</SelectItem>
                {items.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}
              </SelectContent>
            </Select>
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
            <Select value={draft.customerId || ALL} onValueChange={(value) => setDraft({ ...draft, customerId: value === ALL ? "" : value })}>
              <SelectTrigger data-testid="finance-report-customer"><SelectValue placeholder="全部客户" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部客户</SelectItem>
                {customers.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </>}
        {scope === "supplier" && <>
          <label>订单号<Input data-testid="finance-report-order-no" value={draft.orderNo} onChange={(event) => setDraft({ ...draft, orderNo: event.target.value })} placeholder="可选" /></label>
          <label>供应商
            <Select value={draft.supplierId || ALL} onValueChange={(value) => setDraft({ ...draft, supplierId: value === ALL ? "" : value })}>
              <SelectTrigger data-testid="finance-report-supplier"><SelectValue placeholder="全部供应商" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部供应商</SelectItem>
                {suppliers.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </>}
        {scope !== "cash" && <label>草稿
          <Select value={draft.includeDraft ? "true" : "false"} onValueChange={(value) => setDraft({ ...draft, includeDraft: value === "true" })}>
            <SelectTrigger data-testid="finance-report-include-draft"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="false">不含草稿</SelectItem>
              <SelectItem value="true">含草稿</SelectItem>
            </SelectContent>
          </Select>
        </label>}
        <Button variant="secondary" data-testid="finance-report-search" onClick={() => setApplied({ ...draft })}>查询</Button>
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
          <DataTable columns={columns} data={data} empty={<EmptyState title="当前筛选没有数据" />} />
        </div>
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
