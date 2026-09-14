"use client";

import { flexRender, getCoreRowModel, getPaginationRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { EmptyState, LoadingState } from "../feedback/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Button } from "../ui/button";
import { displayText } from "../../lib/display-text";

export function DataTable<T>({ columns, data, loading = false, empty, pageSize = 20 }: { columns: ColumnDef<T, any>[]; data: T[]; loading?: boolean; empty?: ReactNode; pageSize?: number }) {
  const table = useReactTable({ data, columns, initialState: { pagination: { pageSize } }, getCoreRowModel: getCoreRowModel(), getPaginationRowModel: getPaginationRowModel() });
  if (loading) return <LoadingState />;
  if (!data.length) return <>{empty ?? <EmptyState />}</>;
  const text = (value: ReactNode): ReactNode => typeof value === "string" ? String(displayText(value)) : value;
  return <><div className="table-wrap" data-testid="data-table"><Table><TableHeader>{table.getHeaderGroups().map(group => <TableRow key={group.id}>{group.headers.map(header => <TableHead key={header.id}>{header.isPlaceholder ? null : text(flexRender(header.column.columnDef.header, header.getContext()))}</TableHead>)}</TableRow>)}</TableHeader><TableBody>{table.getRowModel().rows.map(row => <TableRow key={row.id} data-testid="data-table-row">{row.getVisibleCells().map(cell => <TableCell key={cell.id}>{text(flexRender(cell.column.columnDef.cell, cell.getContext()))}</TableCell>)}</TableRow>)}</TableBody></Table></div>{table.getPageCount() > 1 && <div className="table-pagination"><span>第 {table.getState().pagination.pageIndex + 1} / {table.getPageCount()} 页，共 {data.length} 条</span><div><Button size="sm" variant="secondary" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>上一页</Button><Button size="sm" variant="secondary" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>下一页</Button></div></div>}</>;
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
