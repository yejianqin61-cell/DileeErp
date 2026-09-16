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
 * 表单自动填充：身份证号变化时重新解析出生日期、性别与住址的省市县前缀。
 *
 * 规则（身份证是这三项的权威来源，改了号码就跟着改）：
 * - 出生日期、性别：只要身份证能解析出来就覆盖（操作员手填过的也一样覆盖 —— 号码变了，手填值
 *   就不再对应当前号码了）；
 * - 家庭住址：只换掉**省市县前缀**，手填的镇/村/门牌原样保留；地址是空的就填前缀。
 *   开头认不出省市县（例如只写了「新民镇柑岭村」）时一个字都不动 —— 宁可少补一个前缀，
 *   也不能把操作员写的详细地址冲掉。
 * - 身份证清空或还没填完 → 什么都不动（不猜、不清空已有信息）。
 *
 * 刻意**不依赖「上一个身份证号」**：操作员可能先清空再输入，中间态里旧号码已经丢了；
 * 直接从地址开头认省市县，跟怎么改的无关。
 */
export function deriveEmployeeFieldsFromIdCard(
  idCard: string | null | undefined,
  current: { birth_date?: string; gender?: string; home_address?: string },
): Record<string, string> {
  const parsed = parseIdCard(idCard);
  if (!parsed.ok) return {};
  const patch: Record<string, string> = {
    birth_date: parsed.value.birthDate,
    gender: parsed.value.gender,
  };
  const nextAddress = swapRegionPrefix(current.home_address ?? "", parsed.value.addressPrefix);
  if (nextAddress !== (current.home_address ?? "")) patch.home_address = nextAddress;
  return patch;
}

/** 行政区划名称的尾巴。**故意不含「镇/乡/村/街道」** —— 那些属于手填的详细地址，不能被换掉。 */
const REGION_SUFFIX = /(省|市|区|县|旗|盟|地区|自治州|自治县|自治区|林区|特区|群岛)$/;

/**
 * 从地址开头认出「省市县」那一截：取**最长**的、看起来像行政区划名的纯中文前缀。
 * 只连续取中文（遇到数字/字母/空白就停），因此「同安区新民镇5号」只认到「同安区」，
 * 「福建省三明市建宁县新民镇柑岭村」认到「福建省三明市建宁县」。
 */
function findRegionHead(address: string): string {
  const chinese = /^[\u4e00-\u9fa5]+/.exec(address)?.[0] ?? "";
  for (let end = chinese.length; end >= 2; end -= 1) {
    const candidate = chinese.slice(0, end);
    if (REGION_SUFFIX.test(candidate)) return candidate;
  }
  return "";
}

/**
 * 把地址开头的旧省市县换成新的，保留后面手填的详细地址。
 * 空地址 → 只给前缀（末尾留一个空格方便继续输入）；已经是新前缀 → 原样返回；
 * 开头认不出省市县 → 原样返回。
 */
function swapRegionPrefix(address: string, nextPrefix: string): string {
  if (!nextPrefix) return address;
  const trimmed = address.trim();
  if (!trimmed) return `${nextPrefix} `;
  if (trimmed.startsWith(nextPrefix)) return address;
  const head = findRegionHead(trimmed);
  if (!head) return address;
  const rest = trimmed.slice(head.length).replace(/^\s+/, "");
  return rest ? `${nextPrefix} ${rest}` : `${nextPrefix} `;
}

export { lookupRegion, type ChinaRegion };
