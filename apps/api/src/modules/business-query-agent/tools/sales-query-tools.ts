import type { PrismaClient } from "@prisma/client";
import type { AgentOrderRoot } from "./order-root";

/**
 * 销售领域 4 个 operation（P3-T2）。全部以已验证订单为根；投影是**白名单**——
 * 财务列（unit_price、total_amount、tax_rate、settlement 系列、receivable_amount、
 * local_currency_amount、currency）与客户快照、extensionData 一律不进；
 * 客户电话/地址是待定口径，默认收紧。
 */

export type SalesQueryStore = Pick<PrismaClient, "salesOrder" | "customer" | "bom" | "bomItem" | "customerReturn">;

export async function getSalesOrder(client: SalesQueryStore, root: AgentOrderRoot): Promise<{ data: Record<string, unknown>; sources: { business_type: string; business_no: string }[] }> {
  const order = await client.salesOrder.findFirst({
    where: { orderNo: root.orderNo, deletedAt: null },
    select: {
      orderNo: true, itemNo: true, reorderFromOrderNo: true, customerPoNo: true, externalContractNo: true,
      orderDate: true, productName: true, productSpec: true, quantity: true, unit: true, deliveryDate: true,
      status: true, currentVersion: true, factory: true, completionRemark: true, attentionNote: true,
      createdAt: true, updatedAt: true,
    },
  });
  if (!order) return { data: {}, sources: [] };
  return {
    data: {
      order_no: order.orderNo, item_no: order.itemNo, reorder_from_order_no: order.reorderFromOrderNo,
      customer_po_no: order.customerPoNo, external_contract_no: order.externalContractNo,
      order_date: order.orderDate, product_name: order.productName, product_spec: order.productSpec,
      quantity: String(order.quantity), unit: order.unit, delivery_date: order.deliveryDate,
      status: order.status, current_version: order.currentVersion, factory: order.factory,
      completion_remark: order.completionRemark, attention_note: order.attentionNote,
      created_at: order.createdAt, updated_at: order.updatedAt,
    },
    sources: [{ business_type: "sales_order", business_no: order.orderNo }],
  };
}

export async function getCustomer(client: SalesQueryStore, root: AgentOrderRoot): Promise<{ data: Record<string, unknown>; sources: { business_type: string; business_no: string }[] }> {
  // 只从已验证订单解析客户（模块设计：不能调用无订单约束的客户池查询）。
  const order = await client.salesOrder.findFirst({ where: { orderNo: root.orderNo, deletedAt: null }, select: { customerId: true, customerSnapshot: true } });
  if (!order) return { data: {}, sources: [] };
  const customer = await client.customer.findFirst({ where: { id: order.customerId, deletedAt: null }, select: { customerCode: true, name: true } });
  // 客户被软删时回退订单快照名；编码不编造。
  const snapshotName = (order.customerSnapshot as { name?: unknown } | null)?.name;
  const data = {
    customer_code: customer?.customerCode ?? null,
    name: customer?.name ?? (typeof snapshotName === "string" ? snapshotName : null),
  };
  return { data, sources: [{ business_type: "customer", business_no: data.customer_code ?? String(order.customerId) }] };
}

export async function getBom(client: SalesQueryStore, root: AgentOrderRoot, page: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const orderNo = root.orderNo;
  const boms = await client.bom.findMany({ where: { orderNo, deletedAt: null }, orderBy: { version: "desc" }, select: { id: true, version: true, status: true } });
  if (!boms.length) return { data: [], sources: [] };
  // BOM 版本可能多张，明细全量在 20 行内截断（capability.maxRows 兜底）——按版本新→旧展开。
  const items = await client.bomItem.findMany({
    where: { bomId: { in: boms.map((bom) => bom.id) }, deletedAt: null },
    orderBy: [{ bomId: "asc" }, { sequence: "asc" }],
    select: { bomId: true, sequence: true, materialName: true, model: true, specificationModel: true, color: true, requiredQuantity: true, unit: true, approvedUsage: true },
  });
  const versionById = new Map(boms.map((bom) => [bom.id, bom]));
  const data = items.map((item) => {
    const bom = versionById.get(item.bomId);
    return {
      bom_version: bom?.version ?? null,
      bom_status: bom?.status ?? null,
      sequence: item.sequence,
      material_name: item.materialName,
      model: item.model,
      specification_model: item.specificationModel,
      color: item.color,
      required_quantity: String(item.requiredQuantity),
      unit: item.unit,
      approved_usage: item.approvedUsage === null || item.approvedUsage === undefined ? null : String(item.approvedUsage),
    };
  });
  void page;
  return { data, sources: [{ business_type: "sales_order", business_no: orderNo }] };
}

export async function getSalesReturns(client: SalesQueryStore, root: AgentOrderRoot, page: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const orderNo = root.orderNo;
  const { skip, take } = { skip: (page - 1) * 20, take: 20 };
  const returns = await client.customerReturn.findMany({
    where: { orderNo, deletedAt: null },
    orderBy: { createdAt: "desc" },
    skip, take,
    // 自由原因、备注、附件、幂等键一律不选（模块设计：不透传自由原因/JSON/附件字段）。
    select: { returnNo: true, quantity: true, returnDate: true, destination: true, status: true },
  });
  return {
    data: returns.map((row) => ({ return_no: row.returnNo, quantity: String(row.quantity), return_date: row.returnDate, destination: row.destination, status: row.status })),
    sources: returns.map((row) => ({ business_type: "customer_return", business_no: row.returnNo })),
  };
}
