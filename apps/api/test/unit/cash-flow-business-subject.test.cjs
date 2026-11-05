// 收支流水的「业务科目」口径（2026-11-05）。
//
// 用户报障：「每一笔确认应付中选择的会计科目，到了收支流水中都是错的，但凭证里又是对的。
// 看一下线上数据库里收支流水 CF-20261105-9CFB412B 这笔流水」（确认应付 APO-20261027-CE78BFBC）。
//
// 线上事实：流水主科目 `subject_id` = 负债类/应付账款（销账那条现金分录的对方科目，生成凭证用它），
// 收支类目 `category_subject_id` = 损益类/管理费用（财务在确认应付时选的那个）。
// 财务说「会计科目」时指的是后者 —— 它才该出现在流水列表与收支报表的「分类 / 项目」里。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { cashFlowBusinessSubject, cashFlowSubjectWhere } = require("../../dist/modules/finance/cash-flow.domain.js");

const AP = { id: "subject-ap", category: "负债类", name: "应付账款" };
const EXPENSE = { id: "subject-expense", category: "损益类", name: "管理费用" };

test("业务科目：有收支类目时用类目（线上 CF-20261105-9CFB412B 的口径）", () => {
  assert.deepEqual(cashFlowBusinessSubject({ subject: AP, categorySubject: EXPENSE }), EXPENSE);
});

test("业务科目：手工流水没有类目 → 退回主科目（录的时候只选了一个科目）", () => {
  assert.deepEqual(cashFlowBusinessSubject({ subject: EXPENSE, categorySubject: null }), EXPENSE);
  assert.deepEqual(cashFlowBusinessSubject({ subject: EXPENSE }), EXPENSE);
});

test("业务科目：两者都没有（科目被硬删）时返回 null，页面据此显示「-」", () => {
  assert.equal(cashFlowBusinessSubject({ subject: null, categorySubject: null }), null);
});

test("筛选口径：按科目筛的是业务科目，类目为空的历史/手工流水退回主科目", () => {
  assert.deepEqual(cashFlowSubjectWhere({ subjectId: "s1" }), {
    OR: [{ categorySubjectId: "s1" }, { categorySubjectId: null, subjectId: "s1" }],
  });
});

test("筛选口径：分类按业务科目的类别筛，两个条件同时给是「交」不是「并」", () => {
  assert.deepEqual(cashFlowSubjectWhere({ category: "损益类" }), {
    OR: [{ categorySubject: { category: "损益类" } }, { categorySubjectId: null, subject: { category: "损益类" } }],
  });
  assert.deepEqual(cashFlowSubjectWhere({ subjectId: "s1", category: "损益类" }), {
    AND: [
      { OR: [{ categorySubjectId: "s1" }, { categorySubjectId: null, subjectId: "s1" }] },
      { OR: [{ categorySubject: { category: "损益类" } }, { categorySubjectId: null, subject: { category: "损益类" } }] },
    ],
  });
});

test("筛选口径：都不给时返回空条件（列表/报表不加限制）", () => {
  assert.deepEqual(cashFlowSubjectWhere({}), {});
  assert.deepEqual(cashFlowSubjectWhere({ subjectId: undefined, category: undefined }), {});
});
