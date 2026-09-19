"use client";

// 会计科目（财务 → 收支管理 → 会计科目）。
//
// 用户 2026-09-17 口径：「收支项目维护和会计科目要合并成会计科目！合并成一个」，
// 并且「分类就对应的是科目类别，项目就对应的是科目名称」（来源 `example/财务/科目表(2).xls`）。
// 所以这一页就是**全站财务口径的唯一维护入口** —— 不另设「收支项目维护」面板。
//
// 三条界面约定：
//   1. 停用的科目仍然列出来（`include_inactive=true`）：否则历史流水上的科目名会消失，
//      财务会以为那些账丢了；停用只影响「还能不能新选」；
//   2. 删除只在「一次都没被引用」时才给按钮（后端也会挡），正常操作是停用；
//   3. 分类下拉的候选来自后端 `/categories`（5 类 ∪ 库里出现过的其它取值），
//      这样迁移带出来的「未分类」科目也能被筛选与重新归类。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../data/data-table";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../lib/api-client";
import { ACCOUNTING_SUBJECTS_PATH, type AccountingSubject } from "../../lib/accounting-subjects";
import { notifyError, notifySuccess } from "../ui/toaster";
import { auditColumns, type AuditRow } from "../data/audit-columns";

/** 会计科目（后端 `accounting_subjects`）。类型与显示口径在 lib/accounting-subjects.ts 里统一。 */
export type AccountingSubjectRow = AuditRow & AccountingSubject;

const ALL = "__all";
const EMPTY_DIRECTION = "__none";
const DIRECTIONS = [
  { value: EMPTY_DIRECTION, label: "（不填）" },
  { value: "借", label: "借" },
  { value: "贷", label: "贷" },
] as const;

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

