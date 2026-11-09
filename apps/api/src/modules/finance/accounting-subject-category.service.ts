import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { compareAccountingSubjectCategories } from "./accounting-subject-catalog";

/**
 * 会计科目类目（`/finance/accounting-subject-categories`，2026-11-07 起可增删改查）。
 *
 * 背景：类目原来是 `accounting_subjects.category` 上的一个字符串，只有
 * `SELECT DISTINCT category` 派生的只读清单，于是「改名」无法原子级联、「删除」无法判断
 * 「还有没有科目」、「新增」没有地方留审计。本服务把类目升成一等实体（表
 * `accounting_subject_categories`），但**科目行的 `category` 仍是字符串**（见设计文档 §2）：
 *   - 三大报表与凭证按类目名硬编码匹配科目，改成外键反而要在运行时翻译名字；
 *   - 一个科目只属于一个类目，字符串没有冗余；
 *   - 改名由本服务在**同一个事务**里 `updateMany` 全部科目行（含软删的，理由见 §4.3）。
 *
 * 三条硬规则（都有测试钉住）：
 *   1. 内置五类（会计制度顺序：资产类/负债类/成本类/所有者权益类/损益类）**不许改名、不许删除** ——
 *      三大报表按这五个名字取数，改名会让报表静默变成空表；
 *   2. 改自建类目名 = 同一事务内改类目行 + 改**全部**科目行的 `category`（不带 `deleted_at` 过滤；
 *      科目唯一键 `@@unique([category, name])` 不认软删，只改未删除的会在旧名下留唯一键地雷）；
 *   3. 删除前必须确认类目下没有未软删科目（含停用），否则一律 422 并说清还有几个科目；
 *      空类目**物理删除**（软删 + 唯一索引会让「删掉写错的类目 → 用同名重建」永远做不到）。
 */
