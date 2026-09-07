import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

type Tx = Prisma.TransactionClient;
type UnitInput = { name: string; remark?: string | null };
type MaterialInput = { material_code?: string; name: string; default_unit_id: string; material_type?: string; remark?: string | null };
type SupplierInput = { supplier_code: string; name: string; contact_name?: string | null; phone?: string | null; settlement_info?: Record<string, unknown>; remark?: string | null };

@Injectable()
export class ProcurementMasterDataService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async listUnits() { return this.prisma.unit.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }); }
  async createUnit(input: UnitInput, user: CurrentUser) { return this.write("unit", () => this.prisma.unit.create({ data: { name: input.name, remark: input.remark, ...this.audit.create(user) } }), user); }
  async updateUnit(id: string, input: Partial<UnitInput>, user: CurrentUser) { await this.requireUnit(id); return this.write("unit", () => this.prisma.unit.update({ where: { id }, data: { ...(input.name === undefined || input.name === null ? {} : { name: input.name }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } }), user, id); }
  async setUnitActive(id: string, isActive: boolean, user: CurrentUser) { await this.requireUnit(id); return this.prisma.unit.update({ where: { id }, data: { isActive, ...this.audit.update(user) } }); }
  async deleteUnit(id: string, user: CurrentUser) { await this.requireUnit(id); return this.ensureUnusedAndDelete("unit", id, user); }

  // D8: restore a soft-deleted unit. The row keeps its original deletedBy trace;
  // only deletedAt is cleared and isActive is set back to true. The unique-name
  // tombstone may block restoration when a same-named live unit exists — that is
  // reported as a friendly 409 (schema-level tombstone rework is a tracked TODO).
  async restoreUnit(id: string, user: CurrentUser) {
    const item = await this.prisma.unit.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!item) throw new NotFoundException({ code: "UNIT_NOT_DELETED", message: "单位不存在或未删除", details: [] });
    try {
      const restored = await this.prisma.unit.update({ where: { id }, data: { deletedAt: null, isActive: true, updatedBy: user.id } });
      await this.audit.record("unit.restore", "unit", user.id, id, { name: item.name, deleted_by: item.deletedBy, deleted_at: item.deletedAt, restored_by: user.id });
      return restored;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "UNIT_NAME_CONFLICT", message: "恢复失败：该单位名称已被其它单位占用，请先改名或处理同名记录后再恢复", details: [] });
      throw error;
    }
  }

  async listMaterials() { return this.prisma.material.findMany({ where: { deletedAt: null, materialType: "raw_material" }, include: { defaultUnit: true }, orderBy: { materialCode: "asc" } }); }
  async createMaterial(input: MaterialInput & { code_mode?: string }, user: CurrentUser) { await this.requireActiveUnit(input.default_unit_id); const materialType = input.material_type ?? "raw_material"; if (!["raw_material", "finished_product"].includes(materialType)) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_TYPE", message: "物料类型不合法", details: [] }); const code = input.code_mode === "auto" ? await this.nextMaterialCode() : input.material_code?.trim(); if (!code) throw new UnprocessableEntityException({ code: "MATERIAL_CODE_REQUIRED", message: "手动编码模式必须填写物料编码", details: [] }); return this.write("material", () => this.prisma.material.create({ data: { materialCode: code, name: input.name, defaultUnitId: input.default_unit_id, materialType, remark: input.remark, ...this.audit.create(user) } }), user); }
  async updateMaterial(id: string, input: Partial<MaterialInput>, user: CurrentUser) { await this.requireMaterial(id); if (input.default_unit_id) await this.requireActiveUnit(input.default_unit_id); if (input.material_type && !["raw_material", "finished_product"].includes(input.material_type)) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_TYPE", message: "物料类型不合法", details: [] }); return this.write("material", () => this.prisma.material.update({ where: { id }, data: { ...(input.material_code === undefined || input.material_code === null ? {} : { materialCode: input.material_code }), ...(input.name === undefined || input.name === null ? {} : { name: input.name }), ...(input.default_unit_id === undefined || input.default_unit_id === null ? {} : { defaultUnitId: input.default_unit_id }), ...(input.material_type === undefined || input.material_type === null ? {} : { materialType: input.material_type }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } }), user, id); }
  async setMaterialActive(id: string, isActive: boolean, user: CurrentUser) { await this.requireMaterial(id); return this.prisma.material.update({ where: { id }, data: { isActive, ...this.audit.update(user) } }); }
  async deleteMaterial(id: string, user: CurrentUser) { await this.requireMaterial(id); return this.ensureUnusedAndDelete("material", id, user); }

  async listSuppliers() { return this.prisma.supplier.findMany({ where: { deletedAt: null }, orderBy: { supplierCode: "asc" } }); }
  async createSupplier(input: SupplierInput, user: CurrentUser) { return this.write("supplier", () => this.prisma.supplier.create({ data: { supplierCode: input.supplier_code, name: input.name, contactName: input.contact_name, phone: input.phone, settlementInfo: (input.settlement_info ?? {}) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } }), user); }
  async updateSupplier(id: string, input: Partial<SupplierInput>, user: CurrentUser) { await this.requireSupplier(id); return this.write("supplier", () => this.prisma.supplier.update({ where: { id }, data: { ...(input.supplier_code === undefined || input.supplier_code === null ? {} : { supplierCode: input.supplier_code }), ...(input.name === undefined || input.name === null ? {} : { name: input.name }), ...(input.contact_name === undefined ? {} : { contactName: input.contact_name }), ...(input.phone === undefined ? {} : { phone: input.phone }), ...(input.settlement_info === undefined ? {} : { settlementInfo: input.settlement_info as Prisma.InputJsonValue }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } }), user, id); }
  async setSupplierActive(id: string, isActive: boolean, user: CurrentUser) { await this.requireSupplier(id); return this.prisma.supplier.update({ where: { id }, data: { isActive, ...this.audit.update(user) } }); }
  async deleteSupplier(id: string, user: CurrentUser) { await this.requireSupplier(id); return this.ensureUnusedAndDelete("supplier", id, user); }

  // D7 + D8 + D9: the reference check and the soft delete run inside one
  // transaction with the target row locked FOR UPDATE, so a reference inserted
  // concurrently can no longer slip between the count and the delete. The soft
  // delete flips isActive to false; the delete itself is audited with a snapshot.
  private async ensureUnusedAndDelete(kind: "unit" | "material" | "supplier", id: string, user: CurrentUser) {
    const { row, deleted } = await this.prisma.$transaction(async (tx) => {
      const table = kind === "unit" ? "units" : kind === "material" ? "materials" : "suppliers";
      await tx.$queryRawUnsafe(`SELECT id FROM ${table} WHERE id = $1::uuid FOR UPDATE`, id);
      const row = kind === "unit" ? await tx.unit.findFirst({ where: { id, deletedAt: null } }) : kind === "material" ? await tx.material.findFirst({ where: { id, deletedAt: null } }) : await tx.supplier.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: kind === "unit" ? "UNIT_NOT_FOUND" : kind === "material" ? "MATERIAL_NOT_FOUND" : "SUPPLIER_NOT_FOUND", message: kind === "unit" ? "单位不存在" : kind === "material" ? "物料不存在" : "供应商不存在", details: [] });
      const references = kind === "unit"
        ? await Promise.all([
            tx.material.count({ where: { defaultUnitId: id, deletedAt: null } }),
            tx.bomItem.count({ where: { unitId: id, deletedAt: null } }),
            tx.operationCatalog.count({ where: { defaultUnitId: id, deletedAt: null } }),
            tx.productionOrderOperation.count({ where: { unitId: id, deletedAt: null } }),
          ])
        : kind === "material"
          ? [await tx.bomItem.count({ where: { materialId: id, deletedAt: null } })]
          : [0];
      if (references.reduce((sum, count) => sum + count, 0)) throw new ConflictException({ code: "MASTER_DATA_IN_USE", message: "基础资料已被业务引用，只能停用", details: [] });
      const softDelete = { ...this.audit.softDelete(user), isActive: false };
      const deleted = kind === "unit"
        ? await tx.unit.update({ where: { id }, data: softDelete })
        : kind === "material"
          ? await tx.material.update({ where: { id }, data: softDelete })
          : await tx.supplier.update({ where: { id }, data: softDelete });
      return { row, deleted };
    });
    // row is the union of the three master rows; each branch only reads fields
    // that exist on the narrowed runtime type, so cast through unknown at access.
    const snapshot = kind === "unit" ? { name: row.name } : kind === "material" ? { name: row.name, material_code: (row as unknown as { materialCode: string }).materialCode } : { name: row.name, supplier_code: (row as unknown as { supplierCode: string }).supplierCode };
    await this.audit.record(`${kind}.delete`, kind, user.id, id, snapshot);
    return deleted;
  }
  private async write(kind: string, action: () => Promise<any>, user: CurrentUser, id?: string) { try { const result = await action(); await this.audit.record(`${kind}.${id ? "update" : "create"}`, kind, user.id, id ?? result.id); return result; } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "MASTER_DATA_CONFLICT", message: "名称或编码已存在", details: [] }); throw error; } }
  private async requireUnit(id: string) { const item = await this.prisma.unit.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "单位不存在", details: [] }); return item; }
  private async requireActiveUnit(id: string) { const item = await this.prisma.unit.findFirst({ where: { id, deletedAt: null, isActive: true } }); if (!item) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "单位不存在或已停用", details: [] }); return item; }
  private async requireMaterial(id: string) { const item = await this.prisma.material.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "MATERIAL_NOT_FOUND", message: "物料不存在", details: [] }); return item; }
  private async requireSupplier(id: string) { const item = await this.prisma.supplier.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "SUPPLIER_NOT_FOUND", message: "供应商不存在", details: [] }); return item; }
  private async nextMaterialCode() { const prefix = `MAT-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-`; const latest = await this.prisma.material.findFirst({ where: { materialCode: { startsWith: prefix } }, orderBy: { materialCode: "desc" }, select: { materialCode: true } }); const sequence = latest ? Number(latest.materialCode.slice(prefix.length)) + 1 : 1; return `${prefix}${String(sequence).padStart(4, "0")}`; }
}
