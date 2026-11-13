"use client";

// 仓库成品存量管理：成品/次品存量、待入库通知（分批）、成品入库单与成品出库单。
// 质检（送检、判定、次品登记）已迁到【质检】模块，本页只读质检结论带来的库存结果。
// 数据口径：库存储量取自库存事实聚合（/inventory/balances），入库/出库单据来自成品链路表。
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { DataTable } from "../../../components/data/data-table";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../../lib/api-client";
import { downloadFile } from "../../../lib/download";
// 搜索语义全站统一（空格分词的 AND、忽略大小写与空白、空查询不过滤），见 lib/fuzzy-search.ts。
import { fuzzyMatch } from "../../../lib/fuzzy-search";
import { shouldRefreshOnVisibility } from "../../../lib/refresh-policy";
import { auditColumns, type AuditRow } from "../../../components/data/audit-columns";
import { OrderNoWithOrphan } from "../../../components/data/orphan-badge";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";
import { FinishedGoodsOutboundSlipSheet } from "../../../components/warehouse/finished-goods-outbound-slip-sheet";
import {
  outboundSlipDocumentPath, outboundSlipExportPath, outboundSlipFileName, type FinishedGoodsOutboundSlip,
} from "../../../lib/finished-goods-outbound-slip";

type Balance = { category: string; unit_id: string; production_order_id: string | null; order_no: string | null; product_name: string | null; product_specification: string | null; quantity: string };
type Notice = AuditRow & { id: string; noticeNo: string; orderNo: string; batchNo?: string | null; noticeDate: string; status: string; noticeQuantity: string; submittedQuantity: string; qcQualifiedQuantity: string; inboundDraftQuantity: string; inboundPostedQuantity: string; availableSubmissionQuantity: string; remainingForInbound: string; operationNameSnapshot: string; unitNameSnapshot: string; productNameSnapshot?: string | null };
type Inbound = AuditRow & { id: string; inboundNo: string; orderNo: string; quantity: string; status: string; productNameSnapshot?: string | null; qcRecord?: { qcNo?: string } | null; createdAt?: string };
type Outbound = AuditRow & { id: string; outboundNo: string; orderNo: string; quantity: string; status: string; /** 所属销售单已被软删（2026-11-03）：出库单不删、仍能过账，只标成「孤立」。判定只认后端字段。 */ orphaned?: boolean; productNameSnapshot?: string | null; shipmentDate?: string | null; carrier?: string | null; trackingNo?: string | null; packingListNo?: string | null; invoiceNo?: string | null; signedAt?: string | null; riskReason?: string | null; remark?: string | null; unit?: { name?: string } | null; salesOrder?: { currency?: string; unitPrice?: string | null; settlementUnitPrice?: string | null; customer?: { name?: string } | null } | null; outboundNotice?: { id: string; noticeNo: string; status: string } | null };
// 销售发起的成品出库通知：仓库据此分批生成出库单（可只出一部分，剩余量继续出）。
type OutboundNotice = AuditRow & { id: string; noticeNo: string; orderNo: string; productionOrderId: string; /** 所属销售单已被软删（2026-11-03）：通知不删、仍可生成出库单，只标成「孤立」。 */ orphaned?: boolean; productNameSnapshot?: string | null; productSpecificationSnapshot?: string | null; noticeQuantity: string; shippedQuantity?: string; remaining_quantity?: string; draft_quantity?: string; status: string; notifiedAt: string; remark?: string | null; outbound_summary?: string; unit?: { name?: string } | null; salesOrder?: { customer?: { name?: string } | null } | null };

const noticeStatusLabels: Record<string, string> = { pending: "待送检", partially_inbound: "入库中", completed: "已完成", cancelled: "已取消" };
const inboundStatusLabels: Record<string, string> = { draft: "待入库登记", posted: "入库成功", reversed: "已冲销" };
const outboundStatusLabels: Record<string, string> = { draft: "待出库", posted: "已出库", shipped: "已发出", signed: "已签收", reversed: "已冲销", cancelled: "已取消" };
const categoryLabels: Record<string, string> = { finished_goods: "成品", defective_goods: "次品" };
// 出库通知状态：pending 待仓库建出库单 → outbound_created 已建单待过账 → partially_outbound 已部分出库 → completed 已出库（已通知财务收款）。
const outboundNoticeStatusLabels: Record<string, string> = { pending: "待建出库单", outbound_created: "已建单待过账", partially_outbound: "已部分出库", completed: "已出库（已通知财务收款）", cancelled: "已取消" };
/**
 * 本页六张表的列宽（百分比）。2026-10-09 加。
 *
 * 为什么需要：`DataTable` 从 2026-10-09 起一律给 `<table>` 加 `data-table-fixed`
 * （components/data/data-table.tsx），`table-layout: fixed` 下**没写宽度的列由浏览器均分**容器宽度；
 * 下面的手写表「成品（按订单号收束）」连 `meta` 都用不上。本页六张表原来一列宽度都没写：
 * 「入库通知 / 订单号 / 包装工序」跟「状态」「已送检」拿到一样宽 —— 长的只能看到开头、
 * 短的留着大片空白。这里把宽度从「按列数均分」改成「按内容需要分配」。
 *
 * 两种总和：
 *   - 四张 `DataTable` 用 `auditColumns()` 追加「创建人 / 最后修改人」（待入库通知 / 成品入库单 /
 *     成品出库通知 / 成品出库单）：那两列是工厂产物，**不给宽度、不改用法**
 *     （`lib/audit-columns-coverage.test.mjs` 有守卫盯着），所以声明总和 = **84%**，
 *     剩下 16% 由浏览器均分给它们各 8%（与仓库首页、物料清单页的先例一致）；
 *   - 「次品」存量（无审计列）与手写表「成品（按订单号收束）」声明总和 = **100%**。
 *
 * 估算基准（与仓库首页同一套）：1366 屏内容宽 1034px（1% = 10.34px）；数据格 Arial 13px
 * + 左右内边距 24px，表头 12px 加粗 + 24px。下面几个数字因此比「数量 / 日期列 4%~6%」的通则宽，
 * 逐条的理由写在该列旁边，主要是三种定长内容：日期的 10 个字符、三字状态、六字表头。
 */