export default function AccountingSubjectWorkspace({ testId = "page-finance-accounting-subjects" }: { testId?: string }) {
  const [subjects, setSubjects] = useState<AccountingSubjectRow[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [subjectResult, categoryResult] = await Promise.all([
        apiGet<AccountingSubjectRow[]>(`${ACCOUNTING_SUBJECTS_PATH}?include_inactive=true`),
        apiGet<string[]>(`${ACCOUNTING_SUBJECTS_PATH}/categories`),
      ]);
      setSubjects(subjectResult.data);
      setCategories(categoryResult.data);
    } catch (cause) {
      setError(messageOf(cause, "会计科目加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const categoryOptions = useMemo(() => categories.map((category) => ({ value: category, label: category })), [categories]);

  /**
   * 关键词与分类都是**本地过滤**：科目表只有一百多条，前端筛比往返一次更快，也不会让下拉闪烁。
   * （后端同样支持 `?category=`，那是给报表取数与第三方调用用的，不是这一页的必需品。）
   */
  const visible = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    return subjects.filter((subject) => {
      if (categoryFilter && subject.category !== categoryFilter) return false;
      if (!text) return true;
      return subject.name.toLowerCase().includes(text) || subject.category.toLowerCase().includes(text);
    });
  }, [subjects, categoryFilter, keyword]);

  /** 分类小计：让「这一共有多少科目、停用了几个」一眼可数。 */
  const summary = useMemo(() => {
    const active = visible.filter((subject) => subject.isActive).length;
    return { total: visible.length, active, inactive: visible.length - active };
  }, [visible]);

  function subjectFields(subject?: AccountingSubjectRow): ActionField[] {
    return [
      { name: "category", label: "分类", type: "select", required: true, defaultValue: subject?.category ?? categories[0], options: categoryOptions },
      { name: "name", label: "项目名称", type: "text", required: true, defaultValue: subject?.name, placeholder: "如：销售费 运费" },
      { name: "balance_direction", label: "余额方向", type: "select", defaultValue: subject?.balanceDirection ?? EMPTY_DIRECTION, options: DIRECTIONS.map((item) => ({ value: item.value, label: item.label })) },
    ];
  }

  function openCreate() {
    setDialog({
      title: "新增会计科目",
      fields: subjectFields(),
      submit: async (values) => {
        setBusy(true);
        try {
          await apiPost(ACCOUNTING_SUBJECTS_PATH, {
            category: values.category,
            name: values.name,
            ...(values.balance_direction && values.balance_direction !== EMPTY_DIRECTION ? { balance_direction: values.balance_direction } : {}),
          });
          notifySuccess(`已新增会计科目「${values.name}」`);
          await load();
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function openEdit(subject: AccountingSubjectRow) {
    setDialog({
      title: `编辑会计科目 ${subject.name}`,
      fields: subjectFields(subject),
      submit: async (values) => {
        setBusy(true);
        try {
          await apiPatch(`${ACCOUNTING_SUBJECTS_PATH}/${subject.id}`, {
            category: values.category,
            name: values.name,
            // 空选择要显式送空串（后端按「清空」处理）；undefined 表示不改。
            balance_direction: values.balance_direction === EMPTY_DIRECTION ? "" : values.balance_direction,
          });
          notifySuccess(`已保存「${values.name}」`);
          await load();
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function toggle(subject: AccountingSubjectRow) {
    setBusy(true);
    try {
      await apiPatch(`${ACCOUNTING_SUBJECTS_PATH}/${subject.id}`, { is_active: !subject.isActive });
      notifySuccess(subject.isActive ? `已停用「${subject.name}」（历史流水仍显示这个科目）` : `已启用「${subject.name}」`);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败（维护会计科目仅管理员可用）"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(subject: AccountingSubjectRow) {
    setBusy(true);
    try {
      await apiRequest(`${ACCOUNTING_SUBJECTS_PATH}/${subject.id}`, { method: "DELETE" });
      notifySuccess(`已删除「${subject.name}」`);
      await load();
    } catch (cause) {
      // 已被引用的科目后端会拒（ACCOUNTING_SUBJECT_IN_USE）；错误信息里已经写明「请改为停用」。
      notifyError(messageOf(cause, "删除失败（维护会计科目仅管理员可用）"));
    } finally {
      setBusy(false);
    }
  }

  const columns: ColumnDef<AccountingSubjectRow>[] = [
    { accessorKey: "category", header: "分类" },
    { accessorKey: "name", header: "项目" },
    { id: "direction", header: "余额方向", cell: ({ row }) => row.original.balanceDirection ?? "-" },
    { id: "state", header: "状态", cell: ({ row }) => (row.original.isActive ? "启用" : "已停用") },
    ...auditColumns<AccountingSubjectRow>(),
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => <div className="page-actions">
        <Button size="sm" variant="secondary" data-testid={`accounting-subject-edit-${row.original.id}`} disabled={busy} onClick={() => openEdit(row.original)}>编辑</Button>
        <Button size="sm" variant="secondary" data-testid={`accounting-subject-toggle-${row.original.id}`} disabled={busy} onClick={() => void toggle(row.original)}>{row.original.isActive ? "停用" : "启用"}</Button>
        <Button size="sm" variant="ghost" data-testid={`accounting-subject-delete-${row.original.id}`} disabled={busy} onClick={() => void remove(row.original)}>删除</Button>
      </div>,
    },
  ];

  // 不套 `page-root`：它由调用方（收支管理页）提供页面骨架与子栏目标签，
  // 这里只出内容面板，否则会出现「页中页」的两层 padding。
  return <div data-testid={testId}>
    <ActionDialog
      open={Boolean(dialog)}
      onOpenChange={(open) => { if (!open && !busy) setDialog(null); }}
      title={dialog?.title ?? "操作"}
      fields={dialog?.fields ?? []}
      onSubmit={(values) => (dialog ? dialog.submit(values) : undefined)}
    />

    <section className="panel">
      <div className="panel-body filter-bar">
        <label>分类
          <Select value={categoryFilter || ALL} onValueChange={(value) => setCategoryFilter(value === ALL ? "" : value)}>
            <SelectTrigger data-testid="accounting-subject-filter-category"><SelectValue placeholder="全部分类" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部分类</SelectItem>
              {categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label>搜索<Input data-testid="accounting-subject-search" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="科目名称 / 分类" /></label>
        {/* 新增必须走弹窗而不是「输个名字点新增」：分类是科目表的必填维度，
            没有分类的科目在报表里会落不进任何一个分类小计。 */}
        <Button data-testid="accounting-subject-create" disabled={busy} onClick={openCreate}>新增科目</Button>
        <Button variant="secondary" data-testid="accounting-subject-refresh" onClick={() => void load()}>刷新</Button>
      </div>
    </section>

    <section className="panel">
      <div className="panel-heading">
        <h2>会计科目</h2>
        <span className="panel-note" data-testid="accounting-subject-count">共 {summary.total} 条（启用 {summary.active} / 已停用 {summary.inactive}）</span>
      </div>
      {error && <div className="panel-body"><ErrorState message={error} onRetry={() => void load()} /></div>}
      {!error && loading && <LoadingState />}
      {!error && !loading && <div className="panel-body">
        <DataTable columns={columns} data={visible} empty={<EmptyState title="没有符合条件的会计科目" />} />
      </div>}
    </section>
  </div>;
}
