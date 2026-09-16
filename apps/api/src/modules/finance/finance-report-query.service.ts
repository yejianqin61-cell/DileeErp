import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../platform/database/prisma.service";
import { CASH_FLOW_ITEM_DICTIONARY_KEY } from "./cash-flow-catalog";
import { BomMaterialCostService } from "./finance-report-cost.service";
import { LOCAL_CURRENCY, receivableOutstanding, salesAmountOf } from "./finance-report.domain";
import { financeDayRange } from "./finance-period";
import { adjustmentNet } from "./receivable-adjustment.domain";
import { footnoteLines } from "./finance-report.tables";
import type { FinanceReportFilter } from "./finance-report.types";
import type {
  CashFlowDetailSource,
  CashFlowSummaryAmount,
  PurchaseReconciliationDetailSource,
  SalesGrossProfitSource,
  SalesReconciliationDetailSource,
  SalesReconciliationSummarySource,
} from "./finance-report.tables";

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
      // 收支项目：老表没这一列，但没有它就「看不出这笔钱算什么」——用户要求明细能按项目分类统计。
      itemLabel: row.item?.label ?? null,
      // 银行账户（银行账户池）优先；历史流水没落 bank_id 时回落到老表结算账户字典的标签。
      bankLabel: row.bank ? `${row.bank.bankName}${row.bank.accountNumber}` : null,
      settlementMethod: row.settlementMethod,
      settlementAccountLabel: row.settlementAccount?.label ?? null,
    }));
  }

  /**
   * 收支汇总表取数：按「项目 × 币种」聚合。
   *
   * 项目清单 = **启用的项目 ∪ 本期数据里出现过的项目**：
   * 只用启用项目会让「已停用项目的旧流水」在汇总表里凭空消失（明细表里有、汇总表里没有），
   * 那种对不上账的报表比多一行更糟。停用的项目排在最后并标注「（已停用）」。
   */
  async cashFlowSummary(filter: FinanceReportFilter): Promise<{
    items: Array<{ id: string; label: string }>;
    amounts: CashFlowSummaryAmount[];
    currencies: string[];
  }> {
    const rows = await this.cashFlowRows(filter);
    const enabled = await this.prisma.dictionaryItem.findMany({
      where: { deletedAt: null, isActive: true, type: { key: CASH_FLOW_ITEM_DICTIONARY_KEY, deletedAt: null } },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
      select: { id: true, label: true },
    });
    const items: Array<{ id: string; label: string }> = enabled.map((item) => ({ id: item.id, label: item.label }));
    const known = new Set(items.map((item) => item.id));
    const retiredIds = [...new Set(rows.map((row) => row.itemId).filter((id) => !known.has(id)))];
    if (retiredIds.length) {
      const retired = await this.prisma.dictionaryItem.findMany({ where: { id: { in: retiredIds } }, select: { id: true, label: true } });
      for (const item of retired) items.push({ id: item.id, label: `${item.label}（已停用）` });
    }

    const grouped = new Map<string, CashFlowSummaryAmount>();
    for (const row of rows) {
      const key = `${row.itemId}|${row.currency}`;
      const current = grouped.get(key) ?? { itemId: row.itemId, currency: row.currency, income: new Prisma.Decimal(0), expense: new Prisma.Decimal(0) };
      if (row.direction === "income") current.income = current.income.plus(row.amount);
      else current.expense = current.expense.plus(row.amount);
      grouped.set(key, current);
    }
    const currencies = [...new Set(rows.map((row) => row.currency))].sort();
    // 本期一条流水都没有时，仍按本位币给一段（37 个项目全部列出、全为 0），
    // 与老表「项目清单 + 收支」的形态一致，也让人能确定「确实是 0 而不是没跑出来」。
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
        ...(filter.itemId ? { itemId: filter.itemId } : {}),
        ...(filter.currency ? { currency: filter.currency } : {}),
        ...(filter.direction ? { direction: filter.direction } : {}),
        ...(period ? { entryDate: period } : {}),
      },
      // 结算账户标签与收支项目名一次带上：汇总表只读项目，但只为一个 select 分两条查询路径不值得
      // （两条路径的筛选条件一旦分叉，就是「明细与汇总对不上」的来源）。
      include: { settlementAccount: { select: { label: true } }, item: { select: { label: true } }, bank: { select: { bankName: true, accountNumber: true } } },
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
