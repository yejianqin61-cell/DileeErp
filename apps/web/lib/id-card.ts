/**
 * 身份证号解析（页面填表用）。
 *
 * 与后端 `apps/api/src/modules/production/employee-roster.ts` 的 parseIdCard **行为一致**：
 * 同样的校验位算法、同样的出生日期/性别推导、同样的行政区划取名，区别只有输出的出生日期是
 * 表单直接能用的 `YYYY-MM-DD` 字符串（后端给的是 Date，用于 @db.Date 落库）。
 *
 * 之所以在 Web 再写一份：本仓库是 apps/* 双 workspace、没有共享包（币种字典也是两边各一份的
 * 既有约定），而「填完身份证号立刻跳出出生日期/性别」必须在本地完成，不能每敲一位就打接口。
 * 两边的一致性由测试保证：同一批身份证号在 API 单测与 Web 测试里断言同样的结果；
 * 行政区划表本身由 `scripts/generate-china-regions.mjs` 生成两份**逐字节相同**的副本。
 */
import { lookupRegion, type ChinaRegion } from "./china-region";

const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECK_CODES = "10X98765432";

export type IdCardIdentity = {
  /** 表单直接可用的出生日期 YYYY-MM-DD */
  birthDate: string;
  gender: "男" | "女";
  /** 前 6 位解析出的省 / 市 / 区县（老代码按当时的名称，查不到的那一级为空串） */
  region: ChinaRegion;
  /** = region.label，方便直接当地址前缀用 */
  addressPrefix: string;
};

export type IdCardResult = { ok: true; value: IdCardIdentity } | { ok: false; reason: string };

/** 只认 18 位（含 X）与 15 位老号；其它一律当「还没填完/填错了」。 */
export function parseIdCard(value: string | null | undefined): IdCardResult {
  const text = String(value ?? "").replace(/\s+/g, "").toUpperCase();
  if (!text) return { ok: false, reason: "为空" };
  if (/^\d{17}[\dX]$/.test(text)) {
    const expected = ID_CARD_CHECK_CODES[ID_CARD_WEIGHTS.reduce((sum, weight, index) => sum + weight * Number(text[index]), 0) % 11];
    if (expected !== text[17]) return { ok: false, reason: "校验位不匹配，请核对号码" };
    const birthDate = formatDate(text.slice(6, 10), text.slice(10, 12), text.slice(12, 14));
    if (!birthDate) return { ok: false, reason: "出生日期段无法解析" };
    return { ok: true, value: identity(birthDate, Number(text[16]) % 2 === 1 ? "男" : "女", text.slice(0, 6)) };
  }
  if (/^\d{15}$/.test(text)) {
    const birthDate = formatDate(`19${text.slice(6, 8)}`, text.slice(8, 10), text.slice(10, 12));
    if (!birthDate) return { ok: false, reason: "出生日期段无法解析" };
    return { ok: true, value: identity(birthDate, Number(text[14]) % 2 === 1 ? "男" : "女", text.slice(0, 6)) };
  }
  return { ok: false, reason: "必须为 18 位（或 15 位）身份证号" };
}

function identity(birthDate: string, gender: "男" | "女", regionCode: string): IdCardIdentity {
  const region = lookupRegion(regionCode);
  return { birthDate, gender, region, addressPrefix: region.label };
}

/** YYYY-M-D → YYYY-MM-DD，并拒绝 2 月 31 日这类会翻滚的日期（与后端同一套判定）。 */
function formatDate(year: string, month: string, day: string): string {
  const y = Number(year); const m = Number(month); const d = Number(day);
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return "";
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * 表单自动填充：身份证号的出生日期/性别/地址前缀。
 * 只在目标字段**还是空的**时候填 —— 操作员手填过的值不能被悄悄覆盖。
 */
export function deriveEmployeeFieldsFromIdCard(idCard: string, current: { birth_date?: string; gender?: string; home_address?: string }): Record<string, string> {
  const parsed = parseIdCard(idCard);
  if (!parsed.ok) return {};
  const patch: Record<string, string> = {};
  if (!current.birth_date?.trim()) patch.birth_date = parsed.value.birthDate;
  if (!current.gender?.trim()) patch.gender = parsed.value.gender;
  // 家庭住址只补省市县前缀，镇/村/门牌由操作员接着手填（后面留一个空格方便继续输入）。
  if (!current.home_address?.trim() && parsed.value.addressPrefix) patch.home_address = `${parsed.value.addressPrefix} `;
  return patch;
}

export { lookupRegion, type ChinaRegion };
