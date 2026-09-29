import { Module } from "@nestjs/common";
import { ReorderController } from "./reorder.controller";
import { ReorderService } from "./reorder.service";

/**
 * 「返单与总结」模块：按**货号**看历次批次与单据（工作台是按**订单号**看推进状态）。
 * 纯读模块，没有写入 —— 返单建单仍在 `SalesModule`（`SalesOrdersService.create`）。
 */
@Module({ controllers: [ReorderController], providers: [ReorderService] })
export class ReorderModule {}
