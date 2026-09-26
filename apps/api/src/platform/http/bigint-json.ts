/**
 * 让 `BigInt` 能被 `JSON.stringify` 序列化。
 *
 * 为什么需要（实测事故，2026-09-26）：`JSON.stringify(1n)` 会抛
 * `TypeError: Do not know how to serialize a BigInt`，而它是**运行时**才炸的：
 *   * `GET /finance/opening-balances` 返回试算平衡的大写金额（BigInt）→ 500；
 *   * `POST /attachments` 返回 Prisma 整行，而 `attachments.file_size` 是 `BigInt` → 500。
 * 两次都不是"算错了"，而是"算对了却送不出去"——整行/整个响应直接 500，接口等于不存在。
 *
 * 为什么放在全局而不是逐处改：
 *   1. 这类缺陷**只在真实响应层出现**：单测里 Prisma 是替身、不会给出 BigInt，
 *      所以每个 service 都得靠人记得转换，漏一处就是一个 500（上面两处就是这么漏的）；
 *   2. 序列化成**字符串**而不是 Number：全站金额约定就是"字符串十进制"（见 `money.ts`），
 *      而且 Number 会在超过 2^53 时静默丢精度——那比 500 更难发现。
 *
 * 服务层该不该仍然显式转字符串：该。全局这层是**兜底**（保证再漏一处也不会 500），
 * 显式转换是**契约**（让响应形状在类型与测试里看得见）。两者都要。
 */
export function installBigIntJson(): void {
  // 只打一次补丁；重复安装无副作用。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prototype = BigInt.prototype as any;
  if (typeof prototype.toJSON === "function") return;
  prototype.toJSON = function toJSON(this: bigint): string {
    return this.toString();
  };
}
