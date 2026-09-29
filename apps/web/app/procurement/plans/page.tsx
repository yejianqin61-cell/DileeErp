"use client";

// 采购计划列表（2026-09-27）。
//
// 用户原话：「采购模块那边多一个采购计划栏目。采购计划就承接的是原来的采购单草稿。
// 在采购计划里面，每个销售单对应一份的BOM对应一份的采购计划。」
//
// 这一页是「哪些单还没买齐」的入口：
//   · 新建 = 选一张**还没有计划**的 BOM（`GET /purchase-plans/candidates` 就是那张待办清单），
//     建完自动带出这张 BOM 的全部明细行与预填供应商，然后直接打开计划
//     （口径 2/3 —— 计划的身份是"这张 BOM 的采购工作面"，诞生时就该包含全部需求）；
//   · 一行 = 一份计划（一个销售单的 BOM），点进去就是那个工作面。
//
// 货号筛选走服务端的 `itemNoKey` 归一（`27621` 与 `27621␠` 是同一个货号）—— 与返单模块同一口径。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { DataTable } from "../../../components/data/data-table";
import { updatedByColumn } from "../../../components/data/audit-columns";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { PlanDetailSheet, type PlanMaterialRef, type PlanUnitRef } from "../../../components/procurement/plan-detail-sheet";
import { ApiClientError, apiGet, apiPost } from "../../../lib/api-client";
import { shouldRefreshOnVisibility } from "../../../lib/refresh-policy";
import { notifyError } from "../../../components/ui/toaster";

type PlanRow = {
  id: string; planNo: string; orderNo: string; itemNo: string | null; customerName: string | null;
  bomId: string; bomVersion: number | null; lineCount: number; unorderedCount: number; orderedCount: number;
  status: "unordered" | "partial" | "completed"; statusLabel: string; updatedByName: string | null;
  createdAt: string; updatedAt: string;
};
type Candidate = { bomId: string; orderNo: string; bomVersion: number | null; itemNo: string | null; customerName: string | null; deliveryDate: string | null; itemCount: number };

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);
const STATUS_TABS = [
  { value: "all", label: "全部" },
  { value: "unordered", label: "未下单" },
  { value: "partial", label: "部分下单" },
  { value: "completed", label: "已完成" },
];

