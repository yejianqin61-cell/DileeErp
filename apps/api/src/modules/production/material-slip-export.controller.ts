import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { Response } from "express";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAdministrator } from "../../platform/authorization/require-administrator.decorator";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { MaterialSlipExportService } from "./material-slip-export.service";

class SingleSlipExportDto {
  @IsUUID() movement_id!: string;
}
class BatchSlipExportDto {
  @IsOptional() @IsIn(["issue", "replenishment"]) document_type?: string;
  @IsOptional() @IsString() @MaxLength(100) order_no?: string;
  @IsOptional() @IsUUID() production_order_id?: string;
  @IsOptional() @IsUUID() production_order_operation_id?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(["draft", "posted"]) status?: string;
}

// 领料单/补料单导出：与现有生产导出一致（production 模块 + 仅管理员）。
@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class MaterialSlipExportController {
  constructor(private readonly exports: MaterialSlipExportService) {}

  /** 单张导出：按单据类型自动套用领料单/补料单模板。 */
  @Get("production/reports/material-issue.xlsx")
  @RequireAdministrator()
  async single(@Query() query: SingleSlipExportDto, @Res() response: Response) {
    const body = await this.exports.exportSlip(query.movement_id);
    return this.send(response, body, "迪礼ERP-领料单.xlsx");
  }

  /** 批量导出：每张单据一个工作表；document_type 省略时同时导出领料单与补料单（各自版式）。 */
  @Get("production/reports/material-slips.xlsx")
  @RequireAdministrator()
  async batch(@Query() query: BatchSlipExportDto, @Res() response: Response) {
    const result = await this.exports.exportSlips(query);
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return this.send(response, result.buffer, `迪礼ERP-领料补料单汇总-${stamp}-${result.count}张.xlsx`);
  }

  private send(response: Response, body: Buffer, fileName: string) {
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(body);
  }
}
