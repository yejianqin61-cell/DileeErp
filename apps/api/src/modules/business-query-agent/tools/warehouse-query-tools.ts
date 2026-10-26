import { Prisma, type PrismaClient } from "@prisma/client";
import type { AgentOrderRoot } from "./order-root";

/**
 * 仓库领域 6 个 operation（P3-T5）。所有查询以已验证订单为根；投影只保留
 * 数量、状态、单据号与时间。余额严格复用 InventoryService.rawMaterialBalances
 * 的事实聚合口径，且明确它是 BOM 物料的全局实存量，不是订单专属库存。
 */
export type WarehouseQueryStore = Pick<PrismaClient,
  "bom" | "bomItem" | "inventoryFact" | "rawMaterialMovement" |
  "finishedGoodsQcRecord" | "finishedGoodsInboundNotice" | "finishedGoodsInbound" |
  "finishedGoodsOutbound">;

const page = (value: number) => ({ skip: (value - 1) * 20, take: 20 });

export async function getRawMaterialBalance(client: WarehouseQueryStore, root: AgentOrderRoot): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const boms = await client.bom.findMany({ where: { orderNo: root.orderNo, deletedAt: null }, select: { id: true } });
  if (!boms.length) return { data: [], sources: [] };
  const items = await client.bomItem.findMany({ where: { bomId: { in: boms.map((bom) => bom.id) }, deletedAt: null }, select: { materialId: true } });
  const materialIds = [...new Set(items.map((item) => item.materialId))];
  if (!materialIds.length) return { data: [], sources: [] };
  const facts = await client.inventoryFact.findMany({
    where: { materialId: { in: materialIds }, inventoryCategory: { in: ["raw_material", "scrap"] }, material: { materialType: "raw_material", deletedAt: null }, unit: { deletedAt: null } },
    select: { materialId: true, unitId: true, quantityDelta: true, material: { select: { materialCode: true, name: true } }, unit: { select: { name: true } } },
  });
  const balances = new Map<string, { material_code: string; material_name: string; unit: string; quantity: Prisma.Decimal }>();
  for (const fact of facts) {
    if (!fact.materialId || !fact.material || !fact.unit) continue;
    const key = `${fact.materialId}|${fact.unitId}`;
    const current = balances.get(key);
    if (current) current.quantity = current.quantity.plus(fact.quantityDelta.toString());
    else balances.set(key, { material_code: fact.material.materialCode, material_name: fact.material.name, unit: fact.unit.name, quantity: new Prisma.Decimal(fact.quantityDelta.toString()) });
  }
  const data = [...balances.values()]
    .filter((row) => !row.quantity.isZero())
    .map((row) => ({ material_code: row.material_code, material_name: row.material_name, unit: row.unit, quantity: row.quantity.toString(), scope: "全局实存量，非订单专属" }));
  return { data, sources: [{ business_type: "sales_order", business_no: root.orderNo }] };
}

export async function getInventoryFacts(client: WarehouseQueryStore, root: AgentOrderRoot, currentPage: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const facts = await client.inventoryFact.findMany({
    where: { orderNo: root.orderNo }, orderBy: { createdAt: "desc" }, ...page(currentPage),
    select: { inventoryCategory: true, quantityDelta: true, sourceType: true, sourceId: true, createdAt: true },
  });
  return {
    data: facts.map((fact) => ({ inventory_category: fact.inventoryCategory, quantity_delta: String(fact.quantityDelta), source_type: fact.sourceType, source_id: fact.sourceId, created_at: fact.createdAt })),
    sources: facts.map((fact) => ({ business_type: "inventory_fact", business_no: fact.sourceId ?? root.orderNo })),
  };
}

