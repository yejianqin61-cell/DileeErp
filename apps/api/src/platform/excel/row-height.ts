/**
 * Excel 行高估算（2026-09-24）。
 *
 * ## 为什么需要它
 *
 * 用户的原话：「销售单导出，用户反馈行高需要自己调，不美观，太扁了。我们能不能根据行数进行自动的行高调整」。
 *
 * ExcelJS **不做自动行高**（`row.height` 只有「写死」与「不写」两种；不写时 Excel 用默认高度 15，
 * 换行文字会被截成一行）。所以「自动」这件事只能由我们在服务端算：按每个格子的**文字宽度**
 * 除以它**跨列的可用宽度**，得到折行数，再乘行高。
 *
 * ## 口径（三条，都有测试钉住）
 *
 * 1. **宽度按显示宽度算，不按字符数**：Excel 的列宽单位是「标准字体下字符 `0` 的宽度」，
 *    而一个汉字约占 **2** 个单位。按 `text.length` 算会让「伞骨（孔对孔）」这种全中文的格子
 *    少算一半折行数 —— 那正是这次要修的病（用户看到的「太扁」就是文字被压在一行里）。
 * 2. **显式换行（`\n`）优先**：财务在备注里敲的回车必须算作一次换行，不能和自动折行混在一起。
 * 3. **必须有上限**：备注/注意事项最多 2000 字，落在一格 114 单位宽的格里是 30 多行、
 *    约 500 磅高，会把一张工艺单撑成两页。超过上限就截断高度，让 Excel 自己去滚动单元格
 *    （印出来仍然是一个格子，比整张单子排版错位好）。
 */

/** 一位 CJK 字符占的列宽单位数（Excel 列宽以字符 `0` 为 1 个单位，汉字约等于 2）。 */
export const CJK_WIDTH_UNITS = 2;
/** 单行高度（磅）。11pt 宋体在 Excel 里的默认行高是 15。 */
export const LINE_HEIGHT = 15;
/** 行高下限：比默认行高略高一点，短行不至于挤在一起（与历史上写死的 20 一致）。 */
export const MIN_ROW_HEIGHT = 20;
/**
 * 行高上限（磅）。300 ≈ 20 行，约等于半页 A4。
 * 为什么要截断而不是老实算：单格上限 2000 字的字段（注意事项 / 正唛 / 侧唛）能算出 30+ 行，
 * 一张工艺单会因此被撑成两页 —— 用户要的是「好看」，不是「把整段备注铺满一页」。
 */
export const MAX_ROW_HEIGHT = 300;

/**
 * 文本的**显示宽度**（Excel 列宽单位）。
 *
 * 中日韩文字、全角标点算 2 个单位，其余算 1。零宽字符（组合记号等）按 0 算 —— 它们不占格子，
 * 算进去只会让行高虚高。
 */
export function displayWidth(text: string): number {
  let width = 0;
  // `for...of` 按码点迭代：emoji 与增补平面的汉字（都是代理对）必须算**一个**字符，
  // 按 UTF-16 下标迭代会把它们算成两个，宽度直接翻倍。
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) continue;
    width += isWide(code) ? CJK_WIDTH_UNITS : 1;
  }
  return width;
}

/**
 * 该码点是否按「两个单位宽」算。
 *
 * 只列常见的宽字符区间，不做完整的 East Asian Width 表（那是几百行的数据表，而导出件里的
 * 文字是工厂单据上的中文、英文、数字与常见标点 —— 为罕见的谚文字母建一张全表不划算）。
 */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // 谚文字母
    (code >= 0x2e80 && code <= 0x303e) || // 中日韩部首、标点
    (code >= 0x3041 && code <= 0x33ff) || // 假名、注音、中日韩兼容
    (code >= 0x3400 && code <= 0x4dbf) || // 中日韩扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 中日韩统一表意文字
    (code >= 0xa000 && code <= 0xa4cf) || // 彝文
    (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // 中日韩兼容表意文字
    (code >= 0xfe30 && code <= 0xfe6f) || // 中日韩兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII
    (code >= 0xffe0 && code <= 0xffe6) || // 全角符号
    (code >= 0x1f300 && code <= 0x1faff) || // emoji（默认就是宽字符）
    (code >= 0x20000 && code <= 0x3fffd) // 中日韩扩展 B 及以上
  );
}

/**
 * 文本在给定列宽下会折成几行（至少 1 行；空文本算 0 行）。
 *
 * `-1` 的余量是给单元格内边距的：Excel 的列宽与实际可写宽度不相等，按满宽算会**恰好**差一点点，
 * 表现为「最后一个字被挤到下一行」—— 那会让行高少算一行，又变回「太扁」。
 */
export function wrappedLines(text: string | null | undefined, columnWidth: number): number {
  const value = text ?? "";
  if (!value) return 0;
  const usable = Math.max(1, columnWidth - 1);
  let lines = 0;
  // 显式换行先拆（财务在备注里敲的回车），每一段再按宽度折行。
  for (const paragraph of value.split(/\r?\n/)) {
    if (!paragraph) {
      // 空段落 = 一个空行（用户敲了两个回车就是想要一行空白）。
      lines += 1;
      continue;
    }
    lines += Math.max(1, Math.ceil(displayWidth(paragraph) / usable));
  }
  return lines;
}

/** 一个跨列区间的可用宽度：`from` / `to` 是**从 1 开始**的列号（含两端）。 */
export function columnSpanWidth(widths: readonly number[], from: number, to: number): number {
  let total = 0;
  for (let column = from; column <= to; column += 1) total += widths[column - 1] ?? 0;
  return total;
}

/** 一行里的若干块：同一行左右两栏各写各的，行高取**需要行数最多的那一块**。 */
export type RowHeightBlock = { text: string | null | undefined; width: number };

/**
 * 这一行该有多高：取各块所需行数的最大值 × 单行高度，再夹到 [MIN, MAX]。
 *
 * 为什么是 max 而不是相加：左右两栏是**并排**的两个合并区（材料在 B:F、工艺要求在 G:J），
 * 它们不共用高度，高的那一块决定这一行。
 */
export function rowHeightFor(blocks: readonly RowHeightBlock[]): number {
  const lines = blocks.reduce((most, block) => Math.max(most, wrappedLines(block.text, block.width)), 0);
  if (lines <= 1) return MIN_ROW_HEIGHT;
  return Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, lines * LINE_HEIGHT));
}
