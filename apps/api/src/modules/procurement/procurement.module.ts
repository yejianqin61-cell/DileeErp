import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { ProcurementMasterDataController } from "./procurement-master-data.controller";
import { ProcurementMasterDataService } from "./procurement-master-data.service";
import { PurchaseOrdersController } from "./purchase-orders.controller";
import { PurchaseOrdersService } from "./purchase-orders.service";
import { IncomingInspectionsController } from "./incoming-inspections.controller";
import { IncomingInspectionsService } from "./incoming-inspections.service";
import { RawMaterialInboundsController } from "./raw-material-inbounds.controller";
import { RawMaterialInboundsService } from "./raw-material-inbounds.service";

@Module({ imports: [AuditModule], controllers: [ProcurementMasterDataController, PurchaseOrdersController, IncomingInspectionsController, RawMaterialInboundsController], providers: [ProcurementMasterDataService, PurchaseOrdersService, IncomingInspectionsService, RawMaterialInboundsService], exports: [ProcurementMasterDataService, PurchaseOrdersService, IncomingInspectionsService, RawMaterialInboundsService] })
export class ProcurementModule {}
