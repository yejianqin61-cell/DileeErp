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

  /**
   * 按「物料 + 单位 + 供应商」取原料余额。
   *
   * supplierId 传 null 时，查「未指定供应商」这一档位（历史领料/盘点调整等事实的 supplier_id 都为 NULL，
   * 不算进任何一个具体供应商，也不被具体供应商消耗）。
   *
   * 为什么单独一条方法而不是在 rawMaterialBalance 里加参数：口径不同（default-unit vs 显式单位+供应商），
   * 调用站点必须显式选，避免「默认走 defaultUnitId」的隐式行为把张/个搞混。
   */
  async rawMaterialBalanceBySupplier(client: InventoryClient, materialId: string, unitId: string, supplierId: string | null) {
    const material = await client.material.findFirst({ where: { id: materialId, materialType: "raw_material", deletedAt: null } });
    if (!material) return new Prisma.Decimal(0);
    const result = await client.inventoryFact.aggregate({
      where: { materialId: material.id, unitId, inventoryCategory: { in: ["raw_material", "scrap"] }, ...(supplierId ? { supplierId } : { supplierId: null }) },
      _sum: { quantityDelta: true }
    });
    return result._sum.quantityDelta ?? new Prisma.Decimal(0);
  }

  /**
   * 同一物料 + 同一单位下，按供应商拆分的余额桶（含 supplierId=null 的「未指定」档）。
   * 供给前端「当前库存量」列的 hover title 与供应商下拉里的档位结存显示。
   */
  async rawMaterialSupplierBuckets(client: InventoryClient, materialId: string, unitId: string): Promise<Array<{ supplier_id: string | null; supplier_code: string | null; supplier_name: string | null; quantity: Prisma.Decimal }>> {
    const facts = await client.inventoryFact.findMany({ where: { materialId, unitId, inventoryCategory: { in: ["raw_material", "scrap"] } }, select: { supplierId: true, quantityDelta: true, supplier: { select: { supplierCode: true, name: true } } } });
    const buckets = new Map<string | null, { supplier_id: string | null; supplier_code: string | null; supplier_name: string | null; quantity: Prisma.Decimal }>();
    for (const fact of facts) {
      const key = fact.supplierId;
      const current = buckets.get(key);
      if (current) current.quantity = current.quantity.plus(fact.quantityDelta);
      else buckets.set(key, { supplier_id: fact.supplierId, supplier_code: fact.supplier?.supplierCode ?? null, supplier_name: fact.supplier?.name ?? null, quantity: fact.quantityDelta });
    }
    return [...buckets.values()].filter((row) => !row.quantity.isZero()).sort((a, b) => {
      if (a.supplier_id === null && b.supplier_id !== null) return 1;
      if (a.supplier_id !== null && b.supplier_id === null) return -1;
      if (a.supplier_name && b.supplier_name) return a.supplier_name.localeCompare(b.supplier_name);
      return 0;
    });
  }

  /**
   * 取物料的默认单位（供 group_by=supplier 路径里用，避免前端再查一次物料）。
   * 找不到或不是原料时返回 null。
   */
  async defaultUnitOf(client: InventoryClient, materialId: string): Promise<{ unit_id: string; unit_name: string } | null> {
    const material = await client.material.findFirst({ where: { id: materialId, materialType: "raw_material", deletedAt: null }, select: { id: true, defaultUnitId: true, defaultUnit: { select: { name: true } } } });
    if (!material) return null;
    return { unit_id: material.defaultUnitId, unit_name: material.defaultUnit?.name ?? "" };
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