const COLUMN_WIDTH = {
  // —— T9 手写表「成品（按订单号收束）」（5 列，无审计列 → 合计 100%）——
  // 展开行（`balanceRowText`）把「生产单 / 成品名 / 规格」拼进**第一列**，最长的一格在订单号列里，
  // 所以它拿 36%（=372px）；三个数量列各 12%（=124px）是**表头**「成品现存数量」的需要
  // （6 个汉字 = 72px + 24px ≈ 9.3%，给到 10% 以下先把表头截掉）；「明细」装「N 个成品批次 + 展开按钮」。
  balanceOrderNo: "36%",
  balanceStock: "12%",
  balanceInbound: "12%",
  balanceOutbound: "12%",
  balanceDetail: "28%",
  // —— T10「次品」存量（5 列，无审计列 → 合计 100%）——
  // 与销售列表里的存量汇总同形：三个自由文本列（订单号 / 成品 / 规格）拿 86%，
  // 两个短列「类别」（只有成品 / 次品两个值）6%、「存量」8%（数字 + 表头两个字）。
  defectiveOrderNo: "26%",
  defectiveProduct: "32%",
  defectiveSpec: "28%",
  defectiveCategory: "6%",
  defectiveQuantity: "8%",
  // —— T11「待入库通知」（13 列 = 11 业务 + 2 审计 → 业务合计 84%）——
  // 本模块最宽的一张：11 个业务列摊 84%，长文本列（入库通知 / 订单号 / 批次 / 包装工序）各 8%~11%，
  // 数值列 6%~7%（表头「已送检」「QC 合格」本身要 60~66px）。这张表必然靠横向滚动，取舍是
  // 「长文本列不再被数值列挤到 7%」。
  // 「通知日期」9% 是唯一超出「日期列 4%~6%」的一条：`2026-09-01` 定长 10 字符，
  // Arial 13px 下 66.5px + 24px 内边距 = 90.5px ≈ 8.8%，给 6% 会截成「2026-09-…」而分不出日期。
  noticeNo: "11%",
  noticeOrderNo: "9%",
  noticeBatch: "8%",
  noticeOperation: "9%",
  noticeDate: "9%",
  noticeQuantity: "7%",
  noticeSubmitted: "6%",
  noticePendingSubmit: "6%",
  noticeQcQualified: "7%",
  noticeInboundPosted: "6%",
  // 状态 6% 而不是 5%：标签是三个汉字（待送检 / 入库中 / 已完成 / 已取消），要 36px + 24px = 5.8%。
  noticeStatus: "6%",
  // —— T12「成品入库单」（8 列 = 6 业务 + 2 审计 → 业务合计 84%）——
  // 列少、宽度宽裕：三个文本列拿 56%；「状态」10% 装「待入库登记」（5 个汉字 = 84px）；
  // 操作列同时只有 1 个按钮（`inboundColumns` 的 actions 三元：过账或冲销），44px + 24px ≈ 6.6%，给 10% 留余量。
  inboundNo: "16%",
  inboundOrderNo: "14%",
  inboundProduct: "26%",
  inboundQuantity: "8%",
  inboundStatus: "10%",
  inboundActions: "10%",
  // —— T13「成品出库通知（销售发起）」（11 列 = 9 业务 + 2 审计 → 业务合计 84%）——
  // 「成品」（成品名 / 规格拼串）与「出库单」（一张通知对应多张出库单号的拼接串）是两列高风险长文本；
  // 「已出库 / 剩余」的表头本身 6 个汉字 + 斜杠 ≈ 106px，给 11% 才不折表头；
  // 操作列只有一个「生成出库单」（5 个汉字 = 80px + 24px ≈ 10%）。
  outboundNoticeNo: "10%",
  outboundNoticeOrderNo: "9%",
  outboundNoticeCustomer: "8%",
  outboundNoticeProduct: "11%",
  outboundNoticeQuantity: "6%",
  outboundNoticeShipped: "11%",
  outboundNoticeStatus: "10%",
  outboundNoticeOutbound: "9%",
  outboundNoticeActions: "10%",
  // —— T14「成品出库单」（12 列 = 10 业务 + 2 审计 → 业务合计 84%）——
  // 全文件最挤的一张：操作列要 21%（理由见下），其余 9 个业务列只剩 63%，
  // 于是长文本列压到 6%~8%（都还有省略 + hover 全文兜底），金额列按通则保 7%；
  // 「来源通知」是单号（通则要求 ≥8%），1% 从「发货」挪过来 —— 发货是三段拼串，
  // 7% 与 8% 都只能露出开头的日期，而单号是按单号检索用的，按通则给足。
  outboundNo: "8%",
  outboundOrderNo: "8%",
  outboundCustomer: "6%",
  outboundProduct: "8%",
  outboundQuantity: "5%",
  outboundAmount: "7%",
  outboundShipping: "7%",
  outboundNoticeRef: "8%",
  outboundStatus: "6%",
  // 操作列 21%：这一列同时最多渲染 **3** 个按钮（盘点文档写的「最多 5 个」是按 JSX 里 5 个
  // `<Button>` 数出来的，实际有状态互斥）—— draft 是「过账出库 + 取消出库单」2 个，
  // posted / shipped 是「维护发货 + 登记签收 + 冲销」3 个，signed 是「登记签收 + 冲销」2 个。
  // 按钮是 12px 字号的 `ui-button-sm`：四个汉字 68px、两个汉字 44px，最坏一排
  // 68 + 68 + 44 + 2×4px 间距 = 188px，加 24px 内边距 = 212px ≈ 20.5%，21% 刚好一行放得下
  // （给 15% 会折成两行、行高翻倍）。`.action-row` 自带 `flex-wrap`，所以按钮本身不会被裁，
  // 这一列的宽度只决定「一行还是两行」—— 宁可给它 21%，也不让它把九个业务列继续往下压。
  outboundActions: "21%",
} as const;

const number = (value: string | undefined) => Number(value ?? 0);
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
/**
 * 手写表展开行第一格（第 268 行）的文案：`└ 生产单 8 位 / 成品名 / 规格`。
 * 抽成函数是为了让**格子里显示的文字与 hover 的 title 出自同一处** —— 两边各拼一遍，改一处就会漂。
 */
const balanceRowText = (row: Balance) => `└ 生产单 ${row.production_order_id ? row.production_order_id.slice(0, 8) : "-"} / ${row.product_name ?? "-"}${row.product_specification ? ` / ${row.product_specification}` : ""}`;

/**
 * 手写表展开行最后一格的文案（`单位 成品`）—— 这一格显示的是中文而不是 `category` 原值，
 * 所以搜索也按这串字匹配（搜「成品」命中，搜 `finished_goods` 不命中，与眼睛看到的一致）。
 */
const balanceUnitText = (row: Balance) => `单位 ${row.category === "finished_goods" ? "成品" : row.category}`;

/**
 * 「屏幕上那一格的字」与「关键字搜索匹配的字」必须是同一份。
 *
 * 下面这些格子都是**多个字段拼出来的**：数量 + 单位、单价 × 数量 + 币种、
 * 已出库 / 剩余、成品名 + 规格、发货三段拼串……拼法原先只写在列定义里。
 * 搜索若照着抄一遍，改了一边忘了另一边就会变成「屏幕上明明写着 600.00 USD，搜 600 却搜不到」——
 * 这种错没有任何报错、测试也看不见，只有用户会撞上。
 * 抽成函数之后，列定义（`cell` / `accessorFn`）与过滤集都调同一份拼法，键盘上敲的字与眼睛看到的字同源。
 */
