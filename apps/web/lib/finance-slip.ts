// 收/付款单编辑器的纯逻辑（**不能**放进 "use client" 文件）。
//
// 财务 2026-09-20：「她需要在付款界面能导出付款单……允许用户编辑付款单中的一些字段。
// 比如我要付款 100，我可以自己填加行，我可以写付款备注」，随后补一句「同理，收款单的编辑和导出」。
//
// 关键决定（2026-09-20）：**单子不落库** —— 它是一张打印件（银行单据），不是系统单据。所以这一块只有两件事：
//   1. 从后端预填一张（`/finance/{payment,receipt}-slips/draft`：单号 / 对方单位 / 开户行 / 科目 / 借贷行）；
//   2. 财务在界面上改（金额、增删行、备注）后提交给 `/finance/{payment,receipt}-slips.xlsx` 出文件。
//
// 2026-09-26 用户加了「保存键」（「付款单要有填写汇率的地方，保存键」），于是多了第三条路：
//   3. **存档**（`/finance/slips`：新建 / 覆盖 / 列表 / 删除）—— 存的是这张单子本身，
//      **不改任何账**（不写收支流水、不生成凭证、不动应付状态）。口径与边界见后端
//      `finance-slip-store.service.ts` 的文件头。
//
// 两种单据共用这一份实现，只在**用词**与「钱走哪一侧」上不同（`slipLabels`）——
// 与后端 `apps/api/src/modules/finance/finance-slip.ts` 是同一条口径。
//
// 本模块给编辑器提供可单测的骨架：行的形状与序列化、借贷合计与平衡判定、以及**导出按钮该不该禁用**
// 的那几条原因（与后端 `validateFinanceSlip` 同一套规则，所以不会出现「界面说能导出、后端说不行」）。
// 保存与导出**拦的不是同一批**：保存只拦结构（日期/金额格式/汇率格式），导出还要编号、对方单位与借贷平衡
// —— 财务改到一半就该能存下来（后端 `validateFinanceSlipShape` / `validateFinanceSlip` 的分层）。
//
// 金额一律按「整数分」用 BigInt 相加（与凭证分录编辑器同一条理由）：浮点求和会出现
// `0.1 + 0.2 = 0.30000000000000004`，而这张单要拿合计去和财务逐位比对、还要决定按钮能不能点。
//
// ⚠️ 「人民币大写」刻意**不在这里实现**：它是导出的那份文件里的权威字段，只有后端一份实现。
// 前端要预览时应调接口，而不是再抄一套「金额转中文」的规则。
//
// 汇率的解析（`parseSlipRate`）自带了极小的一份，这是**被迫**的：本模块被
// `finance-slip.test.mjs` 用 `node --test` 直接以 `.ts` 载入，而那种加载方式解析不了
// 「无扩展名的相对导入」（`import ... from "./exchange-rate"`）——所以可测的 lib 模块必须自包含
// （与 `material-image.ts` 当年同样的处境）。精度与后端 `money.ts` 的 `toRateUnits` 一致
// （≤8 位小数），两侧各有一条测试钉住同一批用例。

export type FinanceSlipKind = "payment" | "receipt";
/** 编辑器里的一行（六格 + 一个 React key）。 */
export type FinanceSlipEditorLine = {
  /**
   * 前端行标识。**不能用下标**：增删行之后下标会错位，React 会把上一行的输入框复用给下一行
   * （用户看到的是「删掉的行又变了」）。
   */
  key: string;
  summary: string;
  general_subject: string;
  detail_subject: string;
  debit: string;
  credit: string;
  remark: string;
};

