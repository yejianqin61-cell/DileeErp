/**
 * 回答「来源」的展示映射：把后端 QuerySource.business_type 翻成业务用户看得懂的单据名。
 *
 * 来源由服务端从工具结果生成（apps/api/.../tools/*.ts），不是模型自报，
 * 前端只负责翻译 + 去重展示，不补任何后端没给的单据。
 */

/** business_type → 单据类型中文名。清单来自后端 31 项查询实际产出的类型。 */
export const SOURCE_TYPE_LABELS: Record<string, string> = {
  sales_order: "销售单",
  customer: "客户",
  purchase_plan: "采购计划",
  purchase_order: "采购单",
  purchase_receipt: "采购到货",
  incoming_inspection: "来料检验",
  production_order: "生产单",
  operation_daily_report: "工序日报",
  outsource_logistics_batch: "外协批次",
  outsource_return_transfer: "外协退货",
  outsource_direct_shipment: "外协直发",
  inventory_fact: "库存记录",
  raw_material_movement: "原料流水",
  finished_goods_qc: "成品质检",
  finished_goods_inbound_notice: "成品入库通知",
  finished_goods_inbound: "成品入库",
  finished_goods_outbound: "成品出库",
  customer_return: "客户退货",
  receivable_source: "应收来源",
  customer_payment: "客户收款",
  supplier_payable_entry: "应付明细",
  supplier_payment: "供应商付款",
  receivable_reconciliation: "应收对账",
  supplier_payable_reconciliation: "应付对账",
  employee_daily_report: "员工报工",
  attachment: "附件",
  audit_event: "操作记录",
};

/** 认不出的类型也不暴露内部英文名，统一说「单据」。 */
export function sourceTypeLabel(businessType: string): string {
  return SOURCE_TYPE_LABELS[businessType] ?? "单据";
}

/** 来源标签：`销售单 SO-2026-001`。 */
export function sourceLabel(source: { business_type: string; business_no: string }): string {
  return `${sourceTypeLabel(source.business_type)} ${source.business_no}`;
}

/** 去重（同一单据可能被多次工具调用重复产出来源）+ 最多展示条数，避免来源区把回答挤下去。 */
export function uniqueSources<T extends { business_type: string; business_no: string }>(sources: T[], limit = 12): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const source of sources) {
    const key = `${source.business_type}:${source.business_no}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
    if (result.length >= limit) break;
  }
  return result;
}
