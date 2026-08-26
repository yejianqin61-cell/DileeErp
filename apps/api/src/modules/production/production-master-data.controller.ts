import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsBoolean, IsDateString, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { RequireAdministrator } from "../../platform/authorization/require-administrator.decorator";
import { ProductionMasterDataService } from "./production-master-data.service";

class ActiveDto { @IsBoolean() is_active!: boolean; }
class LeaveDto { @IsDateString() left_on!: string; }
class DepartmentDto { @IsString() @MaxLength(80) code!: string; @IsString() @MaxLength(100) name!: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }
class PositionDto { @IsUUID() department_id!: string; @IsString() @MaxLength(80) code!: string; @IsString() @MaxLength(100) name!: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }
class EmployeeDto { @IsString() @MaxLength(80) employee_no!: string; @IsString() @MaxLength(100) name!: string; @IsUUID() department_id!: string; @IsUUID() position_id!: string; @IsString() @MaxLength(40) employee_type!: string; @IsOptional() @IsUUID() user_id?: string; @IsOptional() @IsDateString() hired_on?: string; @IsOptional() @IsDateString() left_on?: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }
class LocationDto { @IsString() @MaxLength(150) name!: string; @IsString() location_type!: string; @IsOptional() @IsString() @MaxLength(100) contact_name?: string; @IsOptional() @IsString() @MaxLength(50) contact_phone?: string; @IsOptional() @IsString() @MaxLength(500) address?: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }
class OperationDto { @IsOptional() @IsString() @MaxLength(80) operation_code?: string; @IsString() @MaxLength(150) operation_name!: string; @IsOptional() @IsUUID() default_unit_id?: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }
class RateDto { @IsUUID() employee_id!: string; @IsUUID() operation_id!: string; @IsString() wage_mode!: string; @IsString() unit_price!: string; @IsDateString() effective_from!: string; @IsOptional() @IsDateString() effective_to?: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }

@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class ProductionMasterDataController {
  constructor(private readonly service: ProductionMasterDataService) {}
  @Get("production/departments") departments() { return this.ok(this.service.listDepartments()); }
  @Post("production/departments") @RequireAdministrator() createDepartment(@Body() body: DepartmentDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.createDepartment(body, user)); }
  @Patch("production/departments/:id") @RequireAdministrator() updateDepartment(@Param("id") id: string, @Body() body: Partial<DepartmentDto>, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.updateDepartment(id, body, user)); }
  @Patch("production/departments/:id/active") @RequireAdministrator() activeDepartment(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.setDepartmentActive(id, body.is_active, user)); }
  @Get("production/positions") positions(@Query("department_id") departmentId?: string) { return this.ok(this.service.listPositions(departmentId)); }
  @Post("production/positions") @RequireAdministrator() createPosition(@Body() body: PositionDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.createPosition(body, user)); }
  @Patch("production/positions/:id") @RequireAdministrator() updatePosition(@Param("id") id: string, @Body() body: Partial<PositionDto>, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.updatePosition(id, body, user)); }
  @Patch("production/positions/:id/active") @RequireAdministrator() activePosition(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.setPositionActive(id, body.is_active, user)); }
  @Get("production/employees") employees() { return this.ok(this.service.listEmployees()); }
  @Post("production/employees") @RequireAdministrator() createEmployee(@Body() body: EmployeeDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.createEmployee(body, user)); }
  @Patch("production/employees/:id") @RequireAdministrator() updateEmployee(@Param("id") id: string, @Body() body: Partial<EmployeeDto>, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.updateEmployee(id, body, user)); }
  @Patch("production/employees/:id/active") @RequireAdministrator() activeEmployee(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.setEmployeeActive(id, body.is_active, user)); }
  @Patch("production/employees/:id/leave") @RequireAdministrator() leaveEmployee(@Param("id") id: string, @Body() body: LeaveDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.setEmployeeLeft(id, body.left_on, user)); }
  @Get("production/locations") locations() { return this.ok(this.service.listLocations()); }
  @Post("production/locations") createLocation(@Body() body: LocationDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.createLocation(body, user)); }
  @Patch("production/locations/:id") updateLocation(@Param("id") id: string, @Body() body: Partial<LocationDto>, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.updateLocation(id, body, user)); }
  @Patch("production/locations/:id/active") activeLocation(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.setLocationActive(id, body.is_active, user)); }
  @Get("production/operations") operations() { return this.ok(this.service.listOperations()); }
  @Post("production/operations") createOperation(@Body() body: OperationDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.createOperation(body, user)); }
  @Patch("production/operations/:id") updateOperation(@Param("id") id: string, @Body() body: Partial<OperationDto>, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.updateOperation(id, body, user)); }
  @Patch("production/operations/:id/active") activeOperation(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.setOperationActive(id, body.is_active, user)); }
  @Get("production/operation-rates") rates(@Query("employee_id") employeeId?: string, @Query("operation_id") operationId?: string) { return this.ok(this.service.listRates(employeeId, operationId)); }
  @Post("production/operation-rates") createRate(@Body() body: RateDto, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.createRate(body, user)); }
  @Patch("production/operation-rates/:id") updateRate(@Param("id") id: string, @Body() body: Partial<RateDto>, @CurrentUser() user: CurrentUserType) { return this.ok(this.service.updateRate(id, body, user)); }
  private ok<T>(data: T) { return Promise.resolve(data).then((value) => ({ data: value, meta: {} })); }
}
