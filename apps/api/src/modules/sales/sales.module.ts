import { Module } from "@nestjs/common";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { SalesOrdersController } from "./sales-orders.controller";
import { SalesOrdersService } from "./sales-orders.service";
import { AuditModule } from "../../platform/audit/audit.module";

@Module({ imports: [AuditModule], controllers: [CustomersController, SalesOrdersController], providers: [CustomersService, SalesOrdersService], exports: [CustomersService, SalesOrdersService] })
export class SalesModule {}
