// 生产进度表的**工序列顺序**（纯逻辑，不碰 DOM 与网络）。
//
// 为什么单独成模块：这段逻辑要在三个地方用同一份实现 ——
//   1. 导出面板里拖动/上移下移后的列表；
//   2. 导出请求参数 `operation_order` 的生成；
//   3. 按订单号记住用户排的顺序（localStorage，与 lib/collapsible-panel.ts 同一套做法）。
//
// 为什么顺序不能写回 `production_order_operations.sequence_no`：那是**车间实际生产顺序**，
// 进度表的列顺序只是导出的显示偏好。把偏好写回生产顺序会把「我要按这个顺序看表」变成
// 「这道工序要排到那时候做」，是两类完全不同的事实。
//
// 后端 `production-progress-columns.domain.ts` 有同口径实现（不同运行时，各自带测试）；
// 两边都遵守同一条规则：**用户给出的顺序只对已知的工序生效，没提到的工序按原相对顺序排在后面**
// ——这样即使存过一次顺序，之后新增的工序也不会从表里消失。

export type ColumnRef = { id: string };

export function progressColumnOrderKey(orderNo: string): string {
  return `dilee:progress-columns:${orderNo}`;
}

/** 只认自己写过的 JSON 字符串数组；其它内容（旧版本、别处写的键）当没设置过。 */
export function parseStoredColumnOrder(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0))];
  } catch {
    return [];
  }
}

export function serializeColumnOrder(ids: string[]): string {
  return JSON.stringify([...new Set(ids.filter((id) => id.length > 0))]);
}

/** 移动一项（拖拽与上移/下移共用）：越界时夹到两端，原地不动时返回原数组的副本。 */
export function moveColumn(ids: string[], from: number, to: number): string[] {
  const next = [...ids];
  if (from < 0 || from >= next.length) return next;
  const target = Math.min(Math.max(to, 0), next.length - 1);
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * 按用户给定的顺序重排列：先按 `order` 里出现的已知 id（按给定次序、去重），
 * 再把没提到的列按原来的相对顺序接在后面。
 */
export function applyColumnOrder<T extends ColumnRef>(columns: T[], order: string[]): T[] {
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

/** 当前顺序是否就是默认顺序（是则不往导出请求里塞参数，URL 保持干净）。 */
export function isDefaultColumnOrder<T extends ColumnRef>(columns: T[], order: string[]): boolean {
  if (order.length === 0) return true;
  return applyColumnOrder(columns, order).every((column, index) => column.id === columns[index].id);
}
