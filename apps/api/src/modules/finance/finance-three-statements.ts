/**
 * 财务三大报表的**口径内核**（纯函数，不碰数据库、不碰 Excel）。
 *
 * 需求来源：财务 2026-09-24 交付 `example/财务/财务三大报表（标准格式）(2).xlsx`
 * （财政部一般企业财务报表格式 2019：资产负债表 A1:H41 / 利润表 A1:D27 / 现金流量表 A1:D41）。
 * 方案、缺口与待定口径见 `docs/design/finance-three-statements-2026-09-24.md`。
 *
 * 这个模块只回答三个问题（取数、页面、导出各归各的层）：
 *   1. **科目 → 报表行**：模板上每一行收哪些科目（`BALANCE_SHEET_ASSETS` 等行定义）；
 *   2. **金额怎么算**：余额类（资产负债表）与发生额类（利润表 / 现金流量表）的聚合，
 *      以及模板里那些公式行（合计 / 小计 / 营业利润 / 净额）逐行照抄；
 *   3. **哪里没算到**：科目没归位、凭证不是现金类、一张凭证里两边都是资金科目……
 *      全部作为**返回值**报出来，让上层写进表尾 —— 报表最危险的失败方式不是算错，
 *      而是**少算了却看不出来**（与报表导出「缺采购价物料必须显式列出」同一条纪律）。
 *
 * ## 四条刻意的口径
 *
 * 1. **金额一律是「整数 1e-4」的 BigInt**（`money.ts`）：勾稽核对要逐位比对，差一分就是「✗ 不平衡」。
 * 2. **不跨币种相加**（全站口径）：本模块一次只处理一种币种，调用方按币种调用（折算口径见设计文档 §8.2）。
 * 3. **每一行有正常余额方向**（`side`）：资产/成本/费用在借方，负债/权益/收入在贷方。
 *    累计折旧、累计摊销这类备抵科目**不需要单独处理** —— 它们按「借 − 贷」算出来天然是负数，
 *    与主科目相加就是净额（写成「减：累计折旧」反而会在财务按准则记账时把数加成正的）。
 * 4. **成本类科目分两拨**：在制品性质的进「存货」，当期费用性质的进「营业成本」。
 *    这条划分直接决定「存货」与「营业成本」两行的数字，是**待财务确认**的口径（设计文档 §8.1），
 *    所以放在两个显式常量里 —— 改口径就是搬一个名字，不用改代码。
 *
 * ## 行次的陷阱（第一版写错过一次，测试钉住了）
 *
 * 模板里「行次」（B 列）与「Excel 行号」**不是一回事**：资产侧第 1 行次是 C5 的货币资金，
 * 而「流动资产合计」（行次 14）的公式是 `SUM(C5:C17)` = **行次 1..13**。
 * 公式按行次写，否则合计会漏掉前四项而勾稽照样平。
 */

import { ACCOUNTING_SUBJECT_SEEDS, accountingSubjectKey } from "./accounting-subject-catalog";
import {
  type ScopeClaimSource,
  type StatementFlow,
  type StatementRowIndex,
  type StatementScope,
  initialStatementRowClaims,
  mappedRowOf,
} from "./finance-statement-rows";
import { formatUnits, toUnits } from "./money";
import { FUND_SUBJECT_CASH } from "./voucher.domain";

/**
 * 金额（整数 1e-4）→ 十进制字符串；`null` 原样返回（段落行与手填行）。
 *
 * 放在内核里而不是让每个上层各写一遍：预览、导出、勾稽核对三处都要把同一个 BigInt 变成字符串，
 * 格式化口径分叉就会出现「页面上 0.3、导出里 0.30000000000000004」。
 */
export function formatStatementValue(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : formatUnits(value);
}

/* --------------------------------------------------------------------------- 科目与匹配 */

/** 科目键：`分类/名称`（`accounting-subject-catalog.ts` 的唯一标识口径）。 */
export function splitSubjectKey(subjectKey: string): { category: string; name: string } {
  const at = subjectKey.indexOf("/");
  return at < 0 ? { category: "", name: subjectKey } : { category: subjectKey.slice(0, at), name: subjectKey.slice(at + 1) };
}

/**
 * 资金类科目的**裸名**：`voucher.domain.ts` 的 `FUND_SUBJECT_BANK / FUND_SUBJECT_CASH`。
 *
 * 为什么需要归一化：凭证里资金分录的 `subject_key` 是**裸名**（`银行存款` / `库存现金`），
 * 而业务分录的 `subject_key` 是 `分类/名称`（见 `voucher.service.ts` 的 `draftForEntry`）。
 * 两套写法并存是既成事实，报表必须两种都认 —— 只认一种的结果是「货币资金」整行为空，
 * 而这种错误在页面上看起来像「系统里没有银行流水」。
 */
export const FUND_SUBJECT_NAMES = ["银行存款", "库存现金"] as const;

export function isFundSubject(subjectKey: string, refs?: SubjectRefs): boolean {
  // id 键（R3-2）必须靠 refs 解析出分类/名称；label 键直接拆（资金分录历史上是裸名，先归一）。
  const ref = subjectRefOfKey(normalizeSubjectKey(subjectKey), refs);
  if (!ref) return false;
  const { category, name } = ref;
  if (category !== "资产类" && category !== "") return false;
  // 「库存现金（备用金）」这类**现金明细**也是钱本身（2026-10-16 补）：财务口径里「备用金付款」
  // 就是「从银行取现到备用金」，凭证是「借 库存现金（备用金）/贷 银行存款」——两边都是资金科目，
  // 属于内部划转，不能进现金流量表。认不出来时那张凭证会被算成非资金凭证，这笔提现凭空消失。
  //
  // 为什么只对「库存现金」用前缀、**不对「银行存款」用**：历史数据把银行账户名当业务科目用
  // （`美金转入` → `银行存款 中国银行（美元）`，凭证是「借 银行存款 中国银行（美元）/贷 银行存款」），
  // 前缀匹配银行存款会把客户汇进来的货款判成内部划转、整笔从现金流量表里消失。
  // 「库存现金（备用金）」没有这个问题：它作为业务科目出现时（取现、备用金报销）都是钱本身在动。
  return (FUND_SUBJECT_NAMES as readonly string[]).includes(name) || name.startsWith(FUND_SUBJECT_CASH);
}

/** 凭证上的科目键 → 科目表里的规范键（裸名的资金科目补上「资产类/」）。 */
export function normalizeSubjectKey(subjectKey: string): string {
  const { category, name } = splitSubjectKey(subjectKey);
  if (category === "" && (FUND_SUBJECT_NAMES as readonly string[]).includes(name)) return accountingSubjectKey("资产类", name);
  return subjectKey;
}

/* --------------------------------------------------------------------------- 科目 id 归集（2026-11-09 R3-2） */

/**
 * 归集键的 id 前缀：`@id:<uuid>`。分类名是中文、不会以 `@` 开头，所以与「分类/名称」键永不碰撞。
 *
 * 为什么要两套键而不是统一成 id：迁移只对**唯一同名**的历史行回填了 `subject_id`，未命中/歧义行
 * 仍是空（见迁移 `20261109130000_finance_governance_r3`）。因此报表必须两种都能收：
 *   - 有 `subject_id` → 按 id 归集（改名/换分类不影响金额落行，这是 R3-2 的目的）；
 *   - `subject_id` 为空（历史行）→ 回退按 `subject_label`（`subjectKey`）文本匹配。
 * 一条分录只会算出**一个**键，所以不存在「同一行既按 id 又按 label 被计两次」。
 */
