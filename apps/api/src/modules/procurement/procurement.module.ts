import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { ProcurementMasterDataController } from "./procurement-master-data.controller";
import { ProcurementMasterDataService } from "./procurement-master-data.service";

@Module({ imports: [AuditModule], controllers: [ProcurementMasterDataController], providers: [ProcurementMasterDataService], exports: [ProcurementMasterDataService] })
export class ProcurementModule {}
