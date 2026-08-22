import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { AttendancePerformanceService } from "./attendance-performance.service";
import { PayrollLedgerService } from "./payroll-ledger.service";
import { SalaryPaymentService } from "./salary-payment.service";

class AttendanceDto { @IsUUID() employee_id!: string; @IsDateString() attendance_date!: string; @IsString() attendance_type!: string; @IsOptional() @IsString() work_hours?: string; @IsOptional() @IsString() overtime_hours?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class PerformanceDto { @IsUUID() employee_id!: string; @IsDateString() period_start!: string; @IsDateString() period_end!: string; @IsOptional() @IsString() score?: string; @IsOptional() @IsString() grade?: string; @IsOptional() @IsString() reward_amount?: string; @IsOptional() @IsString() comment?: string; @IsOptional() @IsArray() attachment?: unknown[]; }
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }
class PayrollGenerateDto { @IsUUID() employee_id!: string; @IsDateString() period_start!: string; @IsDateString() period_end!: string; @IsString() currency!: string; @IsOptional() @IsString() base_salary?: string; @IsOptional() @IsString() overtime_amount?: string; @IsOptional() @IsString() attendance_deduction?: string; @IsOptional() @IsString() performance_amount?: string; @IsOptional() @IsString() allowance_amount?: string; @IsOptional() @IsString() social_insurance?: string; @IsOptional() @IsString() individual_tax?: string; @IsOptional() @IsString() other_adjustment?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class PayrollAdjustmentDto { @IsString() adjustment_type!: string; @IsIn(["increase", "decrease"]) effect!: string; @IsString() amount!: string; @IsString() reason!: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class PaymentDto { @IsDateString() payment_date!: string; @IsString() amount!: string; @IsString() currency!: string; @IsString() payment_method!: string; @IsOptional() @IsString() bank_reference?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class AllocationDto { @IsUUID() ledger_id!: string; @IsString() amount!: string; @IsOptional() @IsString() remark?: string; }
class PostPaymentDto { @IsArray() allocations!: AllocationDto[]; }

@Controller("hr")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("hr")
export class HrController {
  constructor(private readonly attendance: AttendancePerformanceService, private readonly payroll: PayrollLedgerService, private readonly payments: SalaryPaymentService) {}
  @Get("attendance-records") listAttendance(@Query("employee_id") employeeId?: string, @Query("from") from?: string, @Query("to") to?: string) { return this.wrap(this.attendance.listAttendance(employeeId, from, to)); }
  @Post("attendance-records") createAttendance(@Body() body: AttendanceDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.attendance.createAttendance(body, user)); }
  @Patch("attendance-records/:id") updateAttendance(@Param("id") id: string, @Body() body: Partial<AttendanceDto>, @CurrentUser() user: CurrentUserType) { return this.wrap(this.attendance.updateAttendance(id, body, user)); }
  @Delete("attendance-records/:id") removeAttendance(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.attendance.removeAttendance(id, body.reason, user)); }
  @Get("performance-records") listPerformance(@Query("employee_id") employeeId?: string, @Query("period_start") start?: string, @Query("period_end") end?: string) { return this.wrap(this.attendance.listPerformance(employeeId, start, end)); }
  @Post("performance-records") createPerformance(@Body() body: PerformanceDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.attendance.createPerformance(body, user)); }
  @Patch("performance-records/:id") updatePerformance(@Param("id") id: string, @Body() body: Partial<PerformanceDto>, @CurrentUser() user: CurrentUserType) { return this.wrap(this.attendance.updatePerformance(id, body, user)); }
  @Delete("performance-records/:id") removePerformance(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.attendance.removePerformance(id, body.reason, user)); }
  @Get("payroll-ledgers") listLedgers(@Query("employee_id") employeeId?: string, @Query("period_start") start?: string, @Query("period_end") end?: string, @Query("status") status?: string) { return this.wrap(this.payroll.list(employeeId, start, end, status)); }
  @Get("payroll-ledgers/:id") getLedger(@Param("id") id: string) { return this.wrap(this.payroll.get(id)); }
  @Post("payroll-ledgers/generate") generateLedger(@Body() body: PayrollGenerateDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.generate(body, user)); }
  @Post("payroll-ledgers/:id/confirm") confirmLedger(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.confirm(id, user)); }
  @Get("payroll-ledgers/:id/summary") summary(@Param("id") id: string) { return this.wrap(this.payroll.summary(id)); }
  @Post("payroll-ledgers/:id/adjustments") adjustment(@Param("id") id: string, @Body() body: PayrollAdjustmentDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.adjustment(id, body, user)); }
  @Post("payroll-adjustments/:id/post") postAdjustment(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.postAdjustment(id, user)); }
  @Post("payroll-adjustments/:id/reverse") reverseAdjustment(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.reverseAdjustment(id, body.reason, user)); }
  @Get("salary-payments") listPayments(@Query("status") status?: string) { return this.wrap(this.payments.list(status)); }
  @Get("salary-payments/:id") getPayment(@Param("id") id: string) { return this.wrap(this.payments.get(id)); }
  @Post("salary-payments") createPayment(@Body() body: PaymentDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payments.create(body, user)); }
  @Post("salary-payments/:id/post") postPayment(@Param("id") id: string, @Body() body: PostPaymentDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payments.post(id, body.allocations, user)); }
  @Post("salary-payments/:id/reverse") reversePayment(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payments.reverse(id, body.reason, user)); }
  private wrap<T>(data: T) { return Promise.resolve(data).then((value) => ({ data: value, meta: {} })); }
}
