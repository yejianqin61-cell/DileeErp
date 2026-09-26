// 跨行转账单编辑器的纯逻辑（**不能**放进 "use client" 文件）。
//
// 财务 2026-09-24：「银行账户互转的时候，跨行转账单.html，支持编辑这个样式的表单，并且支持导出打印」。
// 模板文件在 `example/财务/跨行转账单.html`（19 个 `data-docx-field` 占位符）。
//
// 字段名照抄模板里的 `data-docx-field`（`payer_account` / `payee_bank_no` / `amount_cny`…），
// 与后端 `apps/api/src/modules/finance/bank-transfer-slip.ts` 是同一套名字与同一条口径：
// 单子**不落库**（它是一张交给银行的打印件），预填来自 `GET /finance/bank-transfers/:id/slip`，
// 改完提交给 `POST /finance/bank-transfer-slips.xlsx` 出文件。
//
// 本模块给编辑器提供可单测的骨架：字段形状、必填校验（与后端逐条对应）、路径与请求体、文件名。
//
// ⚠️ 「金额大写」刻意**不在这里算**：人民币大写的规则只有后端一份实现（见 lib/finance-slip.ts 顶部）。
// 所以这里的做法是：预填把后端算好的大写带过来，**财务一改金额就把大写清空**（留空 = 让后端按金额算），
// 她自己写了就必须与后端算出来的一致（不一致由后端 422 把正确的写法告诉她）。
// 界面上永远不可能拿一段过期的中文大写去打印。

/** 跨行转账单的全部格子。字段名 = 模板里的 `data-docx-field`（与后端类型逐字段一致）。 */
export type BankTransferSlip = {
  transfer_id: string;
  document_no: string;
  payer_name: string;
  payer_account: string;
  payer_bank: string;
  payee_name: string;
  payee_account: string;
  payee_bank: string;
  payee_bank_no: string;
  transfer_date: string;
  currency: string;
  exchange_rate: string;
  amount_original: string;
  amount_cny: string;
  amount_in_words: string;
  remark: string;
  maker: string;
  reviewer: string;
  cashier: string;
  approver: string;
};

/**
 * 可编辑的字段清单（= 模板上的全部 `data-docx-field` 占位符）。
 *
 * 它同时是**导出请求体的字段清单**：漏掉一个，那一格就会在单子上永远是空的
 * （预填明明给了值也没用）—— 单据编号当年就这么漏过一次，测试是按这份清单逐字段核对的。
 */
export const TRANSFER_SLIP_FIELDS = [
  "document_no",
  "payer_name", "payer_account", "payer_bank",
  "payee_name", "payee_account", "payee_bank", "payee_bank_no",
  "transfer_date", "currency", "exchange_rate", "amount_original", "amount_cny", "amount_in_words",
  "remark", "maker", "reviewer", "cashier", "approver",
] as const;

export type TransferSlipField = (typeof TRANSFER_SLIP_FIELDS)[number];

/**
 * 表单用词。
 *
 * ⚠️ 必须与 `apps/api/src/modules/finance/bank-transfer-slip.ts` 的 `TRANSFER_SLIP_LABELS`
 * 逐字一致（两个 workspace 之间没有共享包，只能各有一份 —— 与 `SLIP_LABELS` 同一处理）。
 * 不一致的后果是打印件与财务手上的样张对不上，而她是拿样张去银行办的。
 */
export const TRANSFER_SLIP_LABELS: Record<TransferSlipField | "title" | "payerSection" | "payeeSection" | "amountSection" | "note", string> = {
  title: "跨行转账单",
  document_no: "单据编号",
  payerSection: "付　款　方",
  payer_name: "付款人全称",
  payer_account: "付款账号",
  payer_bank: "付款开户行",
  payeeSection: "收　款　方",
  payee_name: "收款人全称",
  payee_account: "收款账号",
  payee_bank: "收款开户行",
  payee_bank_no: "联行号",
  transfer_date: "转账日期",
  amountSection: "转　账　金　额",
  currency: "币种",
  exchange_rate: "汇率",
  amount_original: "转账金额（原币）",
  amount_cny: "折合人民币",
  amount_in_words: "金额大写",
  remark: "用途／附言",
  maker: "制单人",
  reviewer: "复核",
  cashier: "出纳",
  approver: "审批",
  note: "注：涉及外币转账时，请填写汇率及折合人民币金额；人民币转账可划去汇率栏。",
};

