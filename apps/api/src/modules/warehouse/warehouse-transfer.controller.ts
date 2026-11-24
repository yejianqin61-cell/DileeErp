import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { WAREHOUSE_TRANSFER_MAX_LINES, WAREHOUSE_TRANSFER_PURPOSE, WAREHOUSE_TRANSFER_TARGET_CODES } from "./warehouse-transfer.domain";
import { WarehouseTransferService } from "./warehouse-transfer.service";

/** 与 parseQuantity 同一条边界：正整数部分最多 14 位、小数最多 4 位。 */
const TRANSFER_QUANTITY = /^\d+(?:\.\d{1,4})?$/;

class WarehouseTransferLineDto {
  @IsUUID() material_id!: string;
  @IsString() @Matches(TRANSFER_QUANTITY, { message: "调拨数量必须是大于零、最多 4 位小数的十进制数" }) quantity!: string;
}

class CreateWarehouseTransferDto {
  /** 源仓库固定同安仓；仍保留字段用于老客户端显式确认，传别的值直接拒绝。 */
  @IsOptional() @IsString() @MaxLength(30) source_warehouse?: string;
  @IsIn([...WAREHOUSE_TRANSFER_TARGET_CODES], { message: "目标仓库只能是晋江仓或大田仓" }) target_warehouse!: string;
  @IsOptional() @IsIn([WAREHOUSE_TRANSFER_PURPOSE], { message: "调拨目的固定为供目标仓库生产使用" }) purpose?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
  @IsOptional() @IsString() @MaxLength(200) idempotency_key?: string;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(WAREHOUSE_TRANSFER_MAX_LINES) @ValidateNested({ each: true }) @Type(() => WarehouseTransferLineDto) lines!: WarehouseTransferLineDto[];
}

/**
 * 跨仓库调拨（仓库模块）。
 *
 * 仓库模块历史上没有自己的 module，控制器统一挂在 `ProductionModule`（见其注释与
 * `StocktakeController` 的先例），本控制器同样在那里注册。
 */
@Controller("warehouse-transfers")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("warehouse")
export class WarehouseTransferController {
  constructor(private readonly transfers: WarehouseTransferService) {}

  @Get() async list(@Query("target_warehouse") targetWarehouse?: string, @Query("limit") limit?: string) {
    return { data: await this.transfers.list({ targetWarehouse, limit: limit ? Number(limit) : undefined }), meta: {} };
  }

  /** 按仓库汇总原料库存：同安 / 大田 / 晋江三列。 */
  @Get("balances") async balances(@Query("material_id") materialId?: string) {
    return { data: await this.transfers.balances(materialId), meta: {} };
  }

  @Post() async create(@Body() body: CreateWarehouseTransferDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.transfers.create(body, user), meta: {} };
  }
}
