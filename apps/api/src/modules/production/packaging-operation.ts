// 包装工序认定（业务口径，用户确认）：工序名称包含「包装」即视为收尾工序。
// 不新增主数据字段，识别逻辑集中在这里，避免各处各写一份字符串匹配。
// 约束：只使用可擦除 TS 语法，便于 node:test 直接加载。

export const PACKAGING_OPERATION_KEYWORD = "包装";

export function isPackagingOperationName(name: string | null | undefined): boolean {
  return typeof name === "string" && name.includes(PACKAGING_OPERATION_KEYWORD);
}

type OperationLike = { operationNameSnapshot: string; status?: string; sequenceNo?: number };

/**
 * 取生产单的包装（收尾）工序。
 * - 只看未取消（active）的工序；
 * - 多道工序名称都含「包装」时取序号最大的一道（最靠后即收尾）。
 */
export function findPackagingOperation<T extends OperationLike>(operations: readonly T[]): T | null {
  const candidates = operations.filter((operation) => (operation.status === undefined || operation.status === "active") && isPackagingOperationName(operation.operationNameSnapshot));
  if (!candidates.length) return null;
  return candidates.reduce((latest, operation) => ((operation.sequenceNo ?? 0) >= (latest.sequenceNo ?? 0) ? operation : latest), candidates[0]);
}
