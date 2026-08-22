import { Prisma } from "@prisma/client";

export const PRODUCTION_PROGRESS_STATUSES = [
  "not_started",
  "in_production",
  "production_completed",
  "blocked",
  "ready_for_qc",
  "ready_to_ship",
] as const;

export type ProductionProgressStatus = (typeof PRODUCTION_PROGRESS_STATUSES)[number];

export const PRODUCTION_PROGRESS_BLOCKERS = [
  "daily_discrepancy",
  "over_order_unconfirmed",
  "missing_operation_report",
  "outsource_pending_handoff",
  "outsource_short_receipt",
  "mixed_units",
  "source_reversal_pending",
] as const;

export type ProductionProgressBlocker = (typeof PRODUCTION_PROGRESS_BLOCKERS)[number];
export type MeasurementSourceType = "operation_report" | "outsource_finished_goods_return" | "outsource_direct_shipment";

export const PRODUCTION_PROGRESS_STATUS_LABELS: Record<ProductionProgressStatus, string> = {
  not_started: "未开始",
  in_production: "生产中",
  production_completed: "生产完成",
  blocked: "存在阻塞",
  ready_for_qc: "待成品 QC",
  ready_to_ship: "待发货",
};

export const PRODUCTION_PROGRESS_BLOCKER_DETAILS: Record<ProductionProgressBlocker, { label: string; suggestion: string }> = {
  daily_discrepancy: { label: "日报数量差异", suggestion: "核对工序日报与员工日报件数并补录或更正" },
  over_order_unconfirmed: { label: "超单告警待处理", suggestion: "确认超单原因，保留现场实际累计量" },
  missing_operation_report: { label: "缺少工序日报", suggestion: "补录对应生产单工序的有效日报" },
  outsource_pending_handoff: { label: "外加工待交接", suggestion: "登记成品回厂或直装柜事实" },
  outsource_short_receipt: { label: "外加工签收短收", suggestion: "核对短收原因并处理补收或冲销" },
  mixed_units: { label: "计量单位不一致", suggestion: "按单位分组核对，不要直接相加" },
  source_reversal_pending: { label: "来源冲销待处理", suggestion: "检查被冲销来源及其下游单据" },
};

export function describeProgressBlockers(blockers: ProductionProgressBlocker[]) {
  return [...new Set(blockers)].map((code) => ({ code, ...PRODUCTION_PROGRESS_BLOCKER_DETAILS[code] }));
}

export type MeasurementRow = {
  order_no: string;
  production_order_id: string;
  production_order_no: string;
  operation_id?: string;
  source_type: MeasurementSourceType;
  source_id: string;
  unit: string;
  planned_quantity: string | Prisma.Decimal;
  actual_quantity: string | Prisma.Decimal;
  execution_mode: "in_house" | "outsourced";
  cancelled?: boolean;
  warning_codes?: string[];
};

export type QuantityProgress = {
  planned_quantity: string;
  actual_quantity: string;
  difference_quantity: string;
  over_order_quantity: string;
  completion_rate: string | null;
  status: "not_started" | "in_progress" | "completed" | "over_order" | "not_applicable";
};

export type MeasurementGroup = QuantityProgress & {
  unit: string;
  execution_mode: "in_house" | "outsourced";
  source_types: MeasurementSourceType[];
  source_ids: string[];
};

const zero = () => new Prisma.Decimal(0);
const decimal = (value: string | Prisma.Decimal) => new Prisma.Decimal(value);

export function calculateQuantityProgress(plannedValue: string | Prisma.Decimal, actualValue: string | Prisma.Decimal, cancelled = false): QuantityProgress {
  const planned = decimal(plannedValue);
  const actual = decimal(actualValue);
  if (planned.lt(0) || actual.lt(0)) throw new Error("计划数量和完成数量不能为负数");
  if (cancelled) {
    return { planned_quantity: planned.toString(), actual_quantity: actual.toString(), difference_quantity: planned.minus(actual).toString(), over_order_quantity: zero().toString(), completion_rate: null, status: "not_applicable" };
  }
  const difference = planned.minus(actual);
  const over = actual.gt(planned) ? actual.minus(planned) : zero();
  const status = planned.eq(0) ? (actual.eq(0) ? "not_started" : "over_order") : actual.gt(planned) ? "over_order" : actual.eq(planned) ? "completed" : actual.eq(0) ? "not_started" : "in_progress";
  return { planned_quantity: planned.toString(), actual_quantity: actual.toString(), difference_quantity: difference.toString(), over_order_quantity: over.toString(), completion_rate: planned.eq(0) ? null : actual.div(planned).toString(), status };
}