/** 单子的表头（模板上表头那五行 + 备注 + 制单人）。字段名与种类无关，用词由 `slipLabels` 决定。 */
export type FinanceSlipHeader = {
  slip_no: string;
  slip_date: string;
  slip_method: string;
  counterparty_name: string;
  /**
   * 我方 / 对方各两格（用户 2026-09-24：「付款单/收款单上，我方和对方账户都分别设置对应的字段」）。
   *
   * 与后端 `finance-slip.ts` 是同一条口径：原来只有一对 `bank_name` / `bank_account`，
   * 而预填塞进去的是**我方**账户 —— 模板上那两格说的却是对方。拆开之后我方两格吃确认流水里的账户，
   * 对方两格由财务填（供应商能从结算信息里认出来就预填，客户认不出）。
   */
  our_bank_name: string;
  our_bank_account: string;
  counterparty_bank_name: string;
  counterparty_bank_account: string;
  /**
   * 币种。模板上**没有**这一格（后端类型里有同样的注释）：它只用于队列里分辨「哪张是哪张」——
   * 同一家供应商可能同时有 CNY 与 USD 两笔待付，而这两个字段在界面上不可编辑（来自预填）。
   */
  currency: string;
  /**
   * 汇率（用户 2026-09-26：「付款单要有填写汇率的地方」）。人民币付款可留空。
   *
   * 与后端同一精度（最多 8 位小数，见 `money.ts` 的 `toRateUnits`）：界面上用
   * `exchange-rate.ts` 的 `parseRate` 判定，两边不会出现「界面说能导出、后端说不行」。
   */
  exchange_rate: string;
  /**
   * 折合人民币。人民币付款可留空。
   *
   * **手填，前端不预览、后端不自动折算**：银行的折算价与我们的报价可能不同，
   * 而自动算出来的数在单子上看不出错（与「模板金额留空、由财务按回单填」同一取舍；
   * 2026-11-09 D5 起，专票的进项税自动拆分只发生在**挂账凭证**路径，不在本单据上）。
   */
  amount_cny: string;
  attachment_count: number;
  remark: string;
  maker: string;
};

/**
 * 后端预填接口的返回：种类 + 表头 + 分录行。
 *
 * 三个可选字段来自**存档**（2026-09-26 的「保存键」）：`id` 有值 = 这张单子已经存过，
 * 再点保存就是**覆盖它**（没有 id 才是新建）—— 少了这个字段，财务点两次保存就会得到两张一样的单子。
 */
export type FinanceSlipDraft = FinanceSlipHeader & {
  kind: FinanceSlipKind;
  lines: Array<Omit<FinanceSlipEditorLine, "key">>;
  id?: string;
  /** 预填时勾选的条目 id（只读，追溯用）。 */
  source_entry_ids?: string[];
  created_at?: string;
  updated_at?: string;
};

/**
 * 两种单据的用词。
 *
 * ⚠️ 这份文案必须与 `apps/api/src/modules/finance/finance-slip.ts` 的 `slipLabels(kind)` 逐字一致
 * （两个 workspace 之间没有共享包，只能各有一份 —— 与 `audit-time` / `beijing-time` 同一处理）。
 * 不一致的后果是界面上的列头与导出的文件对不上，而财务会拿界面上的话去核对文件。
 */
export const SLIP_LABELS = {
  payment: {
    name: "付款单", counterparty: "收款单位", date: "付款日期", method: "付款方式", remark: "付款备注",
    ourBankName: "我方开户银行", ourBankAccount: "我方银行账号",
    counterpartyBankName: "对方开户银行", counterpartyBankAccount: "对方银行账号",
    currency: "币种", exchangeRate: "汇率", amountCny: "折合人民币",
    summary: "摘要", generalSubject: "总账科目", detailSubject: "明细科目",
    debit: "借方金额", credit: "贷方金额", remarkColumn: "备注", maker: "制单人",
  },
  receipt: {
    name: "收款单", counterparty: "付款单位", date: "收款日期", method: "收款方式", remark: "收款备注",
    ourBankName: "我方开户银行", ourBankAccount: "我方银行账号",
    counterpartyBankName: "对方开户银行", counterpartyBankAccount: "对方银行账号",
    currency: "币种", exchangeRate: "汇率", amountCny: "折合人民币",
    summary: "摘要", generalSubject: "总账科目", detailSubject: "明细科目",
    debit: "借方金额", credit: "贷方金额", remarkColumn: "备注", maker: "制单人",
  },
} as const satisfies Record<FinanceSlipKind, Record<string, string>>;

