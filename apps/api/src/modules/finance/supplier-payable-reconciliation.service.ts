import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { payableInReconciliationScope } from "./supplier-payable.domain";
import { requireActiveBank } from "./bank-selection";
import { CashFlowService } from "./cash-flow.service";
import { PAYABLE_CONFIRM_ITEM_KEYS, paymentItemKeys } from "./cash-flow-catalog";

const STATUS_LABELS: Record<string, string> = { pending: "待处理", matched: "已对平", difference: "有差异", resolved: "差异已处理" };

/**
 * 纳入对账的应付状态：**含待确认的草稿**。
 *
 * 为什么必须含草稿：业务顺序是「先对账、再确认应付」（`confirmPayables` 与应收侧同规则）。
 * 若对账快照只算已确认的条目，财务刚接收完应付去做对账时系统余额恒为 0、差异恒等于 −外部余额，
 * 而它对账之后要确认的偏偏就是那些草稿 —— 两边口径不一致，流转就断了。
 * get() / confirmPayables / 前端「待创建对账」分组用的都是这一组状态，create 必须一致。
 */
const ENTRY_STATUSES = ["draft", "confirmed", "partially_paid", "paid"] as const;

/** 一行对账能覆盖多个订单与多种物料，因此列表给的是去重后的清单。 */
type ReconciliationFlow = {
  entry_count: number;
  draft_count: number;
  draft_amount: string;
  can_confirm_payables: boolean;
  order_nos: string[];
  purchase_order_nos: string[];
  material_names: string[];
  /** 规格型号与物料名称一一对应地展示（用户要求：对账要看得出「买的是什么料、什么规格」）。 */
  material_specifications: string[];
};

/** flow / 明细共同用到的应付条目形状（含物料来源关联）。 */
type FlowEntry = {
  supplierId: string;
  currency: string;
  orderNo: string | null;
  purchaseOrderId: string | null;
  confirmationDate: Date;
  amount: Prisma.Decimal;
  status: string;
  payableSource?: { purchaseOrder?: { purchaseOrderNo: string } | null; purchaseOrderItem?: { materialSnapshot?: unknown; material?: { name: string; specificationModel: string | null } | null } | null } | null;
  outsourcePayableSource?: { purchaseOrder?: { purchaseOrderNo: string } | null; logisticsBatch?: { material?: { name: string; specificationModel: string | null } | null } | null } | null;
};

