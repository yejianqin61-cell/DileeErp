/**
 * 会计科目表（全站财务口径的唯一来源）。
 *
 * 需求来源：用户 2026-09-17 交付的 `example/财务/科目表(2).xls`（sheet `Capacity report`，A1:H122）。
 * 用户口径原文：「那个编码的可以不管，分类就对应的是科目类别，项目就对应的是科目名称」。
 * 因此本表**只保留两级**：`category`（分类 = 科目类别）与 `name`（项目 = 科目名称）；
 * 老表的「科目代码」整列不采纳 —— 它自带 1001→100201→222101001 三层结构，与用户要的两级口径冲突。
 *
 * 为什么单独成模块：迁移 SQL、`prisma/seed.ts`、迁移守卫测试与「旧收支项目并入」映射必须用**同一份清单**，
 * 否则「老库升级」与「新库初始化」会种出不同的科目表（收支项目字典当年就踩过这个坑）。
 *
 * `balanceDirection`（余额方向，借/贷）照抄老表：本期不参与任何计算，但凭证/账簿将来要用它判断
 * 科目的自然余额方向，现在丢掉以后就得再问一次财务。
 */

export type AccountingSubjectSeed = {
  category: string;
  name: string;
  /** 余额方向：借 / 贷（老表 D 列原文）。 */
  balanceDirection: string;
  sortOrder: number;
};

/** 五类科目类别（老表 A 列出现过的全部取值，按老表首次出现顺序）。 */
export const ACCOUNTING_SUBJECT_CATEGORIES = [
  "资产类",
  "负债类",
  "成本类",
  "所有者权益类",
  "损益类",
] as const;

