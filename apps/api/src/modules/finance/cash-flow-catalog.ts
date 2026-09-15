/**
 * 收支项目 / 结算账户的内置清单。
 *
 * 需求来源：`example/财务/收支汇总表.xls` 的「项目」列（37 行）与
 * `example/财务/收支明细表.xls` 的「结算方式」列（形如 `转账--农业银行5706`）。
 *
 * 为什么单独成模块：迁移 SQL、`prisma/seed.ts` 与迁移守卫测试必须用**同一份清单**，
 * 否则「老库升级」与「新库初始化」会种出不同的字典（币种字典当年就是这么做的）。
 *
 * 标签是**老表原文照抄**（只去首尾空白、把连续空白并成一个空格）：
 * 里面确实有手误留下的空格（`原材料 成本`、`人 工费`），也有把**银行账户**当项目列进来的
 * （`中国银行 美元`）。这些都不在代码里"顺便修好"——项目改成可配置字典之后，
 * 由管理员在「收支项目」维护里改名或停用（用户 R6 选定的就是「可配置字典」）。
 */
export const CASH_FLOW_ITEM_DICTIONARY_KEY = "cash_flow_item";
export const SETTLEMENT_ACCOUNT_DICTIONARY_KEY = "settlement_account";

export type DictionarySeed = { key: string; label: string; sortOrder: number };

/** 老表「项目」列原文（按原顺序）。 */
const CASH_FLOW_ITEM_LABELS = [
  "备用金",
  "货款",
  "美金转入",
  "原材料 成本",
  "外加工费 晋江大田工资 ",
  "成品外加工费",
  "房租支出",
  "会展费用",
  "销售费用",
  "货代费",
  "水电费",
  "国际快递费",
  "机器折旧费用",
  "辅料费",
  "制造费用-货拉拉",
  "制造费用-物流",
  "销售费用-货拉拉",
  "生产用品、工具费用",
  "管理费用",
  "销售样品费",
  "销售知识产权费用",
  "顺丰快递费",
  "办公费用",
  "差旅费",
  "验厂费",
  "杂费车间装修费",
  "财务费用-手续费",
  "财务费用-外账",
  "银行费用利息",
  "电商费用",
  "机械维修费",
  "员工福利费",
  "员工餐费",
  "国家退税",
  "人 工费",
  "加工费",
  "中国银行 美元",
] as const;

/** 老表「结算方式」里出现过的银行账户。 */
const SETTLEMENT_ACCOUNT_LABELS = ["农业银行5706", "中国银行（美元）7624"] as const;

/** 归一化：去首尾空白 + 连续空白并成一个空格（其余原样保留）。 */
export const normalizeDictionaryLabel = (label: string): string => label.trim().replace(/\s+/g, " ");

const toSeed = (labels: readonly string[]): DictionarySeed[] =>
  labels.map((label, index) => {
    const text = normalizeDictionaryLabel(label);
    // key 直接用中文标签：这些项目是给财务看的业务类目，没有对外的英文编码需求，
    // 中文 key 在库里可读、也不会因为拼音方案变化而漂移。
    return { key: text, label: text, sortOrder: (index + 1) * 10 };
  });

export const DEFAULT_CASH_FLOW_ITEMS: readonly DictionarySeed[] = toSeed(CASH_FLOW_ITEM_LABELS);
export const DEFAULT_SETTLEMENT_ACCOUNTS: readonly DictionarySeed[] = toSeed(SETTLEMENT_ACCOUNT_LABELS);

/**
 * 自动写入收支流水时，按业务来源选定收支项目（**按优先级**）。
 *
 * 为什么是一串候选而不是单个 key：一笔资金动账必须落进一个收支项目，而项目是管理员可改的字典。
 * 给候选链，第一个存在的生效；一个都不存在时由 `CashFlowService.autoCreateFromPayment` 显式 422
 * —— 绝不静默跳过：历史缺陷正是供应商付款写死 `外加工费`，而字典里只有「外加工费 晋江大田工资」，
 * 结果每一笔供应商付款都被悄悄丢掉，收支流水里只剩客户货款与工资付款。
 *
 * key 就是字典里的中文标签（见 toSeed：key = label）。
 */
export const PAYMENT_ITEM_KEYS = {
  /** 收到客户货款（收）。 */
  customer_payment: ["货款"],
  /** 工资付款（支）。 */
  salary_payment: ["人 工费"],
  /** 原料入库形成的应付付款（支）。 */
  raw_material_inbound: ["原材料 成本", "货款"],
  /** 到货单来源（已禁用，仅兼容历史数据）。 */
  purchase_receipt: ["原材料 成本", "货款"],
  /** 外加工签收形成的应付付款（支）。 */
  outsource_receipt: ["成品外加工费", "加工费"],
  /** 其他应付（支）。 */
  other: ["管理费用", "杂费车间装修费"],
} as const;

/** 一次付款核销了多种来源时的兜底候选（最常见的是采购付款）。 */
export const DEFAULT_PAYMENT_ITEM_KEYS: readonly string[] = ["原材料 成本", "货款"];

/** 来源类型 → 收支项目候选；未知来源用兜底链。 */
export function paymentItemKeys(sourceType: string): readonly string[] {
  return (PAYMENT_ITEM_KEYS as Record<string, readonly string[]>)[sourceType] ?? DEFAULT_PAYMENT_ITEM_KEYS;
}
