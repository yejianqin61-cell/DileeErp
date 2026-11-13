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
//   3. 分类（科目类目）从 2026-11-07 起是**可维护的实体**：列表、筛选下拉、科目弹窗的下拉
//      都读新接口 `/finance/accounting-subject-categories`（含 id=null 的历史类目，顺序与后端一致），
//      页面上多一块「科目类目」面板做增删改；内置五类（资产类…损益类）只读 —— 三大报表按名字硬编码
//      匹配它们，允许改名会让报表静默变成空表。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../data/data-table";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SearchableSelect } from "../ui/searchable-select";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../lib/api-client";
import { ACCOUNTING_SUBJECT_CATEGORIES_PATH, ACCOUNTING_SUBJECTS_PATH, type AccountingSubject, type AccountingSubjectCategory } from "../../lib/accounting-subjects";
import { notifyError, notifySuccess } from "../ui/toaster";
import { auditColumns, type AuditRow } from "../data/audit-columns";
import OpeningBalancePanel from "./opening-balance-panel";
import ExchangeRatePanel from "./exchange-rate-panel";

/** 会计科目（后端 `accounting_subjects`）。类型与显示口径在 lib/accounting-subjects.ts 里统一。 */
export type AccountingSubjectRow = AuditRow & AccountingSubject;
/** 类目行（含审计列）；`id === null` = 只存在于科目表里的历史类目，不可改名/删除。 */
export type AccountingSubjectCategoryRow = AuditRow & AccountingSubjectCategory;

const ALL = "__all";
const EMPTY_DIRECTION = "__none";
const DIRECTIONS = [
  { value: EMPTY_DIRECTION, label: "（不填）" },
  { value: "借", label: "借" },
  { value: "贷", label: "贷" },
] as const;

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

/**
 * 类目类型词（设计 §6）：内置 / 自建 / 历史。
 * 内置 = 会计制度五类（`isSystem`）；历史 = `id` 为 null、只存在于某些历史科目行上的分类。
 */
function categoryTypeLabel(category: AccountingSubjectCategoryRow): string {
  if (!category.id) return "历史";
  return category.isSystem ? "内置" : "自建";
}

