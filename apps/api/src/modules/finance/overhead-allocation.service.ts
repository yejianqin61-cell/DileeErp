import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { financeDayRange } from "./finance-period";
import {
  allocationPeriodDays,
  allocationQuantity,
  allocationRate,
  allocationUnitCandidates,
  isAllocationPeriod,
  type OverheadAllocationFacts,
} from "./overhead-allocation.domain";

/**
 * 月度管理费分摊登记（财务 → 财务报表 → 核算表 的输入）。
 *
 * 需求见 `docs/design/finance-cost-accounting-and-voucher-editing-2026-09-20.md`；
 * 口径（费率 = 总额 ÷ 本月生产数量、单位必须一致、数量可人工覆盖）全在
 * `overhead-allocation.domain.ts` 里，本文件只负责取数与落库。
 *
 * ## 为什么一个期间只有一条
 *
 * 两条并存就会有「用哪条算费率」的歧义，而报表不会报错、只会算出一个没人能解释的数。
 * 所以 `period` 是唯一键，写入走**按期间 upsert**。软删除的条目仍然占着这个期间
 * （唯一索引在软删后依旧成立），重新登记时**把那条恢复回来**而不是新建 —— 否则
 * 「删了再录」会直接撞唯一索引，用户看到的是一个数据库错误。
 */

/** 一条分摊记录 + 它派生的数量与费率（页面与报表共用同一个响应形状，避免两处各算一遍）。 */
export type ResolvedOverheadAllocation = {
  period: string;
  record: {
    id: string;
    period: string;
    amount: string;
    unit: string;
    quantity_override: string | null;
    remark: string | null;
    created_at: Date;
    updated_at: Date;
    created_by: string;
    updated_by: string;
    created_by_name?: string | null;
    updated_by_name?: string | null;
  } | null;
  /** 登记单位（有记录才有；没有记录时 null）。 */
  unit: string | null;
  /** 本月计件日报的自动汇总数量（按登记单位过滤）。没有记录时为 null（没有单位就无从过滤）。 */
  auto_quantity: string | null;
  /** 实际参与分摊的数量（覆盖值优先，否则自动值）。 */
  quantity: string | null;
  /** 费率 = 总额 ÷ 数量；算不出来时为 null。 */
  rate: string | null;
};

