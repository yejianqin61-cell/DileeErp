import { Injectable } from "@nestjs/common";
import type { CurrentUser } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "@prisma/client";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  create(user: CurrentUser) { return { createdBy: user.id, updatedBy: user.id }; }
  update(user: CurrentUser) { return { updatedBy: user.id }; }
  softDelete(user: CurrentUser) { return { deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }; }
  activeWhere<T extends object>(where: T = {} as T) { return { ...where, deletedAt: null }; }
  async record(action: string, entityType: string, actorId?: string, entityId?: string, details: Record<string, unknown> = {}) {
    await this.prisma.auditEvent.create({ data: { action, entityType, actorId, entityId, details: details as Prisma.InputJsonValue } });
  }
}