/** 科目表全部科目（老表行序即 sortOrder，间隔 10 便于插行）。 */
export const ACCOUNTING_SUBJECTS: readonly AccountingSubjectSeed[] = [
  { category: "资产类", name: "库存现金（备用金）", balanceDirection: "借", sortOrder: 10 },
  { category: "资产类", name: "银行存款", balanceDirection: "借", sortOrder: 20 },
  { category: "资产类", name: "银行存款 中国银行（人民币）", balanceDirection: "借", sortOrder: 30 },
  { category: "资产类", name: "银行存款 中国银行（美元）", balanceDirection: "借", sortOrder: 40 },
  { category: "资产类", name: "银行存款 农业银行", balanceDirection: "借", sortOrder: 50 },
  { category: "资产类", name: "银行存款 阿里账户（美元）", balanceDirection: "借", sortOrder: 60 },
  { category: "资产类", name: "银行存款 刘总转入", balanceDirection: "借", sortOrder: 70 },
  { category: "资产类", name: "其他货币资金", balanceDirection: "借", sortOrder: 80 },
  { category: "资产类", name: "短期投资", balanceDirection: "借", sortOrder: 90 },
  { category: "资产类", name: "应收票据", balanceDirection: "借", sortOrder: 100 },
  { category: "资产类", name: "应收账款", balanceDirection: "借", sortOrder: 110 },
  { category: "资产类", name: "预付账款", balanceDirection: "借", sortOrder: 120 },
  { category: "资产类", name: "应收股利", balanceDirection: "借", sortOrder: 130 },
  { category: "资产类", name: "应收利息", balanceDirection: "借", sortOrder: 140 },
  { category: "资产类", name: "其他应收款", balanceDirection: "借", sortOrder: 150 },
  { category: "资产类", name: "材料采购", balanceDirection: "借", sortOrder: 160 },
  { category: "资产类", name: "在途物资", balanceDirection: "借", sortOrder: 170 },
  { category: "资产类", name: "原材料", balanceDirection: "借", sortOrder: 180 },
  { category: "资产类", name: "材料成本差异", balanceDirection: "借", sortOrder: 190 },
  { category: "资产类", name: "库存商品", balanceDirection: "借", sortOrder: 200 },
  { category: "资产类", name: "发出商品", balanceDirection: "借", sortOrder: 210 },
  { category: "资产类", name: "商品进销差价", balanceDirection: "借", sortOrder: 220 },
  { category: "资产类", name: "委托加工物资", balanceDirection: "借", sortOrder: 230 },
  { category: "资产类", name: "半成品", balanceDirection: "借", sortOrder: 240 },
  { category: "资产类", name: "周转材料", balanceDirection: "借", sortOrder: 250 },
  { category: "资产类", name: "消耗性生物资产", balanceDirection: "借", sortOrder: 260 },
  { category: "资产类", name: "长期债券投资", balanceDirection: "借", sortOrder: 270 },
  { category: "资产类", name: "长期股权投资", balanceDirection: "借", sortOrder: 280 },
  { category: "资产类", name: "固定资产", balanceDirection: "借", sortOrder: 290 },
  { category: "资产类", name: "累计折旧", balanceDirection: "借", sortOrder: 300 },
  { category: "资产类", name: "在建工程", balanceDirection: "借", sortOrder: 310 },
  { category: "资产类", name: "工程物资", balanceDirection: "借", sortOrder: 320 },
  { category: "资产类", name: "固定资产清理", balanceDirection: "借", sortOrder: 330 },
  { category: "资产类", name: "生产性生物资产", balanceDirection: "借", sortOrder: 340 },
  { category: "资产类", name: "生产性生物资产累计折旧", balanceDirection: "借", sortOrder: 350 },
  { category: "资产类", name: "无形资产", balanceDirection: "借", sortOrder: 360 },
  { category: "资产类", name: "累计摊销", balanceDirection: "借", sortOrder: 370 },
  { category: "资产类", name: "长期待摊费用", balanceDirection: "借", sortOrder: 380 },
  { category: "资产类", name: "待处理财产损益", balanceDirection: "借", sortOrder: 390 },
  { category: "负债类", name: "短期借款", balanceDirection: "贷", sortOrder: 400 },
  { category: "负债类", name: "应付票据", balanceDirection: "贷", sortOrder: 410 },
  { category: "负债类", name: "应付账款", balanceDirection: "贷", sortOrder: 420 },
  { category: "负债类", name: "预收账款", balanceDirection: "贷", sortOrder: 430 },
  { category: "负债类", name: "应付职工薪酬", balanceDirection: "贷", sortOrder: 440 },
  { category: "负债类", name: "应交税费", balanceDirection: "贷", sortOrder: 450 },
  { category: "负债类", name: "应付利息", balanceDirection: "贷", sortOrder: 460 },
  { category: "负债类", name: "应付利润", balanceDirection: "贷", sortOrder: 470 },
  { category: "负债类", name: "其他应付款", balanceDirection: "贷", sortOrder: 480 },
  { category: "负债类", name: "递延收益", balanceDirection: "贷", sortOrder: 490 },
  { category: "负债类", name: "长期借款", balanceDirection: "贷", sortOrder: 500 },
  { category: "负债类", name: "长期应付款", balanceDirection: "贷", sortOrder: 510 },
  { category: "负债类", name: "应交税费-进项税", balanceDirection: "借", sortOrder: 520 },
  { category: "负债类", name: "应交税费-进项税--祥恩线业", balanceDirection: "借", sortOrder: 530 },
  { category: "负债类", name: "应交税费-销项税", balanceDirection: "借", sortOrder: 540 },
  { category: "成本类", name: "生产成本", balanceDirection: "借", sortOrder: 550 },
  { category: "成本类", name: "劳务成本", balanceDirection: "借", sortOrder: 560 },
  { category: "成本类", name: "制造费用", balanceDirection: "借", sortOrder: 570 },
  { category: "成本类", name: "研发支出", balanceDirection: "借", sortOrder: 580 },
  { category: "成本类", name: "工程施工", balanceDirection: "借", sortOrder: 590 },
  { category: "成本类", name: "机械作业", balanceDirection: "借", sortOrder: 600 },
  { category: "成本类", name: "临时工资", balanceDirection: "借", sortOrder: 610 },
  { category: "成本类", name: "加工费", balanceDirection: "借", sortOrder: 620 },
  { category: "成本类", name: "水电费", balanceDirection: "借", sortOrder: 630 },
  { category: "成本类", name: "房租费", balanceDirection: "借", sortOrder: 640 },
  { category: "成本类", name: "生产用品", balanceDirection: "借", sortOrder: 650 },
  { category: "成本类", name: "机台维修费", balanceDirection: "借", sortOrder: 660 },
  { category: "成本类", name: "顺丰快递", balanceDirection: "借", sortOrder: 670 },
  { category: "成本类", name: "基本生产成本", balanceDirection: "借", sortOrder: 680 },
  { category: "成本类", name: "辅助生产成本", balanceDirection: "借", sortOrder: 690 },
  { category: "成本类", name: "货拉拉 物流费", balanceDirection: "借", sortOrder: 700 },
  { category: "成本类", name: "印刷费", balanceDirection: "借", sortOrder: 710 },
  { category: "所有者权益类", name: "实收资本", balanceDirection: "贷", sortOrder: 720 },
  { category: "所有者权益类", name: "资本公积", balanceDirection: "贷", sortOrder: 730 },
  { category: "所有者权益类", name: "盈余公积", balanceDirection: "贷", sortOrder: 740 },
  { category: "所有者权益类", name: "本年利润", balanceDirection: "贷", sortOrder: 750 },
  { category: "所有者权益类", name: "利润分配", balanceDirection: "贷", sortOrder: 760 },
  { category: "损益类", name: "主营业务收入", balanceDirection: "借", sortOrder: 770 },
  { category: "损益类", name: "其他业务收入", balanceDirection: "借", sortOrder: 780 },
  { category: "损益类", name: "投资收益", balanceDirection: "借", sortOrder: 790 },
  { category: "损益类", name: "营业外收入", balanceDirection: "借", sortOrder: 800 },
  { category: "损益类", name: "主营业务成本", balanceDirection: "借", sortOrder: 810 },
  { category: "损益类", name: "其他业务成本", balanceDirection: "借", sortOrder: 820 },
  { category: "损益类", name: "营业税金及附加", balanceDirection: "借", sortOrder: 830 },
  { category: "损益类", name: "销售费用", balanceDirection: "借", sortOrder: 840 },
  { category: "损益类", name: "销售费 运费", balanceDirection: "借", sortOrder: 850 },
  { category: "损益类", name: "销售费 推广费", balanceDirection: "借", sortOrder: 860 },
  { category: "损益类", name: "销售费 港杂费", balanceDirection: "借", sortOrder: 870 },
  { category: "损益类", name: "销售费 手续费", balanceDirection: "借", sortOrder: 880 },
  { category: "损益类", name: "销售费 样品费", balanceDirection: "借", sortOrder: 890 },
  { category: "损益类", name: "销售费 测试费用", balanceDirection: "借", sortOrder: 900 },
  { category: "损益类", name: "销售费 招待费", balanceDirection: "借", sortOrder: 910 },
  { category: "损益类", name: "销售费 参展费", balanceDirection: "借", sortOrder: 920 },
  { category: "损益类", name: "销售费 打车费", balanceDirection: "借", sortOrder: 930 },
  { category: "损益类", name: "销售费 差旅费", balanceDirection: "借", sortOrder: 940 },
  { category: "损益类", name: "销售费 礼品费", balanceDirection: "借", sortOrder: 950 },
  { category: "损益类", name: "销售- 办产地证", balanceDirection: "借", sortOrder: 960 },
  { category: "损益类", name: "销售费 专利费", balanceDirection: "借", sortOrder: 970 },
  { category: "损益类", name: "销售费 快递费", balanceDirection: "借", sortOrder: 980 },
  { category: "损益类", name: "销售费 国际快递费", balanceDirection: "借", sortOrder: 990 },
  { category: "损益类", name: "销售-装柜费", balanceDirection: "借", sortOrder: 1000 },
  { category: "损益类", name: "销售 -业务提成", balanceDirection: "借", sortOrder: 1010 },
  { category: "损益类", name: "销售 潘通色卡", balanceDirection: "借", sortOrder: 1020 },
  { category: "损益类", name: "管理费用", balanceDirection: "借", sortOrder: 1030 },
  { category: "损益类", name: "其他管理费用", balanceDirection: "借", sortOrder: 1040 },
  { category: "损益类", name: "管理费 办公用品", balanceDirection: "借", sortOrder: 1050 },
  { category: "损益类", name: "管理费 差旅费", balanceDirection: "借", sortOrder: 1060 },
  { category: "损益类", name: "管理费 质量问题", balanceDirection: "借", sortOrder: 1070 },
  { category: "损益类", name: "管理费 福利费", balanceDirection: "借", sortOrder: 1080 },
  { category: "损益类", name: "管理费 福利员工餐费", balanceDirection: "借", sortOrder: 1090 },
  { category: "损益类", name: "管理费厂房装修费用", balanceDirection: "借", sortOrder: 1100 },
  { category: "损益类", name: "管理费 培训费", balanceDirection: "借", sortOrder: 1110 },
  { category: "损益类", name: "管理费 福利费-保险费", balanceDirection: "借", sortOrder: 1120 },
  { category: "损益类", name: "管理 验厂费", balanceDirection: "借", sortOrder: 1130 },
  { category: "损益类", name: "管理 差旅", balanceDirection: "借", sortOrder: 1140 },
  { category: "损益类", name: "管理 车维修费", balanceDirection: "借", sortOrder: 1150 },
  { category: "损益类", name: "管理 -财产保险", balanceDirection: "借", sortOrder: 1160 },
  { category: "损益类", name: "财务费用", balanceDirection: "借", sortOrder: 1170 },
  { category: "损益类", name: "外账财务费", balanceDirection: "借", sortOrder: 1180 },
  { category: "损益类", name: "银行手续费", balanceDirection: "借", sortOrder: 1190 },
  { category: "损益类", name: "营业外支出", balanceDirection: "借", sortOrder: 1200 },
  { category: "损益类", name: "所得税费用", balanceDirection: "借", sortOrder: 1210 },
];

