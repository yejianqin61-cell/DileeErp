import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

export const UNROOTED_MAX_ROWS = 20;

/** `total` 是翻页前的总行数：两个实现都先取全量再切页，所以现成可给。 */
export type UnrootedFact = { data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[]; total: number };

export type UnrootedHandler = {
  parse: (raw: unknown) => { page: number; limitDays?: number };
  run: (client: PrismaClient, input: { page: number; limitDays?: number }, now: Date) => Promise<UnrootedFact>;
};

export type UnrootedStore = Pick<PrismaClient, "inventoryFact" | "purchaseOrder" | "purchaseReceipt">;

const ALLOWED_KEYS = ["page"];

function badRequest(message: string) {
  return new BadRequestException({ code: "AGENT_TOOL_ARGUMENT_INVALID", message, details: [] });
}

export function parseUnrootedInput(raw: unknown): { page: number } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("参数必须是 JSON 对象");
  const record = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !ALLOWED_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw badRequest(
      `这个查询不需要单据根，只接受 page：${unknownKeys.join(", ")}。需要单张单据的明细请先检索取得 order_ref。`,
    );
  }
  if (record.page !== undefined) {
    if (typeof record.page !== "number" || !Number.isInteger(record.page) || record.page < 1 || record.page > 1000) {
      throw badRequest("page 必须是 1 到 1000 的整数");
    }
    return { page: record.page };
  }
  return { page: 1 };
}

export async function listLowStockMaterials(client: Pick<PrismaClient, "inventoryFact">, input: { page: number }): Promise<UnrootedFact> {
  const facts = await client.inventoryFact.findMany({
    where: {
      inventoryCategory: { in: ["raw_material", "scrap"] },
      material: { materialType: "raw_material", deletedAt: null },
      unit: { deletedAt: null },
    },
    select: {
      materialId: true,
      unitId: true,
      quantityDelta: true,
      material: { select: { materialCode: true, name: true } },
      unit: { select: { name: true } },
    },
  });

  const balances = new Map<string, { material_code: string; material_name: string; unit: string; net: Prisma.Decimal }>();
  for (const fact of facts) {
    if (!fact.materialId || !fact.material || !fact.unit) continue;
    const key = `${fact.materialId}|${fact.unitId}`;
    const current = balances.get(key);
    if (current) current.net = current.net.plus(fact.quantityDelta.toString());
    else balances.set(key, { material_code: fact.material.materialCode, material_name: fact.material.name, unit: fact.unit.name, net: new Prisma.Decimal(fact.quantityDelta.toString()) });
  }

  const short = [...balances.values()].filter((row) => row.net.lessThanOrEqualTo(0));
  short.sort((left, right) => left.net.comparedTo(right.net));
  const skip = (input.page - 1) * UNROOTED_MAX_ROWS;
  const data = short.slice(skip, skip + UNROOTED_MAX_ROWS).map((row) => ({
    material_code: row.material_code,
    material_name: row.material_name,
    unit: row.unit,
    net_quantity: row.net.toString(),
    basis: "净库存量（inventory_facts 的 quantity_delta 汇总，raw_material + scrap）。系统未维护安全库存，因此本口径只表示「净额不大于 0」。",
  }));
  return { data, sources: data.map((row) => ({ business_type: "material", business_no: row.material_code })), total: short.length };
}

export async function listOverdueArrivals(client: Pick<PrismaClient, "purchaseOrder">, input: { page: number }, now: Date): Promise<UnrootedFact> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const orders = await client.purchaseOrder.findMany({
    where: { deletedAt: null, status: { notIn: ["arrived_complete", "cancelled"] }, expectedDate: { lt: today } },
    orderBy: { expectedDate: "asc" },
    select: { purchaseOrderNo: true, orderNo: true, status: true, expectedDate: true, supplierSnapshot: true },
  });

  const rows = orders.map((order) => {
    const overdueDays = order.expectedDate instanceof Date ? Math.floor((today.getTime() - order.expectedDate.getTime()) / 86_400_000) : null;
    const snapshot = order.supplierSnapshot && typeof order.supplierSnapshot === "object" ? (order.supplierSnapshot as { name?: unknown }) : {};
    return {
      purchase_order_no: order.purchaseOrderNo,
      order_no: order.orderNo,
      status: order.status,
      expected_date: order.expectedDate instanceof Date ? order.expectedDate.toISOString().slice(0, 10) : order.expectedDate,
      overdue_days: overdueDays,
      supplier_name: typeof snapshot.name === "string" ? snapshot.name : null,
      basis: "expected_date 早于今天，且采购单状态不是 arrived_complete / cancelled。",
    };
  });
  const skip = (input.page - 1) * UNROOTED_MAX_ROWS;
  const data = rows.slice(skip, skip + UNROOTED_MAX_ROWS);
  return { data, sources: data.map((row) => ({ business_type: "purchase_order", business_no: row.purchase_order_no })), total: rows.length };
}

export const UNROOTED_OPERATIONS: Record<string, UnrootedHandler> = {
  list_low_stock_materials: { parse: parseUnrootedInput, run: async (client, input) => listLowStockMaterials(client, input) },
  list_overdue_arrivals: { parse: parseUnrootedInput, run: async (client, input, now) => listOverdueArrivals(client, input, now) },
};