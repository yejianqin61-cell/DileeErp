// 会计科目常量表的守卫（纯常量检查，不连数据库）。
//
// 为什么需要它：这张表是全站财务口径的**唯一来源** —— 收支流水的分类、确认应收/应付的自动归类、
// 报表的分类小计、凭证的业务科目全部取自它。常量写错一个字的后果不是「少个功能」，
// 而是「某一类流水被归到别的科目、报表数字对不上，而且只有财务对账时才会发现」。
// 本机没有可用 PostgreSQL，迁移无法在真实库上跑，所以这里把能静态验证的性质全部钉住。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ACCOUNTING_SUBJECTS,
  ACCOUNTING_SUBJECT_CATEGORIES,
  LEGACY_CASH_FLOW_ITEM_SUBJECTS,
  LEGACY_CASH_FLOW_ITEM_DICTIONARY_KEY,
  PAYMENT_SUBJECT_NAMES,
  DEFAULT_PAYMENT_SUBJECT_NAMES,
  RECEIVABLE_CONFIRM_SUBJECT_NAMES,
  PAYABLE_CONFIRM_SUBJECT_NAMES,
  accountingSubjectKey,
  compareAccountingSubjects,
  subjectCategoryRank,
  UNKNOWN_SUBJECT_CATEGORY_RANK,
  legacySubjectOf,
  paymentSubjectNames,
} = require("../../dist/modules/finance/accounting-subject-catalog.js");

const subjectKeys = new Set(ACCOUNTING_SUBJECTS.map((subject) => accountingSubjectKey(subject.category, subject.name)));

