"use client";

// 报表与告警（一级导航「报表与告警」的首页）：五个报表页签 + 告警中心。
//
// 这一页里有**两套**"筛选"，分工必须说清（2026-11-13，用户：「通览整个项目，统计所有下拉列表，所有表单是否
// 都有搜索功能搜索框，如果没有，都需要加上搜索功能。因为现在单子多了，查找比较麻烦。」）：
//   · 上方筛选条里的「订单号 + 筛选」是**服务端**条件：点它才带着 `?order_no=` 重新取数，导出用的是
//     同一个条件（`exportCsv`），所以导出件与屏幕对得上；
//   · 每张表自己的搜索框是**客户端**关键字过滤：只在已经取回来的这一批里按词找一行，不发请求、不影响导出
//     （导出的永远是"当前服务端条件"下的全量）。
// 两者不能合并：订单号是索引列，用它缩小范围是服务端才干得了的事；而"我记得这行是宁波那家"只能靠关键字。
//
// ⚠️ 别把这两套混成一个输入框：客户端过滤**不会**重新取数（所以它搜不到还没取回来的行），
// 服务端条件**不会**逐字过滤（所以它只认订单号）。混在一起就会出现"筛了却搜不到"或"搜到了却导出不到"。
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { PageHeader } from "../../components/layout/app-shell";
import { ActionDialog } from "../../components/ui/action-dialog";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { DataTable } from "../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback/states";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";
import { displayField, displayStatus, displayText } from "../../lib/display-text";
// 搜索语义全站统一（空格分词的 AND、忽略大小写与空白、空查询不过滤），见 lib/fuzzy-search.ts。
import { fuzzyMatch } from "../../lib/fuzzy-search";

type ReportRow = Record<string, unknown>;
type Alert = { source_id: string; source_type: string; alert_type: string; order_no: string | null; severity: string; title: string; suggestion: string; status: string };
const reports = [{ key: "orders", label: "订单推进" }, { key: "procurement-payables", label: "采购与应付" }, { key: "inventory", label: "库存" }, { key: "production-qc", label: "生产与质检" }, { key: "payroll", label: "薪资" }];

/**
 * 一格在屏幕上显示的那串字 = 搜索要比对的那串字。
 *
 * 报表的列是**按接口键动态生成**的（五个页签的列各不相同，见下面的 `reportColumns`），
 * 所以没法像别的页那样逐字段列举参与匹配 —— 只能把每格的值过一遍这个函数。
 * 渲染与过滤共用同一份实现：命中的一定就是屏幕上看得见的那一段，不会出现"搜到了却在表里找不到"。
 * 对象值走 `JSON.stringify`（页面本来就这么显示），其余先过 `displayText`（`pending` → 「待处理」，
 * 用户搜的是中文而不是枚举代码）。这与表格里那一格 `cell` 的写法**必须**是同一句，改一处就要改另一处。
 */
function cellText(value: unknown): string {
  if (typeof value === "object") return JSON.stringify(value);
  return String(displayText(value ?? "-"));
}

