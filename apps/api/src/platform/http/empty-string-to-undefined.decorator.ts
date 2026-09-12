import { Transform } from "class-transformer";

/**
 * 把「表单里留空」提交上来的空串（含纯空白）转成 undefined。
 *
 * 背景：Web 的 ActionDialog 会把每个字段都初始化成 defaultValue ?? ""，页面再 `{ ...values }`
 * 提交，于是没填的可选数字/日期字段会以 "" 出现在请求体里。class-validator 的
 * @IsOptional() 只跳过 null / undefined，"" 仍会走到 @IsDecimal / @IsDateString / @IsUUID
 * 上被拒，用户看到的是「留空就保存失败 400」。
 *
 * 语义：空串 = 没提供该字段（而不是「清空该字段」），与 @IsOptional() 的语义一致。
 * 只用于可选字段；必填字段应当用 @IsNotEmpty() 之类显式拒绝空串。
 */
export function EmptyStringToUndefined() {
  return Transform(({ value }) => (typeof value === "string" && value.trim() === "" ? undefined : value));
}
