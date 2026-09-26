// 跨行转账单编辑器纯逻辑的测试（node:test，与 apps/web/lib/*.test.mjs 同一套）。
//
// 财务 2026-09-24：「银行账户互转的时候，跨行转账单，支持编辑这个样式的表单，并且支持导出打印」。
//
// 这里钉死四件事：
//   ① 三个必填项（双方全称与账号、单据编号、日期、原币金额）缺一就禁用导出，**一次把问题说完**；
//   ② 用词与后端 `bank-transfer-slip.ts` 的 `TRANSFER_SLIP_LABELS` 逐字一致（打印件要和样张对得上）；
//   ③ 导出路径**自带 `/api/v1`**（走裸 fetch，少了前缀就是 404）而预填路径**不带**（走 api-client）；
//   ④ 金额一改就清空大写 —— 界面不算中文大写，留空等于「让后端按金额算」，
//      这样纸上永远不会出现一段过期的大写（大写与小写对不上的单子会被银行退回）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TRANSFER_SLIP_FIELDS,
  TRANSFER_SLIP_LABELS,
  clearWordsOnAmountChange,
  transferSlipBlockers,
  transferSlipDraftPath,
  transferSlipExportPath,
  transferSlipFileName,
  transferSlipPayload,
} from "./bank-transfer-slip.ts";

const slip = (extra = {}) => ({
  transfer_id: "t-1", document_no: "BTR-20260924-ABCD1234",
  payer_name: "迪礼工贸有限公司", payer_account: "40390001040045706", payer_bank: "中国农业银行",
  payee_name: "迪礼工贸有限公司", payee_account: "762400001234", payee_bank: "中国银行（美元）", payee_bank_no: "",
  transfer_date: "2026-09-24", currency: "CNY", exchange_rate: "1", amount_original: "10000", amount_cny: "10000",
  amount_in_words: "", remark: "月末资金归集", maker: "小叶", reviewer: "", cashier: "", approver: "",
  ...extra,
});

test("bank-transfer-slip：样张能导出；缺项一次把全部原因说出来", () => {
  assert.deepEqual(transferSlipBlockers(slip()), [], "填齐必填项就该能导出");

  assert.deepEqual(
    transferSlipBlockers(slip({ document_no: " ", payer_name: "", payer_account: "", payee_name: "", payee_account: "  " })),
    ["请填写单据编号", "请填写付款人全称", "请填写付款账号", "请填写收款人全称", "请填写收款账号"],
    "一次说完（不是报第一个）",
  );
  assert.deepEqual(transferSlipBlockers(slip({ transfer_date: "2026/09/24" })), ["请选择转账日期"]);
  assert.deepEqual(transferSlipBlockers(slip({ amount_original: "0" })), ["转账金额（原币）必须是大于零的数字（最多 4 位小数）"]);
  assert.deepEqual(transferSlipBlockers(slip({ amount_original: "1.23456" })), ["转账金额（原币）必须是大于零的数字（最多 4 位小数）"]);
  // 汇率与折合人民币都可以留空（人民币转账可划去汇率栏；外币转外币没有折合人民币这一格）。
  assert.deepEqual(transferSlipBlockers(slip({ exchange_rate: "", amount_cny: "" })), []);
  assert.deepEqual(transferSlipBlockers(slip({ amount_cny: "-5" })), ["折合人民币必须是大于零的数字（最多 4 位小数），没有人民币腿就留空"]);
  assert.deepEqual(transferSlipBlockers(slip({ exchange_rate: "abc" })), ["汇率必须是大于零的数字（最多 6 位小数），人民币转账可留空"]);
});

test("bank-transfer-slip：路径前缀的区分与文件名", () => {
  // 预填走 apiGet（api-client 自己补 /api/v1），所以这里不带前缀。
  assert.equal(transferSlipDraftPath("t-1"), "/finance/bank-transfers/t-1/slip");
  // 导出走**裸 fetch**（downloadPost），必须自带 /api/v1 —— 少了它请求打到 Web 服务，用户只看到「导出失败」。
  assert.equal(transferSlipExportPath(), "/api/v1/finance/bank-transfer-slips.xlsx");
  assert.equal(transferSlipFileName("BTR-20260924-ABCD1234"), "迪礼跨行转账单-BTR-20260924-ABCD1234.xlsx");
  assert.equal(transferSlipFileName("   "), "迪礼跨行转账单-未编号.xlsx");
});

test("bank-transfer-slip：提交体逐格 trim，且包含模板上的每一个占位字段", () => {
  const body = transferSlipPayload(slip({ document_no: " BTR-1 ", remark: " 月末归集 ", transfer_id: " t-1 " }));
  assert.equal(body.document_no, "BTR-1");
  assert.equal(body.remark, "月末归集");
  assert.equal(body.transfer_id, "t-1", "来源互转单 id 要带上：审计靠它追回「这张纸是从哪笔资金动作开出来的」");
  for (const field of TRANSFER_SLIP_FIELDS) assert.ok(field in body, `${field} 必须出现在请求体里（漏一格就是永久空白）`);
  assert.equal(Object.keys(body).length, TRANSFER_SLIP_FIELDS.length + 1, "请求体只有这些格子（多传字段会被后端 forbidNonWhitelisted 顶回来）");
});

test("bank-transfer-slip：改金额就清空大写（留空 = 后端按金额算，界面不自己算中文大写）", () => {
  const before = slip({ amount_in_words: "壹万元整" });
  const after = clearWordsOnAmountChange(before, { amount_cny: "20000" });
  assert.equal(after.amount_cny, "20000");
  assert.equal(after.amount_in_words, "", "金额改了还留着旧大写，纸上就会出现大写与小写不一致的单子");
  // 其它格子原样（改金额不该顺手抹掉用途或联行号）。
  assert.equal(after.remark, before.remark);
  assert.equal(after.document_no, before.document_no);

  const rateOnly = clearWordsOnAmountChange(before, { exchange_rate: "7.2" });
  assert.equal(rateOnly.amount_in_words, "", "改汇率同样会改变折合人民币，所以也要清空");
});

test("bank-transfer-slip：用词与后端逐字一致（打印件要和财务手上的样张对得上）", () => {
  assert.equal(TRANSFER_SLIP_LABELS.title, "跨行转账单");
  assert.equal(`${TRANSFER_SLIP_LABELS.document_no}：`, "单据编号：");
  assert.equal(TRANSFER_SLIP_LABELS.payerSection, "付　款　方");
  assert.equal(TRANSFER_SLIP_LABELS.payeeSection, "收　款　方");
  assert.equal(TRANSFER_SLIP_LABELS.amountSection, "转　账　金　额");
  assert.equal(TRANSFER_SLIP_LABELS.payee_bank_no, "联行号");
  assert.equal(TRANSFER_SLIP_LABELS.amount_cny, "折合人民币");
  assert.equal(TRANSFER_SLIP_LABELS.remark, "用途／附言");
  assert.equal(TRANSFER_SLIP_LABELS.note, "注：涉及外币转账时，请填写汇率及折合人民币金额；人民币转账可划去汇率栏。");
});
