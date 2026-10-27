import { BadRequestException } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";

/**
 * 按号检索任意单据（R-1）：销售单号、采购单号、生产单号都能作为入口。
 *
 * 为什么需要它：以前只有 `search_orders`，而所有根查询都以**销售单号**为根。用户手里只有
 * 采购单号时，检索必然 0 行，后面每一步都被守卫拒掉，界面看起来就是「问采购却查销售」。
 * 这里把入口放宽到三类单号，但每行仍然落回「所属销售单号」——根不变，只是入口变多。
 *
 * 顺序与去重（同一关键字可能同时命中多张单）：销售单 → 采购单 → 生产单；
 * 同一张销售单只出一行，其余命中的单据折叠进 `related_documents`。
 */

export const SEARCH_DOCUMENTS_MAX_ROWS = 20;

export type DocumentSearchInput = { q: string; page: number };

export type DocumentSearchStore = Pick<PrismaClient, "salesOrder" | "purchaseOrder" | "productionOrder">;

function badRequest(message: string) {
  return new BadRequestException({ code: "AGENT_TOOL_ARGUMENT_INVALID", message, details: [] });
}

/** 与 search_orders 同一套输入口径：固定 schema、q 必填、页码 1..1000。 */
export function parseSearchDocumentsInput(raw: unknown): DocumentSearchInput {
  if (raw === null || typeof raw !== "object") throw badRequest("参数必须是 JSON 对象");
  const { q, page } = raw as { q?: unknown; page?: unknown };
  const unknownKeys = Object.keys(raw as Record<string, unknown>).filter((key) => !["q", "page"].includes(key));
  if (unknownKeys.length > 0) throw badRequest(`不接受参数字段：${unknownKeys.join(", ")}`);
  if (typeof q !== "string" || q.trim().length === 0) throw badRequest("搜索词 q 不能为空");
  if (q.length > 100) throw badRequest("搜索词 q 不能超过 100 个字符");
  if (page !== undefined && (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 1000)) throw badRequest("page 必须是 1 到 1000 的整数");
  return { q: q.trim(), page: page ?? 1 };
}

type Row = Record<string, unknown> & { sales_order_no: string; related_documents: { document_type: string; document_no: string }[] };

export async function searchDocuments(client: DocumentSearchStore, input: DocumentSearchInput): Promise<Record<string, unknown>[]> {
  const take = SEARCH_DOCUMENTS_MAX_ROWS;
  const contains = input.q;
  const [sales, purchases, productions] = await Promise.all([
    client.salesOrder.findMany({
      where: { deletedAt: null, orderNo: { contains } },
      orderBy: { updatedAt: "desc" },
      take,
      select: { orderNo: true, productName: true, quantity: true, unit: true, status: true, deliveryDate: true, updatedAt: true },
    }),
    client.purchaseOrder.findMany({
      where: { deletedAt: null, OR: [{ purchaseOrderNo: { contains } }, { orderNo: { contains } }] },
      orderBy: { updatedAt: "desc" },
      take,
      select: { purchaseOrderNo: true, orderNo: true, status: true, purchaseDate: true, expectedDate: true, updatedAt: true },
    }),
    client.productionOrder.findMany({
      where: { deletedAt: null, OR: [{ productionOrderNo: { contains } }, { orderNo: { contains } }] },
      orderBy: { updatedAt: "desc" },
      take,
      select: { productionOrderNo: true, orderNo: true, status: true, plannedQuantity: true, updatedAt: true },
    }),
  ]);

  const rows: Row[] = [];
  const byOrder = new Map<string, Row>();
  const add = (row: Row) => {
    const existing = byOrder.get(row.sales_order_no);
    if (existing) {
      existing.related_documents.push({ document_type: String(row.document_type), document_no: String(row.document_no) });
      return;
    }
    byOrder.set(row.sales_order_no, row);
    rows.push(row);
  };

  for (const row of sales) {
    add({
      document_type: "sales_order",
      document_no: row.orderNo,
      sales_order_no: row.orderNo,
      product_name: row.productName,
      quantity: row.quantity.toString(),
      unit: row.unit,
      status: row.status,
      delivery_date: row.deliveryDate instanceof Date ? row.deliveryDate.toISOString() : row.deliveryDate,
      updated_at: row.updatedAt,
      related_documents: [],
    });
  }
  for (const row of purchases) {
    add({
      document_type: "purchase_order",
      document_no: row.purchaseOrderNo,
      sales_order_no: row.orderNo,
      status: row.status,
      purchase_date: row.purchaseDate,
      expected_date: row.expectedDate,
      updated_at: row.updatedAt,
      related_documents: [],
    });
  }
  for (const row of productions) {
    add({
      document_type: "production_order",
      document_no: row.productionOrderNo,
      sales_order_no: row.orderNo,
      status: row.status,
      planned_quantity: row.plannedQuantity?.toString() ?? null,
      updated_at: row.updatedAt,
      related_documents: [],
    });
  }
  return rows.slice(0, SEARCH_DOCUMENTS_MAX_ROWS);
}
