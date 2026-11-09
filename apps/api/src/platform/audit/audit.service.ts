import { Injectable, Logger } from "@nestjs/common";
import type { CurrentUser } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "@prisma/client";

/** `audit_events.entity_id` 是 UUID 列；只接受真正的 UUID 字面量。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  create(user: CurrentUser) { return { createdBy: user.id, updatedBy: user.id }; }
  update(user: CurrentUser) { return { updatedBy: user.id }; }
  softDelete(user: CurrentUser) { return { deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }; }
  activeWhere<T extends object>(where: T = {} as T) { return { ...where, deletedAt: null }; }
  /**
   * 记一条审计事件。
   *
   * `client` 可选：调用方要求「业务写入与审计同生共死」时（例如确认与挂账同事务），
   * 把事务客户端传进来，审计行随事务一起提交/回滚 —— 否则会出现「业务回滚了、审计却留下了
   * 一条什么都没发生的记录」，事后无法据审计还原真实操作。
   */
  async record(action: string, entityType: string, actorId?: string, entityId?: string, details: Record<string, unknown> = {}, client?: Prisma.TransactionClient) {
    const safe = this.normalizeEntityId(action, entityId, details);
    const db = client ?? this.prisma;
    await db.auditEvent.create({ data: { action, entityType, actorId, entityId: safe.entityId, details: safe.details as Prisma.InputJsonValue } });
  }
  async recordWithOrderNo(action: string, entityType: string, orderNo: string, actorId?: string, entityId?: string, details: Record<string, unknown> = {}) {
    const safe = this.normalizeEntityId(action, entityId, details);
    await this.prisma.auditEvent.create({ data: { action, entityType, orderNo, actorId, entityId: safe.entityId, details: safe.details as Prisma.InputJsonValue } });
  }

  /**
   * `entityId` 必须是 UUID —— 调用方却常常顺手把**业务编码**传进来。
   *
   * 实测事故（2026-09-26）：材料批量导入把物料编码（或字面量 `"batch"`）传给了第 4 个参数，
   * Prisma 建 `audit_events` 行时报 `Inconsistent column data: Error creating UUID ... found 'M' at 1`，
   * **整个导入请求 500**（业务数据已在一个事务里写好了，用户看到的却是失败）。
   *
   * 处置原则：审计是**附带**记录，不该因为一个字段格式问题把业务操作打断，但也不能静默吞掉——
   * 非法值改记到 `details.entity_id_raw` 并打一条警告，让调用方的 bug 在日志里可见。
   */
  private normalizeEntityId(action: string, entityId: string | undefined, details: Record<string, unknown>) {
    if (entityId === undefined || entityId === null || entityId === "") return { entityId: undefined, details };
    if (UUID_PATTERN.test(entityId)) return { entityId, details };
    this.logger.warn(`审计 entityId 不是 UUID（action=${action}，值=${entityId}）：已记入 details.entity_id_raw，避免因此中断业务操作`);
    return { entityId: undefined, details: { ...details, entity_id_raw: entityId } };
  }
}
