"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { DataTable } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../../lib/api-client";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type Reference = { id: string; materialCode?: string; code?: string; name?: string; specificationModel?: string | null; color?: string | null; isActive?: boolean; defaultUnitId?: string; materialType?: string; remark?: string | null };
type Unit = { id: string; name?: string; isActive?: boolean };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function MaterialsPage() {
  const [materials, setMaterials] = useState<Reference[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);

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

  function openUnit(parentDraft?: Record<string, string>) {
    setCategoryDialog({
      title: "新建单位",
      fields: [{ name: "name", label: "单位名称", required: true }, { name: "remark", label: "备注", type: "textarea" }],
      submit: async (v) => {
        try {
          const result = await apiPost<Unit>("/units", { name: v.name, remark: v.remark || undefined });
          setUnits((items) => [...items, result.data as unknown as Unit]);
          setCategoryDialog(null);
          notifySuccess("单位已创建");
          openMaterial({ ...parentDraft, default_unit_id: result.data.id });
        } catch (cause) {
          notifyError(messageOf(cause, "单位创建失败"));
        }
      },
    });
  }

  function openMaterial(input?: Record<string, string>) {
    const draft = input ?? {};
    setCategoryDialog({
      title: "新建物料",
      fields: [
        { name: "code_mode", label: "编码方式", type: "select", required: true, defaultValue: draft.code_mode || "auto", options: [{ value: "auto", label: "自动生成" }, { value: "manual", label: "手动填写" }] },
        { name: "material_code", label: "物料编码", defaultValue: draft.material_code, placeholder: "自动生成时留空" },
        { name: "name", label: "物料名称", required: true, defaultValue: draft.name },
        { name: "specification_model", label: "规格型号", defaultValue: draft.specification_model },
        { name: "color", label: "颜色", defaultValue: draft.color },
        { name: "default_unit_id", label: "默认单位", type: "select", required: true, defaultValue: draft.default_unit_id, options: unitOptions },
        { name: "material_type", label: "物料类型", type: "select", required: true, defaultValue: draft.material_type || "raw_material", options: [{ value: "raw_material", label: "原料" }, { value: "finished_product", label: "成品" }] },
        { name: "remark", label: "备注", type: "textarea", defaultValue: draft.remark },
      ],
      submit: async (v) => {
        try {
          const result = await apiPost<Reference>("/materials", { ...v, material_code: v.material_code || undefined, specification_model: v.specification_model || undefined, color: v.color || undefined, material_type: v.material_type || "raw_material", remark: v.remark || undefined });
          setMaterials((items) => [...items, result.data]);
          setCategoryDialog(null);
          notifySuccess("物料已创建");
        } catch (cause) {
          notifyError(messageOf(cause, "物料创建失败"));
        }
      },
    });
  }

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
          <Button onClick={() => openMaterial()}>新建物料</Button>
          <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        </div>
      </PageHeader>
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
      {message && <section className="panel panel-body status-success" role="status">{message}</section>}
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <section className="panel">
        <div className="panel-body">
          <DataTable columns={columns} data={materials} empty={<EmptyState title="暂无物料" />} />
        </div>
      </section>
    </div>
  );
}