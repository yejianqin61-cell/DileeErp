import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { AttendancePerformanceService } from "./attendance-performance.service";
import { PayrollLedgerService } from "./payroll-ledger.service";
import { PayrollPayableService } from "./payroll-payable.service";
import { SalaryPaymentService } from "./salary-payment.service";

class AttendanceDto { @IsUUID() employee_id!: string; @IsDateString() attendance_date!: string; @IsString() attendance_type!: string; @IsString() work_start_time!: string; @IsString() work_end_time!: string; @IsOptional() @IsString() work_hours?: string; @IsOptional() @IsString() overtime_hours?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class PerformanceDto { @IsUUID() employee_id!: string; @IsDateString() period_start!: string; @IsDateString() period_end!: string; @IsOptional() @IsString() score?: string; @IsOptional() @IsString() grade?: string; @IsOptional() @IsString() reward_amount?: string; @IsOptional() @IsString() comment?: string; @IsOptional() @IsArray() attachment?: unknown[]; }
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }
class PayrollGenerateDto { @IsOptional() @IsUUID() employee_id?: string; @IsOptional() @IsString() employee_name?: string; @IsDateString() period_start!: string; @IsDateString() period_end!: string; @IsString() currency!: string; @IsOptional() @IsString() base_salary?: string; @IsOptional() @IsString() overtime_amount?: string; @IsOptional() @IsString() attendance_deduction?: string; @IsOptional() @IsString() late_deduction?: string; @IsOptional() @IsString() absence_deduction?: string; @IsOptional() @IsString() early_leave_deduction?: string; @IsOptional() @IsString() performance_amount?: string; @IsOptional() @IsString() allowance_amount?: string; @IsOptional() @IsString() housing_allowance?: string; @IsOptional() @IsString() social_insurance?: string; @IsOptional() @IsString() individual_tax?: string; @IsOptional() @IsString() other_adjustment?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class PayrollUpdateDto { @IsOptional() @IsUUID() employee_id?: string; @IsOptional() @IsDateString() period_start?: string; @IsOptional() @IsDateString() period_end?: string; @IsOptional() @IsString() currency?: string; @IsOptional() @IsString() base_salary?: string; @IsOptional() @IsString() overtime_amount?: string; @IsOptional() @IsString() attendance_deduction?: string; @IsOptional() @IsString() late_deduction?: string; @IsOptional() @IsString() absence_deduction?: string; @IsOptional() @IsString() early_leave_deduction?: string; @IsOptional() @IsString() performance_amount?: string; @IsOptional() @IsString() allowance_amount?: string; @IsOptional() @IsString() housing_allowance?: string; @IsOptional() @IsString() social_insurance?: string; @IsOptional() @IsString() individual_tax?: string; @IsOptional() @IsString() other_adjustment?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; @IsOptional() @IsString() reason?: string; }
class PayrollImportMonthDto { @Matches(/^\d{4}-\d{2}$/) month!: string; @IsOptional() @IsUUID() department_id?: string; @IsOptional() @IsUUID() position_id?: string; @IsOptional() @IsString() employee_type?: string; @IsOptional() @IsString() currency?: string; }
class PayrollAdjustmentDto { @IsString() adjustment_type!: string; @IsIn(["increase", "decrease"]) effect!: string; @IsString() amount!: string; @IsString() reason!: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class PaymentDto { @IsDateString() payment_date!: string; @IsString() amount!: string; @IsString() currency!: string; @IsString() payment_method!: string; @IsOptional() @IsString() bank_reference?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class SalaryPaymentUpdateDto { @IsOptional() @IsDateString() payment_date?: string; @IsOptional() @IsString() amount?: string; @IsOptional() @IsString() payment_method?: string; @IsOptional() @IsString() bank_reference?: string; @IsOptional() @IsString() remark?: string; }
class AllocationDto { @IsUUID() ledger_id!: string; @IsString() amount!: string; @IsOptional() @IsString() remark?: string; }
class PostPaymentDto { @IsArray() @ValidateNested({ each: true }) @Type(() => AllocationDto) allocations!: AllocationDto[]; }
class PayrollPayableCreateDto { @IsOptional() @IsString() order_no?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class UpdateAttendanceDto { @IsOptional() @IsDateString() attendance_date?: string; @IsOptional() @IsString() attendance_type?: string; @IsOptional() @IsString() work_start_time?: string; @IsOptional() @IsString() work_end_time?: string; @IsOptional() @IsString() work_hours?: string; @IsOptional() @IsString() overtime_hours?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class UpdatePerformanceDto { @IsOptional() @IsString() score?: string; @IsOptional() @IsString() grade?: string; @IsOptional() @IsString() reward_amount?: string; @IsOptional() @IsString() comment?: string; @IsOptional() @IsArray() attachment?: unknown[]; }

@Controller("hr")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("hr")
export class HrController {
  constructor(private readonly attendance: AttendancePerformanceService, private readonly payroll: PayrollLedgerService, private readonly payables: PayrollPayableService, private readonly payments: SalaryPaymentService) {}
  @Get("attendance-records") listAttendance(@Query("employee_id") employeeId?: string, @Query("from") from?: string, @Query("to") to?: string) { return this.wrap(this.attendance.listAttendance(employeeId, from, to)); }
  @Post("attendance-records") createAttendance(@Body() body: AttendanceDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.attendance.createAttendance(body, user)); }
  @Patch("attendance-records/:id") updateAttendance(@Param("id") id: string, @Body() body: UpdateAttendanceDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.attendance.updateAttendance(id, body, user)); }
  @Delete("attendance-records/:id") removeAttendance(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.attendance.removeAttendance(id, body.reason, user)); }
  @Get("performance-records") listPerformance(@Query("employee_id") employeeId?: string, @Query("period_start") start?: string, @Query("period_end") end?: string) { return this.wrap(this.attendance.listPerformance(employeeId, start, end)); }
  @Post("performance-records") createPerformance(@Body() body: PerformanceDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.attendance.createPerformance(body, user)); }
  @Patch("performance-records/:id") updatePerformance(@Param("id") id: string, @Body() body: UpdatePerformanceDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.attendance.updatePerformance(id, body, user)); }
  @Delete("performance-records/:id") removePerformance(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.attendance.removePerformance(id, body.reason, user)); }
  // 工资管理页按「月 + 部门 + 岗位 + 员工类型」筛选：month 为自然月（YYYY-MM），department_id/position_id/employee_type 过滤员工。
  @Get("payroll-ledgers") listLedgers(@Query("employee_id") employeeId?: string, @Query("period_start") start?: string, @Query("period_end") end?: string, @Query("status") status?: string, @Query("from") from?: string, @Query("to") to?: string, @Query("month") month?: string, @Query("department_id") departmentId?: string, @Query("position_id") positionId?: string, @Query("employee_type") employeeType?: string) { return this.wrap(this.payroll.list(employeeId, start, end, status, from, to, month, departmentId, positionId, employeeType)); }
  @Get("payroll-ledgers/:id") getLedger(@Param("id") id: string) { return this.wrap(this.payroll.get(id)); }
  @Post("payroll-ledgers/generate") generateLedger(@Body() body: PayrollGenerateDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.generate(body, user)); }
  // 按月导入全部在册员工（用户要求「每个月自动先导入全部员工」）：幂等，只补建缺失的草稿台账，
  // 车间员工同时把该月全部生产日报汇总成生产工资；已存在（含已确认/已付款/已软删）的一律不碰。
  @Post("payroll-ledgers/import-month") importMonth(@Body() body: PayrollImportMonthDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.importMonth(body, user)); }
  @Patch("payroll-ledgers/:id") updateLedger(@Param("id") id: string, @Body() body: PayrollUpdateDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.update(id, body, user)); }
  @Delete("payroll-ledgers/:id") removeLedger(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.remove(id, user)); }
  @Post("payroll-ledgers/:id/reopen") reopenLedger(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.reopen(id, body.reason, user)); }
  @Post("payroll-ledgers/:id/confirm") confirmLedger(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.confirm(id, user)); }
  @Post("payroll-ledgers/:id/close") closeLedger(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.close(id, user)); }
  @Get("payroll-ledgers/:id/summary") summary(@Param("id") id: string) { return this.wrap(this.payroll.summary(id)); }
  @Get("payroll-payables") listPayrollPayables(@Query("employee_id") employeeId?: string, @Query("status") status?: string, @Query("order_no") orderNo?: string) { return this.wrap(this.payables.list(employeeId, status, orderNo)); }
  @Get("payroll-payables/:id") getPayrollPayable(@Param("id") id: string) { return this.wrap(this.payables.get(id)); }
  @Post("payroll-ledgers/:id/payable") createPayrollPayable(@Param("id") id: string, @Body() body: PayrollPayableCreateDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payables.createFromLedger(id, body, user)); }
  @Post("payroll-payables/:id/confirm") confirmPayrollPayable(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payables.confirm(id, user)); }
  @Post("payroll-payables/:id/reopen") reopenPayrollPayable(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payables.reopen(id, body.reason, user)); }
  @Post("payroll-payables/:id/reverse") reversePayrollPayable(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payables.reverse(id, body.reason, user)); }
  @Post("payroll-ledgers/:id/adjustments") adjustment(@Param("id") id: string, @Body() body: PayrollAdjustmentDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.adjustment(id, body, user)); }
  @Post("payroll-adjustments/:id/post") postAdjustment(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.postAdjustment(id, user)); }
  @Post("payroll-adjustments/:id/reverse") reverseAdjustment(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.reverseAdjustment(id, body.reason, user)); }
  // 工资付款满页表格的筛选与工资台账同一套维度：月份（付款日期自然月）+ 部门 + 岗位。
  @Get("salary-payments") listPayments(@Query("status") status?: string, @Query("month") month?: string, @Query("department_id") departmentId?: string, @Query("position_id") positionId?: string) { return this.wrap(this.payments.list(status, month, departmentId, positionId)); }
  @Get("salary-payments/:id") getPayment(@Param("id") id: string) { return this.wrap(this.payments.get(id)); }
  @Post("salary-payments") createPayment(@Body() body: PaymentDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payments.create(body, user)); }
  @Patch("salary-payments/:id") updatePayment(@Param("id") id: string, @Body() body: SalaryPaymentUpdateDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payments.updateDraft(id, body, user)); }
  @Post("salary-payments/:id/post") postPayment(@Param("id") id: string, @Body() body: PostPaymentDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payments.post(id, body.allocations, user)); }
  @Post("salary-payments/:id/reverse") reversePayment(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payments.reverse(id, body.reason, user)); }
  private wrap<T>(data: T) { return Promise.resolve(data).then((value) => ({ data: value, meta: {} })); }
}
