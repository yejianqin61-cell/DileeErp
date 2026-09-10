// 销售单 → BOM → 生产单 的候选与单位判定。
//
// 后端契约（production-orders.service.ts refs()）：建生产单要求
// 1) 销售单存在且 status = confirmed；
// 2) 传入的 bom_id 必须属于该销售单，且 bom_version 必须是最新版本；
// 3) unit_id 必须是启用单位。
// 因此“新建生产单无匹配项”要么是销售单没确认，要么是还没有 BOM —— 页面必须把这两者区分开，
// 而不是静默地把订单从下拉框里去掉。

export type SalesOrderRef = {
  orderNo: string;
  quantity: string;
  status: string;
  unit?: string;
  boms: Array<{ id: string; version: number; status?: string }>;
};

export type UnitRef = { id: string; name: string; isActive?: boolean };
export type OperationRef = { isActive: boolean; defaultUnitId?: string | null };

/** 可以直接建生产单的销售单：已确认且已建 BOM。 */
export function productionCandidates<T extends SalesOrderRef>(orders: T[]): T[] {
  return orders.filter((order) => order.status === "confirmed" && order.boms.length > 0);
}

/** 已确认但还没建 BOM 的销售单：这是“无匹配项”的最常见原因。 */
export function ordersAwaitingBom<T extends SalesOrderRef>(orders: T[]): T[] {
  return orders.filter((order) => order.status === "confirmed" && order.boms.length === 0);
}

/** 未确认的销售单，用于把“未确认”与“缺 BOM”区分开。 */
export function unconfirmedOrders<T extends SalesOrderRef>(orders: T[]): T[] {
  return orders.filter((order) => order.status !== "confirmed");
}

/**
 * 生产单单位：优先使用销售单上的产品单位（按名称匹配启用单位），
 * 其次退回工序默认单位（且该单位必须仍是启用单位，否则后端会以“单位不存在或已停用”拒绝）。
 * 两者都没有时返回空串，由调用方给出明确提示。
 */
export function resolveProductionUnit(orderUnit: string | undefined, units: UnitRef[], operations: OperationRef[]): string {
  const activeUnit = (id: string | null | undefined) => (id ? units.find((unit) => unit.id === id && unit.isActive !== false)?.id : undefined);
  const wanted = orderUnit?.trim();
  if (wanted) {
    const matched = units.find((unit) => unit.isActive !== false && unit.name.trim() === wanted);
    if (matched) return matched.id;
  }
  return activeUnit(operations.find((operation) => operation.isActive && operation.defaultUnitId)?.defaultUnitId) ?? "";
}

/**
 * 生产单要用的 BOM：同一销售单可能存在历史版本，必须取版本号最大的一个，
 * 否则后端会以 BOM_VERSION_CHANGED 拒绝（/sales-orders 返回的 boms 并不保证顺序）。
 */
export function latestBom<T extends { id: string; version: number; status?: string }>(boms: T[]): T | undefined {
  return [...boms].sort((left, right) => right.version - left.version)[0];
}

/** 候选为空/不足时给用户的原因说明；没有阻塞时返回空串。 */
export function productionCandidateHint(orders: SalesOrderRef[]): string {
  const awaiting = ordersAwaitingBom(orders);
  if (!orders.length) return "暂无销售单：请先在【销售】建立并确认销售单。";
  if (!productionCandidates(orders).length && awaiting.length) {
    return `有 ${awaiting.length} 张已确认销售单尚未建立 BOM（${awaiting.map((order) => order.orderNo).join("、")}），请先在【采购 → BOM表】为其建立 BOM 后再建生产单。`;
  }
  if (awaiting.length) return `另有 ${awaiting.length} 张已确认销售单因缺少 BOM 未出现在候选列表中（${awaiting.map((order) => order.orderNo).join("、")}）。`;
  return "";
}
