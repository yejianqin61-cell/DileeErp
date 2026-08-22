import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { ProductionMasterDataController } from "./production-master-data.controller";
import { ProductionMasterDataService } from "./production-master-data.service";
import { ProductionOrdersController } from "./production-orders.controller";
import { ProductionOrdersService } from "./production-orders.service";
import { RawMaterialMovementsController } from "./raw-material-movements.controller";
import { RawMaterialMovementsService } from "./raw-material-movements.service";
import { OperationDailyReportsController } from "./operation-daily-reports.controller";
import { OperationDailyReportsService } from "./operation-daily-reports.service";
import { EmployeeDailyReportsController } from "./employee-daily-reports.controller";
import { EmployeeDailyReportsService } from "./employee-daily-reports.service";
import { ProductionDailyAlertsController } from "./production-daily-alerts.controller";
import { ProductionDailyAlertsService } from "./production-daily-alerts.service";
import { OutsourceLogisticsController } from "./outsource-logistics.controller";
import { OutsourceLogisticsService } from "./outsource-logistics.service";

@Module({ imports: [AuditModule], controllers: [ProductionMasterDataController, ProductionOrdersController, RawMaterialMovementsController, OperationDailyReportsController, EmployeeDailyReportsController, ProductionDailyAlertsController, OutsourceLogisticsController], providers: [ProductionMasterDataService, ProductionOrdersService, RawMaterialMovementsService, OperationDailyReportsService, EmployeeDailyReportsService, ProductionDailyAlertsService, OutsourceLogisticsService], exports: [ProductionMasterDataService, ProductionOrdersService, RawMaterialMovementsService, OperationDailyReportsService, EmployeeDailyReportsService, ProductionDailyAlertsService, OutsourceLogisticsService] })
export class ProductionModule {}
