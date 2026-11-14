import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { AuthenticationGuard } from "../authorization/authentication.guard";
import { ModulePermissionGuard } from "../authorization/module-permission.guard";
import { RequireModules } from "../authorization/require-modules.decorator";
import { RequireAnyModules } from "../authorization/require-any-modules.decorator";
import { InventoryService } from "./inventory.service";

@Controller("inventory")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireAnyModules("warehouse", "procurement")
export class InventoryController {
  constructor(private readonly inventory: InventoryService, private readonly prisma: PrismaService) {}
  @Get("balances") async balances(@Query("category") category?: "finished_goods" | "defective_goods", @Query("order_no") orderNo?: string, @Query("production_order_id") productionOrderId?: string, @Query("unit_id") unitId?: string) { return { data: await this.inventory.finishedGoodsBalances({ category, orderNo, productionOrderId, unitId }), meta: {} }; }
  /**
   * 原料库存余额。
   *
   * 默认按「物料 + 单位」聚合（向下兼容，响应绝不出现 supplier_* 字段）；
   * 带上 `group_by=supplier` 时，按「物料 + 单位 + 供应商」拆分，返回 supplier_id /
   * supplier_code / supplier_name 三个字段，供前端领料时按供应商展示档位结存。
   */
  @Get("raw-material-balances") async rawMaterialBalances(@Query("material_ids") materialIds?: string, @Query("group_by") groupBy?: string) {
    const ids = (materialIds ?? "").split(",").filter(Boolean);
    if (groupBy === "supplier") {
      const buckets = await Promise.all(ids.length === 0 ? [] : ids.map(async (materialId) => {
        // 每个 material 取其 default 单位上的桶；前端若需更细粒度可再按 unit 过滤。
        const material = await this.inventory.defaultUnitOf(this.prisma, materialId);
        if (!material) return [];
        return this.inventory.rawMaterialSupplierBuckets(this.prisma, materialId, material.unit_id);
      }));
      const data = buckets.flat().map((row) => ({ ...row, quantity: row.quantity.toString() }));
      return { data, meta: {} };
    }
    return { data: await this.inventory.rawMaterialBalances(ids), meta: {} };
  }
  @Get("order-summary") async orderSummary(@Query("order_no") orderNo?: string) { if (!orderNo) return { data: [], meta: {} }; return { data: await this.inventory.finishedGoodsOrderSummary(orderNo), meta: {} }; }
}
