/**
 * 单号与检索词的归一（R-4）：**只做三件事** —— 去首尾空白、合并连续空白、匹配时忽略大小写。
 *
 * 为什么不改库里的值：订单号是业务自己编的，`DL260170-4H 伞头` 里的空格与产品名都是真实内容；
 * 归一只能发生在「比对」这一步。大小写不敏感交给查询层的 `mode: "insensitive"`，
 * 因为它在 PostgreSQL 上走 `ILIKE`，比取回内存再比更快也更准。
 *
 * 不做拼音、同音字、模糊纠错：那会把「查不到」变成「查到一张看起来像的单」，
 * 对财务与对账场景比对查不到更危险。
 */
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;
const FULL_WIDTH_ASCII = /[\uff10-\uff19\uff21-\uff3a\uff41-\uff5a\uff0d\uff3f\uff0f\uff0e]/g;
const IDEOGRAPHIC_SPACE = /\u3000/g;

export function normalizeKeyword(value: string): string {
  return value
    .replace(ZERO_WIDTH, "")
    .replace(FULL_WIDTH_ASCII, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(IDEOGRAPHIC_SPACE, " ")
    .trim()
    .replace(/\s+/g, " ");
}