@Injectable()
export class SupplierPayableReconciliationService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly cashFlow: CashFlowService, @Optional() private readonly currencies?: CurrencyService) {}

  /**
   * 对账列表。
   *
   * 2026-09-15：每行带上 `flow`（覆盖多少条应付、其中多少条待确认、覆盖哪些订单与物料）。
   * 为什么列表也要算：前端要在对账单行上显示「到确认应付确认 N 条」并给出**批量确认**入口；
   * 只给 get() 算会让列表永远显示 0 条，用户看不到「对账 → 确认应付」这一步（历史缺陷）。
   * 覆盖的订单号与物料名称同时是对账列表的新列（用户要求：该批原料对应订单号 + 采购物料名称）。
   */
  async list(supplierId?: string, orderNo?: string, status?: string) {
    const rows = await this.prisma.supplierPayableReconciliation.findMany({
      where: { deletedAt: null, ...(supplierId ? { supplierId } : {}), ...(orderNo ? { orderNo } : {}), ...(status ? { status } : {}) },
      include: { supplier: true, purchaseOrder: { select: { purchaseOrderNo: true } }, bank: { select: { id: true, bankName: true, accountNumber: true } } },
      orderBy: { createdAt: "desc" },
    });
    const flows = await this.flows(rows);
    return rows.map((row) => ({ ...row, flow: flows.get(row.id) ?? this.emptyFlow(row.status) }));
  }

  /** 对账详情：快照字段 + 该供应商/期间内的应付条目（含待确认草稿）与仍待接收的来源。 */
  async get(id: string) {
    const row = await this.prisma.supplierPayableReconciliation.findFirst({ where: { id, deletedAt: null }, include: { supplier: true, purchaseOrder: { select: { purchaseOrderNo: true } }, bank: { select: { id: true, bankName: true, accountNumber: true } } }, });
    if (!row) throw this.notFound("RECONCILIATION_NOT_FOUND", "应付对账不存在");
    const [entries, payableSources, outsourceSources] = await Promise.all([
      this.prisma.supplierPayableEntry.findMany({
        where: { ...this.entryScope(row), status: { in: [...ENTRY_STATUSES] } },
        select: {
          id: true, payableNo: true, sourceType: true, sourceNoSnapshot: true, orderNo: true, quantity: true, amount: true, currency: true, status: true, confirmationDate: true, purchaseOrderId: true, supplierId: true,
          // 财务核对时要看到「这批原料是哪张订单的、买的什么料、什么规格」（用户要求的新列）。
          payableSource: { select: { purchaseOrder: { select: { purchaseOrderNo: true } }, purchaseOrderItem: { select: { materialSnapshot: true, unit: { select: { name: true } }, material: { select: { name: true, specificationModel: true } } } } } },
          outsourcePayableSource: { select: { purchaseOrder: { select: { purchaseOrderNo: true } }, logisticsBatch: { select: { material: { select: { name: true, specificationModel: true } } } } } },
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.payableSource.findMany({ where: { supplierId: row.supplierId, currency: row.currency, status: "pending_finance", createdAt: { gte: row.periodStart, lte: new Date(row.periodEnd.getTime() + 86400000) }, ...(row.orderNo ? { orderNo: row.orderNo } : {}), ...(row.purchaseOrderId ? { purchaseOrderId: row.purchaseOrderId } : {}) }, select: { id: true, orderNo: true, quantity: true, amount: true, currency: true, purchaseReceipt: { select: { receiptNo: true } }, rawMaterialInbound: { select: { inboundNo: true } } } }),
      this.prisma.outsourcePayableSource.findMany({ where: { supplierId: row.supplierId, currency: row.currency, status: "pending_finance", createdAt: { gte: row.periodStart, lte: new Date(row.periodEnd.getTime() + 86400000) }, ...(row.orderNo ? { orderNo: row.orderNo } : {}), ...(row.purchaseOrderId ? { purchaseOrderId: row.purchaseOrderId } : {}) }, select: { id: true, orderNo: true, quantity: true, amount: true, currency: true, outsourceReceipt: { select: { id: true } } } }),
    ]);
    const draft = entries.filter((entry) => entry.status === "draft");
    const draftAmount = draft.reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
    const shaped = entries.map((entry) => ({
      ...entry,
      material_name: this.materialName(entry),
      material_specification: this.materialSpec(entry),
      unit_name: entry.payableSource?.purchaseOrderItem?.unit?.name ?? null,
      purchase_order_no: entry.payableSource?.purchaseOrder?.purchaseOrderNo ?? entry.outsourcePayableSource?.purchaseOrder?.purchaseOrderNo ?? null,
    }));
    return {
      ...row,
      status_label: STATUS_LABELS[row.status] ?? row.status,
      // 详情也带 flow：列表与详情用同一份摘要字段（物料名称 + 规格型号）展示，
      // 前端不必为「详情里显示什么」再维护一套不同的口径。
      flow: this.summarize(entries as FlowEntry[], row.status),
      details: {
        payable_entries: shaped,
        draft_entries: shaped.filter((entry) => entry.status === "draft"),
        entry_count: shaped.length,
        draft_count: draft.length,
        draft_amount: draftAmount.toFixed(4),
        can_confirm_payables: this.canConfirmPayables(row.status) && draft.length > 0,
        pending_sources: [...payableSources.map((source) => ({ ...source, source_type: "purchase_or_inbound", source_no: source.rawMaterialInbound?.inboundNo ?? source.purchaseReceipt?.receiptNo ?? source.id })), ...outsourceSources.map((source) => ({ ...source, source_type: "outsource_receipt", source_no: source.outsourceReceipt?.id ?? source.id }))],
      },
    };
  }

  async create(input: { supplier_id: string; order_no?: string; purchase_order_id?: string; period_start: string; period_end: string; external_balance: string; currency: string; bank_id?: string; cash_flow_item_id?: string; attachment?: unknown[]; remark?: string }, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "应付对账币种");
    const start = this.date(input.period_start); const end = this.date(input.period_end); if (start > end) throw this.invalid("INVALID_RECONCILIATION_PERIOD", "对账开始日期不能晚于结束日期");
    const supplier = await this.prisma.supplier.findFirst({ where: { id: input.supplier_id, deletedAt: null }, select: { id: true } }); if (!supplier) throw this.notFound("SUPPLIER_NOT_FOUND", "供应商不存在");
    // 支付银行与收支项目都来自主数据：银行必须在池子里且启用（外键拦不住「停用」）；
    // 项目建单时就校验并落库，确认应付要按它把付款归到某个项目上，报表才能按项目统计。
    await requireActiveBank(this.prisma, input.bank_id, "支付银行不存在或已停用");
    const cashFlowItem = await this.cashFlow.requireItem(input.cash_flow_item_id, "收支项目不存在或已停用，请在「收支管理 → 收支项目」里确认");
    const scope = { supplierId: supplier.id, currency: input.currency, orderNo: input.order_no?.trim() || undefined, purchaseOrderId: input.purchase_order_id?.trim() || undefined };
    const entries = await this.prisma.supplierPayableEntry.findMany({ where: { ...this.entryScope({ ...scope, periodStart: start, periodEnd: end }), status: { in: [...ENTRY_STATUSES] } } });
    const entryIds = entries.map((entry) => entry.id);
    const payments = entryIds.length ? await this.prisma.supplierPayment.findMany({ where: { supplierId: supplier.id, currency: input.currency, deletedAt: null, paymentDate: { gte: start, lte: end }, status: "posted" }, include: { allocations: { where: { payableEntryId: { in: entryIds }, deletedAt: null, status: "active" } } } }) : [];
    const payable = entries.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
    // Reconcile allocated amounts only; an unallocated payment must not reduce a supplier/order balance.
    const paid = payments.reduce((sum, payment) => sum.plus(payment.allocations.reduce((inner, allocation) => inner.plus(allocation.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0));
    const external = this.decimal(input.external_balance); const difference = payable.minus(paid).minus(external);
    const row = await this.prisma.supplierPayableReconciliation.create({ data: { reconciliationNo: this.number(), orderNo: scope.orderNo, purchaseOrderId: scope.purchaseOrderId, supplierId: supplier.id, bankId: input.bank_id || undefined, cashFlowItemId: cashFlowItem?.id, periodStart: start, periodEnd: end, payableAmountSnapshot: payable, paymentAmountSnapshot: paid, adjustmentAmountSnapshot: 0, systemBalance: payable.minus(paid), externalBalance: external, difference, currency: input.currency, status: difference.eq(0) ? "matched" : "difference", attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user) } });
    if (row.orderNo) await this.audit.recordWithOrderNo("supplier_payable_reconciliation.create", "supplier_payable_reconciliation", row.orderNo, user.id, row.id, { difference: difference.toString() });
    else await this.audit.record("supplier_payable_reconciliation.create", "supplier_payable_reconciliation", user.id, row.id, { difference: difference.toString() });
    return row;
  }

  async resolve(id: string, remark: string, user: CurrentUser) {
    if (!remark?.trim()) throw this.invalid("RESOLUTION_REMARK_REQUIRED", "解决对账差异必须填写说明");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payable_reconciliations WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayableReconciliation.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("RECONCILIATION_NOT_FOUND", "应付对账不存在");
      if (current.status !== "difference") throw this.invalid("RECONCILIATION_NOT_RESOLVABLE", "只有存在差异的应付对账可以处理");
      return tx.supplierPayableReconciliation.update({ where: { id }, data: { status: "resolved", resolutionRemark: remark.trim(), ...this.audit.update(user) } });
    });
    await this.audit.record("supplier_payable_reconciliation.resolve", "supplier_payable_reconciliation", user.id, id, { remark: remark.trim() });
    return row;
  }

  /**
   * 对账完成后批量确认该对账范围内的草稿应付：一次事务、逐条行锁。
   * 确认即记账：把本次确认的金额作为**支出流水**写进收支流水，从对账单的银行账户转出
   * （用户要求：「一旦确认应付，金额就要转出对应的账户」）。
   *
   * 业务顺序与应收侧一致：先对账、再确认应付。仍有未处理差异（difference）时拒绝，
   * 否则会把没核对清楚的金额直接记成生效负债。来源已作废（voided）的草稿会被跳过并回报，
   * 因为「上游冲销后不得确认」是既定规则（SupplierPayableService.confirm 同口径）。
   *
   * `override`：确认时补/改银行账户与收支项目（历史对账单可能没填），给了就回写到对账单上。
   */
  async confirmPayables(id: string, user: CurrentUser, override: { bank_id?: string | null; cash_flow_item_id?: string | null } = {}) {
    // **先进校验、后进事务**：等事务提交完才发现银行非法，应付已被确认、流水却没写，
    // 账面上凭空少一笔支出（确认与记账必须同生共死）。
    if (override.bank_id) await requireActiveBank(this.prisma, override.bank_id, "支付银行不存在或已停用");
    if (override.cash_flow_item_id) await this.cashFlow.requireItem(override.cash_flow_item_id, "收支项目不存在或已停用，请在「收支管理 → 收支项目」里确认");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payable_reconciliations WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayableReconciliation.findFirst({ where: { id, deletedAt: null }, include: { supplier: { select: { id: true, name: true } } } });
      if (!current) throw this.notFound("RECONCILIATION_NOT_FOUND", "应付对账不存在");
      if (!this.canConfirmPayables(current.status)) throw this.invalid("RECONCILIATION_NOT_COMPLETED", `对账尚未完成（当前：${STATUS_LABELS[current.status] ?? current.status}），请先处理差异`);
      const drafts = await tx.supplierPayableEntry.findMany({
        where: { ...this.entryScope(current), status: "draft" },
        select: { id: true, payableNo: true, orderNo: true, amount: true, currency: true, sourceType: true, payableSource: { select: { status: true } }, outsourcePayableSource: { select: { status: true } } },
        orderBy: { createdAt: "asc" },
      });
      const confirmed: typeof drafts = [];
      const skipped: Array<{ id: string; payable_no: string; reason: string }> = [];
      for (const draft of drafts) {
        if (draft.payableSource?.status === "voided" || draft.outsourcePayableSource?.status === "voided") {
          skipped.push({ id: draft.id, payable_no: draft.payableNo, reason: "来源已作废" });
          continue;
        }
        await tx.$queryRaw`SELECT id FROM supplier_payable_entries WHERE id = ${draft.id}::uuid FOR UPDATE`;
        await tx.supplierPayableEntry.update({ where: { id: draft.id }, data: { status: "confirmed", ...this.audit.update(user) } });
        confirmed.push(draft);
      }
      const bankId = override.bank_id === undefined ? current.bankId : (override.bank_id || null);
      const cashFlowItemId = override.cash_flow_item_id === undefined ? current.cashFlowItemId : (override.cash_flow_item_id || null);
      if (bankId !== current.bankId || cashFlowItemId !== current.cashFlowItemId) {
        await tx.supplierPayableReconciliation.update({ where: { id }, data: { bankId, cashFlowItemId, ...this.audit.update(user) } });
      }
      return { current, confirmed, skipped, bankId, cashFlowItemId };
    });
    const confirmedAmount = result.confirmed.reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
    // 项目归类与供应商付款过账同一套口径：按本次确认金额最大的来源类型选候选链，
    // 这样「原料入库」确认出来是「原材料 成本」、「外加工签收」确认出来是「成品外加工费」。
    const sourceAmounts = new Map<string, Prisma.Decimal>();
    for (const entry of result.confirmed) sourceAmounts.set(entry.sourceType, (sourceAmounts.get(entry.sourceType) ?? new Prisma.Decimal(0)).plus(entry.amount));
    const dominant = [...sourceAmounts.entries()].sort((left, right) => right[1].minus(left[1]).toNumber())[0]?.[0];
    const cashFlow = await this.cashFlow.recordConfirmation({
      sourceType: "supplier_payable_reconciliation",
      sourceId: id,
      documentNo: result.current.reconciliationNo,
      entryDate: this.today(),
      amount: confirmedAmount,
      currency: result.current.currency,
      counterpartyName: result.current.supplier?.name ?? result.current.supplierId,
      direction: "expense",
      itemKeys: dominant ? paymentItemKeys(dominant) : PAYABLE_CONFIRM_ITEM_KEYS,
      itemId: result.cashFlowItemId,
      bankId: result.bankId,
      remark: `应付对账确认（${result.confirmed.length} 条）`,
    }, user);
    await this.audit.record("supplier_payable_reconciliation.confirm_payables", "supplier_payable_reconciliation", user.id, id, {
      reconciliation_no: result.current.reconciliationNo,
      supplier_id: result.current.supplierId,
      confirmed_count: result.confirmed.length,
      confirmed_amount: confirmedAmount.toFixed(4),
      bank_id: result.bankId,
      cash_flow_entry_id: cashFlow?.id ?? null,
      skipped: result.skipped,
    });
    return {
      reconciliation_id: id,
      status: result.current.status,
      confirmed_count: result.confirmed.length,
      confirmed_amount: confirmedAmount.toFixed(4),
      currency: result.current.currency,
      bank_id: result.bankId,
      cash_flow_item_id: result.cashFlowItemId,
      cash_flow_entry_id: cashFlow?.id ?? null,
      /** 没指定银行账户：钱记进了收支流水，但不会体现在任何银行余额里，界面必须提示。 */
      bank_missing: !result.bankId,
      skipped_count: result.skipped.length,
      skipped: result.skipped,
      entries: result.confirmed.map((entry) => ({ id: entry.id, payable_no: entry.payableNo, order_no: entry.orderNo, amount: entry.amount.toFixed(4), currency: entry.currency, status: "confirmed" })),
    };
  }

  /** 对账范围：供应商 + 币种 + 期间，可选收窄到订单/采购单。create / get / confirmPayables / flows 必须完全一致。 */
  private entryScope(row: { supplierId: string; currency: string; orderNo: string | null | undefined; purchaseOrderId: string | null | undefined; periodStart: Date; periodEnd: Date }) {
    return {
      supplierId: row.supplierId,
      currency: row.currency,
      deletedAt: null,
      confirmationDate: { gte: row.periodStart, lte: row.periodEnd },
      ...(row.orderNo ? { orderNo: row.orderNo } : {}),
      ...(row.purchaseOrderId ? { purchaseOrderId: row.purchaseOrderId } : {}),
    };
  }

  /** 一条对账覆盖的应付条目（含草稿）→ 流转摘要。供列表与详情共用同一口径。 */
  private async flows(rows: Array<{ id: string; status: string; supplierId: string; currency: string; orderNo: string | null; purchaseOrderId: string | null; periodStart: Date; periodEnd: Date }>) {
    const map = new Map<string, ReconciliationFlow>();
    if (!rows.length) return map;
    const scopes = rows.map((row) => this.entryScope(row));
    const entries = (await this.prisma.supplierPayableEntry.findMany({
      // 一次查询取回全部对账范围内的条目（OR 精确复刻 entryScope），避免每行一次 N+1。
      where: { OR: scopes, status: { in: [...ENTRY_STATUSES] } },
      select: {
        supplierId: true, currency: true, orderNo: true, purchaseOrderId: true, confirmationDate: true, amount: true, status: true,
        payableSource: { select: { purchaseOrder: { select: { purchaseOrderNo: true } }, purchaseOrderItem: { select: { materialSnapshot: true, material: { select: { name: true, specificationModel: true } } } } } },
        outsourcePayableSource: { select: { purchaseOrder: { select: { purchaseOrderNo: true } }, logisticsBatch: { select: { material: { select: { name: true, specificationModel: true } } } } } },
      },
      orderBy: { createdAt: "asc" },
    })) as FlowEntry[];
    for (const row of rows) {
      const scope = this.entryScope(row);
      map.set(row.id, this.summarize(entries.filter((entry) => this.inScope(entry, scope)), row.status));
    }
    return map;
  }

  /** 一组应付条目 → 流转摘要（覆盖条数、待确认、订单/采购单/物料名称与规格型号）。 */
  private summarize(scoped: FlowEntry[], status: string): ReconciliationFlow {
    const drafts = scoped.filter((entry) => entry.status === "draft");
    const draftAmount = drafts.reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
    return {
      entry_count: scoped.length,
      draft_count: drafts.length,
      draft_amount: draftAmount.toFixed(4),
      can_confirm_payables: this.canConfirmPayables(status) && drafts.length > 0,
      // 订单号既有应付条目上的销售订单号，也有采购单号：财务核对时要能同时看到两者。
      order_nos: [...new Set(scoped.map((entry) => entry.orderNo).filter((value): value is string => Boolean(value)))],
      purchase_order_nos: [...new Set(scoped.map((entry) => entry.payableSource?.purchaseOrder?.purchaseOrderNo ?? entry.outsourcePayableSource?.purchaseOrder?.purchaseOrderNo).filter((value): value is string => Boolean(value)))],
      material_names: [...new Set(scoped.map((entry) => this.materialName(entry)).filter((value): value is string => Boolean(value)))],
      material_specifications: [...new Set(scoped.map((entry) => this.materialSpec(entry)).filter((value): value is string => Boolean(value)))],
    };
  }

  private inScope(entry: { supplierId: string; currency: string; orderNo: string | null; purchaseOrderId: string | null; confirmationDate: Date }, scope: { supplierId: string; currency: string; orderNo?: string; purchaseOrderId?: string; confirmationDate: { gte: Date; lte: Date } }) {
    return payableInReconciliationScope(entry, { ...scope, periodStart: scope.confirmationDate.gte, periodEnd: scope.confirmationDate.lte });
  }

  private materialName(entry: { payableSource?: { purchaseOrderItem?: { material?: { name: string } | null; materialSnapshot?: unknown } | null } | null; outsourcePayableSource?: { logisticsBatch?: { material?: { name: string } | null } | null } | null }) {
    const snapshot = (entry.payableSource?.purchaseOrderItem?.materialSnapshot as { name?: string } | null | undefined)?.name ?? null;
    return entry.payableSource?.purchaseOrderItem?.material?.name ?? snapshot ?? entry.outsourcePayableSource?.logisticsBatch?.material?.name ?? null;
  }

  /** 规格型号：主数据优先，物料被软删除后回落到来源快照（与 materialName 同一套兜底规则）。 */
  private materialSpec(entry: { payableSource?: { purchaseOrderItem?: { material?: { specificationModel: string | null } | null; materialSnapshot?: unknown } | null } | null; outsourcePayableSource?: { logisticsBatch?: { material?: { specificationModel: string | null } | null } | null } | null }) {
    const snapshot = (entry.payableSource?.purchaseOrderItem?.materialSnapshot as { specificationModel?: string | null } | null | undefined)?.specificationModel ?? null;
    return entry.payableSource?.purchaseOrderItem?.material?.specificationModel ?? snapshot ?? entry.outsourcePayableSource?.logisticsBatch?.material?.specificationModel ?? null;
  }

  private emptyFlow(status: string): ReconciliationFlow {
    return { entry_count: 0, draft_count: 0, draft_amount: "0.0000", can_confirm_payables: false, order_nos: [], purchase_order_nos: [], material_names: [], material_specifications: [] };
  }

  private canConfirmPayables(status: string) { return status === "matched" || status === "resolved"; }

  private date(value: string) { const date = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf())) throw this.invalid("INVALID_RECONCILIATION_PERIOD", "日期无效"); return date; }
  /** 确认发生的日期（记账日）：取当天的 UTC 零点，让流水日期与「今天」在库里可比较、可复现。 */
  private today() { return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`); }
  private decimal(value: string) { try { const n = new Prisma.Decimal(value); if (n.lt(0)) throw new Error(); return n; } catch { throw this.invalid("INVALID_EXTERNAL_BALANCE", "外部余额必须是有效的非负十进制数"); } }
  private number() { return `APREC-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}