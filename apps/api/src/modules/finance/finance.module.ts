import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { FinanceController } from "./finance.controller";
import { ReceivableService } from "./receivable.service";
import { CustomerPaymentService } from "./customer-payment.service";

@Module({ imports: [AuditModule], controllers: [FinanceController], providers: [ReceivableService, CustomerPaymentService], exports: [ReceivableService, CustomerPaymentService] })
export class FinanceModule {}
