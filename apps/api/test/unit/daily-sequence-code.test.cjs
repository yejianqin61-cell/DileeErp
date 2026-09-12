const assert = require("node:assert/strict");
const { test } = require("node:test");
const { dailyCodePrefix, nextSequenceCode } = require("../../dist/platform/database/daily-sequence-code.js");

// 自动编码规则：前缀 = 类别 + YYYYMMDD，序号 = 当天同类编码里**数字后缀**的最大值 + 1（4 位补零）。
const prefix = dailyCodePrefix("CUS", new Date("2026-09-12T05:00:00.000Z"));

test("前缀按当天日期生成（YYYYMMDD）", () => {
  assert.equal(prefix, "CUS-20260912-");
  assert.equal(dailyCodePrefix("MAT", new Date("2026-01-02T23:59:59.000Z")), "MAT-20260102-");
});

test("当天没有编码时从 0001 开始", () => {
  assert.equal(nextSequenceCode(prefix, []), "CUS-20260912-0001");
  assert.equal(nextSequenceCode(prefix, [null, undefined]), "CUS-20260912-0001");
});

test("在最大数字后缀上 +1 并补零", () => {
  assert.equal(nextSequenceCode(prefix, ["CUS-20260912-0003"]), "CUS-20260912-0004");
  assert.equal(nextSequenceCode(prefix, ["CUS-20260912-0001", "CUS-20260912-0009", "CUS-20260912-0004"]), "CUS-20260912-0010");
});

test("手工编码里的非数字后缀不影响序号（旧实现会 Number('ABC') → NaN → 回退 0001 撞号）", () => {
  assert.equal(nextSequenceCode(prefix, ["CUS-20260912-ABC"]), "CUS-20260912-0001");
  assert.equal(nextSequenceCode(prefix, ["CUS-20260912-ABC", "CUS-20260912-0002"]), "CUS-20260912-0003");
});

test("序号超过 9999 后仍按数值比较（字符串排序会误判 '9999' > '10000'）", () => {
  assert.equal(nextSequenceCode(prefix, ["CUS-20260912-9999", "CUS-20260912-10000"]), "CUS-20260912-10001");
});

test("只统计同一前缀的编码，别的日期/类别不参与", () => {
  assert.equal(nextSequenceCode(prefix, ["CUS-20260911-0087", "SUP-20260912-0042"]), "CUS-20260912-0001");
});
