import { Prisma, type PrismaClient } from "@prisma/client";
import { BomMaterialCostService } from "../../finance/finance-report-cost.service";
import { localRevenueOf, salesAmountOf, salesExchangeRate } from "../../finance/finance-report.domain";
import type { AgentOrderRoot } from "./order-root";

/**
 * 财务领域只读查询。财务事实只会在 full 档经 ToolExecutor 的 capability
 * 闸门到达这里；本文件仍使用 Agent 的只读 client 和窄 DTO，不复用会带
 * 写依赖或自由备注的领域服务返回。
 */
export type FinanceQueryStore = Pick<PrismaClient, "receivableSource" | "customerPayment" | "supplierPayableEntry" | "supplierPayment" | "receivableReconciliation" | "supplierPayableReconciliation" | "salesOrder" | "finishedGoodsOutbound" | "outsourceDirectShipment" | "employeeDailyReport" | "bom" | "purchaseOrderItem">;

const page = (value: number) => ({ skip: (value - 1) * 20, take: 20 });

export async function getReceivables(client: FinanceQueryStore, root: AgentOrderRoot, currentPage: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const rows = await client.receivableSource.findMany({
    where: { orderNo: root.orderNo, deletedAt: null }, orderBy: { createdAt: "desc" }, ...page(currentPage),
    select: {
      sourceNo: true, quantity: true, unit: true, unitPrice: true, taxRate: true, amount: true, currency: true, status: true,
      dueDate: true, invoiceNo: true, invoiceDate: true,
      customer: { select: { customerCode: true, name: true } },
      outbound: { select: { outboundNo: true } },
      allocations: { where: { deletedAt: null }, select: { amount: true, status: true, payment: { select: { status: true } } } },
    },
  });
  return {
    data: rows.map((row) => {
      const allocated = row.allocations
        .filter((allocation) => allocation.status === "active" && allocation.payment?.status === "posted")
        .reduce((total, allocation) => total.plus(allocation.amount.toString()), new Prisma.Decimal(0));
      return {
        source_no: row.sourceNo, outbound_no: row.outbound?.outboundNo ?? null,
        customer_code: row.customer?.customerCode ?? null, customer_name: row.customer?.name ?? null,
        quantity: row.quantity.toString(), unit: row.unit, unit_price: row.unitPrice?.toString() ?? null,
        tax_rate: row.taxRate?.toString() ?? null, amount: row.amount.toString(), currency: row.currency, status: row.status,
        allocated_amount: allocated.toString(), outstanding_amount: new Prisma.Decimal(row.amount.toString()).minus(allocated).toString(),
        due_date: row.dueDate, invoice_no: row.invoiceNo, invoice_date: row.invoiceDate,
      };
    }),
    sources: rows.map((row) => ({ business_type: "receivable_source", business_no: row.sourceNo })),
  };
}

export async function getCustomerPayments(client: FinanceQueryStore, root: AgentOrderRoot, currentPage: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const rows = await client.customerPayment.findMany({
    where: { orderNo: root.orderNo, deletedAt: null }, orderBy: { paymentDate: "desc" }, ...page(currentPage),
    // bankReference、payerName、完整账号、附件和备注都是不必要的自由/敏感字段。
    select: {
      paymentNo: true, paymentDate: true, amount: true, currency: true, paymentMethod: true, status: true,
      customer: { select: { customerCode: true, name: true } }, bank: { select: { bankName: true } },
      allocations: { where: { deletedAt: null }, select: { amount: true, currency: true, status: true, receivableSource: { select: { sourceNo: true } } } },
    },
  });
  return {
    data: rows.map((row) => ({
      payment_no: row.paymentNo, payment_date: row.paymentDate, amount: row.amount.toString(), currency: row.currency,
      payment_method: row.paymentMethod, status: row.status,
      customer_code: row.customer?.customerCode ?? null, customer_name: row.customer?.name ?? null,
      bank_name: row.bank?.bankName ?? null,
      allocations: row.allocations
        .filter((allocation) => allocation.status === "active")
        .map((allocation) => ({ source_no: allocation.receivableSource.sourceNo, amount: allocation.amount.toString(), currency: allocation.currency })),
    })),
    sources: rows.map((row) => ({ business_type: "customer_payment", business_no: row.paymentNo })),
  };
}

