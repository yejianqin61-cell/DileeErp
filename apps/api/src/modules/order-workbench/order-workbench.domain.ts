import { Prisma } from "@prisma/client";

export type WorkbenchBlocker = { code: string; label: string; suggestion: string };

export const WORKBENCH_STATUS_LABELS: Record<string, string> = {
  not_started: "未建立",
  in_progress: "进行中",
  blocked: "存在阻塞",
  ready_to_ship: "待发货",
  completed: "已完成",
};

export function overallStatus(statuses: string[], blockers: WorkbenchBlocker[]) {
  if (blockers.length) return "blocked";
  if (statuses.includes("in_progress")) return "in_progress";
  if (statuses.includes("ready_to_ship")) return "ready_to_ship";
  if (statuses.length > 0 && statuses.every((status) => ["completed", "paid", "closed"].includes(status))) return "completed";
  return statuses.length ? "in_progress" : "not_started";
}

export function decimalString(value: { toString(): string } | null | undefined) { return value?.toString() ?? "0"; }

export function reconciliationBlockers(input: {
  bomRequired: string;
  ordered: string;
  received: string;
  inspected: string;
  accepted: string;
  conditional: string;
  inbound: string;
  planned: string;
  completed: string;
  outbound: string;
  orderQuantity: string;
  receivable: string;
  receivableAllocated: string;
  payable: string;
  payableAllocated: string;
}): WorkbenchBlocker[] {
  const d = (value: string) => new Prisma.Decimal(value);
  const blockers: WorkbenchBlocker[] = [];
  if (d(input.bomRequired).gt(0) && d(input.ordered).lt(d(input.bomRequired))) blockers.push({ code: "PROCUREMENT_SHORT_ORDER", label: "采购数量少于 BOM 需求", suggestion: "请补充采购明细或确认需求差异。" });
  if (d(input.ordered).gt(0) && d(input.received).gt(d(input.ordered))) blockers.push({ code: "PROCUREMENT_OVER_RECEIPT", label: "到货数量超过采购数量", suggestion: "请核对超收原因和收货批次。" });
  if (d(input.received).gt(0) && d(input.inspected).gt(d(input.received))) blockers.push({ code: "INSPECTION_OVER_RECEIPT", label: "质检数量超过到货数量", suggestion: "请检查来料质检批次。" });
  if (d(input.inbound).gt(d(input.accepted).plus(input.conditional))) blockers.push({ code: "INBOUND_OVER_ACCEPTED", label: "原料入库超过质检合格量", suggestion: "请回退或更正原料入库批次。" });
  if (d(input.planned).gt(0) && d(input.completed).gt(d(input.planned))) blockers.push({ code: "PRODUCTION_OVER_PLAN", label: "工序完成量超过生产计划", suggestion: "请核对工序员工日报和超单确认。" });
  if (d(input.outbound).gt(d(input.orderQuantity))) blockers.push({ code: "OUTBOUND_OVER_ORDER", label: "成品出库超过订单数量", suggestion: "请核对成品出库数量。" });
  if (d(input.receivableAllocated).gt(d(input.receivable))) blockers.push({ code: "RECEIVABLE_OVER_ALLOCATED", label: "收款核销超过应收金额", suggestion: "请检查收款分配。" });
  if (d(input.payableAllocated).gt(d(input.payable))) blockers.push({ code: "PAYABLE_OVER_ALLOCATED", label: "付款核销超过应付金额", suggestion: "请检查付款分配。" });
  return blockers;
}
