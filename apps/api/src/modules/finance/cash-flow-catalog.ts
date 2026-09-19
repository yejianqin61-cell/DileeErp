/**
 * 「结算账户」字典的内置清单（收支流水上给人看的那个账户文本）。
 *
 * 需求来源：`example/财务/收支明细表.xls` 的「结算方式」列（形如 `转账--农业银行5706`）。
 *
 * 为什么单独成模块：迁移 SQL、`prisma/seed.ts` 与迁移守卫测试必须用**同一份清单**，
 * 否则「老库升级」与「新库初始化」会种出不同的字典（币种字典当年就是这么做的）。
 *
 * ## 2026-09-17：本文件不再是「收支项目」的来源
 *
 * 用户 2026-09-17 交付 `example/财务/科目表(2).xls` 并选定「收支项目维护和会计科目合并成一个」
 * ——原来的 37 个收支项目（本文件曾经的 `DEFAULT_CASH_FLOW_ITEMS`）已并入会计科目表，
 * 见 `accounting-subject-catalog.ts`：那里才是财务口径的唯一来源，这里只剩结算账户。
 *
 * 保留文件名而不是改名，是为了让 `20260914190000_cash_flow_entries` 迁移与既有守卫测试的
 * 引用不至于为了重命名而整片改动；本文件当前只服务「收支管理」板块，名字仍然贴切。
 */

export const SETTLEMENT_ACCOUNT_DICTIONARY_KEY = "settlement_account";

export type DictionarySeed = { key: string; label: string; sortOrder: number };

/** 老表「结算方式」里出现过的银行账户。 */
const SETTLEMENT_ACCOUNT_LABELS = ["农业银行5706", "中国银行（美元）7624"] as const;

/** 归一化：去首尾空白 + 连续空白并成一个空格（其余原样保留）。 */
export const normalizeDictionaryLabel = (label: string): string => label.trim().replace(/\s+/g, " ");

const toSeed = (labels: readonly string[]): DictionarySeed[] =>
  labels.map((label, index) => {
    const text = normalizeDictionaryLabel(label);
    // key 直接用中文标签：这些账户是给财务看的业务文本，没有对外的英文编码需求，
    // 中文 key 在库里可读、也不会因为拼音方案变化而漂移。
    return { key: text, label: text, sortOrder: (index + 1) * 10 };
  });

export const DEFAULT_SETTLEMENT_ACCOUNTS: readonly DictionarySeed[] = toSeed(SETTLEMENT_ACCOUNT_LABELS);
