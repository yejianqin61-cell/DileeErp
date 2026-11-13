"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { DataTable } from "../../../components/data/data-table";
import { auditColumns } from "../../../components/data/audit-columns";
import { RawMaterialInboundDetailDialog, type RawMaterialInboundRow } from "../../../components/warehouse/raw-material-inbound-detail-dialog";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { Input } from "../../../components/ui/input";
// 搜索语义全站统一（空格分词的 AND、忽略大小写与空白、空查询不过滤），见 lib/fuzzy-search.ts。
import { fuzzyMatch } from "../../../lib/fuzzy-search";
import { ApiClientError, apiGet, apiRequest } from "../../../lib/api-client";
import { shouldRefreshOnVisibility } from "../../../lib/refresh-policy";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

// 列表行与仓库「原料仓储情况」页是同一个接口、同一张单：双击详情也复用同一个弹窗组件
// （`components/warehouse/raw-material-inbound-detail-dialog.tsx`），字段名与口径不会在两个页面分叉。
type Inbound = RawMaterialInboundRow;
type PayableSource = { id: string; orderNo: string; amount: string; status: string; rawMaterialInboundId?: string | null; rawMaterialInbound?: { inboundNo?: string } };
type PayableEntry = { id: string; payableNo: string; payableSourceId?: string | null; status: string; amount: string; currency?: string };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const inboundStatusLabels: Record<string, string> = { draft: "待入库登记", posted: "入库成功", reversed: "已冲销" };
// 来源状态：财务「接收应付」后后端会把 payable_sources.status 置为 received（历史数据可能缺失），
// 因此这里既给 received 的中文，也在下面用应付条目关联兜底显示「已通知」。
const payableStatusLabels: Record<string, string> = { pending_finance: "待通知财务", received: "财务已接收", draft: "待财务确认", confirmed: "财务已确认", partially_paid: "部分付款", paid: "已付款", reversed: "已冲回", voided: "已作废" };

/** 入库状态码 → 界面文字。列定义与它的 `accessorFn` 共用这一处，避免「屏幕上中文、hover 是 posted」。 */
const inboundStatusText = (status: string) => inboundStatusLabels[status] ?? status;

/**
 * 原料入库列表的列宽。
 *
 * 为什么要有这个常量：2026-10-09 起 `DataTable` **一律**给 `<table>` 加 `data-table-fixed`
 * （`table-layout: fixed`，`components/data/data-table.tsx`），没写 `meta.width` 的列由浏览器**均分**
 * 容器宽度 —— 「某个 column 把表顶宽」已经不会发生，这次要做的是把**均分**换成**按内容需要分配**。
 * 集中写成一个常量，是为了让「总和 = 84%」这件事一眼可核对（散在 11 个 meta 里没法核）。
 *
 * 口径与数字来历：
 *   - 基准容器宽 **1034px**（1366px 视口下表格可用宽，与 `docs/design/table-column-width-audit-2026-10-09/` 同口径），
 *     百分比 = 需要的像素 ÷ 1034；
 *   - `.ui-table-cell` 是 `padding: 12px`（`globals.css:89`），即**每格左右各吃掉 12px**：
 *     一列定 n% 后真正能放字的宽度是 `n% × 1034 - 24`（8% → 58.7px，与 `components/data/audit-columns.tsx:44`
 *     记的实测值一致）。所以「够不够放」要按这个减完的数看，不是按百分比本身看；
 *   - 本表 13 列 = 11 列业务列 + `auditColumns()` 产出的「创建人 / 最后修改人」。后两列**刻意不在
 *     这里给宽度**（工厂用法不能改，`lib/audit-columns-coverage.test.mjs` 有守卫），所以这 11 列的总和
 *     必须是 **84%**，剩下 16% 由那两列均分（各 8% → 58.7px，正好是工厂注释里记的宽度）。
 */
