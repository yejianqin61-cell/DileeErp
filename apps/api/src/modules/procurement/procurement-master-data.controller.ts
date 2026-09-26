import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { IsBoolean, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { Express, Response } from "express";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { EmptyStringToUndefined } from "../../platform/http/empty-string-to-undefined.decorator";
import { MAX_MATERIAL_IMAGE_BYTES } from "./material-image";
import { ProcurementMasterDataService } from "./procurement-master-data.service";

/** 与「库存盘点导入」「其他应付导入」「花名册导入」同一套白名单：只放行 Excel。 */
const EXCEL_MIME = new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"]);
function materialImportFileFilter(_req: Express.Request, file: Express.Multer.File, callback: (error: Error | null, acceptFile: boolean) => void) {
  const name = (file.originalname ?? "").toLowerCase();
  const extensionOk = name.endsWith(".xlsx") || name.endsWith(".xls");
  callback(null, extensionOk || (EXCEL_MIME.has(file.mimetype) && file.mimetype !== "application/octet-stream"));
}

/**
 * 物料图片的外圈白名单：只放行 `.webp` / `image/webp`。
 *
 * 前端的 canvas 一定会产出 `image/webp`，所以这里放行 `.webp` 与 `image/webp` 两种写法就够了。
 * 「内容是不是真 WebP」由服务层的 `validateMaterialImage` 判 —— 白名单只看得到名字，
 * 而名字是客户端随便写的（这一层只负责把「明显不是图片的 PDF/Excel」挡在解析之前）。
 */
function materialImageFileFilter(_req: Express.Request, file: Express.Multer.File, callback: (error: Error | null, acceptFile: boolean) => void) {
  const name = (file.originalname ?? "").toLowerCase();
  callback(null, name.endsWith(".webp") || file.mimetype === "image/webp");
}

class ActiveDto { @IsBoolean() is_active!: boolean; }
class UnitDto { @IsString() @MaxLength(30) name!: string; @IsOptional() @IsString() @MaxLength(500) remark?: string; }
export class MaterialDto { @IsOptional() @IsString() @MaxLength(80) material_code?: string; @IsOptional() @IsIn(["auto", "manual"]) code_mode?: string; @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(200) name!: string; @IsOptional() @IsString() @MaxLength(200) specification_model?: string; @IsOptional() @IsString() @MaxLength(100) color?: string; @IsUUID() default_unit_id!: string; @IsOptional() @IsString() @MaxLength(30) material_type?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }
export class SupplierDto { @IsOptional() @IsString() @MaxLength(80) supplier_code?: string; @IsOptional() @IsIn(["auto", "manual"]) code_mode?: string; @IsString() @MaxLength(200) name!: string; @IsOptional() @IsString() @MaxLength(100) contact_name?: string; @IsOptional() @IsString() @MaxLength(50) phone?: string; @IsOptional() @IsString() @MaxLength(300) address?: string; @IsOptional() @IsObject() settlement_info?: Record<string, unknown>; @IsOptional() @IsString() @MaxLength(1000) remark?: string; }

// PATCH DTOs: only modifiable keys are declared (all optional), so the global
// ValidationPipe whitelist/forbidNonWhitelisted rejects audit/state columns such
// as createdAt/updatedAt/createdBy/updatedBy/deletedAt/deletedBy/isActive.
class UpdateUnitDto { @IsOptional() @IsString() @MaxLength(30) name?: string; @IsOptional() @IsString() @MaxLength(500) remark?: string | null; }
export class UpdateMaterialDto { @IsOptional() @IsString() @MaxLength(80) material_code?: string; @IsOptional() @IsString() @MaxLength(200) name?: string; @IsOptional() @IsString() @MaxLength(200) specification_model?: string | null; @IsOptional() @IsString() @MaxLength(100) color?: string | null; @IsOptional() @IsUUID() default_unit_id?: string; @IsOptional() @IsString() @MaxLength(30) material_type?: string; @IsOptional() @IsString() @MaxLength(1000) remark?: string | null; }
class UpdateSupplierDto { @IsOptional() @IsString() @MaxLength(80) supplier_code?: string; @IsOptional() @IsString() @MaxLength(200) name?: string; @IsOptional() @IsString() @MaxLength(100) contact_name?: string | null; @IsOptional() @IsString() @MaxLength(50) phone?: string | null; @IsOptional() @IsString() @MaxLength(300) address?: string | null; @IsOptional() @IsObject() settlement_info?: Record<string, unknown>; @IsOptional() @IsString() @MaxLength(1000) remark?: string | null; }

@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("procurement")
export class ProcurementMasterDataController {
  constructor(private readonly data: ProcurementMasterDataService) {}
  // GET /units 与 GET /materials 已移到 MasterDataReadController（仓库/生产/销售也要读，见该文件说明）。
  @Post("units") async createUnit(@Body() body: UnitDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.createUnit(body, user), meta: {} }; }
  @Patch("units/:id") async updateUnit(@Param("id") id: string, @Body() body: UpdateUnitDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.updateUnit(id, body, user), meta: {} }; }
  @Patch("units/:id/active") async activeUnit(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.setUnitActive(id, body.is_active, user), meta: {} }; }
  @Delete("units/:id") async deleteUnit(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.data.deleteUnit(id, user), meta: {} }; }
  // D8: restore a soft-deleted unit (deletedAt cleared, isActive back to true).
  @Post("units/:id/restore") async restoreUnit(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.data.restoreUnit(id, user), meta: {} }; }
  @Post("materials") async createMaterial(@Body() body: MaterialDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.createMaterial(body, user), meta: {} }; }
  /**
   * 物料清单批量导入（用户 2026-09-20）：下载模板 → 填写 → 上传 → 看逐行结果。
   *
   * ⚠️ `materials/import-template.xlsx` 与 `materials/import` 都**必须排在任何 `materials/:id` 之前**：
   * Nest 按声明顺序匹配，单段静态路径会被 `:id` 当成一个 id 吃掉（`payable-entries/import-template.xlsx`
   * 与 `stocktakes/import-template.xlsx` 都踩过同一个坑）。本控制器的 :id 路由都在下面，这里天然安全，
   * 但把导入放在一起是为了让下一个加 `@Get("materials/:id")` 的人一眼看到顺序是有意为之。
   *
   * 权限**只要 procurement 模块**，不额外要求管理员：批量只是「新建物料」的批量入口，
   * 与 `POST /materials` 同一档权限（与盘点导入同样只要求模块权限，理由一致）。
   */
  @Get("materials/import-template.xlsx")
  async materialImportTemplate(@Res() response: Response) {
    const body = this.data.materialTemplate();
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-物料清单导入模板.xlsx")}`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(body);
  }
  @Post("materials/import")
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: materialImportFileFilter }))
  async importMaterials(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: CurrentUserType) {
    return { data: await this.data.importMaterials(file, user), meta: {} };
  }
  @Patch("materials/:id") async updateMaterial(@Param("id") id: string, @Body() body: UpdateMaterialDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.updateMaterial(id, body, user), meta: {} }; }
  @Patch("materials/:id/active") async activeMaterial(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.setMaterialActive(id, body.is_active, user), meta: {} }; }
  @Delete("materials/:id") async deleteMaterial(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.data.deleteMaterial(id, user), meta: {} }; }
  /**
   * 上传 / 替换物料图片（用户 2026-09-24：「要给物料配上图片。图片上传之后要压缩成 webp 再存进数据库里」）。
   *
   * 走 multipart（`FileInterceptor("file")`），前端先用 canvas 把选中的图压成 WebP 再传。
   * 这里的 multer 白名单只是**外圈**：它按扩展名/mimetype 挡一道，真正的判据是服务层的
   * `validateMaterialImage`（解开 RIFF 容器读真实尺寸），因为客户端的 mimetype 可以是谎话。
   *
   * `limits.fileSize` 与 `MAX_MATERIAL_IMAGE_BYTES` 对齐：超限的文件在 multer 层就被拦下，
   * 不会先读进内存再判。
   */
  @Post("materials/:id/image")
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: MAX_MATERIAL_IMAGE_BYTES }, fileFilter: materialImageFileFilter }))
  async uploadMaterialImage(@Param("id") id: string, @UploadedFile() file: Express.Multer.File, @CurrentUser() user: CurrentUserType) {
    return { data: await this.data.setMaterialImage(id, file, user), meta: {} };
  }
  @Delete("materials/:id/image") async deleteMaterialImage(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.data.clearMaterialImage(id, user), meta: {} }; }
  @Get("suppliers") async suppliers() { return { data: await this.data.listSuppliers(), meta: {} }; }
  @Post("suppliers") async createSupplier(@Body() body: SupplierDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.createSupplier(body, user), meta: {} }; }
  @Patch("suppliers/:id") async updateSupplier(@Param("id") id: string, @Body() body: UpdateSupplierDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.updateSupplier(id, body, user), meta: {} }; }
  @Patch("suppliers/:id/active") async activeSupplier(@Param("id") id: string, @Body() body: ActiveDto, @CurrentUser() user: CurrentUserType) { return { data: await this.data.setSupplierActive(id, body.is_active, user), meta: {} }; }
  @Delete("suppliers/:id") async deleteSupplier(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.data.deleteSupplier(id, user), meta: {} }; }
}
