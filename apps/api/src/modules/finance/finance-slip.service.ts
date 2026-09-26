import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import { makerStamp } from "../../platform/audit/maker-stamp";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { beijingDateTime } from "../../platform/time/beijing-time";
import { RECEIVABLE_CONFIRM_SUBJECT_NAMES, paymentSubjectNames } from "./accounting-subject-catalog";
import {
  SLIP_KIND_LABELS,
  counterpartyBankOf,
  financeSlipFileName,
  financeSlipsFileName,
  groupSlipEntries,
  renderFinanceSlipsWorkbook,
  slipTotals,
  validateFinanceSlip,
  type FinanceSlip,
  type FinanceSlipKind,
  type FinanceSlipLine,
} from "./finance-slip";

/** 可开单的条目状态：草稿（还没记账）+ 已记账的都行 —— 单子是一张打印件，不要求先确认。 */
const ENTRY_STATUSES = ["draft", "confirmed", "partially_paid", "paid"] as const;

/**
 * 收/付款单的**预填与导出**服务（财务 2026-09-20）。
 *
 * 两种单据共用一套流程，差别只有三处：条目从哪张表来（应付 / 应收）、
 * 「钱走哪一侧」（付款是贷银行存款、收款是借银行存款）、以及对方的称谓（供应商 / 客户）：
 *
 *   - `draft(kind, ids)`：按勾选的条目**预填**单子（对方单位 / 我方账户 / 对方账户 /
 *     附单据张数 / 分录行 / 单据编号 / 制单人）。预填只是起点 —— 财务在界面上改金额、加行、写备注。
 *     **返回数组**：勾选跨对方单位 / 跨币种时按「对方单位 + 币种」拆成多张（一次勾选 = 一次集中付款）；
 *   - `export(slip)` / `exportMany(slips)`：校验（`validateFinanceSlip`）后渲染 xlsx 并审计。
 *     **以界面提交的内容为准**，不回头覆盖成系统算出来的值：财务改了金额（「我要付款 100」）
 *     就该按 100 出单，否则这张单子就不是她要的那张。
 *
 * 为什么预填口径放在服务端而不是前端常量：借方/贷方科目来自**这条条目在确认时实际记账用的科目**
 * （`cash_flow_entries.subject`），只有服务端知道；单号规则与「本月第几笔」也只有服务端算得出来。
 */
