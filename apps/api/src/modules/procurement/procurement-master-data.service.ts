import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { dailyCodePrefix, nextSequenceCode } from "../../platform/database/daily-sequence-code";
import { isUniqueConstraintViolation, isUniqueConstraintViolationOn } from "../../platform/database/prisma-error";
import { PrismaService } from "../../platform/database/prisma.service";
import {
  MATERIAL_IMPORT_MAX_ROWS,
  materialCodeKey,
  materialComboKey,
  materialTemplateWorkbook,
  materialUnitKey,
  parseMaterialRows,
  type MaterialImportError,
  type MaterialImportRow,
} from "./material-import";

type Tx = Prisma.TransactionClient;
type UnitInput = { name: string; remark?: string | null };
type MaterialInput = { material_code?: string; name: string; specification_model?: string | null; color?: string | null; default_unit_id: string; material_type?: string; remark?: string | null };
type SupplierInput = { supplier_code?: string; name: string; contact_name?: string | null; phone?: string | null; address?: string | null; settlement_info?: Record<string, unknown>; remark?: string | null };

/** Multer 的文件对象只用得到这两个字段（与盘点导入同一形状）。 */
type UploadedWorkbook = { buffer?: Buffer; originalname?: string };

/** 逐行导入的结果：形状与「库存盘点导入」「其他应付导入」一致，前端复用同一套结果面板。 */
export type MaterialImportResult = {
  status: "ok" | "partial" | "failed";
  total: number;
  imported: number;
  errorCount: number;
  headerRow: number;
  errors: MaterialImportError[];
  missingColumns: string[];
  ignoredColumns: string[];
  ignoredTrailingRows: number;
  hints: string[];
  /** 真正建档的物料（含自动生成的编码）—— 自动编码看不见的话，操作员不知道后续该引用哪个编码。 */
  created: Array<{ row: number; material_code: string; name: string; auto_code: boolean }>;
};

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
  async createMaterial(input: MaterialInput & { code_mode?: string }, user: CurrentUser) { await this.requireActiveUnit(input.default_unit_id); const materialType = input.material_type ?? "raw_material"; if (!["raw_material", "finished_product"].includes(materialType)) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_TYPE", message: "物料类型不合法", details: [] }); const code = input.code_mode === "auto" ? await this.nextMaterialCode() : input.material_code?.trim(); if (!code) throw new UnprocessableEntityException({ code: "MATERIAL_CODE_REQUIRED", message: "手动编码模式必须填写物料编码", details: [] }); return this.write("material", () => this.prisma.material.create({ data: { materialCode: code, name: input.name.trim(), specificationModel: this.materialKey(input.specification_model), color: this.materialKey(input.color), defaultUnitId: input.default_unit_id, materialType, remark: input.remark, ...this.audit.create(user) } }), user); }
  async updateMaterial(id: string, input: Partial<MaterialInput>, user: CurrentUser) { await this.requireMaterial(id); if (input.default_unit_id) await this.requireActiveUnit(input.default_unit_id); if (input.material_type && !["raw_material", "finished_product"].includes(input.material_type)) throw new UnprocessableEntityException({ code: "INVALID_MATERIAL_TYPE", message: "物料类型不合法", details: [] }); return this.write("material", () => this.prisma.material.update({ where: { id }, data: { ...(input.material_code === undefined || input.material_code === null ? {} : { materialCode: input.material_code }), ...(input.name === undefined || input.name === null ? {} : { name: input.name.trim() }), ...(input.specification_model === undefined ? {} : { specificationModel: this.materialKey(input.specification_model) }), ...(input.color === undefined ? {} : { color: this.materialKey(input.color) }), ...(input.default_unit_id === undefined || input.default_unit_id === null ? {} : { defaultUnitId: input.default_unit_id }), ...(input.material_type === undefined || input.material_type === null ? {} : { materialType: input.material_type }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } }), user, id); }
  async setMaterialActive(id: string, isActive: boolean, user: CurrentUser) { await this.requireMaterial(id); return this.prisma.material.update({ where: { id }, data: { isActive, ...this.audit.update(user) } }); }
  async deleteMaterial(id: string, user: CurrentUser) { await this.requireMaterial(id); return this.ensureUnusedAndDelete("material", id, user); }

  // ------------------------------------------------------------------
  // 物料清单批量导入（用户 2026-09-20）
  // ------------------------------------------------------------------

  materialTemplate() { return materialTemplateWorkbook(); }

  /**
   * 批量导入物料。
   *
   * 四段式，与「库存盘点导入」「其他应付导入」同一套纪律：
   *   1. **解析**（纯函数 `parseMaterialRows`）：表头按名字认列、逐行校验长度/枚举/文件内重复；
   *      找不到表头 / 缺必需列 / 没有数据行 → 一行都不写，只回一条整体错误；
   *   2. **匹配单位**：按**单位名称**（忽略大小写与空格）在单位池里找。找不到 / 已停用就逐行报错，
   *      **不自动新建单位** —— 单位是主数据，靠一份物料表顺手建出来只会让「米 / m / M」各占一条。
   *      与盘点导入「找不到物料不自动建档」是同一条纪律（那里是模板里没有单位，建不出来）。
   *   3. **查重**：物料编码（区分大小写之外的归一）与「名称+规格型号+颜色」组合各查一次。
   *      ⚠️ 带 `deletedAt != null` 的记录一起查：数据库的唯一索引**不看删除标记**，
   *      软删的物料照样占着编码与组合，漏查就会以 P2002 整批失败、而且说不清是哪一行。
   *   4. **写库**：通过校验的行在**一个事务**里批量建档，要么全进要么全不进；自动编码在批内连续分配，
   *      并与库里已有的编码核对（`nextSequenceCode` 沿用平台规则，不重写「只认纯数字后缀」那套边界）。
   *
   * 只**新增**不修改：撞上已有记录的行走行级错误（提示改用「编辑」），避免一次误传把主数据改烂。
   */
  async importMaterials(file: UploadedWorkbook | undefined, user: CurrentUser): Promise<MaterialImportResult> {
    if (!file?.buffer?.length) throw this.invalid("MATERIAL_IMPORT_FILE_REQUIRED", "请上传Excel文件（仅支持 .xlsx/.xls）");
    // 控制器层的 Multer 白名单已经挡过一道；这里再按扩展名挡一次 —— 「上传了一个 CSV/PDF」
    // 应当回一句「只支持 .xlsx/.xls」，而不是让解析器把它读成空表再报「找不到表头」。
    if (file.originalname && !/\.(xlsx|xls)$/i.test(file.originalname)) throw this.invalid("MATERIAL_IMPORT_INVALID_FILE", "只支持 .xlsx / .xls 文件，请使用「下载模板」得到的模板填写");

    const parsed = parseMaterialRows(this.readImportSheet(file));
    // `created` 必须显式标注类型：`as const` 会把空数组推成 readonly []，赋不回可变数组。
    const empty = { imported: 0, created: [] as MaterialImportResult["created"] } as const;
    if (parsed.status === "failed" && !parsed.rows.length) {
      return { ...empty, status: "failed", total: parsed.total, errorCount: parsed.errors.length, headerRow: parsed.headerRow, errors: parsed.errors, missingColumns: parsed.missingColumns, ignoredColumns: parsed.ignoredColumns, ignoredTrailingRows: parsed.ignoredTrailingRows, hints: parsed.hints };
    }

    // 单位池与物料池一次性读完：一个厂的规模是几百到几千条，比逐行查库更省也更一致。
    const [units, materials] = await Promise.all([
      this.prisma.unit.findMany({ where: { deletedAt: null }, select: { id: true, name: true, isActive: true }, orderBy: { name: "asc" } }),
      this.prisma.material.findMany({ select: { materialCode: true, name: true, specificationModel: true, color: true, deletedAt: true } }),
    ]);
    const byUnitName = new Map(units.map((unit) => [materialUnitKey(unit.name), unit]));
    // 唯一索引不看 deletedAt，所以查重也必须带上已删除的记录（见方法注释第 3 点）。
    const byCode = new Map(materials.map((row) => [materialCodeKey(row.materialCode), row]));
    const byCombo = new Map(materials.map((row) => [materialComboKey(row.name, row.specificationModel ?? "", row.color ?? ""), row]));

    const errors: MaterialImportError[] = [...parsed.errors];
    const accepted: Array<{ row: MaterialImportRow; unitId: string }> = [];

    for (const row of parsed.rows) {
      const unit = byUnitName.get(materialUnitKey(row.unitName));
      if (!unit) {
        errors.push({ row: row.row, field: "默认单位", reason: `默认单位「${row.unitName}」在单位表里找不到：请先在【采购 → 物料清单 → 新建物料】的「默认单位」旁点「新增类目」建出这个单位，或把这一格改成已有的单位` });
        continue;
      }
      if (unit.isActive === false) {
        errors.push({ row: row.row, field: "默认单位", reason: `默认单位「${unit.name}」已停用：请先启用它，或换一个在用的单位` });
        continue;
      }
      if (row.materialCode) {
        const existing = byCode.get(materialCodeKey(row.materialCode));
        if (existing) {
          errors.push({ row: row.row, field: "物料编码", reason: existing.deletedAt
            ? `物料编码 ${row.materialCode} 被一个已删除的物料「${existing.name}」占用着（数据库的唯一索引不看删除标记）：请换一个编码，或把这一格留空让系统自动生成`
            : `物料编码 ${row.materialCode} 已存在（物料「${existing.name}」）：本导入只新增不修改，请改用「编辑」改那条记录，或把这一格留空让系统自动生成` });
          continue;
        }
      }
      const combo = materialComboKey(row.name, row.specificationModel, row.color);
      const sameCombo = byCombo.get(combo);
      if (sameCombo) {
        const described = `${row.name} + ${row.specificationModel || "（无规格型号）"} + ${row.color || "（无颜色）"}`;
        errors.push({ row: row.row, field: "物料名称", reason: sameCombo.deletedAt
          ? `「${described}」被一个已删除的物料「${sameCombo.materialCode}」占用着：请先恢复那条物料，或改一下规格型号/颜色`
          : `「${described}」已存在（物料编码 ${sameCombo.materialCode}）：同名同规格同颜色只能有一条，请改规格型号或颜色` });
        continue;
      }
      accepted.push({ row, unitId: unit.id });
    }

    const hints = [...parsed.hints];
    // 「单位找不到」是最容易一错错一片的原因（一个单位名写错，那一列的行全废），
    // 所以只要出现过这类错误就把单位池列出来 —— 不管这次是整批失败还是部分成功。
    if (errors.some((error) => error.field === "默认单位")) {
      hints.push(`单位表里现有的单位：${units.length ? units.map((unit) => `${unit.name}${unit.isActive === false ? "（已停用）" : ""}`).join("、") : "（一个都没有，请先新建单位）"}`);
    }
    if (!accepted.length) {
      hints.push(`本文件 ${parsed.rows.length} 行都没能建档，没有新增任何物料`);
      return { ...empty, status: "failed", total: parsed.total, errorCount: errors.length, headerRow: parsed.headerRow, errors, missingColumns: [], ignoredColumns: parsed.ignoredColumns, ignoredTrailingRows: parsed.ignoredTrailingRows, hints };
    }

    // 自动编码：先用平台规则算出「下一个」，再在批内继续递增，并与库里已有的编码核对。
    const prefix = dailyCodePrefix("MAT");
    let sequence = Number(nextSequenceCode(prefix, materials.map((row) => row.materialCode)).slice(prefix.length));
    const taken = new Set(byCode.keys());
    const nextCode = () => {
      let code = `${prefix}${String(sequence).padStart(4, "0")}`;
      while (taken.has(materialCodeKey(code))) { sequence += 1; code = `${prefix}${String(sequence).padStart(4, "0")}`; }
      taken.add(materialCodeKey(code));
      sequence += 1;
      return code;
    };

    const auditFields = this.audit.create(user);
    const planned = accepted.map(({ row, unitId }) => {
      const autoCode = !row.materialCode;
      // 注意：`nextCode()` 有副作用（占用一个序号），整行只能调用**一次** —— 调两次会让序号跳号。
      const materialCode = autoCode ? nextCode() : row.materialCode;
      return {
        row: row.row,
        autoCode,
        materialCode,
        data: {
          materialCode,
          name: row.name.trim(),
          // 与单条新建同一个口径：规格/颜色去空格、空值落成空串（NULL 会让组合唯一索引失效）。
          specificationModel: this.materialKey(row.specificationModel),
          color: this.materialKey(row.color),
          defaultUnitId: unitId,
          materialType: row.materialType,
          remark: row.remark || null,
          ...auditFields,
        },
      };
    });

    try {
      await this.prisma.$transaction((tx) => tx.material.createMany({ data: planned.map((item) => item.data) }));
    } catch (error) {
      // 走到这里说明「查重」与「写入」之间有人在并发建档（或自动编码撞号）。
      // 事务已整体回滚，所以没有任何半成品；提示重传即可，不要让它变成一句 P2002。
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException({ code: "MATERIAL_IMPORT_CONFLICT", message: "导入时有并发的重复写入（物料编码或「名称+规格型号+颜色」组合已被占用），本次导入已全部回滚，请重新上传", details: [] });
      }
      throw error;
    }

    if (errors.length) hints.push(`${errors.length} 行未导入（见下方逐行原因），其余 ${planned.length} 行已新增`);
    hints.push("本导入只新增物料，不修改已有物料");

    await this.audit.record("material.import", "material", user.id, planned[0]?.data.materialCode ?? "batch", {
      imported: planned.length,
      total: parsed.total,
      error_count: errors.length,
      auto_code_count: planned.filter((item) => item.autoCode).length,
      source_file_name: file.originalname ?? null,
    });

    return {
      status: errors.length ? "partial" : "ok",
      total: parsed.total,
      imported: planned.length,
      errorCount: errors.length,
      headerRow: parsed.headerRow,
      errors,
      missingColumns: [],
      ignoredColumns: parsed.ignoredColumns,
      ignoredTrailingRows: parsed.ignoredTrailingRows,
      hints,
      created: planned.map((item) => ({ row: item.row, material_code: item.materialCode, name: item.data.name, auto_code: item.autoCode })),
    };
  }

  /**
   * 读工作簿第一张表：固定 `cellDates: false`（与其它导入一致），并挡住超大文件。
   * 物料表里没有日期列，但保持与盘点/花名册导入同一个读法，免得以后加列时踩时区坑。
   */
  private readImportSheet(file: UploadedWorkbook): unknown[][] {
    try {
      const book = XLSX.read(file.buffer, { type: "buffer", cellDates: false });
      const sheet = book.Sheets[book.SheetNames[0]];
      if (!sheet) throw new Error("sheet-missing");
      const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]!) : null;
      if (range) {
        const rowCount = range.e.r - range.s.r + 1;
        if (rowCount > MATERIAL_IMPORT_MAX_ROWS + 20) throw this.invalid("MATERIAL_IMPORT_ROWS_EXCEEDED", `单次最多导入${MATERIAL_IMPORT_MAX_ROWS}行`);
      }
      return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" }) as unknown[][];
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      throw this.invalid("MATERIAL_IMPORT_INVALID_FILE", "Excel文件无法解析，请使用「下载模板」得到的模板填写");
    }
  }

  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }

  async listSuppliers() { return this.prisma.supplier.findMany({ where: { deletedAt: null }, orderBy: { supplierCode: "asc" } }); }
  async createSupplier(input: SupplierInput & { code_mode?: string }, user: CurrentUser) {
    // 与物料一致：供应商编码支持“自动生成 / 手动填写”，由调用方选择。
    const code = input.code_mode === "auto" ? await this.nextSupplierCode() : input.supplier_code?.trim();
    if (!code) throw new UnprocessableEntityException({ code: "SUPPLIER_CODE_REQUIRED", message: "手动编码模式必须填写供应商编码", details: [] });
    return this.write("supplier", () => this.prisma.supplier.create({ data: { supplierCode: code, name: input.name, contactName: input.contact_name, phone: input.phone, address: input.address, settlementInfo: (input.settlement_info ?? {}) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } }), user);
  }
  async updateSupplier(id: string, input: Partial<SupplierInput>, user: CurrentUser) { await this.requireSupplier(id); return this.write("supplier", () => this.prisma.supplier.update({ where: { id }, data: { ...(input.supplier_code === undefined || input.supplier_code === null ? {} : { supplierCode: input.supplier_code }), ...(input.name === undefined || input.name === null ? {} : { name: input.name }), ...(input.contact_name === undefined ? {} : { contactName: input.contact_name }), ...(input.phone === undefined ? {} : { phone: input.phone }), ...(input.address === undefined ? {} : { address: input.address }), ...(input.settlement_info === undefined ? {} : { settlementInfo: input.settlement_info as Prisma.InputJsonValue }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } }), user, id); }
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
          : // supplier：采购单头与采购明细行都会引用；任一未删除引用都应阻止删除。
            await Promise.all([
              tx.purchaseOrder.count({ where: { supplierId: id, deletedAt: null } }),
              tx.purchaseOrderItem.count({ where: { supplierId: id, deletedAt: null } }),
            ]);
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
  /** P2002 的提示要按主数据种类、并按冲突列说清楚：物料可能是组合冲突，也可能是物料编码重复。 */
  private async write(kind: string, action: () => Promise<any>, user: CurrentUser, id?: string) { try { const result = await action(); await this.audit.record(`${kind}.${id ? "update" : "create"}`, kind, user.id, id ?? result.id); return result; } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "MASTER_DATA_CONFLICT", message: this.conflictMessage(kind, error), details: [] }); throw error; } }
  private conflictMessage(kind: string, error?: unknown) {
    if (kind === "material") {
      // 组合唯一索引（名称+规格型号+颜色）与物料编码是两件不同的事，提示不能混。
      // 复用平台的冲突列判断（下划线/驼峰/约束名都能识别）。
      if (isUniqueConstraintViolationOn(error, "material_code")) return "物料编码已存在：请换一个物料编码，或改用「自动生成」编码模式";
      return "「名称 + 规格型号 + 颜色」完全相同的物料已存在：请修改规格型号或颜色（同名不同规格/颜色可以并存），或改用其它物料编码";
    }
    if (kind === "unit") return "单位名称已存在";
    return "名称或编码已存在";
  }
  /** 物料组合唯一键的组成部分统一处理：去空格，未填写用空串（NULL 会让唯一索引失效）。 */
  private materialKey(value: string | null | undefined) { return (value ?? "").trim(); }
  private async requireUnit(id: string) { const item = await this.prisma.unit.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "单位不存在", details: [] }); return item; }
  private async requireActiveUnit(id: string) { const item = await this.prisma.unit.findFirst({ where: { id, deletedAt: null, isActive: true } }); if (!item) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "单位不存在或已停用", details: [] }); return item; }
  private async requireMaterial(id: string) { const item = await this.prisma.material.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "MATERIAL_NOT_FOUND", message: "物料不存在", details: [] }); return item; }
  private async requireSupplier(id: string) { const item = await this.prisma.supplier.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "SUPPLIER_NOT_FOUND", message: "供应商不存在", details: [] }); return item; }
  private async nextMaterialCode() { return this.nextSequenceCode("MAT", async (prefix) => (await this.prisma.material.findMany({ where: { materialCode: { startsWith: prefix } }, select: { materialCode: true } })).map((row) => row.materialCode)); }
  private async nextSupplierCode() { return this.nextSequenceCode("SUP", async (prefix) => (await this.prisma.supplier.findMany({ where: { supplierCode: { startsWith: prefix } }, select: { supplierCode: true } })).map((row) => row.supplierCode)); }

  /**
   * 自动编码：前缀 = 类别 + 当天日期，序号按当天已有编码的数字后缀最大值 +1（4 位补零）。
   * 物料/供应商/客户共用同一套规则（见 platform/database/daily-sequence-code.ts），避免三种主数据各写一份。
   */
  private async nextSequenceCode(category: string, readCodes: (prefix: string) => Promise<Array<string | null>>) {
    const prefix = dailyCodePrefix(category);
    return nextSequenceCode(prefix, await readCodes(prefix));
  }
}