export const SUBJECT_ID_KEY_PREFIX = "@id:";

/** 科目键 → 分类/名称（id 键靠 `SubjectRefs` 解析；label 键直接拆）。 */
export type SubjectRef = { category: string; name: string };
/** 报表取数时由上层查库得到的「归集键 → 分类/名称」索引（只装 id 键与需要兜底的 label 键）。 */
export type SubjectRefs = ReadonlyMap<string, SubjectRef>;

/** 科目 id → 归集键。 */
export function subjectIdKeyOf(subjectId: string): string {
  return `${SUBJECT_ID_KEY_PREFIX}${subjectId}`;
}

/** 归集键是不是 id 键（id 键无法靠字符串拆出分类/名称）。 */
export function isSubjectIdKey(subjectKey: string): boolean {
  return subjectKey.startsWith(SUBJECT_ID_KEY_PREFIX);
}

/**
 * 一条分录 → 归集键：**`subject_id` 优先，空才回退 label**。
 *
 * 调用方负责保证「传进来的 subjectId 一定能被 `SubjectRefs` 解析」—— 解析不到时（科目被硬删等）
 * 由上层把 subjectId 置空走 label 兜底，内核不做猜测（猜错会把金额落到别的行）。
 */
export function subjectKeyOfLine(line: { subjectKey: string; subjectId?: string | null }): string {
  const subjectId = line.subjectId?.trim();
  return subjectId ? subjectIdKeyOf(subjectId) : normalizeSubjectKey(line.subjectKey);
}

/** 归集键 → (分类,名称)；id 键在索引里找不到时返回 null（宁可不归行，也不猜一个科目）。 */
export function subjectRefOfKey(subjectKey: string, refs?: SubjectRefs): SubjectRef | null {
  const known = refs?.get(subjectKey);
  if (known) return known;
  if (isSubjectIdKey(subjectKey)) return null;
  return splitSubjectKey(subjectKey);
}

/** 归集键的展示文案：能解析就写成「分类/名称」，解析不到（缺索引的 id 键）就原样返回。 */
export function subjectLabelOfKey(subjectKey: string, refs?: SubjectRefs): string {
  const ref = subjectRefOfKey(subjectKey, refs);
  return ref ? accountingSubjectKey(ref.category, ref.name) : subjectKey;
}

/** 科目匹配器：报表行的 `match` 用它声明「这一行收哪些科目」。 */
export type SubjectMatch = (category: string, name: string) => boolean;

/** 名字是这几个之一。 */
const named = (...names: string[]) => (_c: string, n: string) => names.includes(n);
/** 名字以这些前缀开头（财务的明细科目就是靠前缀分层：`销售费 运费` / `应交税费-进项税`）。 */
const prefixed = (...prefixes: string[]) => (_c: string, n: string) => prefixes.some((prefix) => n.startsWith(prefix));
const anyOf = (...tests: SubjectMatch[]): SubjectMatch => (c, n) => tests.some((test) => test(c, n));
/** 某个分类下 + 若干条件。 */
const only = (category: string, ...tests: SubjectMatch[]): SubjectMatch => (c, n) => c === category && anyOf(...tests)(c, n);

/* --------------------------------------------------------------------------- 成本类两拨（待确认） */

/**
 * 在制品性质的成本类科目 → 期末余额进**存货**（准则：生产成本 / 制造费用期末是在产品）。
 * 2026-09-24 待财务确认（设计文档 §8.1）。
 */
export const INVENTORY_COST_SUBJECT_NAMES: readonly string[] = [
  "生产成本", "基本生产成本", "辅助生产成本", "制造费用", "劳务成本", "机械作业", "工程施工",
];

/**
 * 当期费用性质的成本类科目 → **营业成本**（财务的用法就是「这笔钱这个月付出去了」）。
 * 与上面那拨互补，两拨合起来必须覆盖全部成本类科目（守卫测试逐条钉）。
 */
export const PERIOD_COST_SUBJECT_NAMES: readonly string[] = [
  "临时工资", "加工费", "水电费", "房租费", "生产用品", "机台维修费", "顺丰快递",
  "货拉拉 物流费", "印刷费", "研发支出", "工资支付",
];

/** 存货性质的资产类科目名（与成本类那拨一起进「存货」行）。 */
const INVENTORY_ASSET_SUBJECT_NAMES: readonly string[] = [
  "材料采购", "在途物资", "原材料", "材料成本差异", "库存商品", "发出商品", "商品进销差价",
  "委托加工物资", "半成品", "周转材料", "消耗性生物资产",
];

/* --------------------------------------------------------------------------- 行定义 */

/**
 * 一行报表。
 *
 * - `row`：模板**行次**（不是 Excel 行号，见文件头）。
 * - `side`：这一行的正常余额方向（默认借方）。收入/负债/权益行必须显式写 `credit`。
 * - `sumOf` / `minusRows`：模板里的公式（按**行次**引用同一侧的其它行）。
 * - `flow`：现金流量表专用，这一行收的是流入还是流出（见字段注释）。
 * - `manual`：系统给不出这一格（导出留空手填，如每股收益需要股数）。
 * - `note`：口径或缺口说明，会集中进表尾（`statementNotes`）。
 */
export type StatementRow = {
  row: number | null;
  label: string;
  section?: boolean;
  match?: SubjectMatch;
  side?: "debit" | "credit";
  /**
   * 现金流量表专用：这一行收的是**流入**还是**流出**。
   *
   * 为什么必须有它：同一个科目会同时出现在流入与流出两组的候选里（借了短期借款是「取得借款收到的现金」，
   * 还它是「偿还债务支付的现金」，科目都是「短期借款」）。只看科目不看方向，还款会被算成借款 ——
   * 金额方向全反，而小计、净额、期末余额一路跟着错，勾稽却照样平。
   */
  flow?: "in" | "out";
  sumOf?: readonly number[];
  minusRows?: readonly number[];
  manual?: boolean;
  note?: string;
};

