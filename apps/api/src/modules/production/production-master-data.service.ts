import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import * as XLSX from "xlsx";
import type { Express } from "express";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";

type User = CurrentUser;
type Tx = Prisma.TransactionClient;
const EMPLOYEE_IMPORT_HEADERS = ["工号", "姓名", "部门编码", "岗位编码", "员工类型", "入职日期", "离职日期", "备注"] as const;
const EMPLOYEE_IMPORT_MAX_ROWS = 50000;
const EMPLOYEE_IMPORT_CHUNK_SIZE = 200;
// D12: import label tolerance. Seed/dictionary UI labels only expose 车间/非车间,
// but operators historically type 车间员工/非车间员工 (and plain 车间/非车间).
// We normalize all four spellings here; converging the seed/dictionary labels
// themselves is a product-domain decision and is deliberately left untouched.
const EMPLOYEE_TYPE_LABELS: Record<string, "workshop" | "non_workshop"> = { "车间": "workshop", "车间员工": "workshop", "非车间": "non_workshop", "非车间员工": "non_workshop" };
// Excel serial-date conversion window (1 = 1900-01-01 … 60000 ≈ 2064) used only
// when a cell holds a raw number instead of a typed date.
const EXCEL_SERIAL_MAX = 60000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

  listEmployees(filters: { query?: string; employment_status?: string; department_id?: string; position_id?: string; employee_type?: string; hired_from?: string; hired_to?: string; left_from?: string; left_to?: string; has_user?: string } = {}) { const query = filters.query?.trim(); return this.prisma.employee.findMany({ where: { deletedAt: null, ...(query ? { OR: [{ employeeNo: { contains: query, mode: "insensitive" } }, { name: { contains: query, mode: "insensitive" } }] } : {}), ...(filters.employment_status ? { employmentStatus: filters.employment_status } : {}), ...(filters.department_id ? { departmentId: filters.department_id } : {}), ...(filters.position_id ? { positionId: filters.position_id } : {}), ...(filters.employee_type ? { employeeType: filters.employee_type } : {}), ...(filters.has_user === "true" ? { userId: { not: null } } : filters.has_user === "false" ? { userId: null } : {}), ...(filters.hired_from || filters.hired_to ? { hiredOn: { ...(filters.hired_from ? { gte: new Date(filters.hired_from) } : {}), ...(filters.hired_to ? { lte: new Date(filters.hired_to) } : {}) } } : {}), ...(filters.left_from || filters.left_to ? { leftOn: { ...(filters.left_from ? { gte: new Date(filters.left_from) } : {}), ...(filters.left_to ? { lte: new Date(filters.left_to) } : {}) } } : {}) }, include: { department: true, position: true }, orderBy: [{ employeeNo: "asc" }, { name: "asc" }] }); }
  async exportEmployees(filters: Parameters<ProductionMasterDataService["listEmployees"]>[0]) { const rows = await this.listEmployees(filters); const userIds = rows.flatMap((row) => row.userId ? [row.userId] : []); const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds }, deletedAt: null }, select: { id: true, username: true } }) : []; const usernames = new Map(users.map((user) => [user.id, user.username])); const data = rows.map((row) => ({ "工号": row.employeeNo, "姓名": row.name, "员工类型": row.employeeType === "workshop" ? "车间" : row.employeeType === "non_workshop" ? "非车间" : row.employeeType, "员工状态": row.employmentStatus === "active" ? "在职" : row.employmentStatus === "left" ? "离职" : row.employmentStatus === "inactive" ? "停用" : row.employmentStatus, "入职日期": row.hiredOn ? row.hiredOn.toISOString().slice(0, 10) : "", "离职日期": row.leftOn ? row.leftOn.toISOString().slice(0, 10) : "", "部门编码": row.department.code, "部门名称": row.department.name, "岗位编码": row.position.code, "岗位名称": row.position.name, "绑定系统用户名": row.userId ? usernames.get(row.userId) ?? "" : "", "员工备注": row.remark ?? "", "创建时间": row.createdAt.toISOString().replace("T", " ").slice(0, 19), "更新时间": row.updatedAt.toISOString().replace("T", " ").slice(0, 19) })); const sheet = XLSX.utils.json_to_sheet(data); sheet["!cols"] = Object.keys(data[0] ?? { "工号": "" }).map(() => ({ wch: 18 })); const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "员工名单"); return XLSX.write(book, { type: "buffer", bookType: "xlsx" }); }
  employeeImportTemplate() { const sheet = XLSX.utils.aoa_to_sheet([[...EMPLOYEE_IMPORT_HEADERS], ["E0001", "张三", "D001", "P001", "车间", "2026-01-01", "", ""]]); sheet["!cols"] = EMPLOYEE_IMPORT_HEADERS.map(() => ({ wch: 18 })); const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, "员工导入"); return XLSX.write(book, { type: "buffer", bookType: "xlsx" }); }

  // D10-D12: robust row-by-row employee import.
  //  - structural problems are collected per row (same {row, field?, reason} shape);
  //  - valid rows are imported in chunked transactions; a DB failure inside one
  //    chunk rolls back only that chunk and is retried row-by-row so a single bad
  //    row (e.g. a race on employee_no) never fails the whole batch;
  //  - the summary is unambiguous: status "partial" whenever errors exist, and
  //    successCount/imported reflect rows actually inserted.
  async importEmployees(file: Express.Multer.File | undefined, user: User) {
    if (!file?.buffer?.length) throw new UnprocessableEntityException({ code: "EMPLOYEE_IMPORT_FILE_REQUIRED", message: "请上传Excel文件（仅支持 .xlsx/.xls）", details: [] });
    let rows: unknown[][];
    try {
      const book = XLSX.read(file.buffer, { type: "buffer", cellDates: true });
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
    const errors: { row: number; field?: string; reason: string }[] = [];
    let headerOk = true;
    if (!rows.length) { headerOk = false; errors.push({ row: 1, reason: `首行必须严格为：${EMPLOYEE_IMPORT_HEADERS.join("、")}` }); }
    else if (rows[0].slice(0, EMPLOYEE_IMPORT_HEADERS.length).map((cell) => String(cell ?? "").trim()).join("\u0001") !== EMPLOYEE_IMPORT_HEADERS.join("\u0001")) { headerOk = false; errors.push({ row: 1, reason: `首行必须严格为：${EMPLOYEE_IMPORT_HEADERS.join("、")}` }); }
    const dataRows = rows.slice(1).filter((row) => row.some((cell) => String(cell ?? "").trim()));
    if (headerOk && !dataRows.length) errors.push({ row: 0, reason: "未检测到数据行" });
    let imported = 0;
    if (headerOk) {
      // column alignment is unknown when the header is wrong — refuse to import anything
      const departments = await this.prisma.department.findMany({ where: { deletedAt: null, isActive: true }, select: { id: true, code: true } });
      const positions = await this.prisma.position.findMany({ where: { deletedAt: null, isActive: true }, select: { id: true, code: true, departmentId: true } });
      const departmentMap = new Map(departments.map((item) => [item.code.trim(), item]));
      const positionMap = new Map(positions.map((item) => [item.code.trim(), item]));
      const employeeNos = dataRows.map((row) => String(row[0] ?? "").trim()).filter(Boolean);
      const existing = new Set((await this.prisma.employee.findMany({ where: { employeeNo: { in: employeeNos } }, select: { employeeNo: true } })).map((item) => item.employeeNo));
      const seen = new Set<string>();
      const valid: { line: number; employeeNo: string; name: string; departmentId: string; positionId: string; employeeType: "workshop" | "non_workshop"; hiredOn?: Date; leftOn?: Date; remark?: string }[] = [];
      const rowHasErrors = (line: number) => errors.some((error) => error.row === line);
      dataRows.forEach((row, index) => {
        const line = index + 2;
        const cell = (column: number) => String(row[column] ?? "").trim();
        const employeeNo = cell(0);
        const name = cell(1);
        const departmentCode = cell(2);
        const positionCode = cell(3);
        const employeeType = cell(4);
        const hired = row[5];
        const left = row[6];
        const remark = cell(7);
        const extraColumns = row.slice(EMPLOYEE_IMPORT_HEADERS.length);
        if (extraColumns.some((value) => String(value ?? "").trim())) errors.push({ row: line, field: "列数", reason: `列数超过模板（应为${EMPLOYEE_IMPORT_HEADERS.length}列）` });
        if (!employeeNo) errors.push({ row: line, field: "工号", reason: "不能为空" });
        else if (employeeNo.length > 80) errors.push({ row: line, field: "工号", reason: "长度不能超过80个字符" });
        else if (existing.has(employeeNo)) errors.push({ row: line, field: "工号", reason: "工号已存在，不覆盖" });
        else if (seen.has(employeeNo)) errors.push({ row: line, field: "工号", reason: "文件内工号重复" });
        else seen.add(employeeNo);
        if (!name) errors.push({ row: line, field: "姓名", reason: "不能为空" });
        else if (name.length > 100) errors.push({ row: line, field: "姓名", reason: "长度不能超过100个字符" });
        if (remark.length > 500) errors.push({ row: line, field: "备注", reason: "长度不能超过500个字符" });
        const department = departmentMap.get(departmentCode);
        if (!department) errors.push({ row: line, field: "部门编码", reason: "部门不存在或已停用" });
        const position = positionMap.get(positionCode);
        if (!position) errors.push({ row: line, field: "岗位编码", reason: "岗位不存在或已停用" });
        else if (department && position.departmentId !== department.id) errors.push({ row: line, field: "岗位编码", reason: "岗位不属于该部门" });
        const type = EMPLOYEE_TYPE_LABELS[employeeType];
        if (!type) errors.push({ row: line, field: "员工类型", reason: "仅允许车间/车间员工/非车间/非车间员工" });
        const hiredOn = this.parseImportDate(hired);
        const leftOn = this.parseImportDate(left);
        if (hired !== undefined && hired !== null && String(hired).trim() && !hiredOn) errors.push({ row: line, field: "入职日期", reason: "日期格式必须为YYYY-MM-DD" });
        if (left !== undefined && left !== null && String(left).trim() && !leftOn) errors.push({ row: line, field: "离职日期", reason: "日期格式必须为YYYY-MM-DD" });
        if (hiredOn && leftOn && leftOn < hiredOn) errors.push({ row: line, field: "离职日期", reason: "不能早于入职日期" });
        if (!rowHasErrors(line)) valid.push({ line, employeeNo, name, departmentId: department!.id, positionId: position!.id, employeeType: type!, hiredOn: hiredOn ?? undefined, leftOn: leftOn ?? undefined, remark: remark || undefined });
      });
      const dbFailures: { row: number; reason: string }[] = [];
      for (let start = 0; start < valid.length; start += EMPLOYEE_IMPORT_CHUNK_SIZE) {
        const chunk = valid.slice(start, start + EMPLOYEE_IMPORT_CHUNK_SIZE);
        try {
          await this.prisma.$transaction(chunk.map((item) => this.prisma.employee.create({ data: this.employeeImportCreate(item, user) })));
          imported += chunk.length;
        } catch {
          // Whole chunk failed (constraint race or transient error): retry each row
          // in its own small transaction so unrelated rows are still imported.
          for (const item of chunk) {
            try { await this.prisma.employee.create({ data: this.employeeImportCreate(item, user) }); imported += 1; }
            catch (error) { dbFailures.push({ row: item.line, reason: this.employeeCreateFailureReason(error) }); }
          }
        }
      }
      if (dbFailures.length) errors.push(...dbFailures);
    }
    const errorCount = errors.length;
    await this.audit.record("employee.import", "employee", user.id, undefined, { count: imported, total: dataRows.length, error_count: errorCount });
    return { status: errorCount ? "partial" : "success", imported, total: dataRows.length, successCount: imported, errorCount, errors };
  }

  private employeeImportCreate(item: { employeeNo: string; name: string; departmentId: string; positionId: string; employeeType: string; hiredOn?: Date; leftOn?: Date; remark?: string }, user: User) {
    return { employeeNo: item.employeeNo, name: item.name, departmentId: item.departmentId, positionId: item.positionId, employeeType: item.employeeType, employmentStatus: item.leftOn ? "left" : "active", hiredOn: item.hiredOn, leftOn: item.leftOn, remark: item.remark, ...this.audit.create(user) };
  }
  private employeeCreateFailureReason(error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") return "工号已存在（并发重复），未导入";
    if (error && typeof error === "object" && "code" in error && error.code === "P2003") return "部门或岗位不存在，未导入";
    return "数据库写入失败，未导入";
  }

  // D12: tolerate Date objects, common separators, Excel serial numbers and
  // date-time text (only the date part is kept), then normalize to a plain
  // YYYY-MM-DD Date (UTC) used for @db.Date columns.
  private parseImportDate(value: unknown): Date | null {
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return null;
    let year = 0; let month = 0; let day = 0;
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return null;
      year = value.getFullYear(); month = value.getMonth() + 1; day = value.getDate();
    } else if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 1 || value > EXCEL_SERIAL_MAX) return null;
      const serial = Math.floor(value);
      const epoch = new Date(Date.UTC(1899, 11, 30));
      const date = new Date(epoch.getTime() + serial * MS_PER_DAY);
      year = date.getUTCFullYear(); month = date.getUTCMonth() + 1; day = date.getUTCDate();
    } else {
      // strip a trailing time part ("2026-01-05T00:00:00Z", "2026/1/5 8:30", …)
      const datePart = String(value).trim().split(/[ T]/)[0];
      const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(datePart) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(datePart);
      if (!match) return null;
      year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
    }
    if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    // reject rollover inputs such as 2026-02-31 instead of silently shifting them
    if (Number.isNaN(date.getTime()) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date;
  }

  async createEmployee(input: { employee_no: string; name: string; department_id: string; position_id: string; employee_type: string; user_id?: string; hired_on?: string; left_on?: string; remark?: string }, user: User) { await this.requireOrganization(input.department_id, input.position_id); this.assertEmployeeType(input.employee_type); this.assertEmploymentDates(input.hired_on ? new Date(input.hired_on) : undefined, input.left_on ? new Date(input.left_on) : undefined); if (input.user_id) await this.assertUserBindable(input.user_id); return this.write("employee", () => this.prisma.employee.create({ data: { employeeNo: input.employee_no, name: input.name, departmentId: input.department_id, positionId: input.position_id, employeeType: input.employee_type, userId: input.user_id, employmentStatus: input.left_on ? "left" : "active", hiredOn: input.hired_on ? new Date(input.hired_on) : undefined, leftOn: input.left_on ? new Date(input.left_on) : undefined, remark: input.remark, ...this.audit.create(user) } }), user); }

  // D6: employment-state guard on PATCH.
  // Minimal self-consistent rules:
  //  - an ACTIVE employee may set/clear/change left_on in the edit form; the
  //    business linkage is preserved (non-empty left_on => status "left");
  //  - a LEFT/INACTIVE employee may only re-submit the unchanged stored left_on
  //    (pure no-op so base-info edits keep working); any other left_on change is
  //    rejected 409 EMPLOYEE_NOT_ACTIVE — status changes (rehire/reactivate or a
  //    leave date correction) must go through /active (reactivate) or /leave.
  //  - hired_on/user_id/employee_no/name/... keep their existing business linkage.
  async updateEmployee(id: string, input: Partial<{ employee_no: string; name: string; department_id: string; position_id: string; employee_type: string; user_id: string | null; hired_on: string | null; left_on: string | null; remark: string | null }>, user: User) {
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
