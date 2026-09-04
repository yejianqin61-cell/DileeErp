"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../layout/app-shell";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DataTable } from "../data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import type { ColumnDef } from "@tanstack/react-table";
import { ApiClientError, apiGet, apiPatch, apiPost } from "../../lib/api-client";

type Unit = { id: string; name: string; isActive: boolean };
type Operation = { id: string; operationName: string; operationCode?: string | null; defaultUnitId?: string | null; defaultUnit?: { name: string } | null; isActive: boolean };
type Location = { id: string; name: string; locationType: "workshop" | "outsource_site"; isActive: boolean };

export function MasterDataPoolPage({ kind }: { kind: "operations" | "locations" }) {
  const [rows, setRows] = useState<Array<Operation | Location>>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const isOperations = kind === "operations";

  async function load() {
    setLoading(true); setError("");
    try {
      const response = await apiGet<Operation[] | Location[]>(isOperations ? "/production/operations" : "/production/locations");
      setRows(response.data);
      if (isOperations) setUnits((await apiGet<Unit[]>("/units")).data.filter((unit) => unit.isActive));
    } catch (cause) { setError(cause instanceof ApiClientError ? cause.message : "基础资料加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [isOperations]);
  async function run(action: () => Promise<unknown>, success: string) { setError(""); try { await action(); setMessage(success); setDialog(null); await load(); } catch (cause) { setError(cause instanceof ApiClientError ? cause.message : "操作失败"); } }
  const visible = useMemo(() => rows.filter((row) => {
    const label = "operationName" in row ? `${row.operationName} ${row.operationCode ?? ""}` : `${row.name} ${row.locationType}`;
    return !query || label.toLowerCase().includes(query.toLowerCase());
  }), [rows, query]);
  function openCreate() {
    setDialog({ title: isOperations ? "新建工序" : "新建加工地点", fields: isOperations ? [{ name: "operation_name", label: "工序名称", required: true }, { name: "operation_code", label: "工序编码" }, { name: "default_unit_id", label: "默认单位", type: "select", options: units.map((unit) => ({ value: unit.id, label: unit.name })) }] : [{ name: "name", label: "地点名称", required: true }, { name: "location_type", label: "地点类型", type: "select", required: true, defaultValue: "workshop", options: [{ value: "workshop", label: "厂内车间" }, { value: "outsource_site", label: "外加工点" }] }], submit: (values) => void run(() => apiPost(isOperations ? "/production/operations" : "/production/locations", values), isOperations ? "工序已创建" : "加工地点已创建") });
  }
  function openEdit(row: Operation | Location) {
    const operation = row as Operation; const location = row as Location;
    setDialog({ title: isOperations ? "编辑工序" : "编辑加工地点", fields: isOperations ? [{ name: "operation_name", label: "工序名称", required: true, defaultValue: operation.operationName }, { name: "operation_code", label: "工序编码", defaultValue: operation.operationCode ?? "" }, { name: "default_unit_id", label: "默认单位", type: "select", defaultValue: operation.defaultUnitId ?? undefined, options: units.map((unit) => ({ value: unit.id, label: unit.name })) }] : [{ name: "name", label: "地点名称", required: true, defaultValue: location.name }, { name: "location_type", label: "地点类型", type: "select", required: true, defaultValue: location.locationType, options: [{ value: "workshop", label: "厂内车间" }, { value: "outsource_site", label: "外加工点" }] }], submit: (values) => void run(() => apiPatch(isOperations ? `/production/operations/${row.id}` : `/production/locations/${row.id}`, values), isOperations ? "工序已更新" : "加工地点已更新") });
  }
  function toggle(row: Operation | Location) { void run(() => apiPatch(isOperations ? `/production/operations/${row.id}/active` : `/production/locations/${row.id}/active`, { is_active: !row.isActive }), row.isActive ? "已停用" : "已启用"); }
  const columns: ColumnDef<Operation | Location>[] = isOperations ? [{ id: "name", header: "工序名称", cell: ({ row }) => (row.original as Operation).operationName }, { id: "code", header: "编码", cell: ({ row }) => (row.original as Operation).operationCode || "-" }, { id: "unit", header: "默认单位", cell: ({ row }) => (row.original as Operation).defaultUnit?.name || "-" }, { id: "status", header: "状态", cell: ({ row }) => row.original.isActive ? "启用" : "停用" }, { id: "actions", header: "操作", cell: ({ row }) => <div className="page-actions"><Button size="sm" variant="secondary" onClick={() => openEdit(row.original)}>编辑</Button><Button size="sm" variant="secondary" onClick={() => toggle(row.original)}>{row.original.isActive ? "停用" : "启用"}</Button></div> }] : [{ id: "name", header: "地点名称", cell: ({ row }) => (row.original as Location).name }, { id: "type", header: "类型", cell: ({ row }) => (row.original as Location).locationType === "workshop" ? "厂内车间" : "外加工点" }, { id: "status", header: "状态", cell: ({ row }) => row.original.isActive ? "启用" : "停用" }, { id: "actions", header: "操作", cell: ({ row }) => <div className="page-actions"><Button size="sm" variant="secondary" onClick={() => openEdit(row.original)}>编辑</Button><Button size="sm" variant="secondary" onClick={() => toggle(row.original)}>{row.original.isActive ? "停用" : "启用"}</Button></div> }];
  return <><PageHeader title={isOperations ? "工序池" : "加工地点池"}><Button onClick={openCreate}>新建{isOperations ? "工序" : "加工地点"}</Button></PageHeader><ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />{message && <section className="panel panel-body status-success" role="status">{message}</section>}{error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}{loading ? <LoadingState /> : <section className="panel"><div className="panel-body"><label>搜索<Input value={query} onChange={(event) => setQuery(event.target.value)} /></label></div><DataTable columns={columns} data={visible} empty={<EmptyState title={isOperations ? "暂无工序" : "暂无加工地点"} />} /></section>}</>;
}
