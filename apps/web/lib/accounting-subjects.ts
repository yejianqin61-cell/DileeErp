// 会计科目的前端共用件（纯数据模块，**不能**放进 "use client" 文件）。
//
// 为什么单独成模块：收支流水、应收/应付的「会计科目」下拉、财务报表筛选都要用同一份类型与
// 同一个显示口径。若从客户端组件里导出，跨 RSC 边界后拿到的是 client reference 代理
// （`apps/web/lib/server-client-boundary.test.mjs` 守着这条）。

/** 会计科目（后端 `accounting_subjects`）。`category` = 科目类别，`name` = 科目名称。 */
export type AccountingSubject = {
  id: string;
  category: string;
  name: string;
  balanceDirection: string | null;
  sortOrder: number;
  isActive: boolean;
};

/** 会填进下拉的最小形状。 */
export type AccountingSubjectOption = { id: string; label: string };

/** 会计科目接口前缀（后端 `accounting-subject.controller.ts`）。 */
export const ACCOUNTING_SUBJECTS_PATH = "/finance/accounting-subjects";

/**
 * 会计科目**类目**（后端 `accounting_subject_categories`，2026-11-07 起成为一等实体）。
 *
 * `id: null` 是「只存在于科目表里的历史类目」：正常迁移会把每个出现过的分类回填成类目行，
 * 只有在旧备份被整库恢复 / 绕过接口直写数据库时才会出现。它出现在筛选与科目弹窗的下拉里
 * （保证这些科目还能被编辑），但没有实体可以改名/删除 —— 所以列表里这一行不给操作按钮。
 */
export type AccountingSubjectCategory = {
  id: string | null;
  name: string;
  sortOrder: number;
  /** 内置类目（会计制度五类）：三大报表按名字硬编码匹配，不允许改名/删除。 */
  isSystem: boolean;
  /** 该类目下未软删的科目数（含停用）。 */
  subjectCount: number;
  /** 其中启用中的科目数。 */
  activeSubjectCount: number;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  created_by_name?: string | null;
  updated_by_name?: string | null;
};

/** 会计科目类目接口前缀（后端 `accounting-subject-category.controller.ts`）。 */
export const ACCOUNTING_SUBJECT_CATEGORIES_PATH = "/finance/accounting-subject-categories";

/**
 * 科目在下拉/表格里的显示文案：`分类 / 项目`。
 *
 * 为什么把分类拼进 label 而不是做成分组下拉：科目表的唯一键是 `(分类, 项目)`，
 * 不同分类下允许同名科目；只显示名称会让财务在两个「管理费用」之间无从选择。
 */
export const subjectOptionLabel = (subject: { category: string; name: string }): string => `${subject.category} / ${subject.name}`;

/** 列表接口返回的科目数组 → 下拉选项。 */
export const toSubjectOptions = (subjects: readonly AccountingSubject[]): AccountingSubjectOption[] =>
  subjects.map((subject) => ({ id: subject.id, label: subjectOptionLabel(subject) }));