test("科目表就是财务那张表：121 条、5 个分类、条数与老表逐类相符", () => {
  assert.equal(ACCOUNTING_SUBJECTS.length, 121, "example/财务/科目表(2).xls 的 A2:H122 共 121 行科目");
  assert.deepEqual([...ACCOUNTING_SUBJECT_CATEGORIES], ["资产类", "负债类", "成本类", "所有者权益类", "损益类"]);
  const counts = new Map();
  for (const subject of ACCOUNTING_SUBJECTS) counts.set(subject.category, (counts.get(subject.category) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(counts), { 资产类: 39, 负债类: 15, 成本类: 17, 所有者权益类: 5, 损益类: 45 });
  for (const subject of ACCOUNTING_SUBJECTS) {
    assert.ok(ACCOUNTING_SUBJECT_CATEGORIES.includes(subject.category), `科目「${subject.name}」的分类「${subject.category}」不在 5 类之内`);
  }
});

test("科目代码整列不采纳；余额方向照抄老表", () => {
  // 用户口径原文：「那个编码的可以不管，分类就对应的是科目类别，项目就对应的是科目名称」。
  // 所以常量里不允许出现 code 字段 —— 出现就说明有人把编码偷偷加回来了。
  for (const subject of [...ACCOUNTING_SUBJECTS, ...LEGACY_CASH_FLOW_ITEM_SUBJECTS]) {
    assert.equal("code" in subject, false, `「${subject.name ?? subject.legacyKey}」不应该有科目代码字段`);
  }
  for (const subject of ACCOUNTING_SUBJECTS) {
    assert.ok(["借", "贷"].includes(subject.balanceDirection), `科目「${subject.name}」的余额方向只能是借或贷，实际是「${subject.balanceDirection}」`);
  }
});

test("科目名称全局唯一（自动归类按名称取候选，重名会让归类变得不确定）", () => {
  const seen = new Map();
  for (const subject of ACCOUNTING_SUBJECTS) {
    assert.equal(seen.has(subject.name), false, `科目名称「${subject.name}」重复了（${seen.get(subject.name)} 与 ${subject.category}）`);
    seen.set(subject.name, subject.category);
  }
});

test("sortOrder 单调递增且唯一（报表按它排序，才能让同一分类连成一段）", () => {
  const orders = ACCOUNTING_SUBJECTS.map((subject) => subject.sortOrder);
  assert.deepEqual(orders, [...orders].sort((left, right) => left - right), "sortOrder 必须递增");
  assert.equal(new Set(orders).size, orders.length, "sortOrder 不能重复");
  // 分类必须连成段：这是收支汇总表「分类小计」靠遍历插行的前提。
  const sequence = ACCOUNTING_SUBJECTS.map((subject) => subject.category);
  const blocks = sequence.filter((category, index) => index === 0 || sequence[index - 1] !== category);
  assert.equal(blocks.length, new Set(sequence).size, "同一个分类的科目必须连续排列，不能交错");
});

test("37 条旧收支项目全部有归属，且归属科目真实存在于科目表", () => {
  assert.equal(LEGACY_CASH_FLOW_ITEM_SUBJECTS.length, 37, "老表「项目」列有 37 行");
  assert.equal(LEGACY_CASH_FLOW_ITEM_DICTIONARY_KEY, "cash_flow_item", "旧字典的类型 key 必须与历史迁移里的字面量一致");
  const keys = new Set();
  for (const legacy of LEGACY_CASH_FLOW_ITEM_SUBJECTS) {
    assert.equal(keys.has(legacy.legacyKey), false, `旧项目「${legacy.legacyKey}」出现两次`);
    keys.add(legacy.legacyKey);
    assert.ok(subjectKeys.has(accountingSubjectKey(legacy.category, legacy.name)), `旧项目「${legacy.legacyKey}」归属的科目「${legacy.category}/${legacy.name}」在科目表里不存在`);
  }
});

test("并入映射里有 5 组是一对多：37 条旧项目落到 32 个不同科目", () => {
  // 一对多的那几组，科目只能沿用一个旧字典项的 id，另一条的历史引用必须由迁移改指。
  // 这个数字变化意味着合并关系变了 —— 迁移里的改指逻辑要跟着确认，所以在这里钉住。
  const targets = new Set(LEGACY_CASH_FLOW_ITEM_SUBJECTS.map((legacy) => accountingSubjectKey(legacy.category, legacy.name)));
  assert.equal(targets.size, 32, "37 条旧项目应归到 32 个不同科目（5 组一对多）");
  const merged = [...targets].filter((target) => LEGACY_CASH_FLOW_ITEM_SUBJECTS.filter((legacy) => accountingSubjectKey(legacy.category, legacy.name) === target).length > 1);
  assert.equal(merged.length, 5, "一对多的科目应有 5 个");
});

test("判断存疑的归属都在常量里写明理由", () => {
  // 这 12 条是老名与科目名不同义的：迁移前要请财务过目（docs/memo/0917-…对照表.md），
  // 所以每一条都必须带 note，否则「为什么这么归」在代码里就无从追溯。
  const ambiguous = ["原材料 成本", "外加工费 晋江大田工资", "房租支出", "货代费", "水电费", "机器折旧费用", "辅料费", "销售费用-货拉拉", "顺丰快递费", "差旅费", "银行费用利息", "电商费用", "国家退税", "人 工费", "中国银行 美元"];
  for (const key of ambiguous) {
    const found = legacySubjectOf(key);
    assert.ok(found, `旧项目「${key}」必须在并入映射里`);
    assert.ok(found.note?.trim(), `旧项目「${key}」的判断有争议，必须写 note 说明理由`);
  }
  assert.equal(legacySubjectOf("不存在的项目"), undefined, "查不到的旧 key 返回 undefined（迁移据此判定数据异常）");
});

test("每一种资金动账来源的自动归类候选都指向真实存在的科目", () => {
  // 历史缺陷：供应商付款写死了一个字典里不存在的 key，于是每一笔都被悄悄丢掉。
  // 候选指向不存在的科目 = 同一类事故，所以逐条校验。
  const all = [
    ...Object.entries(PAYMENT_SUBJECT_NAMES).flatMap(([source, names]) => names.map((name) => [source, name])),
    ...DEFAULT_PAYMENT_SUBJECT_NAMES.map((name) => ["默认兜底", name]),
    ...RECEIVABLE_CONFIRM_SUBJECT_NAMES.map((name) => ["确认应收", name]),
    ...PAYABLE_CONFIRM_SUBJECT_NAMES.map((name) => ["确认应付", name]),
  ];
  const names = new Set(ACCOUNTING_SUBJECTS.map((subject) => subject.name));
  for (const [source, name] of all) {
    assert.ok(names.has(name), `${source} 的候选科目「${name}」在科目表里不存在，这一类动账会被 422 挡住`);
  }
  assert.equal(all.length > 0, true, "候选链不能是空的（空链等于所有自动写入都失败）");
});

test("未知来源走兜底候选，不返回空数组", () => {
  assert.deepEqual(paymentSubjectNames("raw_material_inbound"), ["主营业务成本", "原材料"]);
  assert.deepEqual(paymentSubjectNames("outsource_receipt"), ["加工费"]);
  assert.deepEqual(paymentSubjectNames("customer_payment"), ["主营业务收入"]);
  assert.deepEqual(paymentSubjectNames("unknown_source"), DEFAULT_PAYMENT_SUBJECT_NAMES);
});

test("accountingSubjectKey 拼出唯一的科目标识", () => {
  assert.equal(accountingSubjectKey("损益类", "主营业务收入"), "损益类/主营业务收入");
  const keys = ACCOUNTING_SUBJECTS.map((subject) => accountingSubjectKey(subject.category, subject.name));
  assert.equal(new Set(keys).size, keys.length);
});

test("compareAccountingSubjects：分类按科目表顺序优先，同分类内才看 sortOrder / 名称", () => {
  // 这个比较器是列表页与收支汇总表的**唯一排序口径**：汇总表的「分类小计」靠同一分类的科目连续，
  // 而库层 sortOrder 排不出「分类优先」（财务新增的科目拿的是本分类内的号，可能大于别的分类）。
  const rows = [
    { category: "损益类", name: "主营业务收入", sortOrder: 770 },
    { category: "资产类", name: "银行存款", sortOrder: 5000 },
    { category: "成本类", name: "加工费", sortOrder: 620 },
    { category: "未分类", name: "迁移带出来的旧项目", sortOrder: 10 },
    { category: "资产类", name: "库存现金（备用金）", sortOrder: 10 },
  ];
  assert.deepEqual(
    [...rows].sort(compareAccountingSubjects).map((row) => accountingSubjectKey(row.category, row.name)),
    ["资产类/库存现金（备用金）", "资产类/银行存款", "成本类/加工费", "损益类/主营业务收入", "未分类/迁移带出来的旧项目"],
    "资产类 sortOrder 5000 的科目仍然排在成本类之前：分类优先，不受 sortOrder 大小影响",
  );
  assert.equal(subjectCategoryRank("资产类"), 0);
  assert.equal(subjectCategoryRank("损益类"), 4);
  assert.equal(subjectCategoryRank("未分类"), UNKNOWN_SUBJECT_CATEGORY_RANK, "5 类之外的分类一律排在最后");
});

test("compareAccountingSubjects：同分类同 sortOrder 时按名称，保证结果确定", () => {
  const rows = [
    { category: "资产类", name: "银行存款", sortOrder: 20 },
    { category: "资产类", name: "库存现金（备用金）", sortOrder: 20 },
  ];
  assert.deepEqual([...rows].sort(compareAccountingSubjects).map((row) => row.name), ["库存现金（备用金）", "银行存款"]);
});

test("科目表按科目表顺序排列时，每个分类恰好是一段（比较器与内置顺序一致）", () => {
  const sorted = [...ACCOUNTING_SUBJECTS].sort(compareAccountingSubjects).map((subject) => subject.category);
  assert.deepEqual(sorted, ACCOUNTING_SUBJECTS.map((subject) => subject.category), "常量本身已经是规范顺序，排序后不应变化");
});
