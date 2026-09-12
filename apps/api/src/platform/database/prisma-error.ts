/** Prisma 唯一约束冲突（P2002）。并发写入或自动编码撞号时用它区分「可以重算重试」与其它错误。 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002";
}

/**
 * P2002 是否来自指定列（唯一索引）。
 * meta.target 可能是列名数组（["customer_code"]）或约束名（"customers_customer_code_key"）；
 * 拿不到 target 时保守返回 false —— 不重试也不会写坏数据，只是少一次自愈机会。
 */
export function isUniqueConstraintViolationOn(error: unknown, ...columns: string[]): boolean {
  if (!isUniqueConstraintViolation(error)) return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const targets = (Array.isArray(target) ? target : typeof target === "string" ? [target] : []).map((item) => String(item).toLowerCase());
  if (!targets.length) return false;
  return targets.some((value) => columns.some((column) => value === column.toLowerCase() || value.includes(column.toLowerCase())));
}
