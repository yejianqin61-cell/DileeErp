import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { ProcurementMasterDataController } from "./procurement-master-data.controller";
import { ProcurementMasterDataService } from "./procurement-master-data.service";
import { PurchaseOrdersController } from "./purchase-orders.controller";
import { PurchaseOrdersService } from "./purchase-orders.service";
import { IncomingInspectionsController } from "./incoming-inspections.controller";
import { IncomingInspectionsService } from "./incoming-inspections.service";

@Module({ imports: [AuditModule], controllers: [ProcurementMasterDataController, PurchaseOrdersController, IncomingInspectionsController], providers: [ProcurementMasterDataService, PurchaseOrdersService, IncomingInspectionsService], exports: [ProcurementMasterDataService, PurchaseOrdersService, IncomingInspectionsService] })
export class ProcurementModule {}
