"use client";

// BOM 表工作区（采购与生产共用）。
//
// 为什么抽成共享组件：BOM 现在有两个编辑入口——【采购】按 BOM 下单、【生产】按 BOM 建生产单并领料，
// 两边都要根据现场情况改用量与明细。如果各自实现一套，冲突处理和字段口径必然漂移
// （历史上「规格型号/颜色被 material_snapshot 覆盖」就是这样出现的）。
//
// 并发编辑（本次新增的关口）：
//   打开时记住服务端返回的 `updatedAt`，保存时原样回传 `expected_updated_at`。
//   服务端在事务里取行锁后比对，不一致返回 422 BOM_UPDATE_CONFLICT。
//   前端不重试、不覆盖，而是明确告诉操作者「别人先改了」并给一个重新加载的入口——
//   按宪法「Reversible Business Changes」，不允许静默丢弃别人的现场修正。
import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiRequest } from "../../lib/api-client";
import { displayText } from "../../lib/display-text";
import { notifyError, notifySuccess } from "../ui/toaster";

export type BomMaterialRef = {
  id: string;
  materialCode?: string;
  code?: string;
  name?: string;
  specificationModel?: string | null;
  color?: string | null;
  materialType?: string;
  defaultUnitId?: string;
  isActive?: boolean;
};

export type BomUnitRef = { id: string; name?: string; isActive?: boolean };

export type BomRow = {
  id?: string;
  materialId: string;
  materialName: string;
  model: string;
  specificationModel?: string | null;
  color?: string | null;
  productionBatchBase?: string | null;
  baseUsage?: string | null;
  requiredQuantity: string;
  unit: string;
  unitId?: string | null;
  materialSnapshot: Record<string, unknown>;
};

type BomPayload = { id: string; orderNo: string; status: string; version: number; updatedAt?: string; items: BomRow[] };

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);
/** 规格型号/颜色只在「选择物料 / 新建物料」时引用主数据；保存时不再回填，避免覆盖人工修改。 */
const specOf = (material?: BomMaterialRef | null) => ({ specificationModel: material?.specificationModel ?? "", color: material?.color ?? "" });

