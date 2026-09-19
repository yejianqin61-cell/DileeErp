"use client";

// 生产单详情页里的领料面板：新建/编辑领料草稿、提交给仓库、撤回提交、重新打开、冲销，并列出该生产单的单据。
// 领料单只绑定生产单（一个生产单可开多张），所以入口放在具体生产单页面最自然。
// 出库改成两步：生产只负责「确认提交」（draft → pending_outbound，不写库存），
// 原料真正出库由仓库「确认出库」（pending_outbound → posted，写库存事实）完成。
// 与仓库页共用同一套接口（/production/material-movements 及其 issue-preview / submit / reopen / reverse）。

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { DataTable } from "../data/data-table";
import { auditColumns, auditDetailFields, type AuditRow } from "../data/audit-columns";
import { EmptyState } from "../feedback/states";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { RecordDetailDialog, type DetailField } from "../finance/record-detail-dialog";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../lib/api-client";
// 时间统一走 lib/audit-time（固定北京时间）：toLocaleString 按运行宿主时区走。
import { formatBeijingShort } from "../../lib/audit-time";
import { isMaterialMovementDocumentType, movementEditorHref } from "../../lib/material-slip-api";
import { notifyError, notifySuccess } from "../ui/toaster";

type MovementLine = { id: string; materialId: string; quantity: string; remark?: string | null; unit?: { name: string } | null; material?: { materialCode?: string; name: string; specificationModel?: string | null } | null };
type Movement = AuditRow & { id: string; movementNo: string; documentType: string; status: string; orderNo?: string | null; productionOrderId?: string | null; businessDate?: string | null; submittedAt?: string | null; createdAt: string; remark?: string | null; reason?: string | null; productionOrder?: { productionOrderNo: string; orderNo: string } | null; lines: MovementLine[] };
type BomItem = { materialId: string; materialName: string; model?: string | null; specificationModel?: string | null; requiredQuantity: string; unit: string; unitId?: string | null };
type Material = { id: string; materialCode?: string; name: string; materialType?: string; isActive?: boolean };
type PreviewLine = { material_id: string; material_name?: string; material_code?: string; model?: string | null; unit?: string | null; bom_reference_quantity: string | null; inventory_quantity?: string; available_before: string; available_after: string; cumulative_issued_after: string; production_outstanding_quantity?: string | null; risks: Array<{ type: string }> };
type Preview = { lines: PreviewLine[] };
type DraftLine = { materialId: string; quantity: string; remark: string };
// documentType 决定过账走 /post 还是 /post-replenishment：这个面板同时列出领料单与补料单。
type Draft = { id?: string; documentType: "issue" | "replenishment"; lines: DraftLine[] };