export type SlipLabelSet = (typeof SLIP_LABELS)[FinanceSlipKind];

export function slipLabels(kind: FinanceSlipKind): SlipLabelSet {
  return SLIP_LABELS[kind];
}

/**
 * 汇率 / 折合人民币 / 行金额的拦截文案。**与后端逐字一致**（后端 `SLIP_RATE_INVALID`、
 * `SLIP_CNY_AMOUNT_INVALID`、`SLIP_LINE_AMOUNT_INVALID` 的 message）。
 *
 * 提成常量而不是在判定处写字符串：这几句会同时出现在「按钮为什么点不动」的提示与后端的 422 里，
 * 两处只要差一个字，财务就会以为是两个不同的问题（历史上有过一次：界面说「最多 4 位小数」、
 * 后端说「必须是大于零的数字」）。
 */
export const SLIP_RATE_BLOCKER = "汇率必须是大于零的数字（最多 8 位小数），人民币付款可留空";
export const SLIP_CNY_AMOUNT_BLOCKER = "折合人民币必须是大于零的数字（最多 4 位小数），人民币付款可留空";
export const SLIP_LINE_AMOUNT_BLOCKER = "行金额必须是大于零的数字（最多 4 位小数）";

/**
 * 「填了汇率但折合人民币空着」时的那句提示。
 *
 * 为什么必须显式说出来：这两格看起来是一对（跨行转账单上就是一对），财务会以为系统会替她算。
 * 但我们**刻意不自动折算**（银行的折算价与我们的报价可能不同，自动算出来的数在单子上看不出错），
 * 所以她得知道「留空 = 单子上那一格也是空的」，而不是导出后才发现。
 */
export const SLIP_CNY_EMPTY_HINT = "折合人民币留空就是留空：系统不会按「合计 × 汇率」自动折算，需要的话请照银行回单填上。";

/**
 * 预填接口的路径。
 *
 * 注意前缀：这条走 `apiPost`，而 `api-client` 会自己补 `/api/v1`（`api-client.ts:32`），
 * 所以这里**不能**带前缀。导出那条（`financeSlipExportPath`）恰恰相反 —— 两者必须分开看。
 */
export function financeSlipDraftPath(kind: FinanceSlipKind): string {
  return `/finance/${kind === "payment" ? "payment" : "receipt"}-slips/draft`;
}

/**
 * 导出接口的路径。
 *
 * ⚠️ 必须自带 `/api/v1` 前缀：导出走的是 `downloadPost`（**裸 fetch**，见 lib/download.ts），
 * 它不像 `api-client` 那样补前缀。少了这三个字，请求会打到 Web 服务而不是 API，
 * 拿回一个 404 的 HTML —— 用户看到的是「导出失败」，而网络面板里那条请求根本没到过后端。
 * 全站其余下载（台账、工资付款表）也都是在调用处写全 `/api/v1/...`，这里是同一件事。
 */
export function financeSlipExportPath(kind: FinanceSlipKind): string {
  return `/api/v1/finance/${kind === "payment" ? "payment" : "receipt"}-slips.xlsx`;
}

/**
 * 「全部导出」的路径（一次导出队列里的全部张，一个工作簿多张工作表）。
 *
 * 前缀的理由与 `financeSlipExportPath` 完全相同（`downloadPost` 是裸 fetch）——
 * 两条路径写在一起就是为了让人一眼看到它们**都要**带 `/api/v1`：
 * 只给其中一条带前缀，那种病在测试里只表现为「一条记录都没有」，很难查。
 */
export function financeSlipBatchExportPath(kind: FinanceSlipKind): string {
  return `/api/v1/finance/${kind === "payment" ? "payment" : "receipt"}-slips/batch.xlsx`;
}

