import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { AuditModule } from "../../platform/audit/audit.module";
@Module({ imports: [AuditModule], controllers: [ReportsController], providers: [ReportsService] }) export class ReportsModule {}