/** 科目在代码里的稳定标识：`分类/名称`（老表没有唯一编码，两段拼起来才是唯一的）。 */
export function accountingSubjectKey(category: string, name: string): string {
  return `${category}/${name}`;
}

/* ------------------------------------------------------------------ 分类顺序 */

/** 不在 5 类之内的分类（迁移带出来的「未分类」、财务自建的分类）排在最后，彼此按名称排。 */
export const UNKNOWN_SUBJECT_CATEGORY_RANK = 1000;

/**
 * 分类的排序权重：**科目表里的 5 类按老表顺序**（资产类 → 负债类 → 成本类 → 所有者权益类 → 损益类），
 * 其它分类一律排在后面。
 *
 * 为什么需要一个「权重」而不是直接按分类名排：分类名是中文，按字典序排出来的顺序
 * （所有者权益类、损益类、成本类、资产类、负债类…）与财务那张表的顺序完全不同；
 * 报表与列表都要按科目表的顺序读，顺序错了财务每次都要重新找。
 */
export function subjectCategoryRank(category: string): number {
  const index = (ACCOUNTING_SUBJECT_CATEGORIES as readonly string[]).indexOf(category);
  return index >= 0 ? index : UNKNOWN_SUBJECT_CATEGORY_RANK;
}

/**
 * 会计科目的规范顺序：**先按分类（科目表顺序），再按 `sortOrder`，最后按名称**。
 *
 * 为什么必须有这么一个统一比较器，而不是各处 `orderBy` 一下：收支汇总表的「分类小计」是遍历时
 * 按「分类变化」插行的，前提就是**同一分类的科目必须连续**。数据库的 `orderBy: sortOrder` 满足不了
 * 这一点 —— 财务在「资产类」下新增一个科目时它的 `sortOrder` 是全局最大值，会排到损益类之后，
 * 于是「资产类小计」在同一币种段里出现两次（算术没错，但看着像重复计算）。
 *
 * 用它做唯一排序口径，列表页与报表就不会各排一套。
 */