const COLUMN_WIDTH = {
  // ── 四张单号列：内容 14~16 字符 ≈ 110px（需求 10.6%），但 84% 要分给 11 列，
  //    单号只能落在规则下限 8%（= 58.7px，放得下约 8 个字符）；长出来的部分统一靠
  //    「cell-ellipsis 省略 + hover 看全文」兜住 —— 这是本次口径下的既定取舍。
  inboundNo: "8%",
  orderNo: "8%",
  purchaseOrderNo: "8%",
  receiptNo: "8%",
  // 到货批次是派生串「第 12 批」≈ 5 个字符 ≈ 45px = 4.4%，属短串 → 5%。
  batch: "5%",
  // 数量：几位小数的数字串（"1234.0000" ≈ 58px = 5.6%），取规则 4%~6% 的中段 5%。
  quantity: "5%",
  // 质检状态：接口原样下发的状态码（最长 conditionally_accepted = 22 字符 ≈ 158px = 15%），
  // 远超「短状态 4%~6%」的上限 —— 顶格 6% 也只能放 4 个字符。按 5% 与「入库状态」对齐，
  // 长码仍然 hover 看全文（这一列只有 accessorKey，title 取的就是屏幕上那串原码，两边一致）。
  inspectionStatus: "5%",
  // 入库状态：「待入库登记」5 个汉字 ≈ 65px = 6.3%，但它是固定枚举（三个值）+ 可省略 → 5%。
  status: "5%",
  // 应付来源是拼接串「金额（状态）」（"12345.6700（待通知财务）" ≈ 170px = 16%）：
  // 拼接串按规则下限 8% —— 预算也只够给它 8%（58.7px 放得下金额前 8 位），全文 hover 可见。
  payable: "7%",
  // 财务付款：这一列有的行渲染的是按钮（`ui-button-sm`「通知财务付款」= 6 汉字 × 12px + 左右各 10px
  // 内边距 ≈ 92px），加本格 24px 内边距 = 116px → 116 ÷ 1034 = 11.2% → 取 12%。
  // 为什么必须给够：这一列下面挂了 `accessorFn`（自动 title 取得到文字），DataTable 会给它加
  // `cell-ellipsis`（`white-space: nowrap` + `overflow: hidden`）—— 放不下时按钮会被**无声裁掉**，
  // 不是换成省略号。
  finance: "11%",
  // 操作列最多同时两个按钮（「编辑」+ 已过账行的「冲销」）：44px + 间距 4px + 44px = 92px，
  // 加本格 24px 内边距 = 116px → 11.2% → 12%。同理不能少：`.action-row` 虽会 flex 换行，
  // 但 92px 挤进更窄的格子会把两个按钮叠成两行、把行高撑起来。
  // 编辑 / 冲销保持在同一行，避免入库记录的行高被操作按钮撑开。
  actions: "14%",
} as const;

