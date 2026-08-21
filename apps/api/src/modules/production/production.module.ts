import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { ProductionMasterDataController } from "./production-master-data.controller";
import { ProductionMasterDataService } from "./production-master-data.service";
import { ProductionOrdersController } from "./production-orders.controller";
import { ProductionOrdersService } from "./production-orders.service";
import { RawMaterialMovementsController } from "./raw-material-movements.controller";
import { RawMaterialMovementsService } from "./raw-material-movements.service";

@Module({ imports: [AuditModule], controllers: [ProductionMasterDataController, ProductionOrdersController, RawMaterialMovementsController], providers: [ProductionMasterDataService, ProductionOrdersService, RawMaterialMovementsService], exports: [ProductionMasterDataService, ProductionOrdersService, RawMaterialMovementsService] })
export class ProductionModule {}
