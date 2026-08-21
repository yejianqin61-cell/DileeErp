import { Module } from "@nestjs/common";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { SalesOrdersController } from "./sales-orders.controller";
import { SalesOrdersService } from "./sales-orders.service";
import { BomsController } from "./boms.controller";
import { BomsService } from "./boms.service";
import { AuditModule } from "../../platform/audit/audit.module";

@Module({ imports: [AuditModule], controllers: [CustomersController, SalesOrdersController, BomsController], providers: [CustomersService, SalesOrdersService, BomsService], exports: [CustomersService, SalesOrdersService, BomsService] })
export class SalesModule {}