export function compareAccountingSubjects(
  left: { category: string; sortOrder: number; name: string },
  right: { category: string; sortOrder: number; name: string },
): number {
  return (
    subjectCategoryRank(left.category) - subjectCategoryRank(right.category) ||
    left.sortOrder - right.sortOrder ||
    left.name.localeCompare(right.name)
  );
}

/* ------------------------------------------------------------------ 旧「收支项目」并入 */

/** 旧收支项目字典的类型 key（`dictionary_types.key`）。合并后整张字典停用，键本身只在迁移里用得到。 */
export const LEGACY_CASH_FLOW_ITEM_DICTIONARY_KEY = "cash_flow_item";

/**
 * 旧的 37 个收支项目 → 会计科目 的归属表。
 *
 * 用户 2026-09-17 选定「**彻底合并**：37 个旧项目并入 121 条科目，历史数据改指」，
 * 并要求「迁移前先出一份 37→121 对照表请你过目」。这份表就是那份对照表，
 * 逐条录入 `docs/design/accounting-subject-chart-2026-09-17.md` 与
 * `docs/memo/0917-收支项目并入会计科目对照表.md` 供财务核对。
 *
 * 为什么这张表必须和迁移 SQL 用同一份常量：37 条里有一对多（`制造费用-货拉拉` 与
 * `制造费用-物流` 都归到「货拉拉 物流费」）。SQL 里手抄一遍、常量里再抄一遍，
 * 迟早出现「迁移把两条流水指向了不同科目」这种只有财务对账时才会发现的偏差。
 * 迁移守卫测试逐条比对下面这张表与迁移 SQL 的映射块。
 *
 * `note` 只标**判断存疑**的条目（老名与科目名不是同义）。这些是按语义最近邻挑的默认值，
 * 财务在「会计科目」页上随时能改；同义直译的条目不写 note。
 */
