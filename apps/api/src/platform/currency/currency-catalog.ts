/**
 * 内置币种目录（纯数据，无框架依赖）。
 *
 * `prisma/seed.ts` 与 `currency.service.ts` 共用同一份清单，
 * 避免「种子数据」和「服务默认值」两处各写一份而漂移。
 */
export const CURRENCY_DICTIONARY_KEY = "currency";

export type CurrencyCatalogItem = { key: string; label: string; sortOrder: number };

export const DEFAULT_CURRENCIES: ReadonlyArray<CurrencyCatalogItem> = [
  { key: "CNY", label: "人民币", sortOrder: 10 },
  { key: "USD", label: "美元", sortOrder: 20 },
  { key: "EUR", label: "欧元", sortOrder: 30 },
  { key: "HKD", label: "港币", sortOrder: 40 },
  { key: "JPY", label: "日元", sortOrder: 50 },
  { key: "GBP", label: "英镑", sortOrder: 60 },
  { key: "TWD", label: "新台币", sortOrder: 70 },
  { key: "SGD", label: "新加坡元", sortOrder: 80 },
  { key: "AUD", label: "澳元", sortOrder: 90 },
  { key: "CAD", label: "加元", sortOrder: 100 },
  { key: "KRW", label: "韩元", sortOrder: 110 },
  { key: "THB", label: "泰铢", sortOrder: 120 },
  { key: "MYR", label: "马来西亚林吉特", sortOrder: 130 },
  { key: "VND", label: "越南盾", sortOrder: 140 },
  { key: "INR", label: "印度卢比", sortOrder: 150 },
];
