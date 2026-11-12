"use client";

// 采购计划列表（2026-09-27 建；**2026-10-13 展平**）。
//
// 用户原话：「采购模块那边多一个采购计划栏目。采购计划就承接的是原来的采购单草稿。
// 在采购计划里面，每个销售单对应一份的BOM对应一份的采购计划。」（2026-09-27）
// 以及 2026-10-13：「采购计划的那个页面，也要显示物料名称等等 column。都要显示」。
//
// 2026-09-27 那一版是「一行 = 一份计划」，只显示计划级信息（编号/单号/货号/客户/版本/行数/
// 未下单/金额/状态/最后更新）—— 想知道"这份计划里到底有哪些物料、哪条还没买"只能点进去。
// 这一版按用户 2026-10-13 的口径**展平**：**一行 = 一条计划明细**，13 列一次显示，
// 每列都有显式宽度（和 = 100%，`table-layout: fixed`）。
//
// 取舍（口径 7，见 `docs/design/purchase-plan-split-order-and-flat-list-2026-10-13.md`）：
//   · 计划级汇总（未下单行数 / 计划金额 / 状态 / 最后更新）**不再单独成列** ——
//     它们与 13 个明细列塞在同一张表里会变成 20+ 列，1366px 上每列不到 70px，
//     那正是 2026-09-27「一次性展示所有 column」要防的事。
//     它们挂在「计划编号」那一格的 `title` 上，点进详情也仍然看得见。
//   · 一份**一行明细都没有**的计划仍然出现在列表里（占位一行）：否则它会凭空消失，
//     而它唯一的入口就是这一页。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { DataTable } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { PlanDetailSheet, type PlanMaterialRef, type PlanUnitRef } from "../../../components/procurement/plan-detail-sheet";
import { ApiClientError, apiGet, apiPost } from "../../../lib/api-client";
import { shouldRefreshOnVisibility } from "../../../lib/refresh-policy";
import { formatBeijingShort } from "../../../lib/audit-time";
import { amountSummaryText, lineAmountText, type PlanAmount } from "../../../lib/purchase-plan-amount";
import { OrderNoWithOrphan } from "../../../components/data/orphan-badge";
import { trimPlanNumber } from "../../../lib/purchase-plan-price-entry";
import { blockedCandidateLabel, blockedCandidateNotes, blockedCandidatesFromMeta, candidatePlaceholder, type BlockedCandidate } from "../../../lib/purchase-plan-candidates";
import { notifyError } from "../../../components/ui/toaster";

/**
 * 一条计划明细（`GET /purchase-plans` 的 `lines[]`）。
 *
 * 名字与详情接口的 `items` 区别开是刻意的：那些是**可编辑行**（带快照、BOM 参考单价、
 * 已下单行锁），这里只是渲染下面这 13 列要用的投影。
 */
type PlanLine = {
  id: string; materialId: string; materialCode: string | null; materialName: string; model: string | null;
  unitName: string | null; quantity: string; unitPrice: string; amount: string; currency: string | null;
  supplierId: string | null; supplierName: string | null; expectedDate: string | null;
  /** 「这一行已经下过单」的唯一表示（与后端同一口径）。 */
  ordered: boolean; purchaseOrderNo: string | null;
};

type PlanRow = {
  id: string; planNo: string; orderNo: string; itemNo: string | null; customerName: string | null;
  bomId: string; bomVersion: number | null; lineCount: number; unorderedCount: number; orderedCount: number;
  /** 计划金额：**按币种分列**（后端 `sumPlanAmounts`，金额不跨币种合计）。`unorderedAmounts` 是其中未下单的那部分。 */
  amounts?: PlanAmount[]; unorderedAmounts?: PlanAmount[];
  status: "unordered" | "partial" | "completed"; statusLabel: string; updatedByName: string | null;
  /** 所属销售单已被软删（2026-11-03）：计划不删，只显示成「孤立」。判定只认后端字段。 */
  orphaned?: boolean;
  createdAt: string; updatedAt: string;
  /** 展平用的明细行（2026-10-13）。老版本接口没有这一项时按空处理，页面不会炸。 */
  lines?: PlanLine[];
};
type Candidate = { bomId: string; orderNo: string; bomVersion: number | null; itemNo: string | null; customerName: string | null; deliveryDate: string | null; itemCount: number };
/** 展平后的一行：一份计划 + 它的某一条明细（`line === null` = 这份计划一行都没有）。 */
type FlatRow = { plan: PlanRow; line: PlanLine | null };

