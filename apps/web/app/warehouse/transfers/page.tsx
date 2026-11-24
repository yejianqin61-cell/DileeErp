"use client";

// 仓库 → 跨仓调拨（/warehouse/transfers），工单 T-0028。
//
// 用户原话：「新增跨仓库调拨业务，源仓库为同安仓库，目标仓库可选大田仓库、晋江仓库；
// 调拨目的是供目标仓库生产使用，调拨完成后自动更新两边仓库库存，保留调拨记录可追溯。」
//
// 页面只做三件事，与后端口径一一对应（见 warehouse-transfer.service.ts）：
//   1. 新建：选目标仓 → 加原料明细 → 提交。源仓固定同安仓，数量按物料默认单位；
//   2. 看两边库存：三仓原料库存汇总，调拨完成后同安减、目标加；
//   3. 看记录：不可变调拨单列表（单号 / 日期 / 源 / 目标 / 用途 / 明细 / 操作人）。
//
// 数量按字符串原样提交，前端不做 Number 累加（与全站数量口径一致）；跨单位不合计。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { SearchableSelect } from "../../../components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { DataTable } from "../../../components/data/data-table";
import { auditColumns, type AuditRow } from "../../../components/data/audit-columns";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPost } from "../../../lib/api-client";
import { formatBeijingShort } from "../../../lib/audit-time";
import { fuzzyMatch } from "../../../lib/fuzzy-search";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";
import {
  WAREHOUSE_TRANSFER_MAX_LINES,
  WAREHOUSE_TRANSFER_PURPOSE,
  WAREHOUSE_TRANSFER_PURPOSE_LABEL,
  WAREHOUSE_TRANSFER_SOURCE_LABEL,
  WAREHOUSE_TRANSFER_TARGET_OPTIONS,
  isPositiveTransferQuantity,
  transferLineSummary,
  warehouseTransferTargetLabel,
} from "../../../lib/warehouse-transfer";

