import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { AlertsController } from "./alerts.controller";
import { AlertsService } from "./alerts.service";
@Module({ imports: [AuditModule], controllers: [AlertsController], providers: [AlertsService] }) export class AlertsModule {}
