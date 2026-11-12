"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../components/ui/action-dialog";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback/states";
import { DataTable, statusCell } from "../../components/data/data-table";
import { auditColumns, type AuditRow } from "../../components/data/audit-columns";
import { OrderNoWithOrphan } from "../../components/data/orphan-badge";
import type { ColumnDef } from "@tanstack/react-table";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";
import { latestBom, productionCandidateHint, productionCandidates, resolveProductionUnit } from "../../lib/production-candidates";
// 搜索语义全站统一（空格分词的 AND、忽略大小写与空白、空查询不过滤），见 lib/fuzzy-search.ts。
import { fuzzyMatch } from "../../lib/fuzzy-search";
// 状态列经 DataTable 落成中文标签，过滤也必须认这份标签，否则用户照着界面输入「草稿」搜不到。
import { displayText } from "../../lib/display-text";
import { BomWorkbench, type BomMaterialRef } from "../../components/bom/bom-workbench";
import { MaterialCreateDialog } from "../../components/bom/material-create-dialog";
import { PayrollExportPanel } from "../../components/production/payroll-export-panel";
import { notifyError, notifySuccess } from "../../components/ui/toaster";

type Unit = { id: string; name: string; isActive: boolean };
type Location = { id: string; name: string; locationType: "workshop" | "outsource_site"; isActive: boolean };
type Operation = { id: string; operationName: string; defaultUnitId?: string | null; isActive: boolean };
type Order = { id?: string; orderNo: string; quantity: string; unit?: string; status: string; boms: Array<{ id: string; version: number; status: string }> };
type ProductionOrder = AuditRow & { id: string; productionOrderNo: string; orderNo: string; executionMode: "in_house" | "outsourced"; status: string; plannedQuantity: string; /** 所属销售单已被软删（2026-11-03）：生产单不删，只标成「孤立」。 */ orphaned?: boolean; executionLocation: Location; operations: Array<{ id: string; operationCatalogId?: string; sequenceNo?: number; operationNameSnapshot: string; targetQuantity: string; status: string }> };

/**
 * 「BOM表」列表（本页 179 行的**手写** `<table className="data-table">`）的列宽，总和恰好 100%。
 *
 * 手写表拿不到 DataTable 的 `meta`，所以照 globals.css 里 `.table-bounded` 那段注释的三件事办：
 * ①表上加 `table-bounded`（= 拿到固定布局）；②每列显式给宽度（fixed 布局下没给宽度的列会被均分）；
 * ③长文本格自己写 `cell-ellipsis` + `title`（手写表没有 DataTable 那套自动 title）。
 * 三个数的来历：订单号 45% 是唯一的自由文本列（销售单号），给它绝对多数，长单号也只省略尾部；
 * 数量 20% 装「数量 + 单位」拼串；BOM表 35% 装「新建/编辑BOM表」按钮（约 96px）——
 * 按钮列必须有宽度，否则固定布局下它会和文本列一样宽，窄屏时按钮被裁掉。
 */
const BOM_COLUMN_WIDTH = { orderNo: "45%", quantity: "20%", bom: "35%" } as const;

/**
 * 「生产单查找」表（10 列）的声明宽度，**总和 85%**：剩下 15% 留给 `auditColumns()` 产出的
 * 「创建人 / 最后修改人」两列 —— 工厂列不给宽度、用法也不改（`lib/audit-columns-coverage.test.mjs`
 * 有守卫盯着），浏览器把那 15% 均分给它们，约 7.5% 一列（与物料清单页给审计列的 8% 同量级）。
 *
 * 每个数字的来历（估算基准：1366 屏内容宽 1034px）：
 *   - 生产单号 13%（=134px）：装「生产单号」链接按钮，单号本体约 16 字符 ≈ 120px；
 *   - 工序 20%（=207px）：`operations.map(item => item.operationNameSnapshot).join("、")`（145 行）
 *     是全表最长的自由文本，工序一多就是长串。固定布局下它只能在自己的 20% 里省略 + hover 看全文，
 *     把宽度给它，别的列才不会被它挤窄 —— 这正是 Phase B 要解决的比例问题；
 *   - 订单号 10% / 地点 9%：编号与名称型文本，够一屏显示；
 *   - 执行方式 7% / 计划数 7% / 状态 8%：短列（厂内·外加工 / 数字 / 状态词），按 4%~8% 取上沿；
 *   - 操作 11%（=114px）：这一列同时最多渲染 1 个按钮（仅 draft 给「启动」，148 行），
 *     1×44px 远小于 114px，留余量避免按钮折行。
 */
