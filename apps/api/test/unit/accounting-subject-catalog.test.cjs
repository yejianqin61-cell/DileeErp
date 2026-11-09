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
  ACCOUNTING_SUBJECT_SEEDS,
  SUPPLEMENTARY_SUBJECTS,
  ACCOUNTING_SUBJECT_CATEGORIES,
  LEGACY_CASH_FLOW_ITEM_SUBJECTS,
  LEGACY_CASH_FLOW_ITEM_DICTIONARY_KEY,
  PAYMENT_SUBJECT_NAMES,
  DEFAULT_PAYMENT_SUBJECT_NAMES,
  RECEIVABLE_CONFIRM_SUBJECT_NAMES,
  PAYABLE_CONFIRM_SUBJECT_NAMES,
  INPUT_TAX_SUBJECT_NAMES,
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
  // 用**实际种入库的那份**（财务科目表 + 系统补充科目）：候选指向一个「不在种入清单里」的科目
  // 与指向一个不存在的科目是同一类事故 —— 2026-09-20 的「工资支付」正好落在补充清单里。
  const names = new Set(ACCOUNTING_SUBJECT_SEEDS.map((subject) => subject.name));
  for (const [source, name] of all) {
    assert.ok(names.has(name), `${source} 的候选科目「${name}」不在种入清单里，这一类动账会被 422 挡住`);
  }
  assert.equal(all.length > 0, true, "候选链不能是空的（空链等于所有自动写入都失败）");
});

test("工资付款的默认归类指向「工资支付」（用户 2026-09-20：好做账、好出表）", () => {
  assert.equal(paymentSubjectNames("salary_payment")[0], "工资支付", "候选链首位必须是工资支付，否则不选科目时会归到临时工资");
  assert.deepEqual(paymentSubjectNames("salary_payment"), ["工资支付", "临时工资", "基本生产成本"], "后两个是历史兜底，不能被删掉");
});

/* ------------------------------------------------- 系统补充科目（不在财务那张表里） */

test("补充科目：不混进 ACCOUNTING_SUBJECTS（财务科目表 121 行的口径必须保持纯净）", () => {
  assert.equal(ACCOUNTING_SUBJECTS.length, 121, "补一个科目就把长度改成 122，等于把「科目表 = 财务那张 xls」的守卫废掉");
  assert.ok(SUPPLEMENTARY_SUBJECTS.length >= 1);
  const tableNames = new Set(ACCOUNTING_SUBJECTS.map((subject) => subject.name));
  for (const subject of SUPPLEMENTARY_SUBJECTS) {
    assert.equal(tableNames.has(subject.name), false, `补充科目「${subject.name}」不该同时出现在财务科目表里`);
  }
  assert.equal(ACCOUNTING_SUBJECT_SEEDS.length, ACCOUNTING_SUBJECTS.length + SUPPLEMENTARY_SUBJECTS.length);
});

test("补充科目「工资支付」：成本类、借方、名称与排序号都不与既有科目冲突", () => {
  const wagePayment = ACCOUNTING_SUBJECT_SEEDS.find((subject) => subject.name === "工资支付");
  assert.ok(wagePayment, "工资支付必须种入库");
  assert.equal(wagePayment.category, "成本类");
  assert.equal(wagePayment.balanceDirection, "借");
  assert.equal(wagePayment.sortOrder, 715);

  // 与合并后的全量清单一起校验：名称唯一、sortOrder 唯一且递增、分类仍连成段。
  const names = ACCOUNTING_SUBJECT_SEEDS.map((subject) => subject.name);
  assert.equal(new Set(names).size, names.length, "科目名重复会让自动归类变得不确定");
  const orders = ACCOUNTING_SUBJECT_SEEDS.map((subject) => subject.sortOrder);
  assert.deepEqual(orders, [...orders].sort((left, right) => left - right), "合并后 sortOrder 仍须递增");
  assert.equal(new Set(orders).size, orders.length, "合并后 sortOrder 不能重复");
  const sequence = ACCOUNTING_SUBJECT_SEEDS.map((subject) => subject.category);
  const blocks = sequence.filter((category, index) => index === 0 || sequence[index - 1] !== category);
  assert.equal(blocks.length, new Set(sequence).size, "同一分类必须连续（否则报表的分类小计会被拆成两行）");
});

test("未知来源走兜底候选，不返回空数组", () => {
  // D1（2026-11-09 用户拍板「原材料作为存货吧」）：采购入库先记资产类「原材料」，
  // 「主营业务成本」退为兜底 —— 入库即费用化会同时错列资产负债表的存货与利润表的成本。
  assert.deepEqual(paymentSubjectNames("raw_material_inbound"), ["原材料", "主营业务成本"], "原料入库首位必须是「原材料」");
  assert.deepEqual(paymentSubjectNames("purchase_receipt"), ["原材料", "主营业务成本"], "到货单来源同口径");
  assert.deepEqual(DEFAULT_PAYMENT_SUBJECT_NAMES, ["原材料", "主营业务成本"], "未挂账付款的借方兜底同口径");
  assert.deepEqual(PAYABLE_CONFIRM_SUBJECT_NAMES, ["原材料", "主营业务成本"], "识别不出来源时的确认兜底同口径");
  assert.deepEqual(paymentSubjectNames("outsource_receipt"), ["加工费"]);
  assert.deepEqual(paymentSubjectNames("customer_payment"), ["主营业务收入"]);
  assert.deepEqual(paymentSubjectNames("unknown_source"), DEFAULT_PAYMENT_SUBJECT_NAMES);
});

test("进项税科目候选（D5）：顺序固定、干净库上必须能命中，专票拆分不会因缺目录而必然 422", () => {
  // 2026-11-09 用户拍板 D5：专票挂账拆「借 业务科目（不含税）+ 借 应交税费-进项税（税额）」。
  // 候选顺序就是「科目表实际存在的明细 → 外账口头叫法 → 科目表本体兜底」，顺序变了会挂错明细科目。
  assert.deepEqual([...INPUT_TAX_SUBJECT_NAMES], ["应交税费-进项税", "应交税费-应交增值税（进项税额）", "应交税费"]);
  assert.equal(new Set(INPUT_TAX_SUBJECT_NAMES).size, INPUT_TAX_SUBJECT_NAMES.length, "候选不能重复（重复会让解析顺序失去意义）");
  const seeded = new Set(ACCOUNTING_SUBJECT_SEEDS.map((subject) => subject.name));
  assert.equal(seeded.has(INPUT_TAX_SUBJECT_NAMES[0]), true, "首位候选「应交税费-进项税」必须在种入科目表里，否则干净库上每一张专票都会 422");
  assert.equal(seeded.has(INPUT_TAX_SUBJECT_NAMES[INPUT_TAX_SUBJECT_NAMES.length - 1]), true, "末位兜底「应交税费」也必须在（明细被停用/改名时退到它）");
  // 中间那个是财务/外账的口头叫法，财务那张科目表里没有 —— 它只在「别的科目表版本」才可能命中，
  // 所以不能要求它必须存在；解析按顺序取第一个存在的。
  assert.equal(seeded.has("应交税费-应交增值税（进项税额）"), false);
  assert.equal(INPUT_TAX_SUBJECT_NAMES.find((name) => seeded.has(name)), "应交税费-进项税", "干净库上应落到「应交税费-进项税」");
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
