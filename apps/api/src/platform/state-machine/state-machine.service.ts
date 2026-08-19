import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import type { CurrentUser } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";

@Injectable()
export class StateMachineService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async initialize(machineKey: string, entityType: string, entityId: string, stateKey: string, user: CurrentUser, remark?: string) {
    const state = await this.activeState(machineKey, stateKey);
    return this.prisma.$transaction(async (tx) => {
      const record = await tx.stateRecord.create({ data: { machineKey, entityType, entityId, currentStateId: state.id, ...this.audit.create(user) } });
      await tx.stateChange.create({ data: { recordId: record.id, toStateId: state.id, remark, ...this.audit.create(user) } });
      return record;
    });
  }

  async transition(machineKey: string, entityType: string, entityId: string, targetStateKey: string, user: CurrentUser, remark?: string) {
    const record = await this.prisma.stateRecord.findUnique({ where: { machineKey_entityType_entityId: { machineKey, entityType, entityId } } });
    if (!record) throw new NotFoundException("状态记录不存在");
    const target = await this.activeState(machineKey, targetStateKey);
    const allowed = await this.prisma.stateTransition.findFirst({ where: { machineKey, fromStateId: record.currentStateId, toStateId: target.id } });
    if (!allowed) throw new BadRequestException("不允许的状态转换");
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.stateRecord.update({ where: { id: record.id }, data: { currentStateId: target.id, ...this.audit.update(user) } });
      await tx.stateChange.create({ data: { recordId: record.id, fromStateId: record.currentStateId, toStateId: target.id, remark, ...this.audit.create(user) } });
      return updated;
    });
  }

  private async activeState(machineKey: string, key: string) {
    const state = await this.prisma.stateDefinition.findFirst({ where: { machineKey, key, isActive: true, deletedAt: null } });
    if (!state) throw new NotFoundException("状态不存在或已停用");
    return state;
  }
}