export default function AccountingSubjectWorkspace({ testId = "page-finance-accounting-subjects" }: { testId?: string }) {
  const [subjects, setSubjects] = useState<AccountingSubjectRow[]>([]);
  // 类目清单（2026-11-07 起来自新接口）：既供「科目类目」面板渲染，也供筛选/科目弹窗的下拉。
  // 里层顺序就是后端给的顺序（内置五类按会计制度 → 自建按 sortOrder/名称 → 历史类目最后），前端不再排。
  const [categoryRows, setCategoryRows] = useState<AccountingSubjectCategoryRow[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submitLabel?: string; submit: (values: Record<string, string>) => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [subjectResult, categoryResult] = await Promise.all([
        apiGet<AccountingSubjectRow[]>(`${ACCOUNTING_SUBJECTS_PATH}?include_inactive=true`),
        // 旧接口 `/accounting-subjects/categories` 只是派生字符串清单、无法维护，已不再调用；
        // 新接口同时带回科目数/内置标记/审计人，类目面板与两个下拉共用这一份数据，避免两处清单不一致。
        apiGet<AccountingSubjectCategoryRow[]>(ACCOUNTING_SUBJECT_CATEGORIES_PATH),
      ]);
      setSubjects(subjectResult.data);
      setCategoryRows(categoryResult.data ?? []);
    } catch (cause) {
      setError(messageOf(cause, "会计科目加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 两个下拉的候选 = 类目清单的名称（值仍用名称：科目表存的是字符串，后端写入口会校验它存在）。
  // 分两套（2026-11-07 复核）：
  //   - `categoryOptions`（全部，含 id=null 历史类目）给筛选与「编辑科目」——
  //     历史类目上的旧科目不换分类也要能改名字/余额方向，后端 update 只在分类真的变了时才校验；
  //   - `categoryOptionsForCreate`（过滤掉 id=null）给「新增科目」——
  //     历史类目在类目表里没有实体，选它新建科目必然被后端 422，不能给用户一个注定失败的选项。
  const categoryNames = useMemo(() => categoryRows.map((category) => category.name), [categoryRows]);
  const categoryOptions = useMemo(() => categoryNames.map((category) => ({ value: category, label: category })), [categoryNames]);
  const categoryOptionsForCreate = useMemo(
    () => categoryRows.filter((category) => category.id !== null).map((category) => ({ value: category.name, label: category.name })),
    [categoryRows],
  );

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
    // 编辑：保留全部类目（含历史），旧科目不换分类也能改其它字段；
    // 新增：只给有实体的类目（id !== null），避免选中一个必然 422 的历史类目。
    const options = subject ? categoryOptions : categoryOptionsForCreate;
    return [
      { name: "category", label: "分类", type: "select", required: true, defaultValue: subject?.category ?? options[0]?.value, options },
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

  /**
   * 类目 CRUD（2026-11-07 用户：「允许用户自行对会计科目的类目进行增删改查」）。
   *
   * 三个动作共用同一个 ActionDialog：
   *   - 新增 / 改名：后端 422（重名 / 内置保护）抛回 ActionDialog，原因显示在弹窗内、已填的值不丢；
   *   - 删除：二次确认（有科目时后端 422 会写明「还有 N 个科目」），用 notifyError 原样提示；
   *     内置类目与 id=null 历史类目在列表里根本不给按钮，所以这里不需要再判 id。
   */
  function openCreateCategory() {
    setDialog({
      title: "新增科目类目",
      submitLabel: "新增",
      fields: [{ name: "name", label: "类目名称", type: "text", required: true, placeholder: "如：共同类" }],
      submit: async (values) => {
        setBusy(true);
        try {
          await apiPost(ACCOUNTING_SUBJECT_CATEGORIES_PATH, { name: values.name.trim() });
          notifySuccess(`已新增科目类目「${values.name.trim()}」`);
          await load();
        } finally { setBusy(false); }
      },
    });
  }

  function openRenameCategory(category: AccountingSubjectCategoryRow) {
    setDialog({
      title: `改名科目类目：${category.name}`,
      submitLabel: "保存",
      fields: [{ name: "name", label: "类目名称", type: "text", required: true, defaultValue: category.name }],
      submit: async (values) => {
        setBusy(true);
        try {
          // 改名由后端在同一事务里级联更新全部科目（含软删），前端不自己拼第二条请求。
          await apiPatch(`${ACCOUNTING_SUBJECT_CATEGORIES_PATH}/${category.id}`, { name: values.name.trim() });
          notifySuccess(`已将类目「${category.name}」改名为「${values.name.trim()}」`);
          await load();
        } finally { setBusy(false); }
      },
    });
  }

  function openDeleteCategory(category: AccountingSubjectCategoryRow) {
    setDialog({
      title: `删除科目类目：${category.name}`,
      submitLabel: "删除",
      fields: [{ name: "notice", label: "只在类目下没有科目时可删；如果还有科目，请先把这些科目改到其它类目。删除后不可恢复。", type: "info" }],
      submit: async () => {
        setBusy(true);
        try {
          await apiRequest(`${ACCOUNTING_SUBJECT_CATEGORIES_PATH}/${category.id}`, { method: "DELETE" });
          notifySuccess(`已删除科目类目「${category.name}」`);
          await load();
        } catch (cause) {
          // 有科目时后端返回 422 并写明「还有 N 个科目，请先把这些科目改到其它类目」——
          // 原样提示，让财务知道下一步该做什么。
          notifyError(messageOf(cause, "删除科目类目失败（维护类目仅管理员可用）"));
        } finally { setBusy(false); }
      },
    });
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

  /**
   * 「科目类目」面板的列。科目数显示成「启用 x / 共 y」：停用的科目也占类目（删除守卫按未软删科目算），
   * 财务要能一眼看出「这个类目是真的空，还是只剩停用科目」。
   * 内置类目与 id=null 历史类目没有可操作的实体 —— 操作列只显示类型标签，不出现改名/删除按钮。
   */
  const categoryColumns: ColumnDef<AccountingSubjectCategoryRow>[] = [
    { accessorKey: "name", header: "类目" },
    { id: "subjectCount", header: "科目数", cell: ({ row }) => `启用 ${row.original.activeSubjectCount} / 共 ${row.original.subjectCount}` },
    { id: "type", header: "类型", cell: ({ row }) => categoryTypeLabel(row.original) },
    ...auditColumns<AccountingSubjectCategoryRow>(),
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => {
        const category = row.original;
        // 内置五类：三大报表按名字硬编码匹配，改名会让报表静默变空，所以只读。
        if (category.isSystem) return <span className="panel-note" data-testid={`accounting-subject-category-system-${category.name}`}>内置类目（会计制度口径，不可改）</span>;
        // id=null 的历史类目只在科目表里剩一个字符串，没有实体可改/可删。
        if (!category.id) return <span className="panel-note" data-testid={`accounting-subject-category-history-${category.name}`}>历史类目（仅存在于历史科目）</span>;
        return <div className="page-actions">
          <Button size="sm" variant="secondary" data-testid={`accounting-subject-category-rename-${category.id}`} disabled={busy} onClick={() => openRenameCategory(category)}>改名</Button>
          <Button size="sm" variant="ghost" data-testid={`accounting-subject-category-delete-${category.id}`} disabled={busy} onClick={() => openDeleteCategory(category)}>删除</Button>
        </div>;
      },
    },
  ];

  // 不套 `page-root`：它由调用方（收支管理页）提供页面骨架与子栏目标签，
  // 这里只出内容面板，否则会出现「页中页」的两层 padding。
  return <div data-testid={testId}>
    <ActionDialog
      open={Boolean(dialog)}
      onOpenChange={(open) => { if (!open && !busy) setDialog(null); }}
      title={dialog?.title ?? "操作"}
      submitLabel={dialog?.submitLabel}
      fields={dialog?.fields ?? []}
      onSubmit={(values) => (dialog ? dialog.submit(values) : undefined)}
    />

    {/* 科目类目（2026-11-07 用户：「允许用户自行对会计科目的类目进行增删改查」）：放在科目列表之前 ——
        类目是科目的分类清单，财务先维护清单、再维护科目。内置五类只读（三大报表按名字硬编码匹配）。 */}
    <section className="panel" data-testid="accounting-subject-category-panel">
      <div className="panel-heading">
        <h2>科目类目</h2>
        {/* 类目数只在拿到数据后显示：loading 时闪「共 0 个类目」、失败时留着 0 都是误导。 */}
        {!loading && !error ? <span className="panel-note" data-testid="accounting-subject-category-count">共 {categoryRows.length} 个类目</span> : null}
        <div className="page-actions">
          <Button data-testid="accounting-subject-category-create" disabled={busy} onClick={openCreateCategory}>新增类目</Button>
        </div>
      </div>
      <p className="panel-note panel-body" data-testid="accounting-subject-category-note">
        内置五类（资产类 / 负债类 / 成本类 / 所有者权益类 / 损益类）按会计制度锁定，不能改名或删除；
        自建类目在类目下还有科目（含停用）时也不能删除，请先把这些科目改到其它类目。历史类目只出现在旧数据里，不能操作。
      </p>
      {/* 三种状态与科目面板同源（同一个 load() 的 loading / error）。首屏与失败态**不能**渲染 DataTable：
          loading 时会闪一下「暂无科目类目」，加载失败时更会显示「0 个类目 + 请执行数据库迁移」——
          把网络/权限问题说成数据库没迁移，是最容易被当成真故障的一类误导（2026-11-07 复核）。 */}
      {error ? <p className="status-error panel-body" data-testid="accounting-subject-category-error">类目加载失败：{error}（可在下方会计科目面板点「重新加载」）</p> : null}
      {!error && loading ? <p className="panel-note panel-body" data-testid="accounting-subject-category-loading">正在加载科目类目…</p> : null}
      {!error && !loading ? <div className="panel-body">
        <DataTable columns={categoryColumns} data={categoryRows} empty={<EmptyState title="暂无科目类目" description="正常迁移会种入五个内置类目；如果这里是空的，请先执行数据库迁移。" />} />
      </div> : null}
    </section>

    <section className="panel">
      <div className="panel-body filter-bar">
        <label>分类
          {/* 分类清单随科目表增长（用户 2026-11-13：「所有下拉列表……都要有搜索功能」），筛选器带搜索。 */}
          <SearchableSelect
            id="accounting-subject-filter-category"
            testId="accounting-subject-filter-category"
            value={categoryFilter || ALL}
            options={[{ value: ALL, label: "全部分类" }, ...categoryNames.map((category) => ({ value: category, label: category }))]}
            placeholder="全部分类"
            label="分类"
            searchPlaceholder="搜索分类"
            noResultsText="没有匹配的分类"
            onChange={(value) => setCategoryFilter(value === ALL ? "" : value)}
          />
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
      {!error && !loading && <div className="panel-body" data-testid="accounting-subject-table">
        <DataTable columns={columns} data={visible} empty={<EmptyState title="没有符合条件的会计科目" />} />
      </div>}
    </section>

    {/* 建账期初余额（2026-09-24）：科目表是「有哪些科目」，这一块是「建账那天各科目各是多少」——
        三大报表的起点。放在同一页是因为两件事都是财务口径的维护入口，分两页反而要多找一次。 */}
    <OpeningBalancePanel />

    {/* 期末汇率（2026-09-24）：外币凭证要折成人民币才能进三大报表。与期初余额同为「报表口径的维护入口」，
        所以也在这一页 —— 财务的月度动作就这两件：维护期初一次、维护汇率每月一次。 */}
    <ExchangeRatePanel />
  </div>;
}
