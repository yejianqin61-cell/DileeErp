"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { DataTable } from "../../../components/data/data-table";
import { auditColumns, type AuditRow } from "../../../components/data/audit-columns";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../../lib/api-client";
import { fuzzyMatch } from "../../../lib/fuzzy-search";
import { MaterialCreateDialog } from "../../../components/bom/material-create-dialog";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type Reference = AuditRow & { id: string; materialCode?: string; code?: string; name?: string; specificationModel?: string | null; color?: string | null; isActive?: boolean; defaultUnitId?: string; materialType?: string; remark?: string | null };
type Unit = { id: string; name?: string; isActive?: boolean };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function MaterialsPage() {
  const [materials, setMaterials] = useState<Reference[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // 物料池的关键字搜索（用户 2026-09-16：「所有池子，都要支持搜索」）：
  // 与供应商池等共用 lib/fuzzy-search 的匹配语义（多词 AND、忽略大小写与空白）。
  const [query, setQuery] = useState("");
  // 「新建物料」弹窗（共享组件）：打开时是新建，关闭即销毁，草稿不跨次保留。
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);

  // 默认单位在物料表里存的是 id，人搜的是单位名（「米」），所以这里先把名字解析出来再参与匹配。
  const unitNameOf = (unitId?: string | null) => units.find((unit) => unit.id === unitId)?.name ?? "";
  const visible = useMemo(
    () => materials.filter((item) => fuzzyMatch(query, [item.materialCode, item.code, item.name, item.specificationModel, item.color, unitNameOf(item.defaultUnitId), item.materialType === "finished_product" ? "成品" : "原料", item.remark])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unitNameOf 只读 units，下面已把 units 列为依赖
    [materials, units, query],
  );

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [ms, us] = await Promise.all([apiGet<Reference[]>("/materials"), apiGet<Unit[]>("/units")]);
      setMaterials(ms.data);
      setUnits(us.data);
    } catch (cause) {
      setError(messageOf(cause, "物料数据加载失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function action(path: string, body?: unknown, success = "操作已完成", method: "POST" | "PATCH" = "POST") {
    setError("");
    try {
      if (method === "PATCH") await apiRequest(path, { method, body: JSON.stringify(body) });
      else await apiPost(path, body);
      notifySuccess(success);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }

  const unitOptions = units.filter((u) => u.isActive !== false).map((u) => ({ value: u.id, label: u.name ?? u.id }));

  // 「新建物料」不再是本页自己的一份表单：用共享的 MaterialCreateDialog（BOM 表三处入口也用它），
  // 全站只有一份字段与校验，避免「物料清单里能建、BOM 表里建不出来」这种漂移。
  // 「新建单位」的联动（默认单位 + 新增类目）由该组件内部完成。

  function editMaterial(item: Reference) {
    setCategoryDialog({
      title: "编辑物料",
      fields: [
        { name: "material_code", label: "物料编码", required: true, defaultValue: item.materialCode ?? item.code ?? "" },
        { name: "name", label: "物料名称", required: true, defaultValue: item.name ?? "" },
        { name: "specification_model", label: "规格型号", defaultValue: item.specificationModel ?? "" },
        { name: "color", label: "颜色", defaultValue: item.color ?? "" },
        { name: "default_unit_id", label: "默认单位", type: "select", required: true, defaultValue: item.defaultUnitId, options: unitOptions },
        { name: "material_type", label: "物料类型", type: "select", required: true, defaultValue: item.materialType ?? "raw_material", options: [{ value: "raw_material", label: "原料" }, { value: "finished_product", label: "成品" }] },
      ],
      submit: async (v) => {
        await apiRequest(`/materials/${item.id}`, { method: "PATCH", body: JSON.stringify({ ...v, specification_model: v.specification_model || null, color: v.color || null }) });
        setCategoryDialog(null);
        setMessage("物料已更新");
        await load();
      },
    });
  }

  function deleteMaterial(id: string) {
    setDialog({
      title: "删除物料",
      fields: [{ name: "confirm", label: "确认删除该物料？（被 BOM 或采购单引用的物料会被拒绝删除）", required: true, placeholder: "输入 删除 确认" }],
      submit: async (v) => {
        if (v.confirm?.trim() !== "删除") throw new Error("请输入\u201c删除\u201d确认");
        await apiRequest(`/materials/${id}`, { method: "DELETE" });
        notifySuccess("物料已删除");
        await load();
      },
    });
  }

  const columns: ColumnDef<Reference>[] = [
    { accessorKey: "materialCode", header: "物料编码" },
    { accessorKey: "name", header: "物料名称" },
    { accessorKey: "specificationModel", header: "规格型号", cell: ({ row }) => row.original.specificationModel ?? "-" },
    { accessorKey: "color", header: "颜色", cell: ({ row }) => row.original.color ?? "-" },
    { id: "unit", header: "默认单位", cell: ({ row }) => units.find((u) => u.id === row.original.defaultUnitId)?.name ?? "-" },
    { id: "status", header: "状态", cell: ({ row }) => row.original.isActive === false ? "停用" : "启用" },
    ...auditColumns<Reference>(),
    {
      id: "actions", header: "操作",
      cell: ({ row }) => (
        <div className="action-row">
          <Button size="sm" variant="secondary" onClick={() => editMaterial(row.original)}>编辑</Button>
          <Button size="sm" variant="ghost" onClick={() => void action(`/materials/${row.original.id}/active`, { is_active: row.original.isActive === false }, row.original.isActive === false ? "物料已启用" : "物料已停用")}>{row.original.isActive === false ? "启用" : "停用"}</Button>
          <Button size="sm" variant="destructive" onClick={() => void deleteMaterial(row.original.id)}>删除</Button>
        </div>
      ),
    },
  ];

  if (loading) return <><PageHeader title="物料清单" breadcrumb={["采购", "物料清单"]} /><LoadingState /></>;
  if (categoryDialog) return <ActionDialog open title={categoryDialog.title} fields={categoryDialog.fields} onOpenChange={(open) => { if (!open) setCategoryDialog(null); }} onSubmit={(values) => { void categoryDialog.submit(values); }} />;

  return (
    <div className="page-root" data-testid="page-procurement-materials">
      <PageHeader title="物料清单" breadcrumb={["采购", "物料清单"]}>
        <div className="page-actions">
          <Button onClick={() => setCreating(true)}>新建物料</Button>
          <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        </div>
      </PageHeader>
      <MaterialCreateDialog
        open={creating}
        units={units}
        onOpenChange={setCreating}
        onUnitCreated={(unit) => setUnits((items) => [...items, unit])}
        onCreated={(material) => { setMaterials((items) => [...items.filter((item) => item.id !== material.id), material]); setCreating(false); }}
      />
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
      {message && <section className="panel panel-body status-success" role="status">{message}</section>}
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <section className="panel">
        <div className="panel-heading">
          <h2>物料清单</h2>
          <span className="panel-note" data-testid="material-count">共 {materials.length} 个物料（启用 {materials.filter((item) => item.isActive !== false).length} 个），当前列出 {visible.length} 条</span>
        </div>
        <div className="panel-body">
          <div className="filter-bar">
            <label>搜索物料编码、名称、规格型号或颜色<Input data-testid="material-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词，空格分隔多个词" /></label>
          </div>
          <DataTable
            columns={columns}
            data={visible}
            empty={query.trim()
              ? <EmptyState title={`没有匹配\u201c${query.trim()}\u201d的物料`} description={`共 ${materials.length} 个物料，换个关键词或清空搜索框。`} />
              : <EmptyState title="暂无物料" />}
          />
        </div>
      </section>
    </div>
  );
}