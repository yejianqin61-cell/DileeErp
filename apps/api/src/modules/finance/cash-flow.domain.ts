/**
 * 收支流水的纯口径（不碰数据库）。
 *
 * 需求来源：`example/财务/收支明细表.xls`（列：日期 / 对方名称 / 币种 / 收入 / 支出 / 结算方式）。
 */
import { Prisma } from "@prisma/client";

export const CASH_FLOW_DIRECTIONS = ["income", "expense"] as const;
export type CashFlowDirection = (typeof CASH_FLOW_DIRECTIONS)[number];

/** 方向校验：只认 income / expense（库层也有同名 CHECK 约束兜底）。 */
export function cashFlowDirection(value: string | null | undefined): CashFlowDirection {
  if (value !== "income" && value !== "expense") throw new Error("invalid cash flow direction");
  return value;
}

/**
 * 「结算方式」列的文字。
 *
 * 老表把**方式 + 银行账户**写在同一格，形如 `转账--农业银行5706`（`收支明细表.xls` 第 2 行），
 * 因此这里同样合成一格；两部分都空时留空（不写空字符串）。
 */
export function settlementText(
  method: string | null | undefined,
  accountLabel: string | null | undefined,
): string | null {
  const parts = [method?.trim(), accountLabel?.trim()].filter((part): part is string => Boolean(part && part.length));
  return parts.length ? parts.join("--") : null;
}

/** 流水上挂的科目摘要（列表/报表只要这几列）。 */
export type CashFlowSubjectLink = { id: string; category: string; name: string };

/**
 * 一条收支流水**对外显示的会计科目**：业务科目。
 *
 * 2026-11-05 用户报障：「每一笔确认应付中选择的会计科目，到了收支流水中都是错的，但凭证里又是对的」——
 * 线上 `CF-20261105-9CFB412B`（确认应付 `APO-20261027-CE78BFBC` 的付款）就是：
 * 主科目 `subject_id` = 负债类/应付账款（销账那条现金分录的**对方科目**，生成凭证要用它），
 * 收支类目 `category_subject_id` = 损益类/管理费用（财务在确认应付时选的那个）。
 *
 * 财务说「会计科目」时指的永远是后者（这笔钱算什么），它才该出现在流水列表/收支报表的
 * 「分类 / 项目」里；前者只回答"现金分录的另一头是谁"。
 *
 * 手工录入的流水没有收支类目（录的时候只选一个科目，那个科目**就是**它的业务科目），
 * 所以这里退回主科目 —— 一条规则同时覆盖自动流水与手工流水，不按来源分叉。
 */
export function cashFlowBusinessSubject<T extends CashFlowSubjectLink>(row: {
  subject?: T | null;
  categorySubject?: T | null;
}): T | null {
  return row.categorySubject ?? row.subject ?? null;
}

/**
 * 「会计科目 / 分类」筛选的统一口径：**筛的是界面上显示的那个科目**（业务科目，见上）。
 *
 * 为什么不能只按 `subject_id` 筛：已挂账的付款主科目一律是「应付账款」，按「损益类 / 管理费用」筛
 * 会一条都筛不出来 —— 列表上明明写着管理费用，筛它却没有，那不是筛选而是另一套口径。
 *
 * 两个条件各自成组再用 AND 合并：`subject_id` 与 `category` 同时给时是「交」不是「并」。
 */
export function cashFlowSubjectWhere(filter: { subjectId?: string; category?: string }): Prisma.CashFlowEntryWhereInput {
  const groups: Prisma.CashFlowEntryWhereInput[] = [];
  if (filter.subjectId) {
    groups.push({
      OR: [
        { categorySubjectId: filter.subjectId },
        // 手工录入/历史流水没有收支类目：它们的主科目就是业务科目。
        { categorySubjectId: null, subjectId: filter.subjectId },
      ],
    });
  }
  if (filter.category) {
    groups.push({
      OR: [
        { categorySubject: { category: filter.category } },
        { categorySubjectId: null, subject: { category: filter.category } },
      ],
    });
  }
  if (groups.length === 0) return {};
  return groups.length === 1 ? groups[0] : { AND: groups };
}

/**
 * 「收支类目」的取值（2026-10-13）：本次核销的**单据**里，金额最大的那一条所填的科目。
 *
 * 为什么是"金额最大的那一条"而不是"第一条"或"都不填"：一条流水 = 一笔付款（一个金额），
 * 而一笔付款可能同时核销备用金（库存现金（备用金））与房租（房租费）。台账/付款单能逐条显示，
 * 流水只有一格，所以取**占钱最多**的那条 —— 与主科目"按金额最大的来源类型"同一条思路，
 * 结果确定且事后解释得清（设计文档 `cash-flow-category-and-payable-batch-delete-2026-10-13.md` §1.2）。
 *
 * 全部单据都没填科目时返回 `null`：由调用方交给候选链兜底（"猜的只当兼底"），不在这里猜。
 */
export function dominantDocumentSubject(
  rows: ReadonlyArray<{ amount: Prisma.Decimal | string | number; subjectId?: string | null }>,
): string | null {
  let best: { amount: Prisma.Decimal; subjectId: string } | null = null;
  for (const row of rows) {
    if (!row.subjectId) continue;
    const amount = new Prisma.Decimal(row.amount ?? 0);
    if (!best || amount.gt(best.amount)) best = { amount, subjectId: row.subjectId };
  }
  return best?.subjectId ?? null;
}
