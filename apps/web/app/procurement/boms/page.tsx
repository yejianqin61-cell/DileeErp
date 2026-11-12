"use client";

import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { DataTable } from "../../../components/data/data-table";
import { auditColumns, type AuditRow } from "../../../components/data/audit-columns";
import { OrderNoWithOrphan } from "../../../components/data/orphan-badge";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiDelete, apiGet, apiPost } from "../../../lib/api-client";
import { BomWorkbench, type BomMaterialRef } from "../../../components/bom/bom-workbench";
import { MaterialCreateDialog } from "../../../components/bom/material-create-dialog";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";
import { fuzzyMatch } from "../../../lib/fuzzy-search";
import { displayText } from "../../../lib/display-text";

type Reference = AuditRow & { id: string; orderNo?: string; status?: string; salesOrderId?: string; /** 所属销售单已被软删（2026-11-03）：BOM 不删，只标成「孤立」。判定只认后端字段。 */ orphaned?: boolean; /** 孤立 BOM 行（2026-11-05）：行 id 被换成 salesOrderId，真实 BOM id 留在这里 —— 删除入口只能拿它当目标。 */ bom_id?: string; name?: string; materialCode?: string; supplierCode?: string; code?: string; isActive?: boolean; defaultUnitId?: string };
// 物料池：规格型号与颜色要一起带上 —— BOM 行选择/新建物料时会引用它们做初始值。
type Material = { id: string; materialCode?: string; code?: string; name?: string; specificationModel?: string | null; color?: string | null; materialType?: string; defaultUnitId?: string; isActive?: boolean };
type Unit = { id: string; name?: string; isActive?: boolean };

/**
 * `GET /boms/:id/delete-preview` 的形状（契约见 docs/design/bom-delete-and-empty-shell-release-2026-11-05.md §4.1）。
 * 可删性、要不要填原因都由服务端给（真删时用同一份「下游事实」重算），前端**不自己再数一遍** ——
 * 两边口径一旦分叉，就会出现「弹窗说能删、DELETE 却被拒」或者绕过审计原因。
 */
type BomDeletePreview = {
  bom_id: string; order_no: string; version?: number; status?: string;
  item_count: number;
  purchase_plan: { id: string; plan_no: string; ordered_line_count?: number } | null;
  purchase_order_count: number;
  production_order_count: number;
  deletable: boolean;
  blocked_reason: string | null;
  reason_required: boolean;
};

/** 删除确认框：与销售单列表同一套 `ActionDialog` 用法（onSubmit 抛错 → 留在弹窗里显示服务端原因）。 */
type BomDeleteDialog = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

/**
 * 一行**能搜到什么**（2026-11-11，用户：「需要在生产和采购模块的BOM表页面加上搜索功能」）。
 *
 * 口径：只搜这张表**看得见的字** —— 订单号、BOM 状态、以及孤立行上那个「孤立」徽章。
 * 为什么不到后面几列去捞（客户名、版本号、创建人 UUID）：搜出来一行，屏幕上却看不见是哪一段
 * 命中的，用户会以为搜索坏了（此处踩过的相邻坑：2026-10-13 那张「只有 20 张单」的空页）。
 *
 * 状态为什么给两份：单元格里 `DataTable` 会用 `displayText` 把 `draft` 显示成「草稿」
 * （`components/data/data-table.tsx` 的 `text()`），用户是照着「草稿」去搜的 ——
 * 只认后端原值，就等于让人搜不到自己刚看见的那两个字（生产页「生产单查找」的 KNOWN_DEFECT 就是这个形态，
 * 同一天一并修掉）。原值也留着：接口文档、导出件里写的是 `draft`。
 */
const searchableFieldsOf = (row: Reference): Array<string | undefined> => [
  row.orderNo,
  row.status,
  row.status ? String(displayText(row.status)) : undefined,
  row.orphaned ? "孤立" : undefined,
];

