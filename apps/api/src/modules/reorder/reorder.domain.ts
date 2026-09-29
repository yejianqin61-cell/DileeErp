import { Prisma } from "@prisma/client";

/**
 * 返单与总结模块的**纯计算**部分：归并、分行汇总、合格率。
 *
 * 为什么把这些抽出来：货号清单的聚合有一处**必须**在内存里做（见 `mergeArticles` 的注释），
 * 而"在内存里算"最容易糊掉的正是口径（跨单位相加、分母为 0 给 0）。抽成纯函数之后，
 * 这些口径可以用普通单测逐条钉住，不必起库。
 */

/** 按单位分行的数量。**全站口径：不跨单位合计**（支 + 打 相加没有意义）。 */
export type UnitQuantity = { unit: string; quantity: string };
/** 按币种分行的金额。**不跨币种合计**。 */
export type CurrencyAmount = { currency: string; amount: string };

/** 一张销售单的轻字段（货号清单只需要这些）。 */
export type ArticleOrderRow = {
  id: string;
  orderNo: string;
  itemNo: string | null;
  orderDate: Date;
  deliveryDate: Date | null;
  status: string;
  currentVersion: number;
  quantity: Prisma.Decimal;
  unit: string;
  currency: string;
  productName: string;
  customerId: string;
  customerName: string | null;
  /** 返单来源单号（T05）；详情里要显示「这批是从哪返来的」。 */
  reorderFromOrderNo: string | null;
};

export type MergedArticle = {
  /** 组内出现最多的那种写法（展示用；**不是**匹配键）。 */
  itemNo: string;
  itemNoKey: string;
  orderCount: number;
  orderNos: string[];
  customerNames: string[];
  firstOrderDate: string | null;
  lastOrderDate: string | null;
  lastDeliveryDate: string | null;
  quantities: UnitQuantity[];
};

/** 还没走完的生产状态 —— 「在制批次数」按它算。 */
export const OPEN_PRODUCTION_STATUSES = ["draft", "in_progress", "paused"] as const;

/**
 * 「已出库」的状态清单 —— 与工作台同一份口径（`order-workbench.service.ts` 里那段注释）：
 * 草稿是**待出库**，`cancelled` / `reversed` 都不算，把它们累加会报出虚高的已出库量。
 */
export const SHIPPED_OUTBOUND_STATUSES = ["posted", "shipped", "signed"] as const;

const toIso = (value: Date | null | undefined): string | null => (value ? new Date(value).toISOString() : null);
const decimalString = (value: { toString(): string } | null | undefined): string => value?.toString() ?? "0";

/**
 * 排序比较器：按**码位**比，不用 `localeCompare`。
 *
 * 为什么不用 localeCompare：它受运行环境的 ICU 与 locale 影响（同一组中文字符在不同 Node/系统上
 * 可能给出不同顺序）。这里的排序进的是 API 响应与分页，顺序不稳定意味着「同一页里行的先后
 * 换台机器就变」，而测试也会跟着变成环境相关。
 */
const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** 分组键：与销售单侧的归一函数同义（trim + 去空白 + 大写），在 `mergeArticles` 里由调用方传入。 */
export type ItemNoKeyFn = (value: string | null | undefined) => string;

/** 按单位分行求和。单位为空归到 `""` 行 —— 保留它，别把它算进别的单位。 */
export function sumByUnit(rows: Array<{ unit: string | null | undefined; quantity: { toString(): string } | null | undefined }>): UnitQuantity[] {
  const totals = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    const unit = (row.unit ?? "").trim();
    const quantity = new Prisma.Decimal(row.quantity?.toString() ?? 0);
    totals.set(unit, (totals.get(unit) ?? new Prisma.Decimal(0)).plus(quantity));
  }
  return [...totals.entries()].map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })).sort((left, right) => byCodeUnit(left.unit, right.unit));
}

/** 按币种分行求和。 */
export function sumByCurrency(rows: Array<{ currency: string | null | undefined; amount: { toString(): string } | null | undefined }>): CurrencyAmount[] {
  const totals = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    const currency = (row.currency ?? "").trim();
    const amount = new Prisma.Decimal(row.amount?.toString() ?? 0);
    totals.set(currency, (totals.get(currency) ?? new Prisma.Decimal(0)).plus(amount));
  }
  return [...totals.entries()].map(([currency, amount]) => ({ currency, amount: amount.toString() })).sort((left, right) => byCodeUnit(left.currency, right.currency));
}