export function BomWorkbench({ bomId, title, materials, units, onCreateMaterial, onClose, onSaved }: {
  bomId: string;
  title?: string;
  materials: BomMaterialRef[];
  units: BomUnitRef[];
  /** 打开「新建物料」弹窗，并把新物料回填到回调里指定的行（生产模块未开放新建物料时为 undefined）。 */
  onCreateMaterial?: (apply: (material: BomMaterialRef) => void) => void;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [bom, setBom] = useState<BomPayload | null>(null);
  const [items, setItems] = useState<BomRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(""); setConflict("");
    try {
      const result = await apiGet<BomPayload>(`/boms/${bomId}`);
      setBom(result.data);
      setItems(result.data.items ?? []);
    } catch (cause) {
      setError(messageOf(cause, "BOM表加载失败"));
    } finally { setLoading(false); }
  }, [bomId]);
  useEffect(() => { void load(); }, [load]);

  const materialOptions = materials.filter((item) => item.isActive !== false).map((item) => ({ value: item.id, label: `${item.materialCode ?? item.code ?? ""} / ${item.name ?? "物料"}` }));
  const unitOptions = units.filter((item) => item.isActive !== false).map((item) => ({ value: item.id, label: item.name ?? item.id }));
  const updateItem = (index: number, patch: Partial<BomRow>) => setItems((rows) => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  function changeMaterial(index: number, materialId: string) {
    const material = materials.find((item) => item.id === materialId);
    updateItem(index, { materialId, materialName: material?.name ?? "", ...specOf(material), materialSnapshot: material ?? {} });
  }
  function newRow(material?: BomMaterialRef): BomRow {
    return { materialId: material?.id ?? "", materialName: material?.name ?? "", model: "", ...specOf(material), productionBatchBase: "1", baseUsage: "1", requiredQuantity: "1", unit: "", materialSnapshot: (material ?? {}) as Record<string, unknown> };
  }
  function addRow() {
    const material = materials.find((item) => item.isActive !== false && item.materialType === "raw_material");
    setItems((rows) => [...rows, newRow(material)]);
  }
  function createMaterial() {
    if (!onCreateMaterial) return;
    onCreateMaterial((material) => {
      // 与旧行为一致：已经在编辑明细时把新物料填到当前最后一行；表里没有行时补一行。
      setItems((rows) => rows.length
        ? rows.map((row, index) => (index === rows.length - 1 ? { ...row, materialId: material.id, materialName: material.name ?? "", ...specOf(material), materialSnapshot: material as unknown as Record<string, unknown> } : row))
        : [newRow(material)]);
    });
  }

  async function save() {
    setSaving(true); setError("");
    try {
      const result = await apiRequest<BomPayload>(`/boms/${bomId}/items`, {
        method: "PUT",
        body: JSON.stringify({
          items: items.map((row) => ({ material_id: row.materialId, material_name: row.materialName, model: row.model || undefined, specification_model: row.specificationModel || undefined, color: row.color || undefined, production_batch_base: row.productionBatchBase || undefined, base_usage: row.baseUsage || undefined, material_snapshot: row.materialSnapshot, required_quantity: row.requiredQuantity, unit: row.unit, unit_id: row.unitId || undefined })),
          // 乐观锁令牌：服务端比对失败会返回 422 BOM_UPDATE_CONFLICT，本组件不覆盖、只提示。
          expected_updated_at: bom?.updatedAt,
        }),
      });
      setBom(result.data);
      setItems(result.data.items ?? []);
      setConflict("");
      notifySuccess("BOM表已保存");
      onSaved?.();
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === "BOM_UPDATE_CONFLICT") {
        setConflict(cause.message);
      } else {
        notifyError(messageOf(cause, "BOM表保存失败"));
      }
    } finally { setSaving(false); }
  }

  return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}><SheetContent className="bom-workbench">
    <SheetHeader>
      <SheetTitle>BOM表 {title ?? bom?.orderNo ?? ""}</SheetTitle>
      <SheetDescription>物料名称、型号、规格型号、颜色、数量和单位可直接编辑；规格型号与颜色在选择物料或新建物料时引用物料主数据，保存后保留人工修改。保存会带上打开时的版本，若采购或生产已先改过，会提示你重新加载。</SheetDescription>
    </SheetHeader>
    {loading ? <LoadingState label="正在加载 BOM" /> : <>
      {error && <p className="status-error panel-body" role="alert">{error}<Button size="sm" variant="secondary" onClick={() => void load()}>重新加载</Button></p>}
      {conflict && <div className="panel panel-body status-error" data-testid="bom-conflict" role="alert">
        <p>{conflict}</p>
        <p className="panel-note">你这次改的内容还在屏幕上，没有被写入。重新加载会放弃本地改动并显示最新版本。</p>
        <Button size="sm" variant="secondary" onClick={() => void load()}>重新加载最新版本（放弃本次修改）</Button>
      </div>}
      <div className="page-actions">
        {onCreateMaterial && <Button size="sm" variant="secondary" onClick={createMaterial}>新建物料</Button>}
        <Button size="sm" variant="secondary" onClick={addRow}>添加行</Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>{saving ? "保存中..." : "保存BOM表"}</Button>
      </div>
      {!onCreateMaterial && <p className="panel-note">物料池由【采购 → 物料清单】维护；这里可以直接改用量、单位、规格型号与颜色。</p>}
      <div className="table-wrap"><table className="data-table"><thead><tr><th>序号</th><th>物料名称</th><th>型号</th><th>规格型号</th><th>颜色</th><th>数量</th><th>单位</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{items.map((row, index) => <tr key={row.id ?? `${row.materialId}-${index}`}>
        <td>{index + 1}</td>
        <td><Select value={row.materialId || undefined} onValueChange={(value) => changeMaterial(index, value)}><SelectTrigger><SelectValue placeholder="请选择物料" /></SelectTrigger><SelectContent>{materialOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></td>
        <td><Input value={row.model ?? ""} onChange={(event) => updateItem(index, { model: event.target.value })} /></td>
        <td><Input value={row.specificationModel ?? ""} onChange={(event) => updateItem(index, { specificationModel: event.target.value })} /></td>
        <td><Input value={row.color ?? ""} onChange={(event) => updateItem(index, { color: event.target.value })} /></td>
        <td><Input type="number" min="0" step="0.0001" value={row.requiredQuantity} onChange={(event) => updateItem(index, { requiredQuantity: event.target.value })} /></td>
        <td><Select value={row.unitId ?? undefined} onValueChange={(value) => updateItem(index, { unitId: value, unit: units.find((unit) => unit.id === value)?.name ?? value })}><SelectTrigger><SelectValue placeholder={row.unit || "选择单位"} /></SelectTrigger><SelectContent>{unitOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></td>
        <td><Button size="icon" variant="ghost" title="删除行" aria-label="删除行" onClick={() => setItems((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}><Trash2 size={16} /></Button></td>
      </tr>)}</tbody></table></div>
      {!items.length && <p className="panel-note">这张 BOM 还没有明细行：点「添加行」或「新建物料」开始录入。</p>}
      <p className="panel-note">状态：{bom ? String(displayText(bom.status)) : "-"}　版本：{bom?.version ?? "-"}　最后更新：{bom?.updatedAt ? String(bom.updatedAt).slice(0, 19).replace("T", " ") : "-"}</p>
    </>}</SheetContent></Sheet>;
}
