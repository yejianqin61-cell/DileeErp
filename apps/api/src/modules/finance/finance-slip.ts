import * as ExcelJS from "exceljs";
import { NUMBER_FORMAT, toExportNumber } from "./finance-report.domain";

/**
 * 收/付款单（财务 2026-09-20 交付的 Excel 模板，见
 * `docs/design/finance-slip-and-merged-reconciliation-2026-09-20.md`）。
 *
 * 财务的原始要求分两轮：
 *   ①「她需要在付款界面能导出付款单」—— 每付一笔货款都要在 Excel 里手工照模板敲一张单子
 *     （单据编号 / 日期 / 对方单位 / 开户银行 / 银行账号 / 附单据 / 借贷明细 / 大写金额 / 签字栏）；
 *   ②「允许用户编辑付款单中的一些字段……比如我要付款 100，我可以自己填加行，我可以写付款备注」，
 *     紧接着又说「同理，收款单的编辑和导出」。
 *
 * 所以这个模块是**两种单据共用的一份实现**：版式、借贷合计、人民币大写、校验、xlsx 渲染都是同一套，
 * 差别只在少数几个字段的**用词**与「钱从哪一侧走」（`SLIP_KIND_LABELS`）。把它们写成两份的代价
 * 不是多敲一遍字，而是「付款单修好的一个大写金额 bug，收款单上还在」。
 *
 * 这个模块负责三件事，全部是**纯函数**（不碰数据库，可单测）：
 *   1. 版式：把 `FinanceSlip` 渲染成与财务模板逐格对齐的 xlsx（`renderFinanceSlipWorkbook`）；
 *   2. 口径：借贷合计与平衡判定（`slipTotals`）、人民币大写（`amountInWords`）；
 *   3. 校验：导出一张「账对不上」的单子比不导出更糟 —— 不平衡、缺对方单位、行里没金额，
 *      都在这里被挡下并给出**具体是哪一行**的原因（`validateFinanceSlip`）。
 *
 * ## 三条刻意的口径
 *
 * 1. **金额一律是 Excel 数值类型**（`numFmt = 0.####`），与全站导出的硬约束一致：
 *    文本型数字在 Excel 里 `SUM` 得 0、筛选分不出区间、排序按字典序（见 finance-report-workbook.ts）。
 *
 * 2. **不按税率自动拆进项税**（付款侧）/ **不自动拆收入与税**（收款侧）。系统里的采购单价是含税价，
 *    `不含税 = 含税 ÷ (1+税率)` 在取得普票（不抵扣）、优惠税率或部分抵扣时会被自动填错，而这种错误
 *    在单子看不出来。预填只给「一行一条、金额全额」，要拆由财务自己加行 —— 这正是用户说的
 *    「我可以自己填加行」。这与记账凭证模板（`voucher-template.ts`）是同一条既定口径。
 *
 * 3. **借贷不平衡不许导出**。单子是要拿去走付款/收款与签字的原始单据，借贷不平流出去就是一张错账凭证；
 *    界面上实时显示差额、导出接口再校验一次（两处同一套 `slipTotals`）。
 */

/** 单据种类：付款单 / 收款单。 */
export type FinanceSlipKind = "payment" | "receipt";

/** 单子里的一行（= 模板里的一行分录：摘要 / 总账科目 / 明细科目 / 借方 / 贷方 / 备注）。 */
export type FinanceSlipLine = {
  summary: string;
  general_subject: string;
  detail_subject: string;
  /** 十进制字符串（最多 4 位小数）；空串表示这一侧没有金额。 */
  debit: string;
  credit: string;
  remark: string;
};

