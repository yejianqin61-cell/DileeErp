"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../layout/app-shell";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DataTable } from "../data/data-table";
import { auditColumns, type AuditRow } from "../data/audit-columns";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import type { ColumnDef } from "@tanstack/react-table";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../lib/api-client";
import { fuzzyMatch } from "../../lib/fuzzy-search";
import { notifyError, notifySuccess } from "../ui/toaster";

type Unit = { id: string; name: string; isActive: boolean };
type Operation = AuditRow & { id: string; operationName: string; operationCode?: string | null; defaultUnitId?: string | null; defaultUnit?: { name: string } | null; isActive: boolean; deletedAt?: string | null };
type Location = AuditRow & { id: string; name: string; locationType: "workshop" | "outsource_site"; isActive: boolean; deletedAt?: string | null };

// 主数据 DTO 的可选键不允许空串（default_unit_id 为 UUID、其余会被后端当脏值拒收/重复 409），
// 提交前把空串归一为 undefined，JSON 序列化时会直接省略该键。
const emptyToUndefined = (value: string | undefined) => (value !== undefined && value.trim() !== "" ? value : undefined);
const operationPayload = (values: Record<string, string>) => ({ operation_name: values.operation_name, operation_code: emptyToUndefined(values.operation_code), default_unit_id: emptyToUndefined(values.default_unit_id) });
const locationPayload = (values: Record<string, string>) => ({ name: values.name, location_type: values.location_type, contact_name: emptyToUndefined(values.contact_name), contact_phone: emptyToUndefined(values.contact_phone), address: emptyToUndefined(values.address), remark: emptyToUndefined(values.remark) });

