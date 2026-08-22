import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service";

type InventoryClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class InventoryService {
  async rawMaterialBalance(client: InventoryClient, materialId: string, unitId: string) {
    const result = await client.inventoryFact.aggregate({
      where: { materialId, unitId, inventoryCategory: "raw_material" },
      _sum: { quantityDelta: true }
    });
    return result._sum.quantityDelta ?? new Prisma.Decimal(0);
  }

  async finishedGoodsBalance(client: InventoryClient, productionOrderId: string, unitId: string, category: "finished_goods" | "defective_goods") {
    const result = await client.inventoryFact.aggregate({ where: { productionOrderId, unitId, inventoryCategory: category }, _sum: { quantityDelta: true } });
    return result._sum.quantityDelta ?? new Prisma.Decimal(0);
  }
}
