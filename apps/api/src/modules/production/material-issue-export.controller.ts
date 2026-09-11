import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { Response } from "express";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAdministrator } from "../../platform/authorization/require-administrator.decorator";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { MaterialIssueExportService } from "./material-issue-export.service";

class SingleIssueExportDto {
  @IsUUID() movement_id!: string;
}
class BatchIssueExportDto {
  @IsOptional() @IsString() @MaxLength(100) order_no?: string;
  @IsOptional() @IsUUID() production_order_id?: string;
  @IsOptional() @IsUUID() production_order_operation_id?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(["draft", "posted"]) status?: string;
}

// 领料单导出与现有生产导出保持一致：production 模块 + 仅管理员。
@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("production")
export class MaterialIssueExportController {
  constructor(private readonly exports: MaterialIssueExportService) {}

  @Get("production/reports/material-issue.xlsx")
  @RequireAdministrator()
  async single(@Query() query: SingleIssueExportDto, @Res() response: Response) {
    const body = await this.exports.exportIssue(query.movement_id);
    return this.send(response, body, "迪礼ERP-领料单.xlsx");
  }

  @Get("production/reports/material-issues.xlsx")
  @RequireAdministrator()
  async batch(@Query() query: BatchIssueExportDto, @Res() response: Response) {
    const result = await this.exports.exportIssues(query);
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return this.send(response, result.buffer, `迪礼ERP-领料单汇总-${stamp}-${result.count}张.xlsx`);
  }

  private send(response: Response, body: Buffer, fileName: string) {
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(body);
  }
}