/** 资产负债表 · 资产侧（模板行次 1–34；公式与模板 C 列逐行对齐）。 */
export const BALANCE_SHEET_ASSETS: readonly StatementRow[] = [
  { row: null, label: "流动资产：", section: true },
  { row: 1, label: "货币资金", match: only("资产类", prefixed("银行存款"), prefixed("库存现金"), named("其他货币资金")) },
  { row: 2, label: "交易性金融资产", match: only("资产类", named("短期投资")) },
  { row: 3, label: "衍生金融资产", note: "本系统无对应科目" },
  { row: 4, label: "应收票据", match: only("资产类", named("应收票据")) },
  { row: 5, label: "应收账款", match: only("资产类", named("应收账款")) },
  { row: 6, label: "应收款项融资", note: "本系统无对应科目" },
  { row: 7, label: "预付款项", match: only("资产类", named("预付账款")) },
  { row: 8, label: "其他应收款", match: only("资产类", named("应收股利", "应收利息", "其他应收款")) },
  {
    row: 9, label: "存货",
    match: anyOf(only("资产类", named(...INVENTORY_ASSET_SUBJECT_NAMES)), only("成本类", named(...INVENTORY_COST_SUBJECT_NAMES))),
    note: "含成本类里在制品性质的科目（口径见设计文档 §8.1）",
  },
  { row: 10, label: "合同资产", note: "本系统无对应科目" },
  { row: 11, label: "持有待售资产", note: "本系统无对应科目" },
  { row: 12, label: "一年内到期的非流动资产", note: "本系统无对应科目" },
  { row: 13, label: "其他流动资产", note: "本系统无对应科目" },
  { row: 14, label: "流动资产合计", sumOf: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] },
  { row: null, label: "非流动资产：", section: true },
  { row: 15, label: "债权投资", match: only("资产类", named("长期债券投资")) },
  { row: 16, label: "其他债权投资", note: "本系统无对应科目" },
  { row: 17, label: "长期应收款", note: "本系统无对应科目" },
  { row: 18, label: "长期股权投资", match: only("资产类", named("长期股权投资")) },
  { row: 19, label: "其他权益工具投资", note: "本系统无对应科目" },
  { row: 20, label: "其他非流动金融资产", note: "本系统无对应科目" },
  { row: 21, label: "投资性房地产", note: "本系统无对应科目" },
  // 备抵科目并入主科目行：按「借 − 贷」算出来天然是负的，相加即净额。
  { row: 22, label: "固定资产", match: only("资产类", named("固定资产", "累计折旧")) },
  { row: 23, label: "在建工程", match: only("资产类", named("在建工程", "工程物资")) },
  { row: 24, label: "生产性生物资产", match: only("资产类", named("生产性生物资产", "生产性生物资产累计折旧")) },
  { row: 25, label: "油气资产", note: "本系统无对应科目" },
  { row: 26, label: "使用权资产", note: "本系统无对应科目" },
  { row: 27, label: "无形资产", match: only("资产类", named("无形资产", "累计摊销")) },
  { row: 28, label: "开发支出", note: "本系统把「研发支出」按当期费用进利润表（口径见设计文档 §8.1）" },
  { row: 29, label: "商誉", note: "本系统无对应科目" },
  { row: 30, label: "长期待摊费用", match: only("资产类", named("长期待摊费用")) },
  { row: 31, label: "递延所得税资产", note: "本系统无对应科目" },
  { row: 32, label: "其他非流动资产", match: only("资产类", named("固定资产清理", "待处理财产损益")) },
  { row: 33, label: "非流动资产合计", sumOf: [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32] },
  { row: 34, label: "资产总计", sumOf: [14, 33] },
];

/** 资产负债表 · 负债和所有者权益侧（模板行次 1–34；「未分配利润」的值由 `buildBalanceSheet` 算）。 */
export const BALANCE_SHEET_EQUITIES: readonly StatementRow[] = [
  { row: null, label: "流动负债：", section: true },
  { row: 1, label: "短期借款", match: only("负债类", named("短期借款")), side: "credit" },
  { row: 2, label: "交易性金融负债", note: "本系统无对应科目" },
  { row: 3, label: "衍生金融负债", note: "本系统无对应科目" },
  { row: 4, label: "应付票据", match: only("负债类", named("应付票据")), side: "credit" },
  { row: 5, label: "应付账款", match: only("负债类", named("应付账款")), side: "credit" },
  { row: 6, label: "预收款项", match: only("负债类", named("预收账款")), side: "credit" },
  { row: 7, label: "合同负债", note: "本系统无对应科目" },
  { row: 8, label: "应付职工薪酬", match: only("负债类", named("应付职工薪酬")), side: "credit" },
  { row: 9, label: "应交税费", match: only("负债类", prefixed("应交税费")), side: "credit" },
  { row: 10, label: "其他应付款", match: only("负债类", named("其他应付款", "应付利息", "应付利润")), side: "credit" },
  { row: 11, label: "持有待售负债", note: "本系统无对应科目" },
  { row: 12, label: "一年内到期的非流动负债", note: "本系统无对应科目" },
  { row: 13, label: "其他流动负债", note: "本系统无对应科目" },
  { row: 14, label: "流动负债合计", sumOf: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] },
  { row: null, label: "非流动负债：", section: true },
  { row: 15, label: "长期借款", match: only("负债类", named("长期借款")), side: "credit" },
  { row: 16, label: "应付债券", note: "本系统无对应科目" },
  { row: 17, label: "租赁负债", note: "本系统无对应科目" },
  { row: 18, label: "长期应付款", match: only("负债类", named("长期应付款")), side: "credit" },
  { row: 19, label: "预计负债", note: "本系统无对应科目" },
  { row: 20, label: "递延收益", match: only("负债类", named("递延收益")), side: "credit" },
  { row: 21, label: "递延所得税负债", note: "本系统无对应科目" },
  { row: 22, label: "其他非流动负债", note: "本系统无对应科目" },
  { row: 23, label: "非流动负债合计", sumOf: [15, 16, 17, 18, 19, 20, 21, 22] },
  { row: 24, label: "负债合计", sumOf: [14, 23] },
  { row: null, label: "所有者权益（或股东权益）：", section: true },
  { row: 25, label: "实收资本（或股本）", match: only("所有者权益类", named("实收资本")), side: "credit" },
  { row: 26, label: "其他权益工具", note: "本系统无对应科目" },
  { row: 27, label: "资本公积", match: only("所有者权益类", named("资本公积")), side: "credit" },
  { row: 28, label: "减：库存股", note: "本系统无对应科目" },
  { row: 29, label: "其他综合收益", note: "本系统无对应科目" },
  { row: 30, label: "专项储备", note: "本系统无对应科目" },
  { row: 31, label: "盈余公积", match: only("所有者权益类", named("盈余公积")), side: "credit" },
  {
    row: 32, label: "未分配利润",
    match: only("所有者权益类", named("本年利润", "利润分配")), side: "credit",
    note: "= 利润分配 + 本年利润 + 未结转的损益（收入 − 支出；系统没有结转损益凭证，见设计文档 §4）",
  },
  // 模板 G39 = G31+G32+G33-G34+G35+G36+G37+G38（本系统第 28 行「库存股」没有科目，恒为 0）
  { row: 33, label: "所有者权益（或股东权益）合计", sumOf: [25, 26, 27, 29, 30, 31, 32], minusRows: [28] },
  { row: 34, label: "负债和所有者权益总计", sumOf: [24, 33] },
];

