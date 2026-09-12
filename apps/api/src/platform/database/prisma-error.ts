/** Prisma 唯一约束冲突（P2002）。并发写入或自动编码撞号时用它区分「可以重算重试」与其它错误。 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002";
}