export type AccountingSubjectCategoryRow = {
  /** `null` = 只存在于科目行里的历史类目（类目表里没有实体，不可改名/删除）。 */
  id: string | null;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  /** 该类目下未软删的科目数（含停用）。 */
  subjectCount: number;
  /** 其中启用中的科目数。 */
  activeSubjectCount: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

/** 审计事件里的实体类型（与 action 前缀一致，便于按实体查历史）。 */
const ENTITY = "accounting_subject_category";

@Injectable()
export class AccountingSubjectCategoryService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /**
   * 类目列表（带科目计数）。
   *
   * 排序（设计文档 §3.1）：**内置五类按会计制度顺序 → 自建类目按 sortOrder、再按名称 →
   * 历史类目（只存在于科目行）最后**。不能在库层 `orderBy: sortOrder` 了事：
   * 那是权重不是制度顺序，且自建类目的 sortOrder 可能落进 10..50 把五类插开；
   * 历史类目根本没有实体行，只能在这里合成。
   *
   * 三个查询并行、都是库侧聚合（不随科目行数把明细搬到应用层）：
   *   ① 类目表全量（几十行）；② 未软删科目按类目 count（含停用）；③ 其中 isActive 的 count。
   */
  async list(): Promise<AccountingSubjectCategoryRow[]> {
    const [categories, totalCounts, activeCounts] = await Promise.all([
      this.prisma.accountingSubjectCategory.findMany(),
      this.prisma.accountingSubject.groupBy({ by: ["category"], where: { deletedAt: null }, _count: { _all: true } }),
      this.prisma.accountingSubject.groupBy({ by: ["category"], where: { deletedAt: null, isActive: true }, _count: { _all: true } })
    ]);
    const totalByCategory = new Map(totalCounts.map((group) => [group.category, group._count._all]));
    const activeByCategory = new Map(activeCounts.map((group) => [group.category, group._count._all]));

    const ordered = [...categories].sort(compareAccountingSubjectCategories);
    const rows: AccountingSubjectCategoryRow[] = ordered.map((category) => ({
      id: category.id,
      name: category.name,
      sortOrder: category.sortOrder,
      isSystem: category.isSystem,
      subjectCount: totalByCategory.get(category.name) ?? 0,
      activeSubjectCount: activeByCategory.get(category.name) ?? 0,
      createdBy: category.createdBy,
      updatedBy: category.updatedBy,
      createdAt: category.createdAt,
      updatedAt: category.updatedAt
    }));

    // 历史类目：科目表里出现、类目表里没有的取值（设计文档 §4.5）。正常情况下迁移会把它们全部回填，
    // 这类合成行只在「旧备份整库恢复 / 绕过接口直写数据库」时出现 —— 仍要返回，
    // 否则这些科目在筛选与编辑下拉里选不出来。它们没有实体行：id=null，不能改名/删除。
    const known = new Set(ordered.map((category) => category.name));
    const maxSortOrder = ordered.reduce((max, category) => Math.max(max, category.sortOrder), 0);
    const historicalNames = [...totalByCategory.keys()].filter((name) => !known.has(name)).sort();
    for (const [index, name] of historicalNames.entries()) {
      rows.push({
        id: null,
        name,
        // 合成排序值：接在现有最大权重之后（只为类型一致，真正的「排最后」由它不在 ordered 里保证）。
        sortOrder: maxSortOrder + 10 * (index + 1),
        isSystem: false,
        subjectCount: totalByCategory.get(name) ?? 0,
        activeSubjectCount: activeByCategory.get(name) ?? 0,
        createdBy: null,
        updatedBy: null,
        createdAt: null,
        updatedAt: null
      });
    }
    return rows;
  }

  /** 新增自建类目；`sort_order` 省略时接在现有最大权重之后 +10。 */
  async create(input: { name: string; sort_order?: number }, user: CurrentUser) {
    const name = this.requiredName(input.name);
    await this.assertNameFree(name);
    const sortOrder = input.sort_order ?? (await this.nextSortOrder());
    const row = await this.prisma.accountingSubjectCategory.create({
      data: { name, sortOrder, isSystem: false, ...this.audit.create(user) }
    });
    await this.audit.record(`${ENTITY}.create`, ENTITY, user.id, row.id, { name, sort_order: sortOrder });
    return row;
  }

  /**
   * 改名 / 改排序（两者都可选）。
   *
   * 改名必须**原子级联**：半途失败会让科目散落在新旧两个名字下，报表的分类小计被拆成两段，
   * 所以「改类目行 + 改全部科目行」在同一个 `$transaction` 里完成。审计在事务之外记录
   * （与既有会计科目服务一致：审计失败不该回滚业务）。
   */
  async update(id: string, input: { name?: string; sort_order?: number }, user: CurrentUser) {
    const current = await this.get(id);
    const nextName = input.name === undefined ? current.name : this.requiredName(input.name);
    const nextSortOrder = input.sort_order === undefined ? current.sortOrder : input.sort_order;
    const rename = nextName !== current.name;
    const reorder = nextSortOrder !== current.sortOrder;

    // 内置五类不许改名/改排序：三大报表与凭证按这五个名字匹配科目，改了会让报表静默变成空表
    // （没有任何报错，只是所有行次取不到科目）—— 这是财务核对时最难查的一类问题。
    if (current.isSystem && (rename || reorder)) {
      throw this.invalid("ACCOUNTING_SUBJECT_CATEGORY_SYSTEM", "内置类目（会计制度五类）不许改名或调整排序：三大报表与凭证按这五个名字匹配科目");
    }
    // 什么都没变：不写库、不记审计（避免「点一下保存就多一条无意义的修改记录」）。
    if (!rename && !reorder) return current;
    if (rename) await this.assertNameFree(nextName, current.id);

    // 先快照旧值：事务里会改类目行，而审计要写**改前**的 name/sortOrder，
    // 级联条件也必须用改前的类目名（不能依赖 current 在 update 之后还是旧值）。
    const before = { name: current.name, sortOrder: current.sortOrder };

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.accountingSubjectCategory.update({
        where: { id },
        data: {
          ...(rename ? { name: nextName } : {}),
          ...(reorder ? { sortOrder: nextSortOrder } : {}),
          updatedBy: user.id
        }
      });
      // 改名级联：**不加 `deletedAt: null`**。科目表唯一键 `@@unique([category, name])` 不认软删，
      // 只改未删除的行会让「旧类目 + 曾删除过的同名科目」占着唯一键 —— 以后在旧类目下新建同名科目
      // 会撞库层唯一索引（500），而那时已经没人知道是这次改名留下的（设计文档 §4.3）。
      const affectedSubjects = rename
        ? (await tx.accountingSubject.updateMany({ where: { category: before.name }, data: { category: nextName, updatedBy: user.id } })).count
        : 0;
      return { updated, affectedSubjects };
    });

    // 改名与「只改排序」用不同的 action：前者带受影响科目数，后者只带排序前后值。
    const action = rename ? `${ENTITY}.rename` : `${ENTITY}.update`;
    await this.audit.record(action, ENTITY, user.id, id, {
      before: { name: before.name, sort_order: before.sortOrder },
      after: { name: result.updated.name, sort_order: result.updated.sortOrder },
      ...(rename ? { affected_subjects: result.affectedSubjects } : {})
    });
    return result.updated;
  }

  /**
   * 删除类目（物理删除）。
   *
   * 守卫：内置类目 422；类目下还有**未软删**科目（含停用）422 并说清还有几个 ——
   * 停用科目仍在会计科目页与历史流水上，类目没了它们就失去所属类目、下拉里也选不到。
   * 空类目物理删除：类目行不承载业务事实，硬删让「删掉写错的类目 → 用同名重新建」成为可能
   * （软删 + 唯一索引会让同名永远建不回来），与宪法《Configurable Business Categories》不冲突：
   * 已使用的类目根本不会被删（直接拒绝）。
   */
  async remove(id: string, user: CurrentUser) {
    const current = await this.get(id);
    if (current.isSystem) {
      throw this.invalid("ACCOUNTING_SUBJECT_CATEGORY_SYSTEM", "内置类目（会计制度五类）不许删除：三大报表与凭证按这五个名字匹配科目");
    }
    const subjectCount = await this.prisma.accountingSubject.count({ where: { category: current.name, deletedAt: null } });
    if (subjectCount > 0) {
      throw this.invalid("ACCOUNTING_SUBJECT_CATEGORY_IN_USE", `该类目下还有 ${subjectCount} 个科目，请先把这些科目改到其它类目后再删除`, [{ subject_count: subjectCount }]);
    }
    await this.prisma.accountingSubjectCategory.delete({ where: { id } });
    await this.audit.record(`${ENTITY}.delete`, ENTITY, user.id, id, { name: current.name });
    return current;
  }

  /** 按 id 取实体行；找不到 → 404（历史合成行没有 id，自然也走不到这里）。 */
  private async get(id: string) {
    const row = await this.prisma.accountingSubjectCategory.findUnique({ where: { id } });
    if (!row) throw this.notFound(`会计科目类目不存在`);
    return row;
  }

  /** 类目名全表唯一：新增与改名都要查；改名时排除自己。 */
  private async assertNameFree(name: string, exceptId?: string) {
    const existing = await this.prisma.accountingSubjectCategory.findUnique({ where: { name } });
    if (!existing || existing.id === exceptId) return;
    throw this.invalid("ACCOUNTING_SUBJECT_CATEGORY_DUPLICATED", `类目「${name}」已存在`);
  }

  /** 新类目的排序权重：接在现有最大值之后 +10（与内置类目的 10 间隔一致）。 */
  private async nextSortOrder(): Promise<number> {
    const last = await this.prisma.accountingSubjectCategory.findFirst({ where: {}, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    return (last?.sortOrder ?? 0) + 10;
  }

  /**
   * 类目名：trim 后必填、≤30 字（与库里 `VARCHAR(30)` 同一口径）。
   *
   * DTO 已经拦了一道，这里再拦一次是因为本服务也可能被其它入口调用 —— 空白名或超长名
   * 落库会变成一条「看起来存在、但没人能选中」的类目；与其撞数据库长度错误，不如给一句能读懂的话。
   */
  private requiredName(value: string | undefined): string {
    const text = value?.trim() ?? "";
    if (!text) throw this.invalid("ACCOUNTING_SUBJECT_CATEGORY_FIELD_REQUIRED", "请填写类目名称");
    if (text.length > 30) throw this.invalid("ACCOUNTING_SUBJECT_CATEGORY_FIELD_REQUIRED", "类目名称不能超过 30 个字");
    return text;
  }

  private notFound(message: string) {
    return new NotFoundException({ code: "ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND", message, details: [] });
  }

  private invalid(code: string, message: string, details: Array<Record<string, unknown>> = []) {
    return new UnprocessableEntityException({ code, message, details });
  }
}