/** 利润表（模板行次 1–23；「减：」开头的行在模板里也用正数填列，靠公式减）。 */
export const INCOME_STATEMENT: readonly StatementRow[] = [
  { row: 1, label: "一、营业收入", match: only("损益类", named("主营业务收入", "其他业务收入")), side: "credit" },
  {
    row: 2, label: "减：营业成本",
    match: anyOf(only("损益类", named("主营业务成本", "其他业务成本")), only("成本类", named(...PERIOD_COST_SUBJECT_NAMES))),
    note: "含当期费用性质的成本类科目（口径见设计文档 §8.1）",
  },
  { row: 3, label: "减：税金及附加", match: only("损益类", named("营业税金及附加")) },
  { row: 4, label: "减：销售费用", match: only("损益类", prefixed("销售")) },
  { row: 5, label: "减：管理费用", match: only("损益类", prefixed("管理"), named("其他管理费用")) },
  // 「研发支出」已经并入营业成本（见成本类两拨），所以这里不再认领它 —— 同一科目被两行认领会抛错。
  { row: 6, label: "减：研发费用", note: "本系统把「研发支出」按当期费用并入营业成本（口径见设计文档 §8.1）" },
  { row: 7, label: "减：财务费用", match: only("损益类", named("财务费用", "外账财务费", "银行手续费")) },
  { row: 8, label: "加：其他收益", note: "本系统无对应科目" },
  { row: 9, label: "加：投资收益（损失以“-”号填列）", match: only("损益类", named("投资收益")), side: "credit" },
  { row: 10, label: "加：公允价值变动收益（损失以“-”号填列）", note: "本系统无对应科目" },
  { row: 11, label: "减：信用减值损失（损失以“-”号填列）", note: "本系统无对应科目" },
  { row: 12, label: "减：资产减值损失（损失以“-”号填列）", note: "本系统无对应科目" },
  { row: 13, label: "加：资产处置收益（损失以“-”号填列）", note: "本系统无对应科目" },
  // 模板 C17 = C4-C5-C6-C7-C8-C9-C10+C11+C12+C13-C14-C15+C16（对应行次 1..13）
  { row: 14, label: "二、营业利润（亏损以“-”号填列）", sumOf: [1, 8, 9, 10, 13], minusRows: [2, 3, 4, 5, 6, 7, 11, 12] },
  { row: 15, label: "加：营业外收入", match: only("损益类", named("营业外收入")), side: "credit" },
  { row: 16, label: "减：营业外支出", match: only("损益类", named("营业外支出")) },
  { row: 17, label: "三、利润总额（亏损总额以“-”号填列）", sumOf: [14, 15], minusRows: [16] },
  { row: 18, label: "减：所得税费用", match: only("损益类", named("所得税费用")) },
  { row: 19, label: "四、净利润（净亏损以“-”号填列）", sumOf: [17], minusRows: [18] },
  { row: 20, label: "五、其他综合收益的税后净额", note: "本系统无对应科目（本期恒为 0）" },
  { row: 21, label: "六、综合收益总额", sumOf: [19, 20] },
  { row: null, label: "七、每股收益：", section: true },
  { row: 22, label: "（一）基本每股收益", manual: true, note: "需要加权平均普通股股数，系统无此数据" },
  { row: 23, label: "（二）稀释每股收益", manual: true, note: "需要加权平均普通股股数，系统无此数据" },
];

/**
 * 现金流量表（模板行次 1–35）。
 *
 * 落行规则：按**同一张凭证里业务分录的科目**决定这笔现金进出算哪一行 ——
 * 凭证的「对方科目」已经说明了这笔钱为什么动（收主营业务收入 / 付原材料 / 付工资），
 * 再维护一张「现金流量项目」映射表等于把同一件事说两遍，两套说法迟早不一致。
 *
 * 两处刻意的归属（此前容易做错的）：
 *   - **销项税跟着货款走**：销售收款时一起收的销项税算「销售商品收到的现金」，
 *     不算「收到的税费返还」；同理进项税算「购买商品支付的现金」。税费返还 / 支付的各项税费
 *     只装真正的税费结算（应交税费本体 + 税金及附加 + 所得税）。
 *   - **应收/应付账款也要认得**：现在的「确认即收付」不会产生它们，但一旦财务补上权责发生制分录
 *     （设计文档 §3 二期），收回应收账款 / 支付应付账款就是最常见的经营现金流，
 *     认不出来会让「销售商品收到的现金」凭空少一大块。
 */
export const CASH_FLOW_STATEMENT: readonly StatementRow[] = [
  { row: null, label: "一、经营活动产生的现金流量：", section: true },
  {
    row: 1, label: "销售商品、提供劳务收到的现金", flow: "in",
    match: anyOf(
      only("损益类", named("主营业务收入", "其他业务收入")),
      only("资产类", named("应收票据", "应收账款")),
      only("负债类", named("预收账款", "应交税费-销项税")),
    ),
  },
  { row: 2, label: "收到的税费返还", flow: "in", match: anyOf(only("负债类", named("应交税费")), only("损益类", named("营业外收入"))), note: "退税口径待财务确认（设计文档 §8.3）" },
  {
    row: 3, label: "收到其他与经营活动有关的现金", flow: "in",
    match: anyOf(
      only("资产类", named("应收股利", "应收利息", "其他应收款")),
      only("负债类", named("其他应付款", "应付利息", "应付利润")),
    ),
  },
  { row: 4, label: "经营活动现金流入小计", sumOf: [1, 2, 3] },
  {
    row: 5, label: "购买商品、接受劳务支付的现金", flow: "out",
    match: anyOf(
      // 存货类与预付账款是资产类；**应付账款/应付票据是负债类**（权责发生制下销账分录的对方科目）。
      // 以前把这三个名字一起写在「资产类」分支里，负债类的应付账款一条都匹配不上：已挂账的付款
      // 会整笔落进 `unmapped`（现金流量表里钱凭空消失、期末现金与资产负债表对不上）。
      // 2026-11-04 排查这笔「销售费推广费被显示成应付账款」时一并修正。
      only("资产类", named(...INVENTORY_ASSET_SUBJECT_NAMES, "预付账款")),
      only("负债类", named("应付账款", "应付票据")),
      only("损益类", named("主营业务成本", "其他业务成本")),
      only("成本类", named("加工费", "货拉拉 物流费", "顺丰快递")),
      only("负债类", named("应交税费-进项税", "应交税费-进项税--祥恩线业")),
    ),
  },
  {
    row: 6, label: "支付给职工以及为职工支付的现金", flow: "out",
    match: anyOf(
      only("负债类", named("应付职工薪酬")),
      // 生产人工性质的科目归这一行。「生产成本 / 辅助生产成本 / 劳务成本」与已在表里的
      // 「基本生产成本」同族（都是生产环节的人工与劳务），所以并到一起 —— 不新开行。
      // 2026-11-11 R-3/T7：这三条原来一条都不在表里，每一笔都整笔落进 unmapped。
      only("成本类", named("工资支付", "临时工资", "基本生产成本", "生产成本", "辅助生产成本", "劳务成本")),
    ),
  },
  {
    row: 7, label: "支付的各项税费", flow: "out",
    match: anyOf(only("负债类", named("应交税费")), only("损益类", named("营业税金及附加", "所得税费用"))),
  },
  {
    row: 8, label: "支付其他与经营活动有关的现金", flow: "out",
    match: anyOf(
      only("损益类", prefixed("销售"), prefixed("管理"), named("其他管理费用", "财务费用", "外账财务费", "银行手续费", "营业外支出")),
      // 车间间接费用归这一行，与已在表里的水电费/机台维修费同族。
      // 2026-11-11 R-3/T7：制造费用/工程施工/机械作业原来一条都不在表里 ——
      // 「制造费用」是最典型的经营现金流出，落空的后果是钱在现金流量表里凭空少一块。
      only("成本类", named("水电费", "房租费", "生产用品", "机台维修费", "印刷费", "研发支出", "制造费用", "工程施工", "机械作业")),
    ),
  },
  { row: 9, label: "经营活动现金流出小计", sumOf: [5, 6, 7, 8] },
  { row: 10, label: "经营活动产生的现金流量净额", sumOf: [4], minusRows: [9] },
  { row: null, label: "二、投资活动产生的现金流量：", section: true },
  { row: 11, label: "收回投资收到的现金", flow: "in", note: "本系统无对应科目（长期资产不产生凭证，见设计文档 §2）" },
  { row: 12, label: "取得投资收益收到的现金", flow: "in", match: only("损益类", named("投资收益")) },
  { row: 13, label: "处置固定资产、无形资产和其他长期资产收回的现金净额", flow: "in", match: only("资产类", named("固定资产清理")) },
  { row: 14, label: "处置子公司及其他营业单位收到的现金净额", flow: "in", note: "本系统无对应科目" },
  { row: 15, label: "收到其他与投资活动有关的现金", flow: "in", note: "本系统无对应科目" },
  { row: 16, label: "投资活动现金流入小计", sumOf: [11, 12, 13, 14, 15] },
  { row: 17, label: "购建固定资产、无形资产和其他长期资产支付的现金", flow: "out", match: only("资产类", named("固定资产", "累计折旧", "在建工程", "工程物资", "无形资产", "累计摊销", "长期待摊费用")) },
  { row: 18, label: "投资支付的现金", flow: "out", match: only("资产类", named("短期投资", "长期股权投资", "长期债券投资")) },
  { row: 19, label: "取得子公司及其他营业单位支付的现金净额", flow: "out", note: "本系统无对应科目" },
  { row: 20, label: "支付其他与投资活动有关的现金", flow: "out", note: "本系统无对应科目" },
  { row: 21, label: "投资活动现金流出小计", sumOf: [17, 18, 19, 20] },
  { row: 22, label: "投资活动产生的现金流量净额", sumOf: [16], minusRows: [21] },
  { row: null, label: "三、筹资活动产生的现金流量：", section: true },
  { row: 23, label: "吸收投资收到的现金", flow: "in", match: only("所有者权益类", named("实收资本", "资本公积")) },
  { row: 24, label: "取得借款收到的现金", flow: "in", match: only("负债类", named("短期借款", "长期借款")) },
  { row: 25, label: "收到其他与筹资活动有关的现金", flow: "in", note: "本系统无对应科目" },
  { row: 26, label: "筹资活动现金流入小计", sumOf: [23, 24, 25] },
  { row: 27, label: "偿还债务支付的现金", flow: "out", match: only("负债类", named("短期借款", "长期借款", "长期应付款")) },
  { row: 28, label: "分配股利、利润或偿付利息支付的现金", flow: "out", match: only("负债类", named("应付利息", "应付利润")) },
  { row: 29, label: "支付其他与筹资活动有关的现金", flow: "out", note: "本系统无对应科目" },
  { row: 30, label: "筹资活动现金流出小计", sumOf: [27, 28, 29] },
  { row: 31, label: "筹资活动产生的现金流量净额", sumOf: [26], minusRows: [30] },
  { row: 32, label: "四、汇率变动对现金及现金等价物的影响", note: "外币资金按「期初汇率 / 期末汇率」分别折算后的差额（设计文档 §8.2）；本币或无外币时为 0" },
  { row: 33, label: "五、现金及现金等价物净增加额", sumOf: [10, 22, 31, 32] },
  { row: 34, label: "加：期初现金及现金等价物余额", note: "来自银行账户档案的期初余额 + 上年累计" },
  { row: 35, label: "六、期末现金及现金等价物余额", sumOf: [33, 34] },
];

