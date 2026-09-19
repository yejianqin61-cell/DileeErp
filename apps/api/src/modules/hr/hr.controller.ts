import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import { IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import type { Response } from "express";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { makerStamp } from "../../platform/audit/maker-stamp";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAdministrator } from "../../platform/authorization/require-administrator.decorator";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { sendWorkbook } from "../finance/finance-report-workbook";
import { AttendancePerformanceService } from "./attendance-performance.service";
import { PayrollLedgerService } from "./payroll-ledger.service";
import { PayrollPayableService } from "./payroll-payable.service";
import { buildPayrollPaymentSheetTable } from "./payroll-payment-sheet";
import { SalaryPaymentService } from "./salary-payment.service";

class AttendanceDto { @IsUUID() employee_id!: string; @IsDateString() attendance_date!: string; @IsString() attendance_type!: string; @IsString() work_start_time!: string; @IsString() work_end_time!: string; @IsOptional() @IsString() work_hours?: string; @IsOptional() @IsString() overtime_hours?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class PerformanceDto { @IsUUID() employee_id!: string; @IsDateString() period_start!: string; @IsDateString() period_end!: string; @IsOptional() @IsString() score?: string; @IsOptional() @IsString() grade?: string; @IsOptional() @IsString() reward_amount?: string; @IsOptional() @IsString() comment?: string; @IsOptional() @IsArray() attachment?: unknown[]; }
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }
class PayrollGenerateDto { @IsOptional() @IsUUID() employee_id?: string; @IsOptional() @IsString() employee_name?: string; @IsDateString() period_start!: string; @IsDateString() period_end!: string; @IsString() currency!: string; @IsOptional() @IsString() base_salary?: string; @IsOptional() @IsString() overtime_amount?: string; @IsOptional() @IsString() attendance_deduction?: string; @IsOptional() @IsString() late_deduction?: string; @IsOptional() @IsString() absence_deduction?: string; @IsOptional() @IsString() early_leave_deduction?: string; @IsOptional() @IsString() performance_amount?: string; @IsOptional() @IsString() allowance_amount?: string; @IsOptional() @IsString() housing_allowance?: string; @IsOptional() @IsString() social_insurance?: string; @IsOptional() @IsString() individual_tax?: string; @IsOptional() @IsString() other_adjustment?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class PayrollUpdateDto { @IsOptional() @IsUUID() employee_id?: string; @IsOptional() @IsDateString() period_start?: string; @IsOptional() @IsDateString() period_end?: string; @IsOptional() @IsString() currency?: string; @IsOptional() @IsString() base_salary?: string; @IsOptional() @IsString() overtime_amount?: string; @IsOptional() @IsString() attendance_deduction?: string; @IsOptional() @IsString() late_deduction?: string; @IsOptional() @IsString() absence_deduction?: string; @IsOptional() @IsString() early_leave_deduction?: string; @IsOptional() @IsString() performance_amount?: string; @IsOptional() @IsString() allowance_amount?: string; @IsOptional() @IsString() housing_allowance?: string; @IsOptional() @IsString() social_insurance?: string; @IsOptional() @IsString() individual_tax?: string; @IsOptional() @IsString() other_adjustment?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; @IsOptional() @IsString() reason?: string; }
class PayrollImportMonthDto { @Matches(/^\d{4}-\d{2}$/) month!: string; @IsOptional() @IsUUID() department_id?: string; @IsOptional() @IsUUID() position_id?: string; @IsOptional() @IsString() employee_type?: string; @IsOptional() @IsString() currency?: string; }
/** 工资付款按月导出：月份必填（YYYY-MM），部门/岗位与页面同一套筛选维度。 */
class PayrollPaymentSheetQueryDto { @Matches(/^\d{4}-\d{2}$/) month!: string; @IsOptional() @IsUUID() department_id?: string; @IsOptional() @IsUUID() position_id?: string; }
class PayLedgerDto { @IsString() amount!: string; @IsDateString() payment_date!: string; @IsString() payment_method!: string; @IsOptional() @IsString() currency?: string; /** 发放银行（银行账户池）：发工资都是走银行发放的，必填（服务层校验）。 */ @IsOptional() @IsUUID() bank_id?: string; @IsOptional() @IsString() remark?: string; }
/** 批量付款的一条：一张台账 + 一个金额（服务层会循环调用行内付款，一人一张付款单）。 */
class PayLedgerBatchItemDto { @IsUUID() ledger_id!: string; @IsString() amount!: string; }
/** 批量付款：付款日期/方式/发放银行整批共用（来源是页面顶部的筛选条）。 */
class PayLedgerBatchDto { @IsArray() @ValidateNested({ each: true }) @Type(() => PayLedgerBatchItemDto) items!: PayLedgerBatchItemDto[]; @IsDateString() payment_date!: string; @IsString() payment_method!: string; @IsOptional() @IsUUID() bank_id?: string; @IsOptional() @IsString() currency?: string; @IsOptional() @IsString() remark?: string; }
class PayrollAdjustmentDto { @IsString() adjustment_type!: string; @IsIn(["increase", "decrease"]) effect!: string; @IsString() amount!: string; @IsString() reason!: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class PaymentDto { @IsDateString() payment_date!: string; @IsString() amount!: string; @IsString() currency!: string; @IsString() payment_method!: string; @IsOptional() @IsString() bank_reference?: string; /** 发放银行（银行账户池）：必填（服务层强制）。 */ @IsOptional() @IsUUID() bank_id?: string; @IsOptional() @IsArray() attachment?: unknown[]; @IsOptional() @IsString() remark?: string; }
class SalaryPaymentUpdateDto { @IsOptional() @IsDateString() payment_date?: string; @IsOptional() @IsString() amount?: string; @IsOptional() @IsString() payment_method?: string; @IsOptional() @IsString() bank_reference?: string; /** 传 null / 空串表示清空发放银行，传 undefined 表示不改（与收付款草稿同一约定）。 */ @IsOptional() @IsUUID() bank_id?: string | null; @IsOptional() @IsString() remark?: string; }
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
  // 工资付款按月导出（含「是否付款」列）。**必须声明在下面的 `payroll-ledgers/:id` 之前**：
  // Express 按注册顺序匹配，`:id` 会把 `payment-sheet.xlsx` 整个吃成 id，导出请求就变成查一张不存在的台账（404）。
  // 这个顺序陷阱在本文件里已经踩过一次，同一段代码再犯一次会非常难查（路由存在、路径也对，就是永远 404）。
  @Get("payroll-ledgers/payment-sheet.xlsx")
  @RequireAdministrator()
  async paymentSheet(@Query() query: PayrollPaymentSheetQueryDto, @Res() response: Response, @CurrentUser() user: CurrentUserType) {
    // 列的列名与列序是用户明确要求固定的，所以不往表里插列；「这份文件是谁生成的」写在表尾落款
    // （与财务报表导出同一处文案：makerStamp）。
    const table = buildPayrollPaymentSheetTable(await this.payments.paymentSheetRows(query.month, query.department_id, query.position_id), { footnotes: [makerStamp(user)] });
    return sendWorkbook(response, table, "工资付款");
  }
  @Get("payroll-ledgers/:id") getLedger(@Param("id") id: string) { return this.wrap(this.payroll.get(id)); }
  @Post("payroll-ledgers/generate") generateLedger(@Body() body: PayrollGenerateDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.generate(body, user)); }
  // 按月导入全部在册员工（用户要求「每个月自动先导入全部员工」）：幂等，只补建缺失的草稿台账，
  // 车间员工同时把该月全部生产日报汇总成生产工资；已存在（含已确认/已付款/已软删）的一律不碰。
  @Post("payroll-ledgers/import-month") importMonth(@Body() body: PayrollImportMonthDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.importMonth(body, user)); }
  // 批量付款：勾选多人后一次提交，服务层逐个调用 `payLedger`（一人一张付款单，失败只影响本人）。
  // 与上面的 `generate` / `import-month` 一样是**静态路径**，因此跟它们放在一起、排在 `:id` 路由之前：
  // 「静态路径必须排在动态路径前面」这条规则在本文件里是踩过坑记下来的，集中放一处才不容易再犯。
  @Post("payroll-ledgers/pay-batch") payBatch(@Body() body: PayLedgerBatchDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payments.payBatch(body.items, body, user)); }
  @Patch("payroll-ledgers/:id") updateLedger(@Param("id") id: string, @Body() body: PayrollUpdateDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.update(id, body, user)); }
  @Delete("payroll-ledgers/:id") removeLedger(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.remove(id, user)); }
  @Post("payroll-ledgers/:id/reopen") reopenLedger(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.reopen(id, body.reason, user)); }
  @Post("payroll-ledgers/:id/confirm") confirmLedger(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.confirm(id, user)); }
  @Post("payroll-ledgers/:id/close") closeLedger(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payroll.close(id, user)); }
  @Get("payroll-ledgers/:id/summary") summary(@Param("id") id: string) { return this.wrap(this.payroll.summary(id)); }
  @Get("payroll-payables") listPayrollPayables(@Query("employee_id") employeeId?: string, @Query("status") status?: string, @Query("order_no") orderNo?: string) { return this.wrap(this.payables.list(employeeId, status, orderNo)); }
  @Get("payroll-payables/:id") getPayrollPayable(@Param("id") id: string) { return this.wrap(this.payables.get(id)); }
  @Post("payroll-ledgers/:id/payable") createPayrollPayable(@Param("id") id: string, @Body() body: PayrollPayableCreateDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payables.createFromLedger(id, body, user)); }
  // 工资付款表格里的行内付款／冲销：一次调用完成「应付 → 付款 → 核销」，操作员只需在行上填金额。
  @Post("payroll-ledgers/:id/pay") payLedger(@Param("id") id: string, @Body() body: PayLedgerDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payments.payLedger(id, body, user)); }
  @Post("payroll-ledgers/:id/unpay") unpayLedger(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return this.wrap(this.payments.reverseLedgerPayments(id, body.reason, user)); }
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
