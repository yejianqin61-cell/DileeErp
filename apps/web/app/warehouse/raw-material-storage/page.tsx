"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { DataTable } from "../../../components/data/data-table";
import { Input } from "../../../components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { RawMaterialInboundDetailDialog, type RawMaterialInboundRow } from "../../../components/warehouse/raw-material-inbound-detail-dialog";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../../lib/api-client";
import { currentOnHandQuantity, mergeMaterialBalances } from "../../../lib/wms-balances";
import { shouldAutoOpenDraft } from "../../../lib/auto-open";
import { shouldRefreshOnVisibility } from "../../../lib/refresh-policy";
import { fuzzyMatch } from "../../../lib/fuzzy-search";
import { auditColumns } from "../../../components/data/audit-columns";

// specificationModel / color 由 GET /materials 返回（listMaterials 返回物料全字段），
// 库存汇总的「规格型号」列与搜索都依赖它们。
type Material = { id: string; materialCode: string; name: string; defaultUnitId: string; specificationModel?: string | null; color?: string | null };
type Unit = { id: string; name: string };
type Inspection = { id: string; orderNo: string; inspectedQuantity: string; status: string };
/**
 * 列表行 = `GET /raw-material-inbounds` 的一行。
 *
 * 详情弹窗要用的物料/单位/供应商/质检/应付来源/库存流水全部来自这个接口（见共享组件
 * `components/warehouse/raw-material-inbound-detail-dialog.tsx`），本页只需要再补两个 id：
 * 库存汇总与搜索要靠 `materialId` / `unitId` 把物料名与单位名映射出来。
 */
type Inbound = RawMaterialInboundRow & { materialId: string; unitId: string; inboundNoticeId?: string | null; incomingInspectionId?: string };
type Balance = { material_id: string; unit_id: string | null; unit_name: string; order_no: string | null; quantity: string; material?: Material };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

/**
 * 库存余额接口。**刻意不带 `material_ids`**（接口支持这个筛选，但这里不能用）。
 *
 * 2026-10-16 排查：「原料入库单过账了（入库状态=入库成功），库存汇总里却看不到那个物料」。
 *
 * 根因是这条 URL 的长度。生产机上 `/api/` 要先过 nginx（`.deploy-run-118/nginx-dilee.conf`），
 * 那份配置**没有**放宽请求行 —— nginx 默认 `large_client_header_buffers 4 8k`，
 * 而**一条请求行（方法 + URL + HTTP 版本）不能超过一个 buffer**：8192 字节。
 * 原来这里把**全部物料 id** 拼进查询串，线上 id 是 UUID（36 字符 + 分隔符 = 37 字节/个）：
 *
 *   物料 200 个 → 约 7.4KB（勉强过）　物料 300 个 → **11.2KB（nginx 直接回 414）**
 *
 * 414 时请求根本到不了 API，而这一页的 `Promise.all` 里前四个请求都成功了，于是
 * **原料入库单那张表照常显示「入库成功」，库存汇总整表空白** —— 用户看到的就是「入库成功但没库存」。
 * 本机复现见 `test/raw-material-storage.test.tsx`（300 个物料时请求行 11165 字节 > 8192）。
 *
 * 为什么不改成"分批发 id"或"加个更长的限制"：这一页**本来就要全部物料的余额** ——
 * 它给每个物料都补一行 0（`mergeMaterialBalances`），少了谁都是错的。
 * 接口在不给 `material_ids` 时返回全部原料余额（`inventory.service.ts` 的空数组=不过滤），
 * 所以把筛选去掉是**同一个结果集、没有 URL 长度上限**：`app/warehouse/page.tsx` 与
 * `material-slip-editor.tsx` 也是这么调的。
 */
const RAW_MATERIAL_BALANCES_PATH = "/inventory/raw-material-balances";

