import { Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import type { CurrentUser } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";

@Injectable()
export class DictionariesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}
  async listTypes() { return this.prisma.dictionaryType.findMany({ where: { deletedAt: null }, orderBy: { key: "asc" } }); }
  async createType(input: { key: string; name: string }, user: CurrentUser) { return this.prisma.dictionaryType.create({ data: { ...input, ...this.audit.create(user) } }); }
  async listItems(typeKey: string, includeInactive = false) {
    const type = await this.requireType(typeKey);
    return this.prisma.dictionaryItem.findMany({ where: { typeId: type.id, deletedAt: null, ...(includeInactive ? {} : { isActive: true }) }, orderBy: [{ sortOrder: "asc" }, { key: "asc" }] });
  }
  async createItem(typeKey: string, input: { key: string; label: string; sort_order?: number }, user: CurrentUser) {
    const type = await this.requireType(typeKey);
    return this.prisma.dictionaryItem.create({ data: { typeId: type.id, key: input.key, label: input.label, sortOrder: input.sort_order ?? 0, ...this.audit.create(user) } });
  }
  async updateItem(id: string, input: { label?: string; sort_order?: number; is_active?: boolean }, user: CurrentUser) {
    await this.requireItem(id);
    return this.prisma.dictionaryItem.update({ where: { id }, data: { ...(input.label === undefined ? {} : { label: input.label }), ...(input.sort_order === undefined ? {} : { sortOrder: input.sort_order }), ...(input.is_active === undefined ? {} : { isActive: input.is_active }), ...this.audit.update(user) } });
  }
  async deleteItem(id: string, user: CurrentUser) {
    await this.requireItem(id);
    return this.prisma.dictionaryItem.update({ where: { id }, data: this.audit.softDelete(user) });
  }
  private async requireType(key: string) { const type = await this.prisma.dictionaryType.findFirst({ where: { key, deletedAt: null } }); if (!type) throw new NotFoundException("字典类型不存在"); return type; }
  private async requireItem(id: string) { const item = await this.prisma.dictionaryItem.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException("字典项不存在"); return item; }
}
