import { Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { dailyCodePrefix, nextSequenceCode } from "../../platform/database/daily-sequence-code";
import { sourceType, coveringPayableReconciliation } from "./supplier-payable.domain";
import { matchesLedgerFilter, type LedgerFilter } from "./ledger-filter";
import { requireActiveBank } from "./bank-selection";
import { CashFlowService } from "./cash-flow.service";
import { paymentSubjectNames, PAYABLE_CONFIRM_SUBJECT_NAMES } from "./accounting-subject-catalog";
import { OTHER_PAYABLE_MAX_ROWS, otherPayableTemplateWorkbook, parseOtherPayableRows, type OtherPayableImportError } from "./other-payable-import";

type SourceType = "raw_material_inbound" | "purchase_receipt" | "outsource_receipt";
export type PayableEntryInput = { source_type: SourceType; source_id: string; amount?: string; amount_reason?: string; confirmation_date?: string; attachment?: unknown[]; remark?: string };
/** 上传的文件（只用到这两个字段，避免为了一个导入去依赖 multer 的类型声明）。 */
type UploadedWorkbook = { buffer?: Buffer; originalname?: string };

export type OtherPayableImportResult = {
  status: "ok" | "partial" | "failed";
  total: number;
  /** 真正落库的行数（校验失败的行不计）。 */
  imported: number;
  successCount: number;
  errorCount: number;
  headerRow: number;
  errors: OtherPayableImportError[];
  missingColumns: string[];
  ignoredColumns: string[];
  ignoredTrailingRows: number;
  /** 这次导入顺手建进供应商池的供应商（请导入后去补联系方式）。 */
  createdSuppliers: Array<{ name: string; supplierCode: string; rows: number }>;
  hints: string[];
};


@Injectable()
export class SupplierPayableService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly cashFlow: CashFlowService, @Optional() private readonly currencies?: CurrencyService) {}

  /**
   * 应付台账列表。
   *
   * `filter`（可选）是「确认应付」页的筛选：付款情况 + 时间范围 + 关键字。
   * 为什么过滤放在 **map 之后**而不是 Prisma where 里：关键字要匹配物料名 / 供应商名 / 来源批次号，
   * 这些都是 map 阶段才从关联里摊平出来的（`material_name` / `supplier_name` / `source_no`）。
   * 台账是财务按月核对的量级（几百到几千行），在内存里做一遍与界面搜索框完全同口径的过滤，
   * 比在 SQL 里重写一套近似规则更不容易漂移。
   */
  async list(orderNo?: string, supplierId?: string, status?: string, filter: LedgerFilter = {}) {
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
    const mapped = rows.map((row) => {
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
    return mapped.filter((row) => matchesLedgerFilter({
      status: row.status,
      // 时间范围用**确认日期**：应付台账的月份归属就是它（与「待对账月份」同一口径）。
      date: row.confirmationDate,
      search: [row.payableNo, row.orderNo, row.supplier_name, row.material_name, row.material_code, row.purchase_order_no, row.source_no],
    }, filter));
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
   * 会计科目候选链按**来源类型**选定（原料入库 → 原材料 成本；外加工签收 → 成品外加工费），
   * 与供应商付款过账同一套归类口径；人工选了就以人工为准。
   */
  async confirm(id: string, user: CurrentUser, options: { bank_id?: string | null; subject_id?: string | null } = {}) {
    // 先进校验、后进事务：等事务提交完才发现银行非法，应付已经确认、流水却没写。
    if (options.bank_id) await requireActiveBank(this.prisma, options.bank_id, "支付银行不存在或已停用");
    if (options.subject_id) await this.cashFlow.requireSubject(options.subject_id, "会计科目不存在或已停用，请在「收支管理 → 会计科目」里确认");
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
      subjectNames: row.sourceType ? paymentSubjectNames(row.sourceType) : PAYABLE_CONFIRM_SUBJECT_NAMES,
      subjectId: options.subject_id,
      bankId: options.bank_id ?? null,
      remark: `确认应付 ${row.payableNo}`,
    }, user);
    return { ...row, cash_flow_entry_id: cashFlow?.id ?? null, bank_missing: !options.bank_id };
  }

  /**
   * 批量确认应付 —— 界面「确认应付」页勾选多条 → 一次确认（用户要求「直接就是支持勾选，批量确认」）。
   *
   * 为什么需要：一笔应付 = **一个来源批次**，一批料分几次入库就是几条应付；逐条确认意味着
   * 同一批料要开 N 次弹窗、把银行账户填 N 遍。批量确认把「钱从哪个账户出、归哪个项目」
   * **只问一次**，记账仍然**每条应付写一条流水**（与 `ReceivableService.batchConfirmByOrder` 同一口径）
   * —— 每条应付都有自己的单号，合并成一条流水就再也追不回是哪批料的钱。
   *
   * 幂等：只确认 `status = draft` 的条目。被另一个入口先确认掉的、来源已作废的计入 `skipped_count`，
   * 既不报错也不重复记账（重复记账＝同一个账户被扣两次）。
   */
  async batchConfirm(ids: string[], user: CurrentUser, options: { bank_id?: string | null; subject_id?: string | null } = {}) {
    if (!ids.length) throw this.invalid("PAYABLE_IDS_REQUIRED", "请先勾选要确认的应付条目");
    // 银行与项目整批只有一个，先校验一次即可（逐条确认里那句「先校验后进事务」在这里同样成立）。
    if (options.bank_id) await requireActiveBank(this.prisma, options.bank_id, "支付银行不存在或已停用");
    if (options.subject_id) await this.cashFlow.requireSubject(options.subject_id, "会计科目不存在或已停用，请在「收支管理 → 会计科目」里确认");
    const result = await this.prisma.$transaction(async (tx) => {
      // 逐条加锁：批量确认不需要「一次锁住全部」的强一致，但每条都要保证「读到草稿 → 改成已确认」
      // 之间不被另一个入口插进来（单条确认、对账确认用的是同一把行锁，因此互相串行）。
      for (const id of ids) await tx.$queryRaw`SELECT id FROM supplier_payable_entries WHERE id = ${id}::uuid FOR UPDATE`;
      const drafts = await tx.supplierPayableEntry.findMany({
        where: { id: { in: ids }, deletedAt: null, status: "draft" },
        select: { id: true, payableNo: true, orderNo: true, amount: true, currency: true, sourceType: true, supplierId: true, supplier: { select: { name: true } }, payableSource: { select: { status: true } }, outsourcePayableSource: { select: { status: true } } },
      });
      // 来源已作废的不能确认（与逐条确认同一条校验）；但它不该让整批失败 —— 跳过并如实回报条数。
      const confirmable = drafts.filter((draft) => draft.payableSource?.status !== "voided" && draft.outsourcePayableSource?.status !== "voided");
      if (!confirmable.length) throw this.invalid("NO_DRAFT_PAYABLES", "勾选的条目里没有可确认的草稿应付");
      const updated = await tx.supplierPayableEntry.updateMany({
        where: { id: { in: confirmable.map((draft) => draft.id) }, deletedAt: null, status: "draft" },
        data: { status: "confirmed", ...this.audit.update(user) },
      });
      // 行锁之下不可能少改：真少了说明有人绕过锁改了状态，宁可整批回滚也不要「界面说确认了、库里没确认」。
      if (updated.count !== confirmable.length) throw this.invalid("PAYABLE_CONFIRM_CONFLICT", "勾选的应付已被其他操作改动，请刷新后重试");
      return { confirmable, skipped: ids.length - confirmable.length };
    });
    const cashFlowEntryIds: string[] = [];
    const totals = new Map<string, Prisma.Decimal>();
    for (const draft of result.confirmable) {
      await this.audit.recordWithOrderNo("supplier_payable.confirm", "supplier_payable_entry", draft.orderNo ?? "", user.id, draft.id, { payable_no: draft.payableNo, batch: true });
      const entry = await this.cashFlow.recordConfirmation({
        sourceType: "supplier_payable_entry",
        sourceId: draft.id,
        documentNo: draft.payableNo,
        entryDate: this.today(),
        amount: draft.amount,
        currency: draft.currency,
        counterpartyName: draft.supplier?.name ?? draft.supplierId,
        direction: "expense",
        subjectNames: draft.sourceType ? paymentSubjectNames(draft.sourceType) : PAYABLE_CONFIRM_SUBJECT_NAMES,
        subjectId: options.subject_id,
        bankId: options.bank_id ?? null,
        remark: `确认应付 ${draft.payableNo}（勾选批量确认）`,
      }, user);
      if (entry) cashFlowEntryIds.push(entry.id);
      totals.set(draft.currency, (totals.get(draft.currency) ?? new Prisma.Decimal(0)).plus(draft.amount));
    }
    return {
      ids: result.confirmable.map((draft) => draft.id),
      confirmed_count: result.confirmable.length,
      skipped_count: result.skipped,
      // 合计**按币种分组**：跨币种相加得到的是一个没有意义的数（与财务报表「不跨币种相加」同一口径）。
      amounts: [...totals.entries()].map(([currency, amount]) => ({ currency, amount: amount.toFixed(4) })),
      cash_flow_entry_ids: cashFlowEntryIds,
      bank_missing: !options.bank_id,
    };
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
    const row = await this.prisma.supplierPayableEntry.create({ data: this.otherEntryData({
      supplierId: supplier.id, amount, currency: input.currency, description: input.description,
      confirmationDate: input.confirmation_date ? this.date(input.confirmation_date) : new Date(),
      attachment: input.attachment, remark: input.remark,
    }, user) });
    await this.audit.record("supplier_payable.create_other", "supplier_payable_entry", user.id, row.id, { payable_no: row.payableNo, description: input.description, amount: row.amount.toString(), supplier_name: supplier.name });
    return row;
  }

  /**
   * 其他应付条目的**唯一**建单口径：单条新建（`createOther`）与批量导入都走这里，
   * 否则「页面上新建的」与「导入进来的」会在来源快照、数量/单价、税率这些字段上慢慢分叉。
   */
  private otherEntryData(input: { supplierId: string; amount: Prisma.Decimal; currency: string; description: string; confirmationDate: Date; attachment?: unknown[]; remark?: string }, user: CurrentUser) {
    return {
      payableNo: this.number("APO"), orderNo: null, supplierId: input.supplierId,
      sourceType: "other", payableSourceId: null, outsourcePayableSourceId: null,
      purchaseOrderId: null, purchaseOrderItemId: null, outsourceLogisticsBatchId: null,
      sourceNoSnapshot: `其他应付-${input.description.slice(0, 30)}`, quantity: new Prisma.Decimal(1),
      unitPrice: input.amount, taxRate: new Prisma.Decimal(0), amount: input.amount, currency: input.currency,
      confirmationDate: input.confirmationDate,
      attachment: (input.attachment ?? []) as Prisma.InputJsonValue,
      remark: input.remark, ...this.audit.create(user),
    };
  }

  /** 其他应付导入模板（一页数据表 + 一页填写说明）。 */
  otherImportTemplate() { return otherPayableTemplateWorkbook(); }

  /**
   * 其他应付批量导入（用户 2026-09-16：「有一些非原料类的支出…要支持批量导入这类应付对账条目」）。
   *
   * 三段式，与员工花名册导入同一套纪律：
   *   1. **解析**（纯函数 `parseOtherPayableRows`）：表头按名字认列、逐行校验；
   *      找不到表头 / 缺必需列 / 没有数据行 → 一行都不写，只回一条整体错误；
   *   2. **写库**：通过校验的行在**一个事务**里建供应商（认不到时）与应付草稿 ——
   *      要么全进、要么全不进。金额行最怕「半个文件进去了」，重传又变成重复记账；
   *   3. 逐行错误如实回报（`errors`），行级错误不连坐。
   *
   * 供应商匹配：编码 → 名称（都忽略大小写与空格），两边都没命中时按名称自动建档
   * （编码用平台统一的 SUP-当天日期-序号，同一批内不重复），并在结果里列出来请财务复核。
   */
  async importOther(file: UploadedWorkbook | undefined, user: CurrentUser): Promise<OtherPayableImportResult> {
    if (!file?.buffer?.length) throw this.invalid("PAYABLE_IMPORT_FILE_REQUIRED", "请上传Excel文件（仅支持 .xlsx/.xls）");
    // 控制器层的 Multer 白名单已经挡过一道；这里再按扩展名挡一次 —— 「上传了一个 CSV/PDF」
    // 应当回一句「只支持 .xlsx/.xls」，而不是让解析器把它读成空表再报「找不到表头」。
    if (file.originalname && !/\.(xlsx|xls)$/i.test(file.originalname)) throw this.invalid("PAYABLE_IMPORT_INVALID_FILE", "只支持 .xlsx / .xls 文件，请使用「下载模板」得到的模板填写");
    const sheetRows = this.readImportSheet(file);
    const parsed = parseOtherPayableRows(sheetRows);
    const empty = { imported: 0, successCount: 0, createdSuppliers: [] as OtherPayableImportResult["createdSuppliers"] };
    if (parsed.status === "failed" && !parsed.rows.length) {
      return { ...empty, status: "failed", total: parsed.total, errorCount: parsed.errors.length, headerRow: parsed.headerRow, errors: parsed.errors, missingColumns: parsed.missingColumns, ignoredColumns: parsed.ignoredColumns, ignoredTrailingRows: parsed.ignoredTrailingRows, hints: parsed.hints };
    }

    // 供应商池一次性读完做匹配表：一个厂的供应商是几百条量级，比逐行查库更省也更一致。
    const suppliers = await this.prisma.supplier.findMany({ where: { deletedAt: null }, select: { id: true, supplierCode: true, name: true } });
    const key = (value: string) => value.replace(/\s+/g, "").toLowerCase();
    const byCode = new Map(suppliers.map((row) => [key(row.supplierCode), row]));
    const byName = new Map(suppliers.map((row) => [key(row.name), row]));
    const existingCodes = await this.prisma.supplier.findMany({ where: { supplierCode: { startsWith: dailyCodePrefix("SUP") } }, select: { supplierCode: true } });
    const usedCodes = existingCodes.map((row) => row.supplierCode);

    const created: string[] = [];
    const createdSuppliers = new Map<string, { name: string; supplierCode: string; rows: number }>();

    await this.prisma.$transaction(async (tx) => {
      for (const row of parsed.rows) {
        const codeKey = row.supplierCode ? key(row.supplierCode) : "";
        const nameKey = row.supplierName ? key(row.supplierName) : "";
        let supplier = (codeKey ? byCode.get(codeKey) : undefined) ?? (nameKey ? byName.get(nameKey) : undefined);
        if (!supplier) {
          // 认不到就自动建档：非原料支出（运费/房租/水电）的对方常常不在供应商池里，
          // 强制先建档会让「导入」这件事退回成手工活。名称优先，其次用文件里的编码当名称。
          const name = row.supplierName || row.supplierCode;
          const supplierCode = nextSequenceCode(dailyCodePrefix("SUP"), usedCodes);
          usedCodes.push(supplierCode);
          const row2 = await tx.supplier.create({ data: { supplierCode, name, ...this.audit.create(user) } });
          supplier = { id: row2.id, supplierCode: row2.supplierCode, name: row2.name };
          byCode.set(key(supplierCode), supplier);
          byName.set(key(name), supplier);
          createdSuppliers.set(key(name), { name, supplierCode, rows: 0 });
        }
        // 计数放在解析之后：同一个新建供应商被后面几行复用时，条数要跟着涨
        // （财务要看的是「这个名字一共带进来几条应付」）。
        const tracked = createdSuppliers.get(key(supplier.name));
        if (tracked) tracked.rows += 1;
        const entry = await tx.supplierPayableEntry.create({ data: this.otherEntryData({
          supplierId: supplier.id,
          amount: new Prisma.Decimal(row.amount),
          currency: row.currency,
          description: row.description,
          // 日期留空 = 按导入当天记账（与手工新建其他应付的默认值一致）。
          confirmationDate: row.confirmationDate ? this.date(row.confirmationDate) : new Date(),
          remark: row.remark || undefined,
        }, user) });
        created.push(entry.payableNo);
      }
    });

    for (const createdSupplier of createdSuppliers.values()) {
      await this.audit.record("supplier.create_from_payable_import", "supplier", user.id, undefined, {
        supplier_code: createdSupplier.supplierCode, name: createdSupplier.name, rows: createdSupplier.rows,
      });
    }
    await this.audit.record("supplier_payable.import_other", "supplier_payable_entry", user.id, undefined, {
      imported: created.length, total: parsed.total, error_count: parsed.errors.length,
      created_suppliers: [...createdSuppliers.values()],
    });

    const hints = [...parsed.hints];
    if (createdSuppliers.size) hints.push(`新增了 ${createdSuppliers.size} 个供应商（${[...createdSuppliers.values()].map((item) => item.name).join("、")}）：请到【采购 → 供应商池】补联系方式`);
    hints.push("导入的是应付草稿：可在【应付对账 → 待创建对账】继续对账，也可直接在【确认应付】勾选批量确认");

    return {
      status: parsed.errors.length ? "partial" : "ok",
      total: parsed.total,
      imported: created.length,
      successCount: created.length,
      errorCount: parsed.errors.length,
      headerRow: parsed.headerRow,
      errors: parsed.errors,
      missingColumns: parsed.missingColumns,
      ignoredColumns: parsed.ignoredColumns,
      ignoredTrailingRows: parsed.ignoredTrailingRows,
      createdSuppliers: [...createdSuppliers.values()],
      hints,
    };
  }

  /** 读工作簿第一张表：固定 `cellDates: false`（见 parseRosterDate 的注释），并挡住超大文件。 */
  private readImportSheet(file: UploadedWorkbook): unknown[][] {
    try {
      const book = XLSX.read(file.buffer, { type: "buffer", cellDates: false });
      const sheet = book.Sheets[book.SheetNames[0]];
      if (!sheet) throw new Error("sheet-missing");
      const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]!) : null;
      if (range) {
        const rowCount = range.e.r - range.s.r + 1;
        if (rowCount > OTHER_PAYABLE_MAX_ROWS + 20) throw this.invalid("PAYABLE_IMPORT_ROWS_EXCEEDED", `单次最多导入${OTHER_PAYABLE_MAX_ROWS}行`);
      }
      return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" }) as unknown[][];
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      throw this.invalid("PAYABLE_IMPORT_INVALID_FILE", "Excel文件无法解析，请使用「下载模板」得到的模板填写");
    }
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