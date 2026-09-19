import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { IsDecimal, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import type { Express, Response } from "express";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { EmptyStringToUndefined } from "../../platform/http/empty-string-to-undefined.decorator";
import { StocktakeService } from "./stocktake.service";

const NON_NEGATIVE_DECIMAL = /^\d+(?:\.\d+)?$/;
/** 盘点月份：YYYY-MM。用户口径是「每月一次」，月份是这张单子的归档维度。 */
const PERIOD_MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
/** 与「其他应付导入」「花名册导入」同一套白名单：只放行 Excel。 */
const EXCEL_MIME = new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"]);
function stocktakeImportFileFilter(_req: Express.Request, file: Express.Multer.File, callback: (error: Error | null, acceptFile: boolean) => void) {
  const name = (file.originalname ?? "").toLowerCase();
  const extensionOk = name.endsWith(".xlsx") || name.endsWith(".xls");
  callback(null, extensionOk || (EXCEL_MIME.has(file.mimetype) && file.mimetype !== "application/octet-stream"));
}

export class StocktakeImportDto {
  @IsNotEmpty() @Matches(PERIOD_MONTH, { message: "盘点月份必须是 YYYY-MM 格式（例如 2026-09）" }) period_month!: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
}

/**
 * 盘点明细行的可改字段。
 *
 * `actual_quantity` 允许 0，但**不接受空串**（`EmptyStringToUndefined` 后等同没传 = 不改）：
 * 「盘点后没有库存」要用 0 表达，用空串表达不出这个意思，静默当 0 会凭空盘亏一整行。
 */
export class StocktakeLineDto {
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "实际数量必须是不小于 0 的十进制数" }) @IsDecimal() actual_quantity?: string;
  @IsOptional() @IsString() @MaxLength(1000) difference_reason?: string | null;
}

class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }

/**
 * 库存盘点（仓库模块）。
 *
 * ⚠️ `import-template.xlsx` **必须排在 `:id` 之前**：Nest 按声明顺序匹配，单段静态路径
 * 会被 `:id` 当成一个 id 吃掉（`payable-entries/import-template.xlsx` 踩过同一个坑）。
 */
@Controller("stocktakes")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("warehouse")
export class StocktakeController {
  constructor(private readonly stocktakes: StocktakeService) {}

  @Get() async list(@Query("period_month") periodMonth?: string) { return { data: await this.stocktakes.list(periodMonth), meta: {} }; }

  @Get("import-template.xlsx")
  template(@Res() response: Response) {
    const body = this.stocktakes.template();
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-库存盘点导入模板.xlsx")}`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(body);
  }

  /**
   * 导入盘点表：生成一张盘点草稿单。
   *
   * 只用 warehouse 模块权限，不额外要求管理员 —— 与页面上的「下载模板 / 确认盘点」同一档权限
   * （批量只是同一件事的批量入口，不该变成另一档权限）。
   */
  @Post("import")
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: stocktakeImportFileFilter }))
  async import(@UploadedFile() file: Express.Multer.File, @Body() body: StocktakeImportDto, @CurrentUser() user: CurrentUserType) {
    return { data: await this.stocktakes.import(file, body, user), meta: {} };
  }

  @Get(":id") async get(@Param("id") id: string) { return { data: await this.stocktakes.get(id), meta: {} }; }
  @Post(":id/confirm") async confirm(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.stocktakes.confirm(id, user), meta: {} }; }
  @Post(":id/reverse") async reverse(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.stocktakes.reverse(id, body.reason, user), meta: {} }; }
  @Delete(":id") async remove(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.stocktakes.remove(id, user), meta: {} }; }

  @Patch("lines/:id") async updateLine(@Param("id") id: string, @Body() body: StocktakeLineDto, @CurrentUser() user: CurrentUserType) { return { data: await this.stocktakes.updateLine(id, body, user), meta: {} }; }
  @Delete("lines/:id") async removeLine(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.stocktakes.removeLine(id, user), meta: {} }; }
}