/**
 * 存档接口的路径（保存 / 列表 / 删除）。
 *
 * 两条要分清的事：
 *   - 这些走 `apiPost` / `apiPatch` / `apiGet` / `apiDelete`（`api-client` 会自己补 `/api/v1`），
 *     所以这里**不带前缀**；导出那两条（`financeSlipExportPath` 等）恰恰相反，它们是裸 fetch。
 *   - 存档是 `finance/slips`（单数资源、复数集合），导出是 `finance/payment-slips.xlsx`：
 *     地址上就该看得出「存一张单子」与「导出一张单子」是两条路。
 */
export const FINANCE_SLIPS_PATH = "/finance/slips";

/** 列表路径（按种类与对方单位筛选，带分页）。 */
export function financeSlipsPath(query: { kind: FinanceSlipKind; page?: number; pageSize?: number; counterparty?: string } = { kind: "payment" }): string {
  const params = new URLSearchParams({ kind: query.kind });
  if (query.page && query.page > 1) params.set("page", String(query.page));
  if (query.pageSize) params.set("page_size", String(query.pageSize));
  if (query.counterparty?.trim()) params.set("counterparty", query.counterparty.trim());
  return `${FINANCE_SLIPS_PATH}?${params.toString()}`;
}

/** 单张存档的路径（详情 / 覆盖保存 / 删除）。 */
export function financeSlipRecordPath(id: string): string {
  return `${FINANCE_SLIPS_PATH}/${id}`;
}

/** 已保存的单子在接口上的形状（= 预填结果 + 存档信息）。 */
export type FinanceSlipRecord = FinanceSlipDraft & { id: string; source_entry_ids: string[]; created_at: string; updated_at: string };

/** 打开一张已保存的单子：存档 → 编辑器认的预填形状。 */
export function financeSlipFromRecord(record: FinanceSlipRecord): FinanceSlipDraft {
  return {
    ...record,
    // 老数据/异常数据里 lines 可能不是数组：编辑器拿到 undefined 会在 `.map` 上崩，
    // 而用户看到的是一整页白屏（这一条在 2026-09-24 的物料引用上踩过一次）。
    lines: Array.isArray(record.lines) ? record.lines : [],
  };
}

/** 预填请求体。
 *
 * 付款单勾的是**应付条目**、收款单勾的是**应收来源**，两边的主键在各自表里，
 * 所以字段名必须分开（后端两个 DTO 也是这样分的）—— 用同一个 `ids` 会让「传错表」变成一个
 * 只有运行时才暴露的错误。
 */
export function financeSlipDraftBody(kind: FinanceSlipKind, ids: string[]): Record<string, string[]> {
  return kind === "payment" ? { payable_entry_ids: ids } : { receivable_source_ids: ids };
}

/** 新建一行的默认值：借方 + 空摘要/科目/金额（用户要「自己填加行」，所以默认就该是借方一行）。 */
export function emptyFinanceSlipLine(key: string): FinanceSlipEditorLine {
  return { key, summary: "", general_subject: "", detail_subject: "", debit: "", credit: "", remark: "" };
}

/** 稳定且不会重复的行 key（同一毫秒内连点两次「新增行」不能撞）。 */
let lineSequence = 0;
export function nextFinanceSlipLineKey(): string {
  lineSequence += 1;
  return `slip-line-${lineSequence}`;
}

/** 后端预填的分录 → 编辑器行。 */
export function slipLinesFromDraft(lines: readonly Omit<FinanceSlipEditorLine, "key">[]): FinanceSlipEditorLine[] {
  return lines.map((line) => ({ ...emptyFinanceSlipLine(nextFinanceSlipLineKey()), ...line }));
}

/**
 * 金额文本 → 整数「分」（1e-4 精度）。非法或 ≤ 0 返回 null。
 *
 * 正则与后端 `finance-slip.ts` 的 `MONEY` 完全一致（最多 4 位小数，与 DECIMAL(18,4) 对齐）。
 */
