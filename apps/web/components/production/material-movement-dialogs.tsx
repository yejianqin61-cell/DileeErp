"use client";

// 原料流转单据的两个弹窗：库存影响（只读）、详情与审计上下文（含凭证上传）。
import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { DataTable } from "../data/data-table";
import { RecordDetailDialog } from "../finance/record-detail-dialog";
import { ApiClientError, apiGet } from "../../lib/api-client";
import { formatBeijingShort } from "../../lib/audit-time";
import { movementRiskLabels } from "../../lib/material-movement-derived";
import { MovementVoucherUpload } from "./material-movement-voucher";

export type DialogMovement = {
  id: string;
  movementNo: string;
  orderNo: string;
  productionOrder?: { productionOrderNo: string } | null;
  reason?: string | null;
  remark?: string | null;
  risks?: Array<{ riskType: string }>;
  lines: Array<{ materialId: string; quantity: string; material?: { name: string } | null; unit?: { name: string } | null }>;
};

type ImpactLine = { material_id: string; material_name?: string; material_code?: string; unit?: string | null; quantity: string; available_before: string; bom_reference_quantity: string | null };
type AuditEvent = { id: string; action: string; actor_name?: string | null; createdAt: string; details?: { reason?: string } | null };

const actionLabels: Record<string, string> = {
  "raw_material_movement.create": "建单",
  "raw_material_movement.update": "修改草稿",
  "raw_material_movement.submit": "提交仓库",
  "raw_material_movement.withdraw": "撤回提交",
  "raw_material_movement.post": "过账",
  "raw_material_movement.reopen": "退回草稿",
  "raw_material_movement.reverse": "冲销",
  "raw_material_movement.delete": "删除",
};

const auditEventColumns: ColumnDef<AuditEvent>[] = [
  { id: "action", header: "操作", meta: { width: "20%" }, cell: ({ row }) => actionLabels[row.original.action] ?? row.original.action },
  { id: "actor", header: "操作人", meta: { width: "20%" }, cell: ({ row }) => row.original.actor_name ?? "-" },
  { id: "time", header: "时间", meta: { width: "25%" }, cell: ({ row }) => formatBeijingShort(row.original.createdAt) || "-" },
  { id: "reason", header: "原因", meta: { width: "35%" }, cell: ({ row }) => row.original.details?.reason ?? "-" },
];

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

/** 打开时按路径取一次数；关闭即清空，避免下一张单据先闪出上一张的数字。 */
function useDialogData<T>(path: string | null, fallback: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    setData(null); setError("");
    if (!path) return;
    let cancelled = false;
    apiGet<T>(path)
      .then((result) => { if (!cancelled) setData(result.data); })
      .catch((cause) => { if (!cancelled) setError(messageOf(cause, fallback)); });
    return () => { cancelled = true; };
  }, [path, fallback, nonce]);
  return { data, error, retry: () => setNonce((value) => value + 1) };
}

/**
 * 已过账领料单 / 补料单的库存影响。
 *
 * 接口 `impact-preview` 是按「再出这一次」算的，而这张单的出库**已经计入**当前库存 ——
 * 所以这里只用它的当前库存与物料清单参考量，不显示「过账后库存」（那会把本单扣两遍）。
 * 风险同理，取单据上实际记录下来的那些。
 */
export function MovementImpactDialog({ movement, onClose }: { movement: DialogMovement | null; onClose: () => void }) {
  const { data, error, retry } = useDialogData<{ lines: ImpactLine[] }>(movement ? `/production/material-movements/${movement.id}/impact-preview` : null, "库存影响加载失败");
  const risks = [...new Set((movement?.risks ?? []).map((risk) => movementRiskLabels[risk.riskType]).filter(Boolean))];
  return <Dialog open={Boolean(movement)} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="inventory-impact-dialog">
      <DialogHeader>
        <DialogTitle>库存影响</DialogTitle>
        <DialogDescription>{movement ? `${movement.movementNo} / ${movement.orderNo}（本单出库已计入当前库存）` : ""}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        {error ? <ErrorState message={error} onRetry={retry} /> : !data ? <LoadingState /> : <div className="inventory-impact-list">
          {risks.length ? <span className="inventory-impact-risk">本单记录的风险：{risks.join("、")}</span> : null}
          {data.lines.map((line, index) => <section className="inventory-impact-item" key={`${line.material_id}-${index}`}>
            <div className="inventory-impact-title"><strong>{[line.material_code, line.material_name ?? line.material_id].filter(Boolean).join(" / ")}</strong></div>
            <div className="inventory-impact-metrics">
              <div><span>本单数量</span><strong data-testid="impact-quantity">{line.quantity}{line.unit ?? ""}</strong></div>
              <span className="inventory-impact-arrow">·</span>
              <div><span>当前库存</span><strong data-testid="impact-stock">{line.available_before}</strong></div>
              <div><span>物料清单参考</span><strong>{line.bom_reference_quantity ?? "未设置"}</strong></div>
            </div>
          </section>)}
        </div>}
      </DialogBody>
    </DialogContent>
  </Dialog>;
}

export function MovementAuditDialog({ movement, typeLabel, statusLabel, onClose }: { movement: DialogMovement | null; typeLabel: string; statusLabel: string; onClose: () => void }) {
  const { data, error, retry } = useDialogData<AuditEvent[]>(movement ? `/production/material-movements/${movement.id}/audit-events` : null, "审计记录加载失败");
  return <RecordDetailDialog
    open={Boolean(movement)}
    onOpenChange={(open) => { if (!open) onClose(); }}
    title={`库存单详情与审计上下文：${movement?.movementNo ?? ""}`}
    testId="material-movement-audit"
    fields={movement ? [
      { label: "单据号", value: movement.movementNo },
      { label: "类型", value: typeLabel },
      { label: "状态", value: statusLabel },
      { label: "订单号", value: movement.orderNo },
      { label: "生产单号", value: movement.productionOrder?.productionOrderNo },
      { label: "明细", value: movement.lines.map((line) => `${line.material?.name ?? line.materialId} × ${line.quantity}${line.unit?.name ?? ""}`).join("、"), wide: true },
      { label: "原因", value: movement.reason, wide: true },
      { label: "备注", value: movement.remark, wide: true },
    ] : []}
    // 加载态与错误态放在审计记录自己的区块里：审计记录读不到时，单据信息与凭证上传仍然可用。
    sections={movement ? [
      { title: "凭证", content: <MovementVoucherUpload key={movement.id} movementId={movement.id} /> },
      {
        title: data ? `审计记录（${data.length} 条）` : "审计记录",
        content: error ? <ErrorState message={error} onRetry={retry} /> : !data ? <LoadingState /> : <DataTable columns={auditEventColumns} data={data} empty={<EmptyState title="没有审计记录" />} />,
      },
    ] : []}
  />;
}