const errorText = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const statusLabels: Record<string, string> = { draft: "草稿", pending_outbound: "待仓库出库", posted: "已过账", reversed: "已冲销" };
const typeLabels: Record<string, string> = { issue: "领料单", replenishment: "补料单", return: "退料单", scrap: "报废单", reversal: "冲销单" };
const riskLabels: Record<string, string> = { MATERIAL_NOT_IN_BOM_WARNING: "不在 BOM 中", OVER_ISSUE_WARNING: "超出 BOM 用量", INSUFFICIENT_STOCK_WARNING: "库存不足" };
const idempotencyKey = () => `web-issue-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function MaterialIssuesPanel({ productionOrderId, bomId, issuable, onChanged }: { productionOrderId: string; bomId?: string | null; issuable: boolean; onChanged?: () => void }) {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [bomItems, setBomItems] = useState<BomItem[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> } | null>(null);
  // 双击条目弹出的详情：列表行给不出全部字段（物料主数据只有明细接口才有），打开时按 id 单独拉一次。
  const [detailId, setDetailId] = useState("");
  const [detail, setDetail] = useState<Movement | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailNonce, setDetailNonce] = useState(0);

  const materialOptions = useMemo(() => {
    if (bomItems.length) return bomItems.map((item) => ({ value: item.materialId, label: `${item.materialName}${item.specificationModel || item.model ? ` / ${item.specificationModel ?? item.model}` : ""}（BOM ${item.requiredQuantity} ${item.unit}）` }));
    return materials.filter((item) => item.isActive !== false && (!item.materialType || item.materialType === "raw_material")).map((item) => ({ value: item.id, label: `${item.name}${item.materialCode ? ` / ${item.materialCode}` : ""}` }));
  }, [bomItems, materials]);
  const firstMaterialId = materialOptions[0]?.value ?? "";

  async function load() {
    setError("");
    try {
      const [movementResult, materialResult] = await Promise.all([
        apiGet<Movement[]>(`/production/material-movements?production_order_id=${encodeURIComponent(productionOrderId)}`),
        bomId ? apiGet<{ items: BomItem[] }>(`/boms/${bomId}`).catch(() => ({ data: { items: [] as BomItem[] }, meta: {} })) : apiGet<Material[]>("/materials").catch(() => ({ data: [] as Material[], meta: {} })),
      ]);
      setMovements(movementResult.data ?? []);
      if (bomId) setBomItems((materialResult.data as { items: BomItem[] }).items ?? []);
      else { setBomItems([]); setMaterials(materialResult.data as Material[]); }
    } catch (cause) { setError(errorText(cause, "领料单加载失败")); }
  }
  useEffect(() => { void load(); }, [productionOrderId, bomId]);
  useEffect(() => {
    if (!detailId) { setDetail(null); return; }
    let cancelled = false;
    setDetailLoading(true); setDetailError("");
    apiGet<Movement>(`/production/material-movements/${detailId}`)
      .then((result) => { if (!cancelled) setDetail(result.data); })
      .catch((cause) => { if (!cancelled) setDetailError(errorText(cause, "领料单详情加载失败")); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [detailId, detailNonce]);

  async function refreshPreview(next: Draft) {
    if (!next.lines.length) { setPreview(null); return; }
    try { setPreview((await apiPost<Preview>("/production/material-movements/issue-preview", { production_order_id: productionOrderId, lines: next.lines.map((line) => ({ material_id: line.materialId, quantity: line.quantity, remark: line.remark || undefined })) })).data); }
    catch { setPreview(null); }
  }
  /** 新增行默认选还没有用过的物料；都用过了就返回空，让用户显式选择（同一物料只能一行）。 */
  function firstUnusedMaterial(current: DraftLine[]) {
    const used = new Set(current.map((line) => line.materialId));
    return materialOptions.find((option) => !used.has(option.value))?.value ?? "";
  }
  /** 当前草稿是否已经把可选物料都登记完了。 */
  const allMaterialsUsed = Boolean(draft) && materialOptions.length > 0 && materialOptions.every((option) => draft?.lines.some((line) => line.materialId === option.value));
  function openCreate() {
    const next: Draft = { documentType: "issue", lines: [{ materialId: firstMaterialId, quantity: "1", remark: "" }] };
    setDraft(next); setError(""); void refreshPreview(next);
  }
  function openEdit(movement: Movement) {
    const next: Draft = {
      id: movement.id,
      documentType: isMaterialMovementDocumentType(movement.documentType) ? movement.documentType : "issue",
      // 每行备注必须带出来：PATCH 会整批替换明细，留空等于把用户之前填的备注清掉。
      lines: movement.lines.map((line) => ({ materialId: line.materialId, quantity: line.quantity, remark: line.remark ?? "" })),
    };
    setDraft(next); setError(""); void refreshPreview(next);
  }
  function updateLine(index: number, patch: Partial<DraftLine>) {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, lines: current.lines.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line) };
      void refreshPreview(next);
      return next;
    });
  }
  function addLine() { setDraft((current) => { if (!current) return current; const next = { ...current, lines: [...current.lines, { materialId: firstUnusedMaterial(current.lines), quantity: "1", remark: "" }] }; void refreshPreview(next); return next; }); }
  function removeLine(index: number) { setDraft((current) => { if (!current) return current; const next = { ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index) }; void refreshPreview(next); return next; }); }

  function payload(current: Draft) { return { production_order_id: productionOrderId, lines: current.lines.map((line) => ({ material_id: line.materialId, quantity: line.quantity, remark: line.remark || undefined })) }; }
  /** 面板同时列出领料单与补料单，提示语按当前草稿类型走，避免把补料单说成领料单。 */
  const draftLabel = (current: Draft | null) => typeLabels[current?.documentType ?? "issue"] ?? "领料单";
  async function saveDraft(): Promise<string | null> {
    if (!draft?.lines.length) { setError(`${draftLabel(draft)}至少需要一条物料明细`); return null; }
    // 服务端会拒绝重复物料（422），这里先拦，省得用户填完才失败。
    const materialIds = draft.lines.map((line) => line.materialId);
    if (new Set(materialIds).size !== materialIds.length) { setError("同一物料只能有一行：请合并数量后再保存"); return null; }
    if (draft.lines.some((line) => !line.materialId || !line.quantity || Number(line.quantity) <= 0)) { setError("每一行都必须选择物料并填写大于 0 的数量"); return null; }
    try {
      if (draft.id) { await apiPatch(`/production/material-movements/${draft.id}`, payload(draft)); notifySuccess(`${draftLabel(draft)}草稿已保存`); return draft.id; }
      // 只有领料单在这里新建；补料单请走「新建补料单」入口（必须填补料原因）。
      const created = await apiPost<{ id: string }>("/production/material-movements", payload(draft));
      notifySuccess("领料单已生成（草稿）");
      return created.data?.id ?? null;
    } catch (cause) { setError(errorText(cause, "领料单保存失败")); return null; }
  }
  async function save(): Promise<void> {
    setBusy("save");
    const id = await saveDraft();
    setBusy("");
    if (id) { setDraft(null); setPreview(null); await load(); onChanged?.(); }
  }
  async function saveAndSubmit(): Promise<void> {
    if (busy) return;
    setBusy("submit");
    const documentType = draft?.documentType ?? "issue";
    const id = await saveDraft();
    if (id) {
      // 保存后只提交给仓库（draft → pending_outbound），不写库存事实：真正的原料出库由仓库「确认出库」完成。
      try { await apiPost(`/production/material-movements/${id}/submit`, {}); notifySuccess("已提交仓库，等待确认出库"); setDraft(null); setPreview(null); await load(); onChanged?.(); }
      catch (cause) { setError(errorText(cause, "已保存，但提交失败（可稍后在列表中提交）")); setDraft({ ...(draft ?? { documentType, lines: [] }), id }); await load(); }
    }
    setBusy("");
  }
  /**
   * 确认提交：draft → pending_outbound。只改状态、不动库存，因此没有幂等键 ——
   * 有没有键都不影响结果（重复提交会被服务端按「不是草稿」拒绝），
   * 库存事实由仓库的「确认出库」写，那一端才需要幂等键防重复扣减。
   */
  async function submit(movement: Movement) {
    setBusy(movement.id);
    try { await apiPost(`/production/material-movements/${movement.id}/submit`, {}); notifySuccess("已提交仓库，等待确认出库"); await load(); onChanged?.(); }
    catch (cause) { notifyError(errorText(cause, "提交失败")); }
    setBusy("");
  }
  async function remove(movement: Movement) {
    setBusy(movement.id);
    try { await apiRequest(`/production/material-movements/${movement.id}`, { method: "DELETE" }); notifySuccess("领料草稿已删除"); await load(); onChanged?.(); }
    catch (cause) { notifyError(errorText(cause, "删除失败")); }
    setBusy("");
  }
  function reopen(movement: Movement) { setDialog({ title: `重新打开领料单：${movement.movementNo}`, fields: [{ name: "reason", label: "重新打开原因", type: "textarea", required: true }], submit: (values) => void action(`/production/material-movements/${movement.id}/reopen`, { reason: values.reason }, "领料单已重新打开为草稿") }); }
  /** 撤回提交：单据还停在 pending_outbound（尚无库存事实），reopen 只是把状态退回草稿，不产生冲销。 */
  function withdraw(movement: Movement) { setDialog({ title: `撤回提交：${movement.movementNo}`, fields: [{ name: "reason", label: "撤回原因", type: "textarea", required: true }], submit: (values) => void action(`/production/material-movements/${movement.id}/reopen`, { reason: values.reason }, "已撤回提交，单据回到草稿") }); }
  function reverse(movement: Movement) { setDialog({ title: `冲销领料单：${movement.movementNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (values) => void action(`/production/material-movements/${movement.id}/reverse`, { reason: values.reason, idempotency_key: idempotencyKey() }, "领料单已冲销") }); }
  async function action(path: string, body: unknown, success: string) {
    setBusy("action");
    try { await apiPost(path, body); notifySuccess(success); setDialog(null); await load(); onChanged?.(); }
    catch (cause) { notifyError(errorText(cause, "操作失败")); }
    setBusy("");
  }

  const columns = [
    { accessorKey: "movementNo", header: "单据号" },
    { id: "documentType", header: "类型", cell: ({ row }: { row: { original: Movement } }) => typeLabels[row.original.documentType] ?? row.original.documentType },
    { id: "businessDate", header: "业务日期", cell: ({ row }: { row: { original: Movement } }) => (row.original.businessDate ?? row.original.createdAt ?? "").slice(0, 10) },
    { id: "lines", header: "明细", cell: ({ row }: { row: { original: Movement } }) => `${row.original.lines.length} 项 / 合计 ${row.original.lines.reduce((sum, line) => sum + Number(line.quantity), 0)}` },
    { id: "status", header: "状态", cell: ({ row }: { row: { original: Movement } }) => statusLabels[row.original.status] ?? row.original.status },
    ...auditColumns<Movement>(),
    { id: "actions", header: "操作", cell: ({ row }: { row: { original: Movement } }) => {
      const movement = row.original;
      if (movement.status === "draft") return <div className="page-actions"><Button size="sm" variant="secondary" disabled={busy === movement.id} onClick={() => openEdit(movement)}>编辑</Button><Button size="sm" disabled={busy === movement.id} onClick={() => void submit(movement)}>确认提交</Button><Button size="sm" variant="ghost" disabled={busy === movement.id} onClick={() => void remove(movement)}>删除</Button></div>;
      // 待出库阶段不做任何库存动作：这里只提示「已交给仓库」并允许生产自己撤回。
      if (movement.status === "pending_outbound") return <div className="page-actions"><span className="status-warning">等待仓库出库</span><Button size="sm" variant="secondary" disabled={busy === "action"} onClick={() => withdraw(movement)}>撤回提交</Button></div>;
      if (movement.status === "posted") return <div className="page-actions"><Button size="sm" variant="secondary" disabled={busy === "action"} onClick={() => reopen(movement)}>重新打开</Button><Button size="sm" variant="ghost" disabled={busy === "action"} onClick={() => reverse(movement)}>冲销</Button></div>;
      return null;
    } },
  ];

  // 详情里的领用物料表：列表行只有 materialId，物料编码/名称/规格型号必须来自详情接口。
  const detailLineColumns = [
    { id: "materialCode", header: "物料编码", cell: ({ row }: { row: { original: MovementLine } }) => row.original.material?.materialCode ?? "-" },
    { id: "materialName", header: "物料名称", cell: ({ row }: { row: { original: MovementLine } }) => row.original.material?.name ?? row.original.materialId },
    { id: "specification", header: "规格型号", cell: ({ row }: { row: { original: MovementLine } }) => row.original.material?.specificationModel ?? "-" },
    { id: "unit", header: "单位", cell: ({ row }: { row: { original: MovementLine } }) => row.original.unit?.name ?? "-" },
    { accessorKey: "quantity", header: "数量" },
    { id: "remark", header: "备注", cell: ({ row }: { row: { original: MovementLine } }) => row.original.remark ?? "-" },
  ];

  const detailFields: DetailField[] = detail ? [
    { label: "单据号", value: detail.movementNo },
    { label: "类型", value: typeLabels[detail.documentType] ?? detail.documentType },
    { label: "状态", value: statusLabels[detail.status] ?? detail.status },
    { label: "业务日期", value: (detail.businessDate ?? detail.createdAt ?? "").slice(0, 10) },
    { label: "生产单号", value: detail.productionOrder?.productionOrderNo ?? "-" },
    { label: "订单号", value: detail.orderNo ?? detail.productionOrder?.orderNo ?? "-" },
    { label: "提交时间", value: formatBeijingShort(detail.submittedAt) || "-" },
    { label: "备注", value: detail.remark, wide: true },
    { label: "补料原因", value: detail.reason, wide: true },
    ...auditDetailFields(detail),
  ] : [];

  return <section className="panel">
    <div className="panel-heading"><h2>生产领料单</h2><div className="page-actions">
      <Button variant="secondary" onClick={() => void load()}>刷新</Button>
      <Button onClick={openCreate} disabled={!issuable || Boolean(draft) || !materialOptions.length}>{draft ? "正在编辑草稿" : "新建领料单"}</Button>
      {/* 补料单必须填原因，走全屏编辑页；同一生产单可开多张。 */}
      <Button asChild variant="secondary"><Link href={movementEditorHref("replenishment", { productionOrderId })}>新建补料单</Link></Button>
    </div></div>
    <div className="panel-body">
      {!issuable && <p className="status-error">只有「生产中」的厂内生产单可以领料；请先启动生产（外加工生产单不在本厂领料）。</p>}
      {issuable && !materialOptions.length && <p className="status-error">该生产单没有可选物料：请先维护 BOM 明细或原料主数据。</p>}
      {error && <div className="panel-body status-error">{error}</div>}
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { void dialog?.submit(values); }} />
      {draft && <div className="detail-list">
        <div className="table-wrap"><table className="ui-table"><thead><tr><th className="ui-table-head">物料</th><th className="ui-table-head">BOM 核定用量</th><th className="ui-table-head">当前库存</th><th className="ui-table-head">生产已领累计</th><th className="ui-table-head">生产未领用</th><th className="ui-table-head">本次领料数量</th><th className="ui-table-head">风险</th><th className="ui-table-head">操作</th></tr></thead>
          <tbody>{draft.lines.map((line, index) => { const info = preview?.lines[index]; return <tr key={`${line.materialId}-${index}`}>
            <td><Select value={line.materialId || undefined} onValueChange={(value) => updateLine(index, { materialId: value })}><SelectTrigger><SelectValue placeholder="选择原料" /></SelectTrigger><SelectContent>{materialOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></td>
            <td>{info?.bom_reference_quantity ?? "-"}</td>
            <td>{info?.inventory_quantity ?? info?.available_before ?? "-"}</td>
            <td>{info?.cumulative_issued_after ?? "-"}</td>
            <td>{info?.production_outstanding_quantity ?? "-"}</td>
            <td><Input type="number" min="0" step="0.0001" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} /></td>
            <td>{info?.risks?.length ? info.risks.map((risk) => riskLabels[risk.type] ?? risk.type).join("、") : "-"}</td>
            <td><Button size="sm" variant="ghost" onClick={() => removeLine(index)}>删除</Button></td>
          </tr>; })}</tbody></table></div>
        <div className="page-actions">
          <Button variant="secondary" size="sm" disabled={allMaterialsUsed} title={allMaterialsUsed ? "该生产单的物料都已登记，同一物料只能有一行" : undefined} onClick={addLine}>添加行</Button>
          <Button variant="secondary" size="sm" disabled={busy === "save"} onClick={() => void save()}>{busy === "save" ? "保存中..." : "保存草稿"}</Button>
          <Button size="sm" disabled={busy === "submit"} onClick={() => void saveAndSubmit()}>{busy === "submit" ? "提交中..." : "保存并提交"}</Button>
          <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setPreview(null); setError(""); }}>取消</Button>
        </div>
      </div>}
      <DataTable columns={columns} data={movements} empty={<EmptyState title="该生产单暂无领料单" description="点击右上角「新建领料单」按 BOM 领料。" />} onRowDoubleClick={(movement) => setDetailId(movement.id)} rowTitle="双击查看领用物料" />
      {/* 双击弹出的详情：把这一条领料单的**全部**领用物料列出来，避免用户只能看到列表里的「N 项」。 */}
      <RecordDetailDialog
        open={Boolean(detailId)}
        onOpenChange={(open) => { if (!open) setDetailId(""); }}
        title={`${typeLabels[detail?.documentType ?? "issue"] ?? "领料单"}详情：${detail?.movementNo ?? ""}`}
        description="双击单据行打开的详情：展示本条单据的全部领用物料与提交信息。"
        fields={detailFields}
        sections={detail ? [{ title: `领用物料（${detail.lines.length} 项）`, content: <DataTable pageSize={50} columns={detailLineColumns} data={detail.lines} empty={<EmptyState title="该单据没有物料明细" />} /> }] : []}
        loading={detailLoading}
        error={detailError}
        onRetry={() => setDetailNonce((value) => value + 1)}
        testId="material-slip-detail"
      />
    </div>
  </section>;
}
