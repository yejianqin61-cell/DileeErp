// 记账凭证「分录编辑器」的纯逻辑（**不能**放进 "use client" 文件）。
//
// 财务 2026-09-20：「我完整的一个工资是这样的（借 应付职工薪酬 / 贷 其他应付款 + 应交税费 + 银行存款），
// 但是现在都不能改」「原材料的也是要加上应交税费」「现在自动生成的不能改、。这是什么意思？」。
//
// 原来的编辑弹窗只能改**已有一借一贷两行**的科目与金额：不能增行、不能改借贷方向、科目还是手打文本。
// 一借多贷的工资凭证因此根本录不进来。本模块给编辑器提供可单测的骨架：
//   - 行的形状与序列化（`voucherLinePayload`）；
//   - 借贷合计与平衡判定（`voucherLineTotals`）—— 金额一律按「整数分」用 BigInt 相加；
//   - 模板套用（`applyVoucherTemplate`）。
//
// 为什么金额用 BigInt 分而不是 `Number`：全站约定金额是字符串十进制（DECIMAL(18,4)），
// 用浮点求和会出现 `0.1 + 0.2 = 0.30000000000000004`，而这张表要拿合计去和用户输入的金额
// 逐位比对、还要决定「保存」按钮能不能点 —— 差一位小数就是「明明平了却不让保存」。

/** 分录方向。中文只在 `DIRECTION_OPTIONS` 里出现一次，别处一律用这个 key。 */
export type VoucherDirection = "debit" | "credit";

export const DIRECTION_OPTIONS: ReadonlyArray<{ value: VoucherDirection; label: string }> = [
  { value: "debit", label: "借" },
  { value: "credit", label: "贷" },
];

/**
 * 编辑器里的一行。
 *
 * `subject` 是**科目下拉的当前值**：命中了科目表就是科目 id，没命中就是一段自由文本科目名。
 * 为什么不换成 `{ id | label }` 的联合类型：`SearchableSelect` 是「单字符串值」的受控组件，
 * 拆成两个字段就得在每次 onChange 里判断用户选的是哪一种，反而更容易写错。取值见 `toLinePayload`。
 */
export type VoucherEditorLine = {
  /**
   * 前端行标识（React key）。**不能用下标**：增删行之后下标会错位，
   * React 会把上一行的输入框复用给下一行，用户看到的是「删掉的行又变了」。
   */
  key: string;
  direction: VoucherDirection;
  subject: string;
  summary: string;
  amount: string;
  /** 资金行引用的银行账户（后端 `voucher_lines.bank_id`）。非资金行为 null。 */
  bankId: string | null;
};

/** 后端 `GET /finance/vouchers/:id/templates` 的一行（科目已在服务端解析到具体科目或明确落空）。 */
export type VoucherTemplateLine = {
  direction: VoucherDirection;
  role: "business" | "fund";
  summary: string;
  subject_id: string | null;
  subject_label: string;
  subject_key: string;
  bank_id: string | null;
  bank_label: string | null;
};

export type VoucherTemplate = {
  key: string;
  name: string;
  description: string;
  lines: VoucherTemplateLine[];
};

/** 编辑器要用的科目形状（`AccountingSubject` 的子集，避免 lib 依赖组件层类型）。 */
export type EditorSubject = { id: string; category: string; name: string };

/** 新建一行的默认值：借方 + 空科目 + 空金额（用户填完才是合法分录）。 */
export function emptyVoucherLine(key: string, direction: VoucherDirection = "debit"): VoucherEditorLine {
  return { key, direction, subject: "", summary: "", amount: "", bankId: null };
}

/** 稳定且不会重复的行 key：增删行时只用「时间戳 + 序号」会撞（同一毫秒内连点两次「新增分录」）。 */
let lineSequence = 0;
export function nextLineKey(prefix = "line"): string {
  lineSequence += 1;
  return `${prefix}-${lineSequence}`;
}

/** 后端凭证详情里的分录 → 编辑器行。 */
export function linesFromVoucher(
  lines: ReadonlyArray<{ direction: string; subjectKey: string; subjectLabel: string; summary: string; amount: { toString(): string } | string; bank?: { id: string } | null }>,
  subjects: readonly EditorSubject[],
): VoucherEditorLine[] {
  return lines.map((line) => {
    // 科目能对上表就用 id（下拉里会显示成「分类 / 名称」，与页面别处一致）；
    // 对不上（模板给的建议名、或历史凭证里手打的科目）就原样保留文本 —— 强行换成空会让财务
    // 一打开编辑器就丢掉原有科目。
    const matched = subjects.find((subject) => `${subject.category}/${subject.name}` === line.subjectKey || subject.name === line.subjectLabel);
    return {
      key: nextLineKey(),
      direction: line.direction === "credit" ? "credit" : "debit",
      subject: matched ? matched.id : line.subjectLabel,
      summary: line.summary,
      amount: typeof line.amount === "string" ? line.amount : line.amount.toString(),
      bankId: line.bank?.id ?? null,
    };
  });
}

