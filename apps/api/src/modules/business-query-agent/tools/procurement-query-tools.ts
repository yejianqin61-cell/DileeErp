import { Prisma, type PrismaClient } from "@prisma/client";
import type { AgentOrderRoot } from "./order-root";

/**
 * 采购领域 4 个 operation（P3-T3）。全部以已验证订单为根，行级投影白名单：
 * 金额/单价/币种/税、付款条款、交货条款（含地址）、extensionData/应付来源、自由备注、
 * 供应商联系人细节一律不进。供应商快照只取 name。
 * 到货批次以 receipt_no 标识（现有「批次序号」规则依赖实现细节，未复刻前不编造序号）。
 */

export type ProcurementQueryStore = Pick<PrismaClient, "purchasePlan" | "purchaseOrder" | "purchaseOrderItem" | "purchaseReceipt" | "incomingInspection">;

type Snapshot = Record<string, unknown> | null | undefined;
const snapName = (snapshot: Snapshot): string | null => (snapshot && typeof snapshot === "object" && typeof (snapshot as { name?: unknown }).name === "string" ? (snapshot as { name: string }).name : null);

export async function getPurchasePlans(client: ProcurementQueryStore, root: AgentOrderRoot, page: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const orderNo = root.orderNo;
  const plans = await client.purchasePlan.findMany({
    where: { orderNo, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { planNo: true, bomVersion: true, createdAt: true, items: { select: { model: true, quantity: true, materialSnapshot: true, unitSnapshot: true, supplierSnapshot: true } } },
  });
  const data = plans.flatMap((plan) => plan.items.map((item) => ({
    plan_no: plan.planNo,
    bom_version: plan.bomVersion,
    material_name: snapName(item.materialSnapshot),
    model: item.model,
    quantity: String(item.quantity),
    unit: snapName(item.unitSnapshot),
    supplier_name: snapName(item.supplierSnapshot),
    plan_created_at: plan.createdAt,
  })));
  const { skip, take } = { skip: (page - 1) * 20, take: 20 };
  return {
    data: data.slice(skip, skip + take),
    sources: plans.map((plan) => ({ business_type: "purchase_plan", business_no: plan.planNo })),
  };
}

export async function getPurchaseOrders(client: ProcurementQueryStore, root: AgentOrderRoot, page: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const orderNo = root.orderNo;
  const { skip, take } = { skip: (page - 1) * 20, take: 20 };
  const orders = await client.purchaseOrder.findMany({
    where: { orderNo, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    skip, take,
    // 付款方式/交货条款（print fields，可能含地址）与金额/币种一样不进非财务投影。
    select: { purchaseOrderNo: true, status: true, supplierSnapshot: true, purchaseDate: true, expectedDate: true, createdAt: true, updatedAt: true, items: { select: { quantity: true } } },
  });
  return {
    data: orders.map((order) => ({
      purchase_order_no: order.purchaseOrderNo,
      status: order.status,
      supplier_name: snapName(order.supplierSnapshot),
      purchase_date: order.purchaseDate,
      expected_date: order.expectedDate,
      item_count: order.items.length,
      ordered_quantity: order.items.reduce((total, item) => total.plus(String(item.quantity)), new Prisma.Decimal(0)).toString(),
      created_at: order.createdAt,
      updated_at: order.updatedAt,
    })),
    sources: orders.map((order) => ({ business_type: "purchase_order", business_no: order.purchaseOrderNo })),
  };
}

export async function getReceipts(client: ProcurementQueryStore, root: AgentOrderRoot, page: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const orderNo = root.orderNo;
  const { skip, take } = { skip: (page - 1) * 20, take: 20 };
  const receipts = await client.purchaseReceipt.findMany({
    where: { orderNo, deletedAt: null },
    orderBy: { receivedDate: "desc" },
    skip, take,
    // extensionData 可能挂结算/应付来源；自由备注同批排除。
    select: { receiptNo: true, receivedDate: true, quantity: true, status: true, purchaseOrder: { select: { purchaseOrderNo: true } } },
  });
  return {
    data: receipts.map((row) => ({ receipt_no: row.receiptNo, purchase_order_no: row.purchaseOrder.purchaseOrderNo, quantity: String(row.quantity), status: row.status, received_date: row.receivedDate })),
    sources: receipts.map((row) => ({ business_type: "purchase_receipt", business_no: row.receiptNo })),
  };
}

export async function getIncomingInspections(client: ProcurementQueryStore, root: AgentOrderRoot, page: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const orderNo = root.orderNo;
  const { skip, take } = { skip: (page - 1) * 20, take: 20 };
  const inspections = await client.incomingInspection.findMany({
    where: { orderNo, deletedAt: null },
    orderBy: { createdAt: "desc" },
    skip, take,
    select: { inspectedQuantity: true, acceptedQuantity: true, conditionalQuantity: true, rejectedQuantity: true, qcResult: true, status: true, createdAt: true, purchaseReceipt: { select: { receiptNo: true } } },
  });
  return {
    data: inspections.map((row) => ({
      receipt_no: row.purchaseReceipt.receiptNo,
      inspected_quantity: String(row.inspectedQuantity),
      accepted_quantity: String(row.acceptedQuantity),
      conditional_quantity: String(row.conditionalQuantity),
      rejected_quantity: String(row.rejectedQuantity),
      qc_result: row.qcResult,
      status: row.status,
      created_at: row.createdAt,
    })),
    sources: inspections.map((row) => ({ business_type: "incoming_inspection", business_no: row.purchaseReceipt.receiptNo })),
  };
}
