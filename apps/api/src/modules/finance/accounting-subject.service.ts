import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { ACCOUNTING_SUBJECT_CATEGORIES, compareAccountingSubjects } from "./accounting-subject-catalog";

/**
 * 会计科目（全站财务口径的唯一来源，`/finance/accounting-subjects`）。
 *
 * 用户 2026-09-17 口径：「收支项目维护和会计科目要合并成会计科目！合并成一个」。
 * 因此**这里就是唯一的分类维护入口** —— 收支项目字典已经并入，不再是独立概念。
 * 收支流水、客户收款、供应商付款、应收/应付对账单上的 `subject_id` 全部指向本表。
 *
 * 三条设计约束：
 *   1. 科目只**停用**不删除（宪法《Configurable Business Categories》）：已被流水引用的科目
 *      必须留成历史快照，否则历史凭证/报表会指到一张不存在的科目上；
 *   2. 停用的科目**仍能显示**（列表用 include_inactive=true 拿全量），否则历史流水上的科目名会消失；
 *   3. `category` 允许出现 5 类之外的取值：迁移会把「对照表没覆盖到的自定义旧项目」并入
 *      「未分类」，财务在界面上重新归类 —— 硬挡掉它等于把已经记过账的分类丢掉。
 */
@Injectable()
export class AccountingSubjectService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /**
   * 科目列表。
   *
   * 默认只给启用的（下拉框用）；`includeInactive` 给全量（列表页与报表用）。
   * 排序按 `sortOrder`（= 科目表原行序），这样界面上的「项目」顺序与财务手上那张表一致；
   * 财务新增的科目排到末尾（sortOrder = 当前最大值 + 10），不会把原有顺序打乱。
   */
  async list(filter: { includeInactive?: boolean; category?: string } = {}) {
    const rows = await this.prisma.accountingSubject.findMany({
      where: {
        deletedAt: null,
        ...(filter.includeInactive ? {} : { isActive: true }),
        ...(filter.category ? { category: filter.category } : {}),
      },
    });
    // 排序在内存里做，用**全站同一个比较器**（先按分类的科目表顺序，再按 sortOrder，最后按名称）。
    // 不能只 `orderBy: sortOrder`：财务在「资产类」下新增科目时它的 sortOrder 是全局最大值，
    // 会排到损益类之后 —— 列表顺序与科目表不一致，收支汇总表的「分类小计」还会因此被拆成两行。
    // 科目表只有一百多条，内存排序的代价可以忽略。
    return rows.sort(compareAccountingSubjects);
  }

  /**
   * 分类清单 = 科目表固定的 5 类 ∪ 库里实际出现过的取值（含「未分类」）。
   *
   * 为什么不是直接返回常量：迁移可能把无法归类的旧项目放进了「未分类」，
   * 只给 5 类会让那些科目在筛选下拉里选不出来，等于看不见。
   */
  async categories(): Promise<string[]> {
    const rows = await this.prisma.accountingSubject.findMany({ where: { deletedAt: null }, select: { category: true }, distinct: ["category"] });
    const present = rows.map((row) => row.category);
    const known: string[] = [...ACCOUNTING_SUBJECT_CATEGORIES];
    return [...known, ...present.filter((category) => !known.includes(category)).sort()];
  }

  async get(id: string) {
    const row = await this.prisma.accountingSubject.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw this.notFound("ACCOUNTING_SUBJECT_NOT_FOUND", "会计科目不存在");
    return row;
  }

  /** 校验一个科目 id 的**唯一实现**在 `CashFlowService.requireSubject`（所有建单/过账路径都走它）。 */

  async create(input: { category: string; name: string; balance_direction?: string; sort_order?: number }, user: CurrentUser) {
    const category = this.required(input.category, "分类");
    const name = this.required(input.name, "项目名称");
    const balanceDirection = this.direction(input.balance_direction);
    await this.assertUnique(category, name);
    const sortOrder = input.sort_order ?? (await this.nextSortOrder(category));
    const row = await this.prisma.accountingSubject.create({
      data: { category, name, balanceDirection, sortOrder, ...this.audit.create(user) },
    });
    await this.audit.record("accounting_subject.create", "accounting_subject", user.id, row.id, { category, name });
    return row;
  }

  /**
   * 改名 / 换分类 / 改余额方向 / 停用启用。
   *
   * 改分类或改名都不影响历史：流水存的是 `subject_id`，展示时按主键取当前名字。
   * 这正是「科目可配置」的含义 —— 改口径不该让历史单据跟着改分类。
   */
  async update(id: string, input: { category?: string; name?: string; balance_direction?: string | null; sort_order?: number; is_active?: boolean }, user: CurrentUser) {
    const current = await this.get(id);
    const category = input.category === undefined ? current.category : this.required(input.category, "分类");
    const name = input.name === undefined ? current.name : this.required(input.name, "项目名称");
    if (category !== current.category || name !== current.name) await this.assertUnique(category, name, id);
    const row = await this.prisma.accountingSubject.update({
      where: { id },
      data: {
        category,
        name,
        ...(input.balance_direction === undefined ? {} : { balanceDirection: this.direction(input.balance_direction) }),
        ...(input.sort_order === undefined ? {} : { sortOrder: input.sort_order }),
        ...(input.is_active === undefined ? {} : { isActive: input.is_active }),
        ...this.audit.update(user),
      },
    });
    await this.audit.record("accounting_subject.update", "accounting_subject", user.id, id, {
      before: { category: current.category, name: current.name, is_active: current.isActive },
      after: { category: row.category, name: row.name, is_active: row.isActive },
    });
    return row;
  }

  /**
   * 逻辑删除。
   *
   * 已被任何业务数据引用时**直接拒绝**：删掉之后历史流水/凭证/对账单上的 `subject_id`
   * 会指向一条不存在的科目（外键 RESTRICT 也会挡，但那时报的是数据库约束错，
   * 财务看不懂）。要「不再用这个科目」就停用。
   */
  async remove(id: string, user: CurrentUser) {
    await this.get(id);
    const used = await this.usageCount(id);
    if (used > 0) {
      throw this.invalid("ACCOUNTING_SUBJECT_IN_USE", "该科目已被业务单据引用，不能删除；请改为停用");
    }
    const row = await this.prisma.accountingSubject.update({ where: { id }, data: this.audit.softDelete(user) });
    await this.audit.record("accounting_subject.delete", "accounting_subject", user.id, id, { category: row.category, name: row.name });
    return row;
  }

  /** 被引用的次数（删除前的守卫，也用于界面提示）。 */
  async usageCount(id: string): Promise<number> {
    const [entries, customerPayments, supplierPayments, receivables, payables] = await Promise.all([
      this.prisma.cashFlowEntry.count({ where: { subjectId: id } }),
      this.prisma.customerPayment.count({ where: { subjectId: id } }),
      this.prisma.supplierPayment.count({ where: { subjectId: id } }),
      this.prisma.receivableReconciliation.count({ where: { subjectId: id } }),
      this.prisma.supplierPayableReconciliation.count({ where: { subjectId: id } }),
    ]);
    return entries + customerPayments + supplierPayments + receivables + payables;
  }

  /** 新科目的排序号：接在**本分类最后一个科目**之后（不是全局最大值，理由见 `list()` 的注释）。 */
  private async nextSortOrder(category: string): Promise<number> {
    const last = await this.prisma.accountingSubject.findFirst({ where: { category, deletedAt: null }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    if (last) return last.sortOrder + 10;
    // 这个分类还一个科目都没有（财务自建的新分类）：接在全局最后，靠分类权重把它排到末尾。
    const globalLast = await this.prisma.accountingSubject.findFirst({ where: { deletedAt: null }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    return (globalLast?.sortOrder ?? 0) + 10;
  }

  /**
   * 同分类内科目名唯一。
   *
   * **必须连软删的科目一起查**：库层的唯一键 `@@unique([category, name])` 不认 `deleted_at`，
   * 所以「删掉一个没人用过的科目 → 再用同名新建」如果只查 `deletedAt: null`，会通过服务校验、
   * 然后撞在数据库唯一索引上，变成一个财务看不懂的 500。这里提前拦住并说清原因。
   */
  private async assertUnique(category: string, name: string, exceptId?: string) {
    const existing = await this.prisma.accountingSubject.findFirst({
      where: { category, name, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true, deletedAt: true },
    });
    if (!existing) return;
    if (existing.deletedAt) {
      throw this.invalid("ACCOUNTING_SUBJECT_DUPLICATED", `「${category}」下曾有一个叫「${name}」的科目（已删除），名称仍被占用，请换一个名字`);
    }
    throw this.invalid("ACCOUNTING_SUBJECT_DUPLICATED", `「${category}」下已经有「${name}」这个科目`);
  }

  private required(value: string | undefined, label: string): string {
    const text = value?.trim();
    if (!text) throw this.invalid("ACCOUNTING_SUBJECT_FIELD_REQUIRED", `请填写${label}`);
    return text;
  }

  /**
   * 余额方向只能是 借 / 贷，空值（undefined / null / 空串）表示「不填」→ 存 null。
   *
   * 为什么要卡住取值：这一列来自老表 D 列，凭证/账簿将来要靠它判断科目的自然余额方向。
   * 放开成任意字符串的话，写进一个「借贷平衡」之类的自由文本，将来的余额方向判断就废了，
   * 而且那时已经不知道是哪个经办人写坏的。
   */
  private direction(value: string | null | undefined): string | null {
    const text = value?.trim();
    if (!text) return null;
    if (text !== "借" && text !== "贷") throw this.invalid("ACCOUNTING_SUBJECT_DIRECTION_INVALID", "余额方向只能是「借」或「贷」");
    return text;
  }

  private notFound(code: string, message: string) {
    return new NotFoundException({ code, message, details: [] });
  }

  private invalid(code: string, message: string) {
    return new UnprocessableEntityException({ code, message, details: [] });
  }
}
