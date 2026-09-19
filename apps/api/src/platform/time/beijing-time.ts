/**
 * 统一的「操作时间」格式化（固定北京时间）。
 *
 * 为什么必须固定时区、不能再用 `toLocaleString()`：
 *   1. 全库时间列是 `TIMESTAMP(3)`（无时区），Prisma 一律按 UTC 读出；
 *   2. Excel 导出在 **API 容器**里生成、界面在 **浏览器**里渲染，两边宿主时区未必相同
 *      （compose 里容器默认 UTC，开发机可能是 +08，`postgres:16-alpine` 也没设 `TZ`）；
 *      用 `toLocaleString()` 就会出现「界面上 14:30、导出文件里 06:30」这种对不上的情况。
 *   3. 所以口径一次性钉成 `Asia/Shanghai`，所有调用方共用这一个模块。
 *
 * 前端有一份**等价实现** `apps/web/lib/audit-time.ts`：两个 workspace 之间没有共享包
 * （根 `package.json` 的 workspaces 只有 `apps/*`），所以是刻意复制的两份，
 * 两边用**同一组测试向量**，改动必须同步。
 */

export const BEIJING_TIME_ZONE = "Asia/Shanghai";

/**
 * 用 `formatToParts` 自己拼，不用 `format()`：
 * `format()` 的分隔符随 locale/ICU 版本变（`en-CA` 给 `2026-09-16, 00:00`，`zh-CN` 给 `2026/09/16 00:00`），
 * 而导出文件里的时间必须是稳定的定长字符串。
 *
 * `hourCycle: "h23"` 是必需的：只写 `hour12: false` 在部分 ICU 版本下午夜会输出 `24:00`。
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

const DATE_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: BEIJING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

type BeijingParts = { year: string; month: string; day: string; hour: string; minute: string; second: string };

/** Date / ISO 字符串 / 毫秒数 → Date；空值与非法输入 → null（调用方自己决定要不要显示 `-`）。 */
export function toInstant(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function partsOf(date: Date): BeijingParts {
  const values: Record<string, string> = {};
  for (const part of DATE_TIME_PARTS.formatToParts(date)) values[part.type] = part.value;
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
}

/** `2026-09-16 14:30`（到分，默认）；`{ seconds: true }` → `2026-09-16 14:30:05`。空值 → `""`。 */
export function beijingDateTime(value: Date | string | number | null | undefined, options: { seconds?: boolean } = {}): string {
  const date = toInstant(value);
  if (!date) return "";
  const parts = partsOf(date);
  const base = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return options.seconds ? `${base}:${parts.second}` : base;
}

/**
 * 列表里用的紧凑写法：**同年省略年份**（`09-16 14:30`），跨年才带年份（`2025-12-31 09:05`）。
 *
 * `now` 可注入，便于测试跨年分支——不能读「当前时间」再被测试反向依赖。
 */
export function beijingDateTimeShort(value: Date | string | number | null | undefined, options: { now?: Date } = {}): string {
  const date = toInstant(value);
  if (!date) return "";
  const parts = partsOf(date);
  const reference = toInstant(options.now) ?? new Date();
  const sameYear = parts.year === partsOf(reference).year;
  const clock = `${parts.hour}:${parts.minute}`;
  return sameYear ? `${parts.month}-${parts.day} ${clock}` : `${parts.year}-${parts.month}-${parts.day} ${clock}`;
}

/** `2026-09-16`（日期口径，如「下单日期」）。空值 → `""`。 */
export function beijingDate(value: Date | string | number | null | undefined): string {
  const date = toInstant(value);
  if (!date) return "";
  const values: Record<string, string> = {};
  for (const part of DATE_PARTS.formatToParts(date)) values[part.type] = part.value;
  return `${values.year}-${values.month}-${values.day}`;
}
