import { Prisma, type PrismaClient } from "@prisma/client";
import { calculateQuantityProgress } from "../../production/production-progress.domain";
import type { AgentOrderRoot } from "./order-root";

/**
 * 生产领域 4 个 operation（P3-T4）。进度计算复用 production-progress.domain 的纯函数
 * （calculateQuantityProgress——与生产进度页同一口径），**禁止**任何重算写入路径；
 * 计薪字段（员工、工价）与自由备注、BOM 快照整块、外加工应付来源一律不进投影。
 * 外加工流转按三条链分列：dispatch（发料批次）/ return（回厂）/ direct_shipment（直发）。
 */

export type ProductionQueryStore = Pick<PrismaClient, "productionOrder" | "operationDailyReport" | "outsourceLogisticsBatch" | "outsourceReturnTransfer" | "outsourceDirectShipment">;

export async function getProductionOrders(client: ProductionQueryStore, root: AgentOrderRoot): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const orders = await client.productionOrder.findMany({
    where: { orderNo: root.orderNo, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      productionOrderNo: true, executionMode: true, status: true, plannedQuantity: true, productSpecification: true,
      productionProcessNote: true, plannedStartedOn: true, deliveryDueOn: true, startedOn: true, completedOn: true, createdAt: true,
      operations: { where: { deletedAt: null }, orderBy: { sequenceNo: "asc" }, select: { operationNameSnapshot: true, sequenceNo: true, targetQuantity: true, status: true } },
    },
  });
  return {
    data: orders.map((order) => ({
      production_order_no: order.productionOrderNo,
      execution_mode: order.executionMode,
      status: order.status,
      planned_quantity: String(order.plannedQuantity),
      product_specification: order.productSpecification,
      process_note: order.productionProcessNote,
      planned_started_on: order.plannedStartedOn,
      delivery_due_on: order.deliveryDueOn,
      started_on: order.startedOn,
      completed_on: order.completedOn,
      created_at: order.createdAt,
      operations: order.operations.map((operation) => ({
        operation_name: operation.operationNameSnapshot,
        sequence: operation.sequenceNo,
        target_quantity: String(operation.targetQuantity),
        status: operation.status,
      })),
    })),
    sources: orders.map((order) => ({ business_type: "production_order", business_no: order.productionOrderNo })),
  };
}

export async function getOperationProgress(client: ProductionQueryStore, root: AgentOrderRoot): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const orders = await client.productionOrder.findMany({
    where: { orderNo: root.orderNo, deletedAt: null },
    select: { id: true, productionOrderNo: true, operations: { where: { deletedAt: null }, orderBy: { sequenceNo: "asc" }, select: { id: true, operationNameSnapshot: true, sequenceNo: true, targetQuantity: true, status: true } } },
  });
  const reports = await client.operationDailyReport.findMany({
    where: { productionOrderId: { in: orders.map((order) => order.id) }, deletedAt: null },
    select: { productionOrderOperationId: true, completedQuantity: true },
  });
  const completedByOperation = new Map<string, Prisma.Decimal>();
  for (const report of reports) {
    const key = report.productionOrderOperationId;
    completedByOperation.set(key, (completedByOperation.get(key) ?? new Prisma.Decimal(0)).plus(String(report.completedQuantity)));
  }
  const data = orders.flatMap((order) => order.operations.map((operation) => {
    const progress = calculateQuantityProgress(String(operation.targetQuantity), (completedByOperation.get(operation.id) ?? new Prisma.Decimal(0)).toString(), operation.status === "cancelled");
    return {
      production_order_no: order.productionOrderNo,
      operation_name: operation.operationNameSnapshot,
      sequence: operation.sequenceNo,
      planned_quantity: progress.planned_quantity,
      actual_quantity: progress.actual_quantity,
      completion_rate: progress.completion_rate,
      status: progress.status,
    };
  }));
  return { data, sources: orders.map((order) => ({ business_type: "production_order", business_no: order.productionOrderNo })) };
}

export async function getOperationReports(client: ProductionQueryStore, root: AgentOrderRoot, page: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const { skip, take } = { skip: (page - 1) * 20, take: 20 };
  const reports = await client.operationDailyReport.findMany({
    where: { orderNo: root.orderNo, deletedAt: null },
    orderBy: [{ reportDate: "desc" }, { createdAt: "desc" }],
    skip, take,
    // 制单人（createdBy）与备注不选：员工归属与计薪口径属 HR/财务域。
    select: { productionOrderNoSnapshot: true, operationNameSnapshot: true, reportDate: true, completedQuantity: true, unit: { select: { name: true } } },
  });
  return {
    data: reports.map((report) => ({
      production_order_no: report.productionOrderNoSnapshot,
      operation_name: report.operationNameSnapshot,
      report_date: report.reportDate,
      completed_quantity: String(report.completedQuantity),
      unit: report.unit?.name ?? null,
    })),
    sources: reports.map((report) => ({ business_type: "operation_daily_report", business_no: `${report.productionOrderNoSnapshot}:${report.operationNameSnapshot}:${report.reportDate instanceof Date ? report.reportDate.toISOString().slice(0, 10) : String(report.reportDate)}` })),
  };
}

export async function getOutsourceFlow(client: ProductionQueryStore, root: AgentOrderRoot): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const orderNo = root.orderNo;
  const [batches, returns, shipments] = await Promise.all([
    client.outsourceLogisticsBatch.findMany({
      where: { orderNo, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      // 发料证明备注/备注/采购关联不选（采购价与应付在外加工的关联链上）。
      select: { batchNo: true, status: true, plannedQuantity: true, dispatchedQuantity: true, dispatchDate: true },
    }),
    client.outsourceReturnTransfer.findMany({
      where: { orderNo, deletedAt: null },
      orderBy: { transferDate: "desc" },
      take: 20,
      select: { transferNo: true, transferType: true, quantity: true, transferDate: true, status: true, finishedGoodsQcStatus: true },
    }),
    client.outsourceDirectShipment.findMany({
      where: { orderNo, deletedAt: null },
      orderBy: { shipmentDate: "desc" },
      take: 20,
      select: { shipmentNo: true, quantity: true, shipmentDate: true, logisticsReference: true, status: true, reversalQuantity: true },
    }),
  ]);
  const data = [
    ...batches.map((row) => ({ chain: "dispatch", batch_no: row.batchNo, status: row.status, planned_quantity: String(row.plannedQuantity), dispatched_quantity: String(row.dispatchedQuantity), date: row.dispatchDate })),
    ...returns.map((row) => ({ chain: "return", transfer_no: row.transferNo, transfer_type: row.transferType, status: row.status, quantity: String(row.quantity), qc_status: row.finishedGoodsQcStatus, date: row.transferDate })),
    ...shipments.map((row) => ({ chain: "direct_shipment", shipment_no: row.shipmentNo, status: row.status, quantity: String(row.quantity), reversal_quantity: String(row.reversalQuantity), logistics_reference: row.logisticsReference, date: row.shipmentDate })),
  ];
  const sources = [
    ...batches.map((row) => ({ business_type: "outsource_logistics_batch", business_no: row.batchNo })),
    ...returns.map((row) => ({ business_type: "outsource_return_transfer", business_no: row.transferNo })),
    ...shipments.map((row) => ({ business_type: "outsource_direct_shipment", business_no: row.shipmentNo })),
  ];
  return { data, sources };
}