/** 三张表各自的行定义（键与导出 / 预览的路由子路径一致）。 */
export const STATEMENT_ROWS: Record<string, readonly StatementRow[]> = {
  "balance-sheet": [...BALANCE_SHEET_ASSETS, ...BALANCE_SHEET_EQUITIES],
  "income-statement": INCOME_STATEMENT,
  "cash-flow-statement": CASH_FLOW_STATEMENT,
};

export type StatementId = keyof typeof STATEMENT_ROWS;

/* --------------------------------------------------------------------------- 科目 → 报表行 的映射 */

/**
 * 四个认领域与它们各自的行定义（2026-11-11 R-2 / T8）。
 *
 * 为什么把资产负债表拆成两侧：它是两栏对照表，行次在左右两侧各自从 1 开始。
 * 混成一个认领域会让「行次 1」同时指「货币资金」与「短期借款」—— 映射落错侧而报表照样平。
 */
export const STATEMENT_SCOPE_ROWS: readonly ScopeClaimSource[] = [
  { scope: "balance-sheet-assets", rows: BALANCE_SHEET_ASSETS },
  { scope: "balance-sheet-equities", rows: BALANCE_SHEET_EQUITIES },
  { scope: "income-statement", rows: INCOME_STATEMENT },
  { scope: "cash-flow-statement", rows: CASH_FLOW_STATEMENT },
];

/**
 * 按今天的 `named()/prefixed()` 规则算出初始映射（迁移 SQL 就是它生成的）。
 *
 * 生成器（`scripts/generate-statement-row-mapping.mjs`）与守卫测试都调这个函数：
 * 规则只有一份，迁移文件与规则之间的漂移由测试盯住。
 */
export function initialStatementRowClaimsOf(seeds: readonly { category: string; name: string }[] = ACCOUNTING_SUBJECT_SEEDS) {
  return initialStatementRowClaims(STATEMENT_SCOPE_ROWS, seeds);
}

/** 表尾要写的口径与缺口（行定义上带 `note` 的行）。 */
export function statementNotes(rows: readonly StatementRow[]): string[] {
  return rows.filter((row) => row.note).map((row) => `${row.row === null ? row.label : `行次 ${row.row} ${row.label}`}：${row.note}`);
}

/* --------------------------------------------------------------------------- 取数（聚合） */

/** 凭证分录（只取报表要用的列，避免与 Prisma 类型耦合）。 */
export type StatementVoucherLine = {
  subjectKey: string;
  /**
   * 记账科目 id（2026-11-09 迁移新增 `voucher_lines.subject_id`）。
   *
   * 有 id 就按 id 归集（R3-2）；历史行/解析不到唯一科目的新行为空，回退 `subjectKey` 文本匹配。
   */
  subjectId?: string | null;
  direction: "debit" | "credit" | string;
  amount: string;
};
/** 一张凭证：报表按**凭证**为单位配对资金分录与业务分录，所以必须带凭证分组。 */
export type StatementVoucher = {
  id: string;
  lines: readonly StatementVoucherLine[];
  /**
   * 来源收支流水的「收支类目」（业务科目，`cash_flow_entries.category_subject_id`）。
   *
   * 现金流量表落行**优先用它**（2026-11-04 用户报障）：已挂账的付款，付款凭证的业务分录是
   * 「应付账款」，照分录科目落行会把专利费/推广费/房租一笔笔算成「购买商品、接受劳务支付的现金」；
   * 收支类目才是单据上选的那个科目，也是台账/利润表统计的口径。没有类目（手工凭证、老数据）
   * 才退回凭证自己的业务分录科目。
   *
   * `subjectId`（2026-11-11 R-2 / T8）：落行改按**科目身份**查映射；只有查不到映射时才退回
   * 「按分类/名称在行定义里找」。类目没有 id（老数据/手工录入）时映射查不到，自然走回退。
   */
  categorySubject?: { subjectId?: string | null; category: string; name: string } | null;
};

export type SummedAmount = { debit: bigint; credit: bigint };

/** 借方余额（资产/成本/费用类看它；备抵科目天然为负）。 */
export function debitBalance(summed: SummedAmount | undefined): bigint {
  return summed ? summed.debit - summed.credit : 0n;
}

/** 贷方余额（负债/权益/收入类看它）。 */
export function creditBalance(summed: SummedAmount | undefined): bigint {
  return summed ? summed.credit - summed.debit : 0n;
}

/**
 * 把凭证分录按科目累计（借贷分开）。
 *
 * 为什么借贷分开而不是直接算余额：利润表要**发生额**（本月收入多少 / 费用多少），
 * 资产负债表要**余额**（累计到期末）。同一份取数同时喂两张表，两处口径就不会分叉。
 *
 * 归集键（2026-11-09 R3-2）：`subject_id` 优先（`@id:<uuid>`），为空才回退 label 键。
 * 一条分录只算出一个键 → 不会被计两次。
 */
