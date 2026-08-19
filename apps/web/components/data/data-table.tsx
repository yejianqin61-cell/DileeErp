"use client";

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { EmptyState, LoadingState } from "../feedback/states";

export function DataTable<T>({ columns, data, loading = false, empty }: { columns: ColumnDef<T, any>[]; data: T[]; loading?: boolean; empty?: ReactNode }) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
  if (loading) return <LoadingState />;
  if (!data.length) return <>{empty ?? <EmptyState />}</>;
  return <div className="table-wrap"><table className="data-table"><thead>{table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => <th key={header.id}>{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map(row => <tr key={row.id}>{row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table></div>;
}