export async function getPayables(client: FinanceQueryStore, root: AgentOrderRoot, currentPage: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const rows = await client.supplierPayableEntry.findMany({
    where: { orderNo: root.orderNo, deletedAt: null }, orderBy: { createdAt: "desc" }, ...page(currentPage),
    select: {
      payableNo: true, sourceNoSnapshot: true, quantity: true, unitPrice: true, taxRate: true, amount: true, currency: true, confirmationDate: true, status: true,
      supplier: { select: { supplierCode: true, name: true } }, purchaseOrder: { select: { purchaseOrderNo: true } },
      allocations: { where: { deletedAt: null }, select: { amount: true, status: true, payment: { select: { status: true } } } },
    },
  });
  return {
    data: rows.map((row) => {
      const paid = row.allocations
        .filter((allocation) => allocation.status === "active" && allocation.payment?.status === "posted")
        .reduce((total, allocation) => total.plus(allocation.amount.toString()), new Prisma.Decimal(0));
      return {
        payable_no: row.payableNo, source_no: row.sourceNoSnapshot, purchase_order_no: row.purchaseOrder?.purchaseOrderNo ?? null,
        supplier_code: row.supplier.supplierCode, supplier_name: row.supplier.name,
        quantity: row.quantity.toString(), unit_price: row.unitPrice.toString(), tax_rate: row.taxRate?.toString() ?? null,
        amount: row.amount.toString(), currency: row.currency, status: row.status, confirmation_date: row.confirmationDate,
        paid_amount: paid.toString(), outstanding_amount: new Prisma.Decimal(row.amount.toString()).minus(paid).toString(),
      };
    }),
    sources: rows.map((row) => ({ business_type: "supplier_payable_entry", business_no: row.payableNo })),
  };
}

export async function getSupplierPayments(client: FinanceQueryStore, root: AgentOrderRoot, currentPage: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const rows = await client.supplierPayment.findMany({
    where: { orderNo: root.orderNo, deletedAt: null }, orderBy: { paymentDate: "desc" }, ...page(currentPage),
    // bankReference、payeeName、完整账号、附件和备注均不是订单财务事实。
    select: {
      paymentNo: true, paymentDate: true, amount: true, currency: true, paymentMethod: true, status: true,
      supplier: { select: { supplierCode: true, name: true } }, bank: { select: { bankName: true } },
      allocations: { where: { deletedAt: null }, select: { amount: true, currency: true, status: true, payableEntry: { select: { payableNo: true } } } },
    },
  });
  return {
    data: rows.map((row) => ({
      payment_no: row.paymentNo, payment_date: row.paymentDate, amount: row.amount.toString(), currency: row.currency,
      payment_method: row.paymentMethod, status: row.status, supplier_code: row.supplier.supplierCode, supplier_name: row.supplier.name,
      bank_name: row.bank?.bankName ?? null,
      allocations: row.allocations.filter((allocation) => allocation.status === "active")
        .map((allocation) => ({ payable_no: allocation.payableEntry.payableNo, amount: allocation.amount.toString(), currency: allocation.currency })),
    })),
    sources: rows.map((row) => ({ business_type: "supplier_payment", business_no: row.paymentNo })),
  };
}