/** 一张收/付款单。字段名与模板逐格对应（设计文档有对照表），字段名本身**与种类无关**。 */
export type FinanceSlip = {
  kind: FinanceSlipKind;
  /** 单据编号（模板里的 `FK-202609-001`）。系统给一个**建议值**，财务可以直接改成自己本子上的号。 */
  slip_no: string;
  /** 单据日期 `YYYY-MM-DD`（付款单是付款日期、收款单是收款日期）。 */
  slip_date: string;
  /** 结算方式（银行转账 / 现金 / 承兑……）。 */
  slip_method: string;
  /** 对方单位：付款单是收款单位（供应商），收款单是付款单位（客户）。 */
  counterparty_name: string;
  /** 对方开户银行。 */
  bank_name: string;
  /** 对方银行账号。 */
  bank_account: string;
  /** 附单据张数。 */
  attachment_count: number;
  /** 付款备注 / 收款备注（模板表头下方那一行，用户明确要求「我可以写付款备注」）。 */
  remark: string;
  /** 制单人（签字栏）。 */
  maker: string;
  lines: FinanceSlipLine[];
  /** 表尾落款（`makerStamp(user)`）：这份文件是谁、什么时候生成的。 */
  footnote?: string;
};

// --------------------------------------------------------------------------- 金额

const MONEY = /^(\d+)(?:\.(\d{1,4}))?$/;

