import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { AuditService } from "../../platform/audit/audit.service";

type Filter = { alert_type?: string; status?: string; order_no?: string; production_order_id?: string; production_order_operation_id?: string; report_date?: string };

@Injectable()
export class ProductionDailyAlertsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  list(filter: Filter) {
    return this.prisma.productionDailyAlert.findMany({ where: { deletedAt: null, ...(filter.alert_type ? { alertType: filter.alert_type } : {}), ...(filter.status ? { status: filter.status } : {}), ...(filter.order_no ? { orderNo: filter.order_no } : {}), ...(filter.production_order_id ? { productionOrderId: filter.production_order_id } : {}), ...(filter.production_order_operation_id ? { productionOrderOperationId: filter.production_order_operation_id } : {}), ...(filter.report_date ? { reportDate: new Date(`${filter.report_date}T00:00:00.000Z`) } : {}) }, include: { productionOrder: true, productionOrderOperation: true }, orderBy: [{ status: "asc" }, { reportDate: "desc" }, { updatedAt: "desc" }] });
  }

  async get(id: string) {
    const row = await this.prisma.productionDailyAlert.findFirst({ where: { id, deletedAt: null }, include: { productionOrder: true, productionOrderOperation: true } });
    if (!row) throw new NotFoundException({ code: "PRODUCTION_DAILY_ALERT_NOT_FOUND", message: "生产日报告警不存在", details: [] });
    return row;
  }

  async confirm(id: string, remark: string, user: CurrentUser) {
    if (!remark?.trim()) throw new UnprocessableEntityException({ code: "ALERT_CONFIRM_REMARK_REQUIRED", message: "确认告警必须填写处理备注", details: [] });
    const current = await this.get(id);
    if (current.status === "recovered") throw new UnprocessableEntityException({ code: "RECOVERED_ALERT_CANNOT_CONFIRM", message: "已恢复告警不能再次确认", details: [] });
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.productionDailyAlert.update({ where: { id }, data: { status: "confirmed", confirmRemark: remark, confirmedBy: user.id, confirmedAt: new Date(), updatedBy: user.id } });
      await tx.auditEvent.create({ data: { action: "production_daily_alert.confirm", entityType: "production_daily_alert", actorId: user.id, entityId: id, details: { order_no: current.orderNo, alert_type: current.alertType, remark, before_status: current.status, after_status: "confirmed" } } });
      return row;
    });
    await this.audit.record("production_daily_alert.confirm", "production_daily_alert", user.id, id, { order_no: current.orderNo, alert_type: current.alertType, remark });
    return updated;
  }

  async auditEvents(id: string) { await this.get(id); return this.prisma.auditEvent.findMany({ where: { entityType: "production_daily_alert", entityId: id }, orderBy: { createdAt: "desc" } }); }

  listMergeAnomalies(status?: string) {
    return this.prisma.dailyReportMergeAnomaly.findMany({ where: status ? { status } : undefined, orderBy: [{ status: "asc" }, { reportDate: "desc" }] });
  }

  async resolveMergeAnomaly(id: string, remark: string, user: CurrentUser) {
    if (!remark?.trim()) throw new UnprocessableEntityException({ code: "ANOMALY_RESOLUTION_REMARK_REQUIRED", message: "处理日报异常必须填写备注", details: [] });
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.dailyReportMergeAnomaly.findUnique({ where: { id } });
      if (!current) throw new NotFoundException({ code: "DAILY_REPORT_MERGE_ANOMALY_NOT_FOUND", message: "日报异常不存在", details: [] });
      if (current.status === "resolved") return current;
      const row = await tx.dailyReportMergeAnomaly.update({ where: { id }, data: { status: "resolved", resolvedAt: new Date() } });
      await tx.auditEvent.create({ data: { action: "daily_report_merge_anomaly.resolve", entityType: "daily_report_merge_anomaly", actorId: user.id, entityId: id, details: { report_kind: current.reportKind, remark: remark.trim() } } });
      return row;
    });
    await this.audit.record("daily_report_merge_anomaly.resolve", "daily_report_merge_anomaly", user.id, id, { remark: remark.trim() });
    return updated;
  }
}