export function parseSlipAmount(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec((text ?? "").trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  const units = BigInt(`${whole}${fraction.padEnd(4, "0")}`);
  return units > 0n ? units : null;
}

/** 整数「分」→ 十进制字符串（去掉无意义的尾零）。 */
export function formatSlipAmount(units: bigint): string {
  const fraction = (units % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${units / 10000n}.${fraction}` : `${units / 10000n}`;
}

/**
 * 汇率文本 → 整数「1e-8」（与后端 `money.ts` 的 `toRateUnits` 同精度、同语义：非法或 0 一律 null）。
 *
 * 为什么要自带：见文件头最后一段（node:test 直接载入 .ts，解析不了无扩展名的相对导入）。
 * 精度取 8 位而不是跨行转账单那 6 位：汇率的精度只该有一个出处，而 8 位正是
 * `exchange_rates.rate` 的列精度、也是后端收付款单那一格的精度。
 */
export function parseSlipRate(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec((text ?? "").trim());
  if (!match) return null;
  const units = BigInt(`${match[1]}${(match[2] ?? "").padEnd(8, "0")}`);
  return units > 0n ? units : null;
}

export type SlipTotals = { debit: string; credit: string; balanced: boolean; invalid: boolean; empty: boolean };

/**
 * 借贷合计。
 *
 * 与后端同一套规则：一行同时填两侧算 `invalid`（这一行自己就不平），两侧都空算「还没填完」。
 */
export function slipTotals(lines: readonly FinanceSlipEditorLine[]): SlipTotals {
  let debit = 0n;
  let credit = 0n;
  let invalid = false;
  let money = false;
  for (const line of lines) {
    const left = parseSlipAmount(line.debit);
    const right = parseSlipAmount(line.credit);
    const leftText = (line.debit ?? "").trim();
    const rightText = (line.credit ?? "").trim();
    if (left !== null && right !== null) { invalid = true; continue; }
    if (!leftText && !rightText) continue;
    if (leftText && left === null) { invalid = true; continue; }
    if (rightText && right === null) { invalid = true; continue; }
    money = true;
    if (left !== null) debit += left; else credit += right!;
  }
  return {
    debit: formatSlipAmount(debit),
    credit: formatSlipAmount(credit),
    balanced: money && debit > 0n && debit === credit,
    invalid,
    empty: !money,
  };
}

/** 这一行有没有写过东西（六个格子全空 = 财务新加了一行但还没填，导出时整行丢掉，不挡着导出）。 */
export function slipLineHasContent(line: FinanceSlipEditorLine): boolean {
  return [line.summary, line.general_subject, line.detail_subject, line.debit, line.credit, line.remark]
    .some((value) => (value ?? "").trim() !== "");
}

/** 导出的行 = 真正填过内容的行（全空行不提交：它会在后端变成「第 N 行请填金额」而挡住整张单）。 */
export function financeSlipLines(lines: readonly FinanceSlipEditorLine[]): FinanceSlipEditorLine[] {
  return lines.filter(slipLineHasContent);
}

/**
 * 导出按钮该不该禁用 —— **返回全部原因**（不是第一个）。
 *
 * 与后端 `validateFinanceSlip` 逐条对应：界面先拦一次只是为了让财务别走到「点了导出才被告知」，
 * 后端仍然会再校验一次（两处同一套规则，结论不会分叉）。
 */
export function financeSlipBlockers(kind: FinanceSlipKind, header: FinanceSlipHeader, lines: readonly FinanceSlipEditorLine[]): string[] {
  const labels = slipLabels(kind);
  const problems: string[] = [];
  if (!header.slip_no.trim()) problems.push("请填写单据编号");
  if (!header.counterparty_name.trim()) problems.push(`请填写${labels.counterparty}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(header.slip_date ?? "")) problems.push(`请选择${labels.date}`);
  if (!Number.isInteger(header.attachment_count) || header.attachment_count < 0) problems.push("附单据张数必须是非负整数");
  // 汇率与折合人民币都可以留空（人民币付款那两格本来就空着）；填了就必须是合法数字。
  // 文案与后端 `SLIP_RATE_INVALID` / `SLIP_CNY_AMOUNT_INVALID` 逐字一致（见文件头）。
  if (header.exchange_rate.trim() && parseSlipRate(header.exchange_rate) === null) problems.push(SLIP_RATE_BLOCKER);
  if (header.amount_cny.trim() && parseSlipAmount(header.amount_cny) === null) problems.push(SLIP_CNY_AMOUNT_BLOCKER);

  const filled = financeSlipLines(lines);
  if (filled.length === 0) { problems.push("请至少填写一行分录"); return problems; }
  filled.forEach((line, index) => {
    const row = index + 1;
    if (!line.summary.trim() && !line.general_subject.trim()) problems.push(`第 ${row} 行请填写摘要或总账科目`);
    const leftText = line.debit.trim();
    const rightText = line.credit.trim();
    if (leftText && rightText) { problems.push(`第 ${row} 行不能同时填写借方与贷方金额`); return; }
    if (!leftText && !rightText) { problems.push(`第 ${row} 行请填写借方或贷方金额`); return; }
    if ((leftText ? parseSlipAmount(leftText) : parseSlipAmount(rightText)) === null) problems.push(`第 ${row} 行金额必须是大于零的数字（最多 4 位小数）`);
  });
  if (problems.length) return problems;

  const totals = slipTotals(filled);
  if (totals.empty) problems.push("请至少填写一行有金额的分录");
  else if (!totals.balanced) problems.push(`借贷不平衡：借方 ${totals.debit} / 贷方 ${totals.credit}（差额 ${slipDifference(totals)}）`);
  return problems;
}

/**
 * **保存**该不该禁用 —— 比导出少拦三件（编号、对方单位、借贷平衡）。
 *
 * 为什么保存的标准要低一档：财务改到一半就该能存下来。一次集中付款会拆出十几张单子，
 * 她填到第五张被叫走，回来时「存不了草稿」等于前面的活白干 —— 后端也是这么分的
 * （`validateFinanceSlipShape` vs `validateFinanceSlip`）。
 */
export function financeSlipSaveBlockers(kind: FinanceSlipKind, header: FinanceSlipHeader, lines: readonly FinanceSlipEditorLine[]): string[] {
  const labels = slipLabels(kind);
  const problems: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(header.slip_date ?? "")) problems.push(`请选择${labels.date}`);
  if (!Number.isInteger(header.attachment_count) || header.attachment_count < 0) problems.push("附单据张数必须是非负整数");
  if (header.exchange_rate.trim() && parseSlipRate(header.exchange_rate) === null) problems.push(SLIP_RATE_BLOCKER);
  if (header.amount_cny.trim() && parseSlipAmount(header.amount_cny) === null) problems.push(SLIP_CNY_AMOUNT_BLOCKER);
  // 行里「金额格式非法」（写了非数字/零/负数）也存不下来：它在库里是 DECIMAL 列。
  // 但**没填金额的空行**不拦 —— 那是「还没填完」，提交时会被 `financeSlipLines` 丢掉。
  for (const line of financeSlipLines(lines)) {
    const leftText = line.debit.trim();
    const rightText = line.credit.trim();
    if (!leftText && !rightText) continue;
    if (leftText && parseSlipAmount(leftText) === null) { problems.push(SLIP_LINE_AMOUNT_BLOCKER); break; }
    if (rightText && parseSlipAmount(rightText) === null) { problems.push(SLIP_LINE_AMOUNT_BLOCKER); break; }
  }
  return problems;
}

