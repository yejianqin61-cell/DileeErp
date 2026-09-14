import { UnprocessableEntityException } from "@nestjs/common";

/**
 * 期间 → Prisma 日期范围（财务报表与收支流水列表共用，避免两处口径漂移）。
 *
 * `to` 取当天 23:59:59.999Z：库里的日期是以 `YYYY-MM-DD` 存的（当天零点），
 * 若直接用 `new Date(to)`（当天零点）会让「截止当天」的记录全部落空。
 */
export function financeDayRange(from?: string, to?: string): { gte?: Date; lte?: Date } | null {
  const range: { gte?: Date; lte?: Date } = {};
  if (from) range.gte = financeDay(from, "from", "00:00:00.000");
  if (to) range.lte = financeDay(to, "to", "23:59:59.999");
  return Object.keys(range).length ? range : null;
}

function financeDay(value: string, field: string, time: string): Date {
  const date = new Date(`${value.slice(0, 10)}T${time}Z`);
  if (Number.isNaN(date.valueOf())) {
    throw new UnprocessableEntityException({
      code: "INVALID_REPORT_PERIOD",
      message: `期间参数 ${field}「${value}」不是有效日期`,
      details: [],
    });
  }
  return date;
}
