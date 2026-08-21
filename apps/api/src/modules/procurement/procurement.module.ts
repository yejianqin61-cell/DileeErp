import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { ProcurementMasterDataController } from "./procurement-master-data.controller";
import { ProcurementMasterDataService } from "./procurement-master-data.service";
import { PurchaseOrdersController } from "./purchase-orders.controller";
import { PurchaseOrdersService } from "./purchase-orders.service";

@Module({ imports: [AuditModule], controllers: [ProcurementMasterDataController, PurchaseOrdersController], providers: [ProcurementMasterDataService, PurchaseOrdersService], exports: [ProcurementMasterDataService, PurchaseOrdersService] })
export class ProcurementModule {}