export function aggregateMeasurementRows(rows: MeasurementRow[]): { groups: MeasurementGroup[]; warnings: ProductionProgressBlocker[] } {
  const groups = new Map<string, { unit: string; execution_mode: "in_house" | "outsourced"; planned: Prisma.Decimal; actual: Prisma.Decimal; source_types: Set<MeasurementSourceType>; source_ids: string[] }>();
  const warnings = new Set<ProductionProgressBlocker>();
  for (const row of rows) {
    if (row.cancelled) continue;
    const key = `${row.execution_mode}:${row.unit}`;
    const current = groups.get(key) ?? { unit: row.unit, execution_mode: row.execution_mode, planned: zero(), actual: zero(), source_types: new Set<MeasurementSourceType>(), source_ids: [] };
    current.planned = current.planned.plus(decimal(row.planned_quantity));
    current.actual = current.actual.plus(decimal(row.actual_quantity));
    current.source_types.add(row.source_type);
    current.source_ids.push(row.source_id);
    groups.set(key, current);
    for (const warning of row.warning_codes ?? []) if ((PRODUCTION_PROGRESS_BLOCKERS as readonly string[]).includes(warning)) warnings.add(warning as ProductionProgressBlocker);
  }
  const modes = new Set([...groups.values()].map((group) => `${group.execution_mode}:${group.unit}`));
  if (modes.size > 1) warnings.add("mixed_units");
  return {
    groups: [...groups.values()].map((group) => ({ unit: group.unit, execution_mode: group.execution_mode, source_types: [...group.source_types], source_ids: group.source_ids, ...calculateQuantityProgress(group.planned, group.actual) })),
    warnings: [...warnings],
  };
}

export type OrderStatusInput = {
  has_production_orders: boolean;
  has_started_production: boolean;
  all_production_complete: boolean;
  blockers?: ProductionProgressBlocker[];
  has_outsource_pending_handoff?: boolean;
  has_finished_goods_source?: boolean;
  qc_capability_available?: boolean;
  shipping_capability_available?: boolean;
};

export function deriveOrderProgressStatus(input: OrderStatusInput): { status: ProductionProgressStatus; blockers: ProductionProgressBlocker[]; capability_not_implemented: string[] } {
  const blockers = [...new Set(input.blockers ?? [])];
  if (input.has_outsource_pending_handoff) blockers.push("outsource_pending_handoff");
  const uniqueBlockers = [...new Set(blockers)];
  if (!input.has_production_orders) return { status: "not_started", blockers: uniqueBlockers, capability_not_implemented: [] };
  if (uniqueBlockers.length > 0) return { status: "blocked", blockers: uniqueBlockers, capability_not_implemented: [] };
  if (!input.has_started_production) return { status: "not_started", blockers: [], capability_not_implemented: [] };
  if (!input.all_production_complete) return { status: "in_production", blockers: [], capability_not_implemented: [] };
  const capabilityNotImplemented: string[] = [];
  if (input.has_finished_goods_source && input.qc_capability_available) {
    if (input.shipping_capability_available) return { status: "ready_to_ship", blockers: [], capability_not_implemented: [] };
    capabilityNotImplemented.push("shipping");
    return { status: "ready_for_qc", blockers: [], capability_not_implemented: capabilityNotImplemented };
  }
  if (input.has_finished_goods_source && !input.qc_capability_available) capabilityNotImplemented.push("quality_control");
  return { status: "production_completed", blockers: [], capability_not_implemented: capabilityNotImplemented };
}
