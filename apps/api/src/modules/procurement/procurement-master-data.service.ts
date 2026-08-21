import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

type UnitInput = { name: string; remark?: string };
type MaterialInput = { material_code: string; name: string; default_unit_id: string; remark?: string };
type SupplierInput = { supplier_code: string; name: string; contact_name?: string; phone?: string; settlement_info?: Record<string, unknown>; remark?: string };

@Injectable()
export class ProcurementMasterDataService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async listUnits() { return this.prisma.unit.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }); }
  async createUnit(input: UnitInput, user: CurrentUser) { return this.write("unit", () => this.prisma.unit.create({ data: { name: input.name, remark: input.remark, ...this.audit.create(user) } }), user); }
  async updateUnit(id: string, input: Partial<UnitInput>, user: CurrentUser) { await this.requireUnit(id); return this.write("unit", () => this.prisma.unit.update({ where: { id }, data: { ...(input.name === undefined ? {} : { name: input.name }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } }), user, id); }
  async setUnitActive(id: string, isActive: boolean, user: CurrentUser) { await this.requireUnit(id); return this.prisma.unit.update({ where: { id }, data: { isActive, ...this.audit.update(user) } }); }
  async deleteUnit(id: string, user: CurrentUser) { await this.requireUnit(id); return this.ensureUnusedAndDelete("unit", id, user); }

  async listMaterials() { return this.prisma.material.findMany({ where: { deletedAt: null }, include: { defaultUnit: true }, orderBy: { materialCode: "asc" } }); }
  async createMaterial(input: MaterialInput, user: CurrentUser) { await this.requireActiveUnit(input.default_unit_id); return this.write("material", () => this.prisma.material.create({ data: { materialCode: input.material_code, name: input.name, defaultUnitId: input.default_unit_id, remark: input.remark, ...this.audit.create(user) } }), user); }
  async updateMaterial(id: string, input: Partial<MaterialInput>, user: CurrentUser) { await this.requireMaterial(id); if (input.default_unit_id) await this.requireActiveUnit(input.default_unit_id); return this.write("material", () => this.prisma.material.update({ where: { id }, data: { ...(input.material_code === undefined ? {} : { materialCode: input.material_code }), ...(input.name === undefined ? {} : { name: input.name }), ...(input.default_unit_id === undefined ? {} : { defaultUnitId: input.default_unit_id }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } }), user, id); }
  async setMaterialActive(id: string, isActive: boolean, user: CurrentUser) { await this.requireMaterial(id); return this.prisma.material.update({ where: { id }, data: { isActive, ...this.audit.update(user) } }); }
  async deleteMaterial(id: string, user: CurrentUser) { await this.requireMaterial(id); return this.ensureUnusedAndDelete("material", id, user); }

  async listSuppliers() { return this.prisma.supplier.findMany({ where: { deletedAt: null }, orderBy: { supplierCode: "asc" } }); }
  async createSupplier(input: SupplierInput, user: CurrentUser) { return this.write("supplier", () => this.prisma.supplier.create({ data: { supplierCode: input.supplier_code, name: input.name, contactName: input.contact_name, phone: input.phone, settlementInfo: (input.settlement_info ?? {}) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } }), user); }
  async updateSupplier(id: string, input: Partial<SupplierInput>, user: CurrentUser) { await this.requireSupplier(id); return this.write("supplier", () => this.prisma.supplier.update({ where: { id }, data: { ...(input.supplier_code === undefined ? {} : { supplierCode: input.supplier_code }), ...(input.name === undefined ? {} : { name: input.name }), ...(input.contact_name === undefined ? {} : { contactName: input.contact_name }), ...(input.phone === undefined ? {} : { phone: input.phone }), ...(input.settlement_info === undefined ? {} : { settlementInfo: input.settlement_info as Prisma.InputJsonValue }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } }), user, id); }
  async setSupplierActive(id: string, isActive: boolean, user: CurrentUser) { await this.requireSupplier(id); return this.prisma.supplier.update({ where: { id }, data: { isActive, ...this.audit.update(user) } }); }
  async deleteSupplier(id: string, user: CurrentUser) { await this.requireSupplier(id); return this.ensureUnusedAndDelete("supplier", id, user); }

  private async ensureUnusedAndDelete(kind: "unit" | "material" | "supplier", id: string, user: CurrentUser) {
    const referenced = kind === "unit" ? await this.prisma.material.count({ where: { defaultUnitId: id, deletedAt: null } }) + await this.prisma.bomItem.count({ where: { unitId: id, deletedAt: null } }) : kind === "material" ? await this.prisma.bomItem.count({ where: { materialId: id, deletedAt: null } }) : 0;
    if (referenced) throw new UnprocessableEntityException({ code: "MASTER_DATA_IN_USE", message: "基础资料已被业务引用，只能停用", details: [] });
    const data = this.audit.softDelete(user);
    const result = kind === "unit" ? await this.prisma.unit.update({ where: { id }, data }) : kind === "material" ? await this.prisma.material.update({ where: { id }, data }) : await this.prisma.supplier.update({ where: { id }, data });
    await this.audit.record(`${kind}.delete`, kind, user.id, id);
    return result;
  }
  private async write(kind: string, action: () => Promise<any>, user: CurrentUser, id?: string) { try { const result = await action(); await this.audit.record(`${kind}.${id ? "update" : "create"}`, kind, user.id, id ?? result.id); return result; } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "MASTER_DATA_CONFLICT", message: "名称或编码已存在", details: [] }); throw error; } }
  private async requireUnit(id: string) { const item = await this.prisma.unit.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "单位不存在", details: [] }); return item; }
  private async requireActiveUnit(id: string) { const item = await this.prisma.unit.findFirst({ where: { id, deletedAt: null, isActive: true } }); if (!item) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "单位不存在或已停用", details: [] }); return item; }
  private async requireMaterial(id: string) { const item = await this.prisma.material.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "MATERIAL_NOT_FOUND", message: "物料不存在", details: [] }); return item; }
  private async requireSupplier(id: string) { const item = await this.prisma.supplier.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "SUPPLIER_NOT_FOUND", message: "供应商不存在", details: [] }); return item; }
}
