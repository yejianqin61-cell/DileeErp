import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * B13：统一的十进制数量输入守卫。
 *
 * 为什么必须显式做正则校验（而不是只依赖 `new Prisma.Decimal(value)`）：
 *   * `new Prisma.Decimal("NaN")` **不抛异常**，而 `NaN.lte(0)` / `NaN.gt(x)` 恒为 false ——
 *     NaN 会绕过所有「必须大于 0」「不能超过可用量」的比较，被写进库存事实后，
 *     该 (生产单, 单位, 类别) 的余额恒为 NaN，后续所有数量校验一起失效；
 *   * 指数写法 `1e3`、超过 4 位小数（PG `numeric(18,4)` 会四舍五入成 0，例如 `0.00004` → `0.0000`）
 *     以及超出 Decimal(18,4) 整数位上限的值同样要在入口拦下。
 *
 * @param value    原始字符串（DTO 层统一是 string，金额/数量不允许浮点）
 * @param code     业务错误码
 * @param message  面向用户的错误文案
 * @param options  allowZero=true 时允许 0（用于「可以为 0」的数量字段）
 */
export function parseQuantity(value: string, code: string, message: string, options: { allowZero?: boolean } = {}) {
  const trimmed = String(value ?? "").trim();
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(trimmed);
  if (!match || match[1].replace(/^0+/, "").length > 14) throw new UnprocessableEntityException({ code, message, details: [] });
  const decimal = new Prisma.Decimal(trimmed);
  if (options.allowZero ? decimal.lt(0) : !decimal.gt(0)) throw new UnprocessableEntityException({ code, message, details: [] });
  return decimal;
}
