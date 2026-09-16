import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import * as XLSX from "xlsx";
import type { Express } from "express";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { dailyCodePrefix, nextSequenceCode } from "../../platform/database/daily-sequence-code";
import { PrismaService } from "../../platform/database/prisma.service";
import {
  EMPLOYEE_DERIVED_HEADERS,
  EMPLOYEE_EXPORT_HEADERS,
  EMPLOYEE_IMPORT_HEADERS,
  EMPLOYEE_IMPORT_SAMPLE_ROW,
  employeeExportRow,
  parseEmployeeRosterRows,
  parseIdCard,
  parseRosterDate,
  parseRosterGender,
  rosterDerived,
  type EmployeeImportRow,
} from "./employee-roster";

type User = CurrentUser;
type Tx = Prisma.TransactionClient;
const EMPLOYEE_IMPORT_MAX_ROWS = 50000;
const EMPLOYEE_IMPORT_CHUNK_SIZE = 200;
// 员工工号留空时自动生成，与物料（MAT-）/供应商（SUP-）/客户（CUS-）共用同一套
// 「类别-当天日期-序号」规则：EMP-20260916-0001。
const EMPLOYEE_CODE_CATEGORY = "EMP";

/**
 * 花名册字段在表单/接口层的入参形状（snake_case，与 DTO 一致）。
 * 键「不出现」＝不改（PATCH 语义）；显式传 null/""＝清空。
 */
type EmployeeRosterInput = {
  birth_date?: string | null;
  gender?: string | null;
  ethnicity?: string | null;
  id_card_no?: string | null;
  education?: string | null;
  blood_type?: string | null;
  social_insurance?: boolean | null;
  commercial_insurance?: boolean | null;
  contract_start?: string | null;
  contract_end?: string | null;
  labor_contract_start?: string | null;
  labor_contract_end?: string | null;
  home_address?: string | null;
  current_address?: string | null;
  phone?: string | null;
  emergency_contact?: string | null;
  emergency_phone?: string | null;
};

/** rosterWriteData 的输出：只含 employees 表的可写列。 */
type EmployeeRosterWrite = {
  birthDate?: Date | null;
  gender?: string | null;
  ethnicity?: string | null;
  idCardNo?: string | null;
  education?: string | null;
  bloodType?: string | null;
  socialInsurance?: boolean | null;
  commercialInsurance?: boolean | null;
  contractStart?: Date | null;
  contractEnd?: Date | null;
  laborContractStart?: Date | null;
  laborContractEnd?: Date | null;
  homeAddress?: string | null;
  currentAddress?: string | null;
  phone?: string | null;
  emergencyContact?: string | null;
  emergencyPhone?: string | null;
};

type EmployeeCreateInput = EmployeeRosterInput & {
  employee_no?: string;
  name: string;
  department_id: string;
  position_id: string;
  employee_type: string;
  user_id?: string;
  hired_on?: string;
  left_on?: string;
  remark?: string;
};

type EmployeeUpdateInput = EmployeeRosterInput & {
  employee_no?: string;
  name?: string;
  department_id?: string;
  position_id?: string;
  employee_type?: string;
  user_id?: string | null;
  hired_on?: string | null;
  left_on?: string | null;
  remark?: string | null;
};

/** rosterWriteData 需要的「当前员工档案」切片：用来合并校验合同区间、决定要不要用身份证补默认值。 */
type EmployeeRosterCurrent = {
  birthDate: Date | null;
  gender: string | null;
  contractStart: Date | null;
  contractEnd: Date | null;
  laborContractStart: Date | null;
  laborContractEnd: Date | null;
};

/** 导入流水线上「已通过全部校验、可以直接落库」的一行。 */
type EmployeeImportCandidate = Omit<EmployeeImportRow, "employeeType"> & {
  employeeType: "workshop" | "non_workshop";
  departmentId: string;
  positionId: string;
  autoNumbered: boolean;
};

