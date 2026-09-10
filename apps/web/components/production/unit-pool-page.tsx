"use client";

// 单位池：全站单位主数据的唯一维护入口（打、个、码等）。
//
// 与工序池/加工地点池并列放在生产模块。这里没有复用 MasterDataPoolPage，
// 是因为后者按 operations/locations 两种类型分支（字段、动作、列定义都不同），
// 再塞第三种类型会让三套分支互相牵制；单位池的字段与动作更简单，单独实现更清晰。
//
// 后端行为（procurement-master-data.service.ts）：删除会先检查物料默认单位、BOM 行、
// 工序默认单位、生产单工序等引用，被引用时拒绝删除 —— 因此页面同时提供“停用”，
// 停用后不再进入任何下拉选项。

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../layout/app-shell";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DataTable } from "../data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import type { ColumnDef } from "@tanstack/react-table";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../lib/api-client";
import { unitMutationPayload } from "../../lib/unit-options";
import { notifyError, notifySuccess } from "../ui/toaster";

type Unit = { id: string; name: string; remark?: string | null; isActive: boolean; createdAt?: string; updatedAt?: string };

export function UnitPoolPage() {
  const [rows, setRows] = useState<Unit[]>([]);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true); setError("");
    try { setRows((await apiGet<Unit[]>("/units")).data); }
    catch (cause) { setError(cause instanceof ApiClientError ? cause.message : "单位池加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function run(action: () => Promise<unknown>, success: string) {
    setError("");
    try { await action(); notifySuccess(success); setDialog(null); await load(); }
    catch (cause) { notifyError(cause instanceof ApiClientError ? cause.message : "操作失败"); }
  }

  const activeCount = rows.filter((row) => row.isActive).length;
  const visible = useMemo(() => rows.filter((row) => !query || `${row.name} ${row.remark ?? ""}`.toLowerCase().includes(query.toLowerCase())), [rows, query]);

  function openCreate() {
    setDialog({ title: "新建单位", fields: [{ name: "name", label: "单位名称", required: true, placeholder: "例如：打、个、码" }, { name: "remark", label: "备注", type: "textarea" }], submit: (values) => void run(() => apiPost("/units", unitMutationPayload(values)), "单位已创建") });
  }
  function openEdit(row: Unit) {
    setDialog({ title: `编辑单位：${row.name}`, fields: [{ name: "name", label: "单位名称", required: true, defaultValue: row.name }, { name: "remark", label: "备注", type: "textarea", defaultValue: row.remark ?? "" }], submit: (values) => void run(() => apiPatch(`/units/${row.id}`, unitMutationPayload(values)), "单位已更新") });
  }
  function toggle(row: Unit) { void run(() => apiPatch(`/units/${row.id}/active`, { is_active: !row.isActive }), row.isActive ? "单位已停用" : "单位已启用"); }
  function remove(row: Unit) { void run(() => apiRequest(`/units/${row.id}`, { method: "DELETE" }), "单位已删除"); }

  const columns: ColumnDef<Unit>[] = [
    { accessorKey: "name", header: "单位名称" },
    { accessorKey: "remark", header: "备注", cell: ({ row }) => row.original.remark || "-" },
    { id: "status", header: "状态", cell: ({ row }) => <span className={row.original.isActive ? "status-success" : "status-warning"}>{row.original.isActive ? "启用" : "停用"}</span> },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="page-actions"><Button size="sm" variant="secondary" onClick={() => openEdit(row.original)}>编辑</Button><Button size="sm" variant="secondary" onClick={() => toggle(row.original)}>{row.original.isActive ? "停用" : "启用"}</Button><Button size="sm" variant="destructive" onClick={() => remove(row.original)}>删除</Button></div> }
  ];

  return <>
    <PageHeader title="单位池" description="全站单位主数据：物料默认单位、BOM 行、采购与入库、工序默认单位都从这里下拉引用。">
      <Button onClick={openCreate}>新建单位</Button>
    </PageHeader>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {loading ? <LoadingState /> : <>
      <section className="panel"><div className="panel-body"><p className="panel-note">共 {rows.length} 个单位，其中 <strong>{activeCount}</strong> 个启用。停用后不再出现在任何单位下拉中；被物料、BOM 或工序引用的单位无法删除，请改用停用。</p><div className="filter-bar"><label>搜索单位名称或备注<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词" /></label></div></div></section>
      <section className="panel"><DataTable columns={columns} data={visible} empty={<EmptyState title="暂无单位" description="点击右上角「新建单位」添加打、个、码等单位。" />} /></section>
    </>}
  </>;
}