/**
 * 两张表的列宽（百分比）。
 *
 * `DataTable` 2026-10-09 起**一律**给 `<table>` 加 `data-table-fixed`（`table-layout: fixed`）：
 * 没写 `meta.width` 的列由浏览器**均分**容器宽度，与内容长短无关 ——「物料」这种长文本
 * 会和「现存原料数量」一样宽，然后被省略成一串「M-00…」。这里把每一列的宽度显式写出来，
 * 把「均分」改成「按内容需要分配」。
 *
 * 两条预算（1366 屏的表内容宽约 1034px 是下面估值的分母）：
 *   - 「库存汇总」六列没有审计列 → 总和 100%；
 *   - 「原料入库单」用 `auditColumns()`，创建人 / 最后修改人两列由工厂追加、**刻意不给宽度**，
 *     让它们分剩下的 16%（各 8%），所以下面十列总和 = 84%。
 *     不给它们写宽度的另一个原因：那两列的列名/字段只有工厂一处定义，
 *     `lib/audit-columns-coverage.test.mjs` 有守卫盯着（键名也不该起 createdBy/updatedBy）。
 *
 * 每个数字的来历：
 *   - 物料 28%：「物料编码 / 物料名称」拼成一格，是这一行的身份，最长的一列；
 *     规格型号 26%：原料的关键区分项（同名不同规格是常态），只给物料名无法确认是哪一种。
 *     这两列的 `cell` 返回的就是字符串，`DataTable` 会自动配 `cell-ellipsis` + 原生 `title`
 *     （hover 看全文），所以**不写 `ellipsis: true`** —— 2026-10-09 起它已是默认值。
 *   - 单位 6%：短文本，够放「米 / 条 / 千克」这类单位名。
 *   - 待入库（未过账）14%：这一列宽的是**表头**（8 个汉字约 96px + 24px 内边距 ≈ 120px），
 *     里面的数字很短；已过账库存 13% / 现存原料数量 13%：数字列，5~6 字表头 + 「120.0000」这类数字。
 *   - 入库单号 10%：行身份，单号常带日期前缀；订单号 / 采购单号 / 到货记录各 8%：
 *     单号属长文本列（规则下限 ≥8%），超出的省略号 + hover 看全文。
 *   - 到货批次 7%：「第 12 批」约 45px + 内边距 = 69px；数量 5%：数字列取规则区间（4%~6%）的中值；
 *     质检状态 / 入库状态各 7%：`inspection_status` 回落后端原值（如 accepted），
 *     「入库状态」是 4 个汉字（约 48px + 内边距 = 72px，恰好等于 1034px 的 7%）。
 *   - 备注 10%：自由文本、无长度上界，给到规则下限以上即可，靠省略号 + hover 看全文。
 *   - 操作 14%：草稿行最多同时 3 个按钮（编辑 / 过账 / 删除），
 *     3 × 44px + 2 × 4px 间距 = 140px，140 ÷ 1034px ≈ 13.5%，向上取 14%。
 *     1366 屏这一列只有约 145px（减掉 12px×2 内边距后 121px），三个按钮会**折成两行** ——
 *     这是既定取舍：宁可按钮折行，也不把单号 / 备注压到一上来就被省略
 *     （与物料清单页 2026-10-08 的取舍一致，见 app/procurement/materials/page.tsx 的列宽注释）。
 */
const COLUMN_WIDTH = {
  // 库存汇总：六列，合计 100%
  material: "28%",
  specification: "26%",
  unit: "6%",
  pending: "14%",
  postedQuantity: "13%",
  totalQuantity: "13%",
  // 原料入库单：十列，合计 84%（剩下 16% 归 auditColumns() 追加的创建人 / 最后修改人）
  inboundNo: "10%",
  orderNo: "8%",
  purchaseOrderNo: "8%",
  batch: "7%",
  receiptNo: "8%",
  quantity: "5%",
  inspectionStatus: "7%",
  inboundStatus: "7%",
  remark: "10%",
  actions: "14%",
} as const;