@Injectable()
export class ProductionMasterDataService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  listDepartments(includeDeleted = false) { return this.prisma.department.findMany({ where: includeDeleted ? {} : { deletedAt: null }, include: { positions: { where: includeDeleted ? {} : { deletedAt: null }, orderBy: { name: "asc" } }, _count: { select: { positions: true, employees: true } } }, orderBy: { code: "asc" } }); }
  async createDepartment(input: { code: string; name: string; remark?: string }, user: User) { return this.write("department", () => this.prisma.department.create({ data: { code: input.code, name: input.name, remark: input.remark, ...this.audit.create(user) } }), user); }
  // D4: department update now maps a field whitelist instead of spreading the raw
  // request body into Prisma data (audit columns can no longer be overwritten).
  async updateDepartment(id: string, input: Partial<{ code: string; name: string; remark: string | null }>, user: User) { await this.requireDepartment(id); return this.write("department", () => this.prisma.department.update({ where: { id }, data: { ...(input.code === undefined || input.code === null ? {} : { code: input.code }), ...(input.name === undefined || input.name === null ? {} : { name: input.name }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } }), user, id); }
  async setDepartmentActive(id: string, active: boolean, user: User) { await this.requireDepartment(id); const item = await this.prisma.department.update({ where: { id }, data: { isActive: active, ...this.audit.update(user) } }); await this.audit.record(active ? "department.activate" : "department.deactivate", "department", user.id, id); return item; }
  // D7+D9: reference check and soft delete run in one transaction, target row
  // locked FOR UPDATE; the delete itself is audited with a row snapshot.
  async deleteDepartment(id: string, user: User) {
    const item = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM departments WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.department.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "DEPARTMENT_NOT_FOUND", message: "部门不存在", details: [] });
      const [employees, positions] = await Promise.all([tx.employee.count({ where: { departmentId: id, deletedAt: null } }), tx.position.count({ where: { departmentId: id, deletedAt: null } })]);
      if (employees || positions) throw new ConflictException({ code: "DEPARTMENT_IN_USE", message: "部门仍被员工或岗位引用，请先停用或迁移关联数据", details: [{ employees, positions }] });
      return tx.department.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: user.id, isActive: false, updatedBy: user.id } });
    });
    await this.audit.record("department.delete", "department", user.id, id, { code: item.code, name: item.name });
    return item;
  }
  // D7: restore keeps the original deletedBy/deletedAt traces on the audit trail,
  // clears the row deletedAt only, and records the restorer in an audit event.
  async restoreDepartment(id: string, user: User) {
    const item = await this.prisma.department.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!item) throw new NotFoundException({ code: "DEPARTMENT_NOT_DELETED", message: "部门不存在或未删除", details: [] });
    const restored = await this.prisma.department.update({ where: { id }, data: { deletedAt: null, isActive: true, updatedBy: user.id } });
    await this.audit.record("department.restore", "department", user.id, id, { code: item.code, name: item.name, deleted_by: item.deletedBy, deleted_at: item.deletedAt, restored_by: user.id });
    return restored;
  }

  listPositions(departmentId?: string) { return this.prisma.position.findMany({ where: { deletedAt: null, ...(departmentId ? { departmentId } : {}) }, include: { department: true }, orderBy: { name: "asc" } }); }
  async createPosition(input: { department_id: string; code: string; name: string; remark?: string }, user: User) { await this.requireActiveDepartment(input.department_id); return this.write("position", () => this.prisma.position.create({ data: { departmentId: input.department_id, code: input.code, name: input.name, remark: input.remark, ...this.audit.create(user) } }), user); }
  async updatePosition(id: string, input: Partial<{ department_id: string; code: string; name: string; remark: string | null }>, user: User) { await this.requirePosition(id); if (input.department_id) await this.requireActiveDepartment(input.department_id); return this.write("position", () => this.prisma.position.update({ where: { id }, data: { ...(input.department_id === undefined || input.department_id === null ? {} : { departmentId: input.department_id }), ...(input.code === undefined || input.code === null ? {} : { code: input.code }), ...(input.name === undefined || input.name === null ? {} : { name: input.name }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } }), user, id); }
  async setPositionActive(id: string, active: boolean, user: User) { await this.requirePosition(id); const item = await this.prisma.position.update({ where: { id }, data: { isActive: active, ...this.audit.update(user) } }); await this.audit.record(active ? "position.activate" : "position.deactivate", "position", user.id, id); return item; }
  async deletePosition(id: string, user: User) {
    const item = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM positions WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.position.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "POSITION_NOT_FOUND", message: "岗位不存在", details: [] });
      const employees = await tx.employee.count({ where: { positionId: id, deletedAt: null } });
      if (employees) throw new ConflictException({ code: "POSITION_IN_USE", message: "岗位仍被员工引用，请先停用或迁移关联员工", details: [{ employees }] });
      return tx.position.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: user.id, isActive: false, updatedBy: user.id } });
    });
    await this.audit.record("position.delete", "position", user.id, id, { department_id: item.departmentId, code: item.code, name: item.name });
    return item;
  }
  async restorePosition(id: string, user: User) {
    const item = await this.prisma.position.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!item) throw new NotFoundException({ code: "POSITION_NOT_DELETED", message: "岗位不存在或未删除", details: [] });
    await this.requireActiveDepartment(item.departmentId);
    const restored = await this.prisma.position.update({ where: { id }, data: { deletedAt: null, isActive: true, updatedBy: user.id } });
    await this.audit.record("position.restore", "position", user.id, id, { department_id: item.departmentId, code: item.code, name: item.name, deleted_by: item.deletedBy, deleted_at: item.deletedAt, restored_by: user.id });
    return restored;
  }

  // 员工目录读模型：除员工表本身的字段外，还直接带上花名册的派生列
  // （年龄/工龄/当月生日/合同到期提醒）。这些列由出生日期、入职日期和合同结束时间实时算出，不落库。
  //
  // include_deleted=true 时把已逻辑删除的员工一起返回（部门池/岗位池同款开关）：员工列表要靠它
  // 才能看到「已删除」并恢复；默认只返回在册员工，删除就从列表里消失。
  async listEmployees(filters: { query?: string; employment_status?: string; department_id?: string; position_id?: string; employee_type?: string; hired_from?: string; hired_to?: string; left_from?: string; left_to?: string; has_user?: string; include_deleted?: string } = {}) { const query = filters.query?.trim(); const rows = await this.prisma.employee.findMany({ where: { ...(filters.include_deleted === "true" ? {} : { deletedAt: null }), ...(query ? { OR: [{ employeeNo: { contains: query, mode: "insensitive" } }, { name: { contains: query, mode: "insensitive" } }] } : {}), ...(filters.employment_status ? { employmentStatus: filters.employment_status } : {}), ...(filters.department_id ? { departmentId: filters.department_id } : {}), ...(filters.position_id ? { positionId: filters.position_id } : {}), ...(filters.employee_type ? { employeeType: filters.employee_type } : {}), ...(filters.has_user === "true" ? { userId: { not: null } } : filters.has_user === "false" ? { userId: null } : {}), ...(filters.hired_from || filters.hired_to ? { hiredOn: { ...(filters.hired_from ? { gte: new Date(filters.hired_from) } : {}), ...(filters.hired_to ? { lte: new Date(filters.hired_to) } : {}) } } : {}), ...(filters.left_from || filters.left_to ? { leftOn: { ...(filters.left_from ? { gte: new Date(filters.left_from) } : {}), ...(filters.left_to ? { lte: new Date(filters.left_to) } : {}) } } : {}) }, include: { department: true, position: true }, orderBy: [{ employeeNo: "asc" }, { name: "asc" }] }); const today = new Date(); return rows.map((row) => ({ ...row, ...rosterDerived(row, today) })); }
  // 导出＝花名册口径（EMPLOYEE_EXPORT_HEADERS）：原始列顺序 + 系统列，派生列当天实时算。
  // 导出的文件可以直接回灌「批量导入员工」——解析按表头名匹配，派生列会被忽略。
  async exportEmployees(filters: Parameters<ProductionMasterDataService["listEmployees"]>[0]) { const rows = await this.listEmployees(filters); const userIds = rows.flatMap((row) => row.userId ? [row.userId] : []); const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds }, deletedAt: null }, select: { id: true, username: true } }) : []; const usernames = new Map(users.map((user) => [user.id, user.username])); const today = new Date(); const data = rows.map((row, index) => employeeExportRow(row, index, row.userId ? usernames.get(row.userId) ?? "" : "", today)); const sheet = XLSX.utils.json_to_sheet(data, { header: [...EMPLOYEE_EXPORT_HEADERS] }); sheet["!cols"] = EMPLOYEE_EXPORT_HEADERS.map((header) => ({ wch: header.length > 6 ? 22 : 12 })); const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "员工名单"); return XLSX.write(book, { type: "buffer", bookType: "xlsx" }); }
  // 导入模板＝花名册的全部非派生字段 + 系统三列（工号/离职日期/员工类型），另附「填写说明」页。
  // 序号/年龄/工龄/当月生日/合同到期提醒是派生列，不进模板（导出时才会带上）。
  employeeImportTemplate() {
    const sheet = XLSX.utils.aoa_to_sheet([[...EMPLOYEE_IMPORT_HEADERS], [...EMPLOYEE_IMPORT_SAMPLE_ROW]]);
    sheet["!cols"] = EMPLOYEE_IMPORT_HEADERS.map((header) => ({ wch: Math.max(12, header.length * 2 + 4) }));
    const notes = XLSX.utils.aoa_to_sheet([
      ["填写说明"],
      ["1. 工号留空时由系统自动生成（EMP-当天日期-序号，例如 EMP-20260916-0001）；填写时不能与已有工号重复。"],
      ["2. 部门与职务可以填名称，也可以填部门编码/岗位编码；两者都必须先在部门池/岗位池里存在且处于启用状态。"],
      ["3. 员工类型只允许「车间」或「非车间」，它决定计件/计时工资规则。整列留空时，若该部门已有员工的类型完全一致，系统会照该类型推断并在导入结果里如实报告；不一致或该部门还没有员工时必须手工填写。"],
      ["4. 身份证号码填对时，出生日期和性别可以留空，系统会按身份证自动推算（同时校验校验位）；两者都填时必须一致。"],
      ["5. 日期格式 YYYY-MM-DD（也接受 2026/1/5、Excel 日期单元格）；「是否」类字段填 是 / 否。"],
      [`6. ${EMPLOYEE_DERIVED_HEADERS.join("、")} 是派生列，不需要填写，导出员工名单时会自动带上。`],
      ["7. 状态填「在职/离职/停用」，留空则按离职日期推断。"],
    ]);
    notes["!cols"] = [{ wch: 110 }];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "员工导入");
    XLSX.utils.book_append_sheet(book, notes, "填写说明");
    return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  }

  // 员工导入：按花名册口径解析（表头名匹配 + 行内校验在 employee-roster.ts 里完成）。
  //  - 表头缺列 / 文件不是员工表：只回一条整体错误，一行都不写；
  //  - 逐行结构性问题（必填、日期、身份证、长度、区间）在纯函数里收集，统一的 {row, field?, reason} 形状；
  //  - 通过校验的行按 200 行一批写库，一批失败退化成逐行独立事务，
  //    一行撞唯一约束（并发下工号重复）不会拖垮整批；自动生成的工号撞号时换号重试一次；
  //  - 工号留空按 EMP-当天日期-序号 自动生成；
  //  - 汇总口径明确：只要还有错误就是 partial，imported/successCount 是真正落库的行数。
  async importEmployees(file: Express.Multer.File | undefined, user: User) {
    if (!file?.buffer?.length) throw new UnprocessableEntityException({ code: "EMPLOYEE_IMPORT_FILE_REQUIRED", message: "请上传Excel文件（仅支持 .xlsx/.xls）", details: [] });
    let rows: unknown[][];
    try {
      // 必须 cellDates: false：SheetJS 的 cellDates 会把 Excel 序列号转成「本地零点附近」的
      // Date（实测差 25 秒 → 整日错位一天）。保留数字则走 parseRosterDate 里的精确序列号换算。
      const book = XLSX.read(file.buffer, { type: "buffer", cellDates: false });
      const sheet = book.Sheets[book.SheetNames[0]];
      if (!sheet) throw new Error("sheet-missing");
      const ref = sheet["!ref"];
      if (ref) {
        const range = XLSX.utils.decode_range(ref);
        const rowCount = range.e.r - range.s.r + 1;
        if (rowCount > EMPLOYEE_IMPORT_MAX_ROWS) throw new UnprocessableEntityException({ code: "IMPORT_ROWS_EXCEEDED", message: `单次最多导入${EMPLOYEE_IMPORT_MAX_ROWS}行`, details: [{ rows: rowCount }] });
      }
      rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" }) as unknown[][];
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      throw new UnprocessableEntityException({ code: "EMPLOYEE_IMPORT_INVALID_FILE", message: "Excel文件无法解析，请使用导出的员工导入模板", details: [] });
    }

    const parsed = parseEmployeeRosterRows(rows);
    const errors: { row: number; field?: string; reason: string }[] = [...parsed.errors];
    let imported = 0;
    let autoNumbered = 0;
    let inferredEmployeeTypes = 0;

    // 只有「整批不可导入」（找不到表头 / 缺必需列 / 没有数据行）才跳过写库；
    // 纯行级错误不该拖着合法行一起不导 —— 通过校验的行照导，出错的行单独列出（status=partial）。
    if (!parsed.blocked) {
      // 部门/职务「先按编码、再按名称」解析：花名册里写的是名称，旧模板写的是编码，两种都能对上。
      const [departments, positions, assignments] = await Promise.all([
        this.prisma.department.findMany({ where: { deletedAt: null, isActive: true }, select: { id: true, code: true, name: true } }),
        this.prisma.position.findMany({ where: { deletedAt: null, isActive: true }, select: { id: true, code: true, name: true, departmentId: true } }),
        this.prisma.employee.findMany({ where: { deletedAt: null }, select: { departmentId: true, employeeType: true } }),
      ]);
      // 手工花名册没有「员工类型」列。该列留空时，只有当这个部门里已有员工的类型完全一致
      // 才照着推断（生产部→车间、办公室→非车间）；一旦不唯一就报错让操作员自己填，
      // 绝不在影响计件/计时工资的字段上猜。
      const departmentTypes = new Map<string, Set<string>>();
      for (const item of assignments) {
        const types = departmentTypes.get(item.departmentId) ?? new Set<string>();
        types.add(item.employeeType);
        departmentTypes.set(item.departmentId, types);
      }
      const declaredNos = parsed.rows.map((row) => row.employeeNo).filter(Boolean);
      const existing = new Set((await this.prisma.employee.findMany({ where: { employeeNo: { in: declaredNos } }, select: { employeeNo: true } })).map((item) => item.employeeNo));
      const valid: EmployeeImportCandidate[] = [];
      for (const row of parsed.rows) {
        const before = errors.length;
        if (row.employeeNo && existing.has(row.employeeNo)) errors.push({ row: row.line, field: "工号", reason: "工号已存在，不覆盖" });
        const department = this.matchByNameOrCode(departments, row.departmentText);
        if (!department) errors.push({ row: row.line, field: "部门", reason: `部门「${row.departmentText}」不存在或已停用` });
        const position = this.matchByNameOrCode(positions, row.positionText, department?.id) ?? this.matchByNameOrCode(positions, row.positionText);
        if (!position) errors.push({ row: row.line, field: "职务", reason: `职务/岗位「${row.positionText}」不存在或已停用` });
        else if (department && position.departmentId !== department.id) errors.push({ row: row.line, field: "职务", reason: `岗位「${position.name}」不属于部门「${department.name}」` });
        let employeeType = row.employeeType;
        if (!employeeType && department) {
          const types = departmentTypes.get(department.id);
          if (types?.size === 1) { employeeType = [...types][0] as "workshop" | "non_workshop"; inferredEmployeeTypes += 1; }
          else errors.push({ row: row.line, field: "员工类型", reason: `不能为空：部门「${department.name}」${types?.size ? "已有多种员工类型" : "还没有员工"}，请在模板里填写车间/非车间` });
        }
        if (errors.length > before) continue;
        valid.push({ ...row, employeeType: employeeType!, departmentId: department!.id, positionId: position!.id, autoNumbered: !row.employeeNo });
      }
      const pending = valid.filter((item) => item.autoNumbered);
      autoNumbered = pending.length;
      if (pending.length) {
        // 序号必须从「当天已有的最大工号」之后接着排，否则同一批次之外的历史工号会被撞上。
        const prefix = dailyCodePrefix(EMPLOYEE_CODE_CATEGORY);
        const existingToday = await this.prisma.employee.findMany({ where: { employeeNo: { startsWith: prefix } }, select: { employeeNo: true } });
        const taken = new Set([...existing, ...existingToday.map((item) => item.employeeNo), ...valid.map((item) => item.employeeNo).filter(Boolean)]);
        for (const item of pending) {
          item.employeeNo = nextSequenceCode(prefix, [...taken]);
          taken.add(item.employeeNo);
        }
      }
      imported = await this.insertImportedEmployees(valid, errors, user);
    }

    // 「做完了什么」以外还要说清「你该做什么」：手工花名册缺员工类型列时，操作员看到 10 条
    // 「员工类型不能为空」是不够的，得直接告诉他去补哪一列；而如果推断成功了，就别再让他返工。
    const hints: string[] = [];
    if (parsed.headerRow > 0 && !parsed.presentFields.includes("employee_type")) {
      const untyped = errors.filter((error) => error.field === "员工类型").length;
      const detail = [
        inferredEmployeeTypes ? `已按各部门已有员工的一致类型推断 ${inferredEmployeeTypes} 行，请复核` : "",
        untyped ? `${untyped} 行无法推断：车间/非车间决定计件/计时工资规则，请下载最新导入模板补上该列后再上传` : "",
      ].filter(Boolean).join("；");
      hints.push(`文件里没有「员工类型」列：${detail || "建议下次上传时在模板里补上该列"}。`);
    }
    if (parsed.documentLayout) {
      hints.push(`识别为手工花名册版式：表头在第 ${parsed.headerRow} 行${parsed.ignoredTrailingRows ? `，末尾 ${parsed.ignoredTrailingRows} 行说明批注已跳过` : ""}${parsed.ignoredColumns.length ? `，忽略的列：${parsed.ignoredColumns.join("、")}` : ""}。`);
    }
    if (parsed.addressedFromIdCard) {
      hints.push(`${parsed.addressedFromIdCard} 行的家庭住址留空，已用身份证前 6 位解析出的省市县补了前缀（镇/村/门牌请在员工编辑里补全）。`);
    }

    await this.audit.record("employee.import", "employee", user.id, undefined, { count: imported, total: parsed.dataRowCount, error_count: errors.length, auto_numbered: autoNumbered, inferred_employee_types: inferredEmployeeTypes, addressed_from_id_card: parsed.addressedFromIdCard, document_layout: parsed.documentLayout });
    return {
      status: errors.length ? "partial" : "success",
      imported,
      total: parsed.dataRowCount,
      successCount: imported,
      errorCount: errors.length,
      autoNumbered,
      inferredEmployeeTypes,
      addressedFromIdCard: parsed.addressedFromIdCard,
      ignoredColumns: parsed.ignoredColumns,
      ignoredTrailingRows: parsed.ignoredTrailingRows,
      headerRow: parsed.headerRow,
      missingColumns: parsed.missingRequired,
      documentLayout: parsed.documentLayout,
      presentFields: parsed.presentFields,
      hints,
      errors,
    };
  }

  /** 分批写库；一批失败就退化成逐行独立事务，自动生成的工号撞号时换号重试一次。 */
  private async insertImportedEmployees(rows: EmployeeImportCandidate[], errors: { row: number; field?: string; reason: string }[], user: User) {
    let imported = 0;
    for (let start = 0; start < rows.length; start += EMPLOYEE_IMPORT_CHUNK_SIZE) {
      const chunk = rows.slice(start, start + EMPLOYEE_IMPORT_CHUNK_SIZE);
      try {
        await this.prisma.$transaction(chunk.map((item) => this.prisma.employee.create({ data: this.employeeImportCreate(item, user) })));
        imported += chunk.length;
        continue;
      } catch {
        // 整批失败（唯一约束竞争或瞬时错误）：逐行重试，别让一行坏数据拖垮整批。
      }
      for (const item of chunk) {
        try { await this.prisma.employee.create({ data: this.employeeImportCreate(item, user) }); imported += 1; continue; }
        catch (error) {
          if (item.autoNumbered && this.isUniqueViolation(error)) {
            try {
              item.employeeNo = await this.nextEmployeeNo();
              await this.prisma.employee.create({ data: this.employeeImportCreate(item, user) });
              imported += 1;
              continue;
            } catch (retryError) { errors.push({ row: item.line, reason: this.employeeCreateFailureReason(retryError) }); continue; }
          }
          errors.push({ row: item.line, reason: this.employeeCreateFailureReason(error) });
        }
      }
    }
    return imported;
  }

  /** 下一个自动工号：EMP-当天日期-序号（与物料/供应商/客户共用同一套规则）。 */
  private async nextEmployeeNo() {
    const prefix = dailyCodePrefix(EMPLOYEE_CODE_CATEGORY);
    const codes = await this.prisma.employee.findMany({ where: { employeeNo: { startsWith: prefix } }, select: { employeeNo: true } });
    return nextSequenceCode(prefix, codes.map((item) => item.employeeNo));
  }

  private isUniqueViolation(error: unknown) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002"); }

  /** 部门/职务解析：先按编码精确匹配，再按名称精确匹配；给了 departmentId 时优先在该部门内找职务。 */
  private matchByNameOrCode<T extends { id: string; code: string; name: string; departmentId?: string }>(rows: T[], text: string, departmentId?: string): T | null {
    const key = text.trim();
    if (!key) return null;
    const inScope = (item: T) => !departmentId || item.departmentId === departmentId;
    return rows.find((item) => item.code.trim() === key && inScope(item))
      ?? rows.find((item) => item.name.trim() === key && inScope(item))
      ?? null;
  }

  private employeeImportCreate(item: EmployeeImportCandidate, user: User) {
    return {
      employeeNo: item.employeeNo,
      name: item.name,
      departmentId: item.departmentId,
      positionId: item.positionId,
      employeeType: item.employeeType,
      // 状态列优先；没有状态列时按离职日期推断（与编辑表单的既有口径一致）。
      employmentStatus: item.employmentStatus ?? (item.leftOn ? "left" : "active"),
      hiredOn: item.hiredOn,
      leftOn: item.leftOn,
      remark: item.remark,
      birthDate: item.birthDate,
      gender: item.gender,
      ethnicity: item.ethnicity,
      idCardNo: item.idCardNo,
      education: item.education,
      bloodType: item.bloodType,
      socialInsurance: item.socialInsurance,
      commercialInsurance: item.commercialInsurance,
      contractStart: item.contractStart,
      contractEnd: item.contractEnd,
      laborContractStart: item.laborContractStart,
      laborContractEnd: item.laborContractEnd,
      homeAddress: item.homeAddress,
      currentAddress: item.currentAddress,
      phone: item.phone,
      emergencyContact: item.emergencyContact,
      emergencyPhone: item.emergencyPhone,
      ...this.audit.create(user),
    };
  }
  private employeeCreateFailureReason(error: unknown) {
    if (this.isUniqueViolation(error)) return "工号已存在（并发重复），未导入";
    if (error && typeof error === "object" && "code" in error && error.code === "P2003") return "部门或职务不存在，未导入";
    return "数据库写入失败，未导入";
  }

  /**
   * 花名册字段的表单入口。与 Excel 导入共用同一套规范化规则，保证「页面新建/编辑」和
   * 「批量导入」写进去的口径一致：身份证号反向推导出生日期与性别、日期只取日期部分、
   * 性别只允许男/女、空字符串按“清空”处理（不往库里写空串）。
   *
   * 只处理请求里**出现过**的键（PATCH 语义）；current 用于判断「该不该用身份证补默认值」——
   * 已有值的字段不会被推导结果覆盖。
   */
  private rosterWriteData(input: EmployeeRosterInput, current?: EmployeeRosterCurrent): EmployeeRosterWrite {
    const data: EmployeeRosterWrite = {};
    const bucket = data as Record<string, unknown>;
    const assignDate = (value: string | null | undefined, column: keyof EmployeeRosterWrite, label: string) => {
      if (value === undefined) return;
      if (!value) { bucket[column] = null; return; }
      const parsed = parseRosterDate(value);
      if (!parsed) throw new UnprocessableEntityException({ code: "INVALID_ROSTER_DATE", message: `${label}格式必须为 YYYY-MM-DD`, details: [] });
      bucket[column] = parsed;
    };
    const assignText = (value: string | null | undefined, column: keyof EmployeeRosterWrite) => {
      if (value === undefined) return;
      bucket[column] = value && value.trim() ? value.trim() : null;
    };

    assignDate(input.birth_date, "birthDate", "出生日期");
    assignDate(input.contract_start, "contractStart", "合同开始时间");
    assignDate(input.contract_end, "contractEnd", "合同结束时间");
    assignDate(input.labor_contract_start, "laborContractStart", "劳务合同开始时间");
    assignDate(input.labor_contract_end, "laborContractEnd", "劳务合同结束时间");
    assignText(input.ethnicity, "ethnicity");
    assignText(input.education, "education");
    assignText(input.blood_type, "bloodType");
    assignText(input.home_address, "homeAddress");
    assignText(input.current_address, "currentAddress");
    assignText(input.phone, "phone");
    assignText(input.emergency_contact, "emergencyContact");
    assignText(input.emergency_phone, "emergencyPhone");
    if (input.social_insurance !== undefined) data.socialInsurance = input.social_insurance;
    if (input.commercial_insurance !== undefined) data.commercialInsurance = input.commercial_insurance;

    if (input.gender !== undefined) {
      const gender = parseRosterGender(input.gender);
      if (gender === null) throw new UnprocessableEntityException({ code: "INVALID_ROSTER_GENDER", message: "性别仅允许男或女", details: [] });
      data.gender = gender ?? null;
    }

    if (input.id_card_no !== undefined) {
      const raw = (input.id_card_no ?? "").trim();
      if (!raw) data.idCardNo = null;
      else {
        const parsed = parseIdCard(raw);
        if (!parsed.ok) throw new UnprocessableEntityException({ code: "INVALID_ID_CARD", message: `身份证号码${parsed.reason}`, details: [] });
        data.idCardNo = raw.replace(/\s+/g, "").toUpperCase();
        // 出生日期/性别留空时按身份证补上；已经填了就必须和身份证自洽。
        const explicitBirth = input.birth_date ? parseRosterDate(input.birth_date) : null;
        const storedBirth = current?.birthDate ?? null;
        if (explicitBirth && explicitBirth.getTime() !== parsed.value.birthDate.getTime()) throw new UnprocessableEntityException({ code: "ID_CARD_MISMATCH", message: "出生日期与身份证号推算的不一致", details: [] });
        if (!explicitBirth && !storedBirth) data.birthDate = parsed.value.birthDate;
        const explicitGender = input.gender ? parseRosterGender(input.gender) : null;
        const storedGender = current?.gender ?? null;
        if (explicitGender && explicitGender !== parsed.value.gender) throw new UnprocessableEntityException({ code: "ID_CARD_MISMATCH", message: "性别与身份证号推算的不一致", details: [] });
        if (!explicitGender && !storedGender) data.gender = parsed.value.gender;
      }
    }

    this.assertRosterContractRanges(data, current);
    return data;
  }

  /** 合同区间必须单调（数据库也有 CHECK；这里提前给出可读的 422）。 */
  private assertRosterContractRanges(data: EmployeeRosterWrite, current?: EmployeeRosterCurrent) {
    const resolve = (key: keyof EmployeeRosterWrite, currentValue: Date | null | undefined) => (key in data ? (data[key] as Date | null) : currentValue ?? null);
    const contractStart = resolve("contractStart", current?.contractStart);
    const contractEnd = resolve("contractEnd", current?.contractEnd);
    if (contractStart && contractEnd && contractEnd < contractStart) throw new UnprocessableEntityException({ code: "INVALID_CONTRACT_RANGE", message: "合同结束时间不能早于合同开始时间", details: [] });
    const laborStart = resolve("laborContractStart", current?.laborContractStart);
    const laborEnd = resolve("laborContractEnd", current?.laborContractEnd);
    if (laborStart && laborEnd && laborEnd < laborStart) throw new UnprocessableEntityException({ code: "INVALID_CONTRACT_RANGE", message: "劳务合同结束时间不能早于劳务合同开始时间", details: [] });
  }

  // 新建员工：工号留空时按 EMP-当天日期-序号 自动生成（与导入同一条规则），
  // 花名册字段走 rosterWriteData（身份证可反推出生日期/性别）。
  async createEmployee(input: EmployeeCreateInput, user: User) {
    await this.requireOrganization(input.department_id, input.position_id);
    this.assertEmployeeType(input.employee_type);
    this.assertEmploymentDates(input.hired_on ? new Date(input.hired_on) : undefined, input.left_on ? new Date(input.left_on) : undefined);
    if (input.user_id) await this.assertUserBindable(input.user_id);
    const employeeNo = input.employee_no?.trim() || (await this.nextEmployeeNo());
    const roster = this.rosterWriteData(input);
    return this.write("employee", () => this.prisma.employee.create({ data: {
      employeeNo,
      name: input.name,
      departmentId: input.department_id,
      positionId: input.position_id,
      employeeType: input.employee_type,
      userId: input.user_id,
      employmentStatus: input.left_on ? "left" : "active",
      hiredOn: input.hired_on ? new Date(input.hired_on) : undefined,
      leftOn: input.left_on ? new Date(input.left_on) : undefined,
      remark: input.remark,
      ...roster,
      ...this.audit.create(user),
    } }), user);
  }

  // D6: employment-state guard on PATCH.
  // Minimal self-consistent rules:
  //  - an ACTIVE employee may set/clear/change left_on in the edit form; the
  //    business linkage is preserved (non-empty left_on => status "left");
  //  - a LEFT/INACTIVE employee may only re-submit the unchanged stored left_on
  //    (pure no-op so base-info edits keep working); any other left_on change is
  //    rejected 409 EMPLOYEE_NOT_ACTIVE — status changes (rehire/reactivate or a
  //    leave date correction) must go through /active (reactivate) or /leave.
  //  - hired_on/user_id/employee_no/name/... keep their existing business linkage.
  async updateEmployee(id: string, input: EmployeeUpdateInput, user: User) {
    const employee = await this.requireEmployee(id);
    if (input.department_id || input.position_id) await this.requireOrganization(input.department_id ?? employee.departmentId, input.position_id ?? employee.positionId);
    if (input.employee_type) this.assertEmployeeType(input.employee_type);
    const touchesHired = input.hired_on !== undefined;
    const touchesLeft = input.left_on !== undefined;
    const nextHired = touchesHired ? (input.hired_on ? new Date(input.hired_on) : null) : employee.hiredOn;
    const activeNow = employee.employmentStatus === "active";
    let nextLeft: Date | null = employee.leftOn;
    let nextStatus: string | undefined;
    if (touchesLeft) {
      const requested = input.left_on ? new Date(input.left_on) : null;
      if (activeNow) {
        nextLeft = requested;
        nextStatus = requested ? "left" : "active";
      } else if (requested && employee.leftOn && requested.getTime() === employee.leftOn.getTime()) {
        // unchanged re-submission for a departed employee — no state change
      } else {
        throw new ConflictException({ code: "EMPLOYEE_NOT_ACTIVE", message: "仅在职员工允许在编辑中设置或调整离职日期；离职/停用员工的重新入职请使用启用接口", details: [] });
      }
    }
    this.assertEmploymentDates(nextHired, nextLeft);
    if (input.user_id) await this.assertUserBindable(input.user_id, id);
    // 花名册字段与入职/离职一样走合并校验：合同区间要跟库里的另一半放在一起判断，
    // 身份证推导默认值时也不能覆盖员工档案里已有的出生日期/性别。
    const roster = this.rosterWriteData(input, employee);
    return this.write("employee", () => this.prisma.employee.update({ where: { id }, data: {
      ...(input.employee_no === undefined || input.employee_no === null ? {} : { employeeNo: input.employee_no }),
      ...(input.name === undefined || input.name === null ? {} : { name: input.name }),
      ...(input.department_id === undefined || input.department_id === null ? {} : { departmentId: input.department_id }),
      ...(input.position_id === undefined || input.position_id === null ? {} : { positionId: input.position_id }),
      ...(input.employee_type === undefined || input.employee_type === null ? {} : { employeeType: input.employee_type }),
      ...(input.user_id === undefined ? {} : { userId: input.user_id }),
      ...(touchesHired ? { hiredOn: nextHired } : {}),
      ...(touchesLeft ? { leftOn: nextLeft } : {}),
      ...(nextStatus ? { employmentStatus: nextStatus } : {}),
      ...(input.remark === undefined ? {} : { remark: input.remark }),
      ...roster,
      ...this.audit.update(user),
    } }), user, id);
  }
  // D6: activating from left/inactive is a rehire/restore: clear the stale
  // leftOn (so status and dates stay consistent) and audit employee.reactivate.
  async setEmployeeActive(id: string, active: boolean, user: User) {
    const employee = await this.requireEmployee(id);
    if (active) {
      const item = await this.prisma.employee.update({ where: { id }, data: { employmentStatus: "active", leftOn: null, ...this.audit.update(user) } });
      if (employee.employmentStatus !== "active") await this.audit.record("employee.reactivate", "employee", user.id, id, { previous_status: employee.employmentStatus, previous_left_on: employee.leftOn ? employee.leftOn.toISOString().slice(0, 10) : null });
      return item;
    }
    const item = await this.prisma.employee.update({ where: { id }, data: { employmentStatus: "inactive", ...this.audit.update(user) } });
    await this.audit.record("employee.deactivate", "employee", user.id, id, { previous_status: employee.employmentStatus });
    return item;
  }
  async setEmployeeLeft(id: string, leftOn: string, user: User) {
    const employee = await this.requireEmployee(id);
    if (employee.employmentStatus !== "active") throw new ConflictException({ code: "EMPLOYEE_NOT_ACTIVE", message: "只有在职员工可以办理离职", details: [] });
    this.assertEmploymentDates(employee.hiredOn, new Date(leftOn));
    const item = await this.prisma.employee.update({ where: { id }, data: { employmentStatus: "left", leftOn: new Date(leftOn), ...this.audit.update(user) } });
    await this.audit.record("employee.leave", "employee", user.id, id, { left_on: leftOn });
    return item;
  }

  // 删除员工 = 逻辑删除（从员工列表/所有选择器里消失），物理行保留，历史日报、考勤、绩效和工资台账
  // 都还引用它，名称快照也照旧能查到。
  //
  // 刻意**不做**引用检查：员工被日报/工资引用是常态，像部门/岗位那样「被引用就不许删」会让删除
  // 几乎永远失败。真正需要停掉的业务由 state 控制（离职/停用），删除是更高一层的「这条不该在册」。
  //
  // 与部门/岗位同一套写法：事务内 FOR UPDATE 锁行 + 只删未删除的行（重复删除 → 404）+ 审计留痕。
  async deleteEmployee(id: string, user: User) {
    const item = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM employees WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.employee.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "EMPLOYEE_NOT_FOUND", message: "员工不存在", details: [] });
      return tx.employee.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id } });
    });
    await this.audit.record("employee.delete", "employee", user.id, id, { employee_no: item.employeeNo, name: item.name, department_id: item.departmentId, employment_status: item.employmentStatus });
    return item;
  }
  // 恢复：只清掉行上的 deletedAt，保留 deletedBy/deletedAt 的原始痕迹到审计事件里。
  // 删错了的员工（以及被别人登录账号绑定过的员工）可以一键回到在册状态。
  async restoreEmployee(id: string, user: User) {
    const item = await this.prisma.employee.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!item) throw new NotFoundException({ code: "EMPLOYEE_NOT_DELETED", message: "员工不存在或未删除", details: [] });
    const restored = await this.prisma.employee.update({ where: { id }, data: { deletedAt: null, updatedBy: user.id } });
    await this.audit.record("employee.restore", "employee", user.id, id, { employee_no: item.employeeNo, name: item.name, deleted_by: item.deletedBy, deleted_at: item.deletedAt, restored_by: user.id });
    return restored;
  }

  listLocations(includeDeleted = false) { return this.prisma.productionLocation.findMany({ where: includeDeleted ? {} : { deletedAt: null }, orderBy: [{ locationType: "asc" }, { name: "asc" }] }); }
  async createLocation(input: { name: string; location_type: string; contact_name?: string; contact_phone?: string; address?: string; remark?: string }, user: User) { this.assertLocationType(input.location_type); return this.write("production_location", () => this.prisma.productionLocation.create({ data: { name: input.name, locationType: input.location_type, contactName: input.contact_name, contactPhone: input.contact_phone, address: input.address, remark: input.remark, ...this.audit.create(user) } }), user); }
  async updateLocation(id: string, input: Partial<{ name: string; location_type: string; contact_name: string | null; contact_phone: string | null; address: string | null; remark: string | null }>, user: User) { await this.requireLocation(id); if (input.location_type) this.assertLocationType(input.location_type); return this.write("production_location", () => this.prisma.productionLocation.update({ where: { id }, data: { ...(input.name === undefined || input.name === null ? {} : { name: input.name }), ...(input.location_type === undefined || input.location_type === null ? {} : { locationType: input.location_type }), ...(input.contact_name === undefined ? {} : { contactName: input.contact_name }), ...(input.contact_phone === undefined ? {} : { contactPhone: input.contact_phone }), ...(input.address === undefined ? {} : { address: input.address }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } }), user, id); }
  async setLocationActive(id: string, active: boolean, user: User) { await this.requireLocation(id); const item = await this.prisma.productionLocation.update({ where: { id }, data: { isActive: active, ...this.audit.update(user) } }); await this.audit.record(active ? "production_location.activate" : "production_location.deactivate", "production_location", user.id, id); return item; }
  async deleteLocation(id: string, user: User) {
    const item = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_locations WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.productionLocation.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "PRODUCTION_LOCATION_NOT_FOUND", message: "生产地点不存在", details: [] });
      const [orders, batches] = await Promise.all([tx.productionOrder.count({ where: { executionLocationId: id, deletedAt: null } }), tx.outsourceLogisticsBatch.count({ where: { outsourceLocationId: id, deletedAt: null } })]);
      if (orders || batches) throw new ConflictException({ code: "PRODUCTION_LOCATION_IN_USE", message: "加工地点仍被业务记录引用，请先停用或迁移", details: [{ orders, batches }] });
      return tx.productionLocation.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: user.id, isActive: false, updatedBy: user.id } });
    });
    await this.audit.record("production_location.delete", "production_location", user.id, id, { name: item.name, location_type: item.locationType });
    return item;
  }
  async restoreLocation(id: string, user: User) {
    const item = await this.prisma.productionLocation.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!item) throw new NotFoundException({ code: "PRODUCTION_LOCATION_NOT_DELETED", message: "加工地点不存在或未删除", details: [] });
    const restored = await this.prisma.productionLocation.update({ where: { id }, data: { deletedAt: null, isActive: true, updatedBy: user.id } });
    await this.audit.record("production_location.restore", "production_location", user.id, id, { name: item.name, location_type: item.locationType, deleted_by: item.deletedBy, deleted_at: item.deletedAt, restored_by: user.id });
    return restored;
  }

  listOperations(includeDeleted = false) { return this.prisma.operationCatalog.findMany({ where: includeDeleted ? {} : { deletedAt: null }, include: { defaultUnit: true }, orderBy: { operationName: "asc" } }); }
  async createOperation(input: { operation_code?: string; operation_name: string; default_unit_id?: string; remark?: string }, user: User) { if (input.default_unit_id) await this.requireActiveUnit(input.default_unit_id); return this.write("operation_catalog", () => this.prisma.operationCatalog.create({ data: { operationCode: input.operation_code, operationName: input.operation_name, defaultUnitId: input.default_unit_id, remark: input.remark, ...this.audit.create(user) } }), user); }
  async updateOperation(id: string, input: Partial<{ operation_code: string | null; operation_name: string; default_unit_id: string | null; remark: string | null }>, user: User) { await this.requireOperation(id); if (input.default_unit_id) await this.requireActiveUnit(input.default_unit_id); return this.write("operation_catalog", () => this.prisma.operationCatalog.update({ where: { id }, data: { ...(input.operation_code === undefined ? {} : { operationCode: input.operation_code }), ...(input.operation_name === undefined || input.operation_name === null ? {} : { operationName: input.operation_name }), ...(input.default_unit_id === undefined ? {} : { defaultUnitId: input.default_unit_id }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } }), user, id); }
  async setOperationActive(id: string, active: boolean, user: User) { await this.requireOperation(id); const item = await this.prisma.operationCatalog.update({ where: { id }, data: { isActive: active, ...this.audit.update(user) } }); await this.audit.record(active ? "operation_catalog.activate" : "operation_catalog.deactivate", "operation_catalog", user.id, id); return item; }
  async deleteOperation(id: string, user: User) {
    const item = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM operation_catalogs WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.operationCatalog.findFirst({ where: { id, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: "OPERATION_NOT_FOUND", message: "工序不存在", details: [] });
      const [rates, assignments] = await Promise.all([tx.operationRate.count({ where: { operationId: id, deletedAt: null } }), tx.productionOrderOperation.count({ where: { operationCatalogId: id, deletedAt: null } })]);
      if (rates || assignments) throw new ConflictException({ code: "OPERATION_IN_USE", message: "工序仍被计价或生产单引用，请先停用或迁移", details: [{ rates, assignments }] });
      return tx.operationCatalog.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: user.id, isActive: false, updatedBy: user.id } });
    });
    await this.audit.record("operation_catalog.delete", "operation_catalog", user.id, id, { operation_code: item.operationCode, operation_name: item.operationName });
    return item;
  }
  async restoreOperation(id: string, user: User) {
    const item = await this.prisma.operationCatalog.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!item) throw new NotFoundException({ code: "OPERATION_NOT_DELETED", message: "工序不存在或未删除", details: [] });
    const restored = await this.prisma.operationCatalog.update({ where: { id }, data: { deletedAt: null, isActive: true, updatedBy: user.id } });
    await this.audit.record("operation_catalog.restore", "operation_catalog", user.id, id, { operation_code: item.operationCode, operation_name: item.operationName, deleted_by: item.deletedBy, deleted_at: item.deletedAt, restored_by: user.id });
    return restored;
  }
  listRates(employeeId?: string, operationId?: string) { return this.prisma.operationRate.findMany({ where: { deletedAt: null, ...(employeeId ? { employeeId } : {}), ...(operationId ? { operationId } : {}) }, include: { employee: true, operation: true }, orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }] }); }

  // D3 + D5 + D14: create/update rate run the whole "validate employee/operation,
  // ensure no overlapping period, insert/update" sequence in ONE transaction and
  // lock the target employee + operation rows FOR UPDATE so concurrent writes on
  // the same (employee, operation, wage_mode) scope are serialized. An overlap
  // still fails with OPERATION_RATE_OVERLAP (409); unit_price is strictly parsed
  // (Decimal-safe, 422 INVALID_RATE_UNIT_PRICE).
  async createRate(input: { employee_id: string; operation_id: string; wage_mode: string; unit_price: string; effective_from: string; effective_to?: string; remark?: string }, user: User) {
    this.assertWageMode(input.wage_mode);
    this.assertRateDates(input.effective_from, input.effective_to);
    const unitPrice = this.parseUnitPrice(input.unit_price);
    const rate = await this.prisma.$transaction(async (tx) => {
      await this.lockRateScope(tx, input.employee_id, input.operation_id);
      await this.requireActiveEmployeeIn(tx, input.employee_id);
      await this.requireActiveOperationIn(tx, input.operation_id);
      await this.ensureRateNoOverlapIn(tx, { employee_id: input.employee_id, operation_id: input.operation_id, wage_mode: input.wage_mode, effective_from: input.effective_from, effective_to: input.effective_to }, undefined);
      return tx.operationRate.create({ data: { employeeId: input.employee_id, operationId: input.operation_id, wageMode: input.wage_mode, unitPrice, effectiveFrom: new Date(input.effective_from), effectiveTo: input.effective_to ? new Date(input.effective_to) : undefined, remark: input.remark, ...this.audit.create(user) } });
    });
    await this.audit.record("operation_rate.create", "operation_rate", user.id, rate.id, { employee_id: input.employee_id, operation_id: input.operation_id, wage_mode: input.wage_mode, unit_price: unitPrice, effective_from: input.effective_from, effective_to: input.effective_to ?? null });
    return rate;
  }
  async updateRate(id: string, input: Partial<{ employee_id: string; operation_id: string; wage_mode: string; unit_price: string; effective_from: string; effective_to: string | null; remark: string | null }>, user: User) {
    const current = await this.requireRate(id);
    const merged = {
      employee_id: input.employee_id ?? current.employeeId,
      operation_id: input.operation_id ?? current.operationId,
      wage_mode: input.wage_mode ?? current.wageMode,
      unit_price: input.unit_price ?? current.unitPrice.toString(),
      effective_from: input.effective_from ?? current.effectiveFrom.toISOString().slice(0, 10),
      // explicit null clears effective_to (open-ended rate); undefined keeps current
      effective_to: input.effective_to === undefined ? (current.effectiveTo ? current.effectiveTo.toISOString().slice(0, 10) : undefined) : (input.effective_to ?? undefined),
      remark: input.remark,
    };
    this.assertWageMode(merged.wage_mode);
    this.assertRateDates(merged.effective_from, merged.effective_to);
    const unitPrice = this.parseUnitPrice(merged.unit_price);
    const rate = await this.prisma.$transaction(async (tx) => {
      await this.lockRateScope(tx, merged.employee_id, merged.operation_id);
      await this.requireActiveEmployeeIn(tx, merged.employee_id);
      await this.requireActiveOperationIn(tx, merged.operation_id);
      await this.ensureRateNoOverlapIn(tx, merged, id);
      return tx.operationRate.update({ where: { id }, data: { employeeId: merged.employee_id, operationId: merged.operation_id, wageMode: merged.wage_mode, unitPrice, effectiveFrom: new Date(merged.effective_from), effectiveTo: merged.effective_to ? new Date(merged.effective_to) : null, ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } });
    });
    await this.audit.record("operation_rate.update", "operation_rate", user.id, id, { employee_id: merged.employee_id, operation_id: merged.operation_id, wage_mode: merged.wage_mode, unit_price: unitPrice, effective_from: merged.effective_from, effective_to: merged.effective_to ?? null });
    return rate;
  }

  private async lockRateScope(tx: Tx, employeeId: string, operationId: string) {
    // fixed lock order (employee → operation) avoids deadlocks between writers.
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM operation_catalogs WHERE id = ${operationId}::uuid FOR UPDATE`;
  }

  private async write(kind: string, action: () => Promise<any>, user: User, id?: string) { try { const result = await action(); await this.audit.record(`${kind}.${id ? "update" : "create"}`, kind, user.id, id ?? result.id); return result; } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "PRODUCTION_MASTER_DATA_CONFLICT", message: "编码、名称或有效关系已存在", details: [] }); throw error; } }
  private async requireDepartment(id: string) { const item = await this.prisma.department.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "DEPARTMENT_NOT_FOUND", message: "部门不存在", details: [] }); return item; }
  private async requireActiveDepartment(id: string) { const item = await this.prisma.department.findFirst({ where: { id, deletedAt: null, isActive: true } }); if (!item) throw new NotFoundException({ code: "DEPARTMENT_NOT_FOUND", message: "部门不存在或已停用", details: [] }); return item; }
  private async requirePosition(id: string) { const item = await this.prisma.position.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "POSITION_NOT_FOUND", message: "岗位不存在", details: [] }); return item; }
  private async requireEmployee(id: string) { const item = await this.prisma.employee.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "EMPLOYEE_NOT_FOUND", message: "员工不存在", details: [] }); return item; }
  private async requireLocation(id: string) { const item = await this.prisma.productionLocation.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "PRODUCTION_LOCATION_NOT_FOUND", message: "生产地点不存在", details: [] }); return item; }
  private async requireOperation(id: string) { const item = await this.prisma.operationCatalog.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "OPERATION_NOT_FOUND", message: "工序不存在", details: [] }); return item; }
  private async requireRate(id: string) { const item = await this.prisma.operationRate.findFirst({ where: { id, deletedAt: null } }); if (!item) throw new NotFoundException({ code: "OPERATION_RATE_NOT_FOUND", message: "工序计价不存在", details: [] }); return item; }
  private async requireActiveEmployeeIn(tx: Tx, id: string) { const item = await tx.employee.findFirst({ where: { id, deletedAt: null, employmentStatus: "active" } }); if (!item) throw new NotFoundException({ code: "EMPLOYEE_NOT_FOUND", message: "员工不存在或已停用", details: [] }); return item; }
  private async requireActiveOperationIn(tx: Tx, id: string) { const item = await tx.operationCatalog.findFirst({ where: { id, deletedAt: null, isActive: true } }); if (!item) throw new NotFoundException({ code: "OPERATION_NOT_FOUND", message: "工序不存在或已停用", details: [] }); return item; }
  private async requireActiveUnit(id: string) { const item = await this.prisma.unit.findFirst({ where: { id, deletedAt: null, isActive: true } }); if (!item) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "单位不存在或已停用", details: [] }); return item; }
  // D14: enum/date value assertions are parameter errors → 422. Only genuine
  // business conflicts (duplicate, in-use, overlap, state transition) stay 409.
  private assertWageMode(value: string) { if (value !== "piece_rate" && value !== "time_rate") throw new UnprocessableEntityException({ code: "INVALID_WAGE_MODE", message: "计薪方式仅允许计件或计时", details: [] }); }
  private assertEmployeeType(value: string) { if (value !== "workshop" && value !== "non_workshop") throw new UnprocessableEntityException({ code: "INVALID_EMPLOYEE_TYPE", message: "员工类型仅允许车间和非车间", details: [] }); }
  private assertEmploymentDates(hiredOn?: Date | null, leftOn?: Date | null) { if (hiredOn && Number.isNaN(hiredOn.getTime())) throw new UnprocessableEntityException({ code: "INVALID_EMPLOYMENT_DATE", message: "入职日期无效", details: [] }); if (leftOn && Number.isNaN(leftOn.getTime())) throw new UnprocessableEntityException({ code: "INVALID_EMPLOYMENT_DATE", message: "离职日期无效", details: [] }); if (hiredOn && leftOn && leftOn.getTime() < hiredOn.getTime()) throw new UnprocessableEntityException({ code: "INVALID_EMPLOYMENT_DATE", message: "离职日期不能早于入职日期", details: [] }); }
  private assertRateDates(from: string, to?: string) { if (Number.isNaN(new Date(from).getTime())) throw new UnprocessableEntityException({ code: "INVALID_RATE_DATE_RANGE", message: "计价生效日期无效", details: [] }); if (to && new Date(to).getTime() < new Date(from).getTime()) throw new UnprocessableEntityException({ code: "INVALID_RATE_DATE_RANGE", message: "计价失效日期不能早于生效日期", details: [] }); }
  // D5: strict Decimal(18,4)-safe parse: digits only (no sign/exponent/space),
  // non-negative, at most 4 fraction digits, integer part ≤ 14 digits.
  private parseUnitPrice(value: string) {
    const text = String(value ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(text)) throw new UnprocessableEntityException({ code: "INVALID_RATE_UNIT_PRICE", message: "计价单价必须为非负十进制数字（不支持负数、科学计数法或空格）", details: [] });
    const [integerPart, fractionPart = ""] = text.split(".");
    if (fractionPart.length > 4) throw new UnprocessableEntityException({ code: "INVALID_RATE_UNIT_PRICE", message: "计价单价最多保留4位小数", details: [] });
    if (integerPart.replace(/^0+/, "").length > 14) throw new UnprocessableEntityException({ code: "INVALID_RATE_UNIT_PRICE", message: "计价单价超出范围（最大 99999999999999.9999）", details: [] });
    return text;
  }
  private async ensureRateNoOverlapIn(tx: Tx, input: { employee_id: string; operation_id: string; wage_mode: string; effective_from: string; effective_to?: string }, excludeId?: string) {
    const records = await tx.operationRate.findMany({ where: { employeeId: input.employee_id, operationId: input.operation_id, wageMode: input.wage_mode, deletedAt: null, ...(excludeId ? { NOT: { id: excludeId } } : {}) } });
    const from = new Date(input.effective_from).getTime();
    const to = input.effective_to ? new Date(input.effective_to).getTime() : Number.POSITIVE_INFINITY;
    if (records.some((record) => from <= (record.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY) && record.effectiveFrom.getTime() <= to)) throw new ConflictException({ code: "OPERATION_RATE_OVERLAP", message: "同一员工、工序和计薪方式的生效日期不能重叠", details: [] });
  }
  private async requireOrganization(departmentId?: string, positionId?: string) { if (!departmentId || !positionId) return; const position = await this.prisma.position.findFirst({ where: { id: positionId, departmentId, deletedAt: null, isActive: true }, include: { department: true } }); if (!position?.department.isActive) throw new NotFoundException({ code: "ORGANIZATION_NOT_FOUND", message: "部门或岗位不存在、已停用或不匹配", details: [] }); }
  private assertLocationType(value: string) { if (value !== "workshop" && value !== "outsource_site") throw new UnprocessableEntityException({ code: "INVALID_LOCATION_TYPE", message: "生产地点类型仅允许厂内车间或外加工点", details: [] }); }
  // D13: binding an employee to a login user requires the user to exist and be
  // active, and forbids double binding (only the owning employee may hold the
  // user_id). Unbinding (set null) is always allowed. A real DB FK/unique needs a
  // migration and is tracked as a follow-up; this is the application-level guard.
  private async assertUserBindable(userId: string, excludeEmployeeId?: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null, isActive: true }, select: { id: true } });
    if (!user) throw new UnprocessableEntityException({ code: "EMPLOYEE_USER_NOT_FOUND", message: "绑定用户不存在或已停用", details: [] });
    const bound = await this.prisma.employee.findFirst({ where: { userId, deletedAt: null, ...(excludeEmployeeId ? { id: { not: excludeEmployeeId } } : {}) }, select: { id: true, employeeNo: true } });
    if (bound) throw new ConflictException({ code: "EMPLOYEE_USER_ALREADY_BOUND", message: "该用户已绑定其他员工，一个用户只能绑定一名员工", details: [{ employee_id: bound.id, employee_no: bound.employeeNo }] });
  }
}