/**
 * 13 列的固定宽度（百分比，**和正好 100%**）。
 *
 * 集中写在一处而不是散在 13 个 `meta` 里：`table-layout: fixed` 下总和超过 100% 就是把表撑出容器，
 * 而"少写一列"的表现只是"那一列由浏览器自动分摊"—— 两者都只能靠人眼看。
 * `lib/purchase-plan-list-table.test.mjs` 按这个常量断言总和。
 */
const COLUMN_WIDTH = {
  planNo: "9%",
  orderNo: "9%",
  itemNo: "6%",
  customerName: "8%",
  materialName: "12%",
  model: "8%",
  unit: "4%",
  quantity: "7%",
  unitPrice: "5%",
  amount: "7%",
  supplier: "9%",
  orderState: "9%",
  expectedDate: "7%",
} as const;

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);
const STATUS_TABS = [
  { value: "all", label: "全部" },
  { value: "unordered", label: "未下单" },
  { value: "partial", label: "部分下单" },
  { value: "completed", label: "已完成" },
];

/**
 * 计划级汇总挂在「计划编号」那一格的 `title` 上（口径 7：这些数不再单独成列，
 * 但用户仍然问得到「这张单还差多少、要花多少钱、谁最后动的」）。
 */
function planSummaryTitle(plan: PlanRow) {
  const total = amountSummaryText(plan.amounts ?? []) || "未填价";
  const unordered = amountSummaryText(plan.unorderedAmounts ?? []) || "未填价";
  const updatedAt = formatBeijingShort(plan.updatedAt);
  return [
    `未下单 ${plan.unorderedCount} / 共 ${plan.lineCount} 行 · ${plan.statusLabel}`,
    `计划金额 ${total}（其中未下单 ${unordered}）`,
    `最后更新 ${plan.updatedByName ?? "—"}${updatedAt ? ` ${updatedAt}` : ""}`,
    /**
     * 完成态追加一句「补料还能在这里加行」（2026-11-12）。
     *
     * 审计 §1.2 的死锁：计划一旦有已下单行就**删不掉**（`remove()` 422），而 `bom_id` 上的
     * 部分唯一索引一直占着 —— 于是这张 BOM 永远不会再出现在"可建计划"的候选里，
     * 「想再买一批」的唯一出路就是**在这份计划里加一行**。
     *
     * 那句提示必须挂在这份计划自己身上：用户看到"已完成"只会以为它结束了。
     * 走 `title` 而不是新增一列 —— 13 列的宽度预算已经用完（口径 7）。
     */
    ...(plan.status === "completed" ? ["这张 BOM 的料已经买齐；补料请在这份计划里加一行（不必也不能另建一份计划）"] : []),
  ].join("\n");
}

