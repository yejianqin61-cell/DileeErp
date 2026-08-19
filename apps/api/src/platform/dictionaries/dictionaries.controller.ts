import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { CurrentUser } from "../audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../auth/auth.service";
import { AuthenticationGuard } from "../authorization/authentication.guard";
import { ModulePermissionGuard } from "../authorization/module-permission.guard";
import { RequireAdministrator } from "../authorization/require-administrator.decorator";
import { DictionariesService } from "./dictionaries.service";

class CreateTypeDto { @IsString() @MaxLength(80) key!: string; @IsString() @MaxLength(100) name!: string; }
class CreateItemDto { @IsString() @MaxLength(80) key!: string; @IsString() @MaxLength(100) label!: string; @IsOptional() @IsInt() @Min(0) sort_order?: number; }
class UpdateItemDto { @IsOptional() @IsString() @MaxLength(100) label?: string; @IsOptional() @IsInt() @Min(0) sort_order?: number; @IsOptional() @IsBoolean() is_active?: boolean; }

@Controller("dictionaries")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
export class DictionariesController {
  constructor(private readonly dictionaries: DictionariesService) {}
  @Get("types") async listTypes() { return { data: await this.dictionaries.listTypes(), meta: {} }; }
  @Post("types") @RequireAdministrator() async createType(@Body() input: CreateTypeDto, @CurrentUser() user: CurrentUserType) { return { data: await this.dictionaries.createType(input, user), meta: {} }; }
  @Get(":typeKey/items") async listItems(@Param("typeKey") typeKey: string, @Query("include_inactive") includeInactive?: string) { return { data: await this.dictionaries.listItems(typeKey, includeInactive === "true"), meta: {} }; }
  @Post(":typeKey/items") @RequireAdministrator() async createItem(@Param("typeKey") typeKey: string, @Body() input: CreateItemDto, @CurrentUser() user: CurrentUserType) { return { data: await this.dictionaries.createItem(typeKey, input, user), meta: {} }; }
  @Patch("items/:id") @RequireAdministrator() async updateItem(@Param("id") id: string, @Body() input: UpdateItemDto, @CurrentUser() user: CurrentUserType) { return { data: await this.dictionaries.updateItem(id, input, user), meta: {} }; }
  @Delete("items/:id") @RequireAdministrator() async deleteItem(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.dictionaries.deleteItem(id, user), meta: {} }; }
}