export async function getMaterialMovements(client: WarehouseQueryStore, root: AgentOrderRoot, currentPage: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const movements = await client.rawMaterialMovement.findMany({
    where: { orderNo: root.orderNo, deletedAt: null }, orderBy: { businessDate: "desc" }, ...page(currentPage),
    // 理由、备注、风险 JSON 和附件均可能是自由文本，禁止进入模型。
    select: { movementNo: true, documentType: true, status: true, businessDate: true, lines: { where: { deletedAt: null }, select: { quantity: true, material: { select: { materialCode: true, name: true } }, unit: { select: { name: true } } } } },
  });
  return {
    data: movements.map((movement) => ({ movement_no: movement.movementNo, document_type: movement.documentType, status: movement.status, business_date: movement.businessDate, lines: movement.lines.map((line) => ({ material_code: line.material.materialCode, material_name: line.material.name, quantity: String(line.quantity), unit: line.unit.name })) })),
    sources: movements.map((movement) => ({ business_type: "raw_material_movement", business_no: movement.movementNo })),
  };
}

export async function getFinishedGoodsQc(client: WarehouseQueryStore, root: AgentOrderRoot, currentPage: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const rows = await client.finishedGoodsQcRecord.findMany({
    where: { orderNo: root.orderNo, deletedAt: null }, orderBy: { inspectionDate: "desc" }, ...page(currentPage),
    select: { qcNo: true, conclusion: true, status: true, inspectedQuantity: true, qualifiedQuantity: true, conditionalAcceptQuantity: true, rejectedQuantity: true, inspectionDate: true },
  });
  return {
    data: rows.map((row) => ({ qc_no: row.qcNo, conclusion: row.conclusion, status: row.status, inspected_quantity: String(row.inspectedQuantity), qualified_quantity: String(row.qualifiedQuantity), conditional_accept_quantity: String(row.conditionalAcceptQuantity), rejected_quantity: String(row.rejectedQuantity), inspection_date: row.inspectionDate })),
    sources: rows.map((row) => ({ business_type: "finished_goods_qc", business_no: row.qcNo })),
  };
}

export async function getFinishedGoodsInbounds(client: WarehouseQueryStore, root: AgentOrderRoot, currentPage: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const [notices, inbounds] = await Promise.all([
    client.finishedGoodsInboundNotice.findMany({ where: { orderNo: root.orderNo, deletedAt: null }, orderBy: { noticeDate: "desc" }, ...page(currentPage), select: { noticeNo: true, status: true, noticeQuantity: true, noticeDate: true, batchNo: true } }),
    client.finishedGoodsInbound.findMany({ where: { orderNo: root.orderNo, deletedAt: null }, orderBy: { createdAt: "desc" }, ...page(currentPage), select: { inboundNo: true, status: true, quantity: true, createdAt: true, qcRecord: { select: { qcNo: true } } } }),
  ]);
  return {
    data: [
      ...notices.map((row) => ({ chain: "notice", notice_no: row.noticeNo, status: row.status, quantity: String(row.noticeQuantity), date: row.noticeDate, batch_no: row.batchNo })),
      ...inbounds.map((row) => ({ chain: "inbound", inbound_no: row.inboundNo, status: row.status, quantity: String(row.quantity), date: row.createdAt, qc_no: row.qcRecord.qcNo })),
    ],
    sources: [
      ...notices.map((row) => ({ business_type: "finished_goods_inbound_notice", business_no: row.noticeNo })),
      ...inbounds.map((row) => ({ business_type: "finished_goods_inbound", business_no: row.inboundNo })),
    ],
  };
}

export async function getFinishedGoodsOutbounds(client: WarehouseQueryStore, root: AgentOrderRoot, currentPage: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const rows = await client.finishedGoodsOutbound.findMany({
    where: { orderNo: root.orderNo, deletedAt: null }, orderBy: { createdAt: "desc" }, ...page(currentPage),
    // 不调用 FinishedGoodsOutboundService.listOutbounds：其 salesOrder include 带价格、结算与应收。
    select: { outboundNo: true, status: true, quantity: true, shipmentDate: true, createdAt: true, outboundNotice: { select: { noticeNo: true } } },
  });
  return {
    data: rows.map((row) => ({ outbound_no: row.outboundNo, status: row.status, quantity: String(row.quantity), shipment_date: row.shipmentDate, created_at: row.createdAt, outbound_notice_no: row.outboundNotice?.noticeNo ?? null })),
    sources: rows.map((row) => ({ business_type: "finished_goods_outbound", business_no: row.outboundNo })),
  };
}
