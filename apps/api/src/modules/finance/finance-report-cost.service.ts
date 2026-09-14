import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../platform/database/prisma.service";
import { materialCostOf, unitUsagePerUnit } from "./finance-report.domain";

/**
 * 销售利润报表(毛利)的成本口径：**BOM 原料成本**（用户 R5 确认）。
 *
 * 成本金额 = Σ(单件用量 × 销售单数量 × 物料采购单价)
 *
 * 两条必须写清楚的取舍：
 *
 * 1. **只算材料成本**，不含人工（工序日报计件）、外加工费与制造费用 —— 因此本表的「销售利润」
 *    是**毛利**的上界，不是净利。表头写「销售利润」沿用老表列名，但口径就是这个。
 * 2. **缺采购价的物料按 0 计入，并在表尾显式列出**（见 `finance-report.tables.ts` 的
 *    `footnoteLines`）。不这么做的话，毛利会被高估而且从表上完全看不出来。
 */
export type OrderMaterialCost = {
  salesOrderId: string;
  /** 该销售单的 BOM 原料成本；没有 BOM 或 BOM 无明细时为 0 */
  cost: Prisma.Decimal;
  /** 是否有可用的 BOM 明细（BOM 存在但明细为空按「没有 BOM」处理） */
  hasBom: boolean;
  /** 缺采购价的物料（已按物料去重） */
  missingPrice: Array<{ materialCode: string; materialName: string }>;
};

type CostOrder = { salesOrderId: string; quantity: Prisma.Decimal | string | number | null };

@Injectable()
export class BomMaterialCostService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 批量算成本。
   *
   * 一次查完所有订单的 BOM 明细与所有相关物料的最近采购价，
   * 避免「每单一次查询」的 N+1（一张导出表可能几百个订单）。
   */
  async materialCosts(orders: readonly CostOrder[]): Promise<Map<string, OrderMaterialCost>> {
    const result = new Map<string, OrderMaterialCost>();
    const quantityOf = new Map<string, CostOrder>();
    for (const order of orders) {
      result.set(order.salesOrderId, { salesOrderId: order.salesOrderId, cost: new Prisma.Decimal(0), hasBom: false, missingPrice: [] });
      quantityOf.set(order.salesOrderId, order);
    }
    if (!orders.length) return result;

    // 一个销售单最多一张有效 BOM（库层唯一索引 `boms_sales_order_id_active_key`）。
    const boms = await this.prisma.bom.findMany({
      where: { salesOrderId: { in: [...quantityOf.keys()] }, deletedAt: null },
      select: {
        salesOrderId: true,
        items: {
          where: { deletedAt: null },
          select: {
            materialId: true,
            materialName: true,
            approvedUsage: true,
            baseUsage: true,
            requiredQuantity: true,
            productionBatchBase: true,
            material: { select: { materialCode: true, name: true } },
          },
        },
      },
    });

    const materialIds = [...new Set(boms.flatMap((bom) => bom.items.map((item) => item.materialId)))];
    const priceByMaterial = await this.latestPurchasePrices(materialIds);

    for (const bom of boms) {
      const target = result.get(bom.salesOrderId);
      if (!target || !bom.items.length) continue;
      target.hasBom = true;
      const quantity = quantityOf.get(bom.salesOrderId)?.quantity ?? null;
      const missing = new Map<string, { materialCode: string; materialName: string }>();
      for (const item of bom.items) {
        const price = priceByMaterial.get(item.materialId);
        if (!price) {
          // 缺价：记进清单，不静默按 0 算完就算了。
          const materialCode = item.material?.materialCode ?? "";
          const materialName = item.material?.name ?? item.materialName;
          missing.set(`${materialCode}|${materialName}`, { materialCode, materialName });
          continue;
        }
        const cost = materialCostOf(unitUsagePerUnit(item), quantity, price);
        if (cost) target.cost = target.cost.plus(cost);
      }
      target.missingPrice = [...missing.values()];
    }

    return result;
  }

  /**
   * 每个物料的「最近一次有效采购单价」。
   *
   * - 取 `purchase_order_items.unit_price`（**含税价**，与 R3 的口径一致）；
   * - 只排除已取消的采购单（草稿采购单的报价也算报价：新物料常常只有草稿单上有价）；
   * - 「最近」按 `采购日期 ?? 采购单创建时间` 取最大 —— 采购日期可空，
   *   直接 `order by purchase_date desc` 在 PostgreSQL 里会把 NULL 排在最前（DESC 默认 NULLS FIRST），
   *   那会让没有采购日期的单据把真正的近期价格顶掉，所以这里在内存里比较。
   */
  private async latestPurchasePrices(materialIds: string[]): Promise<Map<string, Prisma.Decimal>> {
    const prices = new Map<string, Prisma.Decimal>();
    if (!materialIds.length) return prices;
    const rows = await this.prisma.purchaseOrderItem.findMany({
      where: { materialId: { in: materialIds }, deletedAt: null, purchaseOrder: { deletedAt: null, status: { not: "cancelled" } } },
      select: { materialId: true, unitPrice: true, purchaseOrder: { select: { purchaseDate: true, createdAt: true } } },
      orderBy: [{ createdAt: "desc" }],
    });
    const newest = new Map<string, number>();
    for (const row of rows) {
      const at = (row.purchaseOrder?.purchaseDate ?? row.purchaseOrder?.createdAt ?? new Date(0)).valueOf();
      const current = newest.get(row.materialId);
      if (current === undefined || at > current) {
        newest.set(row.materialId, at);
        prices.set(row.materialId, row.unitPrice);
      }
    }
    return prices;
  }
}