export function sumVoucherLines(lines: readonly StatementVoucherLine[]): Map<string, SummedAmount> {
  const summed = new Map<string, SummedAmount>();
  for (const line of lines) {
    const key = subjectKeyOfLine(line);
    const bucket = summed.get(key) ?? { debit: 0n, credit: 0n };
    const units = toUnits(line.amount);
    if (line.direction === "debit") bucket.debit += units;
    else bucket.credit += units;
    summed.set(key, bucket);
  }
  return summed;
}

/** 一行报表算出来的值（`value: null` = 段落行或需要手填的格子）。 */
export type StatementLineValue = {
  row: number | null;
  label: string;
  value: bigint | null;
  section?: boolean;
  manual?: boolean;
  note?: string;
};

/** 没有归到任何报表行的科目及其余额（上层必须写进表尾，不能静默丢掉）。 */
export type UnmappedSubject = { subjectKey: string; balance: bigint };

/** 归集键里的科目主键；文本键返回 `null`（文本键没有身份，只能走名字回退）。 */
export function subjectIdOfKey(subjectKey: string): string | null {
  return isSubjectIdKey(subjectKey) ? subjectKey.slice(SUBJECT_ID_KEY_PREFIX.length) : null;
}

/**
 * 把余额按行分配。
 *
 * 一个科目被同一张表的两行同时匹配是**映射表写错了**，这里直接抛错而不是让金额算两遍 ——
 * 算重了比算漏了更难发现（勾稽照样平）。
 *
 * 归集键按 `SubjectRefs` 解析分类/名称：id 键必须能解析（解析不到就不是任何一行的金额，
 * 会由 `unmappedOf` 报出来）；label 键直接拆。
 *
 * ## 落行顺序（2026-11-11 R-2 / T8）
 *
 * 1. **有映射就照映射**（`statementRows` 里查得到这个科目主键的 (认领域, 方向) → 行次）；
 * 2. 没有映射才回退 `row.match(分类, 名称)` —— 兼容历史文本行与还没指定落行的科目。
 *
 * 回退必须留着：回填没覆盖到的历史行只有文本，删掉它会让那些金额整笔丢钱。
 * 反过来，有映射时**不再看名字**：名字是文案，映射才是身份 —— 这正是「改名不影响数字」的实现点。
 */
function directValues(
  rows: readonly StatementRow[],
  balances: ReadonlyMap<string, SummedAmount>,
  defaultSide: "debit" | "credit",
  subjectRefs: SubjectRefs | undefined,
  scope: StatementScope,
  statementRows: StatementRowIndex | undefined,
) {
  const values = new Map<number, bigint>();
  const claimed = new Set<string>();
  for (const row of rows) {
    if (row.row === null || row.sumOf || row.minusRows) continue;
    const side = row.side ?? defaultSide;
    const flow: StatementFlow = row.flow ?? "";
    let total = 0n;
    for (const [subjectKey, summed] of balances) {
      const ref = subjectRefOfKey(subjectKey, subjectRefs);
      if (!ref) continue;
      const { category, name } = ref;
      const mapped = mappedRowOf(statementRows, scope, flow, subjectIdOfKey(subjectKey));
      // 有映射时以映射为准（不再看名字）；没有映射才按名字认领。
      const belongs = mapped === null ? Boolean(row.match?.(category, name)) : mapped === row.row;
      if (!belongs) continue;
      total += side === "credit" ? creditBalance(summed) : debitBalance(summed);
      claimed.add(subjectKey);
    }
    values.set(row.row, total);
  }
  return { values, claimed };
}

/** 公式行（`sumOf` − `minusRows`）。被引用的行必须在数组里排在前面（行定义按模板顺序）。 */
function evaluateRows(rows: readonly StatementRow[], direct: Map<number, bigint>): Map<number, bigint> {
  const values = new Map<number, bigint>(direct);
  for (const row of rows) {
    if (row.row === null || (!row.sumOf && !row.minusRows)) continue;
    let total = 0n;
    for (const at of row.sumOf ?? []) total += values.get(at) ?? 0n;
    for (const at of row.minusRows ?? []) total -= values.get(at) ?? 0n;
    values.set(row.row, total);
  }
  return values;
}

function toLineValues(rows: readonly StatementRow[], values: ReadonlyMap<number, bigint>): StatementLineValue[] {
  return rows.map((row) => ({
    row: row.row,
    label: row.label,
    value: row.section || row.manual || row.row === null ? null : values.get(row.row) ?? 0n,
    ...(row.section ? { section: true as const } : {}),
    ...(row.manual ? { manual: true as const } : {}),
    ...(row.note ? { note: row.note } : {}),
  }));
}

/** 有发生额但没有任何一行认领的科目（零余额/零发生的科目不算缺口，那是噪音）。 */
function unmappedOf(balances: ReadonlyMap<string, SummedAmount>, claimed: ReadonlySet<string>, absorbed: ReadonlySet<string>, subjectRefs?: SubjectRefs): UnmappedSubject[] {
  const unmapped: UnmappedSubject[] = [];
  for (const [subjectKey, summed] of balances) {
    if (claimed.has(subjectKey) || absorbed.has(subjectKey)) continue;
    if (summed.debit === 0n && summed.credit === 0n) continue;
    // 展示用「分类/名称」：id 键解析得到就写科目名，解析不到才退回原始键（不然表尾会出现一串 uuid）。
    unmapped.push({ subjectKey: subjectLabelOfKey(subjectKey, subjectRefs), balance: debitBalance(summed) });
  }
  return unmapped.sort((left, right) => left.subjectKey.localeCompare(right.subjectKey));
}

/* --------------------------------------------------------------------------- 资产负债表 */

/**
 * 建账期初余额。
 *
 * 为什么是两个口子而不是一个：银行账户档案里只有**货币资金**的期初余额，而期初余额在会计上
 * 是「资产 = 负债 + 权益」两侧同时存在的（钱有期初，对应的权益/负债也有期初）。
 * 只往资产侧加，勾稽立刻不平 —— 这不是算错，而是**系统里缺一张「科目期初余额表」**。
 * 所以两个口子都留出来：默认只填 `money` 时，差额作为 `openingDifference` 返回，上层必须写进表尾。
 */
export type StatementOpening = { money?: bigint; retained?: bigint };

export type BalanceSheetInput = {
  balances: ReadonlyMap<string, SummedAmount>;
  opening?: StatementOpening;
  /**
   * 归集键 → 分类/名称索引（2026-11-09 R3-2）。
   *
   * 期初余额表只存 `subject_key`（`分类/名称`），凭证行优先用 `subject_id`；两套键能不能相加，
   * 取决于上层有没有把期初行也解析成 id 键（`FinanceThreeStatementsService` 负责）。这里只管
   * 按索引把 id 键还原成分类/名称 —— 解析不到的 id 键**不会**被归到任何行（宁可进 unmapped）。
   */
  subjectRefs?: SubjectRefs;
  /**
   * 「科目主键 → 报表行」的映射索引（2026-11-11 R-2 / T8）。
   *
   * 传进来就**照映射落行**（改名不再动数字）；没传、或某个科目没有映射，回退按名字认领。
   * 上层（`FinanceThreeStatementsService`）负责从 `accounting_subject_statement_rows` 建索引。
   */
  statementRows?: StatementRowIndex;
};

