import { Injectable, NotFoundException, Optional, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { CASH_FLOW_ITEM_DICTIONARY_KEY, SETTLEMENT_ACCOUNT_DICTIONARY_KEY } from "./cash-flow-catalog";
import { cashFlowDirection } from "./cash-flow.domain";
import { financeDayRange } from "./finance-period";

/**
 * 收支流水（「收支管理」板块的录入对象）。
 *
 * 用户 R6 选定：**手工录入资金流水 + 可配置项目字典**，与收付款单**不做自动联动**。
 * 已知代价：收付款单过账后不会自动出现在这里，财务需要手工补录
 * （`sourceType` / `sourceId` 两列先留着，将来要联动不必再迁移）。
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
  item_id: string;
  settlement_method?: string;
  settlement_account_id?: string;
  remark?: string;
};

export type CashFlowListFilter = {
  from?: string;
  to?: string;
  itemId?: string;
  currency?: string;
  direction?: string;
  /** 是否包含已冲销的流水（默认只给生效的） */
  includeReversed?: boolean;
};

const ENTRY_INCLUDE = {
  item: { select: { id: true, key: true, label: true } },
  settlementAccount: { select: { id: true, key: true, label: true } },
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
        ...(filter.itemId ? { itemId: filter.itemId } : {}),
        ...(filter.currency ? { currency: filter.currency } : {}),
        ...(filter.direction ? { direction: filter.direction } : {}),
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
      item_id: input.item_id ?? current.itemId,
      settlement_method: input.settlement_method ?? current.settlementMethod ?? undefined,
      settlement_account_id: input.settlement_account_id ?? current.settlementAccountId ?? undefined,
      remark: input.remark ?? current.remark ?? undefined,
    };
    const data = await this.prepare(merged);
    const row = await this.prisma.cashFlowEntry.update({ where: { id }, data: { ...data, ...this.audit.update(user) } });
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

  /** 启用的收支项目（报表需要「37 个项目全部列出」，因此由服务端统一提供）。 */
  async listItems() {
    return this.prisma.dictionaryItem.findMany({
      where: { deletedAt: null, isActive: true, type: { key: CASH_FLOW_ITEM_DICTIONARY_KEY, deletedAt: null } },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
      select: { id: true, key: true, label: true, sortOrder: true },
    });
  }

  /** 校验并归一化一条流水（新建与更正共用，避免两条路径校验不一致）。 */
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
    const item = await this.prisma.dictionaryItem.findFirst({
      where: { id: input.item_id, deletedAt: null, isActive: true, type: { key: CASH_FLOW_ITEM_DICTIONARY_KEY, deletedAt: null } },
      select: { id: true },
    });
    if (!item) throw this.invalid("CASH_FLOW_ITEM_NOT_FOUND", "收支项目不存在或已停用");
    let settlementAccountId: string | undefined;
    if (input.settlement_account_id) {
      const account = await this.prisma.dictionaryItem.findFirst({
        where: { id: input.settlement_account_id, deletedAt: null, isActive: true, type: { key: SETTLEMENT_ACCOUNT_DICTIONARY_KEY, deletedAt: null } },
        select: { id: true },
      });
      if (!account) throw this.invalid("SETTLEMENT_ACCOUNT_NOT_FOUND", "结算账户不存在或已停用");
      settlementAccountId = account.id;
    }
    return {
      entryDate: this.date(input.entry_date),
      counterpartyName,
      direction,
      amount,
      currency: input.currency,
      itemId: item.id,
      settlementMethod: input.settlement_method?.trim() || undefined,
      settlementAccountId,
      remark: input.remark,
    };
  }

  /**
   * 自动从付款单据创建收支流水（「收付款过账后自动写入收支流水」）。
   *
   * 幂等：同 source_type + source_id + status=posted 已存在则不重复创建。
   *
   * `itemKeys` 是**按优先级排列**的收支项目候选：业务口径会随来源变化
   * （原料采购 vs 外加工 vs 其他应付），字典又是管理员可改的，所以给一条链而不是单个 key。
   * 候选一个都不存在时**显式 422**，绝不静默跳过 —— 静默跳过会让整笔资金动账从收支流水里消失：
   * 历史缺陷就是供应商付款写死 `外加工费`，而字典里只有「外加工费 晋江大田工资」，于是**每一笔
   * 供应商付款都被悄悄丢掉**（收支流水只剩收到客户货款与工资付款）。
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
      /** 收付款单据上的银行信息：用于**保守匹配**结算账户字典（匹配不上就留空，不造关联）。 */
      settlementAccountHint?: { bankName?: string | null; accountNumber?: string | null } | null;
      sourceType: string;
      sourceId: string;
      itemKeys: readonly string[];
      remark?: string;
    },
    user: CurrentUser,
  ) {
    const existing = await this.prisma.cashFlowEntry.findFirst({
      where: { sourceType: input.sourceType, sourceId: input.sourceId, status: "posted", deletedAt: null },
      select: { id: true },
    });
    if (existing) return null;
    const candidates = await this.prisma.dictionaryItem.findMany({
      where: { key: { in: [...input.itemKeys] }, deletedAt: null, isActive: true, type: { key: CASH_FLOW_ITEM_DICTIONARY_KEY, deletedAt: null } },
      select: { id: true, key: true },
    });
    const item = input.itemKeys.map((key) => candidates.find((candidate) => candidate.key === key)).find((found) => Boolean(found));
    if (!item) throw this.invalid("CASH_FLOW_ITEM_NOT_FOUND", `自动写入收支流水需要收支项目「${input.itemKeys.join("」或「")}」，请在「收支管理 → 收支项目」里补上后重新过账`);
    const settlementAccountId = input.settlementAccountId ?? await this.matchSettlementAccount(input.settlementAccountHint);
    const row = await this.prisma.cashFlowEntry.create({
      data: {
        entryNo: this.number(),
        entryDate: input.paymentDate,
        counterpartyName: input.counterpartyName,
        direction: input.direction,
        amount: input.amount,
        currency: input.currency,
        itemId: item.id,
        settlementMethod: input.settlementMethod ?? undefined,
        settlementAccountId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        remark: `自动生成：${input.sourceType} / ${input.paymentNo}${input.remark ? ` - ${input.remark}` : ""}`,
        ...this.audit.create(user),
      },
    });
    return row;
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