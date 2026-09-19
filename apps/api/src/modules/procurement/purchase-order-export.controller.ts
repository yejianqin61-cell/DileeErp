import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { Response } from "express";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAdministrator } from "../../platform/authorization/require-administrator.decorator";
// 文件名里的时间戳也走北京时间（与文件内容里的操作时间同口径）。
import { beijingStamp } from "../../platform/time/beijing-time";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { PurchaseOrderExportService } from "./purchase-order-export.service";

class SingleOrderExportDto {
  @IsUUID() purchase_order_id!: string;
}
class BatchOrderExportDto {
  @IsOptional() @IsString() @MaxLength(100) order_no?: string;
  @IsOptional() @IsUUID() supplier_id?: string;
  @IsOptional() @IsIn(["draft", "ordered", "partially_arrived", "arrived_complete", "cancelled"]) status?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

// 采购订单导出：与生产侧导出一致（模块权限 + 仅管理员）。
@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("procurement")
export class PurchaseOrderExportController {
  constructor(private readonly exports: PurchaseOrderExportService) {}

  /** 单张导出：一个工作表，与用户给定的采购订单模板一致。 */
  @Get("procurement/reports/purchase-order.xlsx")
  @RequireAdministrator()
  async single(@Query() query: SingleOrderExportDto, @Res() response: Response) {
    const body = await this.exports.exportOrder(query.purchase_order_id);
    return this.send(response, body, "迪礼ERP-采购订单.xlsx");
  }

  /** 批量导出：每张采购单一个工作表（表名=采购单号）。 */
  @Get("procurement/reports/purchase-orders.xlsx")
  @RequireAdministrator()
  async batch(@Query() query: BatchOrderExportDto, @Res() response: Response) {
    const result = await this.exports.exportOrders(query);
    const stamp = beijingStamp();
    return this.send(response, result.buffer, `迪礼ERP-采购订单汇总-${stamp}-${result.count}张.xlsx`);
  }

  private send(response: Response, body: Buffer, fileName: string) {
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(body);
  }
}
