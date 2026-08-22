import { Module } from "@nestjs/common";
import { OrderWorkbenchController } from "./order-workbench.controller";
import { OrderWorkbenchService } from "./order-workbench.service";

@Module({ controllers: [OrderWorkbenchController], providers: [OrderWorkbenchService] })
export class OrderWorkbenchModule {}
