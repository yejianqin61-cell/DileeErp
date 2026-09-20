// 记账凭证「分录编辑器」纯逻辑的测试（node:test，不是 vitest —— lib 下的纯函数按仓库约定走 node --test）。
//
// 财务 2026-09-20 的三句话是这些用例的来源：
//   「我完整的一个工资是这样的（一借三贷）… 但是现在都不能改」
//   「原材料的也是要加上应交税费」
//   「现在自动生成的不能改、。这是什么意思？」
//
// 最关键的一条：**金额一律按整数分用 BigInt 相加**。用 `Number` 求和时
// `0.1 + 0.2 = 0.30000000000000004`，而这张表要拿合计去决定「保存」按钮能不能点 ——
// 差一位小数就是「明明平了却不让保存」。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyVoucherTemplate,
  emptyVoucherLine,
  formatCents,
  linesFromVoucher,
  parseCents,
  voucherLinePayload,
  voucherLineTotals,
} from "./voucher-lines.ts";

const subjects = [
  { id: "sub-salary", category: "负债类", name: "应付职工薪酬" },
  { id: "sub-other", category: "负债类", name: "其他应付款" },
  { id: "sub-tax", category: "负债类", name: "应交税费" },
  { id: "sub-material", category: "资产类", name: "原材料" },
  { id: "sub-input", category: "负债类", name: "应交税费-进项税" },
  { id: "sub-payable", category: "负债类", name: "应付账款" },
  { id: "sub-bank", category: "资产类", name: "银行存款" },
];

const line = (direction, subject, amount, extra = {}) => ({ ...emptyVoucherLine(`k-${subject}-${amount}`), direction, subject, amount, ...extra });

test("金额解析：最多 4 位小数（与 DECIMAL(18,4) 对齐），非正数与非数字都是 null", () => {
  assert.equal(parseCents("18000"), 180000000n);
  assert.equal(parseCents(" 1960.5 "), 19605000n);
  assert.equal(parseCents("15929.2035"), 159292035n);
  assert.equal(parseCents("100.00001"), null, "第 5 位小数不是合法金额（后端 toCents 同样拒绝）");
  assert.equal(parseCents("0"), null);
  assert.equal(parseCents("-5"), null);
  assert.equal(parseCents(""), null);
  assert.equal(parseCents("abc"), null);
});

test("金额格式化：去掉无意义的尾零，且不经过浮点", () => {
  assert.equal(formatCents(180000000n), "18000");
  assert.equal(formatCents(550000n), "55");
  assert.equal(formatCents(19605000n), "1960.5");
  assert.equal(formatCents(159292035n), "15929.2035");
  assert.equal(formatCents(1n), "0.0001");
  assert.equal(formatCents(0n), "0");
});

test("借贷合计按整数分相加：0.1 + 0.2 恰好等于 0.3（用 Number 会得到 0.30000000000000004）", () => {
  const totals = voucherLineTotals([
    line("debit", "sub-material", "0.1"),
    line("debit", "sub-input", "0.2"),
    line("credit", "sub-payable", "0.3"),
  ]);
  assert.equal(totals.debit, "0.3");
  assert.equal(totals.credit, "0.3");
  assert.equal(totals.balanced, true);
});

test("工资计提（一借三贷）：借贷相等才算平衡", () => {
  const totals = voucherLineTotals([
    line("debit", "sub-salary", "12000"),
    line("credit", "sub-other", "1800"),
    line("credit", "sub-tax", "200"),
    line("credit", "sub-bank", "10000"),
  ]);
  assert.deepEqual([totals.debit, totals.credit, totals.balanced], ["12000", "12000", true]);
  assert.equal(totals.invalid, false);
  assert.equal(totals.subjectMissing, false);
});

test("原材料采购（两借一贷）：进项税与不含税金额之和等于应付账款", () => {
  const totals = voucherLineTotals([
    line("debit", "sub-material", "15929.2035"),
    line("debit", "sub-input", "2070.7965"),
    line("credit", "sub-payable", "18000"),
  ]);
  assert.equal(totals.debit, "18000");
  assert.equal(totals.credit, "18000");
  assert.equal(totals.balanced, true);
});

test("三种「不能保存」的原因分开报：金额非法 / 科目没填 / 借贷不平", () => {
  const invalid = voucherLineTotals([line("debit", "sub-material", ""), line("credit", "sub-payable", "10")]);
  assert.equal(invalid.invalid, true);
  assert.equal(invalid.balanced, false);

  const noSubject = voucherLineTotals([line("debit", "", "10"), line("credit", "sub-payable", "10")]);
  assert.equal(noSubject.subjectMissing, true);
  assert.equal(noSubject.invalid, false);

  const unbalanced = voucherLineTotals([line("debit", "sub-material", "10"), line("credit", "sub-payable", "9")]);
  assert.equal(unbalanced.invalid, false);
  assert.equal(unbalanced.subjectMissing, false);
  assert.equal(unbalanced.balanced, false);
  assert.deepEqual([unbalanced.debit, unbalanced.credit], ["10", "9"]);
});