export type LegacyCashFlowItemSubject = {
  /** 老 `dictionary_items.key`（= `收支汇总表.xls` 项目列原文）。 */
  legacyKey: string;
  /** 归属的科目类别。 */
  category: string;
  /** 归属的科目名称（必须能在 ACCOUNTING_SUBJECTS 里按 (category, name) 命中）。 */
  name: string;
  /** 判断存疑时的说明。 */
  note?: string;
};

export const LEGACY_CASH_FLOW_ITEM_SUBJECTS: readonly LegacyCashFlowItemSubject[] = [
  { legacyKey: "备用金", category: "资产类", name: "库存现金（备用金）" },
  { legacyKey: "货款", category: "损益类", name: "主营业务收入" },
  { legacyKey: "美金转入", category: "资产类", name: "银行存款 中国银行（美元）" },
  { legacyKey: "原材料 成本", category: "损益类", name: "主营业务成本", note: "材料成本按损益口径归主营业务成本，而非资产类「原材料」" },
  { legacyKey: "外加工费 晋江大田工资", category: "成本类", name: "临时工资", note: "老名含「工资」，归成本类「临时工资」" },
  { legacyKey: "成品外加工费", category: "成本类", name: "加工费" },
  { legacyKey: "房租支出", category: "成本类", name: "房租费", note: "老表同时有成本类「房租费」与损益类「管理费用」，按成本类归" },
  { legacyKey: "会展费用", category: "损益类", name: "销售费 参展费" },
  { legacyKey: "销售费用", category: "损益类", name: "销售费用" },
  { legacyKey: "货代费", category: "损益类", name: "销售费 港杂费", note: "货代费按销售港杂费归；若实际走物流费应改「货拉拉 物流费」" },
  { legacyKey: "水电费", category: "成本类", name: "水电费", note: "科目表损益类没有水电费，只有成本类同名科目" },
  { legacyKey: "国际快递费", category: "损益类", name: "销售费 国际快递费" },
  { legacyKey: "机器折旧费用", category: "资产类", name: "累计折旧", note: "科目表唯一与折旧相关的科目；它是资产类贷方科目，不是费用科目" },
  { legacyKey: "辅料费", category: "成本类", name: "生产用品", note: "科目表没有「辅料费」，按车间耗用归「生产用品」" },
  { legacyKey: "制造费用-货拉拉", category: "成本类", name: "货拉拉 物流费" },
  { legacyKey: "制造费用-物流", category: "成本类", name: "货拉拉 物流费", note: "与「制造费用-货拉拉」合并到同一科目" },
  { legacyKey: "销售费用-货拉拉", category: "损益类", name: "销售费 运费", note: "销售侧运费归「销售费 运费」" },
  { legacyKey: "生产用品、工具费用", category: "成本类", name: "生产用品" },
  { legacyKey: "管理费用", category: "损益类", name: "管理费用" },
  { legacyKey: "销售样品费", category: "损益类", name: "销售费 样品费" },
  { legacyKey: "销售知识产权费用", category: "损益类", name: "销售费 专利费" },
  { legacyKey: "顺丰快递费", category: "成本类", name: "顺丰快递", note: "科目表损益类没有顺丰快递费，只有成本类同名科目" },
  { legacyKey: "办公费用", category: "损益类", name: "管理费 办公用品" },
  { legacyKey: "差旅费", category: "损益类", name: "管理费 差旅费", note: "老项目不分销售/管理；默认归管理费，销售差旅应改「销售费 差旅费」" },
  { legacyKey: "验厂费", category: "损益类", name: "管理 验厂费" },
  { legacyKey: "杂费车间装修费", category: "损益类", name: "管理费厂房装修费用" },
  { legacyKey: "财务费用-手续费", category: "损益类", name: "银行手续费" },
  { legacyKey: "财务费用-外账", category: "损益类", name: "外账财务费" },
  { legacyKey: "银行费用利息", category: "损益类", name: "银行手续费", note: "与「财务费用-手续费」合并；若利息单独核算应改回「财务费用」" },
  { legacyKey: "电商费用", category: "损益类", name: "销售费 推广费", note: "科目表没有电商费，按线上推广归" },
  { legacyKey: "机械维修费", category: "成本类", name: "机台维修费" },
  { legacyKey: "员工福利费", category: "损益类", name: "管理费 福利费" },
  { legacyKey: "员工餐费", category: "损益类", name: "管理费 福利员工餐费" },
  { legacyKey: "国家退税", category: "损益类", name: "营业外收入", note: "退税按营业外收入归；若走「应交税费-进项税」需财务改" },
  { legacyKey: "人 工费", category: "成本类", name: "基本生产成本", note: "车间人工归「基本生产成本」；若是临时工应改「临时工资」" },
  { legacyKey: "加工费", category: "成本类", name: "加工费" },
  { legacyKey: "中国银行 美元", category: "资产类", name: "银行存款 中国银行（美元）", note: "老表把银行账户当项目列，实为银行存款明细科目" },
];

