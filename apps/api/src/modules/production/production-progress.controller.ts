import { Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsOptional, IsString, Max, Min, IsInt } from "class-validator";
import { Type } from "class-transformer";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAdministrator } from "../../platform/authorization/require-administrator.decorator";
import { RequireAnyModules } from "../../platform/authorization/require-any-modules.decorator";
import { ProductionProgressService } from "./production-progress.service";

class ProgressQueryDto {
  @IsOptional() @IsString() order_no?: string;
  @IsOptional() @IsString() production_order_id?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) page_size = 20;
}

@Controller("production-progress")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
export class ProductionProgressController {
  constructor(private readonly progress: ProductionProgressService) {}

  @Get("measurements") @RequireAnyModules("production", "finance", "hr") async measurements(@Query() query: ProgressQueryDto) { const result = await this.progress.listMeasurements(query); return { data: result.data, meta: { page: query.page, page_size: query.page_size, total: result.total } }; }
  @Get("order-statuses") @RequireAnyModules("production", "sales", "finance", "hr") async orderStatuses(@Query() query: ProgressQueryDto) { const result = await this.progress.listOrderStatuses(query); return { data: result.data, meta: { page: query.page, page_size: query.page_size, total: result.total } }; }
  @Get("order-statuses/:orderNo/timeline") @RequireAnyModules("production", "sales", "finance", "hr") async timeline(@Param("orderNo") orderNo: string) { return { data: await this.progress.timeline(orderNo), meta: {} }; }
  @Post("rebuild") @RequireAdministrator() async rebuild(@Query() query: ProgressQueryDto) { return { data: await this.progress.rebuild(query), meta: {} }; }
}
