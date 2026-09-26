import * as ExcelJS from "exceljs";
import { NUMBER_FORMAT, toExportNumber } from "./finance-report.domain";
import { amountInWords } from "./finance-slip";

/**
 * 跨行转账单（财务 2026-09-24 交付的 `example/财务/跨行转账单.html`）。
 *
 * 用户的原始要求：「银行账户互转的时候，`跨行转账单.html`，支持编辑这个样式的表单，
 * 并且支持导出打印」——所以这是**银行余额互转**那张单子的纸质件：付款方/收款方各自的全称、
 * 账号、开户行（收款方还要联行号），转账金额（原币 + 折合人民币 + 汇率）、金额大写、用途附言，
 * 以及制单 / 复核 / 出纳 / 审批四个签字格。
 *
 * ## 三条口径
 *
 * 1. **单子不落库**：与收/付款单同一处理（见 `finance-slip.ts`）。它是一张交给银行的打印件，
 *    系统里的那份事实是 `bank_transfers` 记录本身；界面上的改动（用途附言、联行号、
 *    财务自己修过的收款人名称）只影响这一次导出的文件。
 *
 * 2. **字段名照抄 HTML 模板的 `data-docx-field`**（`payer_account` / `payee_bank_no` / `amount_cny`…）。
 *    财务给的那个文件里有 19 个占位符，名字对齐之后「模板上的哪一格对应这里的哪个字段」是查得到的；
 *    自己另起一套 camelCase 名字，以后拿到模板的新版本就得再对一次。
 *
 * 3. **金额大写只有一个实现**：复用 `finance-slip.ts` 的 `amountInWords`（人民币大写规则写两遍，
 *    迟早两边算不到一起去）。这张单子额外允许财务**自己写大写**（外币转账时「折合人民币」可能没有），
 *    但填了就必须与系统算出来的一致 —— 一张大写与小写对不上的银行单据会被退回或被读错。
 */

/** 跨行转账单的全部格子（字段名 = HTML 模板里的 `data-docx-field`）。 */
export type BankTransferSlip = {
  /** 来源互转单 id（可空：这张单子也可以脱离系统记录手写一张）。只用于审计里追回源单。 */
  transfer_id: string;
  /** 单据编号（模板里那一格；互转单本身有 `transferNo`，预填时就取它）。 */
  document_no: string;
  payer_name: string;
  payer_account: string;
  payer_bank: string;
  payee_name: string;
  payee_account: string;
  payee_bank: string;
  /** 收款方联行号（CNAPS）。**目前不存档**：银行账户里没有这一列，所以每次由财务填/改。 */
  payee_bank_no: string;
  /** 转账日期 `YYYY-MM-DD`。 */
  transfer_date: string;
  /** 付款方币种（外币转账时是原币的币种）。 */
  currency: string;
  /** 汇率（同币种为 1）。 */
  exchange_rate: string;
  /** 转账金额（原币）。 */
  amount_original: string;
  /** 折合人民币（没有人民币腿时留空：外币转外币时这一格本来就没有意义）。 */
  amount_cny: string;
  /** 金额大写。留空时由系统按上面的金额算（见 `transferSlipWords`）。 */
  amount_in_words: string;
  /** 用途／附言。 */
  remark: string;
  maker: string;
  reviewer: string;
  cashier: string;
  approver: string;
  /** 表尾落款（`makerStamp(user)`）。 */
  footnote?: string;
};

export type TransferSlipProblem = { code: string; message: string; details: Array<Record<string, unknown>> };

/** 折合人民币那一格的**计算口径**：谁的腿是人民币，取谁；两条腿都不是人民币时没有这一格。 */
export function transferSlipCnyAmount(slip: Pick<BankTransferSlip, "currency" | "amount_original" | "amount_cny">): string {
  if (isCny(slip.currency)) return slip.amount_original.trim();
  return slip.amount_cny.trim();
}

/**
 * 系统算出来的大写金额；算不出来（没有人民币腿 / 金额不合法）时返回 null。
 *
 * `amountInWords` 对非法金额抛 `RangeError`，这里**不对外抛**：校验那条路会给出人话的错误，
 * 渲染这条路只需要一个「算不出来」的信号（大写留空仍可导出，财务可以自己写）。
 */
