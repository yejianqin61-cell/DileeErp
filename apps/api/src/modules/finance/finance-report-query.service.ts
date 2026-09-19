import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../platform/database/prisma.service";
import { compareAccountingSubjects } from "./accounting-subject-catalog";
import { BomMaterialCostService } from "./finance-report-cost.service";
import { LOCAL_CURRENCY, receivableOutstanding, salesAmountOf } from "./finance-report.domain";
import { financeDayRange } from "./finance-period";
import { adjustmentNet } from "./receivable-adjustment.domain";
import { footnoteLines } from "./finance-report.tables";
import {
  compareText,
  forexOutstanding,
  forexUnattributedFootnotes,
  lastDate,
  sumDecimals,
} from "./finance-report-forex.tables";
import type { FinanceReportFilter } from "./finance-report.types";
import type {
  CashFlowDetailSource,
  CashFlowSummaryAmount,
  PurchaseReconciliationDetailSource,
  SalesGrossProfitSource,
  SalesReconciliationDetailSource,
  SalesReconciliationSummarySource,
} from "./finance-report.tables";
import type {
  ForexOutbound,
  ForexReceiptEntry,
  ForexReceiptRow,
  ForexUnattributed,
  ForexUnattributedReason,
} from "./finance-report-forex.tables";

/**
 * 财务报表取数。
 *
 * 只做「查事实 + 扁平化」，不算任何口径：汇率/本币/留空等在
 * `finance-report.tables.ts` 与 `finance-report.domain.ts`（纯函数，可单测）。
 *
 * 默认**不含草稿**：草稿应收/应付还没确认，算进对账金额会让欠款虚高
 * （与既有「已付/未付只算已过账」的口径一致）。已取消/已冲销的来源同样不进报表。
 */

/** 单次导出行数上限。超出必须报错，不能静默截断（否则用户以为导出是全量）。 */
export const MAX_REPORT_ROWS = 20000;

/** 默认纳入报表的应收状态（不含 draft / cancelled）。 */
const SALES_REPORT_STATUSES = ["confirmed", "partially_paid", "paid"] as const;
/** 默认纳入报表的应付状态（不含 draft / 已冲销）。 */
const PAYABLE_REPORT_STATUSES = ["confirmed", "partially_paid", "paid"] as const;
/** 默认纳入利润表的销售单状态（draft 未确认，closed 是已交付关闭，都算已成立的口径）。 */
const SALES_ORDER_STATUSES = ["confirmed", "closed"] as const;

/**
 * 外汇一览表的归属输入（一次性读回来的三张表 + 两个派生索引）。
 *
 * 单独成类型而不是散在方法里：`forexAttributionInputs` 读、`attributeForexEntry` 用，
 * 两边必须对同一组字段有同一个理解，散着写迟早会有一处用错字段（比如把 `sourcesByOrder`
 * 当成「按来源 id」查）。
 */
type ForexAttributionInputs = {
  /** 应收来源 id → 它自己（订单号、客户、币种）。 */
  sourcesById: Map<string, { id: string; orderNo: string; customerId: string; currency: string }>;
  /** 对账单 id → 客户/订单号。按对账确认的流水只能从这个方向反查客户。 */
  reconciliationsById: Map<string, { id: string; orderNo: string | null; customerId: string }>;
  /** 订单号 → 该订单的出库候选，**已按「出货日期 → 出库单号」排好序**（第一个就是「第一次出库」）。 */
  sourcesByOrder: Map<string, ForexOutbound[]>;
  /** 应收来源 id → 出库 id：算「累计已收」时要按 `source_id` 反查同一批出库。 */
  sourcesByIdAll: Map<string, string>;
  /** 订单号 → 客户 id（订单还没有出库时也要能按客户筛）。 */
  orderCustomer: Map<string, string>;
  /** 本次牵涉到的全部订单号。 */
  orderNos: string[];
};

/** 日期是否落在期间内。没给期间 = 全都算落在期间内（与 `financeDayRange` 的空语义一致）。 */
function withinPeriod(date: Date, period: { gte?: Date; lte?: Date } | null): boolean {
  if (!period) return true;
  if (period.gte && date.valueOf() < period.gte.valueOf()) return false;
  if (period.lte && date.valueOf() > period.lte.valueOf()) return false;
  return true;
}

@Injectable()
export class FinanceReportQueryService {
  constructor(private readonly prisma: PrismaService, private readonly cost: BomMaterialCostService) {}

  /**
   * 币种代码 → 中文标签。
   *
   * 老表「币种」列写的是「美元」「人民币」，库里存的是 `USD`/`CNY`。
   * **不过滤 `isActive`**：历史单据上的币种即使后来被停用，也必须还能显示成中文，
   * 不能因为停用就回落成代码。
   */
  async currencyLabels(): Promise<Map<string, string>> {
    const items = await this.prisma.dictionaryItem.findMany({
      where: { deletedAt: null, type: { key: "currency", deletedAt: null } },
      select: { key: true, label: true },
    });
    return new Map(items.map((item) => [item.key, item.label]));
  }