type Material = { id: string; materialCode: string; name: string; defaultUnitId: string; specificationModel?: string | null; defaultUnit?: { name?: string } | null };
type TransferLine = {
  material_id: string;
  material_code: string;
  material_name: string;
  specification_model?: string | null;
  unit_id: string;
  unit_name: string;
  quantity: string;
};
type Transfer = AuditRow & {
  id: string;
  transfer_no: string;
  source_warehouse: string;
  source_warehouse_name: string;
  target_warehouse: string;
  target_warehouse_name: string;
  purpose: string;
  purpose_label: string;
  status: string;
  remark: string | null;
  lines: TransferLine[];
  line_count: number;
  createdAt?: string;
  created_at?: string;
};
type WarehouseBalance = {
  material_id: string;
  material_code: string;
  material_name: string;
  specification_model: string | null;
  unit_id: string;
  unit_name: string;
  tongan: string;
  daitan: string;
  jinjiang: string;
};
type DraftLine = { material: Material; quantity: string };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const idempotencyKey = () => `web-transfer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const materialLabel = (material: Material) => `${material.materialCode} / ${material.name}${material.specificationModel ? `（${material.specificationModel}）` : ""}`;

const COLUMN_WIDTH = {
  transferNo: "10%",
  date: "7%",
  source: "7%",
  target: "7%",
  purpose: "10%",
  lines: "21%",
  status: "5%",
  remark: "10%",
  balanceMaterial: "30%",
  balanceSpec: "22%",
  balanceUnit: "8%",
  balanceQuantity: "13%",
} as const;

export default function WarehouseTransfersPage() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [balances, setBalances] = useState<WarehouseBalance[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<string>("daitan");
  const [materialId, setMaterialId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [remark, setRemark] = useState("");
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [keyword, setKeyword] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [transferResult, balanceResult, materialResult] = await Promise.all([
        apiGet<Transfer[]>("/warehouse-transfers"),
        apiGet<WarehouseBalance[]>("/warehouse-transfers/balances"),
        apiGet<Material[]>("/materials"),
      ]);
      setTransfers(transferResult.data ?? []);
      setBalances(balanceResult.data ?? []);
      setMaterials((materialResult.data ?? []).filter((material) => material.materialCode));
    } catch (cause) {
      setError(messageOf(cause, "读取调拨数据失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const materialOptions = useMemo(
    () => materials.map((material) => ({ value: material.id, label: materialLabel(material) })),
    [materials],
  );
  const selectedMaterial = useMemo(() => materials.find((material) => material.id === materialId) ?? null, [materials, materialId]);
  const visibleTransfers = useMemo(() => {
    const text = keyword.trim();
    if (!text) return transfers;
    return transfers.filter((transfer) => fuzzyMatch(text, [
      transfer.transfer_no,
      transfer.source_warehouse_name,
      transfer.target_warehouse_name,
      transfer.purpose_label,
      transfer.remark,
      transfer.created_by_name,
      transferLineSummary(transfer.lines),
    ]));
  }, [keyword, transfers]);

  const balanceRows = useMemo(() => balances.filter((row) => row.tongan !== "0" || row.daitan !== "0" || row.jinjiang !== "0"), [balances]);

  function addLine() {
    setFormError("");
    if (!selectedMaterial) { setFormError("请先选择要调拨的原料"); return; }
    if (!isPositiveTransferQuantity(quantity)) { setFormError("调拨数量必须是大于零、最多 4 位小数的十进制数"); return; }
    if (draftLines.some((line) => line.material.id === selectedMaterial.id)) { setFormError("同一物料在一张调拨单里只能出现一行"); return; }
    if (draftLines.length >= WAREHOUSE_TRANSFER_MAX_LINES) { setFormError(`一张调拨单最多 ${WAREHOUSE_TRANSFER_MAX_LINES} 行`); return; }
    setDraftLines((current) => [...current, { material: selectedMaterial, quantity: quantity.trim() }]);
    setMaterialId("");
    setQuantity("");
  }

  function removeLine(index: number) {
    setDraftLines((current) => current.filter((_, position) => position !== index));
  }

  async function submit() {
    setFormError("");
    if (!draftLines.length) { setFormError("请先添加至少一条调拨明细"); return; }
    const invalid = draftLines.find((line) => !isPositiveTransferQuantity(line.quantity));
    if (invalid) { setFormError(`「${invalid.material.name}」的数量不合法`); return; }
    setBusy(true);
    try {
      await apiPost("/warehouse-transfers", {
        source_warehouse: "tongan",
        target_warehouse: target,
        purpose: WAREHOUSE_TRANSFER_PURPOSE,
        remark: remark.trim() || undefined,
        idempotency_key: idempotencyKey(),
        lines: draftLines.map((line) => ({ material_id: line.material.id, quantity: line.quantity.trim() })),
      });
      notifySuccess(`已调拨到${warehouseTransferTargetLabel(target)}：同安仓减少、目标仓增加，明细已记入调拨记录`);
      setDraftLines([]);
      setRemark("");
      await load();
    } catch (cause) {
      const message = messageOf(cause, "调拨失败");
      setFormError(message);
      notifyError(message);
    } finally {
      setBusy(false);
    }
  }

  const draftColumns: ColumnDef<DraftLine>[] = [
    { id: "material", header: "物料", meta: { width: "46%" }, cell: ({ row }) => materialLabel(row.original.material) },
    { id: "quantity", header: "数量", meta: { width: "24%" }, cell: ({ row }) => `${row.original.quantity} ${row.original.material.defaultUnit?.name ?? ""}` },
    { id: "actions", header: "操作", meta: { width: "12%" }, cell: ({ row }) => <Button size="sm" variant="secondary" onClick={() => removeLine(row.index)}>移除</Button> },
  ];

  const balanceColumns: ColumnDef<WarehouseBalance>[] = [
    { id: "material", header: "物料", meta: { width: COLUMN_WIDTH.balanceMaterial }, cell: ({ row }) => `${row.original.material_code} / ${row.original.material_name}` },
    { id: "specification", header: "规格型号", meta: { width: COLUMN_WIDTH.balanceSpec }, cell: ({ row }) => row.original.specification_model || "-" },
    { id: "unit", header: "单位", meta: { width: COLUMN_WIDTH.balanceUnit }, cell: ({ row }) => row.original.unit_name },
    { id: "tongan", header: "同安仓", meta: { width: COLUMN_WIDTH.balanceQuantity }, cell: ({ row }) => row.original.tongan },
    { id: "daitan", header: "大田仓", meta: { width: COLUMN_WIDTH.balanceQuantity }, cell: ({ row }) => row.original.daitan },
    { id: "jinjiang", header: "晋江仓", meta: { width: COLUMN_WIDTH.balanceQuantity }, cell: ({ row }) => row.original.jinjiang },
  ];

  const transferColumns: ColumnDef<Transfer>[] = [
    { accessorKey: "transfer_no", header: "调拨单号", meta: { width: COLUMN_WIDTH.transferNo } },
    { id: "date", header: "调拨时间", meta: { width: COLUMN_WIDTH.date }, cell: ({ row }) => formatBeijingShort(row.original.createdAt ?? row.original.created_at) || "-" },
    { id: "source", header: "源仓库", meta: { width: COLUMN_WIDTH.source }, cell: ({ row }) => row.original.source_warehouse_name || WAREHOUSE_TRANSFER_SOURCE_LABEL },
    { id: "target", header: "目标仓库", meta: { width: COLUMN_WIDTH.target }, cell: ({ row }) => row.original.target_warehouse_name || warehouseTransferTargetLabel(row.original.target_warehouse) },
    { id: "purpose", header: "调拨目的", meta: { width: COLUMN_WIDTH.purpose }, cell: ({ row }) => row.original.purpose_label || WAREHOUSE_TRANSFER_PURPOSE_LABEL },
    { id: "lines", header: "物料明细", meta: { width: COLUMN_WIDTH.lines }, cell: ({ row }) => transferLineSummary(row.original.lines) },
    { id: "status", header: "状态", meta: { width: COLUMN_WIDTH.status }, cell: ({ row }) => row.original.status === "posted" ? "已完成" : row.original.status },
    { id: "remark", header: "备注", meta: { width: COLUMN_WIDTH.remark }, cell: ({ row }) => row.original.remark || "-" },
    ...auditColumns<Transfer>(),
  ];

  if (loading) return <><PageHeader title="跨仓调拨" /><LoadingState /></>;

  return (
    <div className="page-root" data-testid="page-warehouse-transfers">
      <PageHeader title="跨仓调拨">
        <div className="page-actions">
          <Button asChild variant="secondary"><Link href="/warehouse">返回仓库首页</Link></Button>
        </div>
      </PageHeader>

      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}

      <section className="panel">
        <div className="panel-heading">
          <h2>新建调拨单</h2>
          <span className="panel-note">源仓库固定 {WAREHOUSE_TRANSFER_SOURCE_LABEL}，调拨目的固定「{WAREHOUSE_TRANSFER_PURPOSE_LABEL}」</span>
        </div>
        <div className="panel-body">
          <div className="filter-bar">
            <label>目标仓库
              <Select value={target} onValueChange={setTarget} disabled={busy}>
                <SelectTrigger data-testid="transfer-target"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WAREHOUSE_TRANSFER_TARGET_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label>调拨物料
              <SearchableSelect
                value={materialId}
                options={materialOptions}
                placeholder="选择原料"
                label="调拨物料"
                searchPlaceholder="搜索物料编码或名称"
                noResultsText="没有匹配的原料"
                disabled={busy}
                onChange={setMaterialId}
              />
            </label>
            <label>数量{selectedMaterial?.defaultUnit?.name ? `（${selectedMaterial.defaultUnit.name}）` : ""}
              <Input data-testid="transfer-quantity" value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="例如 12.5000" inputMode="decimal" />
            </label>
            <label>备注
              <Input data-testid="transfer-remark" value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="选填：调拨原因、交接人" />
            </label>
            <Button type="button" variant="secondary" disabled={busy} onClick={addLine} data-testid="transfer-add-line">添加明细</Button>
            <Button type="button" disabled={busy || !draftLines.length} onClick={() => void submit()} data-testid="transfer-submit">{busy ? "提交中…" : "提交调拨"}</Button>
          </div>
          {formError && <p className="status-error" role="alert" data-testid="transfer-form-error">{formError}</p>}
          <DataTable
            columns={draftColumns}
            data={draftLines}
            empty={<EmptyState title="还没有调拨明细" description="选择原料与数量后点「添加明细」；同一物料一张单只能一行。" />}
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>三仓原料库存</h2>
          <span className="panel-note">调拨完成后自动更新：同安仓减少、目标仓增加；总量不变</span>
        </div>
        <div className="panel-body">
          <DataTable
            columns={balanceColumns}
            data={balanceRows}
            empty={<EmptyState title="暂无原料库存" description="原料入库过账或调拨完成后，这里按同安 / 大田 / 晋江三仓显示余额。" />}
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>调拨记录 <span className="status-warning">{transfers.length}</span></h2>
        </div>
        <div className="panel-body">
          <div className="filter-bar">
            <label>搜索调拨单号、仓库、用途、物料或操作人
              <Input data-testid="transfer-search" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入关键词，空格分隔多个词" />
            </label>
            {keyword.trim() ? <Button variant="secondary" onClick={() => setKeyword("")}>清除搜索</Button> : null}
          </div>
          <DataTable
            columns={transferColumns}
            data={visibleTransfers}
            empty={keyword.trim()
              ? <EmptyState title={`没有匹配“${keyword.trim()}”的调拨记录`} description={`共 ${transfers.length} 条，换个关键词或清空搜索框。`} />
              : <EmptyState title="暂无调拨记录" description="在上方新建调拨单；提交后这里保留单号、源/目标仓、用途、物料明细与操作人，可追溯。" />}
          />
        </div>
      </section>
    </div>
  );
}
