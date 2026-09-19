import { Injectable, NotFoundException, Optional, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { SETTLEMENT_ACCOUNT_DICTIONARY_KEY } from "./cash-flow-catalog";
import { requireActiveBank } from "./bank-selection";
import { cashFlowDirection } from "./cash-flow.domain";
import { financeDayRange } from "./finance-period";
import { isPaymentNature } from "./payment-nature";

/**
 * 收支流水（「收支管理」板块的录入对象）。
 *
 * 用户 R6 选定：**手工录入资金流水 + 可配置项目字典**，与收付款单**不做自动联动**。
 * 已知代价：收付款单过账后不会自动出现在这里，财务需要手工补录
 * （`sourceType` / `sourceId` 两列先留着，将来要联动不必再迁移）。
 *
 * 2026-09-17 口径变更（用户交付 `example/财务/科目表(2).xls`）：流水上的分类从
 * 「收支项目字典项」换成**会计科目**（`accounting_subjects`）—— 分类 = 科目类别，
 * 项目 = 科目名称。列名也从 `item_id` 改成 `subject_id`，因为合并之后已经没有
 * 「收支项目」这个独立概念了。
 *
 * 金额恒为正数，收/支由 `direction` 决定：老表的「收入 / 支出」两列是**报表版式**，
 * 不是存储形态；存成有符号金额则「支出被填成负数」这类错误在库层无法拦住。
 */

export type CashFlowEntryInput = {
  entry_date: string;
  counterparty_name: string;
  direction: string;
  amount: string;
  currency: string;
  /** 会计科目（分类 = 科目类别，项目 = 科目名称）。 */
  subject_id: string;
  settlement_method?: string;
  settlement_account_id?: string;
  /** 资金实际所在的银行账户（银行账户池 banks）；填了才算进该账户的余额。 */
  bank_id?: string;
  /**
   * 款项性质（定金 / 货款 / 尾款 / 其他）。
   *
   * 用户 2026-09-17 要求把老表「外汇一览表」搬进系统，那张表按「定金 / 货款」分列，
   * 于是钱落账的这条记录必须自己说清是什么性质。空 = 没标注（报表算进「其他到账」）。
   */
  payment_nature?: string;
  /**
   * 订单号：把收入流水挂到具体订单。
   *
   * 定金在出货之前就收到了，而应收来源是成品出库过账时才生成的 —— 那一刻没有来源可挂，
   * 只能靠财务手填的订单号。填了必须真实存在（否则外汇一览表会把这笔钱归进「无法归属」，
   * 与其让报表事后吞掉一笔钱，不如建单时就报错）。
   */
  order_no?: string;
  remark?: string;
};

export type CashFlowListFilter = {
  from?: string;
  to?: string;
  subjectId?: string;
  /** 分类（科目类别）筛选：报表与列表共用同一口径，避免两处各筛一套。 */
  category?: string;
  currency?: string;
  direction?: string;
  bankId?: string;
  /** 是否包含已冲销的流水（默认只给生效的） */
  includeReversed?: boolean;
};

const ENTRY_INCLUDE = {
  subject: { select: { id: true, category: true, name: true, balanceDirection: true } },
  settlementAccount: { select: { id: true, key: true, label: true } },
  bank: { select: { id: true, bankCode: true, bankName: true, accountNumber: true, currency: true } },
} as const;

@Injectable()
export class CashFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly currencies?: CurrencyService,
  ) {}

  /** 流水列表（默认只给生效的；已冲销的要显式要）。 */
  async list(filter: CashFlowListFilter = {}) {
    const period = financeDayRange(filter.from, filter.to);
    return this.prisma.cashFlowEntry.findMany({
      where: {
        deletedAt: null,
        ...(filter.includeReversed ? {} : { status: "posted" }),
        ...(filter.subjectId ? { subjectId: filter.subjectId } : {}),
        ...(filter.category ? { subject: { category: filter.category } } : {}),
        ...(filter.currency ? { currency: filter.currency } : {}),
        ...(filter.direction ? { direction: filter.direction } : {}),
        ...(filter.bankId ? { bankId: filter.bankId } : {}),
        ...(period ? { entryDate: period } : {}),
      },
      include: ENTRY_INCLUDE,
      orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
    });
  }

  async get(id: string) {
    const row = await this.prisma.cashFlowEntry.findFirst({ where: { id, deletedAt: null }, include: ENTRY_INCLUDE });
    if (!row) throw this.notFound("CASH_FLOW_ENTRY_NOT_FOUND", "收支流水不存在");
    return row;
  }

  async create(input: CashFlowEntryInput, user: CurrentUser) {
    const data = await this.prepare(input);
    const row = await this.prisma.cashFlowEntry.create({
      data: { entryNo: this.number(), ...data, ...this.audit.create(user) },
    });
    await this.audit.record("cash_flow_entry.create", "cash_flow_entry", user.id, row.id, {
      entry_no: row.entryNo,
      direction: row.direction,
      amount: row.amount.toString(),
      currency: row.currency,
    });
    return row;
  }

  /** 更正：流水没有下游事实，允许直接改；但只有生效中的流水能改，且要留审计。 */
  async update(id: string, input: Partial<CashFlowEntryInput>, user: CurrentUser) {
    const current = await this.get(id);
    if (current.status !== "posted") throw this.invalid("CASH_FLOW_ENTRY_NOT_EDITABLE", "已冲销的收支流水不可编辑");
    const merged: CashFlowEntryInput = {
      entry_date: input.entry_date ?? this.dateText(current.entryDate),
      counterparty_name: input.counterparty_name ?? current.counterpartyName,
      direction: input.direction ?? current.direction,
      amount: input.amount ?? current.amount.toString(),
      currency: input.currency ?? current.currency,
      subject_id: input.subject_id ?? current.subjectId,
      settlement_method: input.settlement_method ?? current.settlementMethod ?? undefined,
      settlement_account_id: input.settlement_account_id === undefined ? (current.settlementAccountId ?? undefined) : (input.settlement_account_id || undefined),
      bank_id: input.bank_id === undefined ? (current.bankId ?? undefined) : (input.bank_id || undefined),
      payment_nature: input.payment_nature === undefined ? (current.paymentNature ?? undefined) : (input.payment_nature || undefined),
      order_no: input.order_no === undefined ? (current.orderNo ?? undefined) : (input.order_no || undefined),
      remark: input.remark ?? current.remark ?? undefined,
    };
    const data = await this.prepare(merged);
    // 清空语义：`bank_id` / `settlement_account_id` / `payment_nature` / `order_no` 传 null 或空串
    // 表示**去掉**（填错了要能改掉），传 undefined 表示不改 —— 与收付款草稿的编辑同一约定。
    // `prepare()` 返回的是「选中的东西」，表达不了「清空」，所以这里显式补上。
    const patch = { ...data } as Record<string, unknown>;
    if (input.bank_id !== undefined && !input.bank_id) patch.bankId = null;
    if (input.settlement_account_id !== undefined && !input.settlement_account_id) patch.settlementAccountId = null;
    if (input.payment_nature !== undefined && !input.payment_nature) patch.paymentNature = null;
    if (input.order_no !== undefined && !input.order_no) patch.orderNo = null;
    const row = await this.prisma.cashFlowEntry.update({ where: { id }, data: { ...(patch as typeof data), ...this.audit.update(user) } });
    await this.audit.record("cash_flow_entry.update", "cash_flow_entry", user.id, id, {
      entry_no: row.entryNo,
      amount: row.amount.toString(),
      direction: row.direction,
    });
    return row;
  }

  /**
   * 冲销：置为 `reversed` 并保留整行 —— 已报过表的数字不能凭空消失，
   * 报表默认不计入已冲销的流水，需要时可以用 `include_reversed=true` 查出来。
   */
  async reverse(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw this.invalid("REVERSAL_REASON_REQUIRED", "冲销必须填写原因");
    const current = await this.get(id);
    if (current.status !== "posted") throw this.invalid("CASH_FLOW_ENTRY_NOT_REVERSIBLE", "只有生效中的收支流水可以冲销");
    const row = await this.prisma.cashFlowEntry.update({
      where: { id },
      data: { status: "reversed", remark: `${current.remark ?? ""}\n冲销：${reason.trim()}`, ...this.audit.update(user) },
    });
    await this.audit.record("cash_flow_entry.reverse", "cash_flow_entry", user.id, id, {
      entry_no: row.entryNo,
      reason: reason.trim(),
      amount: row.amount.toString(),
    });
    return row;
  }

  /**
   * 校验一个**会计科目**（存在 + 启用）。
   *
   * 建单时人工选了科目就要**当场**校验：等到过账才报「科目已停用」，财务已经填完一整张单，
   * 而错误信息在另一个页面的另一个时刻才出现 —— 那不是校验，那是事后通知。
   * 传空（undefined / null / 空串）表示「不指定」，由来源自动归类，返回 null。
   *
   * 这里是全站「科目 id 是否可用」的**唯一实现**：收付款、确认应收/应付、工资付款过账
   * 都通过它校验，不各自写一份查询（写两份的结果一定是一处宽松一处严格）。
   */
  async requireSubject(subjectId: string | null | undefined, message = "会计科目不存在或已停用") {
    const id = subjectId?.trim();
    if (!id) return null;
    const subject = await this.prisma.accountingSubject.findFirst({
      where: { id, deletedAt: null, isActive: true },
      select: { id: true, category: true, name: true },
    });
    if (!subject) throw this.invalid("ACCOUNTING_SUBJECT_NOT_FOUND", message);
    return subject;
  }

  /**
   * 校验一个**款项性质**（定金 / 货款 / 尾款 / 其他）。
   *
   * 与 `requireSubject` 同一个理由单独放在这里：确认应收有「逐条 / 勾选批量 / 按对账单一键」
   * 三条入口，流水本身又有新建与更正两条 —— 五处各写一份白名单，迟早有一处松一处严。
   * 传空（undefined / null / 空串）表示「不标注」，返回 null；非法值显式 422，
   * **绝不静默丢弃**：财务选了「定金」却被当成没填，报表上那笔钱就跑到「其他到账」里去了。
   */
  requirePaymentNature(value: string | null | undefined) {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (!isPaymentNature(trimmed)) throw this.invalid("PAYMENT_NATURE_INVALID", "款项性质只能是定金、货款、尾款或其他");
    return trimmed;
  }

  /**
   * 校验并归一化一条流水（新建与更正共用，避免两条路径校验不一致）。
   */
  private async prepare(input: CashFlowEntryInput) {
    await this.currencies?.assertSupported(input.currency, "收支币种");
    const direction = (() => {
      try {
        return cashFlowDirection(input.direction);
      } catch {
        throw this.invalid("INVALID_CASH_FLOW_DIRECTION", "收支方向只能是收入或支出");
      }
    })();
    const counterpartyName = input.counterparty_name?.trim();
    if (!counterpartyName) throw this.invalid("COUNTERPARTY_REQUIRED", "对方名称必填");
    const amount = (() => {
      try {
        const value = new Prisma.Decimal(input.amount);
        if (value.lte(0)) throw new Error();
        return value;
      } catch {
        throw this.invalid("INVALID_CASH_FLOW_AMOUNT", "收支金额必须是大于零的十进制数");
      }
    })();
    // 金额恒为正：方向由 direction 决定，负数金额在库层会被 CHECK 约束拦住。
    const subject = await this.requireSubject(input.subject_id, "会计科目不存在或已停用，请在「收支管理 → 会计科目」里确认");
    if (!subject) throw this.invalid("ACCOUNTING_SUBJECT_REQUIRED", "每条收支流水都必须归到一个会计科目");
    let settlementAccountId: string | undefined;
    if (input.settlement_account_id) {
      const account = await this.prisma.dictionaryItem.findFirst({
        where: { id: input.settlement_account_id, deletedAt: null, isActive: true, type: { key: SETTLEMENT_ACCOUNT_DICTIONARY_KEY, deletedAt: null } },
        select: { id: true },
      });
      if (!account) throw this.invalid("SETTLEMENT_ACCOUNT_NOT_FOUND", "结算账户不存在或已停用");
      settlementAccountId = account.id;
    }
    // 银行账户来自银行池（财务 → 银行账户）：停用/已删除的账户不能被选中，
    // 与收付款、对账选银行同一套 requireActiveBank 口径。填了才算进该账户余额。
    const bank = await requireActiveBank(this.prisma, input.bank_id, "银行账户不存在或已停用");
    // 款项性质：白名单校验。**不做「收入才允许」的方向限制** —— 财务先在支出上标注、
    // 事后发现方向填反了改回收入时，性质不该被连带清掉；报表只按收入方向取用这一列。
    const paymentNature = this.requirePaymentNature(input.payment_nature);
    // 订单号：填了必须真实存在。外汇一览表按订单号把收款归到订单，写错一个字符这笔钱就会
    // 掉进报表的「无法归属」清单 —— 与其让报表事后吞掉一笔钱，不如建单时就报错。
    const orderNo = input.order_no?.trim() || undefined;
    if (orderNo) {
      const order = await this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null }, select: { id: true } });
      if (!order) throw this.invalid("SALES_ORDER_NOT_FOUND", `订单号「${orderNo}」不存在，请核对后再填`);
    }
    return {
      entryDate: this.date(input.entry_date),
      counterpartyName,
      direction,
      amount,
      currency: input.currency,
      subjectId: subject.id,
      settlementMethod: input.settlement_method?.trim() || undefined,
      settlementAccountId,
      bankId: bank?.id,
      paymentNature,
      orderNo,
      remark: input.remark,
    };
  }

  /**
   * 自动从付款单据创建收支流水（「收付款过账后自动写入收支流水」）。
   *
   * 幂等：同 source_type + source_id + status=posted 已存在则不重复创建。
   *
   * `subjectNames` 是**按优先级排列**的会计科目名称候选：业务口径会随来源变化
   * （原料采购 vs 外加工 vs 其他应付），科目又是管理员可改的，所以给一条链而不是单个名字。
   * 候选一个都不存在时**显式 422**，绝不静默跳过 —— 静默跳过会让整笔资金动账从收支流水里消失：
   * 历史缺陷就是供应商付款写死了一个字典里不存在的 key，于是**每一笔供应商付款都被悄悄丢掉**
   * （收支流水只剩收到客户货款与工资付款）。
   */
  async autoCreateFromPayment(
    input: {
      paymentNo: string;
      paymentDate: Date;
      amount: Prisma.Decimal;
      currency: string;
      counterpartyName: string;
      direction: "income" | "expense";
      settlementMethod?: string | null;
      settlementAccountId?: string | null;
      /**
       * 单据上真正选定的银行账户（`banks.id`）。
       *
       * 与 `settlementAccountHint` 的区别：那个是「按账号去猜老表结算账户字典」的兜底（可能匹配不上，
       * 匹配不上就留空）；这个才是钱到底在哪张卡上，直接落 `cash_flow_entries.bank_id`，
       * 是银行余额的唯一依据。单据上没选银行时为 null —— 流水照样写（收支事实不能丢），
       * 但它不属于任何账户，因此不进任何账户余额。
       */
      bankId?: string | null;
      /** 收付款单据上的银行信息：用于**保守匹配**结算账户字典（匹配不上就留空，不造关联）。 */
      settlementAccountHint?: { bankName?: string | null; accountNumber?: string | null } | null;
      sourceType: string;
      sourceId: string;
      subjectNames: readonly string[];
      /**
       * 过账时人工选定的会计科目 id（可选）。
       *
       * 给了就以它为准，且**校验不过直接报错**——人工选择绝不能被静默忽略或悄悄替换成候选链里的其它科目，
       * 否则财务选了「差旅费」却记成了「管理费用」，账面上看不出来。
       * 没给则退回 `subjectNames` 候选链（按来源自动归类）。
       */
      subjectId?: string | null;
      /** 款项性质（定金/货款/尾款/其他）。收付款单据上通常没有这个信息，留给调用方按需传。 */
      paymentNature?: string | null;
      /** 订单号：让这笔流水能按订单归集（外汇一览表用）。 */
      orderNo?: string | null;
      remark?: string;
    },
    user: CurrentUser,
  ) {
    const existing = await this.prisma.cashFlowEntry.findFirst({
      where: { sourceType: input.sourceType, sourceId: input.sourceId, status: "posted", deletedAt: null },
      select: { id: true },
    });
    if (existing) return null;
    const paymentNature = this.requirePaymentNature(input.paymentNature);
    const subject = input.subjectId
      ? await this.prisma.accountingSubject.findFirst({
          where: { id: input.subjectId, deletedAt: null, isActive: true },
          select: { id: true, name: true },
        })
      : await this.firstCandidateSubject(input.subjectNames);
    if (!subject) {
      throw this.invalid(
        "ACCOUNTING_SUBJECT_NOT_FOUND",
        input.subjectId
          ? "选择的会计科目不存在或已停用，请在「收支管理 → 会计科目」里确认后重新过账"
          : `自动写入收支流水需要会计科目「${input.subjectNames.join("」或「")}」，请在「收支管理 → 会计科目」里补上后重新过账`,
      );
    }
    const settlementAccountId = input.settlementAccountId ?? await this.matchSettlementAccount(input.settlementAccountHint);
    const row = await this.prisma.cashFlowEntry.create({
      data: {
        entryNo: this.number(),
        entryDate: input.paymentDate,
        counterpartyName: input.counterpartyName,
        direction: input.direction,
        amount: input.amount,
        currency: input.currency,
        subjectId: subject.id,
        settlementMethod: input.settlementMethod ?? undefined,
        settlementAccountId,
        bankId: input.bankId ?? undefined,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        paymentNature: paymentNature ?? undefined,
        orderNo: input.orderNo ?? undefined,
        remark: `自动生成：${input.sourceType} / ${input.paymentNo}${input.remark ? ` - ${input.remark}` : ""}`,
        ...this.audit.create(user),
      },
    });
    return row;
  }

  /**
   * 把「本次确认的金额」记进收支流水（确认应收 / 确认应付专用）：**同来源只有一条流水，金额是累计确认额**。
   *
   * 为什么不能用 `autoCreateFromPayment` 的「已存在就跳过」：对账单的范围是**活范围**
   * （同一客户/供应商 + 币种 + 期间），确认一次之后同期间又新进来的草稿可以再确认一次。
   * 跳过就等于「银行账永远停在第一次确认的数字上」，钱对不上还查不出原因。
   *
   * 为什么是**累加**而不是覆盖：同一条应收既可能被「一键确认应收」（对账单维度）记进对账单那条流水，
   * 也可能被行内「确认应收」（逐条维度）单独记一条。若覆盖，先按对账确认 100、再逐条确认新来的 50，
   * 回头再点一次对账确认时对账那条流水会被改写成 50，总额凭空少 100。累加则只会单调增长，
   * 永远不会因为「又点了一次」而丢掉已经记过的钱。
   *
   * 金额为 0（这次没有可确认的条目）时不动流水：返回 null，不建一条 0 元流水出来。
   *
   * 更新时**保留首次确认的日期**（一条累计流水只有一个日期，取最早的才不会被后来的确认把账推到别的期间），
   * 但银行账户与会计科目取最新一次（财务最近一次确认时选的那个才是「钱实际走的地方」）。
   *
   * 款项性质与订单号：**只在调用方显式传了非 `undefined` 的值时才覆盖**。
   * 这两列是人填的口径，不是每次确认都会被重新回答的问题 —— 不传就清掉，等于财务多点一次确认
   * 就把上次标的「定金」抹掉了。要清空请显式传 `null`。
   */
  async recordConfirmation(
    input: {
      sourceType: string;
      sourceId: string;
      documentNo: string;
      entryDate: Date;
      amount: Prisma.Decimal;
      currency: string;
      counterpartyName: string;
      direction: "income" | "expense";
      subjectNames: readonly string[];
      /** 人工选定的会计科目（对账单上填过就传）；给了但不存在会显式 422，不静默换一个。 */
      subjectId?: string | null;
      bankId?: string | null;
      /**
       * 款项性质（定金 / 货款 / 尾款 / 其他）。
       *
       * 确认应收时财务在弹窗里选（已确认的应收、对账单上也存了这个值）；
       * 用户 2026-09-17 的原始需求就是「老表要按定金/货款分列」，这一列是那张表的数据来源。
       */
      paymentNature?: string | null;
      /**
       * 订单号：确认应收/应付时由调用方从来源单据上带过来（应收来源、对账单都知道自己的订单号），
       * 这样外汇一览表不必再去反查一遍来源表就能按订单归集。
       */
      orderNo?: string | null;
      remark?: string;
    },
    user: CurrentUser,
  ) {
    if (input.amount.lte(0)) return null;
    // 款项性质在这一处统一校验：确认应收有三条入口、确认应付两条，它们最终都走这里，
    // 把白名单校验放在这个汇聚点上就不存在「某条入口忘了校验」的可能。
    // `undefined` 保持原值（见方法注释），所以要区分开再交给校验器。
    const paymentNature = input.paymentNature === undefined ? undefined : this.requirePaymentNature(input.paymentNature);
    const subject = input.subjectId
      ? await this.prisma.accountingSubject.findFirst({
          where: { id: input.subjectId, deletedAt: null, isActive: true },
          select: { id: true, name: true },
        })
      : await this.firstCandidateSubject(input.subjectNames);
    if (!subject) {
      throw this.invalid(
        "ACCOUNTING_SUBJECT_NOT_FOUND",
        input.subjectId
          ? "选择的会计科目不存在或已停用，请在「收支管理 → 会计科目」里确认后重新确认"
          : `自动写入收支流水需要会计科目「${input.subjectNames.join("」或「")}」，请在「收支管理 → 会计科目」里补上后重新确认`,
      );
    }
    const remark = `自动生成：${input.sourceType} / ${input.documentNo}${input.remark ? ` - ${input.remark}` : ""}`;
    const existing = await this.prisma.cashFlowEntry.findFirst({
      where: { sourceType: input.sourceType, sourceId: input.sourceId, status: "posted", deletedAt: null },
      select: { id: true, amount: true },
    });
    if (existing) {
      const total = existing.amount.plus(input.amount);
      await this.prisma.cashFlowEntry.update({
        where: { id: existing.id },
        data: {
          amount: total,
          counterpartyName: input.counterpartyName,
          currency: input.currency,
          subjectId: subject.id,
          bankId: input.bankId ?? null,
          // `undefined` 保持原值（见方法注释），只有显式给了值/`null` 才动这两列。
          ...(paymentNature === undefined ? {} : { paymentNature }),
          ...(input.orderNo === undefined ? {} : { orderNo: input.orderNo }),
          remark,
          ...this.audit.update(user),
        },
      });
      return { id: existing.id, created: false, amount: total, added: input.amount };
    }
    const row = await this.prisma.cashFlowEntry.create({
      data: {
        entryNo: this.number(),
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        entryDate: input.entryDate,
        counterpartyName: input.counterpartyName,
        direction: input.direction,
        amount: input.amount,
        currency: input.currency,
        subjectId: subject.id,
        bankId: input.bankId ?? null,
        paymentNature: paymentNature ?? undefined,
        orderNo: input.orderNo ?? undefined,
        remark,
        ...this.audit.create(user),
      },
    });
    return { id: row.id, created: true, amount: input.amount, added: input.amount };
  }

  /**
   * 按候选链取第一个**真实存在且启用**的会计科目。
   *
   * 一次查库再按顺序挑，避免为每个候选各查一次；顺序即优先级，不能被数据库返回顺序打乱。
   * 种入的科目表里名称是唯一的，万一将来出现重名（不同分类下的同名科目），
   * `sortOrder` 靠前的那条胜出 —— 结果仍然确定，不会随查询计划漂移。
   */
  private async firstCandidateSubject(subjectNames: readonly string[]) {
    if (subjectNames.length === 0) return null;
    const candidates = await this.prisma.accountingSubject.findMany({
      where: { name: { in: [...subjectNames] }, deletedAt: null, isActive: true },
      orderBy: [{ sortOrder: "asc" }],
      select: { id: true, name: true },
    });
    return subjectNames.map((name) => candidates.find((candidate) => candidate.name === name)).find((found) => Boolean(found)) ?? null;
  }

  /**
   * 把收付款单据上的银行匹配到「结算账户」字典项。
   *
   * 为什么需要匹配而不是直接存银行 id：`cash_flow_entries.settlement_account_id` 是
   * **结算账户字典**（老表「结算方式」里的 `农业银行5706`）的外键，而银行来自 `banks` 表，
   * 两者没有外键关系。硬塞银行 id 会造假关联，所以按「账号数字完全一致 + 银行名互相包含」保守匹配：
   * 匹配上就带上字典项（收支明细表里能看到具体账户），匹配不上就留空。
   */
  private async matchSettlementAccount(hint: { bankName?: string | null; accountNumber?: string | null } | null | undefined) {
    const accountNumber = hint?.accountNumber?.trim();
    if (!accountNumber) return undefined;
    const digits = (value: string) => (value.match(/\d+/g) ?? []).join("");
    const cjk = (value: string) => (value.match(/^[\u4e00-\u9fa5]+/) ?? [""])[0];
    const wanted = digits(accountNumber);
    if (!wanted) return undefined;
    const bankName = hint?.bankName?.trim() ?? "";
    const accounts = await this.prisma.dictionaryItem.findMany({
      where: { deletedAt: null, isActive: true, type: { key: SETTLEMENT_ACCOUNT_DICTIONARY_KEY, deletedAt: null } },
      select: { id: true, label: true },
    });
    const match = accounts.find((account) => {
      if (digits(account.label) !== wanted) return false;
      if (!bankName) return true;
      const labelName = cjk(account.label);
      return labelName.length > 0 && (labelName.includes(bankName) || bankName.includes(labelName));
    });
    return match?.id;
  }

  /**
   * 冲销收付款时回冲它的收支流水。
   *
   * 为什么必须有：付款冲销后钱并没有真的出去，流水里却一直留着那笔支出/收入，
   * 收支汇总表就会比银行账多出一笔。原实现只在过账时写流水、从不处理冲销。
   * 找不到对应流水（例如当年因字典缺项被跳过）时返回 null，不阻断冲销本身。
   */
  async autoReverseFromPayment(sourceType: string, sourceId: string, reason: string, user: CurrentUser) {
    const entry = await this.prisma.cashFlowEntry.findFirst({ where: { sourceType, sourceId, status: "posted", deletedAt: null }, select: { id: true } });
    if (!entry) return null;
    return this.reverse(entry.id, reason, user);
  }

  private dateText(value: Date): string {
    return new Date(value).toISOString().slice(0, 10);
  }

  private date(value: string) {
    const result = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf())) {
      throw this.invalid("INVALID_CASH_FLOW_DATE", "收支日期无效");
    }
    return result;
  }

  private number() {
    return `CF-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
  }

  private notFound(code: string, message: string) {
    return new NotFoundException({ code, message, details: [] });
  }

  private invalid(code: string, message: string) {
    return new UnprocessableEntityException({ code, message, details: [] });
  }
}