/**
 * 预填接口的路径。
 *
 * 注意前缀：这条走 `apiGet`（api-client 自己补 `/api/v1`，见 api-client.ts:32），所以这里**不能**带前缀；
 * 导出那条（`transferSlipExportPath`）恰恰相反 —— 两者必须分开看（收/付款单当年就在这上面栽过）。
 */
export function transferSlipDraftPath(transferId: string): string {
  return `/finance/bank-transfers/${transferId}/slip`;
}

/**
 * 导出接口的路径。
 *
 * ⚠️ 必须自带 `/api/v1`：导出走 `downloadPost`（**裸 fetch**，见 lib/download.ts），
 * 它不像 api-client 那样补前缀。少了这三个字请求会打到 Web 服务、拿回 404 的 HTML。
 */
export function transferSlipExportPath(): string {
  return "/api/v1/finance/bank-transfer-slips.xlsx";
}

/** 正数金额（最多 4 位小数）——与后端 `positive()` 同一形状。 */
function positive(text: string): boolean {
  const trimmed = text.trim();
  return /^\d+(?:\.\d{1,4})?$/.test(trimmed) && Number(trimmed) > 0;
}

/**
 * 导出按钮该不该禁用 —— **返回全部原因**（不是第一个），与后端 `validateBankTransferSlip` 逐条对应。
 *
 * 唯一一条界面拦不住的规则是大写与金额的一致性：中文大写只有后端算得出来，
 * 所以那一条留给后端 422（消息里直接给出正确的写法，财务照抄即可）。
 */
export function transferSlipBlockers(slip: BankTransferSlip): string[] {
  const problems: string[] = [];
  if (!slip.document_no.trim()) problems.push("请填写单据编号");
  if (!slip.payer_name.trim()) problems.push("请填写付款人全称");
  if (!slip.payer_account.trim()) problems.push("请填写付款账号");
  if (!slip.payee_name.trim()) problems.push("请填写收款人全称");
  if (!slip.payee_account.trim()) problems.push("请填写收款账号");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slip.transfer_date ?? "")) problems.push("请选择转账日期");
  if (!positive(slip.amount_original)) problems.push("转账金额（原币）必须是大于零的数字（最多 4 位小数）");
  if (slip.amount_cny.trim() && !positive(slip.amount_cny)) problems.push("折合人民币必须是大于零的数字（最多 4 位小数），没有人民币腿就留空");
  if (slip.exchange_rate.trim() && !positive(slip.exchange_rate)) problems.push("汇率必须是大于零的数字（最多 6 位小数），人民币转账可留空");
  return problems;
}

/** 编辑器状态 → 导出接口的请求体（每个格子 trim；空串保留，后端按「没填」处理）。 */
export function transferSlipPayload(slip: BankTransferSlip): Record<string, string> {
  const body: Record<string, string> = {};
  for (const field of [...TRANSFER_SLIP_FIELDS, "transfer_id"] as const) body[field] = (slip[field] ?? "").trim();
  return body;
}

/** 导出后的兜底文件名（正常情况下以响应头给的为准）。 */
export function transferSlipFileName(documentNo: string): string {
  return `迪礼跨行转账单-${documentNo.trim() || "未编号"}.xlsx`;
}

/**
 * 「金额变动就清空大写」这条规则的单点实现：改了原币或折合人民币，就把大写清空（留空 = 后端按金额算）。
 *
 * 为什么做成函数而不是散在 onChange 里：这是**唯一**防止「打印出来的大写与小写不一致」的地方，
 * 散在组件里改一个字段就可能漏掉另一条路径（例如将来加了「按汇率自动算折合人民币」）。
 */
export function clearWordsOnAmountChange(slip: BankTransferSlip, next: Partial<Pick<BankTransferSlip, "amount_original" | "amount_cny" | "exchange_rate">>): BankTransferSlip {
  return { ...slip, ...next, amount_in_words: "" };
}
