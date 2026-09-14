// 币种下拉的纯逻辑：字典项 -> 下拉选项 + 历史值兜底。
//
// 决策依据：`docs/product/PRD.md`「支持多币种，币种为可配置字典」、
// `docs/product/SRS.md`「币种……应支持授权用户通过管理接口维护，不写死在前端或后端代码中」。
// 因此下拉的第一来源永远是 `GET /dictionaries/currency/items`（见 lib/currency-catalogue.ts）；
// 下面的内置清单只在字典请求失败或字典为空时兜底，保证离线/未迁移的库也能录入金额。
//
// 本文件保持零依赖，便于 lib/**/*.test.mjs 用 Node 原生 test 直接 import。

export type CurrencyOption = { value: string; label: string };
/**
 * 兼容两种形状：字典接口返回 `{ key, label, sortOrder, isActive }`，
 * 而页面里已经算好的选项是 `{ value, label }`。两者都能直接喂给下面的函数。
 */
export type CurrencyDictionaryItem = { key?: string; value?: string; label?: string; sortOrder?: number; isActive?: boolean };

/** 内置兜底清单，与后端 `currency-catalog.ts` 保持一致。 */
export const FALLBACK_CURRENCIES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "CNY", label: "人民币" },
  { key: "USD", label: "美元" },
  { key: "EUR", label: "欧元" },
  { key: "HKD", label: "港币" },
  { key: "JPY", label: "日元" },
  { key: "GBP", label: "英镑" },
  { key: "TWD", label: "新台币" },
  { key: "SGD", label: "新加坡元" },
  { key: "AUD", label: "澳元" },
  { key: "CAD", label: "加元" },
  { key: "KRW", label: "韩元" },
  { key: "THB", label: "泰铢" },
  { key: "MYR", label: "马来西亚林吉特" },
  { key: "VND", label: "越南盾" },
  { key: "INR", label: "印度卢比" },
];

const labelOf = (key: string, label: string | undefined) => {
  const trimmed = (label ?? "").trim();
  return trimmed ? `${key} ${trimmed}` : key;
};
const codeOf = (item: CurrencyDictionaryItem) => (item.key ?? item.value ?? "").trim();

/**
 * 启用币种的选项：过滤停用/软删除项，按 sortOrder、key 排序。
 * 字典为空（未配置或请求失败）时退回内置清单。
 */
export function currencyOptions(items: CurrencyDictionaryItem[] | undefined | null): CurrencyOption[] {
  const active = (items ?? []).filter((item) => item.isActive !== false && codeOf(item) !== "");
  // 兜底清单按数组顺序赋排序号：CNY 必须排在第一个，defaultCurrency 才会选到它。
  const source = active.length ? active : FALLBACK_CURRENCIES.map((item, index) => ({ ...item, sortOrder: (index + 1) * 10, isActive: true }));
  const seen = new Set<string>();
  return source
    .map((item) => ({ value: codeOf(item), label: labelOf(codeOf(item), item.label), sortOrder: item.sortOrder ?? 0 }))
    .filter((item) => (seen.has(item.value) ? false : (seen.add(item.value), true)))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.value.localeCompare(right.value))
    .map((item) => ({ value: item.value, label: item.label }));
}

/**
 * 表单用的选项：选项列表 +（必要时）当前值。
 *
 * 库里可能存着字典里没有的历史币种（例如字典迁移前录入的编码）。
 * 直接丢弃当前值会让用户一打开编辑弹窗就被迫改币种，所以补一个「历史值」选项。
 */
export function currencyOptionsWithCurrent(items: CurrencyDictionaryItem[] | undefined | null, current: string | undefined | null): CurrencyOption[] {
  const options = currencyOptions(items);
  const wanted = (current ?? "").trim();
  if (!wanted || options.some((option) => option.value === wanted)) return options;
  return [{ value: wanted, label: `${wanted}（历史值）` }, ...options];
}

/** 默认选中值：优先当前值，其次是默认币种，最后是第一个可选币种。 */
export function defaultCurrency(items: CurrencyDictionaryItem[] | undefined | null, current?: string | undefined | null, preferred = "CNY"): string {
  const options = currencyOptionsWithCurrent(items, current);
  const wanted = (current ?? "").trim();
  if (wanted) return wanted;
  if (options.some((option) => option.value === preferred)) return preferred;
  return options[0]?.value ?? preferred;
}

/** 从后端字典接口取币种；任何失败都回落到内置清单，不阻断页面。见 lib/currency-catalogue.ts。 */
export function fallbackCurrencyOptions(): CurrencyOption[] {
  return currencyOptions([]);
}
