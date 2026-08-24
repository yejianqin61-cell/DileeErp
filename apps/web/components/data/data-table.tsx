"use client";

import { flexRender, getCoreRowModel, getPaginationRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { EmptyState, LoadingState } from "../feedback/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

export function DataTable<T>({ columns, data, loading = false, empty, pageSize = 20 }: { columns: ColumnDef<T, any>[]; data: T[]; loading?: boolean; empty?: ReactNode; pageSize?: number }) {
  const table = useReactTable({ data, columns, initialState: { pagination: { pageSize } }, getCoreRowModel: getCoreRowModel(), getPaginationRowModel: getPaginationRowModel() });
  if (loading) return <LoadingState />;
  if (!data.length) return <>{empty ?? <EmptyState />}</>;
  return <><div className="table-wrap"><Table><TableHeader>{table.getHeaderGroups().map(group => <TableRow key={group.id}>{group.headers.map(header => <TableHead key={header.id}>{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}</TableHead>)}</TableRow>)}</TableHeader><TableBody>{table.getRowModel().rows.map(row => <TableRow key={row.id}>{row.getVisibleCells().map(cell => <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}</TableRow>)}</TableBody></Table></div>{table.getPageCount() > 1 && <div className="table-pagination"><span>第 {table.getState().pagination.pageIndex + 1} / {table.getPageCount()} 页，共 {data.length} 条</span><div><button type="button" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>上一页</button><button type="button" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>下一页</button></div></div>}</>;
}