/**
 * 金额文本 → 整数「分」。非法或 ≤ 0 返回 null。
 *
 * 与后端 `voucher.domain.ts` 的 `toCents` 同一条正则（最多 4 位小数，与 DECIMAL(18,4) 对齐），
 * 所以「前端说平了」与「后端说平了」不可能得出不同结论。
 */
export function parseCents(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(text.trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  const cents = BigInt(`${whole}${fraction.padEnd(4, "0")}`);
  return cents > 0n ? cents : null;
}

/** 整数「分」→ 十进制字符串（去掉无意义的尾零）。 */
export function formatCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  const fraction = (abs % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${sign}${abs / 10000n}.${fraction}` : `${sign}${abs / 10000n}`;
}

export type VoucherLineTotals = {
  /** 借方合计（十进制字符串）。 */
  debit: string;
  credit: string;
  /** 借贷相等且都大于零。 */
  balanced: boolean;
  /** 有任一行的金额不是合法的正数（此时不许保存，也不该报「借贷不平衡」——那是两回事）。 */
  invalid: boolean;
  /** 有任一行的科目为空。 */
  subjectMissing: boolean;
};

/**
 * 借贷合计。
 *
 * 三种「不能保存」的原因**分开报**（金额非法 / 科目没填 / 借贷不平）：合成一句「请检查分录」
 * 会让财务在四行金额里逐个试。前两种是「还没填完」，第三种是「填错了」。
 */
export function voucherLineTotals(lines: readonly VoucherEditorLine[]): VoucherLineTotals {
  let debit = 0n;
  let credit = 0n;
  let invalid = false;
  let subjectMissing = false;
  for (const line of lines) {
    if (!line.subject.trim()) subjectMissing = true;
    const cents = parseCents(line.amount);
    if (cents === null) { invalid = true; continue; }
    if (line.direction === "debit") debit += cents;
    else credit += cents;
  }
  return {
    debit: formatCents(debit),
    credit: formatCents(credit),
    // 空分录集不算平衡：一张没有任何分录的凭证没有意义，后端也会以 VOUCHER_LINE_REQUIRED 拒绝。
    balanced: lines.length > 0 && !invalid && debit > 0n && debit === credit,
    invalid,
    subjectMissing,
  };
}

/** 编辑器行 → 后端 `PATCH /finance/vouchers/:id` 的 lines。 */
export function voucherLinePayload(
  lines: readonly VoucherEditorLine[],
  subjects: readonly EditorSubject[],
): Array<{ direction: VoucherDirection; subject_key: string; subject_label: string; summary: string; amount: string; bank_id: string | null }> {
  return lines.map((line) => {
    const subject = subjects.find((item) => item.id === line.subject);
    const label = subject ? subject.name : line.subject.trim();
    return {
      direction: line.direction,
      // 科目编码快照沿用凭证的既有写法 `分类/名称`；自由文本没有分类，就与名称相同。
      subject_key: subject ? `${subject.category}/${subject.name}` : label,
      subject_label: label,
      summary: line.summary.trim(),
      amount: line.amount.trim(),
      bank_id: line.bankId,
    };
  });
}

/**
 * 套用一张模板：**替换全部分录**（不是追加）。
 *
 * 为什么是替换：模板描述的是「这张凭证应该长什么样」（工资计提就是四行），追加会在原有两行后面
 * 再挂四行，得到一张六行、借贷各半的怪凭证。界面上也把这件事写清楚了（按钮旁注明「会覆盖现有分录」）。
 *
 * 金额一律留空（用户 2026-09-20 拍板）：不按税率自动拆进项税 —— 取得普票（不抵扣）、
 * 享受优惠税率或部分抵扣时自动填的税额是错的，而那种错误在凭证上看不出来。
 */
export function applyVoucherTemplate(
  template: VoucherTemplate,
  currentFundLine: VoucherEditorLine | null,
): VoucherEditorLine[] {
  return template.lines.map((line) => ({
    key: nextLineKey("tpl"),
    direction: line.direction,
    // 命中了科目表就用 id（下拉能显示成「分类 / 名称」）；没命中就放建议名，让财务在下拉里自己选。
    subject: line.subject_id ?? line.subject_label,
    summary: line.summary,
    amount: "",
    // 资金行沿用本凭证原有的银行账户：钱落在哪张卡上是已确认的事实，模板不该把它清掉。
    bankId: line.role === "fund" ? line.bank_id ?? currentFundLine?.bankId ?? null : null,
  }));
}