export function transferSlipWords(slip: Pick<BankTransferSlip, "currency" | "amount_original" | "amount_cny">): string | null {
  const cny = transferSlipCnyAmount(slip);
  if (!cny) return null;
  try {
    return amountInWords(cny);
  } catch {
    return null;
  }
}

/** 单据上最终印出来的大写：财务写了就用她写的（校验已经保证它一致），否则用算出来的。 */
export function transferSlipFinalWords(slip: BankTransferSlip): string {
  return slip.amount_in_words.trim() || transferSlipWords(slip) || "";
}

function isCny(currency: string): boolean {
  return currency.trim().toUpperCase() === "CNY";
}

/** 金额是否为正的十进制数（与 `finance-slip.ts` 的 `parseAmount` 同一形状，但允许 0 之外的写法）。 */
function positive(text: string): boolean {
  return /^\d+(?:\.\d{1,4})?$/.test(text.trim()) && Number(text) > 0;
}

/**
 * 导出前的校验：**返回全部问题**（一次说完，而不是改一个试一次）。
 *
 * 必填的是「一张银行单据没有它就无效」的那些格子：单据编号、双方全称与账号、日期、原币金额。
 * 开户行、联行号、汇率、折合人民币、用途、四个签字格都可以留空 —— 签字格本来就是留着手签的。
 */
export function validateBankTransferSlip(slip: BankTransferSlip): TransferSlipProblem[] {
  const problems: TransferSlipProblem[] = [];
  if (!slip.document_no.trim()) problems.push({ code: "TRANSFER_SLIP_NO_REQUIRED", message: "跨行转账单必须填写单据编号", details: [{ field: "document_no" }] });
  if (!slip.payer_name.trim()) problems.push({ code: "TRANSFER_SLIP_PAYER_REQUIRED", message: "请填写付款人全称", details: [{ field: "payer_name" }] });
  if (!slip.payer_account.trim()) problems.push({ code: "TRANSFER_SLIP_PAYER_ACCOUNT_REQUIRED", message: "请填写付款账号", details: [{ field: "payer_account" }] });
  if (!slip.payee_name.trim()) problems.push({ code: "TRANSFER_SLIP_PAYEE_REQUIRED", message: "请填写收款人全称", details: [{ field: "payee_name" }] });
  if (!slip.payee_account.trim()) problems.push({ code: "TRANSFER_SLIP_PAYEE_ACCOUNT_REQUIRED", message: "请填写收款账号", details: [{ field: "payee_account" }] });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slip.transfer_date ?? "") || Number.isNaN(new Date(`${slip.transfer_date}T00:00:00.000Z`).valueOf())) {
    problems.push({ code: "TRANSFER_SLIP_DATE_INVALID", message: "转账日期无效（应为 YYYY-MM-DD）", details: [{ field: "transfer_date" }] });
  }
  if (!positive(slip.amount_original)) {
    problems.push({ code: "TRANSFER_SLIP_AMOUNT_INVALID", message: "转账金额（原币）必须是大于零的数字（最多 4 位小数）", details: [{ field: "amount_original" }] });
  }
  if (slip.amount_cny.trim() && !positive(slip.amount_cny)) {
    problems.push({ code: "TRANSFER_SLIP_CNY_AMOUNT_INVALID", message: "折合人民币必须是大于零的数字（最多 4 位小数），没有人民币腿就留空", details: [{ field: "amount_cny" }] });
  }
  if (slip.exchange_rate.trim() && !positive(slip.exchange_rate)) {
    problems.push({ code: "TRANSFER_SLIP_RATE_INVALID", message: "汇率必须是大于零的数字（最多 6 位小数），人民币转账可留空", details: [{ field: "exchange_rate" }] });
  }
  // 大写：自己写了就必须与系统算出的一致（外币转外币时系统算不出来，写什么由财务决定）。
  const expected = transferSlipWords(slip);
  if (slip.amount_in_words.trim() && expected && slip.amount_in_words.trim() !== expected) {
    problems.push({
      code: "TRANSFER_SLIP_WORDS_MISMATCH",
      message: `金额大写与折合人民币不一致：${transferSlipCnyAmount(slip)} 应写作「${expected}」`,
      details: [{ field: "amount_in_words", expected }],
    });
  }
  return problems;
}