@Injectable()
export class FinanceSlipService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /**
   * 按条目预填收/付款单 —— **返回一个数组**：勾选的条目会按「对方单位 + 币种」自动拆成多张单子。
   *
   * 约束（仍然是硬约束，只是不再靠报错来维持）：一张单子的全部条目必须同属一个对方单位与一个币种
   * （模板上「收款单位 / 开户银行 / 银行账号」只有一格，单子也只有一个大写金额）。
   * 用户 2026-09-24 的口径是「一次勾选把该付的都付掉」，所以跨对方单位/跨币种不再 422，
   * 而是**分组**：一组一张（见 `groupSlipEntries`）。混着两家报错等于逼她一家一家重选。
   */
  async draft(kind: FinanceSlipKind, ids: string[], user: CurrentUser): Promise<FinanceSlip[]> {
    const label = SLIP_KIND_LABELS[kind];
    if (!ids?.length) throw this.invalid(`${this.prefix(kind)}_ENTRY_REQUIRED`, `请先勾选条目，再导出${label.name}`);
    return kind === "payment" ? this.draftPayment(ids, user) : this.draftReceipt(ids, user);
  }

  /**
   * 导出收/付款单 xlsx。
   *
   * 校验不过直接 422，并且**一次把全部问题说出来**（哪一行、缺什么），不让财务改一个试一次。
   * 落款用 `makerStamp`（与其余导出件同一套纪律）：这份文件是谁、什么时候生成的。
   */
  async export(slip: FinanceSlip, user: CurrentUser): Promise<{ body: Buffer; fileName: string }> {
    this.assertExportable([slip]);
    const body = await renderFinanceSlipsWorkbook([{ ...slip, footnote: makerStamp(user) }]);
    await this.recordExport(slip, user);
    return { body, fileName: financeSlipFileName(slip) };
  }

  /**
   * 「全部导出」：把队列里的多张单子渲染成**一个工作簿（一张单子一个工作表）**。
   *
   * 为什么不是逐张下载：一次集中付款可能拆出十几张，浏览器的连续下载拦截会让财务只拿到第一张
   * （她看到的是「后面的都没出来」，而且不知道丢了几张）。一个文件拿全、工作表的打印设置各自独立，
   * 逐张打印与原来一样。
   *
   * 校验失败时**按张点名**（`第 2 张（绍兴纺织）：第 3 行请填写摘要或总账科目`）：
   * 队列里有五张时，一句不带主语的「第 3 行请填写…」根本没法定位是哪一张。
   */
  async exportMany(slips: FinanceSlip[], user: CurrentUser): Promise<{ body: Buffer; fileName: string }> {
    if (!slips?.length) throw this.invalid("SLIP_REQUIRED", "没有可导出的单据");
    this.assertExportable(slips);
    const body = await renderFinanceSlipsWorkbook(slips.map((slip) => ({ ...slip, footnote: makerStamp(user) })));
    for (const slip of slips) await this.recordExport(slip, user, slips.length);
    return { body, fileName: financeSlipsFileName(slips[0].kind, slips.length) };
  }

  /** 逐张校验，把每张的问题都带上「第 N 张（对方单位）」前缀，一次说完。 */
  private assertExportable(slips: readonly FinanceSlip[]) {
    const problems = slips.flatMap((slip, index) => {
      const named = slips.length > 1 ? `第 ${index + 1} 张（${slip.counterparty_name || slip.slip_no || "未编号"}）：` : "";
      return validateFinanceSlip(slip).map((problem) => ({ ...problem, message: `${named}${problem.message}` }));
    });
    if (!problems.length) return;
    throw new UnprocessableEntityException({
      code: problems[0].code,
      message: problems.map((problem) => problem.message).join("；"),
      details: problems.map((problem) => ({ code: problem.code, ...(problem.details[0] ?? {}) })),
    });
  }

  /** 审计：一张单子一条（单据是**逐张**签发的凭证，一张一条才追得回「哪张是谁什么时候导出的」）。 */
  private async recordExport(slip: FinanceSlip, user: CurrentUser, batchSize?: number) {
    const totals = slipTotals(slip.lines);
    await this.audit.record(`${slip.kind}_slip.export`, `${slip.kind}_slip`, user.id, undefined, {
      slip_no: slip.slip_no,
      counterparty_name: slip.counterparty_name,
      currency: slip.currency,
      amount: totals.debit,
      line_count: slip.lines.length,
      // 一次导出多张时记下这一批的规模：审计里几行同批的记录否则看不出「这是一次集中付款」。
      ...(batchSize && batchSize > 1 ? { batch_size: batchSize } : {}),
    });
  }

  // ------------------------------------------------------------------ 付款单预填

  private async draftPayment(ids: string[], user: CurrentUser): Promise<FinanceSlip[]> {
    const entries = await this.prisma.supplierPayableEntry.findMany({
      where: { id: { in: ids }, deletedAt: null, status: { in: [...ENTRY_STATUSES] } },
      include: {
        supplier: { select: { id: true, name: true, settlementInfo: true } },
        payableSource: { select: { purchaseOrderItem: { select: { material: { select: { name: true } }, materialSnapshot: true } } } },
        outsourcePayableSource: { select: { logisticsBatch: { select: { material: { select: { name: true } } } } } },
      },
      // 定序：单子上的行序要稳定（同一批勾选每次打开都是同一个顺序），按确认日期 + 应付单号。
      orderBy: [{ confirmationDate: "asc" }, { payableNo: "asc" }],
    });
    if (entries.length !== ids.length) throw this.notFound(this.prefix("payment") + "_ENTRY_NOT_FOUND", "勾选的应付条目里有不存在或已删除的，请刷新后重试");

    // 确认时写下的那条流水带走了**实际用哪张卡付的**、以及**记到哪个会计科目**——
    // 这两件事正是单子上「开户银行 / 银行账号」与「总账科目」的来源，不在应付条目上。
    const flows = await this.fetchFlows("supplier_payable_entry", ids);
    const slipDate = this.today();
    const slips: FinanceSlip[] = [];
    // 同一批里给同一家已经开出去几张（见 suggestNumber 的 offset：同公司两个币种会拆两张）。
    const offsets = new Map<string, number>();
    for (const group of groupSlipEntries(entries, (entry) => entry.supplierId)) {
      const counterpartyId = group[0].supplierId;
      const counterpartyName = group[0].supplier?.name ?? counterpartyId;
      const offset = offsets.get(counterpartyId) ?? 0;
      offsets.set(counterpartyId, offset + 1);
      const bank = this.singleBank(this.flowsOf(flows, group.map((entry) => entry.id)));
      // 对方（收款单位 = 供应商）账户：结算信息是自由 JSON，认得出就预填，认不出留空。
      const counterpartyBank = counterpartyBankOf(group[0].supplier?.settlementInfo);
      let total = new Prisma.Decimal(0);
      const lines: FinanceSlipLine[] = group.map((entry) => {
        total = total.plus(entry.amount);
        return {
          summary: `支付${counterpartyName}${this.materialLabel(entry)}款`,
          // 科目优先取**确认时实际用的那个**；查不到（例如还没确认、或当年流水缺失）时退回按来源的候选链首位。
          general_subject: this.subjectOf(flows, entry.id) ?? paymentSubjectNames(entry.sourceType)[0] ?? "",
          detail_subject: "",
          debit: entry.amount.toString(),
          credit: "",
          remark: "",
        };
      });
      // 贷方行：钱从银行存款出去。这是模板样张第三行的形状，金额等于借方合计 —— 预填出来就是平的，
      // 财务要拆进项税就自己加行（拆完借贷仍然相等）。
      lines.push({
        summary: `支付${counterpartyName}款项合计`,
        general_subject: "银行存款",
        detail_subject: bank?.bankName ?? "",
        debit: "",
        credit: total.toString(),
        remark: "",
      });

      slips.push({
        kind: "payment",
        currency: group[0].currency,
        slip_no: await this.suggestNumber("payment", counterpartyId, slipDate, group.length, offset),
        slip_date: slipDate,
        slip_method: "银行转账",
        counterparty_name: counterpartyName,
        our_bank_name: bank?.bankName ?? "",
        our_bank_account: bank?.accountNumber ?? "",
        counterparty_bank_name: counterpartyBank.bank_name,
        counterparty_bank_account: counterpartyBank.bank_account,
        // 附单据张数 = 这一笔付款要对上的单据条数（一条应付对应一张入库/签收/其他应付来源单）。
        attachment_count: group.length,
        remark: "",
        maker: user.display_name ?? "",
        lines,
      });
    }
    return slips;
  }

  // ------------------------------------------------------------------ 收款单预填

  /**
   * 收款单的预填与付款单**镜像**：一行一条应收（贷「主营业务收入」等确认时用的科目），
   * 末尾一行借「银行存款 = 合计」。这样财务拿到的是一张已经平的收款单，要拆收入与税就自己加行。
   *
   * 银行同样取「确认时实际入账的那张卡」（`cash_flow_entries` 里 `direction = income` 的那条）；
   * 同样按「客户 + 币种」拆成多张（一个客户一张，跨客户勾选不再报错）。
   */
  private async draftReceipt(ids: string[], user: CurrentUser): Promise<FinanceSlip[]> {
    const entries = await this.prisma.receivableSource.findMany({
      where: { id: { in: ids }, deletedAt: null, status: { in: [...ENTRY_STATUSES] } },
      include: {
        // 客户主数据**没有**结算信息这一列（只有供应商有 `settlementInfo`），所以收款单的对方账户
        // 没有可预填的来源，只能由财务手工填 —— 这一条是查了 schema 才定下来的，不要顺手加个 include。
        customer: { select: { id: true, name: true } },
        outbound: { select: { outboundNo: true, productNameSnapshot: true } },
      },
      // 应收来源没有确认日期列（确认与生成一般同一天），行序按创建时间 + 来源编号。
      orderBy: [{ createdAt: "asc" }, { sourceNo: "asc" }],
    });
    if (entries.length !== ids.length) throw this.notFound("RECEIPT_SLIP_ENTRY_NOT_FOUND", "勾选的应收条目里有不存在或已删除的，请刷新后重试");

    const flows = await this.fetchFlows("receivable_source", ids);
    const slipDate = this.today();
    const slips: FinanceSlip[] = [];
    const offsets = new Map<string, number>();
    for (const group of groupSlipEntries(entries, (entry) => entry.customerId)) {
      const counterpartyId = group[0].customerId;
      const counterpartyName = group[0].customer?.name ?? counterpartyId;
      const offset = offsets.get(counterpartyId) ?? 0;
      offsets.set(counterpartyId, offset + 1);
      const bank = this.singleBank(this.flowsOf(flows, group.map((entry) => entry.id)));
      let total = new Prisma.Decimal(0);
      const lines: FinanceSlipLine[] = group.map((entry) => {
        total = total.plus(entry.amount);
        const product = entry.outbound?.productNameSnapshot?.trim();
        return {
          summary: `收${counterpartyName}${product || "货款"}款`,
          general_subject: this.subjectOf(flows, entry.id) ?? RECEIVABLE_CONFIRM_SUBJECT_NAMES[0] ?? "",
          detail_subject: "",
          debit: "",
          credit: entry.amount.toString(),
          remark: "",
        };
      });
      lines.push({
        summary: `收${counterpartyName}款项合计`,
        general_subject: "银行存款",
        detail_subject: bank?.bankName ?? "",
        debit: total.toString(),
        credit: "",
        remark: "",
      });

      slips.push({
        kind: "receipt",
        currency: group[0].currency,
        slip_no: await this.suggestNumber("receipt", counterpartyId, slipDate, group.length, offset),
        slip_date: slipDate,
        slip_method: "银行转账",
        counterparty_name: counterpartyName,
        our_bank_name: bank?.bankName ?? "",
        our_bank_account: bank?.accountNumber ?? "",
        // 对方（付款单位 = 客户）账户：客户主数据没有结算信息列，认不出任何东西 → 一律留空，
        // 由财务照客户回单上的付款账户手工填（见 draftReceipt 的 include 注释）。
        counterparty_bank_name: "",
        counterparty_bank_account: "",
        attachment_count: group.length,
        remark: "",
        maker: user.display_name ?? "",
        lines,
      });
    }
    return slips;
  }

  // ------------------------------------------------------------------ 共用小件

  /** 条目确认时写下的流水（带科目与银行）；两种单据只是 sourceType 不同。 */
  private fetchFlows(sourceType: string, ids: string[]) {
    return this.prisma.cashFlowEntry.findMany({
      where: { sourceType, sourceId: { in: ids }, status: "posted", deletedAt: null },
      select: { sourceId: true, subject: { select: { name: true } }, bank: { select: { id: true, bankName: true, accountNumber: true } } },
    });
  }

  /**
   * 只看**这一组条目**的流水。
   *
   * 分组之后必须按组过滤再判银行：不然「全批只有一个账户」与「这一组只有一个账户」会被混为一谈，
   * 结果是一张单子上填了另一家供应商那笔钱走的账户 —— 打印出来是一张指错账户的银行单据。
   */
  private flowsOf<T extends { sourceId: string | null }>(flows: readonly T[], sourceIds: readonly string[]): T[] {
    const wanted = new Set(sourceIds);
    return flows.filter((flow) => flow.sourceId !== null && wanted.has(flow.sourceId));
  }

  /**
   * 只在**所有条目都指向同一个账户**时才预填银行：混着两个账户的单子填哪一个都是错的，
   * 留空让财务自己写（比填一个看起来像真的的值安全）。
   */
  private singleBank(flows: Array<{ bank?: { id: string; bankName: string; accountNumber: string } | null }>) {
    const ids = [...new Set(flows.map((flow) => flow.bank?.id).filter((id): id is string => Boolean(id)))];
    return ids.length === 1 ? flows.find((flow) => flow.bank?.id === ids[0])?.bank ?? null : null;
  }

  private subjectOf(flows: Array<{ sourceId: string | null; subject?: { name: string } | null }>, sourceId: string) {
    return flows.find((flow) => flow.sourceId === sourceId)?.subject?.name ?? null;
  }

  /**
   * 单据编号的**建议值**：`<前缀>-<年月>-<序号>`（付款单 FK、收款单 SK，与财务模板样张 `FK-202609-001` 同格式）。
   *
   * 序号 = 该对方单位本月第几笔结算 = 本月已确认条数 − 本次条数 + 1：
   * 一笔一笔付下去得到 001、002……；一次结清整月就是 001。
   *
   * `offset` 是**同一批里已经给这家开出去几张**（分组拆张时才非零）：同一家供应商的 CNY 与 USD
   * 两笔会拆成两张单子，而两次调用算出来的基数是一样的 —— 不加这个偏移，两张单子会拿到同一个编号，
   * 财务打印出来就是两张同名单据（编号是她自己会核对的东西，不能靠她手工去重）。
   *
   * 为什么是「建议」而不是权威序列：单子本身**不落库**（它是一张打印件，不是系统单据），
   * 系统没有可以顺延的计数器。所以界面上这个字段是可改的，财务按自己本子上的号覆盖即可 ——
   * 与其编一个看起来权威、实际会重号的序列，不如把编号权交回去。
   *
   * 月份口径跟着各自的台账走：应付用**确认日期**（应付台账的月份归属就是它），
   * 应收用**创建日期**（应收来源没有确认日期列，列表页的「待对账月份 / 出库日期」用的也是它）。
   */
  private async suggestNumber(kind: FinanceSlipKind, counterpartyId: string, slipDate: string, entryCount: number, offset = 0): Promise<string> {
    const month = slipDate.slice(0, 7);
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
    const settled = counterpartyId
      ? kind === "payment"
        ? await this.prisma.supplierPayableEntry.count({ where: { supplierId: counterpartyId, deletedAt: null, status: { in: ["confirmed", "partially_paid", "paid"] }, confirmationDate: { gte: start, lte: end } } })
        : await this.prisma.receivableSource.count({ where: { customerId: counterpartyId, deletedAt: null, status: { in: ["confirmed", "partially_paid", "paid"] }, createdAt: { gte: start, lte: end } } })
      : 0;
    const sequence = Math.max(1, settled - entryCount + 1) + offset;
    return `${SLIP_KIND_LABELS[kind].numberPrefix}-${month.replace("-", "")}-${String(sequence).padStart(3, "0")}`;
  }

  /** 一行单据的「是什么款」：物料名 → 其他应付的支出说明 → 泛称「材料」。 */
  private materialLabel(entry: {
    sourceType: string;
    sourceNoSnapshot: string;
    payableSource?: { purchaseOrderItem?: { material?: { name: string } | null; materialSnapshot?: unknown } | null } | null;
    outsourcePayableSource?: { logisticsBatch?: { material?: { name: string } | null } | null } | null;
  }): string {
    const snapshot = (entry.payableSource?.purchaseOrderItem?.materialSnapshot as { name?: string } | null | undefined)?.name ?? null;
    const material = entry.payableSource?.purchaseOrderItem?.material?.name ?? snapshot ?? entry.outsourcePayableSource?.logisticsBatch?.material?.name ?? null;
    if (material) return material;
    if (entry.sourceType === "other") {
      // 其他应付的来源快照是 `其他应付-<支出说明>`（见 otherEntryData）：去掉前缀就是财务写的说明。
      const description = entry.sourceNoSnapshot.replace(/^其他应付[-—]/, "").trim();
      if (description) return description;
    }
    return "材料";
  }

  private prefix(kind: FinanceSlipKind) { return kind === "payment" ? "PAYMENT_SLIP" : "RECEIPT_SLIP"; }
  private today() { return beijingDateTime(new Date()).slice(0, 10); }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}
