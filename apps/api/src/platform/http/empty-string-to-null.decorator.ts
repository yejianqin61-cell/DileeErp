import { Transform } from "class-transformer";

/**
 * 把「表单里留空」提交上来的空串（含纯空白）转成 `null`。
 *
 * 与 `EmptyStringToUndefined` 的区别只有一条，但语义正好相反：
 *   - `EmptyStringToUndefined`：空串 = **没提供这个字段**（更新时＝不动）；
 *   - `EmptyStringToNull`：空串 = **把这个字段清空**（更新时＝落 NULL）。
 *
 * 为什么需要它（而不是直接用 `EmptyStringToUndefined`）：销售单工艺单的 37 个细化字段里，
 * 空串的既定语义是「清除这一格」（见 sales-orders.service.ts 的 `specScalars`，它把 `""` 落成
 * NULL）——文本列用 `@IsString()` 能直接放行空串，但**数值列不行**：
 * `@IsOptional()` 只跳过 `null` / `undefined`，`""` 仍会走到 `@Matches` / `@IsDecimal` 上被拒。
 * 于是「布量一个字都不填」这种最常见的填法必然 400，而且报的还是笼统的「请求参数校验失败」。
 *
 * 用 `null` 而不是 `undefined` 是关键：`@IsOptional()` 同样跳过 `null`（校验能过），
 * 而服务层的 `specScalars` 把 `null` 原样落库（清空语义保住了）。换成
 * `EmptyStringToUndefined` 则变成「不动」——用户把一格删空再保存，值还在，看着像保存失败。
 *
 * 只用于可选字段；必填字段应当用 `@IsNotEmpty()` 之类显式拒绝空串。
 */
export function EmptyStringToNull() {
  return Transform(({ value }) => (typeof value === "string" && value.trim() === "" ? null : value));
}