export default function PurchasePlansPage() {
  const searchParams = useSearchParams();
  // `?order_no=`（工作台/返单跳过来）与 `?plan_id=`（分享/返回某份计划）都只在挂载时取初值：
  // 预置值是起点，不是锁（照生产页与采购单页的既有写法）。
  const [query, setQuery] = useState(searchParams.get("order_no") ?? "");
  const [itemNo, setItemNo] = useState("");
  const [status, setStatus] = useState("all");
  /**
   * 服务端返回的**每一份计划**。
   *
   * ⚠️ 状态名 `rows` / setter `setRows` 与 `lib/page-data-alignment.test.mjs` 的绑定表绑在一起
   * （那条守卫按"哪个 setter 拿了哪个接口"钉住位置型解构）；改名的收益是 0，改红的代价是
   * 一条本来有用的守卫，所以展平后的表数据另起名叫 `flatRows`。
   */
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  /**
   * 被拦下的 BOM（`meta.blocked`，2026-11-12）。
   *
   * 用户原话：「采购计划有时候无法选中需要建立采购计划的BOM表」。审计指出候选接口把
   * 不可建的 BOM 静默滤掉，界面上只剩空下拉 —— 这一格就是"为什么"。
   */
  const [blockedCandidates, setBlockedCandidates] = useState<BlockedCandidate[]>([]);
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
      setBlockedCandidates(blockedCandidatesFromMeta(cands.meta));
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
   *
   * ⚠️ 这里刻意不刷 `?plan_id=` 打开的那份计划 —— 那是详情 Sheet 自己的事，
   * 而且它正在被人编辑，外部刷新会覆盖未保存的改动（Sheet 里只刷「下单状态」那一列）。
   */
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState)) void load({ silent: true }); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);

  /**
   * 展平：一行 = 一条明细。顺序照服务端（计划按最后更新倒序、明细按序号）。
   * 一行明细都没有的计划补一行占位（`line: null`）。
   */
  const flatRows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    for (const plan of rows) {
      const lines = plan.lines ?? [];
      if (lines.length) for (const line of lines) out.push({ plan, line });
      else out.push({ plan, line: null });
    }
    return out;
  }, [rows]);

  /** 新建：选一张还没有计划的 BOM。建完直接打开它 —— 行已经带好了，不用再点一次。 */
  async function createPlan(values: Record<string, string>) {
    const result = await apiPost<{ id: string }>("/purchase-plans", { bom_id: values.bom_id });
    setOpenPlanId(result.data.id);
  }

  const columns = useMemo<ColumnDef<FlatRow, any>[]>(() => [
    {
      id: "planNo",
      header: "计划编号",
      meta: { width: COLUMN_WIDTH.planNo, ellipsis: true },
      accessorFn: (row) => row.plan.planNo,
      // 计划编号就是这一页的入口（口径 7 不再单设「操作」列）：它的 `title` 里带着
      // 计划级汇总（未下单行数/金额/最后更新），所以少掉那几列不等于少掉那几个答案。
      cell: ({ row }) => (
        <Button
          variant="link"
          data-testid="plan-open"
          data-plan-no={row.original.plan.planNo}
          title={planSummaryTitle(row.original.plan)}
          onClick={() => setOpenPlanId(row.original.plan.id)}
        >
          {row.original.plan.planNo}
        </Button>
      ),
    },
    // 销售单号旁可能跟着「孤立」徽章：销售单被删后采购计划不删，仍要能按计划继续下单/收货。
    { id: "orderNo", header: "销售单号", meta: { width: COLUMN_WIDTH.orderNo, ellipsis: true }, accessorFn: (row) => row.plan.orderNo, cell: ({ row }) => <OrderNoWithOrphan orderNo={row.original.plan.orderNo} orphaned={row.original.plan.orphaned} /> },
    { id: "itemNo", header: "货号", meta: { width: COLUMN_WIDTH.itemNo, ellipsis: true }, accessorFn: (row) => row.plan.itemNo ?? "-" },
    { id: "customerName", header: "客户", meta: { width: COLUMN_WIDTH.customerName, ellipsis: true }, accessorFn: (row) => row.plan.customerName ?? "-" },
    {
      id: "materialName",
      header: "物料名称",
      meta: { width: COLUMN_WIDTH.materialName, ellipsis: true },
      accessorFn: (row) => row.line?.materialName ?? "",
      cell: ({ row }) => {
        const line = row.original.line;
        if (!line) return <span className="panel-note">（这份计划一行都没有）</span>;
        // 物料编码放在悬停提示里：这一列的字数预算全给"叫什么"（13 列一屏，
        // 编码在物料清单页、BOM 表与计划详情里都有）。
        return <span title={line.materialCode ? `${line.materialCode} / ${line.materialName}` : line.materialName}>{line.materialName}</span>;
      },
    },
    { id: "model", header: "型号", meta: { width: COLUMN_WIDTH.model, ellipsis: true }, accessorFn: (row) => row.line?.model ?? "-" },
    { id: "unit", header: "单位", meta: { width: COLUMN_WIDTH.unit, ellipsis: true }, accessorFn: (row) => row.line?.unitName ?? "-" },
    { id: "quantity", header: "本次采购量", meta: { width: COLUMN_WIDTH.quantity, ellipsis: true }, accessorFn: (row) => (row.line ? trimPlanNumber(row.line.quantity) : "-") },
    {
      id: "unitPrice",
      header: "单价",
      meta: { width: COLUMN_WIDTH.unitPrice, ellipsis: true },
      // 0 价 = 还没谈价，而 0 价的行**不会下单**（2026-10-11 口径）：标红，与详情表同一口径。
      cell: ({ row }) => {
        const line = row.original.line;
        if (!line) return "-";
        const price = trimPlanNumber(line.unitPrice);
        return Number(line.unitPrice) > 0 ? <span>{price}</span> : <span className="status-danger" title="还没有单价：这一行不会下单，补价后再下一波">{price}</span>;
      },
      accessorFn: (row) => (row.line ? trimPlanNumber(row.line.unitPrice) : "-"),
    },
    {
      id: "amount",
      header: "行总价",
      meta: { width: COLUMN_WIDTH.amount, ellipsis: true },
      // 本地即时算（与详情表、后端合计同一个函数），币种放 title —— 5% 的列塞不下「CNY 17.50」还看得清。
      accessorFn: (row) => (row.line ? lineAmountText(row.line.quantity, row.line.unitPrice) : "-"),
      cell: ({ row }) => {
        const line = row.original.line;
        if (!line) return "-";
        return <span title={`${line.currency ?? "CNY"} ${lineAmountText(line.quantity, line.unitPrice)}`}>{lineAmountText(line.quantity, line.unitPrice)}</span>;
      },
    },
    { id: "supplier", header: "供应商", meta: { width: COLUMN_WIDTH.supplier, ellipsis: true }, accessorFn: (row) => row.line?.supplierName ?? "-" },
    {
      id: "orderState",
      header: "下单状态",
      meta: { width: COLUMN_WIDTH.orderState, ellipsis: true },
      accessorFn: (row) => (row.line ? (row.line.ordered ? `已下单 ${row.line.purchaseOrderNo ?? ""}`.trim() : "未下单") : "-"),
      // 「这一行落在哪张单」和「有没有买」是同一个问题的两半，合成一格 —— 13 列里没有位置再拆。
      cell: ({ row }) => {
        const line = row.original.line;
        if (!line) return "-";
        if (!line.ordered) return <span className="panel-note">未下单</span>;
        return <span className="status-success" title={`已下单：${line.purchaseOrderNo ?? ""}`}>{line.purchaseOrderNo ?? "已下单"}</span>;
      },
    },
    {
      id: "expectedDate",
      header: "预计到货",
      meta: { width: COLUMN_WIDTH.expectedDate, ellipsis: true },
      accessorFn: (row) => (row.line?.expectedDate ? String(row.line.expectedDate).slice(0, 10) : "-"),
    },
  ], []);

  const candidateField: ActionField = {
    name: "bom_id",
    label: "销售单 / BOM",
    type: "searchable-select",
    required: true,
    placeholder: candidatePlaceholder(candidates.length, blockedCandidates.length),
    options: candidates.map((candidate) => ({
      value: candidate.bomId,
      label: `${candidate.orderNo}${candidate.itemNo ? ` / ${candidate.itemNo}` : ""}${candidate.customerName ? ` / ${candidate.customerName}` : ""}（${candidate.itemCount} 行）`,
    })),
  };

  /**
   * 把被拦下的 BOM 摆进新建弹窗（2026-11-12）。
   *
   * 为什么不另做一个"要建计划的 BOM 清单"页面：用户卡的这一刻就在这个弹窗里，
   * 答案必须出现在同一个地方。字段类型 `info` 是 `ActionDialog` 已有的只读行，不新增控件。
   *
   * 每条一行、最多三条；超出时补一句"还有 N 条"——否则用户会以为被拦的就这三张。
   */
  const blockedReasonFields: ActionField[] = useMemo(() => {
    const { notes, shown, total } = blockedCandidateNotes(blockedCandidates);
    const fields: ActionField[] = notes.map((note, index) => ({ name: `blocked_${index}`, label: note, type: "info" as const }));
    if (total > shown) fields.push({ name: "blocked_more", label: `还有 ${total - shown} 张 BOM 不能建计划（原因同上几类）`, type: "info" as const });
    return fields;
  }, [blockedCandidates]);

  return (
    <div className="page-root purchase-plan-list" data-testid="page-procurement-plans">
      <PageHeader title="采购计划" description="一个销售单的一份 BOM 对应一份计划：逐行填供应商、单价与预计到货，再按供应商收束下单到采购单（一行 = 一条物料，超长悬停看全文）。">
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
          data={flatRows}
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
          fields={[candidateField, ...blockedReasonFields]}
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
