// 收/付款单编辑器纯逻辑的测试（node:test，与 apps/web/lib/*.test.mjs 同一套）。
//
// 四件事钉死：
//   ① 借贷合计按「分」精确相加（浮点求和会让明明平了的单子导不出来）；
//   ② 导出按钮的禁用原因**与后端 finance-slip.ts 的 validateFinanceSlip 同一套口径**
//      （用户点「导出」时不能出现「界面说行、后端说不行」）；
//   ③ 金额的合法性与后端同一条正则（最多 4 位小数）；
//   ④ **付款单与收款单的用词不同、路由不同、请求体字段不同**（勾应付条目 vs 勾应收来源）——
//      用户那句「同理，收款单的编辑和导出」最容易实现成「标题改成收款单、其余照抄」，
//      所以这里逐条断言对方的称谓、接口路径与请求字段。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyFinanceSlipLine,
  financeSlipBlockers,
  financeSlipDraftBody,
  financeSlipDraftPath,
  financeSlipExportPath,
  financeSlipFileName,
  financeSlipPayload,
  formatSlipAmount,
  nextFinanceSlipLineKey,
  parseSlipAmount,
  slipDifference,
  slipLabels,
  slipLinesFromDraft,
  slipTotals,
} from "./finance-slip.ts";

const line = (extra = {}) => ({ ...emptyFinanceSlipLine(nextFinanceSlipLineKey()), ...extra });
const header = (extra = {}) => ({
  slip_no: "FK-202609-001", slip_date: "2026-09-20", slip_method: "银行转账", counterparty_name: "富雨鑫",
  bank_name: "中国农业银行", bank_account: "4039", attachment_count: 1, remark: "", maker: "小叶", ...extra,
});
/** 财务模板样张那张单（借 原材料 130 + 借 进项税 19.50 / 贷 银行存款 149.50）。 */
const sampleLines = () => [
  line({ summary: "支付富雨鑫材料款", general_subject: "原材料", debit: "130.00" }),
  line({ summary: "应交税费-进项税", debit: "19.50" }),
  line({ summary: "支付富雨鑫材料款（含税）", general_subject: "银行存款", credit: "149.50" }),
];

test("finance-slip：金额解析与格式化（0.1 + 0.2 必须是 0.3，不是 0.30000000000000004）", () => {
  assert.equal(parseSlipAmount("130.00"), 1300000n);
  assert.equal(parseSlipAmount("0.1"), 1000n);
  assert.equal(formatSlipAmount(1000n + 2000n), "0.3");
  assert.equal(formatSlipAmount(1495000n), "149.5");
  for (const bad of ["", "0", "-1", "abc", "1.23456"]) assert.equal(parseSlipAmount(bad), null, `${bad} 不是合法金额`);
});

test("finance-slip：样张那张单是平的；只有借方不平；两侧都填算填错了", () => {
  const totals = slipTotals(sampleLines());
  assert.equal(totals.debit, "149.5");
  assert.equal(totals.credit, "149.5");
  assert.equal(totals.balanced, true);
  assert.equal(totals.invalid, false);

  const oneSided = slipTotals([line({ summary: "只有借方", debit: "100" })]);
  assert.equal(oneSided.balanced, false);
  assert.equal(oneSided.invalid, false, "只有一侧是「不平」，不是「金额写错」");

  const bothSides = slipTotals([line({ summary: "两边都填", debit: "100", credit: "100" })]);
  assert.equal(bothSides.invalid, true);
  assert.equal(bothSides.balanced, false);
});

test("finance-slip：样张能导出；缺表头 / 缺行 / 行里没金额 / 借贷不平各自给出可执行的原因", () => {
  assert.deepEqual(financeSlipBlockers("payment", header(), sampleLines()), [], "样张必须能导出");

  assert.deepEqual(financeSlipBlockers("payment", header({ slip_no: "  ", counterparty_name: "" }), sampleLines()), ["请填写单据编号", "请填写收款单位"]);
  assert.deepEqual(financeSlipBlockers("payment", header({ slip_date: "2026/09/20" }), sampleLines()), ["请选择付款日期"]);
  assert.deepEqual(financeSlipBlockers("payment", header({ attachment_count: -1 }), sampleLines()), ["附单据张数必须是非负整数"]);
  assert.deepEqual(financeSlipBlockers("payment", header(), []), ["请至少填写一行分录"]);
  assert.deepEqual(financeSlipBlockers("payment", header(), [line({ summary: "第一行", debit: "10" })]), ["借贷不平衡：借方 10 / 贷方 0（差额 10）"]);
});