export type BalanceSheetResult = {
  assets: StatementLineValue[];
  equities: StatementLineValue[];
  totalAssets: bigint;
  totalEquities: bigint;
  /** 勾稽核对 = 资产总计 − 负债和所有者权益总计（模板 G41，0 才是平衡）。 */
  difference: bigint;
  balanced: boolean;
  /** 未分配利润（含未结转损益与期初未分配利润）。 */
  retainedEarnings: bigint;
  /** 其中属于「未结转损益」的部分（收入 − 支出）：系统没有结转凭证，所以它必须显式露出来。 */
  retainedFromProfit: bigint;
  /** 只填了货币资金期初、没有对应权益期初时的差额（不平的原因写清楚，别让人以为是算错了）。 */
  openingDifference: bigint;
  unmapped: UnmappedSubject[];
  notes: string[];
};

/**
 * 资产负债表。
 *
 * 三处口径：
 *   1. 「货币资金」加上**银行账户档案的期初余额**（建账前的钱不在凭证里）；
 *   2. 「未分配利润」= 利润分配 + 本年利润 + **未结转的损益**（损益类科目贷方余额之和，
 *      加上当期费用性质的成本类科目）—— 系统没有「结转损益」凭证，不这样算
 *      「资产总计 = 负债和所有者权益总计」永远不平；
 *   3. 备抵科目（累计折旧 / 累计摊销）按「借 − 贷」并入主科目行，天然为负数即净额。
 */
export function buildBalanceSheet(input: BalanceSheetInput): BalanceSheetResult {
  const opening = input.opening ?? {};
  // 资产负债表是两栏对照表，两栏行次各自从 1 开始，所以两个「认领域」分开查映射（见 StatementScope）。
  const assets = directValues(BALANCE_SHEET_ASSETS, input.balances, "debit", input.subjectRefs, "balance-sheet-assets", input.statementRows);
  if (opening.money) assets.values.set(1, (assets.values.get(1) ?? 0n) + opening.money);
  const assetValues = evaluateRows(BALANCE_SHEET_ASSETS, assets.values);

  const equities = directValues(BALANCE_SHEET_EQUITIES, input.balances, "credit", input.subjectRefs, "balance-sheet-equities", input.statementRows);

  // 未结转的损益：损益类全部科目 + 当期费用性质的成本类科目（贷方余额 = 正贡献）。
  const absorbed = new Set<string>([...assets.claimed, ...equities.claimed]);
  let retainedFromProfit = 0n;
  for (const [subjectKey, summed] of input.balances) {
    const ref = subjectRefOfKey(subjectKey, input.subjectRefs);
    if (!ref) continue;
    const { category, name } = ref;
    const isProfit = category === "损益类" || (category === "成本类" && PERIOD_COST_SUBJECT_NAMES.includes(name));
    if (!isProfit) continue;
    absorbed.add(subjectKey);
    retainedFromProfit += creditBalance(summed);
  }
  const retainedEarnings = (equities.values.get(32) ?? 0n) + retainedFromProfit + (opening.retained ?? 0n);
  equities.values.set(32, retainedEarnings);
  const equityValues = evaluateRows(BALANCE_SHEET_EQUITIES, equities.values);

  const totalAssets = assetValues.get(34) ?? 0n;
  const totalEquities = equityValues.get(34) ?? 0n;
  const difference = totalAssets - totalEquities;
  const openingDifference = (opening.money ?? 0n) - (opening.retained ?? 0n);
  const notes = statementNotes(BALANCE_SHEET_ASSETS).concat(statementNotes(BALANCE_SHEET_EQUITIES));
  if (openingDifference !== 0n) {
    notes.push(`期初余额只填了货币资金 ${formatStatementValue(openingDifference)}：系统还没有「科目期初余额表」，`
      + `对应的权益/负债期初无处可填，所以勾稽差额 = ${formatStatementValue(openingDifference)}（不是算错了）`);
  }
  return {
    assets: toLineValues(BALANCE_SHEET_ASSETS, assetValues),
    equities: toLineValues(BALANCE_SHEET_EQUITIES, equityValues),
    totalAssets,
    totalEquities,
    difference,
    balanced: difference === 0n,
    retainedEarnings,
    retainedFromProfit,
    openingDifference,
    unmapped: unmappedOf(input.balances, absorbed, new Set(), input.subjectRefs),
    notes,
  };
}

/* --------------------------------------------------------------------------- 利润表 */

export type IncomeStatementResult = {
  lines: StatementLineValue[];
  operatingProfit: bigint;
  totalProfit: bigint;
  netProfit: bigint;
  unmapped: UnmappedSubject[];
  notes: string[];
};

/**
 * 利润表（入参是**期间发生额**：`sumVoucherLines(期间分录)`）；`subjectRefs` 用于解析 id 归集键。
 * `statementRows` 是「科目主键 → 利润表行次」的映射（2026-11-11 R-2 / T8），缺省则按名字认领。
 */
export function buildIncomeStatement(
  movements: ReadonlyMap<string, SummedAmount>,
  subjectRefs?: SubjectRefs,
  statementRows?: StatementRowIndex,
): IncomeStatementResult {
  const income = directValues(INCOME_STATEMENT, movements, "debit", subjectRefs, "income-statement", statementRows);
  const values = evaluateRows(INCOME_STATEMENT, income.values);
  // 资金类科目不进利润表（它们是资金动作，不是损益），所以不算「没归位」。
  const fundKeys = new Set([...movements.keys()].filter((key) => isFundSubject(key, subjectRefs)));
  return {
    lines: toLineValues(INCOME_STATEMENT, values),
    operatingProfit: values.get(14) ?? 0n,
    totalProfit: values.get(17) ?? 0n,
    netProfit: values.get(19) ?? 0n,
    unmapped: unmappedOf(movements, income.claimed, fundKeys, subjectRefs),
    notes: statementNotes(INCOME_STATEMENT),
  };
}

/* --------------------------------------------------------------------------- 现金流量表 */

export type CashFlowInput = {
  /** 期间内的**已过账**凭证（红冲件本身就是一张反向凭证，原凭证不计入）。 */
  vouchers: readonly StatementVoucher[];
  /** 期初现金及现金等价物余额（与资产负债表的货币资金期初同源）。 */
  cashOpening?: bigint;
  /**
   * 汇率变动对现金及现金等价物的影响（行次 32）。
   *
   * 由上层算好（`期末资金按期末汇率 − 期初资金按期初汇率 − 本期资金净流量按期末汇率`）：
   * 内核只看凭证，看不到「资金余额折算成多少」，硬算会算错。默认 0 = 本币业务或无外币。
   */
  exchangeEffect?: bigint;
  /** 归集键 → 分类/名称索引（2026-11-09 R3-2）：资金/业务分录按 `subject_id` 识别与落行。 */
  subjectRefs?: SubjectRefs;
  /** 「科目主键 → 现金流量表行次」的映射索引（2026-11-11 R-2 / T8），按流向分两组。 */
  statementRows?: StatementRowIndex;
};

export type CashFlowResult = {
  lines: StatementLineValue[];
  netIncrease: bigint;
  closing: bigint;
  /** 认不出落哪一行的对方科目及其金额（上层必须写进表尾）。 */
  unmapped: Array<{ subjectKey: string; amount: bigint }>;
  /** 没有资金分录的凭证张数（如折旧计提：不计入现金流量表）。 */
  nonCashVouchers: number;
  /** 一张凭证里两边都是资金科目的张数（内部划转：不构成现金流量）。 */
  internalTransfers: number;
  notes: string[];
};