export default function ReportsPage() {
  const [tab, setTab] = useState("orders"); const [rows, setRows] = useState<ReportRow[]>([]); const [alerts, setAlerts] = useState<Alert[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [orderNo, setOrderNo] = useState(""); const [pendingAlert, setPendingAlert] = useState<{ item: Alert; status: "acknowledged" | "resolved" } | null>(null);
  /**
   * 两张表的表内关键词各存一份：报表页签的列与告警中心的列完全不同，
   * 共用一个词会让"换到告警中心还留着上一个页签的词"变成一个空表。
   */
  const [rowKeyword, setRowKeyword] = useState(""); const [alertKeyword, setAlertKeyword] = useState("");
  async function load() { setLoading(true); setError(""); try { const query = orderNo ? `?${new URLSearchParams({ order_no: orderNo })}` : ""; if (tab === "alerts") setAlerts((await apiGet<Alert[]>(`/alerts${query}`)).data); else setRows((await apiGet<ReportRow[]>(`/reports/${tab}${query}`)).data); } catch (cause) { setError(cause instanceof ApiClientError ? cause.message : "数据加载失败"); } finally { setLoading(false); } }
  useEffect(() => { void load(); }, [tab]);
  /**
   * 换页签 = 换了一张表，把两个关键词一起清掉。
   *
   * 不清会怎样：在「订单推进」搜了某个客户名，切到「薪资」—— 薪资的列里根本没有那个词，
   * 于是整张表空着、只剩一句「没有匹配」，看起来就像"这个页签没有数据"。
   */
  useEffect(() => { setRowKeyword(""); setAlertKeyword(""); }, [tab]);
  async function exportCsv() { const query = orderNo ? `?${new URLSearchParams({ order_no: orderNo })}` : ""; const response = await fetch(`/api/v1/reports/${tab}/export${query}`, { credentials: "include" }); if (!response.ok) { setError("导出失败，请缩小筛选范围后重试"); return; } const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = `${tab}.csv`; link.click(); URL.revokeObjectURL(url); }
  async function handleAlert(values: Record<string, string>) {
    if (!pendingAlert) return;
    try {
      await apiPost(`/alerts/${pendingAlert.item.source_id}/handle`, { status: pendingAlert.status, remark: values.remark });
      // 生产日报告警必须**同时**落到 production_daily_alert.status = confirmed：
      // /alerts/:id/handle 只写 alert_handling（alerts.service.ts:21），而订单侧的
      // daily_discrepancy / over_order_unconfirmed 阻塞只看 production_daily_alert.status === "pending"
      // （production-progress.service.ts:169-170）。只调 handle 会让"已确认"的告警继续阻塞生产单。
      if (pendingAlert.item.source_type === "production_daily_alert") {
        try {
          await apiPost(`/production/daily-alerts/${pendingAlert.item.source_id}/confirm`, { remark: values.remark });
        } catch (cause) {
          // 已恢复（recovered）的告警不允许再确认；而它本来也不再产生阻塞，
          // 因此视为无需处理，不打断用户的确认流程。
          if (!(cause instanceof ApiClientError) || cause.code !== "RECOVERED_ALERT_CANNOT_CONFIRM") throw cause;
        }
      }
      setPendingAlert(null);
      await load();
    } catch (cause) { setError(cause instanceof ApiClientError ? cause.message : "告警处理失败"); }
  }
  const alertColumns = [{ accessorKey: "severity", header: "级别", cell: ({ row }: { row: { original: Alert } }) => displayStatus(row.original.severity) }, { accessorKey: "title", header: "标题" }, { accessorKey: "order_no", header: "订单号", cell: ({ row }: { row: { original: Alert } }) => row.original.order_no ?? "-" }, { accessorKey: "status", header: "状态", cell: ({ row }: { row: { original: Alert } }) => displayStatus(row.original.status) }, { accessorKey: "suggestion", header: "建议" }, { id: "actions", header: "操作", cell: ({ row }: { row: { original: Alert } }) => row.original.status === "pending" ? <Button size="sm" variant="secondary" onClick={() => setPendingAlert({ item: row.original, status: "acknowledged" })}>确认</Button> : row.original.status === "acknowledged" ? <Button size="sm" variant="secondary" onClick={() => setPendingAlert({ item: row.original, status: "resolved" })}>解决</Button> : null }];
  const reportColumns = rows[0] ? Object.keys(rows[0]).map((key) => ({ accessorKey: key, header: displayField(key), cell: ({ row }: { row: { original: ReportRow } }) => cellText(row.original[key]) })) : [];
  /**
   * 表内关键字过滤（2026-11-13）。报表的列随页签变，所以按**每一格显示出来的文字**匹配
   * （`cellText`，与渲染同源）；不匹配接口键名本身 —— 搜 `order_no` 这种字段名能让一行命中，
   * 但屏幕上没有这个词，看起来就是搜索坏了。
   */
  const visibleRows = useMemo(() => rows.filter((row) => fuzzyMatch(rowKeyword, Object.values(row).map((value) => cellText(value)))), [rows, rowKeyword]);
  /**
   * 告警中心的表内过滤：只匹配这张表看得见的五列（级别 / 标题 / 订单号 / 状态 / 建议）。
   * `alert_type`、`source_type`、`source_id` 是内部字段，不参与 —— 否则搜 `production_daily_alert`
   * 会命中一堆，而表里一个字都对不上。
   */
  const visibleAlerts = useMemo(() => alerts.filter((item) => fuzzyMatch(alertKeyword, [
    displayStatus(item.severity), item.title, item.order_no, displayStatus(item.status), item.suggestion,
  ])), [alerts, alertKeyword]);
  return <div className="page-root" data-testid="page-reports">
    <PageHeader title="报表与告警">
      <div className="page-actions">
        <Button asChild variant="secondary"><Link href="/reports/procurement-warehouse">采购与仓储报表</Link></Button>
        <Button variant="secondary" onClick={() => void load()} title="刷新"><RefreshCw size={15} /> 刷新</Button>
      </div>
    </PageHeader>
    <ActionDialog open={Boolean(pendingAlert)} onOpenChange={(open) => { if (!open) setPendingAlert(null); }} title="处理告警" fields={[{ name: "remark", label: "处理备注", type: "textarea", required: true }]} onSubmit={(values) => void handleAlert(values)} />
    {/* 服务端条件（订单号 + 筛选）：点了才重新取数，导出也用它。这一条不动 —— 表内搜索是另一套（见文件头）。 */}
    <section className="panel">
      <div className="panel-body filter-bar">
        <label>订单号 <Input value={orderNo} onChange={(event) => setOrderNo(event.target.value)} placeholder="可选" /></label>
        <Button variant="secondary" onClick={() => void load()}>筛选</Button>
      </div>
    </section>
    <div className="tabs">
      {reports.map((item) => <Button key={item.key} variant={tab === item.key ? "default" : "secondary"} onClick={() => setTab(item.key)}>{item.label}</Button>)}
      <Button variant={tab === "alerts" ? "default" : "secondary"} onClick={() => setTab("alerts")}>告警中心</Button>
    </div>
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {loading ? <LoadingState /> : tab === "alerts" ? <section className="panel" data-testid="daily-alert-table">
      <div className="panel-body">
        <div className="filter-bar">
          <label>搜索告警（标题、订单号、建议、级别或状态）
            <Input data-testid="reports-alert-search" value={alertKeyword} onChange={(event) => setAlertKeyword(event.target.value)} placeholder="输入关键词，空格分隔多个词" />
          </label>
          {alertKeyword.trim() ? <span className="panel-note" data-testid="reports-alert-count">筛选后 {visibleAlerts.length} / {alerts.length} 行</span> : null}
          {alertKeyword.trim() ? <Button variant="secondary" onClick={() => setAlertKeyword("")}>清除搜索</Button> : null}
        </div>
        <DataTable
          columns={alertColumns}
          data={visibleAlerts}
          empty={alertKeyword.trim()
            ? <EmptyState title={`没有匹配“${alertKeyword.trim()}”的告警`} description={`当前共 ${alerts.length} 条待处理告警，换个关键词或点「清除搜索」看全部。`} />
            : <EmptyState title="暂无待处理告警" />}
        />
      </div>
    </section> : <section className="panel">
      <div className="panel-heading">
        <h2>{reports.find((item) => item.key === tab)?.label}</h2>
        <Button variant="secondary" onClick={() => void exportCsv()}><Download size={15} /> 导出表格</Button>
      </div>
      <div className="panel-body">
        <div className="filter-bar">
          <label>在这张报表里搜索（每一格显示出来的文字都参与匹配）
            <Input data-testid="reports-search" value={rowKeyword} onChange={(event) => setRowKeyword(event.target.value)} placeholder="输入关键词，空格分隔多个词" />
          </label>
          {rowKeyword.trim() ? <span className="panel-note" data-testid="reports-search-count">筛选后 {visibleRows.length} / {rows.length} 行</span> : null}
          {rowKeyword.trim() ? <Button variant="secondary" onClick={() => setRowKeyword("")}>清除搜索</Button> : null}
        </div>
        <DataTable
          columns={reportColumns}
          data={visibleRows}
          empty={rowKeyword.trim()
            ? <EmptyState title={`没有匹配“${rowKeyword.trim()}”的行`} description={`当前条件下共 ${rows.length} 行，换个关键词或点「清除搜索」看全部。`} />
            : <EmptyState title="暂无报表数据" />}
        />
      </div>
    </section>}
  </div>;
}