/** 按旧 key 取归属科目；查不到返回 undefined（迁移里出现查不到的 key 视为数据异常）。 */
export function legacySubjectOf(legacyKey: string): LegacyCashFlowItemSubject | undefined {
  return LEGACY_CASH_FLOW_ITEM_SUBJECTS.find((item) => item.legacyKey === legacyKey);
}

/* ------------------------------------------------------------------ 自动写入流水时的科目候选 */

/**
 * 自动写入收支流水时，按业务来源选定会计科目（**按优先级排列的名称候选**）。
 *
 * 与旧实现的区别只有一处：候选值从「收支项目字典的 key」换成了「会计科目的名称」——
 * 科目是管理员可改的，业务口径又会随来源变化（原料采购 vs 外加工 vs 其他应付），
 * 所以给一条链而不是单个名字。候选一个都不存在时**显式 422**，绝不静默跳过：
 * 静默跳过会让整笔资金动账从收支流水里消失（历史缺陷就是供应商付款写死了一个字典里不存在的
 * key，于是每一笔供应商付款都被悄悄丢掉）。
 *
 * 名称在种入的科目表里是唯一的（`apps/api/test/unit/accounting-subject-catalog.test.cjs` 守着这一点），
 * 万一将来出现重名，取值时按 `sortOrder` 取第一个，结果仍然是确定的。
 */
export const PAYMENT_SUBJECT_NAMES = {
  /** 收到客户货款（收）。 */
  customer_payment: ["主营业务收入"],
  /** 工资付款（支）。 */
  salary_payment: ["临时工资", "基本生产成本"],
  /** 原料入库形成的应付付款（支）。 */
  raw_material_inbound: ["主营业务成本", "原材料"],
  /** 到货单来源（已禁用，仅兼容历史数据）。 */
  purchase_receipt: ["主营业务成本", "原材料"],
  /** 外加工签收形成的应付付款（支）。 */
  outsource_receipt: ["加工费"],
  /** 其他应付（支）。 */
  other: ["管理费用", "其他管理费用"],
} as const;

/** 一次付款核销了多种来源时的兜底候选（最常见的是采购付款）。 */
export const DEFAULT_PAYMENT_SUBJECT_NAMES: readonly string[] = ["主营业务成本", "原材料"];

/** 「确认应收」自动写入流水时的科目候选（收）：出库形成的应收绝大多数就是主营收入。 */
export const RECEIVABLE_CONFIRM_SUBJECT_NAMES: readonly string[] = ["主营业务收入", "营业外收入"];

/** 「确认应付」在来源类型都识别不出时的兜底候选（支）。 */
export const PAYABLE_CONFIRM_SUBJECT_NAMES: readonly string[] = ["主营业务成本", "原材料"];

/** 来源类型 → 科目候选；未知来源用兜底链。 */
export function paymentSubjectNames(sourceType: string): readonly string[] {
  return (PAYMENT_SUBJECT_NAMES as Record<string, readonly string[]>)[sourceType] ?? DEFAULT_PAYMENT_SUBJECT_NAMES;
}
