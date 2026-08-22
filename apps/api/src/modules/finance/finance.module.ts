import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { FinanceController } from "./finance.controller";
import { ReceivableService } from "./receivable.service";
import { CustomerPaymentService } from "./customer-payment.service";
import { ReceivableAdjustmentService } from "./receivable-adjustment.service";
import { ReconciliationService } from "./reconciliation.service";

@Module({ imports: [AuditModule], controllers: [FinanceController], providers: [ReceivableService, CustomerPaymentService, ReceivableAdjustmentService, ReconciliationService], exports: [ReceivableService, CustomerPaymentService, ReceivableAdjustmentService, ReconciliationService] })
export class FinanceModule {}