/* --------------------------------------------------------------------------- 版式（xlsx） */

const BODY_FONT: Partial<ExcelJS.Font> = { name: "宋体", size: 11 };
const LABEL_FONT: Partial<ExcelJS.Font> = { name: "宋体", size: 11, bold: true };
const TITLE_FONT: Partial<ExcelJS.Font> = { name: "黑体", size: 16, bold: true };
const SECTION_FONT: Partial<ExcelJS.Font> = { name: "黑体", size: 11, bold: true };
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

/** 四列与 HTML 模板逐列对齐：A 标签 / B 值 / C 标签 / D 值（宽行把值合并到 B:D）。 */
const SLIP_COLUMNS = [{ width: 18 }, { width: 26 }, { width: 18 }, { width: 26 }];
const LAST_COLUMN = "D";

/**
 * 模板上的固定文案。**与 `example/财务/跨行转账单.html` 逐字一致**（含全角空格与「／」），
 * 改一个字就会让打印件与财务手上的样张对不上，测试逐个钉住这些串。
 */
export const TRANSFER_SLIP_LABELS = {
  title: "跨行转账单",
  documentNo: "单据编号：",
  payerSection: "付　款　方",
  payerName: "付款人全称",
  payerAccount: "付款账号",
  payerBank: "付款开户行",
  payeeSection: "收　款　方",
  payeeName: "收款人全称",
  payeeAccount: "收款账号",
  payeeBank: "收款开户行",
  payeeBankNo: "联行号",
  transferDate: "转账日期",
  amountSection: "转　账　金　额",
  currency: "币种",
  exchangeRate: "汇率",
  amountOriginal: "转账金额（原币）",
  amountCny: "折合人民币",
  amountInWords: "金额大写",
  remark: "用途／附言",
  maker: "制单人：",
  reviewer: "复核：",
  cashier: "出纳：",
  approver: "审批：",
  note: "注：涉及外币转账时，请填写汇率及折合人民币金额；人民币转账可划去汇率栏。",
} as const;

/** 空值归一化：空串 / 全空白 → `null`（真正的空单元格，与全站导出同一纪律）。 */
function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

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

function merged(sheet: ExcelJS.Worksheet, range: string, value: ExcelJS.CellValue, options: { font?: Partial<ExcelJS.Font>; align?: Partial<ExcelJS.Alignment>; numFmt?: string } = {}): void {
  sheet.mergeCells(range);
  const cell = sheet.getCell(range.split(":")[0]);
  cell.value = value;
  paint(sheet, range, options);
}

/**
 * 渲染跨行转账单 xlsx。
 *
 * 版式照 `example/财务/跨行转账单.html` 的三段（付款方 / 收款方 / 转账金额）逐格对齐，
 * 差别只有两处，都是全站导出的既定纪律：
 *   - 签字栏不写任何名字（**除了制单人**）：那四格是留给手签的，印上去等于替人签了；
 *   - 表尾多一行落款（谁、什么时候生成的这份文件）。
 */
