import { BadRequestException } from "@nestjs/common";
import type { Prisma, PrismaClient } from "@prisma/client";
import { normalizeKeyword } from "./normalize";

export const LIST_DOCUMENTS_MAX_ROWS = 20;
export const SALES_ORDER_STATUSES = ["draft", "confirmed", "closed"] as const;

export type ListDocumentsInput = {
  status?: string;
  customerQ?: string;
  productQ?: string;
  from?: string;
  to?: string;
  page: number;
};

export type ListDocumentsStore = Pick<PrismaClient, "salesOrder">;

const ALLOWED_KEYS = ["status", "customer_q", "product_q", "from", "to", "page"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(message: string) {
  return new BadRequestException({ code: "AGENT_TOOL_ARGUMENT_INVALID", message, details: [] });
}

export function parseListDocumentsInput(raw: unknown): ListDocumentsInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("参数必须是 JSON 对象");
  const record = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !ALLOWED_KEYS.includes(key));
  if (unknownKeys.length > 0) throw badRequest(`不接受参数字段：${unknownKeys.join(", ")}`);

  const input: ListDocumentsInput = { page: 1 };

  if (record.status !== undefined) {
    if (typeof record.status !== "string") throw badRequest("status 必须是字符串");
    const status = normalizeKeyword(record.status).toLowerCase();
    if (!(SALES_ORDER_STATUSES as readonly string[]).includes(status)) {
      throw badRequest(`status 必须是 ${SALES_ORDER_STATUSES.join(" / ")} 之一，收到 ${record.status}`);
    }
    input.status = status;
  }

  for (const [key, field] of [["customer_q", "customerQ"], ["product_q", "productQ"]] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim().length === 0) throw badRequest(`${key} 必须是非空字符串`);
    if (value.length > 100) throw badRequest(`${key} 不能超过 100 个字符`);
    input[field] = normalizeKeyword(value);
  }

  for (const key of ["from", "to"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !ISO_DATE.test(value)) throw badRequest(`${key} 必须是 YYYY-MM-DD 格式的日期`);
    if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw badRequest(`${key} 不是合法日期：${value}`);
    input[key] = value;
  }

  if (record.page !== undefined) {
    if (typeof record.page !== "number" || !Number.isInteger(record.page) || record.page < 1 || record.page > 1000) {
      throw badRequest("page 必须是 1 到 1000 的整数");
    }
    input.page = record.page;
  }
  return input;
}

export async function listDocuments(client: ListDocumentsStore, input: ListDocumentsInput) {
  const where: Prisma.SalesOrderWhereInput = { deletedAt: null };
  if (input.status !== undefined) where.status = input.status;
  if (input.productQ !== undefined) where.productName = { contains: input.productQ, mode: "insensitive" };
  if (input.customerQ !== undefined) where.customerSnapshot = { path: ["name"], string_contains: input.customerQ };
  if (input.from !== undefined || input.to !== undefined) {
    where.updatedAt = {
      ...(input.from !== undefined ? { gte: new Date(`${input.from}T00:00:00Z`) } : {}),
      ...(input.to !== undefined ? { lte: new Date(`${input.to}T23:59:59Z`) } : {}),
    };
  }

  const rows = await client.salesOrder.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    skip: (input.page - 1) * LIST_DOCUMENTS_MAX_ROWS,
    take: LIST_DOCUMENTS_MAX_ROWS,
    select: {
      orderNo: true,
      productName: true,
      quantity: true,
      unit: true,
      status: true,
      deliveryDate: true,
      orderDate: true,
      customerSnapshot: true,
      updatedAt: true,
    },
  });

  return rows.map((row) => {
    const snapshot = row.customerSnapshot && typeof row.customerSnapshot === "object" ? (row.customerSnapshot as { name?: unknown }) : {};
    return {
      order_no: row.orderNo,
      product_name: row.productName,
      quantity: row.quantity.toString(),
      unit: row.unit,
      status: row.status,
      customer_name: typeof snapshot.name === "string" ? snapshot.name : null,
      order_date: row.orderDate instanceof Date ? row.orderDate.toISOString().slice(0, 10) : row.orderDate,
      delivery_date: row.deliveryDate instanceof Date ? row.deliveryDate.toISOString().slice(0, 10) : row.deliveryDate,
    };
  });
}

export function buildListDocumentsFactSources(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({ business_type: "sales_order", business_no: String(row.order_no), queried_at: new Date().toISOString() }));
}