test("finance-slip：收款单的用词跟着种类走，接口路径与请求体字段与付款单分开", () => {
  assert.equal(slipLabels("payment").counterparty, "收款单位");
  assert.equal(slipLabels("receipt").counterparty, "付款单位", "收款单上对方是付款方");
  assert.equal(slipLabels("payment").name, "付款单");
  assert.equal(slipLabels("receipt").name, "收款单");

  // 同一个表头，两种单据给出的原因不同（对方的称谓、日期的说法）
  assert.deepEqual(financeSlipBlockers("receipt", header({ counterparty_name: "", slip_date: "" }), sampleLines()), ["请填写付款单位", "请选择收款日期"]);

  // 勾的是两张不同的表：付款单勾应付条目、收款单勾应收来源
  assert.equal(financeSlipDraftPath("payment"), "/finance/payment-slips/draft", "预填走 apiPost，前缀由 api-client 补");
  assert.equal(financeSlipDraftPath("receipt"), "/finance/receipt-slips/draft");
  // 导出走**裸 fetch**（downloadPost），必须自带 /api/v1 前缀 —— 少了它请求打到 Web 服务，
  // 用户只会看到「导出失败」（这条断言就是那次 404 的回归保护）。
  assert.equal(financeSlipExportPath("payment"), "/api/v1/finance/payment-slips.xlsx");
  assert.equal(financeSlipExportPath("receipt"), "/api/v1/finance/receipt-slips.xlsx");
  assert.deepEqual(financeSlipDraftBody("payment", ["a"]), { payable_entry_ids: ["a"] });
  assert.deepEqual(financeSlipDraftBody("receipt", ["a"]), { receivable_source_ids: ["a"] }, "传错字段名会变成「勾了却查不到条目」");
  assert.equal(financeSlipFileName("payment", "FK-1"), "迪礼付款单-FK-1.xlsx");
  assert.equal(financeSlipFileName("receipt", "SK-1"), "迪礼收款单-SK-1.xlsx");
});

test("finance-slip：行级问题指到具体第几行；空白行不算一行、不挡导出", () => {
  const blockers = financeSlipBlockers("payment", header(), [
    line({ summary: "第一行没问题", debit: "10" }),
    line({ summary: "第二行没金额" }),
    line({ summary: "第三行两边都填", debit: "5", credit: "5" }),
  ]);
  assert.deepEqual(blockers, ["第 2 行请填写借方或贷方金额", "第 3 行不能同时填写借方与贷方金额"]);

  // 财务点「新增行」多出来的空行：整行丢掉，不报「第 4 行请填金额」，也不影响借贷平衡判断。
  const withBlank = [line({ summary: "借", general_subject: "原材料", debit: "100" }), emptyFinanceSlipLine("blank"), line({ summary: "贷", general_subject: "银行存款", credit: "100" })];
  assert.deepEqual(financeSlipBlockers("payment", header(), withBlank), []);
  // 摘要与总账科目有一列就算写过了（模板样张第 2 行就是把科目名写在摘要里）。
  assert.deepEqual(financeSlipBlockers("payment", header(), [line({ summary: "只有摘要", debit: "10" }), line({ general_subject: "银行存款", credit: "10" })]), []);
});

test("finance-slip：提交体丢掉空行、trim 各字段，并保留财务改过的金额", () => {
  const payload = financeSlipPayload("payment", header({ slip_no: " FK-202609-009 ", remark: " 本次只付 100 " }), [
    line({ summary: " 支付富雨鑫材料款 ", general_subject: " 原材料 ", debit: " 86.96 " }),
    emptyFinanceSlipLine("blank"),
    line({ summary: " 支付富雨鑫款项合计 ", general_subject: " 银行存款 ", credit: " 100 " }),
  ]);
  assert.equal(payload.kind, "payment");
  assert.equal(payload.slip_no, "FK-202609-009");
  assert.equal(payload.remark, "本次只付 100");
  assert.deepEqual(payload.lines, [
    { summary: "支付富雨鑫材料款", general_subject: "原材料", detail_subject: "", debit: "86.96", credit: "", remark: "" },
    { summary: "支付富雨鑫款项合计", general_subject: "银行存款", detail_subject: "", debit: "", credit: "100", remark: "" },
  ]);
  assert.equal(financeSlipFileName("payment", payload.slip_no), "迪礼付款单-FK-202609-009.xlsx");
  assert.equal(financeSlipFileName("payment", "  "), "迪礼付款单-未编号.xlsx");
});

test("finance-slip：后端预填的行带出自己的 key（增删行不会串行）", () => {
  const lines = slipLinesFromDraft([
    { summary: "借", general_subject: "原材料", detail_subject: "", debit: "100", credit: "", remark: "" },
    { summary: "贷", general_subject: "银行存款", detail_subject: "中国农业银行", debit: "", credit: "100", remark: "" },
  ]);
  assert.equal(lines.length, 2);
  assert.notEqual(lines[0].key, lines[1].key);
  assert.equal(lines[1].detail_subject, "中国农业银行");
  assert.deepEqual(slipTotals(lines), { debit: "100", credit: "100", balanced: true, invalid: false, empty: false });
  assert.equal(slipDifference(slipTotals([line({ summary: "x", debit: "100" })])), "100");
});
