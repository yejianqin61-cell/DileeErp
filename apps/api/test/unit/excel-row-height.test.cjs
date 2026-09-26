// Excel 行高估算的单元测试（用户 2026-09-24：「销售单导出，用户反馈行高需要自己调，不美观，太扁了」）。
//
// 四个必须钉死的口径：
//   1. **按显示宽度算，不按字符数**：一个汉字占 2 个列宽单位。按 `text.length` 算会让
//      「伞骨（孔对孔）」这类全中文的格子少算一半行数 —— 那正是「太扁」的病根；
//   2. **显式换行优先**：财务在备注 / 正唛里敲的回车必须各占一行；
//   3. **有下限也有上限**：短行不低于 MIN（不挤在一起），超长文本不超过 MAX（备注 2000 字
//      不把一张工艺单撑成两页）；
//   4. **代理对算一个字符**：emoji 与增补平面的汉字按 UTF-16 下标迭代会被算成两个，宽度直接翻倍。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  CJK_WIDTH_UNITS,
  LINE_HEIGHT,
  MAX_ROW_HEIGHT,
  MIN_ROW_HEIGHT,
  columnSpanWidth,
  displayWidth,
  rowHeightFor,
  wrappedLines,
} = require("../../dist/platform/excel/row-height.js");

test("displayWidth：汉字算两个单位、ASCII 算一个（列宽单位是「字符 0 的宽度」）", () => {
  assert.equal(displayWidth(""), 0);
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("50cm*5K"), 7);
  assert.equal(displayWidth("伞骨"), 4);
  assert.equal(displayWidth("伞骨（孔对孔）"), 14, "中文 + 全角括号都算 2 个单位");
  assert.equal(displayWidth("伞骨 50cm"), 4 + 1 + 4, "空格算 1");
  assert.equal(CJK_WIDTH_UNITS, 2);
});

test("displayWidth：emoji 与增补平面汉字按**一个**字符算（UTF-16 下标迭代会算成两个）", () => {
  assert.equal(displayWidth("🌂"), 2, "emoji 落在代理对里，按码点迭代是一个字符（宽 2）");
  assert.equal(displayWidth("🌂🌂"), 4);
  assert.equal(displayWidth("\u{20000}"), 2, "中日韩扩展 B 的汉字同样是宽字符");
  assert.equal(displayWidth("a\u200bb"), 2, "零宽空格不占格子");
});

test("wrappedLines：按可用宽度折行，且留 1 个单位的余量（否则最后一个字会被挤到下一行）", () => {
  assert.equal(wrappedLines("", 20), 0, "空文本不占行");
  assert.equal(wrappedLines(null, 20), 0);
  assert.equal(wrappedLines("短", 20), 1);
  // 宽度 20 → 可用 19 个单位：38 个 ASCII 字符要两行，正好 19 个只要一行。
  assert.equal(wrappedLines("x".repeat(19), 20), 1);
  assert.equal(wrappedLines("x".repeat(20), 20), 2);
  assert.equal(wrappedLines("中文".repeat(5), 20), 2, "10 个汉字 = 20 单位 > 19 → 两行");
  assert.equal(wrappedLines("中文", 1), 4, "列宽小到 1 时按 1 个单位可用宽度算（4 个单位宽 → 4 行），不能除以 0 得 Infinity");
});

test("wrappedLines：显式换行各占一行（财务敲的回车不能被当成自动折行吃掉）", () => {
  assert.equal(wrappedLines("第一行\n第二行", 60), 2);
  assert.equal(wrappedLines("第一行\r\n第二行", 60), 2, "Windows 的 \\r\\n 也只算一次换行");
  assert.equal(wrappedLines("上\n\n下", 60), 3, "空行也算一行（用户敲了两个回车就是想要一行空白）");
  // 显式换行与自动折行叠加：一行里放 40 个 ASCII（宽 40 > 可用 39）→ 2 行，加第二段 1 行 = 3 行。
  assert.equal(wrappedLines(`${"x".repeat(40)}\nend`, 40), 3);
});

test("columnSpanWidth：按列宽表加出跨列可用宽度（B:F 与 G:J 就是工艺单那两栏）", () => {
  const widths = [16, 14, 10, 12, 14, 10, 8, 10, 10, 10];
  assert.equal(columnSpanWidth(widths, 1, 10), 114, "整行 A:J");
  assert.equal(columnSpanWidth(widths, 2, 6), 60, "材料/明细值 B:F");
  assert.equal(columnSpanWidth(widths, 7, 10), 38, "工艺要求 G:J");
  assert.equal(columnSpanWidth(widths, 1, 2), 30, "细分明细的品番/品名 A:B");
  assert.equal(columnSpanWidth(widths, 2, 5), 50, "正唛 / 布量 B:E");
  assert.equal(columnSpanWidth(widths, 3, 3), 10, "单列");
  assert.equal(columnSpanWidth(widths, 20, 22), 0, "越界不报错，加 0");
});

test("rowHeightFor：短行取下限、长行按行数长高、超长封顶", () => {
  // 短文本：下限 20（历史上分录行就写死 20，短行不能比它更扁）
  assert.equal(rowHeightFor([{ text: "伞骨（孔对孔）", width: 60 }]), MIN_ROW_HEIGHT);
  assert.equal(rowHeightFor([]), MIN_ROW_HEIGHT, "没有任何块也要给一个能用的高度");
  assert.equal(rowHeightFor([{ text: null, width: 60 }]), MIN_ROW_HEIGHT);

  // 5 行：材料格 B:F 宽 60 → 可用 59；每行放 29 个汉字（58 单位）→ 5 行
  const fiveLines = "甲".repeat(29 * 5);
  assert.equal(wrappedLines(fiveLines, 60), 5);
  assert.equal(rowHeightFor([{ text: fiveLines, width: 60 }]), 5 * LINE_HEIGHT);

  // 左右两栏：取**需要行数更多的那一栏**，不是相加
  assert.equal(rowHeightFor([{ text: "甲".repeat(100), width: 60 }, { text: "短", width: 38 }]), Math.ceil(200 / 59) * LINE_HEIGHT);
  assert.equal(rowHeightFor([{ text: "短", width: 60 }, { text: "短", width: 38 }]), MIN_ROW_HEIGHT);

  // 上限：注意事项最多 2000 字，落在 114 宽的整行里会算出 30+ 行 → 必须封顶
  assert.equal(MAX_ROW_HEIGHT, 300);
  assert.equal(rowHeightFor([{ text: "甲".repeat(2000), width: 114 }]), MAX_ROW_HEIGHT);
  assert.equal(rowHeightFor([{ text: "甲".repeat(2000), width: 114 }]) < wrappedLines("甲".repeat(2000), 114) * LINE_HEIGHT, true, "封顶后必须真的比「老实算」矮");
});