/** 借贷差额（绝对值，用于提示文案）。 */
export function slipDifference(totals: SlipTotals): string {
  const debit = parseSlipAmount(totals.debit) ?? 0n;
  const credit = parseSlipAmount(totals.credit) ?? 0n;
  return formatSlipAmount(debit > credit ? debit - credit : credit - debit);
}

/** 编辑器状态 → 导出接口的请求体（丢掉 key、空行，并把表头字段 trim）。 */
export function financeSlipPayload(kind: FinanceSlipKind, header: FinanceSlipHeader, lines: readonly FinanceSlipEditorLine[]) {
  return {
    kind,
    slip_no: header.slip_no.trim(),
    slip_date: header.slip_date,
    slip_method: header.slip_method.trim(),
    counterparty_name: header.counterparty_name.trim(),
    our_bank_name: header.our_bank_name.trim(),
    our_bank_account: header.our_bank_account.trim(),
    counterparty_bank_name: header.counterparty_bank_name.trim(),
    counterparty_bank_account: header.counterparty_bank_account.trim(),
    currency: header.currency.trim(),
    exchange_rate: header.exchange_rate.trim(),
    amount_cny: header.amount_cny.trim(),
    attachment_count: header.attachment_count,
    remark: header.remark.trim(),
    maker: header.maker.trim(),
    lines: financeSlipLines(lines).map((line) => ({
      summary: line.summary.trim(),
      general_subject: line.general_subject.trim(),
      detail_subject: line.detail_subject.trim(),
      debit: line.debit.trim(),
      credit: line.credit.trim(),
      remark: line.remark.trim(),
    })),
  };
}