/**
 * 合格率 = 合格 / 受检。
 *
 * **受检为 0 时返回 `null`，不是 `0`**：没有质检事实与"全部不合格"是两件完全不同的事，
 * 用 `0` 冒充会让业务以为这个货的质量崩了。前端把 `null` 显示成 `-`。
 */
export function qualifiedRate(inspected: { toString(): string } | null | undefined, qualified: { toString(): string } | null | undefined): string | null {
  const denominator = new Prisma.Decimal(inspected?.toString() ?? 0);
  if (denominator.eq(0)) return null;
  return new Prisma.Decimal(qualified?.toString() ?? 0).div(denominator).toDecimalPlaces(4).toString();
}

/**
 * 按货号归并订单 —— **必须在内存里做**。
 *
 * `prisma.salesOrder.groupBy({ by: ["itemNo"] })` 是按**列值**分组，`27621` 与 `27621␠`
 * 会分成两行，而它们按业务是同一个货号；Prisma 又不支持按表达式分组。
 * 不归并的后果正是老板要「调取该货号」时最怕的事：查 `27621` 只看到两批，另外三批躲在 `27621␠` 底下。
 *
 * 允许全量拉轻字段的理由：销售单是千级规模，轻字段的一次查询远低于"把分组算错"的代价；
 * 真正贵的是下游聚合，那只对当前页的货号做（见 `ReorderService.enrich`）。
 * **将来销售单过万**时再换成 `$queryRaw` 的 `upper(btrim(...))` 表达式分组 —— 升级点在这里。
 *
 * 排序：最近下单的货号排前面（返单页最常见的问题是"上次那个货最近做的是哪批"）；
 * 同一时间按归一键升序，保证分页稳定（不稳定排序会让第 2 页重复或漏行）。
 */
export function mergeArticles(rows: ArticleOrderRow[], keyOf: ItemNoKeyFn): MergedArticle[] {
  const groups = new Map<string, { rows: ArticleOrderRow[]; spellings: Map<string, number> }>();
  for (const row of rows) {
    const key = keyOf(row.itemNo);
    if (!key) continue; // 没有货号的订单不属于任何货号（它们走 unassigned-orders 那条路）
    const group = groups.get(key) ?? { rows: [], spellings: new Map<string, number>() };
    group.rows.push(row);
    const spelling = (row.itemNo ?? "").trim();
    group.spellings.set(spelling, (group.spellings.get(spelling) ?? 0) + 1);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([itemNoKey, group]) => {
      const sorted = [...group.rows].sort((left, right) => new Date(left.orderDate).getTime() - new Date(right.orderDate).getTime() || byCodeUnit(left.orderNo, right.orderNo));
      const dates = sorted.map((row) => new Date(row.orderDate).getTime());
      const deliveryDates = sorted.map((row) => (row.deliveryDate ? new Date(row.deliveryDate).getTime() : null)).filter((value): value is number => value !== null);
      const spellings = [...group.spellings.entries()].sort((left, right) => right[1] - left[1] || byCodeUnit(left[0], right[0]));
      return {
        itemNo: spellings[0]?.[0] ?? "",
        itemNoKey,
        orderCount: sorted.length,
        orderNos: sorted.map((row) => row.orderNo),
        customerNames: [...new Set(sorted.map((row) => row.customerName ?? "").filter(Boolean))].sort(byCodeUnit),
        firstOrderDate: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
        lastOrderDate: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
        lastDeliveryDate: deliveryDates.length ? new Date(Math.max(...deliveryDates)).toISOString() : null,
        quantities: sumByUnit(sorted),
      };
    })
    .sort((left, right) => (right.lastOrderDate ?? "").localeCompare(left.lastOrderDate ?? "") || byCodeUnit(left.itemNoKey, right.itemNoKey));
}

/** 一张「待补货号」的订单行（`GET /reorder/unassigned-orders`）。 */
export function unassignedOrderRow(row: ArticleOrderRow) {
  return {
    sales_order_id: row.id,
    order_no: row.orderNo,
    customer_name: row.customerName,
    product_name: row.productName,
    quantity: decimalString(row.quantity),
    unit: row.unit,
    order_date: toIso(row.orderDate),
    status: row.status,
  };
}

// ---------------------------------------------------------------- 单据清单（T09）

