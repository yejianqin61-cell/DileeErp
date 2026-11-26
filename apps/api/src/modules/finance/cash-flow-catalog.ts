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
 *
 * ## 2026-11-23：内置清单分「历史」与「当前」两份
 *
 * 用户要求把「中国银行-人民币账户」与「备用金（招商银行账户）」加进结算方式。
 * 迁移 `20260914190000_cash_flow_entries` 已经执行过、按仓库红线**不可再改**，
 * 它当年只种了老表里的 2 个账户；因此这里把那份历史清单单独冻结成
 * `LEGACY_SETTLEMENT_ACCOUNTS`（迁移守卫测试用它），
 * 而 `DEFAULT_SETTLEMENT_ACCOUNTS` 是**当前**内置清单（4 项），供 `prisma/seed.ts` 初始化/补齐新库。
 *
 * 已有库里的这两项不会因为改代码自动出现：不能新增 migration、也不能由 Agent 直接写生产库，
 * 所以财务页「结算方式」提供了「补齐缺失的内置账户」按钮（走既有字典接口，由管理员显式触发），
 * 或在部署时执行一次 `npm run db:seed --workspace=@dilee/api`（幂等 upsert）。
 */

export const SETTLEMENT_ACCOUNT_DICTIONARY_KEY = "settlement_account";

export type DictionarySeed = { key: string; label: string; sortOrder: number };

/** 老表「结算方式」里出现过的银行账户（迁移 20260914190000 已固化，**不要再改**）。 */
const LEGACY_SETTLEMENT_ACCOUNT_LABELS = ["农业银行5706", "中国银行（美元）7624"] as const;

/** 当前内置结算账户：历史两项 + 2026-11-23 用户新增两项。 */
const SETTLEMENT_ACCOUNT_LABELS = [
  ...LEGACY_SETTLEMENT_ACCOUNT_LABELS,
  "中国银行-人民币账户",
  "备用金（招商银行账户）",
] as const;

/** 归一化：去首尾空白 + 连续空白并成一个空格（其余原样保留）。 */
export const normalizeDictionaryLabel = (label: string): string => label.trim().replace(/\s+/g, " ");

const toSeed = (labels: readonly string[]): DictionarySeed[] =>
  labels.map((label, index) => {
    const text = normalizeDictionaryLabel(label);
    // key 直接用中文标签：这些账户是给财务看的业务文本，没有对外的英文编码需求，
    // 中文 key 在库里可读、也不会因为拼音方案变化而漂移。
    return { key: text, label: text, sortOrder: (index + 1) * 10 };
  });

/** 迁移 20260914190000 种下的两项（历史事实，已冻结；迁移守卫测试用它校验「老库升级后不丢项」）。 */
export const LEGACY_SETTLEMENT_ACCOUNTS: readonly DictionarySeed[] = toSeed(LEGACY_SETTLEMENT_ACCOUNT_LABELS);

/** 当前内置结算账户（seed 用；含 2026-11-23 新增的两项）。 */
export const DEFAULT_SETTLEMENT_ACCOUNTS: readonly DictionarySeed[] = toSeed(SETTLEMENT_ACCOUNT_LABELS);
