import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { sourceType, coveringPayableReconciliation } from "./supplier-payable.domain";
import { requireActiveBank } from "./bank-selection";
import { CashFlowService } from "./cash-flow.service";
import { paymentItemKeys, PAYABLE_CONFIRM_ITEM_KEYS } from "./cash-flow-catalog";

type SourceType = "raw_material_inbound" | "purchase_receipt" | "outsource_receipt";
export type PayableEntryInput = { source_type: SourceType; source_id: string; amount?: string; amount_reason?: string; confirmation_date?: string; attachment?: unknown[]; remark?: string };

@Injectable()
export class SupplierPayableService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly cashFlow: CashFlowService, @Optional() private readonly currencies?: CurrencyService) {}

  async list(orderNo?: string, supplierId?: string, status?: string) {
    const rows = await this.prisma.supplierPayableEntry.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}), ...(supplierId ? { supplierId } : {}), ...(status ? { status } : {}) }, include: { supplier: { select: { id: true, name: true, supplierCode: true } }, allocations: { where: { deletedAt: null }, include: { payment: { select: { status: true } } } }, payableSource: { include: { purchaseReceipt: { select: { receiptNo: true, extensionData: true } }, rawMaterialInbound: { select: { inboundNo: true } }, purchaseOrder: { select: { purchaseOrderNo: true } }, purchaseOrderItem: { select: { materialSnapshot: true, material: { select: { materialCode: true, name: true, specificationModel: true, color: true } }, unit: { select: { name: true } } } } } }, outsourcePayableSource: { include: { outsourceReceipt: { select: { id: true } }, purchaseOrder: { select: { purchaseOrderNo: true } }, logisticsBatch: { select: { material: { select: { materialCode: true, name: true, specificationModel: true, color: true } }, unit: { select: { name: true } } } } } } }, orderBy: { createdAt: "desc" } });
    /**
     * 「这条应付是否已经被某张对账单覆盖」。
     *
     * 为什么由服务端算：对账范围是**供应商 + 币种 + 期间（可再收窄到订单/采购单）**，
     * 前端只有供应商与日期、拿不到 purchaseOrderId，自己推一遍必然与服务端不一致。
     * 口径与 SupplierPayableReconciliationService 的 entryScope 共用同一个纯函数
     * （`payableInReconciliationScope`），否则「前端说没对过账、后端说已覆盖」会各说各话。
     *
     * 用途：财务页面「待创建对账」只列**没被覆盖**的草稿；已被覆盖的要显式说明在哪张对账单里，
     * 否则用户会以为这条应付「没流转过去」（历史反馈）。
     */
    const supplierIds = [...new Set(rows.map((row) => row.supplierId))];
    const scopes = supplierIds.length
      ? await this.prisma.supplierPayableReconciliation.findMany({
        where: { deletedAt: null, supplierId: { in: supplierIds } },
        select: { id: true, reconciliationNo: true, status: true, supplierId: true, currency: true, orderNo: true, purchaseOrderId: true, periodStart: true, periodEnd: true },
        orderBy: { createdAt: "desc" },
      })
      : [];
    return rows.map((row) => {
      const receiptData = row.payableSource?.purchaseReceipt?.extensionData as { batch_sequence?: number } | null | undefined;
      const item = row.payableSource?.purchaseOrderItem;
      // 应付条目要能看出是哪个原料（客户反馈：只看到金额不知道对应什么物料）。
      const material = item?.material ?? row.outsourcePayableSource?.logisticsBatch?.material ?? null;
      const snapshot = (item?.materialSnapshot as { name?: string } | null | undefined)?.name ?? null;
      // 已付/未付：只统计已过账付款的有效核销（冲销后的核销不算），与详情、对账口径一致。
      const paid = row.allocations.filter((allocation) => allocation.status === "active" && allocation.payment?.status === "posted").reduce((sum, allocation) => sum.plus(allocation.amount), new Prisma.Decimal(0));
      const outstanding = row.amount.minus(paid);
      const covering = coveringPayableReconciliation(row, scopes);
      return {
        ...row,
        source_no: row.payableSource?.rawMaterialInbound?.inboundNo ?? row.payableSource?.purchaseReceipt?.receiptNo ?? row.outsourcePayableSource?.outsourceReceipt?.id ?? row.sourceNoSnapshot,
        purchase_order_no: row.payableSource?.purchaseOrder?.purchaseOrderNo ?? row.outsourcePayableSource?.purchaseOrder?.purchaseOrderNo ?? null,
        batch_sequence: receiptData?.batch_sequence ?? null,
        material_name: material?.name ?? snapshot,
        material_code: material?.materialCode ?? null,
        material_specification: material?.specificationModel ?? null,
        material_color: material?.color ?? null,
        unit_name: item?.unit?.name ?? row.outsourcePayableSource?.logisticsBatch?.unit?.name ?? null,
        supplier_name: row.supplier?.name ?? null,
        supplier_code: row.supplier?.supplierCode ?? null,
        paid_amount: paid.toFixed(4),
        outstanding_amount: outstanding.toFixed(4),
        reconciliation: covering ? { id: covering.id, reconciliation_no: covering.reconciliationNo, status: covering.status, period_start: covering.periodStart, period_end: covering.periodEnd } : null,
      };
    });
  }

  async get(id: string) {
    const row = await this.prisma.supplierPayableEntry.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null }, include: { payment: true } }, payableSource: true, outsourcePayableSource: true } });
    if (!row) throw this.notFound("SUPPLIER_PAYABLE_NOT_FOUND", "应付确认不存在");
    return row;
  }

  async createFromSource(input: PayableEntryInput, user: CurrentUser) {
    sourceType(input.source_type);
    if (input.source_type === "purchase_receipt") throw this.invalid("PURCHASE_RECEIPT_PAYABLE_DISABLED", "到货单不是可接收应付来源，请以原料入库过账来源为准");
    const row = await this.prisma.$transaction(async (tx) => {
      if (input.source_type === "outsource_receipt") await tx.$queryRaw`SELECT id FROM outsource_payable_sources WHERE id = ${input.source_id}::uuid FOR UPDATE`;
      else await tx.$queryRaw`SELECT id FROM payable_sources WHERE id = ${input.source_id}::uuid FOR UPDATE`;
      const refs = await this.source(input.source_type, input.source_id, tx);
      const existing = input.source_type === "outsource_receipt"
        ? await tx.supplierPayableEntry.findUnique({ where: { outsourcePayableSourceId: input.source_id } })
        : await tx.supplierPayableEntry.findUnique({ where: { payableSourceId: input.source_id } });
      // 已有条目直接复用（含被软删除后恢复），不重复建单：来源 → 应付是一对一。
      const entry = existing
        ? (existing.deletedAt ? await tx.supplierPayableEntry.update({ where: { id: existing.id }, data: { deletedAt: null, deletedBy: null, ...this.audit.update(user) } }) : existing)
        : await this.createEntry(tx, input, refs, user);
      // 接收动作必须把来源推进到「已接收」，否则来源会永远停在待接收（见 markSourceReceived 注释）。
      await this.markSourceReceived(tx, input.source_type, input.source_id, user);
      return entry;
    });
    await this.audit.recordWithOrderNo("supplier_payable.create", "supplier_payable_entry", row.orderNo ?? "", user.id, row.id, { payable_no: row.payableNo, source_type: row.sourceType, source_id: input.source_id, amount: row.amount.toString() });
    return row;
  }

  private createEntry(tx: Prisma.TransactionClient, input: PayableEntryInput, refs: Awaited<ReturnType<SupplierPayableService["source"]>>, user: CurrentUser) {
    const amount = input.amount ? this.decimal(input.amount, "INVALID_PAYABLE_AMOUNT") : refs.amount;
    if (!amount.eq(refs.amount) && !input.amount_reason?.trim()) throw this.invalid("PAYABLE_AMOUNT_REASON_REQUIRED", "覆盖应付金额必须填写原因");
    return tx.supplierPayableEntry.create({ data: {
      payableNo: this.number("AP"), orderNo: refs.orderNo, supplierId: refs.supplierId, sourceType: input.source_type,
      payableSourceId: ["raw_material_inbound", "purchase_receipt"].includes(input.source_type) ? input.source_id : undefined,
      outsourcePayableSourceId: input.source_type === "outsource_receipt" ? input.source_id : undefined,
      // 采购单/采购明细/外加工批次的关联必须落库：应付对账按 purchase_order_id 过滤明细，
      // 这三个字段为空会让"按采购单对账"的系统余额恒为 0（历史缺陷，见 docs/log）。
      purchaseOrderId: refs.purchaseOrderId, purchaseOrderItemId: refs.purchaseOrderItemId, outsourceLogisticsBatchId: refs.outsourceLogisticsBatchId,
      sourceNoSnapshot: refs.sourceNo, quantity: refs.quantity, unitPrice: refs.unitPrice, taxRate: refs.taxRate,
      amount, currency: refs.currency, confirmationDate: input.confirmation_date ? this.date(input.confirmation_date) : new Date(),
      attachment: (input.attachment ?? []) as Prisma.InputJsonValue, remark: input.remark, ...this.audit.create(user),
    } });
  }

  /**
   * 把来源推进到「已接收」：这是「接收应付」这一步**唯一**会改来源状态的地方。
   *
   * 历史缺陷：接收应付只建了应付条目，来源状态一直停在 `pending_finance`，于是
   *   ①「原料入库条目」永远显示「接收应付」按钮、来源状态永远「待财务接收」；
   *   ② 再点一次只是幂等返回旧条目，用户看到成功提示却看不到任何变化（「点了没反应」）；
   *   ③ 对账详情里「仍待接收的来源」把已经接收过的来源又列一遍；
   *   ④ 流转看板的「待接收来源 N 条」永远不下降。
   * 只改非作废的来源（作废是终态），重复调用是幂等的。
   */
  private async markSourceReceived(tx: Prisma.TransactionClient, type: SourceType, sourceId: string, user: CurrentUser) {
    const data = { status: "received", ...this.audit.update(user) };
    if (type === "outsource_receipt") await tx.outsourcePayableSource.updateMany({ where: { id: sourceId, status: { not: "voided" } }, data });
    else await tx.payableSource.updateMany({ where: { id: sourceId, status: { not: "voided" } }, data });
  }

  /**
   * 逐条确认应付 —— 确认即记账（用户要求：「一旦确认应付，金额就要转出对应的账户」）。
   *
   * 与「一键确认应付」（按对账单）的关系：同一件事的两条入口。按对账单确认写一条按对账单汇总的流水；
   * 逐条确认写一条只属于这条应付的流水。一条应付一旦被确认就不再是草稿，另一个入口的
   * `status = draft` 条件不会再捞到它，因此不会重复记账。
   *
   * 收支项目候选链按**来源类型**选定（原料入库 → 原材料 成本；外加工签收 → 成品外加工费），
   * 与供应商付款过账同一套归类口径；人工选了就以人工为准。
   */
  async confirm(id: string, user: CurrentUser, options: { bank_id?: string | null; cash_flow_item_id?: string | null } = {}) {
    // 先进校验、后进事务：等事务提交完才发现银行非法，应付已经确认、流水却没写。
    if (options.bank_id) await requireActiveBank(this.prisma, options.bank_id, "支付银行不存在或已停用");
    if (options.cash_flow_item_id) await this.cashFlow.requireItem(options.cash_flow_item_id, "收支项目不存在或已停用，请在「收支管理 → 收支项目」里确认");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payable_entries WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayableEntry.findFirst({ where: { id, deletedAt: null }, include: { payableSource: { select: { status: true } }, outsourcePayableSource: { select: { status: true } }, supplier: { select: { name: true } } } });
      if (!current) throw this.notFound("SUPPLIER_PAYABLE_NOT_FOUND", "应付确认不存在");
      if (current.status !== "draft") throw this.invalid("SUPPLIER_PAYABLE_NOT_CONFIRMABLE", "只有草稿应付可以确认");
      if (current.payableSource?.status === "voided" || current.outsourcePayableSource?.status === "voided") throw this.invalid("PAYABLE_SOURCE_VOIDED", "应付来源已作废，不能确认");
      const updated = await tx.supplierPayableEntry.update({ where: { id }, data: { status: "confirmed", ...this.audit.update(user) } });
      // 供应商名要从 current 拿：update 的返回值只有标量列，没有关联，用 row 会退化成供应商 UUID。
      return { updated, supplierName: current.supplier?.name ?? current.supplierId };
    });
    const row = result.updated;
    await this.audit.recordWithOrderNo("supplier_payable.confirm", "supplier_payable_entry", row.orderNo ?? "", user.id, id, { payable_no: row.payableNo });
    const cashFlow = await this.cashFlow.recordConfirmation({
      sourceType: "supplier_payable_entry",
      sourceId: id,
      documentNo: row.payableNo,
      entryDate: this.today(),
      amount: row.amount,
      currency: row.currency,
      counterpartyName: result.supplierName,
      direction: "expense",
      itemKeys: row.sourceType ? paymentItemKeys(row.sourceType) : PAYABLE_CONFIRM_ITEM_KEYS,
      itemId: options.cash_flow_item_id,
      bankId: options.bank_id ?? null,
      remark: `确认应付 ${row.payableNo}`,
    }, user);
    return { ...row, cash_flow_entry_id: cashFlow?.id ?? null, bank_missing: !options.bank_id };
  }

  /**
   * 编辑草稿应付：金额、确认日期、**币种**、备注。
   *
   * 与应收侧同样的道理：草稿还没核销任何付款，此时改币种是安全的；
   * 过账时 SupplierPaymentService.post 仍会校验 `entry.currency === payment.currency`。
   */
  async updateDraft(id: string, input: { amount?: string; confirmation_date?: string; currency?: string; remark?: string }, user: CurrentUser) {
    if (input.currency !== undefined) await this.currencies?.assertSupported(input.currency, "应付币种");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payable_entries WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayableEntry.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw this.notFound("SUPPLIER_PAYABLE_NOT_FOUND", "应付确认不存在");
      if (current.status !== "draft") throw this.invalid("SUPPLIER_PAYABLE_NOT_EDITABLE", "只有草稿应付可以编辑");
      const amount = input.amount === undefined ? current.amount : this.decimal(input.amount, "INVALID_PAYABLE_AMOUNT");
      return tx.supplierPayableEntry.update({ where: { id }, data: { amount, confirmationDate: input.confirmation_date ? this.date(input.confirmation_date) : current.confirmationDate, currency: input.currency ?? current.currency, remark: input.remark ?? current.remark, ...this.audit.update(user) } });
    });
    await this.audit.recordWithOrderNo("supplier_payable.update", "supplier_payable_entry", row.orderNo ?? "", user.id, id, { amount: row.amount.toString() });
    return row;
  }

  async reopen(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("CORRECTION_REASON_REQUIRED", "回退草稿必须填写原因");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payable_entries WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayableEntry.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } });
      if (!current) throw this.notFound("SUPPLIER_PAYABLE_NOT_FOUND", "应付确认不存在");
      if (current.status !== "confirmed") throw this.invalid("SUPPLIER_PAYABLE_NOT_REOPENABLE", "只有未发生付款的已确认应付可以回退草稿");
      if (current.allocations.some((allocation) => allocation.payment.status === "posted")) throw this.invalid("SUPPLIER_PAYABLE_HAS_ALLOCATIONS", "应付存在有效付款核销，必须先冲销付款");
      return tx.supplierPayableEntry.update({ where: { id }, data: { status: "draft", remark: `${current.remark ?? ""}\n回退草稿：${reason.trim()}`, ...this.audit.update(user) } });
    });
    await this.audit.recordWithOrderNo("supplier_payable.reopen", "supplier_payable_entry", row.orderNo ?? "", user.id, id, { reason: reason.trim(), from: "confirmed", to: "draft" });
    return row;
  }

  async reverse(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("REVERSAL_REASON_REQUIRED", "冲销必须填写原因");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM supplier_payable_entries WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.supplierPayableEntry.findFirst({ where: { id, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } });
      if (!current) throw this.notFound("SUPPLIER_PAYABLE_NOT_FOUND", "应付确认不存在");
      if (!["confirmed", "partially_paid", "paid"].includes(current.status)) throw this.invalid("SUPPLIER_PAYABLE_NOT_REVERSIBLE", "当前应付不可冲销");
      if (current.allocations.some((allocation) => allocation.payment.status === "posted")) throw this.invalid("SUPPLIER_PAYABLE_HAS_ALLOCATIONS", "应付存在有效付款核销，必须先冲销付款");
      return tx.supplierPayableEntry.update({ where: { id }, data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason.trim()}`, ...this.audit.update(user) } });
    });
    await this.audit.recordWithOrderNo("supplier_payable.reverse", "supplier_payable_entry", row.orderNo ?? "", user.id, id, { reason: reason.trim() });
    return row;
  }

  async allocationBalance(id: string, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    const entry = await client.supplierPayableEntry.findFirst({ where: { id, deletedAt: null } });
    if (!entry) throw this.notFound("SUPPLIER_PAYABLE_NOT_FOUND", "应付确认不存在");
    const result = await client.supplierPaymentAllocation.aggregate({ where: { payableEntryId: id, deletedAt: null, status: "active", payment: { status: "posted" } }, _sum: { amount: true } });
    const allocated = new Prisma.Decimal(result._sum.amount ?? 0);
    return { entry, allocated, available: entry.amount.minus(allocated) };
  }

  async refreshStatus(client: Prisma.TransactionClient, id: string, user: CurrentUser) {
    const { entry, available } = await this.allocationBalance(id, client);
    if (["reversed", "voided"].includes(entry.status)) return entry;
    const next = available.eq(0) ? "paid" : available.lt(entry.amount) ? "partially_paid" : "confirmed";
    return client.supplierPayableEntry.update({ where: { id }, data: { status: next, ...this.audit.update(user) } });
  }

  async orderSummary(orderNo: string) {
    const entries = await this.prisma.supplierPayableEntry.findMany({ where: { orderNo, deletedAt: null }, include: { allocations: { where: { deletedAt: null, status: "active" }, include: { payment: true } } } });
    const amount = entries.filter((entry) => entry.status !== "reversed").reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
    const allocated = entries.reduce((sum, entry) => sum.plus(entry.allocations.filter((allocation) => allocation.payment.status === "posted").reduce((inner, allocation) => inner.plus(allocation.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0));
    return { order_no: orderNo, payable_entry_count: entries.length, payable_amount: amount.toString(), allocated_amount: allocated.toString(), outstanding_amount: amount.minus(allocated).toString(), status: amount.eq(0) || allocated.eq(0) ? "unpaid" : allocated.gte(amount) ? "paid" : "partially_paid" };
  }

  async createOther(input: { supplier_id: string; amount: string; currency: string; description: string; confirmation_date?: string; attachment?: unknown[]; remark?: string }, user: CurrentUser) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: input.supplier_id, deletedAt: null }, select: { id: true, name: true } });
    if (!supplier) throw this.notFound("SUPPLIER_NOT_FOUND", "供应商不存在");
    const amount = this.decimal(input.amount, "INVALID_PAYABLE_AMOUNT");
    const row = await this.prisma.supplierPayableEntry.create({ data: {
      payableNo: this.number("APO"), orderNo: null, supplierId: supplier.id,
      sourceType: "other", payableSourceId: null, outsourcePayableSourceId: null,
      purchaseOrderId: null, purchaseOrderItemId: null, outsourceLogisticsBatchId: null,
      sourceNoSnapshot: `其他应付-${input.description.slice(0, 30)}`, quantity: new Prisma.Decimal(1),
      unitPrice: amount, taxRate: new Prisma.Decimal(0), amount, currency: input.currency,
      confirmationDate: input.confirmation_date ? this.date(input.confirmation_date) : new Date(),
      attachment: (input.attachment ?? []) as Prisma.InputJsonValue,
      remark: input.remark, ...this.audit.create(user),
    } });
    await this.audit.record("supplier_payable.create_other", "supplier_payable_entry", user.id, row.id, { payable_no: row.payableNo, description: input.description, amount: row.amount.toString(), supplier_name: supplier.name });
    return row;
  }

  private async source(type: SourceType, id: string, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    if (type === "raw_material_inbound" || type === "purchase_receipt") {
      const row = await client.payableSource.findFirst({ where: { id, status: { not: "voided" }, OR: [{ rawMaterialInbound: { deletedAt: null } }, { purchaseReceipt: { deletedAt: null } }] }, include: { rawMaterialInbound: true, purchaseReceipt: true } });
      if (!row) throw this.notFound("PAYABLE_SOURCE_NOT_FOUND", "原料入库应付来源不存在或已作废");
      const extensionData = (row.purchaseReceipt?.extensionData ?? {}) as { batch_sequence?: number };
      return { orderNo: row.orderNo, supplierId: row.supplierId, sourceNo: row.rawMaterialInbound?.inboundNo ?? row.purchaseReceipt?.receiptNo ?? row.id, batchSequence: extensionData.batch_sequence ?? null, quantity: row.quantity, unitPrice: row.unitPrice, taxRate: row.taxRate, amount: row.amount, currency: row.currency, purchaseOrderId: row.purchaseOrderId, purchaseOrderItemId: row.purchaseOrderItemId, outsourceLogisticsBatchId: null };
    }
    const row = await client.outsourcePayableSource.findFirst({ where: { id, status: { not: "voided" } }, include: { logisticsBatch: true, outsourceReceipt: true } });
    if (!row) throw this.notFound("PAYABLE_SOURCE_NOT_FOUND", "外加工应付来源不存在或已作废");
    return { orderNo: row.orderNo, supplierId: row.supplierId, sourceNo: `${row.logisticsBatch.batchNo}/${row.outsourceReceipt.id.slice(0, 8)}`, quantity: row.quantity, unitPrice: row.unitPrice, taxRate: row.taxRate, amount: row.amount, currency: row.currency, purchaseOrderId: row.purchaseOrderId, purchaseOrderItemId: row.purchaseOrderItemId, outsourceLogisticsBatchId: row.logisticsBatchId };
  }

  private decimal(value: string, code: string) { try { const result = new Prisma.Decimal(value); if (result.lte(0)) throw new Error(); return result; } catch { throw this.invalid(code, "金额必须是大于零的十进制数"); } }
  private date(value: string) { const result = new Date(`${value}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) throw this.invalid("INVALID_CONFIRMATION_DATE", "确认日期无效"); return result; }
  private number(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`; }
  /** 确认发生的日期（记账日）：取当天的 UTC 零点，让流水日期与「今天」在库里可比较、可复现。 */
  private today() { return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`); }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}