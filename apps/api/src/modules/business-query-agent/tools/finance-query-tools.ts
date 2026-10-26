import { Prisma, type PrismaClient } from "@prisma/client";
import type { AgentOrderRoot } from "./order-root";

/**
 * 财务领域只读查询。财务事实只会在 full 档经 ToolExecutor 的 capability
 * 闸门到达这里；本文件仍使用 Agent 的只读 client 和窄 DTO，不复用会带
 * 写依赖或自由备注的领域服务返回。
 */
export type FinanceQueryStore = Pick<PrismaClient, "receivableSource" | "customerPayment">;

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
