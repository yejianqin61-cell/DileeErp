import { Module } from "@nestjs/common";
import { AuditModule } from "../../platform/audit/audit.module";
import { ProductionMasterDataController } from "./production-master-data.controller";
import { ProductionMasterDataService } from "./production-master-data.service";

@Module({ imports: [AuditModule], controllers: [ProductionMasterDataController], providers: [ProductionMasterDataService], exports: [ProductionMasterDataService] })
export class ProductionModule {}