export default function InboundsPage() {
  const [inbounds, setInbounds] = useState<Inbound[]>([]);
  const [payables, setPayables] = useState<PayableSource[]>([]);
  const [payableEntries, setPayableEntries] = useState<PayableEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);
  /** 双击入库单弹出的居中详情（复用仓库页同一个组件，见文件头的说明）。 */
  const [detail, setDetail] = useState<Inbound | null>(null);
  /**
   * 关键字搜索（2026-11-13，用户：「统计所有下拉列表，所有表单是否都有搜索功能搜索框，如果没有，都需要
   * 加上搜索功能。因为现在单子多了，查找比较麻烦」）。
   *
   * 入库记录只会越来越多，而这一页一行里同时有入库单号/订单号/采购单号/到货记录四串号码 ——
   * 用户手上拿到的往往是其中任意一串。可搜：单号类四列 + 到货批次 + 数量 + 质检状态 + 入库状态 +
   * 应付来源 + 财务付款（都是这张表**看得见**的列）。只改显示，不影响这一页的取数与动作。
   */
  const [keyword, setKeyword] = useState("");

  async function load(options: { silent?: boolean } = {}) {
    if (!options.silent) setLoading(true);
    setError("");
    try {
      const [ib, payable, entries] = await Promise.all([
        apiGet<Inbound[]>("/raw-material-inbounds"),
        apiGet<PayableSource[]>("/payable-sources"),
        apiGet<PayableEntry[]>("/finance/payable-entries").catch(() => ({ data: [] as PayableEntry[], meta: {} })),
      ]);
      setInbounds(ib.data);
      setPayables(payable.data);
      setPayableEntries(entries.data);
    } catch (cause) {
      setError(messageOf(cause, "入库数据加载失败"));
    } finally {
      if (!options.silent) setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState)) void load({ silent: true }); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);

  async function action(path: string, body?: unknown, success = "操作已完成") {
    setError("");
    try {
      await apiRequest(path, { method: "POST", body: JSON.stringify(body) });
      notifySuccess(success);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }

  const payableSourcesOf = (inbound: Inbound) => payables.find((s) => s.rawMaterialInboundId === inbound.id);

  /**
   * 「财务付款」这一格在屏幕上到底是哪串字：
   * 有应付条目 → 「已通知（状态）」；还没过账 / 没有应付来源 → 「仓库入库成功后可通知」；否则 → 按钮文案。
   *
   * 为什么要单独写成函数：这一列渲染的是 JSX（状态 span / 按钮），DataTable 的自动 title 只认
   * 字符串，取不到就只能空着；`accessorFn` 拿这个函数当值，hover 才有全文可看（见 `COLUMN_WIDTH.finance`
   * 关于「必须给够宽度」的注释）。
   */
  const financeTextOf = (inbound: Inbound): string => {
    const source = payableSourcesOf(inbound);
    const entry = source ? payableEntries.find((e) => e.payableSourceId === source.id) : undefined;
    if (entry) return `已通知（${payableStatusLabels[entry.status] ?? entry.status}）`;
    if (inbound.status !== "posted" || !source) return "仓库入库成功后可通知";
    return "通知财务付款";
  };

  function editInbound(item: Inbound) {
    setDialog({
      title: "编辑原料入库单",
      fields: [
        { name: "quantity", label: "入库数量", type: "number", required: true, defaultValue: item.quantity },
        { name: "settlement_unit_price", label: "结算单价", type: "number", defaultValue: item.settlementUnitPrice ?? "" },
        { name: "settlement_total_amount", label: "结算总价", type: "number", defaultValue: item.settlementTotalAmount ?? "" },
        { name: "settlement_amount_reason", label: "金额差异原因", type: "textarea", defaultValue: item.settlementAmountReason ?? "" },
        { name: "remark", label: "备注", type: "textarea" },
      ],
      submit: (v) => void action(`/raw-material-inbounds/${item.id}`, {
        quantity: v.quantity,
        settlement_unit_price: v.settlement_unit_price || undefined,
        settlement_total_amount: v.settlement_total_amount || undefined,
        settlement_amount_reason: v.settlement_amount_reason || undefined,
        remark: v.remark || undefined,
      }, "原料入库单已更新"),
    });
  }

  function reverseInbound(item: Inbound) {
    setDialog({
      title: `冲销入库：${item.inboundNo}`,
      fields: [{ name: "reason", label: "冲销原因", required: true, type: "textarea" }],
      submit: (v) => void action(`/raw-material-inbounds/${item.id}/reverse`, { reason: v.reason }, "原料入库已冲销"),
    });
  }

  function notifyFinance(inbound: Inbound, source: PayableSource) {
    void action("/finance/payable-entries/from-source", { source_type: "raw_material_inbound", source_id: source.id, remark: `采购通知付款：${inbound.inboundNo}` }, "已通知财务付款");
  }

  /**
   * 详情里的动作与列表行动作是**同一批回调**（编辑 / 冲销 / 通知财务付款），只是先把弹窗关掉：
   * 编辑与冲销会再弹一个 ActionDialog、通知财务会整页重载，两弹窗叠着只会把焦点抢乱。
   */
  function actFromDetail(run: () => void) {
    setDetail(null);
    run();
  }

  /** 详情底部「通知财务付款」的可用性：已过账、有应付来源、且还没有生成应付条目（与列表那一列同一条判断）。 */
  function sourceToNotify(inbound: Inbound) {
    const source = payableSourcesOf(inbound);
    if (!source || inbound.status !== "posted") return null;
    return payableEntries.some((entry) => entry.payableSourceId === source.id) ? null : source;
  }

  /** 关键字过滤后的入库记录（只按这张表看得见的列匹配，见 `keyword` 的注释）。 */
  const visibleInbounds = useMemo(() => {
    if (!keyword.trim()) return inbounds;
    return inbounds.filter((row) => fuzzyMatch(keyword, [
      row.inboundNo, row.orderNo, row.purchase_order_no, row.receipt_no,
      `第 ${row.batch_sequence ?? "-"} 批`, row.quantity, row.inspection_status,
      inboundStatusText(row.status), payableSourcesOf(row)?.amount,
      payableStatusLabels[(payableSourcesOf(row)?.status ?? "") as keyof typeof payableStatusLabels],
      financeTextOf(row),
    ]));
  }, [inbounds, keyword, payableEntries, payables]);

  const columns: ColumnDef<Inbound>[] = [
    { accessorKey: "inboundNo", header: "入库单号", meta: { width: COLUMN_WIDTH.inboundNo } },
    { accessorKey: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.orderNo } },
    { accessorKey: "purchase_order_no", header: "采购单号", meta: { width: COLUMN_WIDTH.purchaseOrderNo } },
    { id: "batch", header: "到货批次", meta: { width: COLUMN_WIDTH.batch }, cell: ({ row }) => `第 ${row.original.batch_sequence ?? "-"} 批` },
    { accessorKey: "receipt_no", header: "到货记录", meta: { width: COLUMN_WIDTH.receiptNo } },
    { accessorKey: "quantity", header: "数量", meta: { width: COLUMN_WIDTH.quantity } },
    { accessorKey: "inspection_status", header: "质检状态", meta: { width: COLUMN_WIDTH.inspectionStatus } },
    {
      id: "status", header: "入库状态", meta: { width: COLUMN_WIDTH.status },
      // 这一格包着 <span>（JSX），自动 title 只会回退到「这一格的值」；原来的 accessorKey 取的是
      // `posted` / `draft` 这类码，hover 出来是英文。改成 accessorFn 返回**屏幕上那串字**。
      accessorFn: (row) => inboundStatusText(row.status),
      cell: ({ row }) => <span className={row.original.status === "posted" ? "status-success" : row.original.status === "reversed" ? "status-warning" : undefined}>{inboundStatusText(row.original.status)}</span>,
    },
    { id: "payable", header: "应付来源", meta: { width: COLUMN_WIDTH.payable }, cell: ({ row }) => { const source = payableSourcesOf(row.original); return source ? `${source.amount}（${payableStatusLabels[source.status] ?? source.status}）` : "待过账生成"; } },
    {
      id: "finance", header: "财务付款", meta: { width: COLUMN_WIDTH.finance },
      // 同上：这一列是分支渲染（状态 span / 按钮），原来只有 id + cell，自动 title 取不到文字。
      // accessorFn 给的是屏幕上那串字（按钮那一行就是按钮文案），省略号与 hover 才配套生效。
      accessorFn: (row) => financeTextOf(row),
      cell: ({ row }) => {
        const source = payableSourcesOf(row.original);
        const entry = source ? payableEntries.find((e) => e.payableSourceId === source.id) : undefined;
        const text = financeTextOf(row.original);
        if (entry) return <span className="status-success">{text}</span>;
        if (row.original.status !== "posted" || !source) return <span className="panel-note">{text}</span>;
        return <Button size="sm" variant="secondary" onClick={() => notifyFinance(row.original, source)}>通知财务付款</Button>;
      },
    },
    ...auditColumns<Inbound>(),
    {
      id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.actions },
      // 这一列是纯控件（按钮），刻意不给 accessor / title：没有 title 就没有 `cell-ellipsis`
      // 的 nowrap + overflow:hidden，两个按钮才不会被裁掉（靠上面 12% 的宽度放下）。
      cell: ({ row }) => (
        <div className="action-row purchase-table-actions">
          <Button size="sm" variant="secondary" onClick={() => editInbound(row.original)}>编辑</Button>
          {row.original.status === "posted" && <Button size="sm" variant="ghost" onClick={() => reverseInbound(row.original)}>冲销</Button>}
        </div>
      ),
    },
  ];

  if (loading) return <><PageHeader title="原料入库" breadcrumb={["采购", "原料入库"]} /><LoadingState /></>;

  return (
    <div className="page-root" data-testid="page-procurement-inbounds">
      <PageHeader title="原料入库" breadcrumb={["采购", "原料入库"]} description="入库登记和过账在仓库模块执行；本页展示跨模块状态与财务通知。">
        <div className="page-actions">
          <Button variant="secondary" asChild><Link href="/warehouse/raw-material-storage">去原料仓储过账</Link></Button>
          <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        </div>
      </PageHeader>
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
      {/* 双击入库单弹出居中详情：与仓库「原料仓储情况」页共用同一个弹窗组件（字段/分区完全一致），
          只是底部动作按本页能做的事给（编辑 / 冲销 / 通知财务付款）。 */}
      <RawMaterialInboundDetailDialog
        inbound={detail}
        onOpenChange={(open) => { if (!open) setDetail(null); }}
        actions={detail ? <div className="action-row">
          <Button size="sm" variant="secondary" onClick={() => actFromDetail(() => editInbound(detail))}>编辑</Button>
          {detail.status === "posted" && <Button size="sm" variant="ghost" onClick={() => actFromDetail(() => reverseInbound(detail))}>冲销</Button>}
          {sourceToNotify(detail) ? <Button size="sm" variant="secondary" onClick={() => actFromDetail(() => notifyFinance(detail, sourceToNotify(detail)!))}>通知财务付款</Button> : null}
        </div> : undefined}
      />
      {message && <section className="panel panel-body status-success" role="status">{message}</section>}
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <section className="panel">
        <div className="panel-body">
          <div className="filter-bar">
            <label>搜索入库单号、订单号、采购单号、到货记录、状态或应付金额
              <Input data-testid="inbound-search" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入关键词，空格分隔多个词" />
            </label>
            {keyword.trim() ? <span className="panel-note" data-testid="inbound-search-count">筛选后 {visibleInbounds.length} / {inbounds.length} 条</span> : null}
            {keyword.trim() ? <Button variant="secondary" onClick={() => setKeyword("")}>清除搜索</Button> : null}
          </div>
          <DataTable columns={columns} data={visibleInbounds} empty={keyword.trim() ? <EmptyState title={`没有匹配“${keyword.trim()}”的入库记录`} description={`共 ${inbounds.length} 条，换个关键词或清空搜索框。`} /> : <EmptyState title="暂无入库记录" />} onRowDoubleClick={(row) => setDetail(row)} rowTitle="双击查看详情" />
          <p className="panel-note">双击任意一行可查看这张入库单的详情（全字段 + 应付来源 + 库存流水）。</p>
        </div>
      </section>
    </div>
  );
}
