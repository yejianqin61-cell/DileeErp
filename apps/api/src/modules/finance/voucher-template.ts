import { accountingSubjectKey } from "./accounting-subject-catalog";

/**
 * 记账凭证模板（财务 2026-09-20 提出）。
 *
 * 财务原话（两条完整分录）：
 *
 *   借：应付职工薪酬——工资        （应发）
 *       贷：其他应付款——社保（个人部分）
 *           应交税费——应交个人所得税
 *           银行存款                （实发）
 *
 *   借：原材料              18 000
 *       应交税费——应交增值税（进项税额）  （如取得专票）
 *       贷：应付账款——泉州峰峰雨伞    18 000
 *
 * 并追问「现在自动生成的不能改、。这是什么意思？」—— 系统原先只能从收支流水生成
 * **一借一贷**两行，页面上只允许改这两行的科目与金额，不能增删行、不能改借贷方向，
 * 所以财务那套「一借多贷」的工资凭证根本录不进来。
 *
 * 本轮的解法分两层，这里是第二层：
 *   1. **分录编辑器**（`apps/web/components/finance/voucher-line-editor.tsx`）：
 *      增删行、改方向、从科目表选科目、改金额与摘要 —— 这才是「能改」；
 *   2. **模板**（本文件）：把两条最常用的结构固化下来，一键套用，免得每次手搭。
 *
 * ## 三条刻意的口径
 *
 * 1. **模板只给结构，金额一律留空**（用户 2026-09-20 拍板）。不按税率自动拆进项税：
 *    系统里采购单价是**含税价**，`不含税 = 含税 ÷ (1+税率)` 在取得普票（不抵扣）、
 *    享受优惠税率或部分抵扣时会被自动填错，而这类错误在凭证上看不出来。
 *    金额由财务手填，编辑器实时显示借贷合计、不平不让保存。
 *
 * 2. **科目按**名称候选**解析，候选全部落空时不编一个科目 id**。科目表（`accounting_subjects`）
 *    是财务那张 `科目表(2).xls` 的照抄，里面**没有**「应交个人所得税」也没有
 *    「应交税费——应交增值税（进项税额）」。所以每行给一串候选名（从最贴近财务说法到最宽的兜底），
 *    命中哪个用哪个，一个都不命中就返回 `subject_id: null` + 建议名，让财务在编辑器的科目下拉里
 *    自己选（也可以在「会计科目」页把这两个科目建出来，之后模板就自动命中了）。
 *
 * 3. **资金行（`role: "fund"`）只是一个标记，不带金额**。它的科目与银行账户由**被套用的那张凭证**
 *    决定（凭证是从某条收支流水生成的，钱落在那张卡上是已确认的事实）；页面套模板时会把
 *    凭证原有的资金行科目/账户搬过来。所以这里给出的候选只是「这张凭证没有资金行时」的兜底。
 *
 * 模板清单放在后端而不是前端常量：它是**会计口径**，与科目表同源；放前端就成了一处只有页面
 * 知道的口径，将来做「手工凭证」「批量凭证」时还得再抄一遍。
 */

export type VoucherTemplateLineRole = "business" | "fund";

export type VoucherTemplateLine = {
  direction: "debit" | "credit";
  /** 科目名称候选，**按优先级**：靠前的更贴近财务的说法。 */
  subjects: readonly string[];
  /** 候选全部落空时给财务看的建议名（不写库，只是编辑器的初值）。 */
  fallbackLabel: string;
  role: VoucherTemplateLineRole;
  /** 该行的摘要建议。 */
  summary: string;
};

export type VoucherTemplate = {
  key: string;
  name: string;
  /** 一句话说明这张模板算什么业务（界面上给财务看）。 */
  description: string;
  lines: readonly VoucherTemplateLine[];
};

export const SALARY_ACCRUAL_TEMPLATE_KEY = "salary-accrual";
export const RAW_MATERIAL_PURCHASE_TEMPLATE_KEY = "raw-material-purchase";