export async function getReconciliations(client: FinanceQueryStore, root: AgentOrderRoot, currentPage: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const [receivables, payables] = await Promise.all([
    client.receivableReconciliation.findMany({
      where: { orderNo: root.orderNo, deletedAt: null }, orderBy: { createdAt: "desc" },
      select: {
        reconciliationNo: true, periodStart: true, periodEnd: true, receivableAmountSnapshot: true, paymentAmountSnapshot: true, adjustmentAmountSnapshot: true,
        systemBalance: true, externalBalance: true, difference: true, currency: true, status: true, createdAt: true,
        customer: { select: { customerCode: true, name: true } }, bank: { select: { bankName: true } },
      },
    }),
    client.supplierPayableReconciliation.findMany({
      where: { deletedAt: null, OR: [{ orderNo: root.orderNo }, { purchaseOrder: { is: { orderNo: root.orderNo, deletedAt: null } } }] }, orderBy: { createdAt: "desc" },
      select: {
        reconciliationNo: true, periodStart: true, periodEnd: true, payableAmountSnapshot: true, paymentAmountSnapshot: true, adjustmentAmountSnapshot: true,
        systemBalance: true, externalBalance: true, difference: true, currency: true, status: true, createdAt: true,
        supplier: { select: { supplierCode: true, name: true } }, bank: { select: { bankName: true } }, purchaseOrder: { select: { purchaseOrderNo: true } },
      },
    }),
  ]);
  const rows = [
    ...receivables.map((row) => ({ createdAt: row.createdAt, source: { business_type: "receivable_reconciliation", business_no: row.reconciliationNo }, data: {
      direction: "receivable", reconciliation_no: row.reconciliationNo, period_start: row.periodStart, period_end: row.periodEnd,
      receivable_amount: row.receivableAmountSnapshot.toString(), payment_amount: row.paymentAmountSnapshot.toString(), adjustment_amount: row.adjustmentAmountSnapshot.toString(),
      system_balance: row.systemBalance.toString(), external_balance: row.externalBalance.toString(), difference: row.difference.toString(), currency: row.currency, status: row.status,
      customer_code: row.customer.customerCode, customer_name: row.customer.name, bank_name: row.bank?.bankName ?? null,
    } })),
    ...payables.map((row) => ({ createdAt: row.createdAt, source: { business_type: "supplier_payable_reconciliation", business_no: row.reconciliationNo }, data: {
      direction: "payable", reconciliation_no: row.reconciliationNo, period_start: row.periodStart, period_end: row.periodEnd,
      payable_amount: row.payableAmountSnapshot.toString(), payment_amount: row.paymentAmountSnapshot.toString(), adjustment_amount: row.adjustmentAmountSnapshot.toString(),
      system_balance: row.systemBalance.toString(), external_balance: row.externalBalance.toString(), difference: row.difference.toString(), currency: row.currency, status: row.status,
      supplier_code: row.supplier.supplierCode, supplier_name: row.supplier.name, purchase_order_no: row.purchaseOrder?.purchaseOrderNo ?? null, bank_name: row.bank?.bankName ?? null,
    } })),
  ].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()).slice((currentPage - 1) * 20, currentPage * 20);
  return { data: rows.map((row) => row.data), sources: rows.map((row) => row.source) };
}

/**
 * 报表服务的口径映射在这里以只读 client 重建：不注入含业务凭据的服务。
 * ponytail: 此 operation 没有期间参数，因此沿用核算表的无期间语义，月度管理费不纳入。
 */
