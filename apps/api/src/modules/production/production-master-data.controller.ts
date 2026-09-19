import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { IsBoolean, IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
// 文件名里的时间戳也走北京时间（与文件内容里的操作时间同口径）。
import { beijingStamp } from "../../platform/time/beijing-time";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { RequireAdministrator } from "../../platform/authorization/require-administrator.decorator";
import { ProductionMasterDataService } from "./production-master-data.service";
import type { Response } from "express";
import type { Express } from "express";

class ActiveDto { @IsBoolean() is_active!: boolean; }
class LeaveDto { @IsDateString() left_on!: string; }
class DepartmentDto { @IsString() @MaxLength(80) code!: string; @IsString() @MaxLength(100) name!: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }
class PositionDto { @IsUUID() department_id!: string; @IsString() @MaxLength(80) code!: string; @IsString() @MaxLength(100) name!: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }
// 员工 DTO = 花名册口径（《在职员工花名册》）：工号、姓名、部门、职务、状态、出生日期、学历、血型、
// 入职/离职日期、员工类型、社保/商业险、劳动合同与劳务合同起止、性别、民族、身份证号码、
// 家庭住址、现住地址、联系方式、紧急联络人与备注。
// 年龄/工龄/当月生日/合同到期提醒是派生列，由服务端按当天日期实时计算，因此**不在** DTO 里。
// 工号可留空：服务端按 EMP-当天日期-序号 自动生成。
class EmployeeDto { @IsOptional() @IsString() @MaxLength(80) employee_no?: string; @IsString() @MaxLength(100) name!: string; @IsUUID() department_id!: string; @IsUUID() position_id!: string; @IsString() @MaxLength(40) employee_type!: string; @IsOptional() @IsUUID() user_id?: string; @IsOptional() @IsDateString() hired_on?: string; @IsOptional() @IsDateString() left_on?: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; @IsOptional() @IsDateString() birth_date?: string; @IsOptional() @IsString() @MaxLength(10) gender?: string; @IsOptional() @IsString() @MaxLength(50) ethnicity?: string; @IsOptional() @IsString() @MaxLength(30) id_card_no?: string; @IsOptional() @IsString() @MaxLength(50) education?: string; @IsOptional() @IsString() @MaxLength(10) blood_type?: string; @IsOptional() @IsBoolean() social_insurance?: boolean; @IsOptional() @IsBoolean() commercial_insurance?: boolean; @IsOptional() @IsDateString() contract_start?: string; @IsOptional() @IsDateString() contract_end?: string; @IsOptional() @IsDateString() labor_contract_start?: string; @IsOptional() @IsDateString() labor_contract_end?: string; @IsOptional() @IsString() @MaxLength(500) home_address?: string; @IsOptional() @IsString() @MaxLength(500) current_address?: string; @IsOptional() @IsString() @MaxLength(50) phone?: string; @IsOptional() @IsString() @MaxLength(100) emergency_contact?: string; @IsOptional() @IsString() @MaxLength(50) emergency_phone?: string; }
class LocationDto { @IsString() @MaxLength(150) name!: string; @IsString() location_type!: string; @IsOptional() @IsString() @MaxLength(100) contact_name?: string; @IsOptional() @IsString() @MaxLength(50) contact_phone?: string; @IsOptional() @IsString() @MaxLength(500) address?: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }
class OperationDto { @IsOptional() @IsString() @MaxLength(80) operation_code?: string; @IsString() @MaxLength(150) operation_name!: string; @IsOptional() @IsUUID() default_unit_id?: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }
class RateDto { @IsUUID() employee_id!: string; @IsUUID() operation_id!: string; @IsString() wage_mode!: string; @IsString() unit_price!: string; @IsDateString() effective_from!: string; @IsOptional() @IsDateString() effective_to?: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }

// PATCH DTOs: declare ONLY the keys a client may change so the global
// ValidationPipe (whitelist + forbidNonWhitelisted) rejects anything else —
// audit/state columns (createdAt/updatedAt/createdBy/updatedBy/deletedAt/
// deletedBy/isActive …) can therefore never be smuggled into an update body.
// Every field is optional (PATCH semantics); constraints mirror the create DTO.
class UpdateDepartmentDto { @IsOptional() @IsString() @MaxLength(80) code?: string; @IsOptional() @IsString() @MaxLength(100) name?: string; @IsOptional() @IsString() @MaxLength(500) remark?: string | null; }
class UpdatePositionDto { @IsOptional() @IsUUID() department_id?: string; @IsOptional() @IsString() @MaxLength(80) code?: string; @IsOptional() @IsString() @MaxLength(100) name?: string; @IsOptional() @IsString() @MaxLength(500) remark?: string | null; }
class UpdateEmployeeDto { @IsOptional() @IsString() @MaxLength(80) employee_no?: string; @IsOptional() @IsString() @MaxLength(100) name?: string; @IsOptional() @IsUUID() department_id?: string; @IsOptional() @IsUUID() position_id?: string; @IsOptional() @IsString() @MaxLength(40) employee_type?: string; @IsOptional() @IsUUID() user_id?: string | null; @IsOptional() @IsDateString() hired_on?: string | null; @IsOptional() @IsDateString() left_on?: string | null; @IsOptional() @IsString() @MaxLength(500) remark?: string | null; @IsOptional() @IsDateString() birth_date?: string | null; @IsOptional() @IsString() @MaxLength(10) gender?: string | null; @IsOptional() @IsString() @MaxLength(50) ethnicity?: string | null; @IsOptional() @IsString() @MaxLength(30) id_card_no?: string | null; @IsOptional() @IsString() @MaxLength(50) education?: string | null; @IsOptional() @IsString() @MaxLength(10) blood_type?: string | null; @IsOptional() @IsBoolean() social_insurance?: boolean | null; @IsOptional() @IsBoolean() commercial_insurance?: boolean | null; @IsOptional() @IsDateString() contract_start?: string | null; @IsOptional() @IsDateString() contract_end?: string | null; @IsOptional() @IsDateString() labor_contract_start?: string | null; @IsOptional() @IsDateString() labor_contract_end?: string | null; @IsOptional() @IsString() @MaxLength(500) home_address?: string | null; @IsOptional() @IsString() @MaxLength(500) current_address?: string | null; @IsOptional() @IsString() @MaxLength(50) phone?: string | null; @IsOptional() @IsString() @MaxLength(100) emergency_contact?: string | null; @IsOptional() @IsString() @MaxLength(50) emergency_phone?: string | null; }
class UpdateLocationDto { @IsOptional() @IsString() @MaxLength(150) name?: string; @IsOptional() @IsString() location_type?: string; @IsOptional() @IsString() @MaxLength(100) contact_name?: string | null; @IsOptional() @IsString() @MaxLength(50) contact_phone?: string | null; @IsOptional() @IsString() @MaxLength(500) address?: string | null; @IsOptional() @IsString() @MaxLength(500) remark?: string | null; }
class UpdateOperationDto { @IsOptional() @IsString() @MaxLength(80) operation_code?: string | null; @IsOptional() @IsString() @MaxLength(150) operation_name?: string; @IsOptional() @IsUUID() default_unit_id?: string | null; @IsOptional() @IsString() @MaxLength(500) remark?: string | null; }
class UpdateRateDto { @IsOptional() @IsUUID() employee_id?: string; @IsOptional() @IsUUID() operation_id?: string; @IsOptional() @IsString() wage_mode?: string; @IsOptional() @IsString() unit_price?: string; @IsOptional() @IsDateString() effective_from?: string; @IsOptional() @IsDateString() effective_to?: string | null; @IsOptional() @IsString() @MaxLength(500) remark?: string | null; }
class EmployeeQueryDto { @IsOptional() @IsString() query?: string; @IsOptional() @IsString() employment_status?: string; @IsOptional() @IsUUID() department_id?: string; @IsOptional() @IsUUID() position_id?: string; @IsOptional() @IsString() employee_type?: string; @IsOptional() @IsDateString() hired_from?: string; @IsOptional() @IsDateString() hired_to?: string; @IsOptional() @IsDateString() left_from?: string; @IsOptional() @IsDateString() left_to?: string; @IsOptional() @IsString() has_user?: string; /** 与部门池/岗位池同款字符串开关：=true 时把已逻辑删除的员工一起返回。 */ @IsOptional() @IsString() include_deleted?: string; }

const EMPLOYEE_IMPORT_ALLOWED_MIME = new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"]);
// D10: file-type whitelist. Files whose extension or declared MIME is not an
// Excel workbook are rejected before Multer stores them (cb(null, false)),
// which surfaces as a clean 422 from the service's missing-file check. The
// ambiguous application/octet-stream MIME is only accepted when the filename
// also declares an Excel extension.
function employeeImportFileFilter(_req: Express.Request, file: Express.Multer.File, callback: (error: Error | null, acceptFile: boolean) => void) {
  const name = (file.originalname ?? "").toLowerCase();
  const extensionOk = name.endsWith(".xlsx") || name.endsWith(".xls");
  callback(null, extensionOk || (EMPLOYEE_IMPORT_ALLOWED_MIME.has(file.mimetype) && file.mimetype !== "application/octet-stream"));
}

@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class ProductionMasterDataController {
  constructor(private readonly service: ProductionMasterDataService) {}
  @Get("production/departments") departments(@Query("include_deleted") includeDeleted?: string) { return this.ok(this.service.listDepartments(includeDeleted === "true")); }
  @Post("production/departments") @RequireAdministrator() createDepartment(@Body() body: DepartmentDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.createDepartment(body, user)); }
  @Patch("production/departments/:id") @RequireAdministrator() updateDepartment(@Param("id") id: string, @Body() body: UpdateDepartmentDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.updateDepartment(id, body, user)); }
  @Patch("production/departments/:id/active") @RequireAdministrator() activeDepartment(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.setDepartmentActive(id, body.is_active, user)); }
  @Delete("production/departments/:id") @RequireAdministrator() deleteDepartment(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.deleteDepartment(id, user)); }
  @Post("production/departments/:id/restore") @RequireAdministrator() restoreDepartment(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.restoreDepartment(id, user)); }
  @Get("production/positions") positions(@Query("department_id") departmentId?: string) { return this.ok(this.service.listPositions(departmentId)); }
  @Post("production/positions") @RequireAdministrator() createPosition(@Body() body: PositionDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.createPosition(body, user)); }
  @Patch("production/positions/:id") @RequireAdministrator() updatePosition(@Param("id") id: string, @Body() body: UpdatePositionDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.updatePosition(id, body, user)); }
  @Patch("production/positions/:id/active") @RequireAdministrator() activePosition(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.setPositionActive(id, body.is_active, user)); }
  @Delete("production/positions/:id") @RequireAdministrator() deletePosition(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.deletePosition(id, user)); }
  @Post("production/positions/:id/restore") @RequireAdministrator() restorePosition(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.restorePosition(id, user)); }
  @Get("production/employees/export.xlsx") @RequireAdministrator() async exportEmployees(@Query() query: EmployeeQueryDto, @Res() response: Response) { const body = await this.service.exportEmployees(query); const fileName = `DileeERP-employees-${beijingStamp()}.xlsx`; response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`); response.setHeader("Cache-Control", "no-store"); return response.send(body); }
  @Get("production/employees/import-template.xlsx") @RequireAdministrator() async employeeImportTemplate(@Res() response: Response) { const body = this.service.employeeImportTemplate(); response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-员工导入模板.xlsx")}`); response.setHeader("Cache-Control", "no-store"); return response.send(body); }
  @Post("production/employees/import") @RequireAdministrator() @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: employeeImportFileFilter })) async importEmployees(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: CurrentUserType) { return this.ok(await this.service.importEmployees(file, user)); }
  @Get("production/employees") employees(@Query() query: EmployeeQueryDto) { return this.ok(this.service.listEmployees(query)); }
  @Post("production/employees") @RequireAdministrator() createEmployee(@Body() body: EmployeeDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.createEmployee(body, user)); }
  @Patch("production/employees/:id") @RequireAdministrator() updateEmployee(@Param("id") id: string, @Body() body: UpdateEmployeeDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.updateEmployee(id, body, user)); }
  @Patch("production/employees/:id/active") @RequireAdministrator() activeEmployee(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.setEmployeeActive(id, body.is_active, user)); }
  @Patch("production/employees/:id/leave") @RequireAdministrator() leaveEmployee(@Param("id") id: string, @Body() body: LeaveDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.setEmployeeLeft(id, body.left_on, user)); }
  // 删除员工 = 逻辑删除：列表/选择器里不再出现，物理行与历史日报、考勤、绩效、工资台账都保留。
  // 只有管理员能删，且可被 restore 撤销（只清行上的 deletedAt）。
  @Delete("production/employees/:id") @RequireAdministrator() deleteEmployee(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.deleteEmployee(id, user)); }
  @Post("production/employees/:id/restore") @RequireAdministrator() restoreEmployee(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.restoreEmployee(id, user)); }
  @Get("production/locations") locations(@Query("include_deleted") includeDeleted?: string) { return this.ok(this.service.listLocations(includeDeleted === "true")); }
  @Post("production/locations") @RequireAdministrator() createLocation(@Body() body: LocationDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.createLocation(body, user)); }
  @Patch("production/locations/:id") @RequireAdministrator() updateLocation(@Param("id") id: string, @Body() body: UpdateLocationDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.updateLocation(id, body, user)); }
  @Patch("production/locations/:id/active") @RequireAdministrator() activeLocation(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.setLocationActive(id, body.is_active, user)); }
  @Delete("production/locations/:id") @RequireAdministrator() deleteLocation(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.deleteLocation(id, user)); }
  @Post("production/locations/:id/restore") @RequireAdministrator() restoreLocation(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.restoreLocation(id, user)); }
  @Get("production/operations") operations(@Query("include_deleted") includeDeleted?: string) { return this.ok(this.service.listOperations(includeDeleted === "true")); }
  @Post("production/operations") @RequireAdministrator() createOperation(@Body() body: OperationDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.createOperation(body, user)); }
  @Patch("production/operations/:id") @RequireAdministrator() updateOperation(@Param("id") id: string, @Body() body: UpdateOperationDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.updateOperation(id, body, user)); }
  @Patch("production/operations/:id/active") @RequireAdministrator() activeOperation(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.setOperationActive(id, body.is_active, user)); }
  @Delete("production/operations/:id") @RequireAdministrator() deleteOperation(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.deleteOperation(id, user)); }
  @Post("production/operations/:id/restore") @RequireAdministrator() restoreOperation(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.restoreOperation(id, user)); }
  @Get("production/operation-rates") rates(@Query("employee_id") employeeId?: string, @Query("operation_id") operationId?: string) { return this.ok(this.service.listRates(employeeId, operationId)); }
  @Post("production/operation-rates") @RequireAdministrator() createRate(@Body() body: RateDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.createRate(body, user)); }
  @Patch("production/operation-rates/:id") @RequireAdministrator() updateRate(@Param("id") id: string, @Body() body: UpdateRateDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.updateRate(id, body, user)); }
  private ok<T>(data: T) { return Promise.resolve(data).then((value) => ({ data: value, meta: {} })); }
}
