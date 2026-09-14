// 币种字典的加载入口（唯一会发请求的币种模块）。
//
// 与 lib/currency-options.ts 分开的原因：纯逻辑模块保持零依赖，才能被
// `lib/**/*.test.mjs` 用 Node 原生 test 直接 import（Node 的 ESM 解析器不认无扩展名 import）。
//
// 页面统一从这里 import，既能拿到纯函数，也能拿到 fetchCurrencyOptions。
import { apiGet } from "./api-client";
import { currencyOptions, type CurrencyDictionaryItem, type CurrencyOption } from "./currency-options";

export * from "./currency-options";

/** 后端字典接口路径：币种是 `dictionary_types.key = "currency"` 下的可配置字典项。 */
export const CURRENCY_DICTIONARY_PATH = "/dictionaries/currency/items";

/**
 * 拉取启用币种。
 *
 * 任何失败（未登录、无权限、字典未迁移、网络中断）都回落到内置清单：
 * 币种是静态配置，拿不到不应该把整页金额录入锁死。
 */
export async function fetchCurrencyOptions(): Promise<CurrencyOption[]> {
  try {
    const result = await apiGet<CurrencyDictionaryItem[]>(CURRENCY_DICTIONARY_PATH);
    return currencyOptions(result.data ?? []);
  } catch {
    return currencyOptions([]);
  }
}
