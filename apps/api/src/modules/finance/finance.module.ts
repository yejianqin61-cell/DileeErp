import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { AccountingSubjectController } from "./accounting-subject.controller";
import { AccountingSubjectService } from "./accounting-subject.service";
import { BankController } from "./bank.controller";
import { BankService } from "./bank.service";
import { BankTransferController } from "./bank-transfer.controller";
import { BankTransferService } from "./bank-transfer.service";
import { CashFlowController } from "./cash-flow.controller";
import { CashFlowService } from "./cash-flow.service";
import { FinanceController } from "./finance.controller";
import { PayableNotificationController } from "./payable-notification.controller";
import { FinanceReportController } from "./finance-report.controller";
import { BomMaterialCostService } from "./finance-report-cost.service";
import { FinanceReportQueryService } from "./finance-report-query.service";
import { ReceivableService } from "./receivable.service";
import { CustomerPaymentService } from "./customer-payment.service";
import { ReceivableAdjustmentService } from "./receivable-adjustment.service";
import { ReconciliationService } from "./reconciliation.service";
import { SupplierPayableService } from "./supplier-payable.service";
import { SupplierPaymentService } from "./supplier-payment.service";
import { SupplierPayableReconciliationService } from "./supplier-payable-reconciliation.service";
import { VoucherController } from "./voucher.controller";
import { VoucherService } from "./voucher.service";

@Module({ imports: [AuditModule], controllers: [FinanceController, PayableNotificationController, FinanceReportController, CashFlowController, AccountingSubjectController, BankController, BankTransferController, VoucherController], providers: [ReceivableService, CustomerPaymentService, ReceivableAdjustmentService, ReconciliationService, SupplierPayableService, SupplierPaymentService, SupplierPayableReconciliationService, FinanceReportQueryService, BomMaterialCostService, CashFlowService, AccountingSubjectService, BankService, BankTransferService, VoucherService], exports: [ReceivableService, CustomerPaymentService, ReceivableAdjustmentService, ReconciliationService, SupplierPayableService, SupplierPaymentService, SupplierPayableReconciliationService, FinanceReportQueryService, BomMaterialCostService, CashFlowService, AccountingSubjectService, BankService, BankTransferService, VoucherService] })
export class FinanceModule {}