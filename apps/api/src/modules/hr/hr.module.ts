import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { AttendancePerformanceService } from "./attendance-performance.service";
import { HrController } from "./hr.controller";
import { PayrollLedgerService } from "./payroll-ledger.service";
import { SalaryPaymentService } from "./salary-payment.service";

@Module({ imports: [AuditModule], controllers: [HrController], providers: [AttendancePerformanceService, PayrollLedgerService, SalaryPaymentService], exports: [AttendancePerformanceService, PayrollLedgerService, SalaryPaymentService] })
export class HrModule {}
