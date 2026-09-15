/**
 * 生产进度表的工序列顺序（纯函数，不碰数据库）。
 *
 * 与前端 `apps/web/lib/progress-column-order.ts` 同口径：进度表的列顺序是**导出显示偏好**，
 * 不是车间生产顺序（`production_order_operations.sequence_no` 表示实际生产先后，改它会把
 * 「我想按这个顺序看表」变成「这道工序要排到那时候做」）。因此顺序由导出请求的
 * `operation_order`（逗号分隔的工序 id）带过来，后端只按它排表头。
 *
 * 规则：用户列出的工序按给定次序在前（去重、忽略未知/已取消的 id），没提到的按原相对顺序接在后面
 * —— 这样即使前端存过一份顺序，之后新增的工序也不会从表里消失。
 */

/** 解析 `operation_order`：逗号分隔、去空白、去重、丢掉空串；长度上限防止有人塞超长参数。 */
export function parseOperationOrder(raw: string | null | undefined, max = 200): string[] {
  if (!raw?.trim()) return [];
  const ids = raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  return [...new Set(ids)].slice(0, max);
}

/** 按用户给定的顺序重排工序列；没提到的按原相对顺序接在后面。 */
export function orderProgressColumns<T extends { id: string }>(columns: T[], order: string[]): T[] {
  if (!order.length || columns.length < 2) return [...columns];
  const byId = new Map(columns.map((column) => [column.id, column]));
  const ordered: T[] = [];
  const used = new Set<string>();
  for (const id of order) {
    const column = byId.get(id);
    if (!column || used.has(id)) continue;
    ordered.push(column);
    used.add(id);
  }
  for (const column of columns) if (!used.has(column.id)) ordered.push(column);
  return ordered;
}
