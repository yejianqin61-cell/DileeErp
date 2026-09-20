import { BadRequestException, ValidationError } from "@nestjs/common";

/**
 * 一条字段级校验错误。
 *
 * 前端只依赖这三个键（`apps/web/lib/api-client.ts` 把 details 原样带出，
 * 页面负责把 `field` / `message` 拼成人话）。键名不要改：改了等于把全站的错误提示一起改。
 */
export type ValidationDetail = { field: string; rule: string; message: string };

const isArrayIndex = (segment: string) => /^\d+$/.test(segment);

/** 拼字段路径：数组下标写成 `spec_details[0]`，对象属性写成 `a.b`。 */
function joinPath(parent: string, property: string): string {
  if (!parent) return property;
  return isArrayIndex(property) ? `${parent}[${property}]` : `${parent}.${property}`;
}

/**
 * 把 class-validator 的**树形** ValidationError 拍平成可定位的字段路径列表。
 *
 * 为什么必须递归（这是一个被记录在案的契约缺陷，recon D10）：原实现只读 `error.constraints`，
 * 而 `@ValidateNested()` 的失败挂在 `error.children` 上、自己一个 constraint 都没有。
 * 于是「明细第 2 行的数量填了 abc」这种错误返回的 `details` 是 **空数组** ——
 * 前端拿到的就只有一句「请求参数校验失败」，四种可能的原因（明细数量、明细必填、未知字段、
 * 顶层字段）全长得一模一样，用户除了盲目试错没有别的办法。
 *
 * 现在会返回 `spec_details[1].quantity` 这样的路径，前端可以逐条指出来。
 */
export function flattenValidationErrors(errors: readonly ValidationError[], parent = ""): ValidationDetail[] {
  const details: ValidationDetail[] = [];
  for (const error of errors) {
    const path = joinPath(parent, error.property);
    for (const [rule, message] of Object.entries(error.constraints ?? {})) details.push({ field: path, rule, message });
    // 子节点只有在自己也没有 constraint 时才是「有意义的中间层」，但无论哪种情况递归都不会重复报。
    if (error.children?.length) details.push(...flattenValidationErrors(error.children, path));
  }
  return details;
}

/**
 * 全局 ValidationPipe 的 exceptionFactory（main.ts 用）。
 *
 * 形状固定为 `{ code, message, details }`，与全站其它业务异常的载荷一致
 * （`ApiExceptionFilter.normalizePayload` 认这个形状）。抽到独立文件是为了能在单测里
 * 直接用真实 ValidationPipe 跑一遍请求体 —— 放在 main.ts 的 bootstrap 里就永远测不到。
 */
export function validationExceptionFactory(errors: ValidationError[]) {
  return new BadRequestException({
    code: "VALIDATION_ERROR",
    message: "请求参数校验失败",
    details: flattenValidationErrors(errors),
  });
}