export async function renderBankTransferSlipWorkbook(slip: BankTransferSlip): Promise<Buffer> {
  const labels = TRANSFER_SLIP_LABELS;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("跨行转账单", {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  });
  sheet.columns = SLIP_COLUMNS;

  // R1 标题 / R2 单据编号（靠右，与模板一致）
  merged(sheet, `A1:${LAST_COLUMN}1`, labels.title, { font: TITLE_FONT, align: { horizontal: "center" } });
  sheet.getRow(1).height = 30;
  merged(sheet, `A2:${LAST_COLUMN}2`, `${labels.documentNo}${slip.document_no.trim()}`, { align: { horizontal: "right" } });

  let row = 3;
  const section = (title: string): void => {
    merged(sheet, `A${row}:${LAST_COLUMN}${row}`, title, { font: SECTION_FONT, align: { horizontal: "center" } });
    sheet.getRow(row).height = 20;
    row += 1;
  };
  /** 一行「标签 + 值 + 标签 + 值」；值为空的格子留空（不写空串）。 */
  const pair = (leftLabel: string, leftValue: string, rightLabel: string, rightValue: string): void => {
    sheet.getCell(row, 1).value = leftLabel;
    sheet.getCell(row, 2).value = text(leftValue);
    sheet.getCell(row, 3).value = rightLabel;
    sheet.getCell(row, 4).value = text(rightValue);
    paint(sheet, `A${row}:${LAST_COLUMN}${row}`, { font: LABEL_FONT });
    paint(sheet, `B${row}`, { font: BODY_FONT, align: { horizontal: "left" } });
    paint(sheet, `D${row}`, { font: BODY_FONT, align: { horizontal: "left" } });
    sheet.getRow(row).height = 22;
    row += 1;
  };
  /** 一行的值跨 B:D（全称、大写、用途这类长文本）。 */
  const wide = (label: string, value: string, options: { numFmt?: string } = {}): void => {
    sheet.getCell(row, 1).value = label;
    merged(sheet, `B${row}:${LAST_COLUMN}${row}`, text(value), { align: { horizontal: "left", wrapText: true }, ...(options.numFmt ? { numFmt: options.numFmt } : {}) });
    paint(sheet, `A${row}`, { font: LABEL_FONT });
    sheet.getRow(row).height = 26;
    row += 1;
  };

  section(labels.payerSection);
  wide(labels.payerName, slip.payer_name);
  pair(labels.payerAccount, slip.payer_account, labels.payerBank, slip.payer_bank);

  section(labels.payeeSection);
  wide(labels.payeeName, slip.payee_name);
  pair(labels.payeeAccount, slip.payee_account, labels.payeeBank, slip.payee_bank);
  pair(labels.payeeBankNo, slip.payee_bank_no, labels.transferDate, slip.transfer_date);

  section(labels.amountSection);
  pair(labels.currency, slip.currency, labels.exchangeRate, slip.exchange_rate);
  // 金额落**数值**（不是字符串）：财务拿到文件要能 SUM、能排序（与全站导出同一硬约束）。
  const original = toExportNumber(slip.amount_original);
  const cny = toExportNumber(transferSlipCnyAmount(slip));
  sheet.getCell(row, 1).value = labels.amountOriginal;
  if (original !== null) { sheet.getCell(row, 2).value = original; sheet.getCell(row, 2).numFmt = NUMBER_FORMAT; }
  sheet.getCell(row, 3).value = labels.amountCny;
  if (cny !== null) { sheet.getCell(row, 4).value = cny; sheet.getCell(row, 4).numFmt = NUMBER_FORMAT; }
  paint(sheet, `A${row}:${LAST_COLUMN}${row}`, { font: LABEL_FONT });
  sheet.getCell(row, 2).alignment = { horizontal: "right", vertical: "middle" };
  sheet.getCell(row, 4).alignment = { horizontal: "right", vertical: "middle" };
  sheet.getRow(row).height = 24;
  row += 1;
  wide(labels.amountInWords, transferSlipFinalWords(slip));
  wide(labels.remark, slip.remark);

  row += 1;
  const signRow = row;
  [
    [labels.maker, slip.maker],
    [labels.reviewer, slip.reviewer],
    [labels.cashier, slip.cashier],
    [labels.approver, slip.approver],
  ].forEach(([label, value], index) => {
    const cell = sheet.getCell(signRow, index + 1);
    cell.value = `${label}${(value ?? "").trim()}`;
    paint(sheet, `${cell.address}`, { font: BODY_FONT, align: { horizontal: "center" } });
  });
  sheet.getRow(signRow).height = 34;

  sheet.getCell(`A${signRow + 2}`).value = labels.note;
  sheet.getCell(`A${signRow + 2}`).font = { ...BODY_FONT, color: { argb: "FF555555" } };
  if (slip.footnote) {
    const cell = sheet.getCell(`A${signRow + 3}`);
    cell.value = slip.footnote;
    cell.font = BODY_FONT;
  }

  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}

