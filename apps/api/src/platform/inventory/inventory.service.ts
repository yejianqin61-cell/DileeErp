import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

type InventoryClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async rawMaterialBalance(client: InventoryClient, materialId: string, unitId: string) {
    const result = await client.inventoryFact.aggregate({
      where: { materialId, unitId, inventoryCategory: "raw_material" },
      _sum: { quantityDelta: true }
    });
    return result._sum.quantityDelta ?? new Prisma.Decimal(0);
  }

  async rawMaterialBalances(materialIds: string[]) {
    const facts = await this.prisma.inventoryFact.findMany({ where: { materialId: { in: materialIds }, inventoryCategory: "raw_material" }, select: { materialId: true, unitId: true, quantityDelta: true } });
    const balances = new Map<string, Prisma.Decimal>();
    for (const fact of facts) balances.set(fact.materialId!, (balances.get(fact.materialId!) ?? new Prisma.Decimal(0)).plus(fact.quantityDelta));
    return materialIds.map((id) => ({ material_id: id, quantity: (balances.get(id) ?? new Prisma.Decimal(0)).toString() }));
  }

  async finishedGoodsBalance(client: InventoryClient, productionOrderId: string, unitId: string, category: "finished_goods" | "defective_goods") {
    const result = await client.inventoryFact.aggregate({ where: { productionOrderId, unitId, inventoryCategory: category }, _sum: { quantityDelta: true } });
    return result._sum.quantityDelta ?? new Prisma.Decimal(0);
  }

  async finishedGoodsBalances(input: { category?: "finished_goods" | "defective_goods"; orderNo?: string; productionOrderId?: string; unitId?: string }) {
    const facts = await this.prisma.inventoryFact.findMany({ where: { inventoryCategory: input.category ? input.category : { in: ["finished_goods", "defective_goods"] }, ...(input.orderNo ? { orderNo: input.orderNo } : {}), ...(input.productionOrderId ? { productionOrderId: input.productionOrderId } : {}), ...(input.unitId ? { unitId: input.unitId } : {}) }, orderBy: { createdAt: "asc" } });
    const balances = new Map<string, { category: string; unit_id: string; production_order_id: string | null; order_no: string | null; product_name: string | null; product_specification: string | null; quantity: Prisma.Decimal }>();
    for (const fact of facts) {
      const key = [fact.inventoryCategory, fact.unitId, fact.productionOrderId ?? "", fact.productNameSnapshot ?? "", fact.productSpecificationSnapshot ?? ""].join("|");
      const current = balances.get(key);
      if (current) current.quantity = current.quantity.plus(fact.quantityDelta);
      else balances.set(key, { category: fact.inventoryCategory, unit_id: fact.unitId, production_order_id: fact.productionOrderId, order_no: fact.orderNo, product_name: fact.productNameSnapshot, product_specification: fact.productSpecificationSnapshot, quantity: fact.quantityDelta });
    }
    return [...balances.values()].map((row) => ({ ...row, quantity: row.quantity.toString() })).filter((row) => row.quantity !== "0");
  }

  async finishedGoodsOrderSummary(orderNo: string) {
    const facts = await this.prisma.inventoryFact.findMany({ where: { orderNo, inventoryCategory: { in: ["finished_goods", "defective_goods"] } }, orderBy: { createdAt: "asc" } });
    const total = (category: string) => facts.filter((fact) => fact.inventoryCategory === category).reduce((sum, fact) => sum.plus(fact.quantityDelta), new Prisma.Decimal(0));
    const outbound = facts.filter((fact) => fact.sourceType === "finished_goods_outbound").reduce((sum, fact) => sum.plus(fact.quantityDelta.abs()), new Prisma.Decimal(0));
    const returned = facts.filter((fact) => fact.sourceType === "finished_goods_customer_return").reduce((sum, fact) => sum.plus(fact.quantityDelta), new Prisma.Decimal(0));
    return { order_no: orderNo, finished_goods_balance: total("finished_goods").toString(), defective_goods_balance: total("defective_goods").toString(), outbound_quantity: outbound.toString(), return_quantity: returned.toString(), receivable_source_ready: outbound.gt(0), fact_count: facts.length };
  }
}
