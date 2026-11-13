"use client";

// 采购与仓储报表的**屏幕主体**（2026-11-04）：筛选条 + 九列表格 + 口径说明。
//
// 设计见 `docs/design/procurement-warehouse-report-2026-11-04.md` §4。组件只负责"长什么样"，
// 取数 / 导出 / 打印弹窗的状态都留在路由页（`app/reports/procurement-warehouse/page.tsx`）——
// 导出与打印必须用屏幕上这**同一次**接口返回的数据，把状态放在一层里才不会出现两份数据源。
//
// 列定义不在这里另写一遍：`REPORT_COLUMNS`（lib/procurement-warehouse-report.ts）是屏幕 / 纸面 /
// 导出件的唯一来源，组件只把它翻译成 TanStack 的列。九个宽度合计 100% 的守卫也钉在那份 lib 测试里。
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Search } from "lucide-react";
import { DataTable } from "../data/data-table";
import { EmptyState, ErrorState } from "../feedback/states";
// 搜索语义全站统一（空格分词的 AND、忽略大小写与空白、空查询不过滤），见 lib/fuzzy-search.ts。
import { fuzzyMatch } from "../../lib/fuzzy-search";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  REPORT_COLUMNS, REPORT_COLUMN_NOTES, REPORT_ROW_LIMIT, REPORT_SCOPE_INTRO, REPORT_SCOPE_RULES,
  displayReportColor, displayReportText, formatReportQuantity, isNegativeReportQuantity,
  type ProcurementWarehouseFilters, type ProcurementWarehouseMeta, type ProcurementWarehouseRow,
} from "../../lib/procurement-warehouse-report";

/**
 * 九列 → TanStack 列定义。
 *
 * 数字列的内容包一层 `<span className="procurement-warehouse-num">`：右对齐是**内容**的对齐，
 * 而 `DataTable` 的 `<td>` 是全站共用原语（它只接收 `meta.width`，不接收逐列的单元格 class），
 * 给 span `display:block` + `text-align:right` 就能在共享组件之外完成对齐，不用改 DataTable。
 * 负的「采购未入库数」「库存量」复用既有 `.status-error`（`--danger`），不新造颜色。
 */
const COLUMNS: ColumnDef<ProcurementWarehouseRow>[] = REPORT_COLUMNS.map((column) => ({
  accessorKey: column.key,
  header: column.label,
  meta: { width: column.width },
  cell: ({ row }) => {
    const value = row.original[column.key];
    if (column.numeric) {
      const alert = Boolean(column.negativeIsAlert) && isNegativeReportQuantity(value);
      return <span className={alert ? "procurement-warehouse-num status-error" : "procurement-warehouse-num"}>{formatReportQuantity(value)}</span>;
    }
    return column.key === "color" ? displayReportColor(value) : displayReportText(value);
  },
}));

