import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AuthenticationGuard } from "../authorization/authentication.guard";
import { ModulePermissionGuard } from "../authorization/module-permission.guard";
import { RequireModules } from "../authorization/require-modules.decorator";
import { InventoryService } from "./inventory.service";

@Controller("inventory")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("warehouse")
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}
  @Get("balances") async balances(@Query("category") category?: "finished_goods" | "defective_goods", @Query("order_no") orderNo?: string, @Query("production_order_id") productionOrderId?: string, @Query("unit_id") unitId?: string) { return { data: await this.inventory.finishedGoodsBalances({ category, orderNo, productionOrderId, unitId }), meta: {} }; }
  @Get("order-summary") async orderSummary(@Query("order_no") orderNo?: string) { if (!orderNo) return { data: [], meta: {} }; return { data: await this.inventory.finishedGoodsOrderSummary(orderNo), meta: {} }; }
}