export default function RawMaterialStoragePage() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  /**
   * 库存余额**没取到**时的原因（与页面级 `error` 分开）。
   *
   * 为什么值得单独一个状态：余额失败时 `balances` 留在空数组，而库存汇总的空态是「暂无原料库存」——
   * 用户看到的是"没有库存"，事实是"没取到"。这两句话在业务上完全不同（一个是数据、一个是故障），
   * 混在一起正是 2026-10-16 那个「入库成功但库存里看不到物料」查了半天的原因。
   */
  const [balanceError, setBalanceError] = useState("");
  const [inbounds, setInbounds] = useState<Inbound[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /**
   * 双击原料入库单弹出的居中详情（2026-11-04）。
   *
   * 为什么用行数据而不是再打一次 `:id`：`GET /raw-material-inbounds` 本来就把这张单的全部字段
   * （含物料/单位/供应商/质检单、`inventoryFacts`、`payableSources`、批次、结算金额）一次带回，
   * 列表与详情是同一份数据 —— 再开一个详情接口只会多一个「详情和列表不一致」的分叉。
   */
  const [detail, setDetail] = useState<Inbound | null>(null);
  const [query, setQuery] = useState("");
  const [orderQuery, setOrderQuery] = useState("");
  const searchParams = useSearchParams();
  const noticeId = searchParams.get("notice_id");
  const autoOpenedNoticeRef = useRef<string | null>(null);

  // silent：后台刷新（窗口重新获得焦点/可见）时为 true —— 不切整页 loading。
  // 整页 loading 会把页面（包括正在编辑的弹窗）卸载掉，用户切到别的软件复制数据再切回来就白填了。
  async function load(options: { silent?: boolean } = {}) {
    if (!options.silent) setLoading(true);
    setError("");
    try {
      const [m, u, i, ib] = await Promise.all([
        apiGet<Material[]>("/materials"),
        apiGet<Unit[]>("/units"),
        apiGet<Inspection[]>("/incoming-inspections"),
        apiGet<Inbound[]>("/raw-material-inbounds")
      ]);
      setMaterials(m.data);
      setUnits(u.data);
      setInspections(i.data);
      setInbounds(ib.data);
      // 余额单独一次请求、单独一个 try：它失败不该把「原料入库单」那张表也标成加载失败
      // （入库单是入库是否生效的唯一凭证，那时候它恰恰是最需要能看的），
      // 但**也不能静默留空** —— 所以失败时记进 balanceError，由库存汇总那张卡自己说清。
      try {
        const balanceResult = await apiGet<Balance[]>(RAW_MATERIAL_BALANCES_PATH);
        // 单位名必须用本次请求返回的 u.data 解析：渲染期派生的 unitMap 在首次加载时还是空的。
        setBalances(mergeMaterialBalances(m.data, u.data, balanceResult.data, (row, material) => ({ ...row, material })));
        setBalanceError("");
      } catch (cause) {
        setBalanceError(messageOf(cause, "库存汇总加载失败"));
      }
    } catch (cause) {
      setError(messageOf(cause, "原料仓储情况加载失败"));
    } finally {
      if (!options.silent) setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);
  // 跨模块状态刷新：仓库在别处过账/冲销后，本页重新可见时自动拉取，保证入库状态及时更新。
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState)) void load({ silent: true }); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  // 自动打开只做一次：早期版本把 dialog 作为依赖条件，用户一关闭就会立刻被重新打开。
  useEffect(() => {
    if (!shouldAutoOpenDraft({ targetId: noticeId, alreadyOpened: autoOpenedNoticeRef.current, hasLoaded: inbounds.length > 0 })) return;
    const inbound = inbounds.find((item) => item.inboundNoticeId === noticeId);
    if (inbound?.status !== "draft") return;
    autoOpenedNoticeRef.current = noticeId;
    editInbound(inbound);
  }, [noticeId, inbounds]);

  async function run(action: Promise<unknown>, success: string) {
    setError("");
    try {
      await action;
      setMessage(success);
      await load();
    } catch (cause) {
      setError(messageOf(cause, "操作失败"));
    }
  }

  function createInbound() {
    setDialog({
      title: "创建原料入库",
      fields: [
        { name: "inspection_id", label: "质检记录", type: "select", required: true, options: inspections.map((item) => ({ value: item.id, label: item.orderNo + " / " + item.inspectedQuantity + " / " + item.status })) },
        { name: "quantity", label: "入库数量", type: "number", required: true, defaultValue: "1" },
        { name: "remark", label: "备注", type: "textarea" }
      ],
      submit: (values) => void run(apiPost("/raw-material-inbounds", { incoming_inspection_id: values.inspection_id, quantity: values.quantity, inventory_category: "raw_material", remark: values.remark || undefined }), "原料入库草稿已创建")
    });
  }

  function editInbound(item: Inbound) {
    // 仓库只登记实际入库数量；结算单价/总价/金额差异原因属于采购口径，由采购页维护。
    setDialog({
      title: "编辑原料入库单",
      fields: [
        { name: "quantity", label: "实际入库数量（通知数量以当前草稿为准）", type: "number", required: true, defaultValue: item.quantity },
        { name: "remark", label: "备注", type: "textarea", defaultValue: item.remark ?? "" }
      ],
      submit: (values) => void run(apiPatch("/raw-material-inbounds/" + item.id, { quantity: values.quantity, remark: values.remark || undefined }), "原料入库单已更新")
    });
  }

  function reverseInbound(item: Inbound) {
    setDialog({
      title: `冲销入库单：${item.inboundNo}`,
      fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }],
      submit: (values) => void run(apiPost("/raw-material-inbounds/" + item.id + "/reverse", { reason: values.reason }), "原料入库已冲销")
    });
  }

  const balanceColumns: ColumnDef<Balance>[] = [
    { id: "material", header: "物料", meta: { width: COLUMN_WIDTH.material }, cell: ({ row }) => row.original.material?.materialCode + " / " + row.original.material?.name },
    // 规格型号是原料的关键区分项（同名不同规格是常态），只给物料名无法确认是哪一种。
    { id: "specification", header: "规格型号", meta: { width: COLUMN_WIDTH.specification }, cell: ({ row }) => row.original.material?.specificationModel || "-" },
    { accessorKey: "unit_name", header: "单位", meta: { width: COLUMN_WIDTH.unit } },
    // 接收通知后生成的是草稿，库存要过账才会变动；这里把「待入库」单独列出，
    // 否则接收完这个页面看起来“什么都没更新”。
    // 这一格的 `cell` 返回的是带颜色的 span（JSX），而 `DataTable` 的自动 hover title 只认字符串：
    // 补一个与格子同值的 `accessorFn`，非 0 的那几格才拿得到 `cell-ellipsis` + 原生 title。
    { id: "pending", header: "待入库（未过账）", meta: { width: COLUMN_WIDTH.pending }, accessorFn: (row) => pendingByKey.get(`${row.material_id}|${row.unit_id}`) ?? 0, cell: ({ row }) => { const quantity = pendingByKey.get(`${row.original.material_id}|${row.original.unit_id}`) ?? 0; return quantity ? <span className="status-warning">{quantity}</span> : "0"; } },
    { accessorKey: "quantity", header: "已过账库存", meta: { width: COLUMN_WIDTH.postedQuantity } },
    // 「现存原料数量」= 已过账库存 + 待入库（未过账）。这一列以前叫「合计」：数字一直是对的，
    // 但「合计」读起来像「两列相加」这种算术名，看不出它表达的是**物理上已在库的量**，
    // 用户 2026-11-13 要求正名，口径不变。
    // 表头用 `<span title>` 写口径：`DataTable` 只给**字符串表头**自动配 hover title，
    // 而自动 title 只会重复列名，说明不了口径。
    { id: "total", header: () => <span title="现存 = 已过账库存 + 待入库（未过账），即物理上已在库的量">现存原料数量</span>, meta: { width: COLUMN_WIDTH.totalQuantity }, cell: ({ row }) => { const pending = pendingByKey.get(`${row.original.material_id}|${row.original.unit_id}`) ?? 0; return currentOnHandQuantity(row.original.quantity, pending).toString(); } }
  ];

  const inboundColumns: ColumnDef<Inbound>[] = [
    { accessorKey: "inboundNo", header: "入库单号", meta: { width: COLUMN_WIDTH.inboundNo } },
    { accessorKey: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.orderNo } },
    { accessorKey: "purchase_order_no", header: "采购单号", meta: { width: COLUMN_WIDTH.purchaseOrderNo } },
    { id: "batch", header: "到货批次", meta: { width: COLUMN_WIDTH.batch }, cell: ({ row }) => `第 ${row.original.batch_sequence ?? "-"} 批` },
    { accessorKey: "receipt_no", header: "到货记录", meta: { width: COLUMN_WIDTH.receiptNo } },
    { accessorKey: "quantity", header: "数量", meta: { width: COLUMN_WIDTH.quantity } },
    { accessorKey: "inspection_status", header: "质检状态", meta: { width: COLUMN_WIDTH.inspectionStatus } },
    // 这一格渲染的是带颜色的 span（JSX），`DataTable` 的自动 hover title 只认字符串：
    // 不给 accessor 的话，7% 宽的这一列被硬裁时既没有省略号、也没有 title 能看全。
    // 用 `accessorFn` 供出与屏幕一致的中文标签（要的正是「这一格的值」），
    // 表头自动加的那个 `title` 管的是表头，管不到单元格。
    { id: "status", accessorFn: (row) => inboundStatusLabels[row.status] ?? row.status, header: "入库状态", meta: { width: COLUMN_WIDTH.inboundStatus }, cell: ({ row }) => <span className={row.original.status === "posted" ? "status-success" : row.original.status === "reversed" ? "status-warning" : undefined}>{inboundStatusLabels[row.original.status] ?? row.original.status}</span> },
    { accessorKey: "remark", header: "备注", meta: { width: COLUMN_WIDTH.remark } },
    ...auditColumns<Inbound>(),
    {
      id: "actions",
      header: "操作",
      meta: { width: COLUMN_WIDTH.actions },
      cell: ({ row }) => <div className="action-row">
        {row.original.status === "draft" && <>
          <Button size="sm" variant="secondary" onClick={() => editInbound(row.original)}>编辑</Button>
          <Button size="sm" variant="secondary" onClick={() => void run(apiPost("/raw-material-inbounds/" + row.original.id + "/post"), "原料入库已过账")}>过账</Button>
          <Button size="sm" variant="ghost" onClick={() => void run(apiRequest("/raw-material-inbounds/" + row.original.id, { method: "DELETE" }), "原料入库单已删除")}>删除</Button>
        </>}
        {row.original.status === "posted" && <Button size="sm" variant="destructive" onClick={() => reverseInbound(row.original)}>冲销</Button>}
      </div>
    }
  ];

  const unitMap = useMemo(() => new Map(units.map((unit) => [unit.id, unit.name])), [units]);
  const inboundStatusLabels: Record<string, string> = { draft: "待入库登记", posted: "入库成功", reversed: "已冲销" };
  // 草稿入库单 = 已接收/已登记但还没过账的数量，按「物料|单位」汇总，供库存汇总表分列显示。
  const pendingByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const inbound of inbounds) {
      if (inbound.status !== "draft") continue;
      const key = `${inbound.materialId}|${inbound.unitId}`;
      map.set(key, (map.get(key) ?? 0) + Number(inbound.quantity));
    }
    return map;
  }, [inbounds]);

  // 搜索只影响展示，不影响上面的计数与动作；入库单本身不带物料名，用 materials 映射补齐后再参与匹配。
  const materialMap = useMemo(() => new Map(materials.map((item) => [item.id, item])), [materials]);
  const filteredBalances = useMemo(() => balances.filter((row) => {
    const ok = fuzzyMatch(query, [
      row.material?.materialCode, row.material?.name, row.material?.specificationModel, row.material?.color, row.unit_name, row.order_no,
    ]);
    if (!ok) return false;
    if (!orderQuery) return true;
    return fuzzyMatch(orderQuery, [row.order_no]);
  }), [balances, query, orderQuery]);
  const filteredInbounds = useMemo(() => inbounds.filter((row) => {
    const material = materialMap.get(row.materialId);
    const ok = fuzzyMatch(query, [
      row.inboundNo, row.orderNo, row.purchase_order_no, row.receipt_no, row.batch_sequence,
      row.inspection_status, inboundStatusLabels[row.status], row.remark,
      material?.materialCode, material?.name, material?.specificationModel, material?.color,
    ]);
    if (!ok) return false;
    if (!orderQuery) return true;
    return fuzzyMatch(orderQuery, [row.orderNo, row.purchase_order_no]);
  }), [inbounds, materialMap, query, orderQuery]);

  // ---------------------------------------------------------------- 双击详情

  /**
   * 详情里的动作与列表行动作是**同一批回调**，只是先把弹窗关掉：
   * 编辑/冲销会再弹一个 ActionDialog、过账/删除会整页重载，两弹窗叠着只会把焦点抢乱。
   */
  function actFromDetail(action: () => void) {
    setDetail(null);
    action();
  }

  if (loading) return <><PageHeader title="原料仓储情况"><Button asChild variant="secondary"><Link href="/warehouse">返回仓库</Link></Button></PageHeader><LoadingState /></>;

  return (
    <div className="page-root" data-testid="page-warehouse-raw-material-storage">
      <PageHeader title="原料仓储情况">
        <Button asChild variant="secondary"><Link href="/warehouse">返回仓库</Link></Button>
        <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        <Button onClick={createInbound}>新建入库单</Button>
      </PageHeader>
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { dialog?.submit(values); setDialog(null); }} />
      {/* 双击原料入库单弹出的居中详情（2026-11-04）：版式与「哪张单值得看什么」都收在
          `components/warehouse/raw-material-inbound-detail-dialog.tsx`，采购「原料入库」页双击同一行
          打开的是同一个组件 —— 同一条入库单在两个页面上必须是同一个样子。 */}
      <RawMaterialInboundDetailDialog
        inbound={detail}
        onOpenChange={(open) => { if (!open) setDetail(null); }}
        actions={detail ? <div className="action-row">
          {detail.status === "draft" && <>
            <Button size="sm" variant="secondary" onClick={() => actFromDetail(() => editInbound(detail))}>编辑</Button>
            <Button size="sm" variant="secondary" onClick={() => actFromDetail(() => void run(apiPost("/raw-material-inbounds/" + detail.id + "/post"), "原料入库已过账"))}>过账</Button>
            <Button size="sm" variant="ghost" onClick={() => actFromDetail(() => void run(apiRequest("/raw-material-inbounds/" + detail.id, { method: "DELETE" }), "原料入库单已删除"))}>删除</Button>
          </>}
          {detail.status === "posted" && <Button size="sm" variant="destructive" onClick={() => actFromDetail(() => reverseInbound(detail))}>冲销</Button>}
        </div> : undefined}
      />
      {message && <section className="panel panel-body status-success" role="status">{message}</section>}
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <section className="panel panel-body">
        <div className="filter-bar">
          <label>搜索<Input data-testid="raw-material-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="物料编码 / 名称 / 规格型号 / 颜色 / 单位 / 单号" /></label>
          <label>按订单号搜索<Input data-testid="raw-material-order-search" value={orderQuery} onChange={(event) => setOrderQuery(event.target.value)} placeholder="输入订单号或采购单号" /></label>
          {(query || orderQuery) && <Button variant="secondary" onClick={() => { setQuery(""); setOrderQuery(""); }}>清除搜索</Button>}
        </div>
        <p className="panel-note">模糊搜索：按空格分词，所有词都要命中才算匹配（大小写与空格不敏感）。同时过滤「库存汇总」与「原料入库单」两张表，匹配物料编码、名称、规格型号、颜色、单位，以及入库单号、订单号、采购单号、到货记录、备注。</p>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>库存汇总</h2>{query ? <span className="panel-note">筛选后 {filteredBalances.length} / {balances.length} 条</span> : null}</div>
        <div className="panel-body">
          <p className="panel-note">「待入库（未过账）」是已接收通知生成的草稿数量，登记实际数量并过账后才会计入「已过账库存」。「现存原料数量」= 已过账库存 + 待入库（未过账），即物理上已在库的量（含未过账草稿）。</p>
          {/*
            取数失败 ≠ 没有库存。失败时**不渲染这张表**（表在、数据 0 行，读起来就是「库存是空的」），
            改成把原因摆在这里 + 一个重试入口；下面那张原料入库单照旧可用。
          */}
          {balanceError
            ? <ErrorState message={`库存汇总没取到：${balanceError}`} onRetry={() => void load()} />
            : <DataTable columns={balanceColumns} data={filteredBalances} empty={<EmptyState title={query ? "没有匹配的原料库存" : "暂无原料库存"} description={query ? "换个关键词，或点「清除搜索」看全部。" : undefined} />} />}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>原料入库单</h2>{query ? <span className="panel-note">筛选后 {filteredInbounds.length} / {inbounds.length} 条</span> : null}</div>
        <div className="panel-body">
          <DataTable
            columns={inboundColumns}
            data={filteredInbounds}
            onRowDoubleClick={(row) => setDetail(row)}
            rowTitle="双击查看详情"
            empty={query
              ? <EmptyState title="没有匹配的原料入库单" description="换个关键词，或点「清除搜索」看全部。" />
              : <EmptyState title="暂无原料入库单" description="在【仓库 → 待入库通知】接收入库通知后，这里会出现对应的草稿入库单；登记实际数量并过账后计入库存。" />}
          />
          <p className="panel-note">双击任意一行可查看这张入库单的详情（全字段 + 应付来源 + 库存流水）。</p>
          <p className="panel-note">单位：{units.length ? units.map((unit) => unit.name).join("、") : "暂无"}</p>
          <p className="panel-note">质检记录：{inspections.length}</p>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>入库单与库存关系</h2></div>
        <div className="panel-body">
          <p className="panel-note">库存以物料为唯一口径，入库单过账后会同步到汇总库存。</p>
          {/* 余额没取到时不报「当前原料汇总条目：0」——那同样是在把"没取到"说成"没有库存"。 */}
          {balanceError
            ? <p className="panel-note status-error">库存汇总没取到数，条目数暂时不可知（原因见上方「库存汇总」）。</p>
            : <p className="panel-note">当前原料汇总条目：{balances.length}{query ? `（筛选后 ${filteredBalances.length}）` : ""}</p>}
          <p className="panel-note">当前可用入库单：{inbounds.filter((item) => item.status === "draft").length}</p>
          <p className="panel-note">当前已过账入库单：{inbounds.filter((item) => item.status === "posted").length}</p>
          <p className="panel-note">当前已冲销入库单：{inbounds.filter((item) => item.status === "reversed").length}</p>
          <p className="panel-note">单位映射：{unitMap.size}</p>
        </div>
      </section>
    </div>
  );
}