@Injectable()
export class OverheadAllocationService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /**
   * 列举分摊记录（按期间倒序）。`period` 给定时只回那一条。
   *
   * 列表天然很短（一个月一条），所以不做分页，也不加索引 —— `period` 的唯一索引已经够用。
   */
  async list(period?: string) {
    await this.assertPeriod(period, true);
    const rows = await this.prisma.overheadAllocation.findMany({
      where: { deletedAt: null, ...(period ? { period } : {}) },
      orderBy: [{ period: "desc" }],
    });
    return Promise.all(rows.map((row) => this.withDerived(row)));
  }

  /**
   * 「这个期间现在按什么费率分摊」—— 页面上的管理费面板与核算表报表都调它。
   *
   * 期间没有记录时**不报 404**：一条都没登记就是「这个月还没录管理费」，
   * 面板要能显示自动汇总出来的数量并让财务直接录入；报表也应该照常出行（管理费列留空）。
   */
  async resolved(period: string): Promise<ResolvedOverheadAllocation> {
    await this.assertPeriod(period, false);
    const row = await this.prisma.overheadAllocation.findFirst({ where: { period, deletedAt: null } });
    if (!row) {
      return { period, record: null, unit: null, auto_quantity: null, quantity: null, rate: null };
    }
    return this.withDerived(row);
  }

  /**
   * 登记 / 修改某个月的管理费。
   *
   * 幂等（按期间 upsert）：财务连点两次、或者改了金额再保存，都只会留下一条。
   * 软删过的同期间记录会被**恢复**（见文件头注释）。
   */
  async upsert(input: { period: string; amount: string; unit: string; quantity_override?: string | null; remark?: string | null }, user: CurrentUser) {
    await this.assertPeriod(input.period, false);
    const amount = this.positive(input.amount, "INVALID_OVERHEAD_AMOUNT", "管理费总额必须是大于零的数字");
    const unit = (input.unit ?? "").trim();
    // 单位必填：没有单位这条记录就没法用（核算表不知道按打还是按支乘）。
    if (!unit) throw this.invalid("OVERHEAD_UNIT_REQUIRED", "必须填写分摊单位（打 / 支）");
    const override = input.quantity_override === undefined || input.quantity_override === null || input.quantity_override === ""
      ? null
      : this.positive(input.quantity_override, "INVALID_OVERHEAD_QUANTITY", "分摊数量必须是大于零的数字");
    const remark = input.remark?.trim() || null;

    const existing = await this.prisma.overheadAllocation.findFirst({ where: { period: input.period } });
    const row = await this.prisma.$transaction(async (tx) => {
      if (!existing) {
        return tx.overheadAllocation.create({
          data: { period: input.period, amount, unit, quantityOverride: override, remark, ...this.audit.create(user) },
        });
      }
      // 期间是唯一键，所以「软删过的同期间记录」只能改回来，不能新建。
      return tx.overheadAllocation.update({
        where: { id: existing.id },
        data: { amount, unit, quantityOverride: override, remark, deletedAt: null, deletedBy: null, ...this.audit.update(user) },
      });
    });
    await this.audit.record("overhead_allocation.upsert", "overhead_allocation", user.id, row.id, {
      period: row.period, amount: row.amount.toString(), unit: row.unit,
      quantity_override: override?.toString() ?? null,
      // 恢复软删记录也要能被看见，否则「删了又出现」看起来像幽灵数据。
      restored: Boolean(existing?.deletedAt),
      before: existing ? { amount: existing.amount.toString(), unit: existing.unit } : null,
    });
    return this.withDerived(row);
  }

  /** 删除（逻辑删除）。删掉之后这个期间就没有费率了，核算表的管理费列会全部留空。 */
  async remove(id: string, user: CurrentUser) {
    const row = await this.prisma.overheadAllocation.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw this.notFound("OVERHEAD_ALLOCATION_NOT_FOUND", "管理费登记不存在");
    const deleted = await this.prisma.overheadAllocation.update({ where: { id }, data: this.audit.softDelete(user) });
    await this.audit.record("overhead_allocation.delete", "overhead_allocation", user.id, id, {
      period: deleted.period, amount: deleted.amount.toString(), unit: deleted.unit,
    });
    return deleted;
  }

  /**
   * 本月计件日报的自动汇总数量。
   *
   * 口径与「计件人工」同源（`employee_daily_reports`）：按**工序的单位**过滤，
   * 只统计与登记单位归一后相同的那些行。单位过滤下推到 SQL（`allocationUnitCandidates`
   * 把归一标识还原成全部原始写法），否则要把整月日报读回内存再逐行比。
   *
   * 为什么要过滤而不是全加：跨单位相加没有意义（全站纪律），而且「打」与「支」在这一行上
   * 差 12 倍 —— 加错了费率会错 12 倍，报表上看不出来。
   */
  async autoQuantity(period: string, unit: string): Promise<Prisma.Decimal> {
    const candidates = allocationUnitCandidates(unit);
    if (!candidates.length) return new Prisma.Decimal(0);
    const days = allocationPeriodDays(period);
    const range = financeDayRange(days.from, days.to);
    const result = await this.prisma.employeeDailyReport.aggregate({
      where: {
        deletedAt: null,
        ...(range ? { reportDate: range } : {}),
        productionOrderOperation: { unit: { name: { in: candidates, mode: "insensitive" } } },
      },
      _sum: { quantity: true },
    });
    return new Prisma.Decimal(result._sum.quantity ?? 0);
  }

  /** 记录 → 响应：补上自动数量、实际数量与费率（三处口径全部来自纯函数）。 */
  private async withDerived(row: {
    id: string; period: string; amount: Prisma.Decimal; unit: string; quantityOverride: Prisma.Decimal | null;
    remark: string | null; createdAt: Date; updatedAt: Date; createdBy: string; updatedBy: string;
  }): Promise<ResolvedOverheadAllocation> {
    const auto = await this.autoQuantity(row.period, row.unit);
    const facts: OverheadAllocationFacts = { amount: row.amount, unit: row.unit, quantityOverride: row.quantityOverride, autoQuantity: auto };
    const quantity = allocationQuantity(facts);
    const rate = allocationRate(facts);
    return {
      period: row.period,
      unit: row.unit,
      auto_quantity: auto.toString(),
      quantity: quantity?.toString() ?? null,
      rate: rate?.toString() ?? null,
      record: {
        id: row.id,
        period: row.period,
        amount: row.amount.toString(),
        unit: row.unit,
        quantity_override: row.quantityOverride?.toString() ?? null,
        remark: row.remark,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        created_by: row.createdBy,
        updated_by: row.updatedBy,
      },
    };
  }

  private async assertPeriod(period: string | undefined, optional: boolean): Promise<void> {
    if (!period) {
      if (optional) return;
      throw this.invalid("OVERHEAD_PERIOD_REQUIRED", "必须指定期间（YYYY-MM）");
    }
    if (!isAllocationPeriod(period)) throw this.invalid("INVALID_OVERHEAD_PERIOD", `期间「${period}」不是有效的 YYYY-MM`);
  }

  private positive(value: string, code: string, message: string): Prisma.Decimal {
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(value);
    } catch {
      throw this.invalid(code, message);
    }
    if (amount.lte(0)) throw this.invalid(code, message);
    return amount;
  }

  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
}