export default function PurchasePlansPage() {
  const searchParams = useSearchParams();
  // `?order_no=`（工作台/返单跳过来）与 `?plan_id=`（分享/返回某份计划）都只在挂载时取初值：
  // 预置值是起点，不是锁（照生产页与采购单页的既有写法）。
  const [query, setQuery] = useState(searchParams.get("order_no") ?? "");
  const [itemNo, setItemNo] = useState("");
  const [status, setStatus] = useState("all");
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [materials, setMaterials] = useState<PlanMaterialRef[]>([]);
  const [units, setUnits] = useState<PlanUnitRef[]>([]);
  const [openPlanId, setOpenPlanId] = useState(searchParams.get("plan_id") ?? "");
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("order_no", query.trim());
      if (itemNo.trim()) params.set("item_no", itemNo.trim());
      if (status !== "all") params.set("status", status);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      // 位置型解构：`lib/page-data-alignment.test.mjs` 的绑定表按**顺序**盯着这四条，
      // 插入/换序会让那张表立刻变红（这正是它存在的意义）。
      const [plans, cands, ms, us] = await Promise.all([
        apiGet<PlanRow[]>(`/purchase-plans${suffix}`),
        apiGet<Candidate[]>("/purchase-plans/candidates"),
        apiGet<PlanMaterialRef[]>("/materials"),
        apiGet<PlanUnitRef[]>("/units"),
      ]);
      setRows(plans.data ?? []);
      setCandidates(cands.data ?? []);
      setMaterials(ms.data ?? []);
      setUnits(us.data ?? []);
    } catch (cause) {
      setError(messageOf(cause, "采购计划加载失败"));
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, [query, itemNo, status]);

  useEffect(() => { void load(); }, [load]);
  /**
   * 「未下单行数 / 状态」要跟着窗口焦点刷新，而不是只在挂载时拉一次。
   *
   * 场景：同事在另一个窗口把某张 BOM 的行下了单，本页那份计划如果不刷新就还写着"未下单 N"。
   * 两条要求（`lib/refresh-policy.test.mjs` 有守卫盯着）：只在页面**可见**时刷；**静默**刷
   * （切回本页不能整页 loading）。

   * ⚠️ 这里刻意不刷 `?plan_id=` 打开的那份计划 —— 那是详情 Sheet 自己的事，
   * 而且它正在被人编辑，外部刷新会覆盖未保存的改动（Sheet 里只刷「下单状态」那一列）。
   */
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState)) void load({ silent: true }); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);

  /** 新建：选一张还没有计划的 BOM。建完直接打开它 —— 行已经带好了，不用再点一次。 */
  async function createPlan(values: Record<string, string>) {
    const result = await apiPost<{ id: string }>("/purchase-plans", { bom_id: values.bom_id });
    setOpenPlanId(result.data.id);
  }

  const columns = useMemo<ColumnDef<PlanRow, any>[]>(() => [
    { id: "planNo", header: "计划编号", meta: { width: "12%", ellipsis: true }, cell: ({ row }) => <Button variant="link" data-testid={`plan-open-${row.original.planNo}`} onClick={() => setOpenPlanId(row.original.id)}>{row.original.planNo}</Button> },
    { accessorKey: "orderNo", header: "销售单号", meta: { width: "12%", ellipsis: true } },
    { id: "itemNo", header: "货号", meta: { width: "10%", ellipsis: true }, cell: ({ row }) => row.original.itemNo ?? "-" },
    { id: "customerName", header: "客户", meta: { width: "14%", ellipsis: true }, cell: ({ row }) => row.original.customerName ?? "-" },
    { id: "bomVersion", header: "BOM 版本", meta: { width: "7%" }, cell: ({ row }) => String(row.original.bomVersion ?? "-") },
    { id: "lineCount", header: "行数", meta: { width: "6%" }, cell: ({ row }) => String(row.original.lineCount) },
    // 「未下单行数」是这一页存在的理由：一眼扫过去就知道哪张单还没买齐。
    { id: "unorderedCount", header: "未下单", meta: { width: "8%" }, cell: ({ row }) => row.original.unorderedCount ? <span className="status-warning">{row.original.unorderedCount}</span> : <span className="status-success">0</span> },
    { id: "status", header: "状态", meta: { width: "9%" }, cell: ({ row }) => row.original.statusLabel },
    updatedByColumn<PlanRow>(),
    { id: "open", header: "操作", meta: { width: "9%" }, cell: ({ row }) => <Button size="sm" variant="secondary" data-testid={`plan-enter-${row.original.planNo}`} onClick={() => setOpenPlanId(row.original.id)}>打开计划</Button> },
  ], []);

  const candidateField: ActionField = {
    name: "bom_id",
    label: "销售单 / BOM",
    type: "searchable-select",
    required: true,
    placeholder: candidates.length ? "选一张还没有计划的 BOM" : "没有可建计划的 BOM",
    options: candidates.map((candidate) => ({
      value: candidate.bomId,
      label: `${candidate.orderNo}${candidate.itemNo ? ` / ${candidate.itemNo}` : ""}${candidate.customerName ? ` / ${candidate.customerName}` : ""}（${candidate.itemCount} 行）`,
    })),
  };

  return (
    <div className="page-root purchase-plan-list" data-testid="page-procurement-plans">
      <PageHeader title="采购计划" description="一个销售单的一份 BOM 对应一份计划：逐行填供应商、单价与预计到货，再按供应商收束下单到采购单。">
        <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        <Button data-testid="plan-create" onClick={() => setCreateOpen(true)}>新建采购计划</Button>
      </PageHeader>
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      <div className="filter-bar">
        <label>搜索
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="计划编号 / 销售单号 / 客户" aria-label="搜索计划" data-testid="plan-search" />
        </label>
        <label>货号
          <Input value={itemNo} onChange={(event) => setItemNo(event.target.value)} placeholder="按货号筛（同一货号的不同写法算一个）" aria-label="货号" data-testid="plan-item-no" />
        </label>
        <div className="page-actions">
          {STATUS_TABS.map((tab) => <Button key={tab.value} size="sm" variant={status === tab.value ? "secondary" : "ghost"} data-active={status === tab.value} data-testid={`plan-status-${tab.value}`} onClick={() => setStatus(tab.value)}>{tab.label}</Button>)}
        </div>
      </div>
      {loading ? <LoadingState /> : (
        <DataTable
          columns={columns}
          data={rows}
          empty={<EmptyState title="还没有采购计划" description="点右上角「新建采购计划」，选一张已经建好 BOM 的销售单。" />}
        />
      )}
      {openPlanId ? (
        <PlanDetailSheet
          planId={openPlanId}
          materials={materials}
          units={units}
          onClose={() => setOpenPlanId("")}
          onSaved={() => void load()}
          onDeleted={() => { setOpenPlanId(""); void load(); }}
        />
      ) : null}
      {createOpen ? (
        <ActionDialog
          open
          title="新建采购计划"
          submitLabel="创建并打开"
          fields={[candidateField]}
          onOpenChange={(open) => { if (!open) setCreateOpen(false); }}
          onSubmit={async (values) => {
            try {
              await createPlan(values);
              setCreateOpen(false);
              await load();
            } catch (cause) {
              notifyError(messageOf(cause, "新建采购计划失败"));
              // 抛出去：ActionDialog 保持弹窗打开并显示原因（人工挑 BOM，不想重选一遍）
              throw cause;
            }
          }}
        />
      ) : null}
    </div>
  );
}