const noticeDateText = (row: Notice) => row.noticeDate.slice(0, 10);
const noticeQuantityText = (row: Notice) => `${row.noticeQuantity} ${row.unitNameSnapshot}`;
const outboundQuantityText = (row: Outbound) => `${row.quantity}${row.unit?.name ? ` ${row.unit.name}` : ""}`;
const outboundAmountText = (row: Outbound) => {
  const price = row.salesOrder?.settlementUnitPrice ?? row.salesOrder?.unitPrice;
  return price ? `${(Number(price) * Number(row.quantity)).toFixed(2)} ${row.salesOrder?.currency ?? ""}` : "-";
};
const outboundShippingText = (row: Outbound) => row.shipmentDate ? `${row.shipmentDate.slice(0, 10)}${row.carrier ? ` / ${row.carrier}` : ""}${row.trackingNo ? ` / ${row.trackingNo}` : ""}` : "-";
const outboundNoticeProductText = (row: OutboundNotice) => `${row.productNameSnapshot ?? "-"}${row.productSpecificationSnapshot ? ` / ${row.productSpecificationSnapshot}` : ""}`;
const outboundNoticeQuantityText = (row: OutboundNotice) => `${row.noticeQuantity}${row.unit?.name ? ` ${row.unit.name}` : ""}`;
const outboundNoticeShippedText = (row: OutboundNotice) => `${row.shippedQuantity ?? "0"} / ${row.remaining_quantity ?? "-"}`;