/** 导出文件名（控制器用它写 `Content-Disposition`）。 */
export function bankTransferSlipFileName(slip: Pick<BankTransferSlip, "document_no">): string {
  return `迪礼跨行转账单-${slip.document_no.trim() || "未编号"}.xlsx`;
}

/* --------------------------------------------------------------------------- 预填 */

/**
 * 一笔互转记录（只取预填要用的字段，避免与 Prisma 类型耦合 —— 纯函数才好单测）。
 */
export type BankTransferForSlip = {
  transferNo: string;
  transferDate: Date | string;
  fromCurrency: string;
  toCurrency: string;
  fromAmount: { toString(): string } | string;
  toAmount: { toString(): string } | string;
  exchangeRate: { toString(): string } | string | null;
  remark: string | null;
  fromBank: { bankName: string; accountName: string; accountNumber: string } | null;
  toBank: { bankName: string; accountName: string; accountNumber: string } | null;
};

/**
 * 互转记录 → 跨行转账单的**预填**。
 *
 * 逐格对应关系（模板 ← 系统）：
 *   - 单据编号 ← `transferNo`（互转单号，形如 `BTR-20260924-XXXXXXXX`；这格可改，
 *     财务按银行要求的编号写）；
 *   - 付款人 ← 转出账户的**账户名**（`accountName` 是我方公司全称），账号 / 开户行同理；
 *   - 收款人 ← 转入账户的账户名 / 账号 / 开户行；联行号目前**没有存档**，留空由财务填；
 *   - 币种 ← 转出币种（原币）；原币金额 ← `fromAmount`；
 *     折合人民币 ← 两条腿里**是人民币的那条**（转出是人民币就取转出，转入是人民币就取转入，
 *     两条都不是人民币则留空 —— 外币转外币没有「折合人民币」这件事）；
 *   - 汇率 ← `exchangeRate`（同币种为 1，去掉没意义的尾零）。
 *
 * 不预填的东西只有两处，都是刻意的：**联行号**（系统里没有这一列）、**四个签字格**（手签）。
 */
export function bankTransferSlipFromTransfer(transfer: BankTransferForSlip, maker: string): BankTransferSlip {
  const fromAmount = amountText(transfer.fromAmount);
  const toAmount = amountText(transfer.toAmount);
  return {
    transfer_id: "",
    document_no: transfer.transferNo,
    payer_name: transfer.fromBank?.accountName ?? "",
    payer_account: transfer.fromBank?.accountNumber ?? "",
    payer_bank: transfer.fromBank?.bankName ?? "",
    payee_name: transfer.toBank?.accountName ?? "",
    payee_account: transfer.toBank?.accountNumber ?? "",
    payee_bank: transfer.toBank?.bankName ?? "",
    // 联行号不存档：留空比填一个猜来的号安全（银行单据上一个错的联行号会把钱转到别人账上）。
    payee_bank_no: "",
    transfer_date: dateText(transfer.transferDate),
    currency: transfer.fromCurrency,
    exchange_rate: transfer.exchangeRate === null || transfer.exchangeRate === undefined ? "" : trimDecimal(amountText(transfer.exchangeRate)),
    amount_original: fromAmount,
    amount_cny: isCny(transfer.fromCurrency) ? fromAmount : isCny(transfer.toCurrency) ? toAmount : "",
    amount_in_words: "",
    remark: transfer.remark ?? "",
    maker,
    reviewer: "",
    cashier: "",
    approver: "",
  };
}

function amountText(value: { toString(): string } | string): string {
  return typeof value === "string" ? value : value.toString();
}

/** 日期列 → `YYYY-MM-DD`（`@db.Date` 读出来是 UTC 零点，截前 10 位不会偏一天）。 */
function dateText(value: Date | string): string {
  return (typeof value === "string" ? value : value.toISOString()).slice(0, 10);
}

/** 去掉十进制尾零：`7.200000` → `7.2`、`1.000000` → `1`（单据上一格写「1.000000」不像话）。 */
export function trimDecimal(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
  return trimmed.includes(".") ? trimmed.replace(/0+$/, "").replace(/\.$/, "") : trimmed;
}
