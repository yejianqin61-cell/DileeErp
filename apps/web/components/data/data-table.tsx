"use client";

import { flexRender, getCoreRowModel, getPaginationRowModel, useReactTable, type ColumnDef, type ColumnMeta, type RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { EmptyState, LoadingState } from "../feedback/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Button } from "../ui/button";
import { displayText } from "../../lib/display-text";

/**
 * 列元数据（通过 TanStack 的 `ColumnMeta` 扩展挂在 `columnDef.meta` 上）。
 *
 * 为什么用 `meta` 而不是给 DataTable 加 `columnWidths` / `ellipsisColumns` 两个 props：
 * 宽度与「要不要省略」是**列自己的属性**，跟列定义写在同一个对象里才不会漂移
 * （两个平行的 Record 靠列 id 字符串对齐，改个 id 就会静默失效，而且看不出来）。
 */
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** 固定列宽（CSS 长度，如 `"18%"`）。**只要有一列给了宽度，整张表就切成 `table-layout: fixed`**（见下）。 */
    width?: string;
    /** 内容超宽时省略号截断，鼠标悬停用原生 `title` 展示全文（用户 2026-09-20 第 6 条）。 */
    ellipsis?: boolean;
  }
}

/** 表格列元数据（导出给列定义使用，写 `meta` 时能拿到字面量约束）。 */
export type DataTableColumnMeta = ColumnMeta<RowData, unknown>;

/**
 * 读一列的元数据。
 *
 * `columnDef.meta` 在 TanStack 里是可选的 `unknown`，这里统一收口成上面的形状 ——
 * 只有一处读它，就不会出现「某个渲染分支忘了 meta」这种半生效的版式。
 */
function metaOf(meta: unknown): { width?: string; ellipsis?: boolean } {
  return (meta ?? {}) as { width?: string; ellipsis?: boolean };
}

/**
 * 悬停提示的文本。
 *
 * 只对**字符串/数字**单元格给 `title`：这两种是绝大多数文本列的实际类型，而且被截断的正是它们。
 * ReactNode 单元格（操作按钮之类）不给 —— 把按钮的文案拼成一句「确认应付编辑回退」当提示，
 * 比没有提示更让人困惑。
 *
 * 同时刻意**不**用整行的 `rowTitle`（「双击查看详情」）兜底：那是行的说明，
 * 而用户 hover 一列是想看**这一格**被省略掉的全文。
 */
function ellipsisTitle(value: ReactNode): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

export function DataTable<T>({ columns, data, loading = false, empty, pageSize = 20, onRowDoubleClick, rowTitle, tableClassName }: { columns: ColumnDef<T, any>[]; data: T[]; loading?: boolean; empty?: ReactNode; pageSize?: number; onRowDoubleClick?: (row: T) => void; rowTitle?: string; tableClassName?: string }) {
  const table = useReactTable({ data, columns, initialState: { pagination: { pageSize } }, getCoreRowModel: getCoreRowModel(), getPaginationRowModel: getPaginationRowModel() });
  if (loading) return <LoadingState />;
  if (!data.length) return <>{empty ?? <EmptyState />}</>;
  const text = (value: ReactNode): ReactNode => typeof value === "string" ? String(displayText(value)) : value;
  // 有列给了宽度就切固定布局：不切的话「宽度」只是建议值，长文本照样把列撑宽、把表顶出容器 ——
  // 而用户要的恰恰是「保证一次性展示全部column」。固定布局下内容只能在自己的格子里换行或被省略。
  const fixed = columns.some((column) => metaOf(column.meta).width);
  const className = [fixed ? "data-table-fixed" : "", tableClassName ?? ""].filter(Boolean).join(" ") || undefined;
  return <><div className="table-wrap" data-testid="data-table"><Table className={className}><TableHeader>{table.getHeaderGroups().map(group => <TableRow key={group.id}>{group.headers.map(header => <TableHead key={header.id} style={metaOf(header.column.columnDef.meta).width ? { width: metaOf(header.column.columnDef.meta).width } : undefined}>{header.isPlaceholder ? null : text(flexRender(header.column.columnDef.header, header.getContext()))}</TableHead>)}</TableRow>)}</TableHeader><TableBody>{table.getRowModel().rows.map(row => <TableRow key={row.id} data-testid="data-table-row" title={rowTitle} onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row.original) : undefined} className={onRowDoubleClick ? "table-row-clickable" : undefined}>{row.getVisibleCells().map(cell => {
    const meta = metaOf(cell.column.columnDef.meta);
    const rendered = text(flexRender(cell.column.columnDef.cell, cell.getContext()));
    return <TableCell key={cell.id} style={meta.width ? { width: meta.width } : undefined} className={meta.ellipsis ? "cell-ellipsis" : undefined} title={meta.ellipsis ? ellipsisTitle(rendered) : undefined}>{rendered}</TableCell>;
  })}</TableRow>)}</TableBody></Table></div>{table.getPageCount() > 1 && <div className="table-pagination"><span>第 {table.getState().pagination.pageIndex + 1} / {table.getPageCount()} 页，共 {data.length} 条</span><div><Button size="sm" variant="secondary" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>上一页</Button><Button size="sm" variant="secondary" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>下一页</Button></div></div>}</>;
}

/**
 * 只有 accessorKey 的列不会返回字符串，`text()` 的「字符串才翻译」分支因此永不成立：
 * 表头是中文（表头是字符串），单元格却原样吐出 draft / confirmed 之类的英文枚举。
 *
 * DataTable 的既定契约是「默认渲染后端原值，需要中文化的列显式给 cell」
 * （workbench / qc / outsource 面板的测试都钉住了后端原值），
 * 所以这里不改成全局翻译，而是给需要的列提供这个 cell 工厂。
 */
export function statusCell<T extends { status?: string | null }>() {
  return ({ row }: { row: { original: T } }) => displayText(row.original.status ?? "") as ReactNode;
}
