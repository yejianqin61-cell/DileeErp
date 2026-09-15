import { Prisma } from "@prisma/client";

/**
 * 生产工资（车间员工计件/计时）的汇总口径。
 *
 * 事实源是**员工日报本身**，不是 `production_payroll_sources`：后者是生产侧按
 * 「员工 + 生产单 + 日 + 计薪方式」维护的派生表，员工类型从车间改成非车间时会被软删
 * （`employee-daily-reports.service.ts` 的 `syncPayrollSource`），改回车间又不会自动补建。
 * 拿派生表汇总工资台账会真的漏单，所以这里只吃日报行。
 *
 * 「不能漏掉任何一单任何一个工序任何一天」的落实方式：调用方只按
 * 「员工 + 报告日期落在该月 + 未删除」取数，**不做工序/订单/状态预筛**；
 * 本函数把每一行都归到 (日期, 生产单, 工序, 计薪方式) 分组里，分组数与日报条数一起写进台账快照，
 * 供财务逐单逐工序逐日核对。
 */

/** 参与工资汇总的日报字段（与 employee_daily_reports 的列一一对应）。 */
export type PayrollDailyReport = {
  id: string;
  employeeId: string;
  reportDate: Date;
  productionOrderId: string;
  orderNo: string;
  operationId: string;
  operationName: string;
  wageMode: string;
  quantity: Prisma.Decimal;
  durationMinutes: Prisma.Decimal | null;
  amount: Prisma.Decimal;
};

/** 台账快照里的一行：一天 × 一张生产单 × 一道工序 × 一种计薪方式。 */
export type ProductionPayrollLine = {
  report_date: string;
  order_no: string;
  production_order_id: string;
  operation_id: string;
  operation_name: string;
  wage_mode: string;
  report_count: number;
  quantity: string;
  duration_minutes: string;
  duration_hours: string;
  amount: string;
  report_ids: string[];
};

export type ProductionPayrollSummary = {
  employee_id: string;
  amount: Prisma.Decimal;
  quantity: Prisma.Decimal;
  duration_minutes: Prisma.Decimal;
  lines: ProductionPayrollLine[];
  report_count: number;
  day_count: number;
  order_count: number;
  operation_count: number;
};

/** 分钟 -> 小时文案（最多 4 位小数、去尾随零；极小非零值提升精度），与生产侧 toHoursText / 导出 hours() 同口径。 */
export function hoursText(durationMinutes: Prisma.Decimal | null | undefined): string {
  if (durationMinutes === null || durationMinutes === undefined) return "";
  const hours = new Prisma.Decimal(durationMinutes).div(60);
  const trim = (value: string) => value.replace(/0+$/, "").replace(/\.$/, "");
  const text = trim(hours.toFixed(4));
  return text !== "0" || hours.isZero() ? text : trim(hours.toFixed(8));
}

export function emptyProductionPayroll(employeeId: string): ProductionPayrollSummary {
  return { employee_id: employeeId, amount: new Prisma.Decimal(0), quantity: new Prisma.Decimal(0), duration_minutes: new Prisma.Decimal(0), lines: [], report_count: 0, day_count: 0, order_count: 0, operation_count: 0 };
}

/**
 * 把一名员工的日报汇总成工资台账里的生产工资。
 *
 * 分组键含工序与计薪方式：同一员工同日同工序的多条日报会合并成一行（条数累加、金额求和、日报 ID 全留），
 * 所以「同一工序重复登记」不会丢金额，也不会因为合并而看不出原始笔数。
 */
export function aggregateProductionPayroll(reports: PayrollDailyReport[]): ProductionPayrollSummary {
  if (!reports.length) return emptyProductionPayroll("");
  const groups = new Map<string, ProductionPayrollLine & { quantityValue: Prisma.Decimal; durationValue: Prisma.Decimal; amountValue: Prisma.Decimal }>();
  const days = new Set<string>();
  const orders = new Set<string>();
  const operations = new Set<string>();
  for (const report of reports) {
    const day = report.reportDate.toISOString().slice(0, 10);
    const key = `${day}|${report.productionOrderId}|${report.operationId}|${report.wageMode}`;
    const existing = groups.get(key);
    const minutes = report.durationMinutes === null || report.durationMinutes === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(report.durationMinutes);
    if (existing) {
      existing.quantityValue = existing.quantityValue.plus(report.quantity);
      existing.durationValue = existing.durationValue.plus(minutes);
      existing.amountValue = existing.amountValue.plus(report.amount);
      existing.report_count += 1;
      existing.report_ids.push(report.id);
    } else {
      groups.set(key, {
        report_date: day,
        order_no: report.orderNo,
        production_order_id: report.productionOrderId,
        operation_id: report.operationId,
        operation_name: report.operationName,
        wage_mode: report.wageMode,
        report_count: 1,
        quantity: "0",
        duration_minutes: "0",
        duration_hours: "",
        amount: "0",
        report_ids: [report.id],
        quantityValue: new Prisma.Decimal(report.quantity),
        durationValue: minutes,
        amountValue: new Prisma.Decimal(report.amount),
      });
    }
    days.add(day);
    orders.add(report.productionOrderId);
    operations.add(`${report.productionOrderId}|${report.operationId}`);
  }
  const lines = [...groups.values()]
    .map((line) => ({
      report_date: line.report_date,
      order_no: line.order_no,
      production_order_id: line.production_order_id,
      operation_id: line.operation_id,
      operation_name: line.operation_name,
      wage_mode: line.wage_mode,
      report_count: line.report_count,
      quantity: line.quantityValue.toString(),
      duration_minutes: line.durationValue.toString(),
      duration_hours: hoursText(line.durationValue),
      amount: line.amountValue.toString(),
      report_ids: line.report_ids,
    }))
    // 逐日、逐单、逐工序排序：财务核对时按时间顺序读，不依赖数据库返回顺序。
    .sort((left, right) => left.report_date.localeCompare(right.report_date) || left.order_no.localeCompare(right.order_no) || left.operation_name.localeCompare(right.operation_name) || left.wage_mode.localeCompare(right.wage_mode));
  return {
    employee_id: reports[0].employeeId,
    amount: lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0)),
    quantity: lines.reduce((sum, line) => sum.plus(line.quantity), new Prisma.Decimal(0)),
    duration_minutes: lines.reduce((sum, line) => sum.plus(line.duration_minutes), new Prisma.Decimal(0)),
    lines,
    report_count: reports.length,
    day_count: days.size,
    order_count: orders.size,
    operation_count: operations.size,
  };
}

/** 同一员工多行时按员工分组（月度导入一次汇总全部车间员工）。 */
export function groupProductionPayroll(reports: PayrollDailyReport[]): Map<string, ProductionPayrollSummary> {
  const byEmployee = new Map<string, PayrollDailyReport[]>();
  for (const report of reports) {
    const rows = byEmployee.get(report.employeeId);
    if (rows) rows.push(report);
    else byEmployee.set(report.employeeId, [report]);
  }
  return new Map([...byEmployee.entries()].map(([employeeId, rows]) => [employeeId, aggregateProductionPayroll(rows)]));
}
