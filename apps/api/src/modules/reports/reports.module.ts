import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { ProcurementWarehouseReportService } from "./procurement-warehouse-report.service";
import { ProcurementWarehouseReportExportService } from "./procurement-warehouse-report-export.service";
import { AuditModule } from "../../platform/audit/audit.module";
@Module({ imports: [AuditModule], controllers: [ReportsController], providers: [ReportsService, ProcurementWarehouseReportService, ProcurementWarehouseReportExportService] }) export class ReportsModule {}