/**
 * 保存请求体 = 导出请求体 + `source_entry_ids`（预填时的勾选，只用于追溯）。
 *
 * 为什么复用 `financeSlipPayload` 而不是另写一份：保存与导出认的是**同一张单子**，
 * 字段清单一旦分叉，就会出现「导出的那张和存下来的那张不一样」——而两张纸看起来都对。
 */
export function financeSlipSaveBody(kind: FinanceSlipKind, header: FinanceSlipHeader, lines: readonly FinanceSlipEditorLine[], sourceEntryIds?: readonly string[]) {
  return {
    ...financeSlipPayload(kind, header, lines),
    ...(sourceEntryIds?.length ? { source_entry_ids: [...sourceEntryIds] } : {}),
  };
}

/** 列表与编辑器标题上的一张单子的合计（借方合计；没填金额时是空串，不显示 0）。 */
export function financeSlipRecordTotal(record: FinanceSlipDraft): string {
  const totals = slipTotals(slipLinesFromDraft(Array.isArray(record.lines) ? record.lines : []));
  return totals.empty ? "" : totals.debit;
}

/**
 * 列表一行的那句人话：`FK-202609-001　富雨鑫　USD 1069.51`。
 *
 * 与 `slipQueueLabel` 一样是**纯函数**：列表单元格里拼字符串的写法散在组件里，
 * 一处忘带币种就会出现「两家不同币种的单子看起来金额一样」。
 */
export function financeSlipRecordLabel(record: FinanceSlipDraft): string {
  const total = financeSlipRecordTotal(record);
  const currency = (record.currency ?? "").trim();
  // 币种与金额之间用**半角空格**、三段之间用全角空格：没维护币种时不该留下一个悬空的前导空格。
  const money = [currency, total].filter(Boolean).join(" ");
  return [record.slip_no?.trim() || "未编号", record.counterparty_name?.trim() || "未填对方单位", money].filter(Boolean).join("　");
}

/** 删除存档时的二次确认文案（软删除，但单子会从列表里消失）。 */
export function financeSlipDeleteLabel(record: FinanceSlipDraft): string {
  return `${slipLabels(record.kind).name} ${record.slip_no?.trim() || "未编号"}（${record.counterparty_name?.trim() || "未填对方单位"}）`;
}