export function ProcurementWarehouseReport({ rows, meta, loading, error, filters, onFiltersChange, onSearch, onReset, onRetry }: {
  rows: ProcurementWarehouseRow[];
  meta: ProcurementWarehouseMeta | null;
  loading: boolean;
  error: string;
  /** 输入框里**正在编辑**的筛选条件（还没点「查询」）。 */
  filters: ProcurementWarehouseFilters;
  onFiltersChange: (next: ProcurementWarehouseFilters) => void;
  onSearch: () => void;
  onReset: () => void;
  onRetry: () => void;
}) {
  // 行数以接口 meta 为准，缺了就退回本次返回的行数：两者只在「后端漏填 meta」时不同，
  // 但用户看到的「共 N 行」必须与表格里能数出来的行一致，所以以实际渲染的数组为最终兜底。
  const rowCount = typeof meta?.row_count === "number" ? meta.row_count : rows.length;
  /**
   * 表内关键字（2026-11-13，用户：「所有表单是否都有搜索功能搜索框……因为现在单子多了，查找比较麻烦」）。
   *
   * 与上面那两个**服务端**筛选框分工不同：订单号/物料是点了「查询」才回服务端重新取数的条件，
   * 这里是在**已经取回来的这一批**里按关键字找一行（用户手上常常只有一个模糊的印象，
   * 比如「记得是 150D 的黑布」）。只按九列**看得见**的值匹配，不碰内部字段。
   * 单次最多 REPORT_ROW_LIMIT 行，客户端过滤足够；超出范围仍要先用服务端条件缩小。
   */
  const [keyword, setKeyword] = useState("");
  const visibleRows = useMemo(
    () => (keyword.trim()
      ? rows.filter((row) => fuzzyMatch(keyword, [
          row.order_no, row.material_name, displayReportColor(row.color), displayReportText(row.unit),
          row.purchase_quantity, row.inbound_quantity, row.pending_inbound_quantity,
          row.production_issue_quantity, row.stock_quantity,
        ]))
      : rows),
    [rows, keyword],
  );
  return (
    <>
      <section className="panel" data-testid="report-filters">
        <div className="panel-body filter-bar">
          <label>订单号<Input data-testid="filter-order-no" value={filters.order_no} onChange={(event) => onFiltersChange({ ...filters, order_no: event.target.value })} placeholder="可选，包含匹配（不区分大小写）" /></label>
          <label>物料（名称/编码）<Input data-testid="filter-material" value={filters.material} onChange={(event) => onFiltersChange({ ...filters, material: event.target.value })} placeholder="可选，名称或编码包含匹配" /></label>
          <Button data-testid="report-search" onClick={onSearch}><Search size={15} /> 查询</Button>
          <Button data-testid="report-reset" variant="secondary" onClick={onReset}>重置</Button>
        </div>
      </section>

      {error ? <section className="panel"><ErrorState message={error} onRetry={onRetry} /></section> : null}

      <section className="panel">
        <div className="panel-heading">
          <h2>采购与仓储明细</h2>
          {/* 行数写在这里而不是只写在分页条上：分页条只显示「第 1 / N 页」，用户要的是「这次一共多少行」。 */}
          <span className="panel-note" data-testid="report-row-count">
            共 {rowCount} 行（单次最多 {REPORT_ROW_LIMIT} 行，超出请按订单号或物料缩小范围）
          </span>
        </div>
        <div className="panel-body" data-testid="report-table">
          <div className="filter-bar">
            <label>表内搜索订单号、物料、颜色、单位或数量
              <Input data-testid="report-keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入关键词，空格分隔多个词" />
            </label>
            {keyword.trim() ? <span className="panel-note" data-testid="report-keyword-count">筛选后 {visibleRows.length} / {rows.length} 行</span> : null}
            {keyword.trim() ? <Button variant="secondary" onClick={() => setKeyword("")}>清除搜索</Button> : null}
          </div>
          <DataTable
            columns={COLUMNS}
            data={visibleRows}
            loading={loading}
            pageSize={50}
            empty={keyword.trim() ? <EmptyState title={`没有匹配“${keyword.trim()}”的行`} description={`当前条件下共 ${rows.length} 行，换个关键词或清空搜索框。`} /> : <EmptyState title="当前筛选条件下没有数据" description="可留空筛选条件查看全部；只有采购、入库或生产领用过的订单×物料才会出现在这张表里。" />}
          />
        </div>
      </section>

      {/* 口径说明：三条规则必须在页面上出现（设计 §1），否则「库存量不按订单拆账」会被当成「这张单还剩多少」。 */}
      <section className="panel" data-testid="report-scope-notes">
        <div className="panel-heading"><h2>口径说明</h2><span className="panel-note">这张表能回答什么、不能回答什么</span></div>
        <div className="panel-body">
          <p className="panel-note">{REPORT_SCOPE_INTRO}</p>
          <ul className="procurement-warehouse-rule-list">
            {REPORT_SCOPE_RULES.map((rule) => <li key={rule}>{rule}</li>)}
          </ul>
          <ul className="procurement-warehouse-rule-list">
            {REPORT_COLUMN_NOTES.map((item) => <li key={item.label}><strong>{item.label}</strong>：{item.note}</li>)}
          </ul>
        </div>
      </section>
    </>
  );
}
