// 工序员工日报查看的纯逻辑契约。
// 从 daily-reports-panel 抽出，便于用 node:test 直接验证（无 React、无副作用、不读系统时间）。
// 约束：只使用可擦除 TS 语法（类型注解 + 函数），Node 的 type stripping 可直接加载本文件。

export type DailyReportRowLike = {
  employeeId: string;
  reportDate: string;
  calculatedAmount: string;
  productionOrderOperation: { id: string };
};

/**
 * 工序员工日报查看条目筛选。
 *
 * 契约：
 * - viewDate 为空字符串表示“不按日期过滤”：展示该工序所有日期、所有员工的日报条目；
 * - viewDate 非空时：仅展示该工序该日期（按 reportDate 前 10 位归一为 YYYY-MM-DD）的条目；
 * - 两种情况下都始终限定在当前工序（productionOrderOperation.id）内。
 */
export function selectVisibleReports<T extends DailyReportRowLike>(reports: readonly T[], operationId: string | null | undefined, viewDate: string): T[] {
  return reports.filter((report) => report.productionOrderOperation.id === operationId && (!viewDate || report.reportDate.slice(0, 10) === viewDate));
}

/** “当日该员工总薪资”的聚合键：员工 + 日期（YYYY-MM-DD）。 */
export function employeeDateTotalKey(employeeId: string, reportDate: string): string {
  return `${employeeId}|${reportDate.slice(0, 10)}`;
}

/**
 * 按“员工 + 日期”聚合金额，跨工序合计（与历史口径一致：不限定当前工序）。
 * - 选中查看日期时：可见行的自身日期即查看日期，按行取键得到的值等于历史上“该日期该员工全部合计”；
 * - 未选查看日期（展示所有日期）时：每行取该行自身日期的员工合计。
 */
export function computeEmployeeDateTotals(reports: readonly DailyReportRowLike[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const report of reports) {
    const key = employeeDateTotalKey(report.employeeId, report.reportDate);
    totals.set(key, (totals.get(key) ?? 0) + Number(report.calculatedAmount));
  }
  return totals;
}

/** 新增草稿行的日期：选择了查看日期用查看日期，否则回落到当天。 */
export function resolveEntryDate(viewDate: string, fallbackToday: string): string {
  return viewDate || fallbackToday;
}

/**
 * 批量保存接口的 report_date：后端以 body 的 report_date 覆盖行日期，
 * 因此必须与草稿行展示的日期一致——优先查看日期，其次草稿行日期，最后当天。
 */
export function resolveBatchReportDate(viewDate: string, draftReportDates: readonly string[], fallbackToday: string): string {
  if (viewDate) return viewDate;
  return draftReportDates.find((date) => Boolean(date)) ?? fallbackToday;
}

/** 摘要条“查看日期”的展示文案：未选日期时显示“全部日期”。 */
export function viewDateLabel(viewDate: string): string {
  return viewDate || "全部日期";
}

/**
 * 计时单位口径：接口与数据库以“分钟”存储（durationMinutes），界面一律按“小时”录入与展示。
 * 分钟 -> 小时（保留 4 位小数，避免 0.5 小时这类输入在往返中失真）。
 */
export function minutesToHours(minutes: string | number | null | undefined): number {
  const value = Number(minutes ?? 0);
  return Number.isFinite(value) ? Number((value / 60).toFixed(4)) : 0;
}

/** 小时 -> 分钟（保留 4 位小数，与数据库 Decimal(18,4) 口径一致）；用于行内编辑时的本地金额预览。 */
export function hoursToMinutes(hours: string | number | null | undefined): number {
  const value = Number(hours ?? 0);
  return Number.isFinite(value) ? Number((value * 60).toFixed(4)) : 0;
}

/** 时长的展示文案：整数不带小数（2），小数去掉尾随零（1.5、1.25）；空值显示为空串。 */
export function hoursText(minutes: string | number | null | undefined): string {
  if (minutes === null || minutes === undefined || minutes === "") return "";
  return String(minutesToHours(minutes));
}