  /** 销售对账明细表取数（主表 = 应收来源，一条 = 一次成品出库过账）。 */
  async salesReconciliationDetail(filter: FinanceReportFilter): Promise<SalesReconciliationDetailSource[]> {
    const period = financeDayRange(filter.from, filter.to);
    const rows = await this.prisma.receivableSource.findMany({
      where: {
        deletedAt: null,
        status: { in: this.statuses(SALES_REPORT_STATUSES, filter.includeDraft) },
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.orderNo ? { orderNo: filter.orderNo } : {}),
        ...(filter.currency ? { currency: filter.currency } : {}),
        // 期间与「日期」列同源（销售单日期）：筛选和显示必须同源，
        // 否则会出现「页面上筛的是 A 期间、导出的日期却落在 B 期间」。
        ...(period ? { salesOrder: { orderDate: period } } : {}),
      },
      include: {
        customer: { select: { name: true } },
        outbound: { select: { productNameSnapshot: true, productSpecificationSnapshot: true } },
        salesOrder: { select: { orderDate: true, currency: true, totalAmount: true, receivableAmount: true, localCurrencyAmount: true } },
      },
      orderBy: [{ orderNo: "asc" }, { sourceNo: "asc" }],
    });
    this.assertWithinLimit(rows.length);
    return rows.map((row) => ({
      date: row.salesOrder?.orderDate ?? null,
      orderNo: row.orderNo,
      customerName: row.customer?.name ?? null,
      productName: row.outbound?.productNameSnapshot ?? null,
      productSpecification: row.outbound?.productSpecificationSnapshot ?? null,
      unit: row.unit,
      currency: row.currency,
      unitPrice: row.unitPrice,
      quantity: row.quantity,
      amount: row.amount,
      order: row.salesOrder
        ? {
            currency: row.salesOrder.currency,
            totalAmount: row.salesOrder.totalAmount,
            receivableAmount: row.salesOrder.receivableAmount,
            localCurrencyAmount: row.salesOrder.localCurrencyAmount,
          }
        : null,
    }));
  }

  /** 采购对账明细表取数（主表 = 应付条目，与销售侧的「应收来源」对称）。 */
  async purchaseReconciliationDetail(filter: FinanceReportFilter): Promise<PurchaseReconciliationDetailSource[]> {
    const period = financeDayRange(filter.from, filter.to);
    const rows = await this.prisma.supplierPayableEntry.findMany({
      where: {
        deletedAt: null,
        status: { in: this.statuses(PAYABLE_REPORT_STATUSES, filter.includeDraft) },
        ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
        ...(filter.orderNo ? { orderNo: filter.orderNo } : {}),
        ...(filter.currency ? { currency: filter.currency } : {}),
        // 「日期」列 = 采购单的采购日期，为空时回落应付条目创建时间；
        // 过滤条件必须覆盖这两种情况，否则采购日期为空的历史条目会被静默漏掉。
        ...(period
          ? {
              OR: [
                { purchaseOrder: { purchaseDate: period } },
                { purchaseOrder: { purchaseDate: null }, createdAt: period },
                { purchaseOrderId: null, createdAt: period },
              ],
            }
          : {}),
      },
      include: {
        supplier: { select: { name: true } },
        purchaseOrder: { select: { purchaseOrderNo: true, purchaseDate: true } },
        payableSource: {
          select: {
            purchaseOrder: { select: { purchaseOrderNo: true, purchaseDate: true } },
            purchaseOrderItem: {
              select: {
                materialSnapshot: true,
                material: { select: { materialCode: true, name: true, specificationModel: true } },
                unit: { select: { name: true } },
              },
            },
          },
        },
        outsourcePayableSource: {
          select: {
            purchaseOrder: { select: { purchaseOrderNo: true, purchaseDate: true } },
            logisticsBatch: {
              select: {
                material: { select: { materialCode: true, name: true, specificationModel: true } },
                unit: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: "asc" }],
    });
    this.assertWithinLimit(rows.length);
    return rows.map((row) => {
      const item = row.payableSource?.purchaseOrderItem ?? null;
      // 外加工签收形成的应付没有采购明细，物料挂在物流批次的原料上。
      const material = item?.material ?? row.outsourcePayableSource?.logisticsBatch?.material ?? null;
      // 采购单关联优先取应付条目自己的（应付来源可能早于该字段落库，故保留来源回退）。
      const order =
        row.purchaseOrder ?? row.payableSource?.purchaseOrder ?? row.outsourcePayableSource?.purchaseOrder ?? null;
      const snapshot = (item?.materialSnapshot ?? null) as { name?: string; specificationModel?: string | null } | null;
      return {
        date: order?.purchaseDate ?? row.createdAt,
        purchaseOrderNo: order?.purchaseOrderNo ?? null,
        supplierName: row.supplier?.name ?? null,
        productName: material?.name ?? snapshot?.name ?? null,
        materialCode: material?.materialCode ?? null,
        specification: material?.specificationModel ?? snapshot?.specificationModel ?? null,
        unit: item?.unit?.name ?? row.outsourcePayableSource?.logisticsBatch?.unit?.name ?? null,
        currency: row.currency,
        unitPrice: row.unitPrice,
        quantity: row.quantity,
        amount: row.amount,
      };
    });
  }

  /**
   * 销售对账汇总表取数：**按销售单汇总**（R4）。
   *
   * 以应收来源为基准分组（而不是以销售单为基准左连接）：这样「出现在表里的」恰好是
   * 「有纳入对账的应收来源的」销售单，销售金额天然等于明细表里同一销售单的金额合计，
   * 两张表的总额一定对得上。
   */
  async salesReconciliationSummary(filter: FinanceReportFilter): Promise<SalesReconciliationSummarySource[]> {
    const period = financeDayRange(filter.from, filter.to);
    const sources = await this.prisma.receivableSource.findMany({
      where: {
        deletedAt: null,
        status: { in: this.statuses(SALES_REPORT_STATUSES, filter.includeDraft) },
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.orderNo ? { orderNo: filter.orderNo } : {}),
        ...(filter.currency ? { currency: filter.currency } : {}),
        ...(period ? { salesOrder: { orderDate: period } } : {}),
      },
      select: {
        orderNo: true,
        amount: true,
        currency: true,
        customer: { select: { name: true } },
        salesOrder: { select: { orderDate: true } },
        allocations: { where: { deletedAt: null }, select: { amount: true, status: true, payment: { select: { status: true } } } },
      },
      orderBy: [{ orderNo: "asc" }, { sourceNo: "asc" }],
    });

    const grouped = new Map<string, { orderNo: string; date: Date | null; customerName: string | null; currency: string | null; salesAmount: Prisma.Decimal; paidAmount: Prisma.Decimal }>();
    for (const row of sources) {
      const current = grouped.get(row.orderNo) ?? {
        orderNo: row.orderNo,
        date: row.salesOrder?.orderDate ?? null,
        customerName: row.customer?.name ?? null,
        currency: row.currency,
        salesAmount: new Prisma.Decimal(0),
        paidAmount: new Prisma.Decimal(0),
      };
      current.salesAmount = current.salesAmount.plus(row.amount);
      // 已收只算「有效核销（status=active）且付款已过账」，与全站已收/未收口径一致。
      const paid = row.allocations
        .filter((item) => item.status === "active" && item.payment?.status === "posted")
        .reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
      current.paidAmount = current.paidAmount.plus(paid);
      grouped.set(row.orderNo, current);
    }
    this.assertWithinLimit(grouped.size);

    const adjustments = await this.postedAdjustments([...grouped.keys()]);
    return [...grouped.values()].map((row) => {
      const rows = adjustments.get(row.orderNo) ?? [];
      return {
        date: row.date,
        orderNo: row.orderNo,
        customerName: row.customerName,
        currency: row.currency,
        salesAmount: row.salesAmount,
        adjustmentNet: adjustmentNet(rows),
        paidAmount: row.paidAmount,
        outstandingAmount: receivableOutstanding(row.salesAmount, row.paidAmount, rows),
      };
    });
  }

  /**
   * 销售利润报表(毛利)取数：一个销售单一行，成本 = BOM 原料成本（R5）。
   *
   * 与对账表不同，这里以**销售单**为基准（已确认/已关闭）：毛利是订单级的经营指标，
   * 不依赖是否已出库。`include_draft=true` 时把草稿销售单也算进来。
   *
   * 返回表尾说明：缺采购价物料、没有 BOM 的销售单 —— 这两种情况都会让成本少算、毛利虚高，
   * 必须在导出文件里说清楚，否则从表上看不出来。
   */
  async salesGrossProfit(filter: FinanceReportFilter): Promise<{ rows: SalesGrossProfitSource[]; footnotes: string[] }> {
    const period = financeDayRange(filter.from, filter.to);
    const orders = await this.prisma.salesOrder.findMany({
      where: {
        deletedAt: null,
        status: { in: this.statuses(SALES_ORDER_STATUSES, filter.includeDraft) },
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.orderNo ? { orderNo: filter.orderNo } : {}),
        ...(filter.currency ? { currency: filter.currency } : {}),
        ...(period ? { orderDate: period } : {}),
      },
      select: {
        id: true,
        orderNo: true,
        orderDate: true,
        currency: true,
        quantity: true,
        totalAmount: true,
        receivableAmount: true,
        localCurrencyAmount: true,
        customer: { select: { name: true } },
      },
      orderBy: [{ orderDate: "asc" }, { orderNo: "asc" }],
    });
    this.assertWithinLimit(orders.length);

    const costs = await this.cost.materialCosts(orders.map((order) => ({ salesOrderId: order.id, quantity: order.quantity })));
    const rows: SalesGrossProfitSource[] = orders.map((order) => ({
      date: order.orderDate,
      orderNo: order.orderNo,
      customerName: order.customer?.name ?? null,
      currency: order.currency,
      salesAmount: salesAmountOf(order),
      costAmount: costs.get(order.id)?.cost ?? new Prisma.Decimal(0),
      order: { currency: order.currency, totalAmount: order.totalAmount, receivableAmount: order.receivableAmount, localCurrencyAmount: order.localCurrencyAmount },
    }));

    const missing = new Map<string, string>();
    for (const order of orders) {
      for (const item of costs.get(order.id)?.missingPrice ?? []) {
        missing.set(`${item.materialCode}|${item.materialName}`, item.materialCode ? `${item.materialCode} ${item.materialName}` : item.materialName);
      }
    }
    const footnotes = [
      ...footnoteLines("缺采购价物料（成本按 0 计入，毛利偏高）", [...missing.values()]),
      ...footnoteLines("没有 BOM 或 BOM 无明细的销售单（成本按 0 计入，毛利偏高）", orders.filter((order) => !costs.get(order.id)?.hasBom).map((order) => order.orderNo)),
    ];
    return { rows, footnotes };
  }

  /* ------------------------------------------------------------ 四期：外汇一览表 */

  /**
   * 外汇一览表取数（用户 2026-09-17 交付 `example/财务/外汇一览表.xlsx`）。
   *
   * **一行 = 一次成品出库**，列的是这次出库的应收，以及**归属到它的收款**。
   * 期间按**收款（实际到账）日期**筛选（用户选定）——老表标题就是「外汇入款一览表」，
   * 看的是钱什么时候进来。
   *
   * 归属规则（**关键不变量：一笔收款在整张表里只出现一次**）：
   *   1. 由【确认应收】写入的流水（`sourceType = receivable_source`）自己就指向那次出库，直接用它；
   *   2. 其余填了订单号的收入流水 → 归到该订单**出货日期最早**的那次出库（同日按出库单号）。
   *      为什么是「最早的那次」：定金在出货前就收到了、出货后收的尾款通常已经核销到具体出库，
   *      真正没有归属的只有「订单级」的收款。挂在第一次出库上既不重复计数
   *      （老表把同一笔定金抄在每个出库行上，照它求和会把定金算 N 遍），
   *      又能让财务一眼看到「这单的钱是什么时候进来的」。
   *   3. 归不到的（按对账单一键确认的一笔流水覆盖多张出库、订单还没出货、没填订单号、币种对不上）
   *      **不塞进任何一行**，而是按原因分类写进表尾，带笔数与金额 —— 宁可显式说「这几笔没进来」，
   *      也不猜一个归属把某行的欠尾款做错。
   *
   * 「欠尾款」= 出库应收 − **截至期间末的累计已收**（含期间外的收款），所以它是时点余额。
   */
  async forexReceipts(filter: FinanceReportFilter): Promise<{ rows: ForexReceiptRow[]; footnotes: string[] }> {
    const period = financeDayRange(filter.from, filter.to);

    // 第一步：期间内的收入流水。它们决定「哪些订单/出库要算」，也是明细行的准入条件。
    const seed = await this.forexEntries(filter, period ?? undefined);
    if (!seed.length) return { rows: [], footnotes: [] };

    // 第二步：把流水挂到「客户 / 订单 / 出库」上所需的三张表一次读回来。
    const linked = await this.forexAttributionInputs(seed);
    // 第三步：候选收款 = 截至期间末的同一批订单/来源的收款。**必须包含期间外的收款**，
    // 否则「8 月收到的定金」在 9 月的表里会让欠尾款虚高（累计已收少算了它）。
    const scoped = await this.forexEntries(filter, period ? { lte: period.lte } : undefined, {
      orderNos: linked.orderNos,
      sourceIds: [...linked.sourcesByIdAll.keys()],
    });
    // 把期间内的流水**并回来**：按「订单/来源」收窄的那条查询天然捞不到
    // 「既没有订单号、也没有来源」的手工收入流水（房租那种），而它们恰恰是表尾
    // 「流水上没有订单号」那一类要报出来的东西。少了这一步，这几笔钱会被静默丢掉 ——
    // 表里的汇入总金额小于银行流水，财务却看不出少在哪。
    const seen = new Set(scoped.map((entry) => entry.id));
    const candidates = [...scoped, ...seed.filter((entry) => !seen.has(entry.id))];
    this.assertWithinLimit(candidates.length);

    const buckets: Record<ForexUnattributedReason, ForexUnattributed[]> = {
      reconciliation: [], no_outbound: [], no_order: [], currency_mismatch: [],
    };
    const byOutbound = new Map<string, { outbound: ForexOutbound; receipts: ForexReceiptEntry[] }>();

    for (const raw of candidates) {
      const entry: ForexReceiptEntry = { ...raw, inPeriod: withinPeriod(raw.entryDate, period) };
      const target = this.attributeForexEntry(entry, linked, filter);
      if (target.kind === "excluded") continue;
      if (target.kind === "unattributed") {
        // 只有落在期间内的才报进表尾：期间外本来就不进这张表，报出来只会让人以为漏了钱。
        if (entry.inPeriod) buckets[target.reason].push({ entryNo: entry.entryNo, entryDate: entry.entryDate, amount: entry.amount, currency: entry.currency, orderNo: target.orderNo });
        continue;
      }
      const current = byOutbound.get(target.outbound.outboundId) ?? { outbound: target.outbound, receipts: [] };
      current.receipts.push(entry);
      byOutbound.set(target.outbound.outboundId, current);
    }

    const rows: ForexReceiptRow[] = [];
    for (const { outbound, receipts } of byOutbound.values()) {
      // 准入条件：**期间内**至少有一笔到账。只看累计的话，一笔 8 月收到的定金会让这一行
      // 出现在之后每一个月的表里，用户按月份看就分不清「这个月收了什么」。
      const within = receipts.filter((receipt) => receipt.inPeriod);
      if (!within.length) continue;
      const deposit = within.filter((receipt) => receipt.paymentNature === "deposit");
      // 老表的「货款」列实际混合了出货后收的尾款与一次性付清的全款，所以尾款并进货款列。
      const balance = within.filter((receipt) => receipt.paymentNature === "balance" || receipt.paymentNature === "final");
      const other = within.filter((receipt) => receipt.paymentNature !== "deposit" && receipt.paymentNature !== "balance" && receipt.paymentNature !== "final");
      const receivedToDate = sumDecimals(receipts.map((receipt) => receipt.amount));
      rows.push({
        customerName: outbound.customerName,
        currency: outbound.currency,
        orderNo: outbound.orderNo,
        orderQuantity: outbound.orderQuantity,
        shipmentDate: outbound.shipmentDate,
        outboundNo: outbound.outboundNo,
        quantity: outbound.quantity,
        unit: outbound.unit,
        unitPrice: outbound.unitPrice,
        amount: outbound.amount,
        depositDate: lastDate(deposit.map((receipt) => receipt.entryDate)),
        depositAmount: sumDecimals(deposit.map((receipt) => receipt.amount)),
        balanceDate: lastDate(balance.map((receipt) => receipt.entryDate)),
        balanceAmount: sumDecimals(balance.map((receipt) => receipt.amount)),
        otherAmount: sumDecimals(other.map((receipt) => receipt.amount)),
        receivedAmount: sumDecimals(within.map((receipt) => receipt.amount)),
        receivedToDate,
        outstanding: forexOutstanding(outbound.amount, receivedToDate),
        remark: outbound.remark,
      });
    }

    this.assertWithinLimit(rows.length);
    // 排序：客户 → 出货日期 → 出库单号。用户要的是「按客户收束」，所以客户是第一关键字。
    rows.sort((left, right) => compareText(left.customerName, right.customerName)
      || (left.shipmentDate?.valueOf() ?? 0) - (right.shipmentDate?.valueOf() ?? 0)
      || compareText(left.outboundNo, right.outboundNo));

    return { rows, footnotes: forexUnattributedFootnotes(buckets) };
  }

  /** 收入流水（`posted` + 收入方向），按期间与可选的「订单 / 应收来源」范围收窄。 */
  private async forexEntries(
    filter: FinanceReportFilter,
    range: { gte?: Date; lte?: Date } | undefined,
    scope?: { orderNos: string[]; sourceIds: string[] },
  ) {
    const orderNos = scope?.orderNos ?? [];
    const sourceIds = scope?.sourceIds ?? [];
    return this.prisma.cashFlowEntry.findMany({
      where: {
        deletedAt: null,
        status: "posted",
        direction: "income",
        ...(filter.currency ? { currency: filter.currency } : {}),
        // 日期范围自己拼而不是直接把 `financeDayRange` 的结果丢进去：这里要的是
        // 「截至期间末」与「完整期间」两种区间，直接传对象没法表达「只给上界」。
        ...(range?.gte || range?.lte
          ? { entryDate: { ...(range.gte ? { gte: range.gte } : {}), ...(range.lte ? { lte: range.lte } : {}) } }
          : {}),
        ...(orderNos.length || sourceIds.length
          ? {
              OR: [
                ...(orderNos.length ? [{ orderNo: { in: orderNos } }] : []),
                // 老流水可能没落 orderNo（这一列是 2026-09-17 才有的），
                // 靠 source_id 回捞同一批出库的收款，不然累计已收会把它们算漏。
                ...(sourceIds.length ? [{ sourceType: "receivable_source", sourceId: { in: sourceIds } }] : []),
              ],
            }
          : {}),
      },
      select: {
        id: true, entryNo: true, entryDate: true, amount: true, currency: true,
        paymentNature: true, orderNo: true, sourceType: true, sourceId: true,
      },
      orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
    });
  }

  /**
   * 归属所需的三张表：应收来源（→ 出库/客户/订单）、对账单（→ 客户/订单）、销售订单（→ 数量/客户）。
   *
   * 只查期间内流水牵涉到的那些订单/来源：这张表是「按期间看收款」，把全库应收来源都读回来
   * 算一遍归属没有意义，还会在大客户多的时候撞上行数上限。
   *
   * 出库候选**从应收来源入手**而不是从出库表：`receivable_sources.outbound_id` 是唯一的，
   * 一次出库最多一条应收；没有应收的出库根本收不到钱，而且「货款金额」也无从取数。
   */
  private async forexAttributionInputs(entries: readonly Omit<ForexReceiptEntry, "inPeriod">[]): Promise<ForexAttributionInputs> {
    const linkedSourceIds = [...new Set(entries.filter((entry) => entry.sourceType === "receivable_source" && entry.sourceId).map((entry) => entry.sourceId as string))];
    const reconciliationIds = [...new Set(entries.filter((entry) => entry.sourceType === "receivable_reconciliation" && entry.sourceId).map((entry) => entry.sourceId as string))];
    const [sources, reconciliations] = await Promise.all([
      linkedSourceIds.length
        ? this.prisma.receivableSource.findMany({ where: { id: { in: linkedSourceIds } }, select: { id: true, orderNo: true, customerId: true, currency: true } })
        : Promise.resolve([] as Array<{ id: string; orderNo: string; customerId: string; currency: string }>),
      reconciliationIds.length
        ? this.prisma.receivableReconciliation.findMany({ where: { id: { in: reconciliationIds } }, select: { id: true, orderNo: true, customerId: true } })
        : Promise.resolve([] as Array<{ id: string; orderNo: string | null; customerId: string }>),
    ]);
    const sourcesById = new Map(sources.map((row) => [row.id, row]));
    const reconciliationsById = new Map(reconciliations.map((row) => [row.id, row]));

    const orderNoSet = new Set<string>();
    for (const entry of entries) {
      if (entry.orderNo) orderNoSet.add(entry.orderNo);
      // 反查来源/对账单上的订单号：确认应收时会把它写进流水，但历史流水（这一列还没有的时候）
      // 只能从这里补，否则老数据会整批掉进「没有订单号」的表尾。
      const source = entry.sourceId ? sourcesById.get(entry.sourceId) : undefined;
      if (source?.orderNo) orderNoSet.add(source.orderNo);
      const reconciliation = entry.sourceId ? reconciliationsById.get(entry.sourceId) : undefined;
      if (reconciliation?.orderNo) orderNoSet.add(reconciliation.orderNo);
    }
    const orderNos = [...orderNoSet];

    const [sourcesOfOrders, orders] = await Promise.all([
      orderNos.length
        ? this.prisma.receivableSource.findMany({
            where: { orderNo: { in: orderNos }, deletedAt: null, status: { not: "cancelled" } },
            select: {
              id: true, outboundId: true, orderNo: true, currency: true, amount: true, unitPrice: true, unit: true, remark: true,
              customer: { select: { id: true, name: true } },
              outbound: { select: { outboundNo: true, shipmentDate: true, quantity: true } },
              salesOrder: { select: { quantity: true, customerId: true } },
            },
          })
        : Promise.resolve([]),
      orderNos.length
        ? this.prisma.salesOrder.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, customerId: true } })
        : Promise.resolve([]),
    ]);

    const sourcesByOrder = new Map<string, ForexOutbound[]>();
    const sourcesByIdAll = new Map<string, string>();
    for (const row of sourcesOfOrders) {
      const outbound: ForexOutbound = {
        outboundId: row.outboundId,
        outboundNo: row.outbound?.outboundNo ?? row.outboundId,
        orderNo: row.orderNo,
        customerId: row.customer?.id ?? null,
        customerName: row.customer?.name ?? "（客户已删除）",
        currency: row.currency,
        amount: row.amount,
        unitPrice: row.unitPrice,
        unit: row.unit,
        quantity: row.outbound?.quantity ?? null,
        shipmentDate: row.outbound?.shipmentDate ?? null,
        orderQuantity: row.salesOrder?.quantity ?? null,
        remark: row.remark,
      };
      const list = sourcesByOrder.get(row.orderNo) ?? [];
      list.push(outbound);
      sourcesByOrder.set(row.orderNo, list);
      sourcesByIdAll.set(row.id, row.outboundId);
    }
    // 订单的「第一次出库」：出货日期在前（没有日期的排最后），日期相同按出库单号。
    // 顺序必须**确定**，否则同一份数据两次导出可能得到不同的归属（定金这次挂 A 行、下次挂 B 行）。
    for (const list of sourcesByOrder.values()) {
      list.sort((left, right) => (left.shipmentDate?.valueOf() ?? Number.MAX_SAFE_INTEGER) - (right.shipmentDate?.valueOf() ?? Number.MAX_SAFE_INTEGER)
        || compareText(left.outboundNo, right.outboundNo));
    }
    return {
      sourcesById,
      reconciliationsById,
      sourcesByOrder,
      sourcesByIdAll,
      orderCustomer: new Map(orders.map((row) => [row.orderNo, row.customerId])),
      orderNos,
    };
  }

  /**
   * 把一条收款挂到一次出库上。
   *
   * 客户/订单筛选在这一层做（而不是在出行的时候）：流水本身没有客户，客户是从「它挂的来源 /
   * 对账单 / 订单」反查出来的 —— 只有先把归属解出来才谈得上筛。放在这里也让「表尾那几类
   * 归不到的收款」同样受筛选约束，不会出现「筛了客户 A，表尾却报客户 B 的漏项」。
   */
  private attributeForexEntry(
    entry: ForexReceiptEntry,
    linked: ForexAttributionInputs,
    filter: FinanceReportFilter,
  ):
    | { kind: "attributed"; outbound: ForexOutbound }
    | { kind: "unattributed"; reason: ForexUnattributedReason; orderNo: string | null }
    | { kind: "excluded" } {
    const source = entry.sourceType === "receivable_source" && entry.sourceId ? linked.sourcesById.get(entry.sourceId) : undefined;
    const reconciliation = entry.sourceType === "receivable_reconciliation" && entry.sourceId ? linked.reconciliationsById.get(entry.sourceId) : undefined;
    // 订单号优先取流水自己的，其次从它挂的来源/对账单上反查。
    const orderNo = entry.orderNo ?? source?.orderNo ?? reconciliation?.orderNo ?? null;
    const customerId = source?.customerId ?? reconciliation?.customerId ?? (orderNo ? linked.orderCustomer.get(orderNo) ?? null : null);
    if (filter.orderNo && orderNo !== filter.orderNo) return { kind: "excluded" };
    if (filter.customerId && customerId !== filter.customerId) return { kind: "excluded" };

    // 「按对账单一键确认应收」写的是**一条流水覆盖 N 张出库单**（对账单本身就是一张凭证）。
    // 硬拆（比如按金额比例摊）会让明细行上的欠尾款变成编出来的数，所以整类进表尾。
    if (entry.sourceType === "receivable_reconciliation") return { kind: "unattributed", reason: "reconciliation", orderNo };
    if (!orderNo) return { kind: "unattributed", reason: "no_order", orderNo: null };
    const candidates = linked.sourcesByOrder.get(orderNo) ?? [];
    if (!candidates.length) return { kind: "unattributed", reason: "no_outbound", orderNo };
    // 由【确认应收】写入的流水**自己就指向那一次出库**，必须用它——
    // 退化成「订单里最早的那次出库」会让一张订单的每笔货款都堆到第一次出货上，
    // 那一行的欠尾款变成负数、后面几行的欠尾款虚高，整张表就没法看了。
    if (source) {
      const target = linked.sourcesByIdAll.get(source.id);
      const outbound = candidates.find((candidate) => candidate.outboundId === target);
      if (!outbound) return { kind: "unattributed", reason: "no_outbound", orderNo };
      if (outbound.currency !== entry.currency) return { kind: "unattributed", reason: "currency_mismatch", orderNo };
      return { kind: "attributed", outbound };
    }
    // 只有「订单级」的收款（典型是出货前收到的定金，没有 sourceId 可挂）才退化成
    // 「出货日期最早的那次出库」，并且要求币种一致（不一致就是跨币种相加）。
    const outbound = candidates.find((candidate) => candidate.currency === entry.currency);
    if (!outbound) return { kind: "unattributed", reason: "currency_mismatch", orderNo };
    return { kind: "attributed", outbound };
  }

  /* ------------------------------------------------------------ 三期：收支明细 / 收支汇总 */

  /** 收支明细表取数（一行一条流水，`status = posted` 才计入）。 */
  async cashFlowDetail(filter: FinanceReportFilter): Promise<CashFlowDetailSource[]> {
    const rows = await this.cashFlowRows(filter);
    this.assertWithinLimit(rows.length);
    return rows.map((row) => ({
      date: row.entryDate,
      counterpartyName: row.counterpartyName,
      currency: row.currency,
      direction: row.direction,
      amount: row.amount,
      // 分类 = 科目类别，项目 = 科目名称（用户 2026-09-17 口径）。科目是必填外键，
      // 所以这两列一定有值；仍然写成 `?? null` 是为了兼容「科目被硬删」这种库层不该发生的情形。
      category: row.subject?.category ?? null,
      subjectName: row.subject?.name ?? null,
      // 银行账户（银行账户池）优先；历史流水没落 bank_id 时回落到老表结算账户字典的标签。
      bankLabel: row.bank ? `${row.bank.bankName}${row.bank.accountNumber}` : null,
      settlementMethod: row.settlementMethod,
      settlementAccountLabel: row.settlementAccount?.label ?? null,
    }));
  }

  /**
   * 收支汇总表取数：按「分类 × 科目 × 币种」聚合。
   *
   * 科目清单 = **启用的科目 ∪ 本期数据里出现过的科目**：
   * 只用启用科目会让「已停用科目的旧流水」在汇总表里凭空消失（明细表里有、汇总表里没有），
   * 那种对不上账的报表比多一行更糟。停用的科目挂在**它自己的分类段里**并标注「（已停用）」——
   * 统一挂到最后会让「分类小计」被拆成两行（算术没错，但看着像重复计算），
   * 所以两批科目合成一个数组后按 `compareAccountingSubjects` 重排（分类 → sortOrder → 名称）。
   */
  async cashFlowSummary(filter: FinanceReportFilter): Promise<{
    items: Array<{ id: string; category: string; name: string }>;
    amounts: CashFlowSummaryAmount[];
    currencies: string[];
  }> {
    const rows = await this.cashFlowRows(filter);
    const enabled = await this.prisma.accountingSubject.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, category: true, name: true, sortOrder: true },
    });
    const known = new Set(enabled.map((row) => row.id));
    const retiredIds = [...new Set(rows.map((row) => row.subjectId).filter((id) => !known.has(id)))];
    const retired = retiredIds.length
      ? await this.prisma.accountingSubject.findMany({ where: { id: { in: retiredIds } }, select: { id: true, category: true, name: true, sortOrder: true } })
      : [];
    const ordered = [
      ...enabled.map((row) => ({ ...row, retired: false })),
      ...retired.map((row) => ({ ...row, retired: true })),
    ].sort(compareAccountingSubjects);
    // 同名同分类同 sortOrder 时（启用 + 已停用各一条）顺序由「稳定排序 + 上面的输入顺序」决定：
    // 启用的先、停用的后。`Array.prototype.sort` 自 ES2019 起要求稳定，所以这个结果是确定的。
    const items: Array<{ id: string; category: string; name: string }> = ordered.map((row) => ({ id: row.id, category: row.category, name: row.retired ? `${row.name}（已停用）` : row.name }));

    const grouped = new Map<string, CashFlowSummaryAmount>();
    for (const row of rows) {
      const key = `${row.subjectId}|${row.currency}`;
      const current = grouped.get(key) ?? { subjectId: row.subjectId, currency: row.currency, income: new Prisma.Decimal(0), expense: new Prisma.Decimal(0) };
      if (row.direction === "income") current.income = current.income.plus(row.amount);
      else current.expense = current.expense.plus(row.amount);
      grouped.set(key, current);
    }
    const currencies = [...new Set(rows.map((row) => row.currency))].sort();
    // 本期一条流水都没有时，仍按本位币给一段（全部科目列出、全为 0），
    // 与老表「科目清单 + 收支」的形态一致，也让人能确定「确实是 0 而不是没跑出来」。
    return {
      items,
      amounts: [...grouped.values()],
      currencies: currencies.length ? currencies : [LOCAL_CURRENCY],
    };
  }

  /** 收支流水的统一取数（明细与汇总共用同一套筛选，避免两张表口径不一致）。 */
  private async cashFlowRows(filter: FinanceReportFilter) {
    const period = financeDayRange(filter.from, filter.to);
    return this.prisma.cashFlowEntry.findMany({
      where: {
        deletedAt: null,
        status: "posted",
        ...(filter.subjectId ? { subjectId: filter.subjectId } : {}),
        // 分类筛选走科目表的科目类别（用户 2026-09-17 口径：「很多报表都要根据这个来统计」）。
        ...(filter.category ? { subject: { category: filter.category } } : {}),
        ...(filter.currency ? { currency: filter.currency } : {}),
        ...(filter.direction ? { direction: filter.direction } : {}),
        ...(period ? { entryDate: period } : {}),
      },
      // 科目（分类 + 名称）与结算账户标签一次带上：汇总表只读科目，但只为一个 select 分两条查询路径不值得
      // （两条路径的筛选条件一旦分叉，就是「明细与汇总对不上」的来源）。
      include: { settlementAccount: { select: { label: true } }, subject: { select: { category: true, name: true } }, bank: { select: { bankName: true, accountNumber: true } } },
      orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
    });
  }

  /** 按订单号取**已过账**的应收调整（草稿未生效、冲销后的不算）。 */
  private async postedAdjustments(orderNos: string[]): Promise<Map<string, Array<{ effect: string; amount: Prisma.Decimal }>>> {
    const grouped = new Map<string, Array<{ effect: string; amount: Prisma.Decimal }>>();
    if (!orderNos.length) return grouped;
    const rows = await this.prisma.receivableAdjustment.findMany({
      where: { orderNo: { in: orderNos }, deletedAt: null, status: "posted" },
      select: { orderNo: true, effect: true, amount: true },
    });
    for (const row of rows) {
      const list = grouped.get(row.orderNo) ?? [];
      list.push({ effect: row.effect, amount: row.amount });
      grouped.set(row.orderNo, list);
    }
    return grouped;
  }

  private statuses(allowed: ReadonlyArray<string>, includeDraft?: boolean): string[] {
    return includeDraft ? ["draft", ...allowed] : [...allowed];
  }

  /**
   * 期间 → Prisma 日期范围。
   *
   * 与收支流水列表共用 `financeDayRange`（`to` 取当天 23:59:59.999Z，
   * 否则「截止当天」的记录会全部落空）——两处各写一份的话口径迟早会漂移。
   */

  private assertWithinLimit(count: number): void {
    if (count > MAX_REPORT_ROWS) {
      throw new UnprocessableEntityException({
        code: "REPORT_TOO_LARGE",
        message: `导出范围过大（${count} 行，上限 ${MAX_REPORT_ROWS} 行），请缩小期间或增加筛选条件`,
        details: [{ row_count: count, max_rows: MAX_REPORT_ROWS }],
      });
    }
  }
}
