import { Prisma } from "@prisma/client";
import type { CurrentUser } from "../../platform/auth/auth.service";

/**
 * Cross-口径 daily_discrepancy reconciliation shared by both daily-report write paths
 * (employee daily reports and operation daily reports).
 *
 * Extracted from EmployeeDailyReportsService.recomputeDiscrepancy so that operation
 * daily report mutations (T2b) can recover/refresh the same alert in the same
 * transaction, per design §7.3 ("任一日报变更时更新同一条告警，重新相等时自动恢复").
 *
 * Must run inside the same transaction that already serialized writes for
 * `operationId`; the extra FOR UPDATE here is a re-entrant lock for callers that
 * did not lock the operation row yet.
 */
export async function reconcileDailyDiscrepancy(tx: Prisma.TransactionClient, orderId: string, operationId: string, reportDate: Date, user: CurrentUser): Promise<void> {
  // Serialize recalculation for one operation so concurrent employee rows see a complete aggregate.
  await tx.$queryRaw`SELECT id FROM production_order_operations WHERE id = ${operationId}::uuid FOR UPDATE`;
  const [order, operationReports, employeeReports] = await Promise.all([
    tx.productionOrder.findUniqueOrThrow({ where: { id: orderId } }),
    tx.operationDailyReport.aggregate({ where: { productionOrderOperationId: operationId, reportDate, deletedAt: null }, _sum: { completedQuantity: true } }),
    tx.employeeDailyReport.aggregate({ where: { productionOrderOperationId: operationId, reportDate, deletedAt: null }, _sum: { quantity: true } }),
  ]);
  const operationQuantity = new Prisma.Decimal(operationReports._sum.completedQuantity ?? 0);
  const employeeQuantity = new Prisma.Decimal(employeeReports._sum.quantity ?? 0);
  const discrepancy = operationQuantity.minus(employeeQuantity);
  const target = (await tx.productionOrderOperation.findUniqueOrThrow({ where: { id: operationId } })).targetQuantity;
  const allReports = await tx.operationDailyReport.aggregate({ where: { productionOrderOperationId: operationId, deletedAt: null }, _sum: { completedQuantity: true } });
  const cumulative = new Prisma.Decimal(allReports._sum.completedQuantity ?? 0);
  const key = { productionOrderOperationId: operationId, reportDate, alertType: "daily_discrepancy" } as const;
  const existing = await tx.productionDailyAlert.findUnique({ where: { productionOrderOperationId_reportDate_alertType: key } });
  if (!discrepancy.eq(0)) {
    const unchanged = existing && existing.status === "confirmed" && existing.operationReportQuantity?.eq(operationQuantity) && existing.employeeReportQuantity?.eq(employeeQuantity) && existing.discrepancyQuantity?.eq(discrepancy);
    const data = { productionOrderId: orderId, orderNo: order.orderNo, targetQuantity: target, operationReportQuantity: operationQuantity, employeeReportQuantity: employeeQuantity, discrepancyQuantity: discrepancy, cumulativeQuantity: cumulative, updatedBy: user.id, status: unchanged ? "confirmed" : "pending" };
    await tx.productionDailyAlert.upsert({ where: { productionOrderOperationId_reportDate_alertType: key }, update: data, create: { ...key, ...data, createdBy: user.id } });
    await tx.auditEvent.create({ data: { action: existing ? "production_daily_alert.recalculate" : "production_daily_alert.create", entityType: "production_daily_alert", actorId: user.id, entityId: existing?.id, details: { order_no: order.orderNo, alert_type: "daily_discrepancy", operation_quantity: operationQuantity.toString(), employee_quantity: employeeQuantity.toString(), discrepancy_quantity: discrepancy.toString(), status: data.status } } });
  } else if (existing && existing.status !== "recovered") {
    await tx.productionDailyAlert.update({ where: { id: existing.id }, data: { status: "recovered", recoveredAt: new Date(), updatedBy: user.id } });
    await tx.auditEvent.create({ data: { action: "production_daily_alert.recover", entityType: "production_daily_alert", actorId: user.id, entityId: existing.id, details: { order_no: order.orderNo, alert_type: "daily_discrepancy", status: "recovered" } } });
  }
}
