import type { PrismaClient } from "@prisma/client";
import type { AgentOrderRoot } from "./order-root";

/**
 * get_order_attachments（模块设计映射表）：只解析当前订单及其**非财务关联单据**的附件链接；
 * operational 投影固定 5 字段（类型/大小/上传时间/实体类型/实体 ID）——
 * **不给**文件名（自由命名可能含敏感内容）、存储键、下载 URL 或文件内容。
 *
 * 关联单据族以「表上有 orderNo 列」为准收录；outsource_* 批次族的归属列未逐表核实，
 * 先不收录（宁可少给），需要时按同模式扩展并在审计用例里补断言。
 */

export type AttachmentStore = Pick<PrismaClient, "bom" | "purchaseOrder" | "purchaseReceipt" | "productionOrder" | "incomingInspection" | "rawMaterialInbound" | "rawMaterialMovement" | "finishedGoodsQcRecord" | "finishedGoodsInbound" | "finishedGoodsInboundNotice" | "finishedGoodsOutbound" | "attachmentLink">;

export async function getOrderAttachments(client: AttachmentStore, root: AgentOrderRoot): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const orderNo = root.orderNo;
  const [boms, purchaseOrders, purchaseReceipts, productionOrders, incomingInspections, rawMaterialInbounds, rawMaterialMovements, qcRecords, finishedInbounds, inboundNotices, finishedOutbounds] = await Promise.all([
    client.bom.findMany({ where: { orderNo, deletedAt: null }, select: { id: true } }),
    client.purchaseOrder.findMany({ where: { orderNo, deletedAt: null }, select: { id: true } }),
    client.purchaseReceipt.findMany({ where: { orderNo, deletedAt: null }, select: { id: true } }),
    client.productionOrder.findMany({ where: { orderNo, deletedAt: null }, select: { id: true } }),
    client.incomingInspection.findMany({ where: { orderNo, deletedAt: null }, select: { id: true } }),
    client.rawMaterialInbound.findMany({ where: { orderNo, deletedAt: null }, select: { id: true } }),
    client.rawMaterialMovement.findMany({ where: { orderNo, deletedAt: null }, select: { id: true } }),
    client.finishedGoodsQcRecord.findMany({ where: { orderNo, deletedAt: null }, select: { id: true } }),
    client.finishedGoodsInbound.findMany({ where: { orderNo, deletedAt: null }, select: { id: true } }),
    client.finishedGoodsInboundNotice.findMany({ where: { orderNo, deletedAt: null }, select: { id: true } }),
    client.finishedGoodsOutbound.findMany({ where: { orderNo, deletedAt: null }, select: { id: true } }),
  ]);

  const families = [
    { entityType: "sales_order", entityIds: [root.id] },
    { entityType: "bom", entityIds: boms.map((row) => row.id) },
    { entityType: "purchase_order", entityIds: purchaseOrders.map((row) => row.id) },
    { entityType: "purchase_receipt", entityIds: purchaseReceipts.map((row) => row.id) },
    { entityType: "production_order", entityIds: productionOrders.map((row) => row.id) },
    { entityType: "incoming_inspection", entityIds: incomingInspections.map((row) => row.id) },
    { entityType: "raw_material_inbound", entityIds: rawMaterialInbounds.map((row) => row.id) },
    { entityType: "raw_material_movement", entityIds: rawMaterialMovements.map((row) => row.id) },
    { entityType: "finished_goods_qc_record", entityIds: qcRecords.map((row) => row.id) },
    { entityType: "finished_goods_inbound", entityIds: finishedInbounds.map((row) => row.id) },
    { entityType: "finished_goods_inbound_notice", entityIds: inboundNotices.map((row) => row.id) },
    { entityType: "finished_goods_outbound", entityIds: finishedOutbounds.map((row) => row.id) },
  ].filter((family) => family.entityIds.length > 0);
  if (!families.length) return { data: [], sources: [] };

  const links = await client.attachmentLink.findMany({
    where: { OR: families.map((family) => ({ entityType: family.entityType, entityId: { in: family.entityIds } })) },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, entityType: true, entityId: true, attachment: { select: { mimeType: true, fileSize: true, createdAt: true } } },
  });
  const data = links.map((link) => ({
    entity_type: link.entityType,
    entity_id: link.entityId,
    file_type: link.attachment.mimeType,
    size: link.attachment.fileSize.toString(),
    uploaded_at: link.attachment.createdAt,
  }));
  return { data, sources: data.map((row) => ({ business_type: "attachment", business_no: `${row.entity_type}:${row.entity_id}` })) };
}