export const VOUCHER_TEMPLATES: readonly VoucherTemplate[] = [
  {
    key: SALARY_ACCRUAL_TEMPLATE_KEY,
    name: "工资计提",
    description: "借 应付职工薪酬（应发）；贷 其他应付款（社保个人部分）、应交税费（个人所得税）、银行存款（实发）。金额留空由财务填写。",
    lines: [
      // 借方一行、贷方三行 —— 这正是系统原来「一借一贷」做不出来的形状。
      { direction: "debit", subjects: ["应付职工薪酬"], fallbackLabel: "应付职工薪酬——工资", role: "business", summary: "计提工资（应发）" },
      { direction: "credit", subjects: ["其他应付款"], fallbackLabel: "其他应付款——社保（个人部分）", role: "business", summary: "代扣社保（个人部分）" },
      // 「应交个人所得税」目前在财务的科目表里没有，候选退到「应交税费」也要让整行有科目可选，
      // 否则财务填金额时会被「每条分录都必须填科目」挡住，还得先去建科目才能保存。
      { direction: "credit", subjects: ["应交个人所得税", "应交税费-应交个人所得税", "应交税费"], fallbackLabel: "应交税费——应交个人所得税", role: "business", summary: "代扣个人所得税" },
      { direction: "credit", subjects: ["银行存款", "库存现金"], fallbackLabel: "银行存款", role: "fund", summary: "实发工资" },
    ],
  },
  {
    key: RAW_MATERIAL_PURCHASE_TEMPLATE_KEY,
    name: "原材料采购",
    description: "借 原材料、应交税费（进项税额，取得专票时）；贷 应付账款。金额留空由财务填写。",
    lines: [
      { direction: "debit", subjects: ["原材料", "材料采购"], fallbackLabel: "原材料", role: "business", summary: "采购原材料" },
      // 财务的说法是「应交税费——应交增值税（进项税额）」，科目表里对应的是「应交税费-进项税」。
      { direction: "debit", subjects: ["应交税费-应交增值税（进项税额）", "应交税费-进项税", "应交税费"], fallbackLabel: "应交税费——应交增值税（进项税额）", role: "business", summary: "进项税额（取得专票时）" },
      { direction: "credit", subjects: ["应付账款"], fallbackLabel: "应付账款", role: "business", summary: "应付供应商货款" },
    ],
  },
];

/** 按 key 取模板；查不到返回 undefined（控制器据此 404，而不是静默回一张空模板）。 */
export function voucherTemplateOf(key: string): VoucherTemplate | undefined {
  return VOUCHER_TEMPLATES.find((template) => template.key === key);
}

/** 解析后的模板行：科目已经落到具体科目上（或明确落空）。 */
export type ResolvedTemplateLine = {
  direction: "debit" | "credit";
  role: VoucherTemplateLineRole;
  summary: string;
  /** 命中的科目 id；候选全部落空时为 null（编辑器显示 fallbackLabel 让财务自己选）。 */
  subject_id: string | null;
  /** 科目名称快照（命中的是科目名，落空的是建议名）。 */
  subject_label: string;
  /** 科目编码快照 = `分类/名称`（凭证分录的既有写法）；落空时与 subject_label 相同。 */
  subject_key: string;
};

/** 可参与模板解析的科目（只用到这三个字段，避免与 Prisma 类型耦合）。 */
export type TemplateSubject = { id: string; category: string; name: string; isActive: boolean };

/**
 * 取候选里第一个**存在**的科目。
 *
 * 优先启用中的科目：停用的科目仍然「存在」（历史凭证要能显示），但拿它当新分录的默认值
 * 等于让财务继续往一个已经停用的科目上记账。
 */
export function resolveTemplateSubject(candidates: readonly string[], subjects: readonly TemplateSubject[]): TemplateSubject | null {
  for (const candidate of candidates) {
    const hit = subjects.find((subject) => subject.name === candidate && subject.isActive) ?? subjects.find((subject) => subject.name === candidate);
    if (hit) return hit;
  }
  return null;
}

/** 把一张模板落到具体科目上（`subjects` 传全量科目，含已停用）。 */
export function resolveVoucherTemplate(template: VoucherTemplate, subjects: readonly TemplateSubject[]): ResolvedTemplateLine[] {
  return template.lines.map((line) => {
    const hit = resolveTemplateSubject(line.subjects, subjects);
    return {
      direction: line.direction,
      role: line.role,
      summary: line.summary,
      subject_id: hit?.id ?? null,
      subject_label: hit?.name ?? line.fallbackLabel,
      subject_key: hit ? accountingSubjectKey(hit.category, hit.name) : line.fallbackLabel,
    };
  });
}