export default function FinishedGoodsStoragePage() {
  const [orderNo, setOrderNo] = useState("");
  const [appliedOrderNo, setAppliedOrderNo] = useState("");
  /**
   * 页面级关键字（2026-11-13，用户：「通览整个项目，统计所有下拉列表，所有表单是否都有搜索功能搜索框，
   * 如果没有，都需要加上搜索功能。因为现在单子多了，查找比较麻烦」）。
   *
   * 与上面的「订单号」筛选是**两件事**，不要合并：
   *   - 订单号筛选（`orderNo` / `appliedOrderNo`）改的是**取数条件** —— 点「筛选」把 order_no 送到后端，
   *     六个接口重新拉一遍，服务端只回这一个订单的数据；
   *   - 这里的 `keyword` 只过滤**已经在手上的行**（本地过滤）：不发请求、不动任何动作按钮，
   *     也不改「待入库」这种业务计数。
   * 所以清空关键字不会触发重新取数，清空订单号筛选也不会把关键字的过滤结果放回去。
   *
   * 六张表共用一个词：仓库找的是「这一单 / 这个成品的库存与单据」，
   * 六张表各给一个框就得让他搜六遍；一个词全打出去，哪个面板的「筛选后 N / M」变了一眼就能看出来。
   */
  const [keyword, setKeyword] = useState("");
  const [finished, setFinished] = useState<Balance[]>([]);
  const [defective, setDefective] = useState<Balance[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [inbounds, setInbounds] = useState<Inbound[]>([]);
  const [outbounds, setOutbounds] = useState<Outbound[]>([]);
  const [outboundNotices, setOutboundNotices] = useState<OutboundNotice[]>([]);
  // 「成品存量」按订单号收束：展开状态记在这里（点击条目展开明细）。
  const [expandedOrders, setExpandedOrders] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> } | null>(null);
  /**
   * 成品出库单的打印视图（2026-11-02）。
   *
   * `slip` 非空 = 打印弹窗已打开；数据来自 `GET /finished-goods/outbounds/:id/slip-document`
   * （与导出 xlsx 同一份组装结果）。**不把单据数据缓存进列表行**：列表接口不带生产单号/客户全名，
   * 缓存在行上就得在列表里塞一堆只为打印服务的字段，而这张纸只有点开时才需要。
   */
  const [slip, setSlip] = useState<FinishedGoodsOutboundSlip | null>(null);
  const [slipLoading, setSlipLoading] = useState(false);
  const [slipError, setSlipError] = useState("");
  /** 正在导出的出库单 id（按钮防重复点击）。 */
  const [exportingSlip, setExportingSlip] = useState("");

  // options.silent：后台刷新（焦点/可见性变化）时不切整页 loading，避免卸载正在编辑的弹窗、清掉用户刚填的内容。
  async function load(targetOrderNo = appliedOrderNo, options: { silent?: boolean } = {}) {
    if (!options.silent) setLoading(true);
    setError("");
    const scope = targetOrderNo ? `?order_no=${encodeURIComponent(targetOrderNo)}` : "";
    try {
      const [finishedResult, defectiveResult, noticeResult, inboundResult, outboundResult, outboundNoticeResult] = await Promise.all([
        apiGet<Balance[]>(`/inventory/balances?category=finished_goods${targetOrderNo ? `&order_no=${encodeURIComponent(targetOrderNo)}` : ""}`),
        apiGet<Balance[]>(`/inventory/balances?category=defective_goods${targetOrderNo ? `&order_no=${encodeURIComponent(targetOrderNo)}` : ""}`),
        apiGet<Notice[]>(`/finished-goods/inbound-notices${scope}`),
        apiGet<Inbound[]>(`/finished-goods/inbounds${scope}`),
        apiGet<Outbound[]>(`/finished-goods/outbounds${scope}`),
        apiGet<OutboundNotice[]>(`/finished-goods/outbound-notices${scope}`),
      ]);
      setFinished(finishedResult.data);
      setDefective(defectiveResult.data);
      setNotices(noticeResult.data);
      setInbounds(inboundResult.data);
      setOutbounds(outboundResult.data);
      setOutboundNotices(outboundNoticeResult.data);
    } catch (cause) {
      setError(messageOf(cause, "成品仓储情况加载失败"));
    } finally {
      if (!options.silent) setLoading(false);
    }
  }

  useEffect(() => { void load(""); }, []);
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState)) void load(undefined, { silent: true }); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [appliedOrderNo]);

  async function run(path: string, body: unknown, success: string, method: "POST" | "PATCH" = "POST") {
    try {
      if (method === "POST") await apiPost(path, body); else await apiRequest(path, { method: "PATCH", body: JSON.stringify(body) });
      notifySuccess(success);
      setDialog(null);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }

  function reverseInbound(row: Inbound) {
    setDialog({ title: `冲销成品入库：${row.inboundNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (values) => void run(`/finished-goods/inbounds/${row.id}/reverse`, { reason: values.reason }, "成品入库已冲销") });
  }

  /** 按销售发起的出库通知生成成品出库单：默认出剩余量，也可以只出一部分（分批出库）。 */
  function createOutboundFromNotice(row: OutboundNotice) {
    const remaining = row.remaining_quantity ?? row.noticeQuantity;
    // 幂等键在打开弹窗时生成一次：同一次提交被重试（网络抖动、重复点击）时复用同一个键，
    // 服务端会返回同一张出库单，而不是按剩余量再建一张草稿。
    const idempotencyKey = `web-notice-outbound-${row.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setDialog({ title: `生成成品出库单：${row.noticeNo}`, fields: [
      { name: "quantity", label: "本次出库数量", type: "number", required: true, defaultValue: remaining, placeholder: `通知 ${row.noticeQuantity}，剩余 ${remaining}（可分批出库）` },
      { name: "confirm", label: `确认出库数量不超过剩余 ${remaining}${row.unit?.name ? ` ${row.unit.name}` : ""}`, required: true, placeholder: "输入 确认 继续" },
    ], submit: async (values) => {
      // 校验失败抛错（而不是 notifyError + return）：ActionDialog 会把异常显示在弹窗内并保留用户已填的值，
      // 用 notifyError 的话弹窗会被立刻关掉，用户手里的数量也跟着丢。
      if (values.confirm?.trim() !== "确认") throw new Error("请输入“确认”以生成出库单");
      await run(`/finished-goods/outbound-notices/${row.id}/create-outbound`, { quantity: values.quantity, idempotency_key: idempotencyKey }, `成品出库单已生成（本次 ${values.quantity}，待过账）`);
    } });
  }

  function editShipping(row: Outbound) {
    setDialog({ title: `维护发货信息：${row.outboundNo}`, fields: [
      { name: "shipment_date", label: "发货日期", type: "date", required: true, defaultValue: row.shipmentDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10) },
      { name: "carrier", label: "承运商", defaultValue: row.carrier ?? undefined },
      { name: "tracking_no", label: "运单号", defaultValue: row.trackingNo ?? undefined },
      { name: "packing_list_no", label: "装箱单号", defaultValue: row.packingListNo ?? undefined },
      { name: "invoice_no", label: "发票号", defaultValue: row.invoiceNo ?? undefined },
    ], submit: (values) => void run(`/finished-goods/outbounds/${row.id}/shipping`, { shipment_date: values.shipment_date, carrier: values.carrier || undefined, tracking_no: values.tracking_no || undefined, packing_list_no: values.packing_list_no || undefined, invoice_no: values.invoice_no || undefined }, "发货信息已保存", "PATCH") });
  }

  function signOutbound(row: Outbound) {
    setDialog({ title: `登记签收：${row.outboundNo}`, fields: [
      { name: "signed_at", label: "签收时间", type: "date", required: true, defaultValue: new Date().toISOString().slice(0, 10) },
      { name: "signature_reference", label: "签收凭证/单号", placeholder: "可选" },
    ], submit: (values) => void run(`/finished-goods/outbounds/${row.id}/sign`, { signed_at: new Date(`${values.signed_at}T00:00:00.000Z`).toISOString(), signature_reference: values.signature_reference || undefined }, "签收已登记") });
  }

  function reverseOutbound(row: Outbound) {
    setDialog({ title: `冲销成品出库：${row.outboundNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (values) => void run(`/finished-goods/outbounds/${row.id}/reverse`, { reason: values.reason }, "成品出库已冲销（来源出库通知退回待处理）") });
  }

  /** 取消未过账的草稿出库单：库存变化导致过账必然失败时的出路，来源通知会退回待处理。 */
  function cancelOutbound(row: Outbound) {
    setDialog({ title: `取消成品出库单：${row.outboundNo}`, fields: [{ name: "reason", label: "取消原因", type: "textarea", required: true, placeholder: "例如：通知数量与库存不一致，需重新通知" }], submit: (values) => void run(`/finished-goods/outbounds/${row.id}/cancel`, { reason: values.reason }, "出库单已取消，来源通知退回待处理") });
  }

  /**
   * 打开出库单的打印视图（2026-11-02）。
   *
   * 打印与导出吃同一份后端组装结果（`slip-document`）：页面上看到的每一个字，导出/打印出来都在；
   * 反过来也一样。任何一项在页面里"顺手补一下"，纸与 Excel 就开始分叉了。
   */
  async function openSlip(row: Outbound) {
    setSlipLoading(true);
    setSlipError("");
    setSlip(null);
    try {
      const result = await apiGet<FinishedGoodsOutboundSlip>(outboundSlipDocumentPath(row.id));
      setSlip(result.data);
    } catch (cause) {
      setSlipError(messageOf(cause, "出库单打印数据加载失败"));
    } finally {
      setSlipLoading(false);
    }
  }

  /** 导出出库单 xlsx（A4 竖版，与打印件同一版式；文件名优先用后端 Content-Disposition 给的）。 */
  async function exportSlip(row: Outbound) {
    setExportingSlip(row.id);
    try {
      await downloadFile(outboundSlipExportPath(row.id), outboundSlipFileName(row.outboundNo));
      notifySuccess(`出库单 ${row.outboundNo} 已导出`);
    } catch (cause) {
      notifyError(messageOf(cause, "出库单导出失败"));
    } finally {
      setExportingSlip("");
    }
  }

  const balanceColumns = [
    { id: "order", header: "订单号", meta: { width: COLUMN_WIDTH.defectiveOrderNo }, cell: ({ row }: { row: { original: Balance } }) => row.original.order_no ?? "-" },
    { id: "product", header: "成品", meta: { width: COLUMN_WIDTH.defectiveProduct }, cell: ({ row }: { row: { original: Balance } }) => row.original.product_name ?? "-" },
    { id: "spec", header: "规格", meta: { width: COLUMN_WIDTH.defectiveSpec }, cell: ({ row }: { row: { original: Balance } }) => row.original.product_specification ?? "-" },
    { accessorKey: "category", header: "类别", meta: { width: COLUMN_WIDTH.defectiveCategory }, cell: ({ row }: { row: { original: Balance } }) => categoryLabels[row.original.category] ?? row.original.category },
    { accessorKey: "quantity", header: "存量", meta: { width: COLUMN_WIDTH.defectiveQuantity } },
  ];
  const noticeColumns = [
    { accessorKey: "noticeNo", header: "入库通知", meta: { width: COLUMN_WIDTH.noticeNo } },
    { accessorKey: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.noticeOrderNo } },
    { id: "batch", header: "批次", meta: { width: COLUMN_WIDTH.noticeBatch }, cell: ({ row }: { row: { original: Notice } }) => row.original.batchNo ?? "-" },
    { accessorKey: "operationNameSnapshot", header: "包装工序", meta: { width: COLUMN_WIDTH.noticeOperation } },
    { id: "date", header: "通知日期", meta: { width: COLUMN_WIDTH.noticeDate }, cell: ({ row }: { row: { original: Notice } }) => noticeDateText(row.original) },
    { id: "quantity", header: "通知数量", meta: { width: COLUMN_WIDTH.noticeQuantity }, cell: ({ row }: { row: { original: Notice } }) => noticeQuantityText(row.original) },
    { accessorKey: "submittedQuantity", header: "已送检", meta: { width: COLUMN_WIDTH.noticeSubmitted } },
    { accessorKey: "availableSubmissionQuantity", header: "待送检", meta: { width: COLUMN_WIDTH.noticePendingSubmit } },
    { accessorKey: "qcQualifiedQuantity", header: "QC 合格", meta: { width: COLUMN_WIDTH.noticeQcQualified } },
    { accessorKey: "inboundPostedQuantity", header: "已入库", meta: { width: COLUMN_WIDTH.noticeInboundPosted } },
    { accessorKey: "status", header: "状态", meta: { width: COLUMN_WIDTH.noticeStatus }, cell: ({ row }: { row: { original: Notice } }) => noticeStatusLabels[row.original.status] ?? row.original.status },
    ...auditColumns<Notice>(),
  ];
  const inboundColumns = [
    { accessorKey: "inboundNo", header: "入库单", meta: { width: COLUMN_WIDTH.inboundNo } },
    { accessorKey: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.inboundOrderNo } },
    { id: "product", header: "成品", meta: { width: COLUMN_WIDTH.inboundProduct }, cell: ({ row }: { row: { original: Inbound } }) => row.original.productNameSnapshot ?? "-" },
    { accessorKey: "quantity", header: "数量", meta: { width: COLUMN_WIDTH.inboundQuantity } },
    { id: "status", header: "状态", meta: { width: COLUMN_WIDTH.inboundStatus }, cell: ({ row }: { row: { original: Inbound } }) => inboundStatusLabels[row.original.status] ?? row.original.status },
    ...auditColumns<Inbound>(),
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.inboundActions }, cell: ({ row }: { row: { original: Inbound } }) => row.original.status === "draft" ? <Button size="sm" onClick={() => void run(`/finished-goods/inbounds/${row.original.id}/post`, {}, "成品入库已过账")}>过账</Button> : row.original.status === "posted" ? <Button size="sm" variant="ghost" onClick={() => reverseInbound(row.original)}>冲销</Button> : null },
  ];
  const outboundColumns = [
    { accessorKey: "outboundNo", header: "出库单", meta: { width: COLUMN_WIDTH.outboundNo } },
    { accessorKey: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.outboundOrderNo }, cell: ({ row }: { row: { original: Outbound } }) => <OrderNoWithOrphan orderNo={row.original.orderNo} orphaned={row.original.orphaned} /> },
    { id: "customer", header: "客户", meta: { width: COLUMN_WIDTH.outboundCustomer }, cell: ({ row }: { row: { original: Outbound } }) => row.original.salesOrder?.customer?.name ?? "-" },
    { id: "product", header: "成品", meta: { width: COLUMN_WIDTH.outboundProduct }, cell: ({ row }: { row: { original: Outbound } }) => row.original.productNameSnapshot ?? "-" },
    { id: "quantity", header: "数量", meta: { width: COLUMN_WIDTH.outboundQuantity }, cell: ({ row }: { row: { original: Outbound } }) => outboundQuantityText(row.original) },
    { id: "amount", header: "应收金额", meta: { width: COLUMN_WIDTH.outboundAmount }, cell: ({ row }: { row: { original: Outbound } }) => outboundAmountText(row.original) },
    { id: "shipping", header: "发货", meta: { width: COLUMN_WIDTH.outboundShipping }, cell: ({ row }: { row: { original: Outbound } }) => outboundShippingText(row.original) },
    { id: "notice", header: "来源通知", meta: { width: COLUMN_WIDTH.outboundNoticeRef }, cell: ({ row }: { row: { original: Outbound } }) => row.original.outboundNotice?.noticeNo ?? "-" },
    { id: "status", header: "状态", meta: { width: COLUMN_WIDTH.outboundStatus }, cell: ({ row }: { row: { original: Outbound } }) => outboundStatusLabels[row.original.status] ?? row.original.status },
    ...auditColumns<Outbound>(),
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.outboundActions }, cell: ({ row }: { row: { original: Outbound } }) => <div className="action-row">{/* 出库单（打印）/ 导出（2026-11-02）：任何状态都能出纸 —— 草稿、已冲销也常常要打一张留档，纸面上会写清状态 */}<Button size="sm" variant="secondary" data-testid={`outbound-slip-${row.original.outboundNo}`} onClick={() => void openSlip(row.original)}>出库单</Button><Button size="sm" variant="secondary" disabled={exportingSlip === row.original.id} data-testid={`outbound-export-${row.original.outboundNo}`} onClick={() => void exportSlip(row.original)}>{exportingSlip === row.original.id ? "导出中…" : "导出"}</Button>{row.original.status === "draft" ? <Button size="sm" onClick={() => void run(`/finished-goods/outbounds/${row.original.id}/post`, {}, "成品出库已过账（已生成应收来源，等待财务收款）")}>过账出库</Button> : null}{row.original.status === "draft" ? <Button size="sm" variant="ghost" onClick={() => cancelOutbound(row.original)}>取消出库单</Button> : null}{["posted", "shipped"].includes(row.original.status) ? <Button size="sm" variant="secondary" onClick={() => editShipping(row.original)}>维护发货</Button> : null}{["posted", "shipped", "signed"].includes(row.original.status) ? <Button size="sm" variant="secondary" onClick={() => signOutbound(row.original)}>登记签收</Button> : null}{["posted", "shipped", "signed"].includes(row.original.status) ? <Button size="sm" variant="ghost" onClick={() => reverseOutbound(row.original)}>冲销</Button> : null}</div> },
  ];
  const outboundNoticeColumns = [
    { accessorKey: "noticeNo", header: "出库通知", meta: { width: COLUMN_WIDTH.outboundNoticeNo } },
    { accessorKey: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.outboundNoticeOrderNo }, cell: ({ row }: { row: { original: OutboundNotice } }) => <OrderNoWithOrphan orderNo={row.original.orderNo} orphaned={row.original.orphaned} /> },
    { id: "customer", header: "客户", meta: { width: COLUMN_WIDTH.outboundNoticeCustomer }, cell: ({ row }: { row: { original: OutboundNotice } }) => row.original.salesOrder?.customer?.name ?? "-" },
    { id: "product", header: "成品", meta: { width: COLUMN_WIDTH.outboundNoticeProduct }, cell: ({ row }: { row: { original: OutboundNotice } }) => outboundNoticeProductText(row.original) },
    { id: "quantity", header: "通知数量", meta: { width: COLUMN_WIDTH.outboundNoticeQuantity }, cell: ({ row }: { row: { original: OutboundNotice } }) => outboundNoticeQuantityText(row.original) },
    { id: "shipped", header: "已出库 / 剩余", meta: { width: COLUMN_WIDTH.outboundNoticeShipped }, cell: ({ row }: { row: { original: OutboundNotice } }) => outboundNoticeShippedText(row.original) },
    { id: "status", header: "状态", meta: { width: COLUMN_WIDTH.outboundNoticeStatus }, cell: ({ row }: { row: { original: OutboundNotice } }) => outboundNoticeStatusLabels[row.original.status] ?? row.original.status },
    { id: "outbound", header: "出库单", meta: { width: COLUMN_WIDTH.outboundNoticeOutbound }, cell: ({ row }: { row: { original: OutboundNotice } }) => row.original.outbound_summary || "-" },
    ...auditColumns<OutboundNotice>(),
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.outboundNoticeActions }, cell: ({ row }: { row: { original: OutboundNotice } }) => ["pending", "outbound_created", "partially_outbound"].includes(row.original.status) && Number(row.original.remaining_quantity ?? row.original.noticeQuantity) > 0 ? <Button size="sm" onClick={() => createOutboundFromNotice(row.original)}>生成出库单</Button> : row.original.status === "cancelled" ? <span>已取消</span> : <span>已发完</span> },
  ];
  // 待入库 = 还有「可送检额度」或「在途入库」的通知。不用 remainingForInbound：QC 不合格的部分永远不会入库，
  // 按通知量减已入库会把这类通知永久算成待办。
  const pendingNoticeCount = notices.filter((row) => row.status !== "cancelled" && (number(row.availableSubmissionQuantity) > 0 || number(row.inboundDraftQuantity) > 0)).length;
  // 成品存量按订单号收束成一条（客户反馈：订单一多整张表很冗长），点开才看该订单下的明细。
  // 现存 = 库存事实余额；已入库/已出库只算已过账（草稿/已冲销/已取消不算）。
  const finishedGroups = useMemo(() => {
    const groups = new Map<string, { orderNo: string; stock: number; inbound: number; outbound: number; rows: Balance[] }>();
    for (const row of finished) {
      const orderNo = row.order_no ?? "（无订单号）";
      const group = groups.get(orderNo) ?? { orderNo, stock: 0, inbound: 0, outbound: 0, rows: [] };
      group.stock += number(row.quantity);
      group.rows.push(row);
      groups.set(orderNo, group);
    }
    for (const row of inbounds) {
      if (row.status !== "posted") continue;
      const orderNo = row.orderNo ?? "（无订单号）";
      const group = groups.get(orderNo) ?? { orderNo, stock: 0, inbound: 0, outbound: 0, rows: [] };
      group.inbound += number(row.quantity);
      groups.set(orderNo, group);
    }
    for (const row of outbounds) {
      if (!["posted", "shipped", "signed"].includes(row.status)) continue;
      const orderNo = row.orderNo ?? "（无订单号）";
      const group = groups.get(orderNo) ?? { orderNo, stock: 0, inbound: 0, outbound: 0, rows: [] };
      group.outbound += number(row.quantity);
      groups.set(orderNo, group);
    }
    return [...groups.values()].sort((left, right) => left.orderNo.localeCompare(right.orderNo));
  }, [finished, inbounds, outbounds]);
  const toggleGroup = (orderNo: string) => setExpandedOrders((current) => ({ ...current, [orderNo]: !current[orderNo] }));

  /**
   * 六张表的本地过滤结果（`keyword` 非空时才过滤；空查询不过滤、一列都不动，见 lib/fuzzy-search.ts）。
   *
   * 三条规矩，六张表都一样：
   *   ① **只匹配这张表屏幕上看得见的列** —— 审计列（创建人 / 最后修改人）与「操作」列不参与：
   *      前者是工厂追加的两列、每个面板都一样，搜「张三」六张表全命中等于没筛；
   *      后者是按钮文案（「过账」「冲销」），匹配它只会让「搜冲销」把所有已过账单都留出来。
   *   ② 状态、类别、日期这类**中文化之后**才显示的原值，按中文字匹配（`noticeStatusLabels[...]`），
   *      不能按 `posted` / `defective_goods` 去匹配 —— 屏幕上没有这些字，用户不会那样敲。
   *   ③ 派生格（金额、发货、已出库 / 剩余…）走与列定义**同一个**拼串函数（见文件上方那组 `xxxText`），
   *      否则「屏幕上写着 600.00 USD、搜 600 搜不到」。
   */
  const query = keyword.trim();
  /**
   * 「成品（按订单号收束）」的过滤以**组**为单位。
   *
   * 为什么组内每个批次的字段也参与匹配：成品名与规格只出现在展开行里，而收束行默认是**收起**的。
   * 只按收束行那几格的字面匹配的话，「搜成品名 → 没有匹配」——可页面上明明有这个成品（收在组里），
   * 而那正是用户找的东西（「这个成品的库存」）。所以组内批次的生产单号 / 成品名 / 规格 / 数量也参与。
   * 生产单号完整值也放进来：屏幕上只显示前 8 位（见 `balanceRowText`），但从别处整条复制过来的
   * 生产单号粘进搜索框时也得能命中，否则第一反应就是「搜索坏了」。
   *
   * 命中后整组显示、展开行照原样列出（**不再在组内二次过滤**）：组内再筛一遍会出现
   * 「它说 N 个成品批次，点开一条都不显示」，看起来比不筛更坏。三个数量仍是整张订单的聚合值，
   * 不随关键字变化 —— 它是「这一单的账」，不是「屏幕上这几行的和」。
   */
  const visibleFinishedGroups = useMemo(() => query ? finishedGroups.filter((group) => fuzzyMatch(query, [
    group.orderNo, group.stock, group.inbound, group.outbound, `${group.rows.length} 个成品批次`,
    ...group.rows.flatMap((row) => [row.production_order_id, balanceRowText(row), row.quantity, balanceUnitText(row)]),
  ])) : finishedGroups, [finishedGroups, query]);
  /** 次品存量：订单号 / 成品 / 规格 / 类别 / 存量。 */
  const visibleDefective = useMemo(() => query ? defective.filter((row) => fuzzyMatch(query, [
    row.order_no, row.product_name, row.product_specification, categoryLabels[row.category] ?? row.category, row.quantity,
  ])) : defective, [defective, query]);
  /** 待入库通知：入库通知 / 订单号 / 批次 / 包装工序 / 通知日期 / 通知数量 / 已送检 / 待送检 / QC 合格 / 已入库 / 状态。 */
  const visibleNotices = useMemo(() => query ? notices.filter((row) => fuzzyMatch(query, [
    row.noticeNo, row.orderNo, row.batchNo, row.operationNameSnapshot, noticeDateText(row), noticeQuantityText(row),
    row.submittedQuantity, row.availableSubmissionQuantity, row.qcQualifiedQuantity, row.inboundPostedQuantity,
    noticeStatusLabels[row.status] ?? row.status,
  ])) : notices, [notices, query]);
  /** 成品入库单：入库单 / 订单号 / 成品 / 数量 / 状态。 */
  const visibleInbounds = useMemo(() => query ? inbounds.filter((row) => fuzzyMatch(query, [
    row.inboundNo, row.orderNo, row.productNameSnapshot, row.quantity, inboundStatusLabels[row.status] ?? row.status,
  ])) : inbounds, [inbounds, query]);
  /** 成品出库通知（销售发起）：出库通知 / 订单号 / 客户 / 成品 / 通知数量 / 已出库·剩余 / 状态 / 出库单。 */
  const visibleOutboundNotices = useMemo(() => query ? outboundNotices.filter((row) => fuzzyMatch(query, [
    row.noticeNo, row.orderNo, row.salesOrder?.customer?.name, outboundNoticeProductText(row),
    outboundNoticeQuantityText(row), outboundNoticeShippedText(row),
    outboundNoticeStatusLabels[row.status] ?? row.status, row.outbound_summary,
  ])) : outboundNotices, [outboundNotices, query]);
  /** 成品出库单：出库单 / 订单号 / 客户 / 成品 / 数量 / 应收金额 / 发货 / 来源通知 / 状态。 */
  const visibleOutbounds = useMemo(() => query ? outbounds.filter((row) => fuzzyMatch(query, [
    row.outboundNo, row.orderNo, row.salesOrder?.customer?.name, row.productNameSnapshot, outboundQuantityText(row),
    outboundAmountText(row), outboundShippingText(row), row.outboundNotice?.noticeNo, outboundStatusLabels[row.status] ?? row.status,
  ])) : outbounds, [outbounds, query]);

  if (loading && !finished.length && !notices.length) return <LoadingState label="正在加载成品仓储情况" />;
  if (error && !finished.length && !notices.length) return <ErrorState message={error} onRetry={() => void load()} />;

  return <div className="page-root" data-testid="page-warehouse-finished-goods-storage">
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
    <PageHeader title="成品仓储情况">
      <Button asChild variant="secondary"><Link href="/warehouse">返回仓库</Link></Button>
      <Button variant="ghost" onClick={() => void load()}>刷新</Button>
    </PageHeader>
    {error && <section className="panel panel-body status-error" role="alert">{error}</section>}
    {/*
      服务端订单号筛选（原样保留，2026-09 就有）：点「筛选」把 order_no 送到后端，六个接口重新取数。
      它不是搜索框 —— 只能按订单号、且必须点按钮。别把下面那个 `keyword` 并进这里：
      一个是「换一批数据」，一个是「在这批数据里找一行」，混在一起会出现
      「搜一个成品名 → 六个接口都白查一遍、全部返回 0 条」。
    */}
    <section className="panel">
      <div className="panel-body filter-bar">
        <label>订单号 <Input value={orderNo} onChange={(event) => setOrderNo(event.target.value)} placeholder="可选，留空看全部" /></label>
        <Button variant="secondary" onClick={() => { setAppliedOrderNo(orderNo.trim()); void load(orderNo.trim()); }}>筛选</Button>
      </div>
    </section>
    {/*
      关键字搜索（2026-11-13，用户：「……所有表单是否都有搜索功能搜索框，如果没有，都需要加上搜索功能。
      因为现在单子多了，查找比较麻烦」）。一个词同时过滤下面六张表 —— 仓库找的是
      「这一单 / 这个成品的库存与单据」，六张表各给一个框就得让他搜六遍。
      只改「显示哪些行」：不发请求、不动任何动作按钮、也不改「待入库 N」这种业务计数。
    */}
    <section className="panel panel-body">
      <div className="filter-bar">
        <label>搜索订单号、成品、单号或状态<Input data-testid="finished-goods-search" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入关键词，空格分隔多个词" /></label>
        {query ? <Button variant="secondary" onClick={() => setKeyword("")}>清除搜索</Button> : null}
      </div>
      <p className="panel-note">
        本地过滤，只影响下面六张表显示的行（不发请求、不改上面的「订单号」筛选，那个才是重新取数）。
        按空格分词，所有词都要命中；匹配的是每张表当前看得见的列（「操作」与审计列除外），
        状态按中文（如「已冲销」）匹配，不必输入 posted / reversed 这种原值。
      </p>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>成品存量</h2><span className="panel-note">按订单号收束（展开到生产单/成品规格），存量口径见下表说明</span>{query ? <span className="panel-note" data-testid="finished-goods-search-count-stock">成品 筛选后 {visibleFinishedGroups.length} / {finishedGroups.length} 条 · 次品 筛选后 {visibleDefective.length} / {defective.length} 条</span> : null}</div>
      <div className="panel-body">
        <h3>成品（按订单号收束，点击条目展开明细）</h3>
        <p className="panel-note">
          三个数不是同一个口径，不满足「现存 = 已入库 − 已出库」属正常：
          现存数量取库存事实余额（入库过账 − 出库过账 + 客户退货回仓 − 转次品/冲销）；
          已入库 / 已出库是单据口径（只统计已过账的入库单与已过账/已发出/已签收的出库单，
          不含退货回仓与转次品）。要对账请以「现存数量」为准。
        </p>
        {/*
          这是**手写** `<table>`（有分组展开行，换成 `DataTable` 会丢掉展开能力），拿不到 `meta` 那套，
          所以照 globals.css 里 `.table-bounded` 那段注释的三件事办：
          ①表上加 `table-bounded`（= 拿到固定布局 + `overflow: hidden`）；
          ②每列显式给宽度（fixed 布局下没给宽度的列会被均分），取 `COLUMN_WIDTH.balance*`，总和 100%；
          ③长文本格自己写 `cell-ellipsis` + `title`（手写表没有 DataTable 那套自动 title）。
          展开行第一格（`balanceRowText(row)`）是「生产单 / 成品名 / 规格」三个字段的拼串、也是本表最长的一格，
          所以它带 `cell-ellipsis` + `title`；收束行第一格装的是链接按钮，按 data-table.tsx 的同一口径
          **不给** `cell-ellipsis`（按钮是原子内联盒，省略号根本不会出现，只会被 `overflow: hidden` 无声裁掉），
          改为在格子上挂 `title`，悬停看完整订单号。
        */}
        <div className="table-wrap"><table className="ui-table table-bounded">
          <thead><tr><th className="ui-table-head" style={{ width: COLUMN_WIDTH.balanceOrderNo }}>订单号</th><th className="ui-table-head" style={{ width: COLUMN_WIDTH.balanceStock }}>成品现存数量</th><th className="ui-table-head" style={{ width: COLUMN_WIDTH.balanceInbound }}>已入库数量</th><th className="ui-table-head" style={{ width: COLUMN_WIDTH.balanceOutbound }}>已出库数量</th><th className="ui-table-head" style={{ width: COLUMN_WIDTH.balanceDetail }}>明细</th></tr></thead>
          <tbody>
            {visibleFinishedGroups.length ? visibleFinishedGroups.map((group) => <Fragment key={group.orderNo}>
              <tr className="ui-table-row">
                <td className="ui-table-cell" title={group.orderNo}><Button size="sm" variant="link" aria-expanded={Boolean(expandedOrders[group.orderNo])} onClick={() => toggleGroup(group.orderNo)}>{group.orderNo}</Button></td>
                <td className="ui-table-cell">{group.stock}</td>
                <td className="ui-table-cell">{group.inbound}</td>
                <td className="ui-table-cell">{group.outbound}</td>
                <td className="ui-table-cell">{group.rows.length} 个成品批次 <Button size="sm" variant="ghost" onClick={() => toggleGroup(group.orderNo)}>{expandedOrders[group.orderNo] ? "收起" : "展开"}</Button></td>
              </tr>
              {expandedOrders[group.orderNo] ? group.rows.map((row, index) => <tr className="ui-table-row" key={`${group.orderNo}-${row.production_order_id ?? "none"}-${index}`}>
                <td className="ui-table-cell cell-ellipsis" title={balanceRowText(row)}>{balanceRowText(row)}</td>
                <td className="ui-table-cell">{row.quantity}</td>
                <td className="ui-table-cell">-</td>
                <td className="ui-table-cell">-</td>
                <td className="ui-table-cell">{balanceUnitText(row)}</td>
              </tr>) : null}
            </Fragment>) : <tr><td className="ui-table-cell" colSpan={5}>
              {/* 手写表没有 DataTable 的 `empty`，空态由这里给：有查询时说「没有匹配」并给出总数，
                  没查询时才说「暂无」—— 两句话混用会让用户以为这批成品真的没有数据。 */}
              {query
                ? <EmptyState title={`没有匹配“${query}”的成品存量`} description={`共 ${finishedGroups.length} 个订单，换个关键词或点「清除搜索」看全部。`} />
                : <EmptyState title="暂无成品存量" description="成品入库过账后这里会出现存量。" />}
            </td></tr>}
          </tbody>
        </table></div>
        <h3>次品</h3>
        {/*
          次品空态同样分两种：`query` 非空说「没有匹配」，否则说「暂无」。
          注意判断**不能**用 `visibleDefective.length === 0`：次品本来就一条都没有时，
          那句话会变成「没有匹配“xx”」，用户会一直换关键词找一个根本不存在的东西。
        */}
        <DataTable
          columns={balanceColumns}
          data={visibleDefective}
          empty={query
            ? <EmptyState title={`没有匹配“${query}”的次品存量`} description={`共 ${defective.length} 条，换个关键词或点「清除搜索」看全部。`} />
            : <EmptyState title="暂无次品存量" />}
        />
      </div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>待入库通知 <span className="status-warning">{pendingNoticeCount}</span></h2><span className="panel-note">生产按包装工序累计报工分批通知；仓库按通知送检 → 质检 → 入库</span>{query ? <span className="panel-note" data-testid="finished-goods-search-count-notices">筛选后 {visibleNotices.length} / {notices.length} 条</span> : null}</div>
      <div className="panel-body"><DataTable columns={noticeColumns} data={visibleNotices} empty={query ? <EmptyState title={`没有匹配“${query}”的入库通知`} description={`共 ${notices.length} 条，换个关键词或点「清除搜索」看全部。`} /> : <EmptyState title="暂无入库通知" description="生产在【生产单详情 → 成品存量与入库通知】按包装工序累计量发通知。" />} /></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>质检合格待入库 / 次品登记</h2><div className="page-actions"><Button size="sm" variant="secondary" asChild><Link href="/qc">进入质检模块</Link></Button></div></div>
      <div className="panel-body"><p className="panel-note">按 QC 合格量登记成品入库、按不合格量登记次品，以及次品记录的过账/冲销，已整体迁到【质检】模块；本页保留成品入库单的过账与冲销。</p></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>成品入库单</h2>{query ? <span className="panel-note" data-testid="finished-goods-search-count-inbounds">筛选后 {visibleInbounds.length} / {inbounds.length} 条</span> : null}</div>
      <div className="panel-body"><DataTable columns={inboundColumns} data={visibleInbounds} empty={query ? <EmptyState title={`没有匹配“${query}”的成品入库单`} description={`共 ${inbounds.length} 条，换个关键词或点「清除搜索」看全部。`} /> : <EmptyState title="暂无成品入库单" />} /></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>成品出库通知（销售发起）</h2><span className="panel-note">销售在销售订单页「通知仓库出库」后出现在这里；点「生成出库单」可按剩余量分批出库，每次过账后自动生成应收来源并通知财务收款</span>{query ? <span className="panel-note" data-testid="finished-goods-search-count-outbound-notices">筛选后 {visibleOutboundNotices.length} / {outboundNotices.length} 条</span> : null}</div>
      <div className="panel-body"><DataTable columns={outboundNoticeColumns} data={visibleOutboundNotices} empty={query ? <EmptyState title={`没有匹配“${query}”的成品出库通知`} description={`共 ${outboundNotices.length} 条，换个关键词或点「清除搜索」看全部。`} /> : <EmptyState title="暂无出库通知" description="成品入库后由销售在【销售 → 打开销售单 → 成品入库与出库】通知仓库出库。" />} /></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>成品出库单</h2><span className="panel-note">支持分批出库（单张数量 ≤ 当前成品可用量）；每次过账自动生成应收来源草稿，财务在「应收来源」确认并核销收款。每行可「出库单」打印（A4 竖版，浏览器打印 / 另存 PDF）或「导出」Excel。</span>{query ? <span className="panel-note" data-testid="finished-goods-search-count-outbounds">筛选后 {visibleOutbounds.length} / {outbounds.length} 条</span> : null}</div>
      <div className="panel-body"><DataTable columns={outboundColumns} data={visibleOutbounds} empty={query ? <EmptyState title={`没有匹配“${query}”的成品出库单`} description={`共 ${outbounds.length} 条，换个关键词或点「清除搜索」看全部。`} /> : <EmptyState title="暂无成品出库单" description="生成出库单后在这里过账、维护发货、签收，也能打印/导出单张出库单。" />} /></div>
    </section>
    {/*
      出库单打印视图（2026-11-02）：屏幕上就是这张纸，打印时页面上只留它（globals.css 的 @media print）。
      数据与导出的 xlsx 同源（`slip-document`）；加载与失败都在弹窗里说明，不弹一个 toast 就把人挡在门外 ——
      仓库打不出这张单，货就发不出去。
    */}
    <Dialog open={slipLoading || Boolean(slip) || Boolean(slipError)} onOpenChange={(open) => { if (!open) { setSlip(null); setSlipError(""); setSlipLoading(false); } }}>
      <DialogContent className="outbound-slip-dialog" data-testid="outbound-slip-dialog">
        <DialogHeader><DialogTitle>成品出库单打印</DialogTitle></DialogHeader>
        <DialogBody>
          {slipLoading ? <LoadingState label="正在生成出库单" /> : slipError ? <ErrorState message={slipError} /> : slip ? <FinishedGoodsOutboundSlipSheet slip={slip} /> : null}
        </DialogBody>
        <DialogFooter>
          <div className="action-row">
            <Button variant="secondary" onClick={() => { setSlip(null); setSlipError(""); }}>关闭</Button>
            {/* 浏览器打印就是出纸方式（与记账凭证纸/跨行转账单同一做法）：@media print 只留 .outbound-slip-sheet。 */}
            <Button data-testid="outbound-slip-print" disabled={!slip} onClick={() => window.print()}>打印 / 另存 PDF</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