/**
 * BOM 表列表的列宽（2026-10-09：`DataTable` 一律 `table-layout: fixed`，没写宽度的列由浏览器**均分**，
 * 这里把「均分」换成「按内容需要分配」）。
 *
 * 口径同 `app/procurement/inbounds/page.tsx`，两个常数先记住：
 *   - 可用宽度基线 **1034px**（1366 视口减侧栏后的实测表宽）；
 *   - `.ui-table-cell` 左右各 12px 内边距 → 一列定 n% 后真正能放字的宽度是 `n% × 1034 - 24`
 *     （8% → 58.7px，与 `components/data/audit-columns.tsx:44` 记的实测值一致）。
 *
 * 本表 5 列 = 3 列业务列（订单号 / BOM状态 / BOM表）+ `auditColumns()` 的「创建人 / 最后修改人」。
 * 后两列**刻意不给宽度、也不改工厂用法**（`lib/audit-columns-coverage.test.mjs` 有守卫），
 * 所以下面 3 个数字的总和必须是 **84%**，剩下 16% 由那两列均分（各 8% = 58.7px）。
 *
 * 这张表行数少、列也少（只有 3 列要配），所以策略与其它页相反：订单号这种长文本列
 * **按内容需要给足**，而不是被预算压到 8% 下限 —— 剩下的都给「BOM表」按钮列。
 */
const COLUMN_WIDTH = {
  // 订单号：`SO-20261009-0001` 一行 16 字符 ≈ 110px（需求 10.6%），取 30%（= 310px）——
  // 按内容需要一次放全，不用 hover（这张表只有 3 列要分 84%，给得起）。
  orderNo: "30%",
  // BOM状态：`草稿 / 已确认` 一类短枚举（最长 3 汉字 ≈ 36px = 3.5%），短状态 4%~6% 取 12% ——
  // 6% 是规则上限，但这里没有别处更需要空间（订单号与按钮列都已按内容给足），
  // 多出来的量留在状态列不会撑坏版式，只让这一格更宽松。
  status: "12%",
  // BOM表：`编辑BOM表 / 新建BOM表`（5 汉字）+ 有 BOM 时多一个「删除」（2 汉字，2026-11-05）。
  // `.ui-button-sm`（padding 0 10px、font-size 12px）下 5 汉字按钮 ≈ 80px、2 汉字 ≈ 44px，
  // 加间距与本格 24px 内边距 = 152px → 14.7%，规则下限 8% 已满足；剩下的预算给到 42%（= 434px）。
  // 两个按钮交给 `.action-row`（`globals.css:134`，`flex-wrap: wrap`）：42% 足够并排；
  // 万一文案变长也不会被裁，只会折到第二行（本表行数少，折行不影响阅读）。
  bom: "42%",
} as const;

