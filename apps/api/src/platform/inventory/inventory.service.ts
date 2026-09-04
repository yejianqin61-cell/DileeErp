import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

type InventoryClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async rawMaterialBalance(client: InventoryClient, materialId: string, unitId: string) {
    const material = await client.material.findFirst({ where: { id: materialId, materialType: "raw_material", deletedAt: null } });
    if (!material) return new Prisma.Decimal(0);
    const result = await client.inventoryFact.aggregate({
      where: { materialId: material.id, unitId, inventoryCategory: { in: ["raw_material", "scrap"] } },
      _sum: { quantityDelta: true }
    });
    return result._sum.quantityDelta ?? new Prisma.Decimal(0);
  }

  async rawMaterialBalances(materialIds: string[]) {
    const facts = await this.prisma.inventoryFact.findMany({ where: { ...(materialIds.length ? { materialId: { in: materialIds } } : {}), inventoryCategory: { in: ["raw_material", "scrap"] }, material: { materialType: "raw_material", deletedAt: null }, unit: { deletedAt: null } }, select: { materialId: true, unitId: true, quantityDelta: true, orderNo: true, material: { select: { materialCode: true, name: true } }, unit: { select: { name: true } } } });
    const balances = new Map<string, { material_id: string; material_code: string; material_name: string; unit_id: string; unit_name: string; order_nos: Set<string>; quantity: Prisma.Decimal }>();
    for (const fact of facts) { if (!fact.materialId || !fact.material || !fact.unit) continue; const key = `${fact.materialId}|${fact.unitId}`; const current = balances.get(key); if (current) { current.quantity = current.quantity.plus(fact.quantityDelta); if (fact.orderNo) current.order_nos.add(fact.orderNo); } else balances.set(key, { material_id: fact.materialId, material_code: fact.material.materialCode, material_name: fact.material.name, unit_id: fact.unitId, unit_name: fact.unit.name, order_nos: new Set(fact.orderNo ? [fact.orderNo] : []), quantity: fact.quantityDelta }); }
    return [...balances.values()].map((row) => ({ material_id: row.material_id, material_code: row.material_code, material_name: row.material_name, unit_id: row.unit_id, unit_name: row.unit_name, order_no: row.order_nos.size === 1 ? [...row.order_nos][0] : null, order_nos: [...row.order_nos].sort(), quantity: row.quantity.toString() })).filter((row) => row.quantity !== "0");
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
