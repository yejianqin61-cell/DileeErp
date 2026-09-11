import { Controller, Get, UseGuards } from "@nestjs/common";
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
}
