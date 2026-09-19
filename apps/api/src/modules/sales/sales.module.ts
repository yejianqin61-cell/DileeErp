import { Module } from "@nestjs/common";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { SalesOrdersController } from "./sales-orders.controller";
import { SalesOrdersService } from "./sales-orders.service";
import { FinishedGoodsOutboundNoticeService } from "./finished-goods-outbound-notice.service";
import { SalesOrderExportService } from "./sales-order-export.service";
import { AuditModule } from "../../platform/audit/audit.module";

// PrismaService / InventoryService 由 @Global 模块提供，这里只需注入即可。
@Module({ imports: [AuditModule], controllers: [CustomersController, SalesOrdersController], providers: [CustomersService, SalesOrdersService, FinishedGoodsOutboundNoticeService, SalesOrderExportService], exports: [CustomersService, SalesOrdersService, FinishedGoodsOutboundNoticeService, SalesOrderExportService] })
export class SalesModule {}
