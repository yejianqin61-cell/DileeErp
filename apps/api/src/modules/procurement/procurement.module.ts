import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { ProcurementMasterDataController } from "./procurement-master-data.controller";
import { MasterDataReadController } from "./master-data-read.controller";
import { ProcurementMasterDataService } from "./procurement-master-data.service";
import { PurchaseOrdersController } from "./purchase-orders.controller";
import { PurchaseOrdersService } from "./purchase-orders.service";
import { IncomingInspectionsController } from "./incoming-inspections.controller";
import { IncomingInspectionsService } from "./incoming-inspections.service";
import { RawMaterialInboundsController } from "./raw-material-inbounds.controller";
import { RawMaterialInboundsService } from "./raw-material-inbounds.service";
import { RawMaterialInboundNoticesController } from "./raw-material-inbound-notices.controller";
import { RawMaterialInboundNoticesService } from "./raw-material-inbound-notices.service";
import { BomsController } from "../sales/boms.controller";
import { BomsService } from "../sales/boms.service";
import { PurchaseOrderExportController } from "./purchase-order-export.controller";
import { PurchaseOrderExportService } from "./purchase-order-export.service";

@Module({ imports: [AuditModule], controllers: [ProcurementMasterDataController, MasterDataReadController, PurchaseOrdersController, IncomingInspectionsController, RawMaterialInboundsController, RawMaterialInboundNoticesController, BomsController, PurchaseOrderExportController], providers: [ProcurementMasterDataService, PurchaseOrdersService, IncomingInspectionsService, RawMaterialInboundsService, RawMaterialInboundNoticesService, BomsService, PurchaseOrderExportService], exports: [ProcurementMasterDataService, PurchaseOrdersService, IncomingInspectionsService, RawMaterialInboundsService, RawMaterialInboundNoticesService, BomsService, PurchaseOrderExportService] })
export class ProcurementModule {}
