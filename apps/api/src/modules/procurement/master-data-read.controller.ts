import { Controller, Get, NotFoundException, Param, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireAnyModules } from "../../platform/authorization/require-any-modules.decorator";
import { ProcurementMasterDataService } from "./procurement-master-data.service";

/**
 * 单位与物料主数据的**只读**接口。
 *
 * 为什么单独一个 controller：仓库页、生产页、销售页都要读 /materials 与 /units
 * （仓库要按物料建领料单、原料仓储要显示单位、生产要解析生产单位、销售要选单位），
 * 而 ProcurementMasterDataController 是类级 @RequireModules("procurement")。
 * 权限守卫先校验类级 MODULES、再校验 ANY，方法级 @RequireAnyModules 无法覆盖类级声明，
 * 因此必须把这些读取端点放在只声明 ANY 的控制器里，否则仅有 warehouse/production 权限的
 * 角色打开仓库页会因 /materials 403 导致整个 Promise.all 失败 —— 页面全空，
 * 连带「待入库通知」也看不到。
 *
 * 写入（新增/修改/停用/删除）仍然只保留在 ProcurementMasterDataController（procurement）。
 */
@Controller()
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireAnyModules("procurement", "warehouse", "production", "sales")
export class MasterDataReadController {
  constructor(private readonly data: ProcurementMasterDataService) {}

  @Get("units")
  async units() {
    return { data: await this.data.listUnits(), meta: {} };
  }

  @Get("materials")
  async materials() {
    return { data: await this.data.listMaterials(), meta: {} };
  }

  /**
   * 物料图片（用户 2026-09-24：「要给物料配上图片」）。
   *
   * **为什么必须挂在只声明 ANY 的控制器上**（而不是写入侧的 ProcurementMasterDataController）：
   * 销售页在编辑销售单时要显示每个部件的物料图片，而销售角色没有 procurement 权限 ——
   * 放在类级 `@RequireModules("procurement")` 的控制器里，销售看到的就是一整排 403 破图。
   * 理由与 `/materials` 本身完全一样（见本文件顶部说明）。
   *
   * 缓存：`ETag` 用内容的 sha256，配 `must-revalidate`。图片是按物料**换**的（换图 = 换 sha），
   * 所以「校验一次、内容没变就 304」既省流量又不会拿到旧图；`Cache-Control` 不写 `no-store`
   * 是因为图片不敏感、但也不想让浏览器长期缓存一个可能被替换的资源。
   */
  @Get("materials/:id/image")
  async materialImage(@Param("id") id: string, @Req() request: Request, @Res() response: Response) {
    const image = await this.data.materialImage(id);
    if (!image) throw new NotFoundException({ code: "MATERIAL_IMAGE_NOT_FOUND", message: "该物料没有图片", details: [] });
    const etag = `"${image.sha256}"`;
    response.setHeader("Content-Type", image.mimeType);
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(image.fileName)}`);
    // 304 时**不能**带 body：Express 的 send 会把 body 一起写出去，浏览器拿到就不认这个 304 了。
    if (request.headers["if-none-match"] === etag) { response.status(304).end(); return; }
    return response.send(image.data);
  }
}
