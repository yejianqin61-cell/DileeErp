import { Module } from "@nestjs/common";
import { FinanceModule } from "../finance/finance.module";
import { ReorderController } from "./reorder.controller";
import { ReorderExportService } from "./reorder-export.service";
import { ReorderService } from "./reorder.service";

/**
 * 「返单与总结」模块：按**货号**看历次批次与单据（工作台是按**订单号**看推进状态）。
 * 只读模块，没有写入 —— 返单建单仍在 `SalesModule`（`SalesOrdersService.create`）。
 *
 * `FinanceModule` 只为一件事：T14 的**毛利**要复用财务侧既有的「销售利润报表(毛利)」取数
 * （`FinanceReportQueryService.salesGrossProfit`），而不是在这里写第二套成本口径。
 * 先例：`HrModule` 也是这么引财务模块的。
 */
@Module({ imports: [FinanceModule], controllers: [ReorderController], providers: [ReorderService, ReorderExportService] })
export class ReorderModule {}
