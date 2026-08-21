import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { IsBoolean, IsObject, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { ProcurementMasterDataService } from "./procurement-master-data.service";

class ActiveDto { @IsBoolean() is_active!: boolean; }
class UnitDto { @IsString() @MaxLength(30) name!: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }
class MaterialDto { @IsString() @MaxLength(80) material_code!: string; @IsString() @MaxLength(200) name!: string; @IsUUID() default_unit_id!: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
class SupplierDto { @IsString() @MaxLength(80) supplier_code!: string; @IsString() @MaxLength(200) name!: string; @IsOptional() @IsString() @MaxLength(100) contact_name?: string; @IsOptional() @IsString() @MaxLength(50) phone?: string; @IsOptional() @IsObject() settlement_info?: Record<string, unknown>; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }

@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("procurement")
export class ProcurementMasterDataController {
  constructor(private readonly data: ProcurementMasterDataService) {}
  @Get("units") async units() { return { data: await this.data.listUnits(), meta: {} }; }
  @Post("units") async createUnit(@Body() body: UnitDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.createUnit(body, user), meta: {} }; }
  @Patch("units/:id") async updateUnit(@Param("id") id: string, @Body() body: Partial<UnitDto>, @CurrentUser() user: CurrentUserType) { return { data: await this.data.updateUnit(id, body, user), meta: {} }; }
  @Patch("units/:id/active") async activeUnit(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.setUnitActive(id, body.is_active, user), meta: {} }; }
  @Delete("units/:id") async deleteUnit(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.data.deleteUnit(id, user), meta: {} }; }
  @Get("materials") async materials() { return { data: await this.data.listMaterials(), meta: {} }; }
  @Post("materials") async createMaterial(@Body() body: MaterialDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.createMaterial(body, user), meta: {} }; }
  @Patch("materials/:id") async updateMaterial(@Param("id") id: string, @Body() body: Partial<MaterialDto>, @CurrentUser() user: CurrentUserType) { return { data: await this.data.updateMaterial(id, body, user), meta: {} }; }
  @Patch("materials/:id/active") async activeMaterial(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.setMaterialActive(id, body.is_active, user), meta: {} }; }
  @Delete("materials/:id") async deleteMaterial(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.data.deleteMaterial(id, user), meta: {} }; }
  @Get("suppliers") async suppliers() { return { data: await this.data.listSuppliers(), meta: {} }; }
  @Post("suppliers") async createSupplier(@Body() body: SupplierDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.createSupplier(body, user), meta: {} }; }
  @Patch("suppliers/:id") async updateSupplier(@Param("id") id: string, @Body() body: Partial<SupplierDto>, @CurrentUser() user: CurrentUserType) { return { data: await this.data.updateSupplier(id, body, user), meta: {} }; }
  @Patch("suppliers/:id/active") async activeSupplier(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.setSupplierActive(id, body.is_active, user), meta: {} }; }
  @Delete("suppliers/:id") async deleteSupplier(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.data.deleteSupplier(id, user), meta: {} }; }
}