/** 现金流量表（入参是**期间内的凭证**：资金分录与业务分录按凭证配对）。 */
export function buildCashFlowStatement(input: CashFlowInput): CashFlowResult {
  const amounts = new Map<number, bigint>();
  const unmapped = new Map<string, bigint>();
  let nonCashVouchers = 0;
  let internalTransfers = 0;

  for (const voucher of input.vouchers) {
    const refs = input.subjectRefs;
    const isFundLine = (line: StatementVoucherLine) => isFundSubject(subjectKeyOfLine(line), refs);
    const fundLines = voucher.lines.filter(isFundLine);
    if (fundLines.length === 0) { nonCashVouchers += 1; continue; }
    // 两边都是资金科目（银行存款 → 库存现金）：内部划转，不构成现金流量。
    if (voucher.lines.every(isFundLine)) { internalTransfers += 1; continue; }
    const businessLines = voucher.lines.filter((line) => !isFundLine(line));
    /**
     * 落行用的科目：**优先用来源流水的收支类目**（2026-11-04，见 `StatementVoucher.categorySubject`）。
     * 没有类目时才退回凭证业务分录自己的科目（手工凭证、历史数据）——
     * 2026-11-09 R3-2 起，业务分录优先按 `subject_id` 解析分类/名称，label 只兜底。
     */
    const categorySubject = voucher.categorySubject?.name ? voucher.categorySubject : null;

    for (const fund of fundLines) {
      const inflow = fund.direction === "debit";
      // **按方向在对应的那一组里找行**：只看科目不看方向，还款会被算成借款（见 StatementRow.flow）。
      const candidates = CASH_FLOW_STATEMENT.filter((candidate) => candidate.match && candidate.flow === (inflow ? "in" : "out"));
      const opposite = businessLines.filter((line) => (inflow ? line.direction === "credit" : line.direction === "debit"));
      for (const line of opposite) {
        const lineKey = subjectKeyOfLine(line);
        const ref = categorySubject ?? subjectRefOfKey(lineKey, refs);
        const units = toUnits(line.amount);
        if (!ref) {
          // 有 id 但索引里查不到（科目被硬删等）：如实点名，不猜一个科目把它归行。
          const orphanKey = subjectLabelOfKey(lineKey, refs);
          unmapped.set(orphanKey, (unmapped.get(orphanKey) ?? 0n) + units);
          continue;
        }
        const subjectKey = categorySubject ? accountingSubjectKey(categorySubject.category, categorySubject.name) : subjectLabelOfKey(lineKey, refs);
        /**
         * 落行顺序与 `directValues` 一致：**有映射照映射**（按科目主键 + 流向），没有映射才按名字在
         * 方向对应的那一组里找。名字是文案，映射才是身份 —— 这正是「改名不影响数字」的实现点。
         *
         * 现金流量表尤其需要它：同一个科目在两组的名字可以一模一样（借了又还），
         * 只有映射能把「借方出现」与「贷方出现」分开落行。
         */
        const lineSubjectId = categorySubject?.subjectId ?? subjectIdOfKey(lineKey);
        const mapped = mappedRowOf(input.statementRows, "cash-flow-statement", inflow ? "in" : "out", lineSubjectId);
        const row = mapped ?? candidates.find((candidate) => candidate.match?.(ref.category, ref.name))?.row ?? null;
        if (row === null) {
          unmapped.set(subjectKey, (unmapped.get(subjectKey) ?? 0n) + units);
          continue;
        }
        amounts.set(row, (amounts.get(row) ?? 0n) + units);
      }
    }
  }

  // 期初余额是外部给的（与货币资金期初同源），净额/小计行由公式算。
  amounts.set(34, input.cashOpening ?? 0n);
  // 汇率变动影响：上层折算后给的差额（行 33 的 sumOf 已经含 32，所以期末 = 期初 + 净增加额仍成立）。
  amounts.set(32, input.exchangeEffect ?? 0n);
  const values = evaluateRows(CASH_FLOW_STATEMENT, amounts);
  return {
    lines: toLineValues(CASH_FLOW_STATEMENT, values),
    netIncrease: values.get(33) ?? 0n,
    closing: values.get(35) ?? 0n,
    unmapped: [...unmapped.entries()].map(([subjectKey, amount]) => ({ subjectKey, amount })).sort((left, right) => left.subjectKey.localeCompare(right.subjectKey)),
    nonCashVouchers,
    internalTransfers,
    notes: statementNotes(CASH_FLOW_STATEMENT),
  };
}

/* --------------------------------------------------------------------------- 覆盖度守卫 */

export type CoverageReport = {
  /** 科目表里有、但**没有任何一行认领**的科目（它的金额会凭空消失）。 */
  unclaimed: string[];
  /** 同一张表（现金流分流入/流出两套）里被两行同时认领的科目（金额会被算两遍）。 */
  doubleClaimed: string[];
  /** 声明了 `match` 却一个科目都没匹配到的行（映射写错了，或科目被改名了）。 */
  emptyRows: string[];
};

/**
 * 映射表的覆盖度检查（守卫测试用，也供「新增科目忘了归位」时在运行期报警）。
 *
 * 三个方向都要查，缺一条都会变成**看不出来的错**：
 *   ① 科目表里的每个科目都必须被某张表认领 —— 漏了就是金额消失；
 *   ② 同一张表的同一方向里一个科目不能被两行同时认领 —— 撞了就是算两遍；
 *   ③ 声明了 match 的行不能一个科目都匹配不到 —— 那通常是名字打错
 *      （`named("应交税费-进项税--祥恩线业")` 少一个横杠就永远匹配不上），而那一行会静默变成 0。
 *
 * `statements` 可覆盖（默认三张表的真映射）：这是为了让**守卫本身**也能被测 ——
 * 一份故意写错的映射必须被它抓住，否则「护栏」只是个摆设。
 */
export function checkStatementCoverage(
  seeds: readonly { category: string; name: string }[] = ACCOUNTING_SUBJECT_SEEDS,
  statements: Record<string, readonly StatementRow[]> = STATEMENT_ROWS,
): CoverageReport {
  const names = Object.keys(statements);
  const claims = new Map<string, string[]>();  // `${statement}|${flow}|${subjectKey}` → 行次
  const matched = new Set<string>();           // `${statement}|${flow}|${row}`

  for (const statement of names) {
    for (const row of statements[statement]) {
      if (!row.match || row.row === null) continue;
      const flow = row.flow ?? "";
      for (const seed of seeds) {
        if (!row.match(seed.category, seed.name)) continue;
        const key = `${statement}|${flow}|${accountingSubjectKey(seed.category, seed.name)}`;
        claims.set(key, [...(claims.get(key) ?? []), String(row.row)]);
        matched.add(`${statement}|${flow}|${row.row}`);
      }
    }
  }

  const unclaimed = seeds
    .map((seed) => accountingSubjectKey(seed.category, seed.name))
    .filter((subjectKey) => !names.some((statement) => (claims.get(`${statement}||${subjectKey}`) ?? []).length > 0));
  const doubleClaimed = [...claims.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => `${key} → 行次 ${rows.join("、")}`)
    .sort();
  const emptyRows = names.flatMap((statement) => statements[statement]
    .filter((row) => row.match && row.row !== null && !matched.has(`${statement}|${row.flow ?? ""}|${row.row}`))
    .map((row) => `${statement}|${row.flow ?? ""}|行次 ${row.row} ${row.label}`));

  return { unclaimed, doubleClaimed, emptyRows };
}
