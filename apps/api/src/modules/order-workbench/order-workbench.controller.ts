import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAnyModules } from "../../platform/authorization/require-any-modules.decorator";
import { OrderWorkbenchService } from "./order-workbench.service";

class WorkbenchQueryDto { @IsOptional() @IsString() order_no?: string; @IsOptional() @IsString() customer_id?: string; @IsOptional() @IsString() status?: string; @IsOptional() @IsIn(["true", "false"]) has_blockers?: string; @IsOptional() @IsDateString() from?: string; @IsOptional() @IsDateString() to?: string; @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1; @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) page_size = 20; }

@Controller("order-workbench")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireAnyModules("sales", "procurement", "production", "warehouse", "finance", "hr")
export class OrderWorkbenchController {
  constructor(private readonly service: OrderWorkbenchService) {}
  @Get("orders") async list(@Query() query: WorkbenchQueryDto) { const result = await this.service.list(query); return { data: result.data, meta: { page: query.page, page_size: query.page_size, total: result.total } }; }
  @Get("orders/:order_no") async detail(@Param("order_no") orderNo: string) { return { data: await this.service.detail(orderNo), meta: {} }; }
  @Get("orders/:order_no/timeline") async timeline(@Param("order_no") orderNo: string) { return { data: await this.service.timeline(orderNo), meta: {} }; }
}