/**
 * 单据分组的**稳定枚举**：前端按 `document_type` 映射跳转路径，API **不拼 URL**
 * （跳转是展示层的事；把路径写进接口就意味着改一次前端路由要动后端）。
 *
 * 顺序 = 页面上的分组顺序 = 这批货实际走的顺序（BOM → 采购 → 到货 → 质检 → 入库 → 生产 →
 * 领料 → 日报 → 送检 → QC → 入库 → 次品 → 出库 → 财务）。
 */
export const DOCUMENT_GROUPS = [
  { type: "bom", label: "BOM 表" },
  { type: "purchase_order", label: "采购单" },
  { type: "purchase_receipt", label: "采购到货" },
  { type: "incoming_inspection", label: "来料质检" },
  { type: "raw_material_inbound", label: "原料入库" },
  { type: "production_order", label: "生产单" },
  { type: "material_movement", label: "领料 / 补料 / 退料" },
  { type: "operation_daily_report", label: "工序日报" },
  { type: "finished_submission", label: "成品送检" },
  { type: "finished_qc", label: "成品 QC" },
  { type: "finished_inbound_notice", label: "成品入库通知" },
  { type: "finished_inbound", label: "成品入库" },
  { type: "finished_defective", label: "次品" },
  { type: "finished_outbound", label: "成品出库" },
  { type: "receivable", label: "应收来源" },
  { type: "payable_source", label: "应付来源（待财务）" },
  { type: "supplier_payable", label: "应付单" },
] as const;

export type DocumentType = (typeof DOCUMENT_GROUPS)[number]["type"];

/**
 * 单据状态 → 中文。**本页只有这一份映射**（工作台也不给 status_label）。
 *
 * 认不出来的状态**原样返回状态码**而不是空字符串：空着会让人以为"这张单没有状态"，
 * 而状态码至少能拿去搜代码。新增状态时在这里补一行即可。
 */
export const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  draft: "草稿", submitted: "已提交", pending: "待处理", pending_outbound: "待出库", pending_finance: "待财务",
  ordered: "已下单", received: "已到货", inspecting: "质检中", completed: "已完成", accepted: "全部入库",
  conditionally_accepted: "条件接收", partially_accepted: "部分入库", rejected: "拒收", cancelled: "已取消",
  in_progress: "生产中", paused: "已暂停", closed: "已关闭", active: "有效", posted: "已过账",
  shipped: "已发出", signed: "已签收", reversed: "已红冲", confirmed: "已确认", outbound_created: "已建出库单",
  partially_outbound: "已部分出库", pending_reconciliation: "待对账", reconciled: "已对账", paid: "已付款",
};

export function documentStatusLabel(status: string | null | undefined): string {
  const key = (status ?? "").trim();
  if (!key) return "";
  return DOCUMENT_STATUS_LABELS[key] ?? key;
}

/**
 * 一条单据行。
 *
 * `date_source` 说明**这个日期是哪个日期**：仓库那几张表（原料入库/成品入库/次品/来料质检）
 * 根本没有业务日期列，只能回落 `createdAt`。不标出来的话，业务会把"登记时间"当成真实业务日期 ——
 * 而这两者在月末对账时差一天就是两个月的数。
 */
export type DocumentRow = {
  document_no: string | null;
  date: string | null;
  date_source: "business" | "created_at" | "none";
  quantity: string | null;
  unit: string | null;
  status: string;
  status_label: string;
  source_id: string;
  extra: Record<string, unknown>;
};

/** 组装一条单据行：把"哪个日期、数量字符串化、状态中文"这三件事收在一处，免得 17 组各写一遍。 */
export function documentRow(input: {
  documentNo?: string | null;
  businessDate?: Date | null;
  createdAt?: Date | null;
  quantity?: { toString(): string } | null;
  unit?: string | null;
  status?: string | null;
  sourceId: string;
  extra?: Record<string, unknown>;
}): DocumentRow {
  const business = input.businessDate ? new Date(input.businessDate) : null;
  const created = input.createdAt ? new Date(input.createdAt) : null;
  const date = business ?? created;
  return {
    document_no: input.documentNo ?? null,
    date: date ? date.toISOString() : null,
    date_source: business ? "business" : created ? "created_at" : "none",
    quantity: input.quantity === null || input.quantity === undefined ? null : input.quantity.toString(),
    unit: input.unit ?? null,
    status: input.status ?? "",
    status_label: documentStatusLabel(input.status),
    source_id: input.sourceId,
    extra: input.extra ?? {},
  };
}

/** 时间线上限：老板要的是"查得到"，静默截断会让人以为这就是全部 —— 所以同时回报 `truncated`。 */
export const TIMELINE_LIMIT = 200;