test("空分录集不算平衡（后端也会以 VOUCHER_LINE_REQUIRED 拒绝）", () => {
  const totals = voucherLineTotals([]);
  assert.equal(totals.balanced, false);
  assert.deepEqual([totals.debit, totals.credit], ["0", "0"]);
});

test("只有一方的分录不算平衡（借有贷无）", () => {
  const totals = voucherLineTotals([line("debit", "sub-material", "10")]);
  assert.equal(totals.balanced, false);
  assert.deepEqual([totals.debit, totals.credit], ["10", "0"]);
});

test("序列化：命中科目表用「分类/名称」做编码、科目名做快照", () => {
  const payload = voucherLinePayload([line("debit", "sub-material", "100", { summary: " 采购 " })], subjects);
  assert.deepEqual(payload[0], {
    direction: "debit",
    subject_key: "资产类/原材料",
    subject_label: "原材料",
    summary: "采购",
    amount: "100",
    bank_id: null,
  });
});

test("序列化：科目对不上科目表时原样保留文本（历史凭证里手打的科目不能在编辑时被清掉）", () => {
  const payload = voucherLinePayload([line("credit", "应交税费——应交个人所得税", "200")], subjects);
  assert.equal(payload[0].subject_label, "应交税费——应交个人所得税");
  assert.equal(payload[0].subject_key, "应交税费——应交个人所得税");
});

test("从凭证铺开：科目能对上表就用 id（下拉显示成分类/名称），对不上保留文本", () => {
  const lines = linesFromVoucher([
    { direction: "debit", subjectKey: "资产类/原材料", subjectLabel: "原材料", summary: "s", amount: "100.0000" },
    { direction: "credit", subjectKey: "银行存款—农业银行5706", subjectLabel: "银行存款—农业银行5706", summary: "s", amount: "100.0000", bank: { id: "bank-1" } },
  ], subjects);
  assert.equal(lines[0].subject, "sub-material", "命中的是 id");
  assert.equal(lines[1].subject, "银行存款—农业银行5706", "带账户快照的科目名对不上表，保留文本");
  assert.equal(lines[1].bankId, "bank-1", "资金行的银行账户要带过来");
  assert.equal(lines[0].direction, "debit");
  assert.notEqual(lines[0].key, lines[1].key, "每行的 key 必须唯一（增删行时 React 才不会复用错行）");
});

test("套用模板：替换全部分录、金额一律留空（不按税率自动拆进项税）", () => {
  const template = {
    key: "raw-material-purchase",
    name: "原材料采购",
    description: "",
    lines: [
      { direction: "debit", role: "business", summary: "采购原材料", subject_id: "sub-material", subject_label: "原材料", subject_key: "资产类/原材料", bank_id: null, bank_label: null },
      { direction: "debit", role: "business", summary: "进项税额（取得专票时）", subject_id: "sub-input", subject_label: "应交税费-进项税", subject_key: "负债类/应交税费-进项税", bank_id: null, bank_label: null },
      { direction: "credit", role: "business", summary: "应付供应商货款", subject_id: "sub-payable", subject_label: "应付账款", subject_key: "负债类/应付账款", bank_id: null, bank_label: null },
    ],
  };
  const lines = applyVoucherTemplate(template, null);
  assert.equal(lines.length, 3, "是替换而不是追加（追加会得到一张借贷各半的怪凭证）");
  assert.deepEqual(lines.map((item) => item.direction), ["debit", "debit", "credit"]);
  assert.deepEqual(lines.map((item) => item.amount), ["", "", ""]);
  assert.deepEqual(lines.map((item) => item.subject), ["sub-material", "sub-input", "sub-payable"]);
  assert.equal(new Set(lines.map((item) => item.key)).size, 3);
});

test("套用模板：科目候选落空时放建议名让财务自己选", () => {
  const template = {
    key: "salary-accrual", name: "工资计提", description: "",
    lines: [{ direction: "credit", role: "business", summary: "代扣个税", subject_id: null, subject_label: "应交税费——应交个人所得税", subject_key: "应交税费——应交个人所得税", bank_id: null, bank_label: null }],
  };
  assert.equal(applyVoucherTemplate(template, null)[0].subject, "应交税费——应交个人所得税");
});

test("套用模板：资金行沿用本凭证原有的银行账户（钱在哪张卡上是已确认的事实）", () => {
  const template = {
    key: "salary-accrual", name: "工资计提", description: "",
    lines: [{ direction: "credit", role: "fund", summary: "实发工资", subject_id: null, subject_label: "银行存款", subject_key: "银行存款", bank_id: null, bank_label: null }],
  };
  const current = { ...emptyVoucherLine("k"), bankId: "bank-9" };
  assert.equal(applyVoucherTemplate(template, current)[0].bankId, "bank-9");
  // 模板自己带了账户（后端按本凭证的原资金行填的）时以它为准。
  const withBank = { ...template, lines: [{ ...template.lines[0], bank_id: "bank-1" }] };
  assert.equal(applyVoucherTemplate(withBank, current)[0].bankId, "bank-1");
});