export function MasterDataPoolPage({ kind }: { kind: "operations" | "locations" }) {
  const [rows, setRows] = useState<Array<Operation | Location>>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const isOperations = kind === "operations";

  async function load() {
    setLoading(true); setError("");
    try {
      const response = await apiGet<Operation[] | Location[]>(isOperations ? "/production/operations?include_deleted=true" : "/production/locations?include_deleted=true");
      setRows(response.data);
      if (isOperations) setUnits((await apiGet<Unit[]>("/units")).data.filter((unit) => unit.isActive));
    } catch (cause) { setError(cause instanceof ApiClientError ? cause.message : "基础资料加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [isOperations]);
  async function run(action: () => Promise<unknown>, success: string) { setError(""); try { await action(); notifySuccess(success); setDialog(null); await load(); } catch (cause) { notifyError(cause instanceof ApiClientError ? cause.message : "操作失败"); } }
  const visible = useMemo(() => rows.filter((row) => fuzzyMatch(query, "operationName" in row ? [row.operationName, row.operationCode] : [row.name, row.locationType])), [rows, query]);
  function openCreate() {
    setDialog({ title: isOperations ? "新建工序" : "新建加工地点", fields: isOperations ? [{ name: "operation_name", label: "工序名称", required: true }, { name: "operation_code", label: "工序编码" }, { name: "default_unit_id", label: "默认单位", type: "select", options: units.map((unit) => ({ value: unit.id, label: unit.name })) }] : [{ name: "name", label: "地点名称", required: true }, { name: "location_type", label: "地点类型", type: "select", required: true, defaultValue: "workshop", options: [{ value: "workshop", label: "厂内车间" }, { value: "outsource_site", label: "外加工点" }] }], submit: (values) => void run(() => apiPost(isOperations ? "/production/operations" : "/production/locations", isOperations ? operationPayload(values) : locationPayload(values)), isOperations ? "工序已创建" : "加工地点已创建") });
  }
  function openEdit(row: Operation | Location) {
    const operation = row as Operation; const location = row as Location;
    setDialog({ title: isOperations ? "编辑工序" : "编辑加工地点", fields: isOperations ? [{ name: "operation_name", label: "工序名称", required: true, defaultValue: operation.operationName }, { name: "operation_code", label: "工序编码", defaultValue: operation.operationCode ?? "" }, { name: "default_unit_id", label: "默认单位", type: "select", defaultValue: operation.defaultUnitId ?? undefined, options: units.map((unit) => ({ value: unit.id, label: unit.name })) }] : [{ name: "name", label: "地点名称", required: true, defaultValue: location.name }, { name: "location_type", label: "地点类型", type: "select", required: true, defaultValue: location.locationType, options: [{ value: "workshop", label: "厂内车间" }, { value: "outsource_site", label: "外加工点" }] }], submit: (values) => void run(() => apiPatch(isOperations ? `/production/operations/${row.id}` : `/production/locations/${row.id}`, isOperations ? operationPayload(values) : locationPayload(values)), isOperations ? "工序已更新" : "加工地点已更新") });
  }
  function toggle(row: Operation | Location) { void run(() => apiPatch(isOperations ? `/production/operations/${row.id}/active` : `/production/locations/${row.id}/active`, { is_active: !row.isActive }), row.isActive ? "已停用" : "已启用"); }
  function remove(row: Operation | Location) { void run(() => apiRequest(isOperations ? `/production/operations/${row.id}` : `/production/locations/${row.id}`, { method: "DELETE" }), isOperations ? "工序已删除" : "加工地点已删除"); }
  function restore(row: Operation | Location) { void run(() => apiRequest(isOperations ? `/production/operations/${row.id}/restore` : `/production/locations/${row.id}/restore`, { method: "POST" }), isOperations ? "工序已恢复" : "加工地点已恢复"); }
  const actionCell = (row: Operation | Location) => row.deletedAt ? <Button size="sm" variant="secondary" onClick={() => restore(row)}>恢复</Button> : <><Button size="sm" variant="secondary" onClick={() => openEdit(row)}>编辑</Button><Button size="sm" variant="secondary" onClick={() => toggle(row)}>{row.isActive ? "停用" : "启用"}</Button><Button size="sm" variant="destructive" onClick={() => remove(row)}>删除</Button></>;
  const columns: ColumnDef<Operation | Location>[] = isOperations ? [{ id: "name", header: "工序名称", cell: ({ row }) => (row.original as Operation).operationName }, { id: "code", header: "编码", cell: ({ row }) => (row.original as Operation).operationCode || "-" }, { id: "unit", header: "默认单位", cell: ({ row }) => (row.original as Operation).defaultUnit?.name || "-" }, { id: "status", header: "状态", cell: ({ row }) => row.original.deletedAt ? "已删除" : row.original.isActive ? "启用" : "停用" }, ...auditColumns<Operation | Location>(), { id: "actions", header: "操作", cell: ({ row }) => <div className="page-actions">{actionCell(row.original)}</div> }] : [{ id: "name", header: "地点名称", cell: ({ row }) => (row.original as Location).name }, { id: "type", header: "类型", cell: ({ row }) => (row.original as Location).locationType === "workshop" ? "厂内车间" : "外加工点" }, { id: "status", header: "状态", cell: ({ row }) => row.original.deletedAt ? "已删除" : row.original.isActive ? "启用" : "停用" }, ...auditColumns<Operation | Location>(), { id: "actions", header: "操作", cell: ({ row }) => <div className="page-actions">{actionCell(row.original)}</div> }];
  // 基础资料仍在加载时禁止打开对话框：openCreate() 会把当时的 units 快照进 dialog.fields，
  // 数据到达后不会重建，用户会得到一个**永久为空**的「默认单位」下拉且无法恢复
  // （见 docs/test/results/2026-09-13-e2e-rewrite-and-platform-unit-expansion.md §7.3）。
  return <><PageHeader title={isOperations ? "工序池" : "加工地点池"}><Button onClick={openCreate} disabled={loading} data-testid={isOperations ? "master-data-create-operation" : "master-data-create-location"}>新建{isOperations ? "工序" : "加工地点"}</Button></PageHeader><ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />{error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}{loading ? <LoadingState /> : <section className="panel"><div className="panel-body"><div className="filter-bar"><label>搜索{isOperations ? "工序名称或编码" : "加工地点名称或类型"}<Input data-testid={isOperations ? "operation-search" : "location-search"} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词，空格分隔多个词" /></label></div><p className="panel-note" data-testid={isOperations ? "operation-count" : "location-count"}>共 {rows.length} 条，当前列出 {visible.length} 条</p></div><DataTable columns={columns} data={visible} empty={query.trim() ? <EmptyState title={`没有匹配\u201c${query.trim()}\u201d的{isOperations ? "工序" : "加工地点"}`} description={`共 ${rows.length} 条，换个关键词或清空搜索框。`} /> : <EmptyState title={isOperations ? "暂无工序" : "暂无加工地点"} />} /></section>}</>;
}