export async function getOrderCostProfit(client: FinanceQueryStore, root: AgentOrderRoot, _currentPage: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const orders = await client.salesOrder.findMany({
    where: { orderNo: root.orderNo, deletedAt: null, status: { in: ["confirmed", "closed"] } },
    select: { id: true, orderNo: true, currency: true, quantity: true, unit: true, totalAmount: true, receivableAmount: true, localCurrencyAmount: true },
  });
  if (!orders.length) {
    return { data: [{ order_no: root.orderNo, shipped: false, cost_basis: "销售利润和核算表仅纳入已确认或已关闭且已出货的订单", footnotes: [`销售单状态不在核算范围：${root.orderNo}`] }], sources: [{ business_type: "sales_order", business_no: root.orderNo }] };
  }
  const order = orders[0];
  const [outbounds, directShipments] = await Promise.all([
    client.finishedGoodsOutbound.findMany({ where: { salesOrderId: order.id, deletedAt: null, status: { in: ["posted", "shipped", "signed"] } }, select: { quantity: true } }),
    client.outsourceDirectShipment.findMany({ where: { orderNo: order.orderNo, deletedAt: null, status: "dispatched" }, select: { quantity: true } }),
  ]);
  const shippedQuantity = [...outbounds, ...directShipments].reduce((total, row) => total.plus(row.quantity.toString()), new Prisma.Decimal(0));
  if (shippedQuantity.eq(0)) {
    return { data: [{ order_no: root.orderNo, shipped: false, cost_basis: "销售利润和核算表仅纳入已出货订单", footnotes: [`尚未出货的销售单（未计入本表）：${root.orderNo}`] }], sources: [{ business_type: "sales_order", business_no: root.orderNo }] };
  }
  const costs = await new BomMaterialCostService(client as never).materialCosts([{ salesOrderId: order.id, quantity: order.quantity }]);
  const cost = costs.get(order.id);
  const labor = await client.employeeDailyReport.aggregate({ where: { orderNo: root.orderNo, deletedAt: null }, _sum: { calculatedAmount: true } });
  const orderCurrency = { currency: order.currency, totalAmount: order.totalAmount, receivableAmount: order.receivableAmount, localCurrencyAmount: order.localCurrencyAmount };
  const material = cost?.cost ?? new Prisma.Decimal(0);
  const rate = salesExchangeRate(orderCurrency);
  const materialLocal = rate ? material.mul(rate) : null;
  const laborAmount = new Prisma.Decimal(labor._sum.calculatedAmount?.toString() ?? 0);
  const totalCost = materialLocal ? materialLocal.plus(laborAmount) : laborAmount;
  const revenue = localRevenueOf(orderCurrency);
  const footnotes = [
    ...(shippedQuantity.lt(order.quantity) ? [`部分出货的销售单（本表按整单计入）：${root.orderNo}（已出 ${shippedQuantity.toString()} / 订单 ${order.quantity.toString()}${order.unit ? ` ${order.unit}` : ""}）`] : []),
    ...(cost?.missingPrice.length ? [`缺采购价物料（成本按 0 计入，毛利偏高）：${cost.missingPrice.map((item) => item.materialCode ? `${item.materialCode} ${item.materialName}` : item.materialName).join("、")}`] : []),
    ...(!cost?.hasBom ? [`没有 BOM 或 BOM 无明细的销售单（成本按 0 计入，毛利偏高）：${root.orderNo}`] : []),
    ...(revenue ? [] : [`本币收入缺失的订单（收入金额与利润留空）：${root.orderNo}`]),
  ];
  return {
    data: [{
      order_no: root.orderNo, shipped: true, currency: order.currency, sales_amount: salesAmountOf(orderCurrency)?.toString() ?? null, local_revenue_amount: revenue?.toString() ?? null,
      material_cost_amount: materialLocal?.toString() ?? null, labor_amount: laborAmount.toString(), total_cost_amount: totalCost.toString(), profit_amount: revenue?.minus(totalCost).toString() ?? null,
      cost_basis: "BOM 原料成本 + 订单关联日报人工；未指定期间，未纳入月度管理费", footnotes,
    }],
    sources: [{ business_type: "sales_order", business_no: root.orderNo }],
  };
}

export async function getOrderPayroll(client: FinanceQueryStore, root: AgentOrderRoot, currentPage: number): Promise<{ data: Record<string, unknown>[]; sources: { business_type: string; business_no: string }[] }> {
  const rows = await client.employeeDailyReport.findMany({
    where: { orderNo: root.orderNo, deletedAt: null }, orderBy: [{ reportDate: "desc" }, { id: "desc" }], ...page(currentPage),
    // 员工快照与工序快照可追溯日报；不投影身份、考勤、合同或自由备注。
    select: { id: true, reportDate: true, employeeNameSnapshot: true, operationNameSnapshot: true, wageMode: true, quantity: true, unitPrice: true, calculatedAmount: true, productionOrderOperation: { select: { unit: { select: { name: true } } } } },
  });
  return {
    data: rows.map((row) => ({ report_date: row.reportDate, employee_name: row.employeeNameSnapshot, operation_name: row.operationNameSnapshot, wage_mode: row.wageMode, quantity: row.quantity.toString(), unit: row.productionOrderOperation.unit?.name ?? null, unit_price: row.unitPrice.toString(), amount: row.calculatedAmount.toString() })),
    sources: rows.map((row) => ({ business_type: "employee_daily_report", business_no: row.id })),
  };
}