/** 金额文本 → 整数「分」（1e-4 精度）。非法或 ≤ 0 返回 null。 */
export function parseAmount(value: string | null | undefined): bigint | null {
  const match = MONEY.exec((value ?? "").trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  const units = BigInt(`${whole}${fraction.padEnd(4, "0")}`);
  return units > 0n ? units : null;
}

/** 整数「分」→ 十进制字符串（去掉无意义的尾零）。 */
export function formatAmount(units: bigint): string {
  const fraction = (units % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${units / 10000n}.${fraction}` : `${units / 10000n}`;
}

export type SlipTotals = {
  /** 借方合计 / 贷方合计（十进制字符串）。 */
  debit: string;
  credit: string;
  /** 借贷相等且都大于零。 */
  balanced: boolean;
  /** 有任一行的金额非法（既不是正数、又同时两边都填了）。 */
  invalid: boolean;
  /** 整张单一行金额都没有。 */
  empty: boolean;
};

/**
 * 借贷合计。
 *
 * 用 BigInt「分」而不是 `Number`：这张单的合计要拿去和用户逐位比对、并决定导出按钮能不能点，
 * 浮点求和的 `0.1 + 0.2 = 0.30000000000000004` 会让财务看到「明明平了却不让导出」
 * （与凭证分录编辑器同一条理由，见 `voucher.domain.ts` 的 toCents）。
 *
 * 一行同时填了借贷两边算 `invalid` —— 分录只能在一侧，两边都填是「这一行自己就不平」。
 */
export function slipTotals(lines: readonly FinanceSlipLine[]): SlipTotals {
  let debit = 0n;
  let credit = 0n;
  let invalid = false;
  let money = false;
  for (const line of lines) {
    const left = parseAmount(line.debit);
    const right = parseAmount(line.credit);
    if (left !== null && right !== null) { invalid = true; continue; }
    // 两侧都空 = 这一行没有金额。它是「还没填完」，不是「填错了」，所以不置 invalid；
    // 由 validateFinanceSlip 单独给一句「第 N 行请填写借方或贷方金额」。
    if (left === null && right === null) continue;
    // 非空但不是合法正数（`abc` / `-5` / `0`）才是 invalid：这里必须能区分出这两种情况。
    if (left === null && (line.debit ?? "").trim() !== "") { invalid = true; continue; }
    if (right === null && (line.credit ?? "").trim() !== "") { invalid = true; continue; }
    money = true;
    if (left !== null) debit += left; else credit += right!;
  }
  return {
    debit: formatAmount(debit),
    credit: formatAmount(credit),
    // 两边都大于零且相等才算平衡：只有借方（或只有贷方）的单子合计相等也无意义。
    balanced: money && debit > 0n && debit === credit,
    invalid,
    empty: !money,
  };
}

// --------------------------------------------------------------------------- 校验

export type SlipProblem = { code: string; message: string; details: Array<Record<string, unknown>> };

/**
 * 导出一张单子前的校验。**返回全部问题**（不是抛第一个）：界面上一次把「第 2 行没金额、
 * 第 5 行两边都填了」说清楚，比让财务改一个、导出一次、再被告知下一个要快得多。
 *
 * 错误码是**与种类无关**的 `SLIP_*`（文案里才出现「付款单 / 收款单」）：同一套规则、同一套码，
 * 前端与测试不必为两种单据各记一套码。对方的称谓取自 `slipLabels(kind)`，
 * 所以收款单报的是「收款单必须填写付款单位」而不是「收款单位」。
 */
export function validateFinanceSlip(slip: FinanceSlip): SlipProblem[] {
  const labels = slipLabels(slip.kind);
  const problems: SlipProblem[] = [];
  if (!slip.slip_no.trim()) problems.push({ code: "SLIP_NO_REQUIRED", message: `${labels.name}必须填写单据编号`, details: [{ field: "slip_no" }] });
  if (!slip.counterparty_name.trim()) problems.push({ code: "SLIP_COUNTERPARTY_REQUIRED", message: `${labels.name}必须填写${labels.counterpartyLabel.replace("：", "")}`, details: [{ field: "counterparty_name" }] });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slip.slip_date ?? "") || Number.isNaN(new Date(`${slip.slip_date}T00:00:00.000Z`).valueOf())) {
    problems.push({ code: "SLIP_DATE_INVALID", message: `${labels.dateLabel.replace("：", "")}无效（应为 YYYY-MM-DD）`, details: [{ field: "slip_date" }] });
  }
  if (!Number.isInteger(slip.attachment_count) || slip.attachment_count < 0) {
    problems.push({ code: "SLIP_ATTACHMENT_INVALID", message: "附单据张数必须是非负整数", details: [{ field: "attachment_count" }] });
  }
  if (slip.lines.length === 0) {
    problems.push({ code: "SLIP_LINE_REQUIRED", message: `${labels.name}至少需要一行分录`, details: [] });
    return problems;
  }
  slip.lines.forEach((line, index) => {
    const row = index + 1;
    if (!line.summary?.trim() && !line.general_subject?.trim()) {
      // 模板里「摘要」与「总账科目」是两列，财务写的时候常常只填其中一列（模板样张第 2 行就是把
      // 科目名写在了摘要里），所以这两列有一列就算写过了 —— 只报「两列都空」的行。
      problems.push({ code: "SLIP_LINE_TEXT_REQUIRED", message: `第 ${row} 行请填写摘要或总账科目`, details: [{ row }] });
    }
    const left = parseAmount(line.debit);
    const right = parseAmount(line.credit);
    const leftText = (line.debit ?? "").trim();
    const rightText = (line.credit ?? "").trim();
    if (leftText && rightText) {
      problems.push({ code: "SLIP_LINE_BOTH_SIDES", message: `第 ${row} 行不能同时填写借方与贷方金额`, details: [{ row }] });
      return;
    }
    if (!leftText && !rightText) {
      problems.push({ code: "SLIP_LINE_AMOUNT_REQUIRED", message: `第 ${row} 行请填写借方或贷方金额`, details: [{ row }] });
      return;
    }
    const value = leftText ? left : right;
    if (value === null) {
      problems.push({ code: "SLIP_LINE_AMOUNT_INVALID", message: `第 ${row} 行金额必须是大于零的数字（最多 4 位小数）`, details: [{ row }] });
    }
  });
  const totals = slipTotals(slip.lines);
  if (!totals.invalid && !problems.some((problem) => problem.code.startsWith("SLIP_LINE_AMOUNT"))) {
    if (totals.empty) problems.push({ code: "SLIP_LINE_REQUIRED", message: `${labels.name}至少需要一行有金额的分录`, details: [] });
    else if (!totals.balanced) {
      problems.push({
        code: "SLIP_NOT_BALANCED",
        message: `借贷不平衡：借方 ${totals.debit} / 贷方 ${totals.credit}`,
        details: [{ debit: totals.debit, credit: totals.credit }],
      });
    }
  }
  return problems;
}

// --------------------------------------------------------------------------- 人民币大写

const UPPER_DIGITS = "零壹贰叁肆伍陆柒捌玖";
const UPPER_POSITIONS = ["", "拾", "佰", "仟"];
/** 四位一节的节权位。金额来自 DECIMAL(18,4)，到「万亿」足够；再大由 `amountInWords` 显式报错。 */
const UPPER_GROUPS = ["", "万", "亿", "万亿"];

/** 四位整数（0–9999）→ 大写，例如 1005 → 壹仟零伍、15 → 壹拾伍。 */
function fourDigitsUpper(value: number): string {
  const text = String(value).padStart(4, "0");
  let out = "";
  let zeroPending = false;
  for (let index = 0; index < 4; index += 1) {
    const digit = Number(text[index]);
    const position = 3 - index;
    if (digit === 0) {
      // 只在**已经写过数字之后**记一个待补的「零」：0005 不能写成「零伍」。
      if (out) zeroPending = true;
      continue;
    }
    if (zeroPending) { out += "零"; zeroPending = false; }
    out += UPPER_DIGITS[digit] + UPPER_POSITIONS[position];
  }
  return out;
}

/** 整数部分 → 大写（如 140000 → 壹拾肆万、100000005 → 壹亿零伍）。 */
function integerUpper(value: bigint): string {
  if (value === 0n) return "零";
  const groups: number[] = [];
  let rest = value;
  while (rest > 0n) { groups.push(Number(rest % 10000n)); rest /= 10000n; }
  if (groups.length > UPPER_GROUPS.length) throw new RangeError("amount-too-large");
  let out = "";
  let zeroGap = false;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === 0) { zeroGap = true; continue; }
    // 节内不足四位（< 1000）或中间有整节为零时必须补「零」，否则「壹亿伍仟零伍」会读成
    // 「壹亿伍仟伍」——中文大写里这个零是金额位数的唯一线索。
    if (out && (group < 1000 || zeroGap)) out += "零";
    out += fourDigitsUpper(group) + UPPER_GROUPS[index];
    zeroGap = false;
  }
  return out;
}

/**
 * 金额 → 人民币大写（模板里「付款金额（大写）」那一格）。
 *
 * 与模板样张逐字对齐：`149.50 → 壹佰肆拾玖元伍角整`（角后无分补「整」）、
 * `100 → 壹佰元整`、`0.05 → 伍分`、`0.50 → 伍角整`。
 *
 * 只分到「分」（2 位）：银行单据上厘及以下没有意义 —— 输入 4 位小数时**四舍五入到分**
 * （`1.005 → 壹元零壹分`），而不是截断，否则合计与单据金额会差一分。
 *
 * ⚠️ 这个函数**只有后端一份实现**：导出的文件是权威。前端编辑器刻意不预览大写金额，
 * 免得「金额转中文」这套规则在两个 workspace 里各写一份、慢慢算不到一起去
 * （前端确需预览时，应改为由本模块提供接口，而不是再抄一遍）。
 */
export function amountInWords(value: string): string {
  const units = parseAmount(value);
  if (units === null) throw new RangeError("invalid-amount");
  // 1e-4 精度 → 1e-2 精度：+50 再整除 100 即四舍五入到分。
  const cents = (units + 50n) / 100n;
  const yuan = cents / 100n;
  const jiao = (cents / 10n) % 10n;
  const fen = cents % 10n;
  const head = yuan === 0n ? "" : `${integerUpper(yuan)}元`;
  if (jiao === 0n && fen === 0n) return `${head || "零元"}整`;
  if (fen === 0n) return `${head}${UPPER_DIGITS[Number(jiao)]}角整`;
  // 「零」只用在「元」与「分」之间（壹元零伍分）；金额不足一元时直接写「伍分」，
  // 不写成「零伍分」—— 那是读不出金额的错误写法。
  if (jiao === 0n) return `${head ? `${head}零` : ""}${UPPER_DIGITS[Number(fen)]}分`;
  return `${head}${UPPER_DIGITS[Number(jiao)]}角${UPPER_DIGITS[Number(fen)]}分`;
}

// --------------------------------------------------------------------------- 版式（xlsx）

const BODY_FONT: Partial<ExcelJS.Font> = { name: "宋体", size: 11 };
const LABEL_FONT: Partial<ExcelJS.Font> = { name: "宋体", size: 11 };
const TITLE_FONT: Partial<ExcelJS.Font> = { name: "宋体", size: 16, bold: true };
const HEADER_FONT: Partial<ExcelJS.Font> = { name: "宋体", size: 11, bold: true };
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

/** 列宽与财务模板逐列对齐：A 摘要（也是表头标签列）/ B 总账科目 / C 明细科目 / D 借方 / E 贷方 / F 备注。 */
const SLIP_COLUMNS = [{ width: 30 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 20 }];
const LAST_COLUMN = "F";

/**
 * 表头字段的显示名（模板上的写法）。测试靠它定位，改文案就会红。
 *
 * 分成两段：`SLIP_LABELS` 是两种单据共用的部分（摘要 / 借贷 / 签字栏……），
 * `SLIP_KIND_LABELS` 是只差用词的那几格。收款单不是「付款单换三个字」——
 * 对方的称谓（收款单位 ↔ 付款单位）、日期与方式的说法、大写金额与备注的抬头、签字栏最后那一格
 * （领款人 ↔ 交款人）都要跟着变，所以这里一处列出、一处取用。
 */
export const SLIP_LABELS = {
  slipNo: "单据编号：",
  bankName: "开户银行：",
  bankAccount: "银行账号：",
  attachment: "附单据：",
  attachmentUnit: "张",
  summary: "摘要",
  generalSubject: "总账科目",
  detailSubject: "明细科目",
  debit: "借方金额（元）",
  credit: "贷方金额（元）",
  remarkColumn: "备注",
  total: "合  计",
  balanced: "√借贷平衡",
  maker: "制单人：",
  reviewer: "审核：",
  cashier: "出纳：",
  department: "部门审批：",
  financeHead: "财务负责人：",
} as const;

export const SLIP_KIND_LABELS: Record<FinanceSlipKind, {
  /** 单据名（用于错误文案与 sheet 名）。 */
  name: string;
  title: string;
  counterpartyLabel: string;
  dateLabel: string;
  methodLabel: string;
  amountInWordsLabel: string;
  remarkLabel: string;
  /** 签字栏最后一格：付款单是领款人，收款单是交款人。 */
  signerLabel: string;
  /** 导出文件名前缀。 */
  filePrefix: string;
  /** 单号建议值的前缀：付款单 FK、收款单 SK。 */
  numberPrefix: string;
}> = {
  payment: {
    name: "付款单", title: "付 款 单", counterpartyLabel: "收款单位：", dateLabel: "付款日期：",
    methodLabel: "付款方式：", amountInWordsLabel: "付款金额（大写）：", remarkLabel: "付款备注：",
    signerLabel: "领款人：", filePrefix: "迪礼付款单", numberPrefix: "FK",
  },
  receipt: {
    name: "收款单", title: "收 款 单", counterpartyLabel: "付款单位：", dateLabel: "收款日期：",
    methodLabel: "收款方式：", amountInWordsLabel: "收款金额（大写）：", remarkLabel: "收款备注：",
    signerLabel: "交款人：", filePrefix: "迪礼收款单", numberPrefix: "SK",
  },
};

/** 一张单据的完整标签集（共用部分 + 该种类特有的用词）。 */
export type SlipLabelSet = typeof SLIP_LABELS & (typeof SLIP_KIND_LABELS)[FinanceSlipKind];

export function slipLabels(kind: FinanceSlipKind): SlipLabelSet {
  return { ...SLIP_LABELS, ...SLIP_KIND_LABELS[kind] };
}

/**
 * 空值归一化：空串 / 全空白 → `null`（真正的空单元格）。
 *
 * 为什么不能写空串：ExcelJS 写 `""` 会落成一个**文本单元格**，读回来是 `""` 而不是空 ——
 * 那既干扰筛选，也让「系统没有这个数据」与「这里写了个空」看起来一样
 * （与报表导出「缺字段就是空单元格，不写 0 也不写空串」同一条纪律）。
 */
function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

/** 给一个区域上边框、字体与对齐（合并单元格后仍要逐格描边，否则 Excel 里只画最外圈）。 */
function paint(sheet: ExcelJS.Worksheet, range: string, options: { font?: Partial<ExcelJS.Font>; align?: Partial<ExcelJS.Alignment>; numFmt?: string } = {}): void {
  const [start, end] = range.split(":");
  const from = sheet.getCell(start);
  const to = sheet.getCell(end ?? start);
  for (let row = from.row; row <= to.row; row += 1) {
    for (let column = from.col; column <= to.col; column += 1) {
      const cell = sheet.getCell(row, column);
      cell.border = THIN_BORDER;
      cell.font = options.font ?? BODY_FONT;
      cell.alignment = { vertical: "middle", ...(options.align ?? {}) };
      if (options.numFmt) cell.numFmt = options.numFmt;
    }
  }
}

/** 合并区域并写入左上角的值（先合并再写，避免 ExcelJS 把非左上角的值丢掉）。 */
function merged(sheet: ExcelJS.Worksheet, range: string, value: ExcelJS.CellValue, options: { font?: Partial<ExcelJS.Font>; align?: Partial<ExcelJS.Alignment>; numFmt?: string } = {}): void {
  sheet.mergeCells(range);
  const cell = sheet.getCell(range.split(":")[0]);
  cell.value = value;
  paint(sheet, range, options);
}

/**
 * 渲染收/付款单工作簿。
 *
 * 版式与财务给的模板**逐格对齐**（标题、四行表头、分录表、合计行、大写行、备注行、两行签字栏），
 * 差别只有一处：表尾多一行落款（`制表人 / 制表时间`），与全站导出件同一套纪律
 * （那份文件是谁、什么时候生成的）。
 */
export async function renderFinanceSlipWorkbook(slip: FinanceSlip): Promise<Buffer> {
  const labels = slipLabels(slip.kind);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(labels.name, {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  });
  sheet.columns = SLIP_COLUMNS;

  // R1 标题
  merged(sheet, `A1:${LAST_COLUMN}1`, labels.title, { font: TITLE_FONT, align: { horizontal: "center" } });
  sheet.getRow(1).height = 30;

  // R2 单据编号 / 单据日期 / 结算方式 —— 三组「标签 + 值」正好占满六列（与模板同一行同一顺序）。
  const metaRow = (row: number, groups: Array<[string, string]>): void => {
    groups.forEach(([label, value], index) => {
      sheet.getCell(row, index * 2 + 1).value = label;
      sheet.getCell(row, index * 2 + 2).value = text(value);
    });
    paint(sheet, `A${row}:${LAST_COLUMN}${row}`, { font: LABEL_FONT });
  };
  metaRow(2, [
    [labels.slipNo, slip.slip_no],
    [labels.dateLabel, slip.slip_date],
    [labels.methodLabel, slip.slip_method || "银行转账"],
  ]);

  // R3 对方单位 / 开户银行：开户行的名字比「一格」宽，所以它的值跨 D:F。
  sheet.getCell("A3").value = labels.counterpartyLabel;
  sheet.getCell("B3").value = text(slip.counterparty_name);
  sheet.getCell("C3").value = labels.bankName;
  merged(sheet, `D3:${LAST_COLUMN}3`, text(slip.bank_name), { font: LABEL_FONT });
  paint(sheet, "A3:C3", { font: LABEL_FONT });

  // R4 银行账号 / 附单据 N 张：账号跨 B:C，张数在 E、单位在 F（与模板逐格一致）。
  sheet.getCell("A4").value = labels.bankAccount;
  merged(sheet, "B4:C4", text(slip.bank_account), { font: LABEL_FONT });
  sheet.getCell("D4").value = labels.attachment;
  sheet.getCell("E4").value = slip.attachment_count;
  sheet.getCell("F4").value = labels.attachmentUnit;
  paint(sheet, "A4", { font: LABEL_FONT });
  paint(sheet, "D4:F4", { font: LABEL_FONT });

  // R5 表头
  const headers = [labels.summary, labels.generalSubject, labels.detailSubject, labels.debit, labels.credit, labels.remarkColumn];
  headers.forEach((header, index) => { sheet.getCell(5, index + 1).value = header; });
  paint(sheet, `A5:${LAST_COLUMN}5`, { font: HEADER_FONT, align: { horizontal: "center", wrapText: true } });
  sheet.getRow(5).height = 22;

  // R6.. 分录行
  slip.lines.forEach((line, index) => {
    const row = 6 + index;
    sheet.getCell(row, 1).value = text(line.summary);
    sheet.getCell(row, 2).value = text(line.general_subject);
    sheet.getCell(row, 3).value = text(line.detail_subject);
    // 借贷金额落**数值**（不是字符串）：财务拿到文件要能 SUM、能排序、能筛选。
    const debit = toExportNumber(line.debit);
    const credit = toExportNumber(line.credit);
    if (debit !== null) { sheet.getCell(row, 4).value = debit; sheet.getCell(row, 4).numFmt = NUMBER_FORMAT; }
    if (credit !== null) { sheet.getCell(row, 5).value = credit; sheet.getCell(row, 5).numFmt = NUMBER_FORMAT; }
    sheet.getCell(row, 6).value = text(line.remark);
    paint(sheet, `A${row}:${LAST_COLUMN}${row}`, {
      align: { horizontal: "left", wrapText: true },
    });
    sheet.getCell(row, 4).alignment = { horizontal: "right", vertical: "middle" };
    sheet.getCell(row, 5).alignment = { horizontal: "right", vertical: "middle" };
    sheet.getRow(row).height = 20;
  });

  const totals = slipTotals(slip.lines);
  const totalRow = 6 + slip.lines.length;
  merged(sheet, `A${totalRow}:C${totalRow}`, labels.total, { font: HEADER_FONT, align: { horizontal: "center" } });
  sheet.getCell(totalRow, 4).value = toExportNumber(totals.debit);
  sheet.getCell(totalRow, 4).numFmt = NUMBER_FORMAT;
  sheet.getCell(totalRow, 5).value = toExportNumber(totals.credit);
  sheet.getCell(totalRow, 5).numFmt = NUMBER_FORMAT;
  sheet.getCell(totalRow, 6).value = labels.balanced;
  paint(sheet, `D${totalRow}:${LAST_COLUMN}${totalRow}`, { font: HEADER_FONT });
  sheet.getCell(totalRow, 4).alignment = { horizontal: "right", vertical: "middle" };
  sheet.getCell(totalRow, 5).alignment = { horizontal: "right", vertical: "middle" };
  sheet.getCell(totalRow, 6).alignment = { horizontal: "center", vertical: "middle" };

  // 金额大写：小写金额落 F 列（模板里 ¥149.50 就在备注列下方）
  const wordsRow = totalRow + 1;
  sheet.getCell(wordsRow, 1).value = labels.amountInWordsLabel;
  merged(sheet, `B${wordsRow}:E${wordsRow}`, amountInWords(totals.debit), { font: BODY_FONT });
  sheet.getCell(wordsRow, 6).value = toExportNumber(totals.debit);
  sheet.getCell(wordsRow, 6).numFmt = NUMBER_FORMAT;
  paint(sheet, `A${wordsRow}`, { font: LABEL_FONT });
  paint(sheet, `F${wordsRow}`, { align: { horizontal: "right" } });

  // 备注（用户明确要求「我可以写付款备注」）：跨列写字，行高给两行，长备注不至于被截断。
  const remarkRow = wordsRow + 1;
  sheet.getCell(remarkRow, 1).value = labels.remarkLabel;
  merged(sheet, `B${remarkRow}:${LAST_COLUMN}${remarkRow}`, text(slip.remark), { align: { horizontal: "left", wrapText: true } });
  paint(sheet, `A${remarkRow}`, { font: LABEL_FONT });
  sheet.getRow(remarkRow).height = 30;

  // 签字栏（两行三格），值只填制单人 —— 其余是留给手签的空格。
  const signRow = remarkRow + 1;
  metaRow(signRow, [
    [labels.maker, slip.maker],
    [labels.reviewer, ""],
    [labels.cashier, ""],
  ]);
  metaRow(signRow + 1, [
    [labels.department, ""],
    [labels.financeHead, ""],
    [labels.signerLabel, ""],
  ]);
  sheet.getRow(signRow).height = 24;
  sheet.getRow(signRow + 1).height = 24;

  // 落款：与全站导出件一致（谁、什么时候生成的这份文件）。
  if (slip.footnote) {
    const noteRow = signRow + 3;
    const cell = sheet.getCell(`A${noteRow}`);
    cell.value = slip.footnote;
    cell.font = BODY_FONT;
  }

  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}

/** 导出文件名（控制器用它写 `Content-Disposition`）。 */
export function financeSlipFileName(slip: Pick<FinanceSlip, "kind" | "slip_no">): string {
  return `${SLIP_KIND_LABELS[slip.kind].filePrefix}-${slip.slip_no.trim() || "未编号"}.xlsx`;
}