const ORDER_COLUMN_WIDTH = {
  productionOrderNo: "13%",
  orderNo: "10%",
  mode: "7%",
  location: "9%",
  plannedQuantity: "7%",
  operations: "20%",
  status: "8%",
  actions: "11%",
} as const;

export default function ProductionPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [orders, setOrders] = useState<Order[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  // BOM 表：生产也要能按现场情况维护用量（采购与生产共用同一套编辑体验），
  // 因此本页加载物料池，并记下当前正在编辑的 BOM。
  const [materials, setMaterials] = useState<BomMaterialRef[]>([]);
  const [bomWorkbench, setBomWorkbench] = useState<{ id: string; label?: string } | null>(null);
  // BOM 工作区里点「新建物料」时存下它的回填函数。生产现场改 BOM 时经常发现少一个物料，
  // 以前这里不传 onCreateMaterial（按钮不渲染、只能跳到采购去建），2026-09-16 起就地能建。
  const [materialApply, setMaterialApply] = useState<((material: BomMaterialRef) => void) | null>(null);
  const [records, setRecords] = useState<ProductionOrder[]>([]);
  const [query, setQuery] = useState(searchParams.get("order_no") ?? "");
  /**
   * 【BOM表】面板自己的搜索词（2026-11-11，用户：「需要在生产和采购模块的BOM表页面加上搜索功能」）。
   *
   * 为什么不复用上面的 `query`：那个是「生产单查找」的搜索，还被 `?order_no=` 深链预填 ——
   * 两个框各管一张表，共用一个状态就会出现「点了一个深链，BOM 表也只剩一张单」。
   */
  const [bomQuery, setBomQuery] = useState("");
  /**
   * 「新建生产单」对话框里的候选单（`null` = 没搜过，就是全量 `orders`）。
   *
   * 为什么要单独存（2026-11-11 缺陷 A）：以前对话框的搜索把结果写进了 `orders`，
   * 而 `orders` 同时是【BOM表】的数据源 —— 用户在对话框里搜了个单号，关掉后 BOM 表就只剩搜到的那几张。
   * 现在对话框的搜索结果只落在这里，页面主列表保持全量。
   */
  const [dialogCandidates, setDialogCandidates] = useState<Order[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> } | null>(null);
  const orderSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orderSearchRequest = useRef(0);
  const ordersRef = useRef<Order[]>([]);

  async function load() {
    setLoading(true); setError("");
    try {
      const [sales, sites, process, production, unitData, materialData] = await Promise.all([
        apiGet<Order[]>("/sales-orders?status=confirmed&page=1&page_size=200"),
        apiGet<Location[]>("/production/locations"),
        apiGet<Operation[]>("/production/operations"),
        apiGet<ProductionOrder[]>("/production/orders"),
        apiGet<Unit[]>("/units"),
        // 物料池走 ANY(procurement, warehouse, production, sales) 的只读端点，生产角色也拿得到。
        apiGet<BomMaterialRef[]>("/materials").catch(() => ({ data: [] as BomMaterialRef[], meta: {} })),
      ]);
      const nextOrders = sales.data;
      ordersRef.current = nextOrders;
      setOrders(nextOrders);
      setMaterials(materialData.data);
      setLocations(sites.data); setOperations(process.data); setRecords(production.data); setUnits(unitData.data.filter((unit) => unit.isActive));
    } catch (cause) { setError(cause instanceof ApiClientError ? cause.message : "生产数据加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function run(path: string, body: unknown, success: string) {
    setError("");
    try { const result = await apiPost<unknown>(path, body); notifySuccess(success); setMessage(""); await load(); return result.data; }
    catch (cause) { notifyError(cause instanceof ApiClientError ? cause.message : "操作失败"); return undefined; }
  }
  /**
   * 「生产单查找」的过滤（2026-11-11 缺陷 B 修复）。
   *
   * 以前这里是「生产单号 + 订单号 + 状态」三段拼串再 `toLowerCase().includes(...)`：状态取的是
   * **后端英文原值** `draft`，而界面上经 `DataTable` 的 `displayText` 显示成「草稿」——
   * 用户照着屏幕输入「草稿」什么都搜不到，会以为生产单不存在。
   * 现在同时喂入原值与中文标签（`displayText`），英文与中文都能命中；匹配语义换成全站统一的
   * `fuzzyMatch`（空格分词 AND、忽略大小写与空白）。
   * 字段范围仍只有这三列（输入框文案写的就是「生产单、订单号或状态」），不扩张到地点/工序。
   */
  const visible = useMemo(() => records.filter((item) => fuzzyMatch(query, [item.productionOrderNo, item.orderNo, item.status, String(displayText(item.status))])), [records, query]);
  /**
   * 【BOM表】的过滤：只匹配这张表**看得见**的三样东西 —— 订单号、数量、单位。
   * 不匹配 `boms` 之类看不见的字段：搜到了却看不出为什么命中，只会让人以为搜索坏了。
   */
  const bomVisible = useMemo(() => orders.filter((order) => fuzzyMatch(bomQuery, [order.orderNo, order.quantity, order.unit])), [orders, bomQuery]);
  const activeLocations = locations.filter((item) => item.isActive);
  // 候选与提示都从“全部销售单”推导：缺 BOM 的已确认订单必须被解释，而不是从下拉框静默消失。
  //
  // 2026-11-11 缺陷 A 之后两者分开口径：
  //   - `candidateHint`（页面上那句「有 N 张已确认销售单尚未建立 BOM」）**只认全量 `orders`**：
  //     它是页面级的解释，不该跟着对话框里的一次搜索变；
  //   - `candidates` 只喂「新建生产单」的下拉，所以优先用对话框自己那份搜索结果
  //     （`dialogCandidates`，null = 没搜过 → 回落到全量 `orders`）。
  const candidates = useMemo(() => productionCandidates(dialogCandidates ?? orders), [dialogCandidates, orders]);
  const candidateHint = useMemo(() => productionCandidateHint(orders), [orders]);
  const orderOptions = candidates.map((item) => ({ value: item.orderNo, label: `${item.orderNo} / ${item.quantity}${item.unit ? ` ${item.unit}` : ""}` }));

  /**
   * 「新建生产单」对话框里订单下拉的服务端搜索（250ms 防抖）。
   *
   * ⚠️ 结果只写进 `dialogCandidates`（对话框自己那份候选）+ `ordersRef`（提交时靠它找 source），
   * **绝不写 `orders`**（2026-11-11 缺陷 A）：`orders` 同时是【BOM表】的数据源，
   * 以前在这里 `setOrders(result.data)`，用户只是在对话框里搜了个单号，
   * 关掉对话框后 BOM 表就只剩被搜到的那几张单。
   */
  function searchSalesOrders(search: string) {
    if (orderSearchTimer.current) clearTimeout(orderSearchTimer.current);
    const requestId = ++orderSearchRequest.current;
    orderSearchTimer.current = setTimeout(() => {
      void apiGet<Order[]>(`/sales-orders?status=confirmed&page=1&page_size=200&search=${encodeURIComponent(search)}`).then((result) => {
        if (requestId === orderSearchRequest.current) {
          ordersRef.current = result.data;
          setDialogCandidates(result.data);
          setDialog((current) => current ? { ...current, fields: current.fields.map((field) => field.name === "order_no" ? { ...field, options: productionCandidates(result.data).map((item) => ({ value: item.orderNo, label: `${item.orderNo} / ${item.quantity}${item.unit ? ` ${item.unit}` : ""}` })) } : field) } : current);
        }
      }).catch((cause) => { if (requestId === orderSearchRequest.current) notifyError(cause instanceof ApiClientError ? cause.message : "订单搜索失败"); });
    }, 250);
  }

  async function openProductionOrder() {
    let candidateOrders = orders;
    try {
      const fresh = await apiGet<Order[]>("/sales-orders?status=confirmed&page=1&page_size=200");
      candidateOrders = fresh.data;
      ordersRef.current = candidateOrders;
      // 打开对话框时重新拉到的「最新候选」也只交给对话框（缺陷 A）：页面主列表与 BOM 表用挂载时那份，
      // 两处各自刷新，谁也不该因为对面拉了一次数据而变小。
      setDialogCandidates(candidateOrders);
    } catch (cause) {
      notifyError(cause instanceof ApiClientError ? cause.message : "订单候选加载失败");
    }
    const options = productionCandidates(candidateOrders).map((item) => ({ value: item.orderNo, label: `${item.orderNo} / ${item.quantity}${item.unit ? ` ${item.unit}` : ""}` }));
    setDialog({ title: "新建生产单", fields: [
      { name: "order_no", label: "订单号", type: "searchable-select", required: true, onSearch: searchSalesOrders, placeholder: options.length ? "请选择订单" : "暂无可建生产单的销售单", options },
      { name: "execution_mode", label: "执行方式", type: "select", required: true, defaultValue: "in_house", options: [{ value: "in_house", label: "厂内生产" }, { value: "outsourced", label: "外加工" }] },
      { name: "execution_location_id", label: "执行地点", type: "select", required: true, options: activeLocations.map((item) => ({ value: item.id, label: `${item.name} / ${item.locationType === "workshop" ? "厂内" : "外加工"}` })) },
    ], submit: (values) => {
      const source = productionCandidates(ordersRef.current).find((item) => item.orderNo === values.order_no); const bom = source ? latestBom(source.boms) : undefined;
      if (!source || !bom) { setError("请选择已确认且已建 BOM 的销售单；缺少 BOM 的订单请先在本页【BOM表】或【采购 → BOM表】建立 BOM。"); return; }
      const unitId = resolveProductionUnit(source.unit, units, operations);
      if (!unitId) { setError(`无法确定订单 ${source.orderNo} 的生产单位：请先在【采购】物料清单的单位中选择「打 / 个 / 码」等单位，或为工序设置默认单位。`); return; }
      void run("/production/orders", { order_no: source.orderNo, bom_id: bom.id, bom_version: bom.version, execution_mode: values.execution_mode, execution_location_id: values.execution_location_id, planned_quantity: source.quantity, unit_id: unitId }, "生产单草稿已创建");
    },
    });
  }

  // BOM 表由采购与生产共同维护：这里提供与【采购 → BOM表】一致的入口（新建 / 编辑）。
  // 冲突处理交给共享组件 BomWorkbench（乐观锁：采购先改过就提示重新加载，绝不静默覆盖）。
  function openBom(id: string, label?: string) { setError(""); setBomWorkbench({ id, label }); }
  async function createOrOpenBom(order: Order) {
    const existing = latestBom(order.boms);
    if (existing) { openBom(existing.id, order.orderNo); return; }
    if (!order.id) { setError("无法确认该销售单的内部编号，请刷新页面后重试"); return; }
    setError("");
    try {
      const result = await apiPost<{ id: string }>(`/boms/from-sales-order/${order.id}`, { extension_data: {} });
      notifySuccess("BOM表已创建");
      await load();
      openBom(result.data.id, order.orderNo);
    } catch (cause) { notifyError(cause instanceof ApiClientError ? cause.message : "BOM表创建失败"); }
  }

  const columns: ColumnDef<ProductionOrder>[] = [
    { accessorKey: "productionOrderNo", header: "生产单号", meta: { width: ORDER_COLUMN_WIDTH.productionOrderNo }, cell: ({ row }) => <Button variant="link" onClick={() => router.push(`/production/orders/${row.original.id}`)}>{row.original.productionOrderNo}</Button> },
    // 订单号旁可能跟着「孤立」徽章：销售单被删后生产单仍在，得让人看出它已经没有在途的销售单了。
    { accessorKey: "orderNo", header: "订单号", meta: { width: ORDER_COLUMN_WIDTH.orderNo }, cell: ({ row }) => <OrderNoWithOrphan orderNo={row.original.orderNo} orphaned={row.original.orphaned} /> },
    { id: "mode", header: "执行方式", meta: { width: ORDER_COLUMN_WIDTH.mode }, cell: ({ row }) => row.original.executionMode === "in_house" ? "厂内" : "外加工" },
    { id: "location", header: "地点", meta: { width: ORDER_COLUMN_WIDTH.location }, cell: ({ row }) => row.original.executionLocation?.name ?? "-" },
    { accessorKey: "plannedQuantity", header: "计划数", meta: { width: ORDER_COLUMN_WIDTH.plannedQuantity } },
    // 「工序」是 `id` + 自定义 `cell`（没有 accessor 可回退）：省略号能出现，但 DataTable 只能从
    // **渲染结果**取 title —— 这里返回的就是字符串，所以 hover 拿得到全文，不必自写 title。
    { id: "operations", header: "工序", meta: { width: ORDER_COLUMN_WIDTH.operations }, cell: ({ row }) => row.original.operations.map((item) => item.operationNameSnapshot).join("、") || "未配置" },
    { accessorKey: "status", header: "状态", meta: { width: ORDER_COLUMN_WIDTH.status }, cell: statusCell<ProductionOrder>() },
    ...auditColumns<ProductionOrder>(),
    { id: "actions", header: "操作", meta: { width: ORDER_COLUMN_WIDTH.actions }, cell: ({ row }) => row.original.status === "draft" ? <Button size="sm" variant="secondary" onClick={() => void run(`/production/orders/${row.original.id}/transition`, { target: "in_progress", reason: "开始生产" }, "生产单已启动")}>启动</Button> : null },
  ];

  // 基础资料加载完成前禁止打开建单对话框：openProductionOrder() 用当时的 activeLocations 构造选项，
  // 数据到达后 dialog.fields 不会重建，会留下**永久为空**的「执行地点」下拉
  // （见 docs/test/results/2026-09-13-e2e-rewrite-and-platform-unit-expansion.md §7.3）。
  return <div className="page-root" data-testid="page-production">
    <PageHeader title="生产"><Button onClick={() => void openProductionOrder()} disabled={loading} data-testid="production-create-order">新建生产单</Button></PageHeader>
    {/* 关窗时把对话框那份候选一起清掉（2026-11-11 缺陷 A）：下次打开由 openProductionOrder()
        重新拉最新候选，留着上一次的搜索结果只会让人以为「候选变少了」。 */}
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) { setDialog(null); setDialogCandidates(null); } }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { dialog?.submit(values); setDialog(null); }} />
    {/* BOM 工作区放在加载分支之外：保存后刷新列表时它不会被卸载，用户的编辑不会被吞掉。 */}
    {/* 生产侧**不显示**「默认供应商」列（2026-09-27，用户：「生产模块里面的 BOM 表里面不用填写供应商」）：
        那一列是采购的知识（这个部件通常找哪家做）。数据没有被清掉 —— 保存时行上的值照旧回传，
        所以生产保存 BOM 不会抹掉采购标过的供应商。 */}
    {bomWorkbench && <BomWorkbench bomId={bomWorkbench.id} title={bomWorkbench.label} materials={materials} units={units} showSupplier={false} showReferencePrice={false} onCreateMaterial={(apply) => setMaterialApply(() => apply)} onClose={() => setBomWorkbench(null)} onSaved={() => void load()} />}
    <MaterialCreateDialog
      open={Boolean(materialApply)}
      units={units}
      onOpenChange={(open) => { if (!open) setMaterialApply(null); }}
      onUnitCreated={(unit) => setUnits((items) => [...items, { id: unit.id, name: unit.name ?? unit.id, isActive: unit.isActive !== false }])}
      onCreated={(material) => {
        // 新物料先进物料池：BOM 行的物料下拉靠 options 渲染名字，只填 id 会让那一格变空白。
        setMaterials((items) => [...items.filter((item) => item.id !== material.id), material]);
        materialApply?.(material);
        setMaterialApply(null);
      }}
    />
    {message && <section className="panel panel-body status-success">{message}</section>}
    {!loading && candidateHint && <section className="panel panel-body panel-note" role="status">{candidateHint}</section>}
    {error ? <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section> : loading ? <LoadingState /> : <>
      <section className="panel" data-testid="production-bom-panel">
        <div className="panel-heading">
          <h2>BOM表</h2>
          {/* 计数只在有数据时出现（2026-11-11）：空态本身就是一句解释，再挂一个「共 0 张」只是噪音。 */}
          {orders.length > 0 && <span className="panel-note" data-testid="production-bom-count">共 {orders.length} 张确认单，当前列出 {bomVisible.length} 张</span>}
        </div>
        <div className="panel-body">
          <p className="panel-note">BOM 由采购与生产共同维护，两个入口改的是同一张表。保存时会校验版本：若采购已先改过，会提示你重新加载，而不是把对方的修改覆盖掉。</p>
          {!orders.length ? <EmptyState title="暂无已确认销售单" description="建立并确认销售单后，即可在这里为其建立 BOM 表。" /> : <>
            {/*
              本面板自己的搜索框（2026-11-11）。两个细节是刻意的：
              · 状态与「生产单查找」那个 `query` 完全分开（那个被 `?order_no=` 深链预填）；
              · placeholder 也刻意不同名（那边是「输入关键词」）—— 撞名会让用户分不清在搜哪张表，
                渲染测试里 `getByPlaceholderText` 也会因为匹配到 2 个直接报错。
            */}
            <div className="filter-bar"><label>搜索订单号或数量<Input data-testid="production-bom-search" value={bomQuery} onChange={(event) => setBomQuery(event.target.value)} placeholder="输入订单号或数量" /></label></div>
            {!bomVisible.length
              // 有数据但搜不到：说清「是没匹配上，不是没有单」，并把总数留在眼前。
              ? <EmptyState title={`没有匹配“${bomQuery.trim()}”的订单`} description={`共 ${orders.length} 张确认单，换个关键词或清空搜索框。`} />
              : <div className="table-wrap"><table className="data-table table-bounded"><thead><tr><th style={{ width: BOM_COLUMN_WIDTH.orderNo }}>订单号</th><th style={{ width: BOM_COLUMN_WIDTH.quantity }}>数量</th><th style={{ width: BOM_COLUMN_WIDTH.bom }}>BOM表</th></tr></thead><tbody>{bomVisible.map((order) => { const bom = latestBom(order.boms); return <tr key={order.orderNo}><td className="cell-ellipsis" title={order.orderNo}>{order.orderNo}</td><td className="cell-ellipsis" title={`${order.quantity}${order.unit ? ` ${order.unit}` : ""}`}>{order.quantity}{order.unit ? ` ${order.unit}` : ""}</td><td><Button size="sm" variant="secondary" data-testid={`production-bom-${order.orderNo}`} onClick={() => void createOrOpenBom(order)}>{bom ? "编辑BOM表" : "新建BOM表"}</Button></td></tr>; })}</tbody></table></div>}
          </>}
        </div>
      </section>
      <section className="panel"><div className="panel-heading"><h2>生产单查找</h2></div><div className="panel-body"><div className="filter-bar"><label>搜索生产单、订单号或状态<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词" /></label></div><div data-testid="production-order-table"><DataTable columns={columns} data={visible} empty={<EmptyState title="暂无生产单" />} /></div></div></section>
      <section className="panel"><div className="panel-heading"><h2>生产基础资料</h2></div><div className="panel-body"><div className="page-actions"><Button asChild variant="secondary"><Link href="/production/operations" data-testid="production-add-operation">工序池（{operations.filter((item) => item.isActive).length} 个启用）</Link></Button><Button asChild variant="secondary"><Link href="/production/locations" data-testid="production-add-location">加工地点池（{activeLocations.length} 个启用）</Link></Button><Button asChild variant="secondary"><Link href="/production/units">单位池（{units.length} 个启用）</Link></Button><Button asChild variant="secondary"><Link href="/production/material-issues">领料/补料单（按工序）</Link></Button></div></div></section>
      <PayrollExportPanel orders={records} operations={operations} />
    </>}
  </div>;
}
