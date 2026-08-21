import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { ProductionMasterDataController } from "./production-master-data.controller";
import { ProductionMasterDataService } from "./production-master-data.service";
import { ProductionOrdersController } from "./production-orders.controller";
import { ProductionOrdersService } from "./production-orders.service";

@Module({ imports: [AuditModule], controllers: [ProductionMasterDataController, ProductionOrdersController], providers: [ProductionMasterDataService, ProductionOrdersService], exports: [ProductionMasterDataService, ProductionOrdersService] })
export class ProductionModule {}