export default function BomsPage() {
  const [boms, setBoms] = useState<Reference[]>([]);
  const [salesOrders, setSalesOrders] = useState<Reference[]>([]);
  /** 空列表时问出来的草稿单张数（`null` = 没问/问不到）：只用来写空状态里那句解释。 */
  const [draftCount, setDraftCount] = useState<number | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bomWorkbench, setBomWorkbench] = useState<{ id: string; label?: string } | null>(null);
  // BOM 工作区请求开的「新建物料」弹窗：存下它给的回填函数，物料建好就填回当前行。
  // （2026-09-16 之前这里是空函数：按钮在，点了没反应 —— 用户反馈「新建物料按钮怎么不见了」。）
  const [materialApply, setMaterialApply] = useState<((material: BomMaterialRef) => void) | null>(null);
  /** 正在读「删除影响面」的那一行：读接口回来之前按钮不能连点（否则会弹两次确认框）。 */
  const [deletingId, setDeletingId] = useState("");
  const [deleteDialog, setDeleteDialog] = useState<BomDeleteDialog | null>(null);
  /**
   * 搜索框（2026-11-11）。**客户端过滤**、不等服务端：这一页一次就把已确认销售单全取回来了
   * （`page_size=200`，生产实况：未删销售单 55 张，其中已确认 54 张），逐字过滤才是用户要的即时感；
   * 多打一个 `?search=` 请求还会在「输入一个字符」和「列表内容」之间引入竞态。
   * 代价写在当天的设计文档里：超过 200 张已确认单时，第 201 张往后的单本来就取不回来 ——
   * 那是这一页**既有的**取数上限，不是搜索带来的，计数条已经把「加载了多少条」摆在用户眼前。
   */
  const [query, setQuery] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [bs, so, ms, us] = await Promise.all([
        apiGet<Reference[]>("/boms"),
        /**
         * 销售单：**服务端按「已确认」筛、一次取 200 张**（2026-10-13 修）。
         *
         * 用户原话：「采购模块，BOM表，没有新建 BOM 表的地方。只要有销售单事实的单子，就要允许
         * 也在采购中创建保存编辑 BOM 表。」
         *
         * 根因就是这一行：原来取的是 `/sales-orders`（**不带状态、默认只取最近 20 张**），
         * 再在页面上按 `status === "confirmed"` 过滤 —— 订单一多、或者最近动过的单恰好都是草稿，
         * 这一页就**整页空**（"暂无已确认销售单"），于是连「新建BOM表」按钮都看不到，
         * 更早的已确认单也永远轮不到。生产页的 BOM 入口一直是
         * `/sales-orders?status=confirmed&page=1&page_size=200`，两处现在一致。
         */
        apiGet<Reference[]>("/sales-orders?status=confirmed&page=1&page_size=200"),
        apiGet<Material[]>("/materials"),
        apiGet<Unit[]>("/units"),
      ]);
      setBoms(bs.data);
      setSalesOrders(so.data);
      setMaterials(ms.data);
      setUnits(us.data);
    } catch (cause) {
      setError(messageOf(cause, "BOM数据加载失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  /**
   * 一张已确认销售单都没有时，问一句"是不是还有草稿单"（**只在空列表时**打这一次请求）。
   *
   * 为什么值得单独问：BOM 只能建在**已确认**销售单上，而"为什么这一页是空的"对用户是个谜 ——
   * 说清"你还有 N 张草稿没确认"比一句"暂无已确认销售单"有用得多（2026-09-16 的
   * 「新建物料按钮怎么不见了」就是同一类"按钮/表空着但不说原因"的坑）。
   * 它**不在上面那个 `Promise.all` 里**：一是失败不影响主数据，二是那个位置型解构有守卫盯着。
   */
  useEffect(() => {
    if (loading || salesOrders.length) { setDraftCount(null); return; }
    let cancelled = false;
    void apiGet<Reference[]>("/sales-orders?status=draft&page=1&page_size=1")
      .then((result) => { if (!cancelled) setDraftCount(Number(result.meta?.total ?? 0) || 0); })
      .catch(() => { if (!cancelled) setDraftCount(null); });
    return () => { cancelled = true; };
  }, [loading, salesOrders.length]);

  function openBom(id: string, label?: string) {
    setError("");
    setBomWorkbench({ id, label });
  }

  async function createOrOpenBom(order: Reference) {
    const existing = boms.find((b) => b.salesOrderId === order.id);
    if (existing) {
      openBom(existing.id, order.orderNo);
      return;
    }
    setError("");
    try {
      const result = await apiPost<Reference>(`/boms/from-sales-order/${order.id}`, { extension_data: {} });
      setBoms((items) => [...items, result.data]);
      notifySuccess("BOM表已创建");
      openBom(result.data.id, order.orderNo);
    } catch (cause) {
      notifyError(messageOf(cause, "BOM表创建失败"));
    }
  }

  /**
   * 这一行**真实**的 BOM id。
   *
   * ⚠️ 不能拿行的 `id` 当删除目标：孤立 BOM 行的行 id 被换成了 `salesOrderId`（见下方 bomRows 注释），
   * 拿它去 `/boms/:id` 会打到一个不存在的 BOM 上。孤立行把真实 id 存在 `bom_id` 里；
   * 在册行用 salesOrderId 从 `/boms` 结果里找回（与 `createOrOpenBom` 找回既有 BOM 同一口径）。
   */
  function bomIdOf(row: Reference): string | undefined {
    if (row.bom_id) return row.bom_id;
    return boms.find((bom) => bom.salesOrderId === row.id)?.id;
  }

  /**
   * 删除 BOM 表（2026-11-05，用户：「想修改销售单，但销售单显示 BOM 表已经建立、其实里面没填内容，
   * 可不可以增加一个 BOM 表的删除键」）。
   *
   * 删除是销毁一张表，**必须先读影响面再弹确认框**（`GET /boms/:id/delete-preview`）：
   *   - 空壳 BOM（0 明细、无采购计划、无采购单/生产单）：预览说 `reason_required=false`，
   *     确认框里**不出现原因框**，点「确认删除」就完事 —— 用户要解决的正是这一种；
   *   - 有明细 / 有采购计划：`reason_required=true`，必须填原因（删掉的是有人录过的内容，要进审计）；
   *   - 被未取消采购单 / 未删除生产单引用：`deletable=false`，**不弹窗**，直接把服务端给的
   *     `blocked_reason`（「先回退下游」）作为错误提示 —— 已经采购/投产的事实不能靠删源撤销。
   *
   * 预览失败（网络/权限）不弹窗、只 toast：连影响面都读不到时不该让用户按下「确认删除」。
   */
  async function deleteBom(row: Reference) {
    const bomId = bomIdOf(row);
    if (!bomId) return;
    setDeletingId(row.id);
    try {
      const preview = (await apiGet<BomDeletePreview>(`/boms/${bomId}/delete-preview`)).data;
      if (!preview.deletable) {
        notifyError(preview.blocked_reason ?? "这张 BOM 不能删除");
        return;
      }
      const fields: ActionField[] = [
        { name: "effect", type: "info", label: "删除后这张 BOM 表和它的明细会一起消失（软删除，审计可追溯）；销售单不再被它挡住，可以继续修改。" },
        { name: "facts", type: "info", label: `明细 ${preview.item_count} 行；采购单 ${preview.purchase_order_count} 张；生产单 ${preview.production_order_count} 张。` },
        preview.purchase_plan
          ? { name: "plan", type: "info", label: `采购计划 ${preview.purchase_plan.plan_no} 会独立保留（不随 BOM 删除），其中已下单 ${preview.purchase_plan.ordered_line_count ?? 0} 行。` }
          : { name: "plan", type: "info", label: "这张 BOM 没有采购计划。" },
      ];
      if (preview.reason_required) fields.push({ name: "reason", label: "删除原因（必填，会记进审计）", type: "textarea", required: true, placeholder: "例如：BOM 建错单 / 选错销售单，需重新建一张" });
      setDeleteDialog({
        title: `删除 BOM 表：${preview.order_no}`,
        fields,
        // 必须把 Promise 交回 ActionDialog：它靠 onSubmit 抛错决定「保持弹窗 + 显示服务端原因」，
        // 被 void 吞掉就会关窗，用户填的原因与服务端拒绝理由一起丢（销售单删除踩过同一个坑）。
        submit: async (values) => { await performDeleteBom(bomId, values.reason?.trim() || undefined); },
      });
    } catch (cause) {
      notifyError(messageOf(cause, "读取删除影响失败，请稍后重试"));
    } finally {
      setDeletingId("");
    }
  }

  /** 真正发 DELETE 并统一「toast + 重新拉列表」；成功文案说清用户最关心的一句：销售单现在能改了。 */
  async function performDeleteBom(bomId: string, reason?: string) {
    await apiDelete(`/boms/${bomId}`, reason ? { reason } : undefined);
    notifySuccess("BOM 表已删除，销售单现在可以修改了");
    await load();
  }

  /**
   * 这一页的列表由两段拼成，都是「一张销售单 + 它的 BOM」这一行形状：
   *
   * ① 在册的**已确认**销售单（`/sales-orders?status=confirmed`）：BOM 是"要按这张单买料/投产"的清单，
   *    草稿单随时会被改，拿它建 BOM 等于给一份会变的单子承诺物料。
   *    ⚠️ 过滤已经交给服务端 —— **不要**在这里再过滤一次：那正是 2026-10-13 那个缺陷的形态
   *    （前端拿到最近 20 张任意状态的单再过滤 → 整页空）。
   *
   * ② 孤立的 BOM（2026-11-03）：父销售单被软删后，BOM 行仍在 `/boms` 里（`deleted_at` 为空），
   *    但那张销售单已经不在 `/sales-orders` 列表里了。不把 `/boms` 里 `orphaned` 的行补进来，
   *    这些 BOM 就**既看不见也打不开**（它们是删单后留下的单据里排在最前面的一类）。
   *    `id` 换成 salesOrderId：`createOrOpenBom` 靠它找回既有 BOM，与在册行同一口径；
   *    同一张销售单可能有多版 BOM，按 salesOrderId 去重、保留 /boms 给出的第一行（version desc）。
   */
  const bomRows: Reference[] = [...salesOrders];
  const shownSalesOrderIds = new Set(salesOrders.map((order) => order.id));
  for (const bom of boms) {
    const salesOrderId = bom.salesOrderId;
    if (!bom.orphaned || !salesOrderId || shownSalesOrderIds.has(salesOrderId)) continue;
    shownSalesOrderIds.add(salesOrderId);
    // 额外保留真实 BOM id（`bom_id`）：行 id 被换成了 salesOrderId，删除入口只能认这一份（2026-11-05）。
    bomRows.push({ ...bom, bom_id: bom.id, id: salesOrderId, orderNo: bom.orderNo ?? "-" });
  }
  const bomEmptyHint = draftCount
    ? `还有 ${draftCount} 张销售单是草稿：BOM 只能建在**已确认**的销售单上 —— 请先到【销售】确认，再回这里点「新建BOM表」。`
    : "建立并确认销售单后，即可在这里为其建立 BOM 表。";
  /**
   * 搜索命中的行（2026-11-11）。空查询（或只有空白）时直接返回原数组：
   * 一是不必逐行跑一遍匹配，二是「清空搜索框 = 回到全量」这件事只靠一行 `if` 就成立。
   */
  const filteredBomRows = query.trim() ? bomRows.filter((row) => fuzzyMatch(query, searchableFieldsOf(row))) : bomRows;

  const columns: ColumnDef<Reference>[] = [
    // 订单号旁可能跟着「孤立」徽章：销售单被删后 BOM 仍在，得让人看出它已经没有在途的销售单了。
    { id: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.orderNo }, accessorFn: (row) => row.orderNo ?? "-", cell: ({ row }) => <OrderNoWithOrphan orderNo={row.original.orderNo ?? "-"} orphaned={row.original.orphaned} /> },
    { accessorKey: "status", header: "BOM状态", meta: { width: COLUMN_WIDTH.status } },
    ...auditColumns<Reference>(),
    {
      id: "bom", header: "BOM表", meta: { width: COLUMN_WIDTH.bom },
      cell: ({ row }) => {
        const bomId = bomIdOf(row.original);
        const busy = deletingId === row.original.id;
        return (
          <div className="action-row">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void createOrOpenBom(row.original)}>{bomId ? "编辑BOM表" : "新建BOM表"}</Button>
            {/* 删除入口只在这行**已有 BOM** 时出现（没有 BOM 就没什么可删），且是「先在确认框里看清影响面再删」。 */}
            {bomId && <Button size="sm" variant="destructive" data-testid={`bom-delete-${row.original.orderNo ?? row.original.id}`} disabled={busy} onClick={() => void deleteBom(row.original)}>{busy ? "读取影响…" : "删除"}</Button>}
          </div>
        );
      },
    },
  ];

  if (loading) return <><PageHeader title="BOM表" breadcrumb={["采购", "BOM表"]} /><LoadingState /></>;
  if (bomWorkbench) {
    return (
      <div className="page-root" data-testid="page-procurement-boms">
        <PageHeader title="BOM表" breadcrumb={["采购", "BOM表"]} />
        <BomWorkbench
          bomId={bomWorkbench.id}
          title={bomWorkbench.label}
          materials={materials}
          units={units}
          onCreateMaterial={(apply) => setMaterialApply(() => apply)}
          onClose={() => setBomWorkbench(null)}
          onSaved={() => void load()}
        />
        <MaterialCreateDialog
          open={Boolean(materialApply)}
          units={units}
          onOpenChange={(open) => { if (!open) setMaterialApply(null); }}
          onUnitCreated={(unit) => setUnits((items) => [...items, unit])}
          onCreated={(material) => {
            // 新物料必须先进物料池：BOM 行里的物料下拉是靠 options 渲染出名字的，
            // 只把 id 填进行里会让那一格变成空白。
            setMaterials((items) => [...items.filter((item) => item.id !== material.id), material]);
            materialApply?.(material);
            setMaterialApply(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="page-root" data-testid="page-procurement-boms">
      <PageHeader title="BOM表" breadcrumb={["采购", "BOM表"]}>
        <div className="page-actions">
          <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        </div>
      </PageHeader>
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <section className="panel">
        {/*
          BOM 表列表（2026-11-11 加搜索，用户：「需要在生产和采购模块的BOM表页面加上搜索功能」）。
          搜索框放在 `.filter-bar` 里、并配一条「共 N 条，当前列出 M 条」的计数 ——
          全站搜索框都是这个形状（物料清单 / 供应商池 / 客户池…），用户不必为同一件事学两种布局；
          计数则是**过滤掉了多少**的唯一可见证据（表里只剩两行时，用户得知道是筛掉了、不是数据没了）。
        */}
        <div className="panel-heading">
          <h2>BOM表</h2>
          {/* 有行才显示计数（与生产页【BOM表】同一口径）：一行都没有时，空态本身已经把原因说完了。 */}
          {bomRows.length > 0 && <span className="panel-note" data-testid="bom-count">共 {bomRows.length} 条，当前列出 {filteredBomRows.length} 条</span>}
        </div>
        <div className="panel-body">
          {/* 一行数据都没有时不渲染搜索框（与生产页【BOM表】同一口径）：没有东西可筛，
              这时该看的是下面那句「为什么一页是空的」（还有 N 张草稿 / 先确认销售单）。 */}
          {bomRows.length > 0 && <div className="filter-bar">
            <label>搜索订单号或 BOM 状态<Input data-testid="bom-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词，空格分隔多个词" /></label>
          </div>}
          <DataTable
            columns={columns}
            data={filteredBomRows}
            empty={query.trim()
              // 搜索无匹配和「真的没有数据」是两件事：前者要让人知道是关键词的问题（并给出总数），
              // 后者原来那句「暂无已确认销售单 + 还有 N 张草稿」仍然最有用，不能被子句顶掉。
              ? <EmptyState title={`没有匹配“${query.trim()}”的 BOM 表`} description={`共 ${bomRows.length} 条，换个关键词或清空搜索框。`} />
              : <EmptyState title="暂无已确认销售单" description={bomEmptyHint} />}
          />
        </div>
      </section>
      {/*
        删除确认框（2026-11-05）：信息行 + 需要时的必填原因。放在页面级、不放进表格单元格 ——
        Radix Dialog 的 portal 与行重渲染都不该影响它；`submit` 抛错时 ActionDialog 会留在弹窗里
        显示服务端原因（422 BOM_HAS_DOWNSTREAM / BOM_DELETE_REASON_REQUIRED），用户填的原因不丢。
      */}
      <ActionDialog
        open={Boolean(deleteDialog)}
        onOpenChange={(open) => { if (!open) setDeleteDialog(null); }}
        title={deleteDialog?.title ?? "删除 BOM 表"}
        fields={deleteDialog?.fields ?? []}
        submitLabel="确认删除"
        onSubmit={async (values) => { await deleteDialog?.submit(values); setDeleteDialog(null); }}
      />
    </div>
  );
}
