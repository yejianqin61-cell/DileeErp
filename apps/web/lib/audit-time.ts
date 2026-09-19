// 统一的「操作时间」格式化（固定北京时间）—— 前端这一份与后端
// apps/api/src/platform/time/beijing-time.ts **是刻意的两份等价实现**：
// 根 package.json 的 workspaces 只有 apps/*，没有共享包，而导出在 API 容器里生成、
// 界面在浏览器里渲染，两边必须得到同一个字符串。
// 两处用**同一组测试向量**，改动必须同步。
//
// 为什么不能用 `toLocaleString()` / `toLocaleDateString()`：它们按**运行宿主**的时区走。
// 导出跑在容器里（compose 默认 UTC），界面跑在浏览器里（可能是 +08），
// 同一条记录就会出现「界面 14:30、导出 06:30」。

export const BEIJING_TIME_ZONE = "Asia/Shanghai";

/**
 * 用 `formatToParts` 自己拼，不用 `format()`：后者的分隔符随 locale/ICU 版本变
 * （`en-CA` → `2026-09-16, 00:00`，`zh-CN` → `2026/09/16 00:00`），
 * 而列里的时间必须稳定。
 * `hourCycle: "h23"` 必需：只写 `hour12: false` 在部分 ICU 版本下午夜会输出 `24:00`。
 */
const DATE_TIME_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: BEIJING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

const DATE_PARTS = new Intl.DateTimeFormat("en-CA", { timeZone: BEIJING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

export type Instant = Date | string | number | null | undefined;

/** Date / ISO 字符串 / 毫秒数 → Date；空值与非法输入 → null。 */
export function toInstant(value: Instant): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function partsOf(date: Date) {
  const values: Record<string, string> = {};
  for (const part of DATE_TIME_PARTS.formatToParts(date)) values[part.type] = part.value;
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}

/** `2026-09-16 14:30`（到分，默认）；`{ seconds: true }` → `2026-09-16 14:30:05`。空值 → `""`。 */
export function formatBeijing(value: Instant, options: { seconds?: boolean } = {}): string {
  const date = toInstant(value);
  if (!date) return "";
  const parts = partsOf(date);
  const base = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return options.seconds ? `${base}:${parts.second}` : base;
}

/**
 * 列表里用的紧凑写法：**同年省略年份**（`09-16 14:30`），跨年才带年份（`2025-12-31 09:05`）。
 * `now` 可注入，便于测试跨年分支。
 */
export function formatBeijingShort(value: Instant, options: { now?: Instant } = {}): string {
  const date = toInstant(value);
  if (!date) return "";
  const parts = partsOf(date);
  const reference = toInstant(options.now) ?? new Date();
  const sameYear = parts.year === partsOf(reference).year;
  const clock = `${parts.hour}:${parts.minute}`;
  return sameYear ? `${parts.month}-${parts.day} ${clock}` : `${parts.year}-${parts.month}-${parts.day} ${clock}`;
}

/** `2026-09-16`。空值 → `""`。 */
export function formatBeijingDate(value: Instant): string {
  const date = toInstant(value);
  if (!date) return "";
  const values: Record<string, string> = {};
  for (const part of DATE_PARTS.formatToParts(date)) values[part.type] = part.value;
  return `${values.year}-${values.month}-${values.day}`;
}
