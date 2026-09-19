// 「操作时间」格式化的测试（node:test，不是 vitest —— lib 下的纯函数按仓库约定走 node --test）。
//
// 与后端 apps/api/src/platform/time/beijing-time.ts 是两份等价实现，
// 本文件与 apps/api/test/unit/beijing-time.test.cjs **用同一组向量**，两边一起改。
//
// 本文件最要紧的一条：**输出不随宿主时区变化**。
// 只写 `expect(format(x)).toBe("2026-09-16 08:30")` 是不够的 —— 本机宿主恰好是 +08
// （Asia/Singapore），一个按宿主时区走的错误实现（toLocaleString）同样会通过。
// 所以下面显式把 process.env.TZ 换成 America/New_York 再断言一次。
import assert from "node:assert/strict";
import { test } from "node:test";
import { BEIJING_TIME_ZONE, formatBeijing, formatBeijingDate, formatBeijingShort, toInstant } from "./audit-time.ts";

test("formatBeijing：固定北京时间，到分为默认精度", () => {
  assert.equal(formatBeijing("2026-09-16T00:30:00Z"), "2026-09-16 08:30");
  assert.equal(formatBeijing(new Date("2026-09-16T06:05:00Z")), "2026-09-16 14:05");
  assert.equal(formatBeijing("2026-09-16T00:30:45Z", { seconds: true }), "2026-09-16 08:30:45");
});

test("formatBeijing：午夜是 00:00 而不是 24:00", () => {
  // 只写 hour12:false 时，部分 ICU 版本会把午夜格式化成 24:00，列里会出现「09-16 24:00」。
  assert.equal(formatBeijing("2026-09-15T16:00:00Z"), "2026-09-16 00:00");
  assert.equal(formatBeijing("2026-12-31T16:00:00Z"), "2027-01-01 00:00");
});

test("formatBeijing：跨年与跨月按北京时间归属，不按 UTC", () => {
  assert.equal(formatBeijing("2025-12-31T20:00:00Z"), "2026-01-01 04:00");
  assert.equal(formatBeijing("2026-01-31T17:00:00Z"), "2026-02-01 01:00");
});

test("formatBeijing：空值与非法输入给空串（调用方自己决定显示 - 还是 —）", () => {
  for (const value of [null, undefined, "", "不是时间", Number.NaN]) assert.equal(formatBeijing(value), "");
  assert.equal(formatBeijing("2026-09-16T00:30:00Z", { seconds: true }).length, 19);
});

test("formatBeijingShort：同年省略年份，跨年才带年份", () => {
  assert.equal(formatBeijingShort("2026-09-16T00:30:00Z", { now: "2026-09-20T00:00:00Z" }), "09-16 08:30");
  assert.equal(formatBeijingShort("2025-12-31T10:00:00Z", { now: "2026-06-01T00:00:00Z" }), "2025-12-31 18:00");
});

test("formatBeijingShort：年份比较用的是「北京时间的年」，不是宿主/UTC 的年", () => {
  // now 落在 UTC 的 2025-12-31，但北京已经是 2026-01-01；
  // value 在北京是 2026-03-01 → 与 now 同年 → 应省略年份。
  // 若实现拿 UTC 年（2025）去比，就会错判成跨年、多印一个 2026。
  assert.equal(formatBeijingShort("2026-03-01T00:00:00Z", { now: "2025-12-31T17:00:00Z" }), "03-01 08:00");
  assert.equal(formatBeijingShort(null, { now: "2025-12-31T17:00:00Z" }), "");
});

test("formatBeijingDate：只给日期", () => {
  assert.equal(formatBeijingDate("2026-09-15T16:00:00Z"), "2026-09-16");
  assert.equal(formatBeijingDate(null), "");
});

test("toInstant：Date / ISO / 毫秒数都认，空与非法给 null", () => {
  assert.equal(toInstant("2026-09-16T00:30:00Z")?.toISOString(), "2026-09-16T00:30:00.000Z");
  assert.equal(toInstant(Date.parse("2026-09-16T00:30:00Z"))?.toISOString(), "2026-09-16T00:30:00.000Z");
  for (const value of [null, undefined, ""]) assert.equal(toInstant(value), null);
  assert.equal(toInstant("不是时间"), null);
});

test("输出与宿主时区无关（把宿主换成 America/New_York 再验一遍）", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    assert.equal(formatBeijing("2026-09-16T00:30:00Z"), "2026-09-16 08:30");
    assert.equal(formatBeijing("2026-01-15T00:30:00Z"), "2026-01-15 08:30");
    assert.equal(formatBeijingShort("2026-09-16T00:30:00Z", { now: "2026-09-20T00:00:00Z" }), "09-16 08:30");
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
  assert.equal(BEIJING_TIME_ZONE, "Asia/Shanghai");
});
