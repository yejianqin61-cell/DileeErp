import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { FinanceModule } from "../finance/finance.module";
import { AttendancePerformanceService } from "./attendance-performance.service";
import { HrController } from "./hr.controller";
import { PayrollLedgerService } from "./payroll-ledger.service";
import { PayrollPayableService } from "./payroll-payable.service";
import { SalaryPaymentService } from "./salary-payment.service";

@Module({ imports: [AuditModule, FinanceModule], controllers: [HrController], providers: [AttendancePerformanceService, PayrollLedgerService, PayrollPayableService, SalaryPaymentService], exports: [AttendancePerformanceService, PayrollLedgerService, PayrollPayableService, SalaryPaymentService] })
export class HrModule {}