const test = require("node:test");
const assert = require("node:assert/strict");
const { adjustmentNet, adjustmentOutstanding, assertAdjustmentWithinBalance, reconciliationStatus, closeBlockers } = require("../../dist/modules/finance/receivable-adjustment.domain.js");

test("E5 calculates independent adjustment net without changing source facts", () => {
  assert.equal(adjustmentNet([{ effect: "decrease", amount: "20" }, { effect: "increase", amount: "5" }]).toString(), "-15");
  assert.equal(adjustmentOutstanding("100", "30", [{ effect: "decrease", amount: "20" }]).toString(), "50");
});

test("E5 blocks a refund or red credit beyond the current source balance", () => {
  assert.equal(assertAdjustmentWithinBalance("20", "70"), "50");
  assert.throws(() => assertAdjustmentWithinBalance("71", "70"), /adjustment exceeds/);
});

test("E5 marks reconciliation differences and allows exact matches", () => {
  assert.equal(reconciliationStatus("80.0000", "80"), "matched");
  assert.equal(reconciliationStatus("80", "79.99"), "difference");
});

test("E5 exposes every order-close blocker without mutating order state", () => {
  assert.deepEqual(closeBlockers({ productionComplete: false, outboundComplete: false, outstandingAmount: "10", unresolvedReconciliations: 1, unreversedAdjustments: 2 }), ["PRODUCTION_NOT_COMPLETE", "OUTBOUND_NOT_COMPLETE", "RECEIVABLE_OUTSTANDING", "UNRESOLVED_RECONCILIATION", "UNREVERSED_ADJUSTMENT"]);
  assert.deepEqual(closeBlockers({ productionComplete: true, outboundComplete: true, outstandingAmount: "0", unresolvedReconciliations: 0, unreversedAdjustments: 0 }), []);
});

// ---------------------------------------------------------------- 边界与口径

test("没有调整行时净额为 0，未收额等于「应收 − 已收」（不能因为少了调整就报错）", () => {
  assert.equal(adjustmentNet([]).toString(), "0");
  assert.equal(adjustmentOutstanding("100.0000", "30.0000", []).toString(), "70");
});

test("调整净额用十进制运算，不引入浮点误差", () => {
  // 0.1 + 0.2 用 JS 浮点是 0.30000000000000004；这里必须是精确的 0.3
  assert.equal(adjustmentNet([{ effect: "increase", amount: "0.1" }, { effect: "increase", amount: "0.2" }]).toString(), "0.3");
  assert.equal(adjustmentOutstanding("0.3", "0", [{ effect: "increase", amount: "0.1" }, { effect: "increase", amount: "0.2" }]).toString(), "0.6");
});

test("effect 不是 increase 的一律按减少处理（写入侧由 service 校验，这里钉住口径）", () => {
  // 这条是在记录**当前行为**：纯函数不校验 effect，未知取值会走 negated 分支。
  // 因此 service.create 必须先做 EFFECTS 白名单校验，否则拼错的方向会静默变成「减少」。
  assert.equal(adjustmentNet([{ effect: "decrease", amount: "5" }]).toString(), "-5");
  assert.equal(adjustmentNet([{ effect: "typo", amount: "5" }]).toString(), "-5");
  assert.equal(adjustmentNet([{ effect: "INCREASE", amount: "5" }]).toString(), "-5", "大小写敏感：必须是精确的 increase");
});

test("未收额允许为负（超额退款已发生时要如实暴露，不能夹到 0）", () => {
  assert.equal(adjustmentOutstanding("100", "100", [{ effect: "decrease", amount: "20" }]).toString(), "-20");
});

test("调整金额必须是 (0, 余额] 区间：等于余额可放行并归零，超出或非正则拒绝", () => {
  assert.equal(assertAdjustmentWithinBalance("70", "70"), "0", "正好等于余额应当放行（清账）");
  assert.equal(assertAdjustmentWithinBalance("1", "70"), "69");
  assert.throws(() => assertAdjustmentWithinBalance("70.0001", "70"), /adjustment exceeds/, "超出余额一分钱也不行");
  assert.throws(() => assertAdjustmentWithinBalance("0", "70"), /adjustment exceeds/, "0 元调整没有意义，必须拒绝");
  assert.throws(() => assertAdjustmentWithinBalance("-5", "70"), /adjustment exceeds/, "负数会把减少变成增加");
});

test("对账状态按十进制数值比较，不比较字符串（80.0000 与 80 必须算相等）", () => {
  assert.equal(reconciliationStatus("0", "0"), "matched");
  assert.equal(reconciliationStatus("80.0000", "80"), "matched");
  assert.equal(reconciliationStatus("80", "80.0001"), "difference");
  assert.equal(reconciliationStatus("-0.00", "0"), "matched", "负零与零相等");
});

test("关单阻断项只列真正卡住的那几条，且顺序稳定可预期", () => {
  const base = { productionComplete: true, outboundComplete: true, outstandingAmount: "0", unresolvedReconciliations: 0, unreversedAdjustments: 0 };
  assert.deepEqual(closeBlockers({ ...base, outboundComplete: false }), ["OUTBOUND_NOT_COMPLETE"]);
  assert.deepEqual(closeBlockers({ ...base, outstandingAmount: "0.0001" }), ["RECEIVABLE_OUTSTANDING"], "差一分钱也算未收清");
  assert.deepEqual(closeBlockers({ ...base, unresolvedReconciliations: 1 }), ["UNRESOLVED_RECONCILIATION"]);
  assert.deepEqual(closeBlockers({ ...base, unreversedAdjustments: 1 }), ["UNREVERSED_ADJUSTMENT"]);
  assert.deepEqual(closeBlockers({ ...base, productionComplete: false, outboundComplete: false }), ["PRODUCTION_NOT_COMPLETE", "OUTBOUND_NOT_COMPLETE"]);
});