/** 一张单子（预填结果或存档）→ 表头。存档与预填本来就是同形状，这里只做**空值兜底**。 */
export function slipHeaderOf(draft: FinanceSlipDraft): FinanceSlipHeader {
  return {
    slip_no: draft.slip_no ?? "",
    slip_date: draft.slip_date ?? "",
    slip_method: draft.slip_method ?? "",
    counterparty_name: draft.counterparty_name ?? "",
    our_bank_name: draft.our_bank_name ?? "",
    our_bank_account: draft.our_bank_account ?? "",
    counterparty_bank_name: draft.counterparty_bank_name ?? "",
    counterparty_bank_account: draft.counterparty_bank_account ?? "",
    currency: draft.currency ?? "",
    exchange_rate: draft.exchange_rate ?? "",
    amount_cny: draft.amount_cny ?? "",
    attachment_count: Number.isInteger(draft.attachment_count) ? draft.attachment_count : 0,
    remark: draft.remark ?? "",
    maker: draft.maker ?? "",
  };
}

/**
 * 已保存的单子 → **导出请求体**（列表页的「导出」按钮不经过编辑器）。
 *
 * 走的是与编辑器导出**同一个** `financeSlipPayload`：列表导出与编辑器导出的文件必须一模一样，
 * 两处各拼一份请求体的话，「列表导出来少一行」这种病只有财务对纸的时候才会发现。
 */
export function financeSlipPayloadFromRecord(record: FinanceSlipDraft) {
  return financeSlipPayload(record.kind, slipHeaderOf(record), slipLinesFromDraft(Array.isArray(record.lines) ? record.lines : []));
}

/**
 * 单子导出后的兜底文件名（与后端 `Content-Disposition` 给出的那份一致）。
 *
 * 前端也拼一份是因为 `downloadPost` 只在响应头缺失时才用兜底名 —— 正常情况下以响应头为准。
 */
export function financeSlipFileName(kind: FinanceSlipKind, slipNo: string): string {
  return `${kind === "payment" ? "迪礼付款单" : "迪礼收款单"}-${slipNo.trim() || "未编号"}.xlsx`;
}

/** 「全部导出」的兜底文件名：`迪礼付款单-3张.xlsx`（与后端 `financeSlipsFileName` 同一形状）。 */
export function financeSlipsFileName(kind: FinanceSlipKind, count: number): string {
  return `${kind === "payment" ? "迪礼付款单" : "迪礼收款单"}-${count}张.xlsx`;
}

/**
 * 「全部导出」的请求体：队列里**每一张**的表头 + 分录。
 *
 * 一张一张地拼（而不是把编辑器状态整个丢过去）：队列里每张单子的可编辑状态是独立的，
 * 服务端要拿到的也只是「这一张长什么样」，多传状态只会让接口与界面状态机绑死。
 */
export function financeSlipBatchPayload(kind: FinanceSlipKind, slips: ReadonlyArray<{ header: FinanceSlipHeader; lines: readonly FinanceSlipEditorLine[] }>) {
  return { slips: slips.map((slip) => financeSlipPayload(kind, slip.header, slip.lines)) };
}

/**
 * 队列里一张单子的标题：`2. 绍兴纺织（USD）合计 200`。
 *
 * 为什么要标题而不是只给序号：一次集中付款拆出的单子常常是**同一家公司不同币种**的两张，
 * 只写「第 1 张 / 第 2 张」财务根本认不出哪张是哪张（用户 2026-09-24 抱怨的正是
 * 「还要一张张改付款单」——队列必须让她一眼定位）。
 */
export function slipQueueLabel(index: number, counterparty: string, currency: string, total: string): string {
  return `${index + 1}. ${counterparty.trim() || "未填对方单位"}${currency.trim() ? `（${currency.trim()}）` : ""} 合计 ${total}`;
}

/**
 * 队列底部「去确认」那条按钮的文案。
 *
 * 为什么单独成一个函数：这句里的动作词必须跟着种类走 —— 写死「付款」会让**收款单**队列底部出现
 * 「确认这 2 条（付款）」，而它确认的是收款。测试就是靠这条断言发现的那句话。
 */
export function slipConfirmPendingLabel(kind: FinanceSlipKind, count: number): string {
  return `确认这 ${count} 条（${kind === "payment" ? "付款" : "收款"}）`;
}
