// 「操作时间」格式化的单元测试（与前端 apps/web/lib/audit-time.test.mjs 用同一组向量）。
//
// 生产文件：apps/api/src/platform/time/beijing-time.ts
//
// 这一层为什么必须固定时区：Excel 导出在 API 容器里生成、界面在浏览器里渲染，
// 两边宿主时区未必相同；用 toLocaleString() 会让同一行的「操作时间」在界面和导出文件里差一个时区。
// 本文件最后一条显式把 process.env.TZ 换成 America/New_York 再断言一遍 ——
// 本机宿主恰好是 +08，不换时区的话「按宿主时区走的错误实现」也会通过。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BEIJING_TIME_ZONE, beijingDate, beijingDateTime, beijingDateTimeShort, beijingStamp, toInstant } = require("../../dist/platform/time/beijing-time.js");

test("beijingDateTime：固定北京时间，到分为默认精度", () => {
  assert.equal(beijingDateTime("2026-09-16T00:30:00Z"), "2026-09-16 08:30");
  assert.equal(beijingDateTime(new Date("2026-09-16T06:05:00Z")), "2026-09-16 14:05");
  assert.equal(beijingDateTime("2026-09-16T00:30:45Z", { seconds: true }), "2026-09-16 08:30:45");
});

test("beijingDateTime：午夜是 00:00 而不是 24:00", () => {
  assert.equal(beijingDateTime("2026-09-15T16:00:00Z"), "2026-09-16 00:00");
  assert.equal(beijingDateTime("2026-12-31T16:00:00Z"), "2027-01-01 00:00");
});

test("beijingDateTime：跨年跨月按北京时间归属", () => {
  assert.equal(beijingDateTime("2025-12-31T20:00:00Z"), "2026-01-01 04:00");
  assert.equal(beijingDateTime("2026-01-31T17:00:00Z"), "2026-02-01 01:00");
});

test("beijingDateTime：空值与非法输入给空串（导出里就是空格子）", () => {
  for (const value of [null, undefined, "", "不是时间", Number.NaN]) assert.equal(beijingDateTime(value), "");
});

test("beijingDateTimeShort：同年省略年份，跨年带年份，年份按北京时间的年比较", () => {
  assert.equal(beijingDateTimeShort("2026-09-16T00:30:00Z", { now: "2026-09-20T00:00:00Z" }), "09-16 08:30");
  assert.equal(beijingDateTimeShort("2025-12-31T10:00:00Z", { now: "2026-06-01T00:00:00Z" }), "2025-12-31 18:00");
  // now 在 UTC 还是 2025-12-31，北京已是 2026-01-01；拿 UTC 年比就会误判成跨年。
  assert.equal(beijingDateTimeShort("2026-03-01T00:00:00Z", { now: "2025-12-31T17:00:00Z" }), "03-01 08:00");
  assert.equal(beijingDateTimeShort(null), "");
});

test("beijingDate：只给日期", () => {
  assert.equal(beijingDate("2026-09-15T16:00:00Z"), "2026-09-16");
  assert.equal(beijingDate(null), "");
});

test("beijingStamp：导出文件名里的紧凑时间戳，同样按北京时间", () => {
  // 用 toISOString() 的 UTC 会让文件名（06:30）和文件里的「制表时间」（14:30）对不上。
  assert.equal(beijingStamp("2026-09-15T16:00:00Z"), "20260916000000");
  assert.equal(beijingStamp("2026-09-16T06:30:05Z"), "20260916143005");
  assert.equal(beijingStamp(null), "");
  assert.equal(beijingStamp().length, 14, "默认取当前时间，定长 14 位");
});

test("toInstant：Date / ISO / 毫秒数都认，空与非法给 null", () => {
  assert.equal(toInstant("2026-09-16T00:30:00Z").toISOString(), "2026-09-16T00:30:00.000Z");
  assert.equal(toInstant(Date.parse("2026-09-16T00:30:00Z")).toISOString(), "2026-09-16T00:30:00.000Z");
  for (const value of [null, undefined, ""]) assert.equal(toInstant(value), null);
  assert.equal(toInstant("不是时间"), null);
});

test("输出与宿主时区无关（把宿主换成 America/New_York 再验一遍）", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    assert.equal(beijingDateTime("2026-09-16T00:30:00Z"), "2026-09-16 08:30");
    assert.equal(beijingDateTime("2026-01-15T00:30:00Z"), "2026-01-15 08:30");
    assert.equal(beijingDateTimeShort("2026-09-16T00:30:00Z", { now: "2026-09-20T00:00:00Z" }), "09-16 08:30");
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
  assert.equal(BEIJING_TIME_ZONE, "Asia/Shanghai");
});
