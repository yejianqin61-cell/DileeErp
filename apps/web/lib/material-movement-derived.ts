// 退料单（MR-）与报废单（MS-）：都从「已过账领料单的某一行」派生，不能凭空登记。
//
// 服务端口径（`raw-material-movements.service.ts` 的 derivedLines）：来源行必须属于所选生产单、
// 来源单据是已过账的**领料单**（补料单不行），且数量不超过来源行扣掉已退料/报废后的余量。
// 余量只由服务端判，这里不重算。
import type { ActionField } from "../components/ui/action-dialog";

export type DerivedType = "return" | "scrap";

export type SourceIssue = {
  movementNo: string;
  documentType: string;
  status: string;
  productionOrderId: string;
  productionOrder?: { productionOrderNo: string } | null;
  lines: Array<{ id: string; materialId: string; quantity: string; material?: { name: string } | null; unit?: { name: string } | null }>;
};

export type DerivableOrder = { id: string; productionOrderNo: string; orderNo: string; executionMode?: string; status?: string };

export const derivedCopy: Record<DerivedType, { button: string; title: string; success: string; createPath: string; postAction: string }> = {
  return: { button: "退料", title: "退料并过账", success: "退料已过账", createPath: "/production/material-movements/returns", postAction: "post-return" },
  scrap: { button: "报废", title: "报废并过账", success: "报废已过账", createPath: "/production/material-movements/scraps", postAction: "post-scrap" },
};

export const movementRiskLabels: Record<string, string> = {
  MATERIAL_NOT_IN_BOM_WARNING: "不在 BOM 中",
  OVER_ISSUE_WARNING: "超出实际入库数量",
  INSUFFICIENT_STOCK_WARNING: "库存不足",
};

/** 可作为来源的明细行：已过账领料单的每一行。 */
export function sourceIssueLines(movements: readonly SourceIssue[]) {
  return movements
    .filter((movement) => movement.documentType === "issue" && movement.status === "posted")
    .flatMap((movement) => movement.lines.map((line) => ({
      value: line.id,
      productionOrderId: movement.productionOrderId,
      label: `${movement.movementNo} / ${movement.productionOrder?.productionOrderNo ?? "-"} / ${line.material?.name ?? line.materialId} / 已领 ${line.quantity}${line.unit?.name ?? ""}`,
    })));
}

/** 生产单只列服务端肯收的那些：生产中的厂内单，且确实有已过账领料可退/可报废。 */
export function derivedFields(movements: readonly SourceIssue[], orders: readonly DerivableOrder[]): ActionField[] {
  const lines = sourceIssueLines(movements);
  const issuable = orders.filter((order) => order.executionMode === "in_house" && order.status === "in_progress" && lines.some((line) => line.productionOrderId === order.id));
  const sources = lines.filter((line) => issuable.some((order) => order.id === line.productionOrderId));
  return [
    ...(sources.length ? [] : [{ name: "no_source", label: "没有可处理的来源：需要「生产中」的厂内生产单上有已过账的领料单。", type: "info" as const }]),
    { name: "production_order_id", label: "生产单", type: "select", required: true, options: issuable.map((order) => ({ value: order.id, label: `${order.productionOrderNo} / ${order.orderNo}` })) },
    { name: "source_issue_line_id", label: "来源领料明细", type: "select", required: true, options: sources.map(({ value, label }) => ({ value, label })) },
    { name: "quantity", label: "数量", type: "number", required: true },
    { name: "reason", label: "原因", type: "textarea", required: true },
    { name: "remark", label: "备注", type: "textarea" },
  ];
}

/** 两个下拉保持一致：选了来源行就带出它的生产单；换生产单就清掉不属于它的来源行。 */
export function deriveSourceSelection(movements: readonly SourceIssue[], changedField: string, values: Record<string, string>): Record<string, string> {
  const source = sourceIssueLines(movements).find((line) => line.value === values.source_issue_line_id);
  if (!source || source.productionOrderId === values.production_order_id) return {};
  if (changedField === "source_issue_line_id") return { production_order_id: source.productionOrderId };
  if (changedField === "production_order_id") return { source_issue_line_id: "" };
  return {};
}

export function derivedPayload(values: Record<string, string>) {
  const remark = values.remark?.trim() || undefined;
  return {
    production_order_id: values.production_order_id,
    reason: values.reason,
    remark,
    lines: [{ source_issue_line_id: values.source_issue_line_id, quantity: values.quantity, remark }],
  };
}
