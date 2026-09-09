import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAnyModules } from "../../platform/authorization/require-any-modules.decorator";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { RawMaterialInboundNoticesService } from "./raw-material-inbound-notices.service";

class CreateNoticeDto { @IsUUID() inspection_id!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }

@Controller("raw-material-inbound-notices")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
export class RawMaterialInboundNoticesController {
  constructor(private readonly notices: RawMaterialInboundNoticesService) {}

  @Get()
  @RequireAnyModules("procurement", "warehouse")
  async list(@Query("status") status?: string, @Query("order_no") orderNo?: string) {
    return { data: await this.notices.list(status, orderNo), meta: {} };
  }

  @Get(":id")
  @RequireAnyModules("procurement", "warehouse")
  async get(@Param("id") id: string) {
    return { data: await this.notices.get(id), meta: {} };
  }

  @Post()
  @RequireModules("procurement")
  async create(@Body() body: CreateNoticeDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.notices.createFromInspection(body.inspection_id, body.remark, user), meta: {} };
  }

  @Patch(":id/acknowledge")
  @RequireModules("warehouse")
  async acknowledge(@Param("id") id: string, @CurrentUser() user: CurrentUserType) {
    return { data: await this.notices.acknowledge(id, user), meta: {} };
  }
}
