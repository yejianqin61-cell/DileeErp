"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { apiGet, apiPatch, apiPost, ApiClientError } from "../../lib/api-client";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DataTable } from "../data/data-table";
import { auditColumns, type AuditRow } from "../data/audit-columns";
import { EmptyState } from "../feedback/states";
import { emitQcDataChanged, subscribeQcDataChanged } from "./qc-refresh";
import { notifyError, notifySuccess } from "../ui/toaster";

type Source = AuditRow & { source_id: string; source_type: string; order_no: string; production_order_no: string; production_order_id: string; unit: string; available_quantity: string; source_status: string; product_name?: string; product_specification?: string; notice_id?: string; notice_no?: string; batch_no?: string | null; packaging_operation_name?: string };
type QcRecord = AuditRow & { qc_id: string; qc_no: string; order_no: string; submission_id: string; status?: string; source_type: string; source_id: string; unit?: string; qualified_quantity: string; conditional_accept_quantity: string; rejected_quantity?: string; available_for_inbound_quantity: string; conditionally_accepted: boolean; inspected_quantity?: string; inspection_date?: string; rejection_reason?: string | null; available_for_correction?: boolean };
type SubmissionQcRecord = { id: string; conclusion: string; inspectedQuantity: string };
// 2026-11-07：listSubmissions 新增两个只读字段（累计已检 / 待检），供「待质检（全部订单）」列表直接展示。
// 前端不自己从 qcRecords 求和：累计口径只允许服务端一份实现，否则会出现「列表说还能检 2，点进去说超量」。
type Submission = AuditRow & { id: string; submissionNo: string; orderNo: string; productionOrderId?: string; productionOrderNoSnapshot?: string; sourceType: string; sourceId: string; submittedQuantity: string; inspectedQuantity?: string; pendingQuantity?: string; submissionDate?: string; remark?: string | null; version?: number; status: string; unitNameSnapshot: string; productNameSnapshot?: string; productSpecificationSnapshot?: string | null; qcRecords: SubmissionQcRecord[] };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void };
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
// 厂内成品送检来源已改为「成品入库通知」（按包装工序累计报工量分批通知）；历史 in_house_completion 单据仍按厂内完工显示。
const sourceLabel = (value: string) => value === "finished_goods_inbound_notice" ? "成品入库通知" : value === "in_house_completion" ? "厂内完工（历史）" : "外加工回厂";
// 「待质检（全部订单）」的行集（设计 2026-11-07 §2.1）：已提交待检 / 部分已检。草稿、已检完、已作废都不进队列。
const PENDING_QC_STATUSES = ["submitted", "inspecting"];
// 队列里的状态词与订单详情不同：这里给质检员看的是「这张单现在该不该我去检」，所以用中文状态词。
const pendingStatusLabel = (status: string) => status === "submitted" ? "待质检" : status === "inspecting" ? "质检中" : status;

/**
 * 成品质检「订单详情」里三张表的声明列宽（T21 成品来源 10 列 / T22 送检记录 8 列 / T23 质检记录 13 列，
 * 盘点见 docs/design/table-column-width-audit-2026-10-09/C-生产与质检.md）。
 *
 * 三张表叠在同一个 `.panel-body` 里（289 行），宽度基准完全相同：**三张都写宽度，列边界才互相对齐** ——
 * 只给其中一张写，另外两张仍会按内容重新分配，看起来就是三张表的表头错位（盘点文档 T21 备注）。
 *
 * 三张表都用 `auditColumns()`，工厂产出的「创建人 / 最后修改人」两列**不给宽度**（`lib/audit-columns-coverage.test.mjs`
 * 盯着这个用法，不要改成逐列加 meta），所以每张表的数字**总和都是 84%**，剩下 16% 由浏览器均分给那两列
 * （约 8% 一列，够放「姓名 + 时间」两行 —— 与物料清单页给这两列各 8% 的口径一致）。
 * 改数字前先算总和：不等于 84% 时缺口会被摊到那两列以外，长文本列又会被重新挤窄。
 *
 * 每个数字的来历（估算基准：1366 屏内容宽 1034px；`.ui-table-cell` 是 `padding: 12px`，所以一列真正能
 * 写字的宽度 = 百分比 × 1034 − 24px；字号 13px，一个中文字约 13px、一个数字约 7.2px）：
 *
 * T21 成品来源（8 列写宽度，总和 84%）
 *   - 生产单 14%（145px / 可用 121px）：编号型文本（`PO-20261009-001` 这类 15 字符 ≈108px）够一行；
 *   - 来源 10%（103px / 79px）：「成品入库通知」6 个中文字 ≈78px，是三档标签里最长的一档，刚好放得下；
 *   - 入库通知/批次 20%（207px / 183px）：`通知单号 / 批次号` 拼接（279 行），盘点文档点名它是这张表
 *     「最容易变宽的一格」，余量集中给它（`FGIN-001 / B-01` 只占约 100px，留的是长通知单号的余地）；
 *   - 包装工序 11%（114px / 90px）：工序名（2~6 字）；
 *   - 可送检数量 6%（62px / 38px）：数量列按 4%~6% 取值。表头「可送检数量」5 字 ≈60px 放不下 ——
 *     表头自带省略号 + hover 全文（data-table.tsx:126 给表头也挂 `title`），这是刻意取舍；
 *   - 单位 5%（52px / 28px）、状态 6%（62px / 38px）：1~2 字的单位与短状态词；
 *   - 操作 12%（124px / 100px）：这一列最多 1 个按钮（`创建送检` 4 字 ≈52px + 按钮内边距 ≈20px = 72px）。
 *     按「每个小按钮 44px + 间距 4px」估只占 44px（≈4.3%），低于规则下限 8%，所以取 12% ——
 *     按钮不会贴到省略边界。
 *
 * T22 送检记录（6 列写宽度，总和 84%）
 *   - 送检单 15%（155px / 131px）：编号型文本（`FGIS-001`），够显示前缀 + 序号；
 *   - 来源 21%（217px / 193px）：`来源标签 / sourceId`（280 行），sourceId 是 36 字符 UUID，一定看不全 ——
 *     按盘点文档给上限，靠省略 + hover 看全；
 *   - 成品 20%（207px / 183px）：`产品名 / 规格型号` 两个快照字段拼接，长度同样不可控；
 *   - 送检数量 6%（62px / 38px）、状态 6%：`100 件` 与短状态词（数量按 4%~6%）；
 *   - 操作 16%（165px / 141px）：`draft` / `submitted` 行最多同时 3 个按钮（编辑 / 提交送检 / 取消送检），
 *     按「每个 44px + 间距 4px」= 3×44 + 2×4 = 140px，刚好 16%。真实按钮比 44px 宽时 `.action-row`
 *     （globals.css:134 带 `flex-wrap`）折成两行 —— 同「领料单 / 补料单」页「不把整张表的 1/3 让给操作列」的取舍。
 *
 * T23 质检记录（11 列写宽度，总和 84%）
 *   - 质检单 10%（103px / 79px）、订单号 10%：两个编号/单号文本，够显示前缀（省略 + hover 看全文）；
 *   - 送检记录 7%（72px / 48px）：这一格直接渲染 `submission_id`（36 字符 UUID，一定看不全），
 *     按盘点文档取 6%~7% 的**上限**；这一列是 `accessorKey`（281 行），所以 DataTable 能从取值层拿到 `title`，
 *     hover 时能看到完整 UUID（若是 `id` + 自定义 `cell` 就必须改成 `accessorFn` 或自己在容器上写 title）；
 *   - 来源类型 8%（83px / 59px）：「成品入库通知」比列宽长，省略 + hover；
 *   - 检验日期 6%（62px / 38px）：日期按 4%~6% 取上限，`2026-10-09` ≈66px 会被省略，hover 看全文；
 *   - 合格数量 / 条件接收 / 不合格 / 可入库数量（净值）各 5%（52px / 28px）：数字列 4%~6%；
 *     表头「可入库数量（净值）」9 字 ≈108px 放不下，同样靠表头省略 + hover；
 *   - 单位 4%（41px / 17px）：一个字宽的单位；
 *   - 操作 19%（196px / 172px）：`available_for_correction === false` 的行渲染整句
 *     「已有入库/次品事实，不可更正」（12 个中文字 × 13px ≈156px，`.panel-note` 实际是 12px 字号 ≈144px，
 *     再加斜杠 / 逗号约 162px）。
 *     这一格是 ReactNode、取不到 `title`（data-table.tsx:88-90），裁掉就再也看不到 —— 必须放得下整句，
 *     所以给 19%，代价是常见的单个「更正」按钮旁边会留一片空白。
 *
 * 没有任何一列写 `ellipsis: true`：2026-10-09 起 DataTable 默认就对文本格做「省略 + hover 看全文」。
 * 两个「操作」列是按钮 / 说明文字（ReactNode），取不到 title 因此自动不带 `cell-ellipsis`，
 * `nowrap` 不会把折行的按钮裁掉，所以也不需要写 `ellipsis: false`。
 *
 * 上面几张 `id` + 自定义 `cell` 的拼接连（成品来源的 来源 / 入库通知·批次 / 包装工序，送检记录的 来源 / 成品 / 送检数量，
 * 质检记录的 来源类型 / 检验日期 / 不合格 / 单位）改用 `accessorFn` 把**屏幕上显示的那串字本身**作为取值 ——
 * 这类列原本没有可回退的值，DataTable 给不出 hover title（data-table.tsx:83-86 的两种情况），
 * 宽度一收窄就永久看不到被裁掉的部分。渲染结果与改前逐字一致，只是补上了 title 这一层。
 *
 * T24 待质检（全部订单）（2026-11-07 新增，10 列写宽度，总和 84%，另 16% 给 `auditColumns()`）
 *
 * 估算基准改按**视觉复核出问题的那一档 1440 屏**：表可用宽 1108px（视口 1440 − 侧栏 232 − 内容区
 * 内边距 64 − 面板内边距 32 − 两层边框 4）；`.ui-table-cell` 的 padding 是 12px×2，所以一列真正能写字的
 * 宽度 = 百分比 × 1108 − 24px。长文本列本来就走「省略 + hover title」，但表头同样带省略号 ——
 * 「已检数量 / 待检数量」是质检员最关心的两个数，**表头必须完整可读**，所以这一版把这两列从 6% 提到 8%：
 *
 *   - 已检 / 待检各 8%（约 89px / 可用 65px）：「已检数量」4 个汉字 ≈52px，65px 放得下（1440 截图里
 *     6% 时只有约 66px / 可用 42px，被截成「已检…」「待检…」，2026-11-07 视觉复核）；
 *     代价是送检单 / 生产单 / 成品 / 来源各让 1% —— 那四列本来就靠省略 + hover title 看全文，让 1% 不影响识别；
 *   - 送检单 9%（100px / 76px）：编号型文本（`FGIS-20261107-0001`），省略 + hover 看全；
 *   - 订单号 8%（89px / 65px）：识别一行的第一眼信息，单号长度可控，65px 够显示 8~9 个数字；
 *   - 生产单 9%（100px / 76px）：编号型文本，缺货/换线时按它找人，省略 + hover；
 *   - 成品 11%（122px / 98px）：`产品名 / 规格型号` 两个快照拼接，长度不可控 —— 余量仍集中给它，省略 + hover；
 *   - 来源 8%（89px / 65px）：「成品入库通知」6 个中文字 ≈78px，与 T21 同一档标签放不下 → 省略 + hover
 *     （这一列是 `accessorFn`，title 是完整标签）；
 *   - 送检数量 7%（78px / 54px）：`100 件` 这种带单位写法（与 T22 送检记录同口径）；
 *   - 状态 6%（66px / 42px）：「待质检 / 质检中」3 个中文字 ≈39px，刚好；
 *   - 操作 10%（111px / 87px）：只有 1 个「录入质检」按钮（4 字 ≈52px + 内边距 ≈20px = 72px）。
 *     与 T21 的「创建送检」同一个按钮宽度，取 10% 而不是 T21 的 12%：这张表的操作列后面没有「取消送检」这类第二按钮。
 *   合计：9+8+9+11+8+7+8+8+6+10 = 84%，另 16% 给 `auditColumns()` 的创建人/最后修改人 = 100%，
 *   与上面三张表同一套列边界。
 */
const COLUMN_WIDTH = {
  // T21 成品来源
  sourceProductionOrderNo: "14%",
  sourceOrigin: "10%",
  sourceNotice: "20%",
  sourcePackaging: "11%",
  sourceAvailableQuantity: "6%",
  sourceUnit: "5%",
  sourceStatus: "6%",
  sourceActions: "12%",
  // T22 送检记录
  submissionNo: "15%",
  submissionOrigin: "21%",
  submissionProduct: "20%",
  submissionQuantity: "6%",
  submissionStatus: "6%",
  submissionActions: "16%",
  // T23 质检记录
  qcNo: "10%",
  qcOrderNo: "10%",
  qcSubmission: "7%",
  qcOriginType: "8%",
  qcDate: "6%",
  qcQualified: "5%",
  qcConditional: "5%",
  qcRejected: "5%",
  qcAvailableForInbound: "5%",
  qcUnit: "4%",
  qcActions: "19%",
  // T24 待质检（全部订单）—— 84% 预算里把「已检 / 待检」两列表头抬到 8%，代价是四个长文本列各让 1%
  pendingSubmissionNo: "9%",
  pendingOrderNo: "8%",
  pendingProductionOrderNo: "9%",
  pendingProduct: "11%",
  pendingOrigin: "8%",
  pendingSubmittedQuantity: "7%",
  pendingInspectedQuantity: "8%",
  pendingPendingQuantity: "8%",
  pendingStatus: "6%",
  pendingActions: "10%",
} as const;

export function FinishedGoodsQcPanel({ initialOrderNo }: { initialOrderNo?: string } = {}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [query, setQuery] = useState("");
  const [selectedOrderNo, setSelectedOrderNo] = useState<string | null>(null);
  const [detailSources, setDetailSources] = useState<Source[]>([]);
  const [detailSubmissions, setDetailSubmissions] = useState<Submission[]>([]);
  const [detailQc, setDetailQc] = useState<QcRecord[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<DialogState | null>(null);
  const [pendingQcValues, setPendingQcValues] = useState<Record<string, string> | null>(null);

  async function load() {
    setError("");
    try {
      const [sourceResult, submissionResult] = await Promise.all([
        apiGet<Source[]>("/finished-goods/qc/sources"),
        apiGet<Submission[]>("/finished-goods/inspection-submissions"),
      ]);
      setSources(sourceResult.data);
      setSubmissions(submissionResult.data);
    } catch (cause) { setError(messageOf(cause, "成品质检数据加载失败")); }
  }
  useEffect(() => { void load(); }, []);
  // 从别的模块带订单号跳进来（/qc?order_no=…）时直接展开该订单的质检详情。
  useEffect(() => { if (initialOrderNo) void loadOrder(initialOrderNo); }, [initialOrderNo]);
  // 同页其它面板（来料质检 / 质检合格待入库）写入后，订单详情里的净值与可入库量也要刷新。
  useEffect(() => subscribeQcDataChanged("finished-goods-qc", () => { void load(); if (selectedOrderNo) void loadOrder(selectedOrderNo); }), [selectedOrderNo]);

  async function loadOrder(orderNo: string) {
    const normalized = orderNo.trim();
    if (!normalized) return;
    setSelectedOrderNo(normalized);
    setDetailLoading(true);
    setError("");
    try {
      const [sourceResult, submissionResult, qcResult] = await Promise.all([
        apiGet<Source[]>(`/finished-goods/qc/sources?order_no=${encodeURIComponent(normalized)}`),
        apiGet<Submission[]>(`/finished-goods/inspection-submissions?order_no=${encodeURIComponent(normalized)}`),
        apiGet<QcRecord[]>(`/finished-goods/qc-records/available-inbound-sources?order_no=${encodeURIComponent(normalized)}`),
      ]);
      setDetailSources(sourceResult.data);
      setDetailSubmissions(submissionResult.data);
      setDetailQc(qcResult.data);
    } catch (cause) { setError(messageOf(cause, "订单质检详情加载失败")); }
    finally { setDetailLoading(false); }
  }
  async function run(action: () => Promise<unknown>, success: string) {
    setError("");
    try { await action(); notifySuccess(success); await load(); if (selectedOrderNo) await loadOrder(selectedOrderNo); emitQcDataChanged("finished-goods-qc"); }
    catch (cause) { notifyError(messageOf(cause, "操作失败")); }
  }
  async function createSubmission(source: Source) {
    try {
      await apiPost<Submission>("/finished-goods/inspection-submissions", { production_order_id: source.production_order_id, source_type: source.source_type, source_id: source.source_id, submitted_quantity: source.available_quantity, submission_date: new Date().toISOString().slice(0, 10) });
      setMessage("成品送检单已创建"); await load(); await loadOrder(source.order_no); emitQcDataChanged("finished-goods-qc");
    } catch (cause) { setError(messageOf(cause, "成品送检单创建失败")); }
  }
  function submit(id: string) { void run(() => apiPost(`/finished-goods/inspection-submissions/${id}/submit`), "送检单已提交"); }
  function editSubmission(item: Submission) {
    setDialog({ title: `编辑送检单：${item.submissionNo}`, fields: [
      { name: "submitted_quantity", label: "送检数量", type: "number", required: true, defaultValue: item.submittedQuantity },
      { name: "submission_date", label: "送检日期", type: "date", required: true, defaultValue: item.submissionDate?.slice(0, 10) },
      { name: "remark", label: "备注", type: "textarea", defaultValue: item.remark ?? undefined },
      { name: "reason", label: "修改原因", type: "textarea", required: true },
    ], submit: (v) => void run(() => apiPatch(`/finished-goods/inspection-submissions/${item.id}`, { submitted_quantity: v.submitted_quantity, submission_date: v.submission_date, remark: v.remark || undefined, reason: v.reason, expected_version: item.version }), "送检单已更新") });
  }
  /** 取消送检：后端允许 draft / submitted 且尚未录入 QC 的送检单作废（会释放来源的可送检额度）。 */
  function cancelSubmission(item: Submission) {
    setDialog({ title: `取消送检单：${item.submissionNo}`, fields: [
      { name: "reason", label: "取消原因", type: "textarea", required: true },
    ], submit: (v) => void run(() => apiPost(`/finished-goods/inspection-submissions/${item.id}/cancel`, { reason: v.reason }), "送检单已取消") });
  }
  function chooseQcOrder() {
    setDialog({ title: "选择订单号", fields: [{ name: "order_no", label: "订单号", type: "searchable-select", required: true, options: orderNumbers.map((item) => ({ value: item, label: item })), placeholder: "搜索并选择订单号" }], submit: (v) => {
      // ActionDialog 在 onSubmit 返回后会自己 onOpenChange(false)，父组件把它读成 setDialog(null)：
      // 在这里同步 openQc() 打开第二个弹窗，会被紧接着的这次关闭一起清掉（历史缺陷：选完订单号什么都没有）。
      // 因此先让选择器按正常流程关闭，等这一次交互结束再打开质检表单。
      const orderNo = v.order_no;
      setTimeout(() => openQc(orderNo), 0);
    } });
  }
  /**
   * 录入质检前先在前端校验数量配平。
   * 服务端同样有这条规则（数量不配平返回 422 并说明差额），但在这里先拦可以避免用户
   * 提交后才发现填错；历史上服务端抛的是普通 Error，界面只会显示「服务器内部错误」。
   */
  function qcBalanceError(values: Record<string, string>): string {
    const round = (value: number) => Math.round(value * 10000) / 10000;
    const inspected = Number(values.inspected_quantity);
    const qualified = values.qualified_quantity?.trim() === "" || values.qualified_quantity === undefined ? 0 : Number(values.qualified_quantity);
    const conditional = values.conditional_accept_quantity?.trim() === "" || values.conditional_accept_quantity === undefined ? 0 : Number(values.conditional_accept_quantity);
    const rejected = values.rejected_quantity?.trim() === "" || values.rejected_quantity === undefined ? 0 : Number(values.rejected_quantity);
    if (!Number.isFinite(inspected) || inspected <= 0) return "「本次检验数量」必须填写为大于 0 的数字";
    if ([qualified, conditional, rejected].some((value) => !Number.isFinite(value) || value < 0)) return "「合格数量 / 条件接收数量 / 不合格数量」必须是不小于 0 的数字";
    const split = round(qualified + conditional + rejected);
    if (round(inspected) !== split) return `数量不配平：本次检验 ${round(inspected)} ≠ 合格 ${round(qualified)} + 条件接收 ${round(conditional)} + 不合格 ${round(rejected)}（拆分合计 ${split}）`;
    if (rejected > 0 && !values.rejection_reason?.trim()) return "存在不合格数量时必须填写「不合格原因」";
    return "";
  }
  function openQc(orderNo: string, values: Record<string, string> = {}) {
    const orderSubmissions = submissions.filter((item) => item.orderNo === orderNo && ["submitted", "inspecting"].includes(item.status));
    setDialog({ title: orderNo ? `录入成品质检：${orderNo}` : "录入成品质检（先选订单号）", fields: [
      { name: "submission_id", label: "订单内送检批次", type: "select", required: true, options: orderSubmissions.map((item) => ({ value: item.id, label: `${item.submissionNo} / ${item.submittedQuantity} ${item.unitNameSnapshot} / ${item.status}` })), defaultValue: values.submission_id },
      { name: "inspection_date", label: "检验日期", type: "date", required: true, defaultValue: values.inspection_date ?? new Date().toISOString().slice(0, 10) },
      { name: "inspected_quantity", label: "本次检验数量", type: "number", required: true, defaultValue: values.inspected_quantity, placeholder: "必须等于合格+条件接收+不合格" },
      { name: "qualified_quantity", label: "合格数量", type: "number", required: true, defaultValue: values.qualified_quantity ?? "0" },
      { name: "conditional_accept_quantity", label: "条件接收数量", type: "number", required: true, defaultValue: values.conditional_accept_quantity ?? "0" },
      { name: "rejected_quantity", label: "不合格数量", type: "number", required: true, defaultValue: values.rejected_quantity ?? "0" },
      { name: "rejection_reason", label: "不合格原因", type: "textarea", defaultValue: values.rejection_reason, placeholder: "不合格数量大于 0 时必填" },
    ], submit: (v) => {
      // 与「更正」一致：抛错把原因留在弹窗里，不关窗、不丢已填值。
      const invalid = qcBalanceError(v);
      if (invalid) throw new Error(invalid);
      void run(() => apiPost("/finished-goods/qc-records", v), "成品质检已保存");
    } });
  }
  /**
   * 更正质检记录（POST /finished-goods/qc-records/:id/correct）。
   * 后端只允许「还没有成品入库/次品事实」的记录更正，并强制 合格+条件接收+不合格 = 检验数量 且必须填更正原因；
   * 界面按同一条件给按钮与预填值（见 available_for_correction），避免给出必然被拒的入口。
   */
  function correctQc(row: QcRecord) {
    const inspected = row.inspected_quantity ?? String(Number(row.qualified_quantity) + Number(row.conditional_accept_quantity) + Number(row.rejected_quantity ?? 0));
    setDialog({ title: `更正成品质检：${row.qc_no}`, fields: [
      { name: "inspection_date", label: "检验日期", type: "date", required: true, defaultValue: (row.inspection_date ?? new Date().toISOString()).slice(0, 10) },
      { name: "inspected_quantity", label: "本次检验数量", type: "number", required: true, defaultValue: inspected, placeholder: "必须等于合格+条件接收+不合格" },
      { name: "qualified_quantity", label: "合格数量", type: "number", required: true, defaultValue: row.qualified_quantity },
      { name: "conditional_accept_quantity", label: "条件接收数量", type: "number", required: true, defaultValue: row.conditional_accept_quantity },
      { name: "rejected_quantity", label: "不合格数量", type: "number", required: true, defaultValue: row.rejected_quantity ?? "0" },
      { name: "rejection_reason", label: "不合格原因", type: "textarea", defaultValue: row.rejection_reason ?? undefined, placeholder: "不合格数量大于 0 时必填" },
      { name: "reason", label: "更正原因", type: "textarea", required: true },
    ], submit: (v) => {
      // 抛错而不是 setError：ActionDialog 会把原因显示在弹窗内并保留用户填好的数量，
      // 用 setError 只能显示在弹窗背后的页面上（弹窗已经被这次提交关掉了）。
      const invalid = qcBalanceError(v);
      if (invalid) throw new Error(invalid);
      void run(() => apiPost(`/finished-goods/qc-records/${row.qc_id}/correct`, v), "成品质检已更正");
    } });
  }
  function openSubmission(values: Record<string, string>) {
    setPendingQcValues(values); setDialog(null);
    setCategoryDialog({ title: "新建送检单", fields: [
      { name: "source_id", label: "送检来源", type: "select", required: true, options: sources.map((item) => ({ value: item.source_id, label: `${item.order_no} / ${item.production_order_no} / ${item.available_quantity} ${item.unit}` })), defaultValue: sources[0]?.source_id },
      { name: "submitted_quantity", label: "送检数量", type: "number", required: true, defaultValue: sources[0]?.available_quantity },
      { name: "submission_date", label: "送检日期", type: "date", required: true, defaultValue: new Date().toISOString().slice(0, 10) },
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: async (v) => {
      const source = sources.find((item) => item.source_id === v.source_id); if (!source) return;
      try {
        const created = (await apiPost<Submission>("/finished-goods/inspection-submissions", { production_order_id: source.production_order_id, source_type: source.source_type, source_id: source.source_id, submitted_quantity: v.submitted_quantity, submission_date: v.submission_date, remark: v.remark })).data;
        setMessage("成品送检单已创建"); await load(); await loadOrder(source.order_no); setCategoryDialog(null); openQc(source.order_no, { ...(pendingQcValues ?? {}), submission_id: created.id }); setPendingQcValues(null);
      } catch (cause) { setError(messageOf(cause, "成品送检单创建失败")); }
    } });
  }

  const orderNumbers = useMemo(() => Array.from(new Set([...sources.map((item) => item.order_no), ...submissions.map((item) => item.orderNo)])).sort(), [sources, submissions]);
  const visibleOrders = useMemo(() => orderNumbers.filter((orderNo) => !query.trim() || orderNo.toLowerCase().includes(query.trim().toLowerCase())), [orderNumbers, query]);
  /**
   * 跨订单待质检队列（设计 2026-11-07 §2.1）：只留 submitted / inspecting，按「先送检先检」排。
   *
   * 排序用字符串比较而不是 `new Date()`：送检日期是 `YYYY-MM-DD`，字典序即日期序，
   * 缺日期时按空串排最前（等于「日期不明，先看一眼」）。同日按送检单号升序 ——
   * 队列要的是稳定顺序，不按「谁最后改过」排，否则质检员刚检完一张，整张表的行就跳位。
   */
  const pendingSubmissions = useMemo(() => submissions
    .filter((item) => PENDING_QC_STATUSES.includes(item.status))
    .sort((left, right) => {
      const leftDate = (left.submissionDate ?? "").slice(0, 10);
      const rightDate = (right.submissionDate ?? "").slice(0, 10);
      if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1;
      return left.submissionNo.localeCompare(right.submissionNo);
    }), [submissions]);
  const sourceColumns: ColumnDef<Source>[] = [{ accessorKey: "production_order_no", header: "生产单", meta: { width: COLUMN_WIDTH.sourceProductionOrderNo } }, { id: "source", header: "来源", accessorFn: (row) => sourceLabel(row.source_type), meta: { width: COLUMN_WIDTH.sourceOrigin } }, { id: "notice", header: "入库通知/批次", accessorFn: (row) => row.notice_no ? `${row.notice_no}${row.batch_no ? ` / ${row.batch_no}` : ""}` : "-", meta: { width: COLUMN_WIDTH.sourceNotice } }, { id: "packaging", header: "包装工序", accessorFn: (row) => row.packaging_operation_name ?? "-", meta: { width: COLUMN_WIDTH.sourcePackaging } }, { accessorKey: "available_quantity", header: "可送检数量", meta: { width: COLUMN_WIDTH.sourceAvailableQuantity } }, { accessorKey: "unit", header: "单位", meta: { width: COLUMN_WIDTH.sourceUnit } }, { accessorKey: "source_status", header: "状态", meta: { width: COLUMN_WIDTH.sourceStatus } }, ...auditColumns<Source>(), { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.sourceActions }, cell: ({ row }) => <Button size="sm" onClick={() => void createSubmission(row.original)}>创建送检</Button> }];
  const submissionColumns: ColumnDef<Submission>[] = [{ accessorKey: "submissionNo", header: "送检单", meta: { width: COLUMN_WIDTH.submissionNo } }, { id: "source", header: "来源", accessorFn: (row) => `${sourceLabel(row.sourceType)} / ${row.sourceId}`, meta: { width: COLUMN_WIDTH.submissionOrigin } }, { id: "product", header: "成品", accessorFn: (row) => `${row.productNameSnapshot ?? "-"} / ${row.productSpecificationSnapshot ?? "-"}`, meta: { width: COLUMN_WIDTH.submissionProduct } }, { id: "quantity", header: "送检数量", accessorFn: (row) => `${row.submittedQuantity} ${row.unitNameSnapshot}`, meta: { width: COLUMN_WIDTH.submissionQuantity } }, { accessorKey: "status", header: "状态", meta: { width: COLUMN_WIDTH.submissionStatus } }, ...auditColumns<Submission>(), { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.submissionActions }, cell: ({ row }) => <div className="action-row">{row.original.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => editSubmission(row.original)}>编辑</Button><Button size="sm" variant="secondary" onClick={() => submit(row.original.id)}>提交送检</Button></>}{["draft", "submitted"].includes(row.original.status) && !row.original.qcRecords.length ? <Button size="sm" variant="ghost" onClick={() => cancelSubmission(row.original)}>取消送检</Button> : null}</div> }];
  const qcColumns: ColumnDef<QcRecord>[] = [{ accessorKey: "qc_no", header: "质检单", meta: { width: COLUMN_WIDTH.qcNo } }, { accessorKey: "order_no", header: "订单号", meta: { width: COLUMN_WIDTH.qcOrderNo } }, { accessorKey: "submission_id", header: "送检记录", meta: { width: COLUMN_WIDTH.qcSubmission } }, { id: "source_type", header: "来源类型", accessorFn: (row) => sourceLabel(row.source_type), meta: { width: COLUMN_WIDTH.qcOriginType } }, { id: "date", header: "检验日期", accessorFn: (row) => (row.inspection_date ?? "").slice(0, 10) || "-", meta: { width: COLUMN_WIDTH.qcDate } }, { accessorKey: "qualified_quantity", header: "合格数量", meta: { width: COLUMN_WIDTH.qcQualified } }, { accessorKey: "conditional_accept_quantity", header: "条件接收", meta: { width: COLUMN_WIDTH.qcConditional } }, { id: "rejected", header: "不合格", accessorFn: (row) => row.rejected_quantity ?? "-", meta: { width: COLUMN_WIDTH.qcRejected } }, { accessorKey: "available_for_inbound_quantity", header: "可入库数量（净值）", meta: { width: COLUMN_WIDTH.qcAvailableForInbound } }, { id: "unit", header: "单位", accessorFn: (row) => row.unit ?? "-", meta: { width: COLUMN_WIDTH.qcUnit } }, ...auditColumns<QcRecord>(), { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.qcActions }, cell: ({ row }) => row.original.available_for_correction === false ? <span className="panel-note">已有入库/次品事实，不可更正</span> : <Button size="sm" variant="ghost" onClick={() => correctQc(row.original)}>更正</Button> }];
  /**
   * 「待质检（全部订单）」的列（T24，10 列）。长文本列一律 `accessorFn` 返回屏幕上那串字本身：
   * 这样 DataTable 才能把完整内容挂到 `title`（省略号 hover 看全文），`id` + 自定义 `cell` 的列取不到值层。
   * 已检/待检直接渲染服务端字段（缺字段才显示 `-`）：前端不再从 qcRecords 求和，累计口径只留服务端一份。
   */
  const pendingColumns: ColumnDef<Submission>[] = [
    { accessorKey: "submissionNo", header: "送检单", meta: { width: COLUMN_WIDTH.pendingSubmissionNo } },
    { accessorKey: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.pendingOrderNo } },
    { id: "productionOrder", header: "生产单", accessorFn: (row) => row.productionOrderNoSnapshot ?? "-", meta: { width: COLUMN_WIDTH.pendingProductionOrderNo } },
    { id: "product", header: "成品", accessorFn: (row) => `${row.productNameSnapshot ?? "-"} / ${row.productSpecificationSnapshot ?? "-"}`, meta: { width: COLUMN_WIDTH.pendingProduct } },
    { id: "origin", header: "来源", accessorFn: (row) => sourceLabel(row.sourceType), meta: { width: COLUMN_WIDTH.pendingOrigin } },
    { id: "submittedQuantity", header: "送检数量", accessorFn: (row) => `${row.submittedQuantity} ${row.unitNameSnapshot}`, meta: { width: COLUMN_WIDTH.pendingSubmittedQuantity } },
    { id: "inspectedQuantity", header: "已检数量", accessorFn: (row) => row.inspectedQuantity ?? "-", meta: { width: COLUMN_WIDTH.pendingInspectedQuantity } },
    { id: "pendingQuantity", header: "待检数量", accessorFn: (row) => row.pendingQuantity ?? "-", meta: { width: COLUMN_WIDTH.pendingPendingQuantity } },
    { id: "status", header: "状态", accessorFn: (row) => pendingStatusLabel(row.status), meta: { width: COLUMN_WIDTH.pendingStatus } },
    ...auditColumns<Submission>(),
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.pendingActions }, cell: ({ row }) => <Button size="sm" onClick={() => openQc(row.original.orderNo, { submission_id: row.original.id })}>录入质检</Button> },
  ];

  return <section className="panel" style={{ gridColumn: "1 / -1" }}>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onAddCategory={(field, values) => field.name === "submission_id" ? openSubmission(values) : setError(`${field.label}为业务记录，请在对应模块建立`)} onSubmit={(values) => dialog?.submit(values)} />
    <ActionDialog open={Boolean(categoryDialog)} onOpenChange={(open) => { if (!open) setCategoryDialog(null); }} title={categoryDialog?.title ?? "新建类目"} fields={categoryDialog?.fields ?? []} onSubmit={(values) => { const current = categoryDialog; void current?.submit(values); }} />
    <div className="panel-heading"><h2>成品质检</h2><div className="page-actions"><Button variant="secondary" data-testid="finished-goods-qc-choose-order" onClick={chooseQcOrder}>录入质检</Button><Button variant="ghost" onClick={() => void load()}>刷新</Button></div></div>
    {message && <p className="status-success panel-body" role="status">{message}</p>}{error && <p className="status-error panel-body" role="alert">{error}</p>}
    {/* 待质检（全部订单）（2026-11-07，用户：「成品提交质检入库，成品质检页面要显示所有待质检列表」）：
        跨订单的质检工作队列，一行一个待检批次，替代原来页面底部那句「请选择订单号」的占位说明。
        数据来自同一个 load() 的 submissions，不新增请求。 */}
    <div className="panel-body" data-testid="finished-goods-qc-pending">
      <div className="panel-heading"><h3>待质检（全部订单）</h3><span className="panel-note" data-testid="finished-goods-qc-pending-count">共 {pendingSubmissions.length} 张</span></div>
      <p className="panel-note">所有订单里已提交送检、尚未检完的成品送检单，按「先送检先检」排序。成品入库通知送检后，要在订单详情的送检记录里点「提交送检」，才会进入这里；草稿送检单在下方按订单号查询的订单详情里编辑。双击一行进入该订单的质检详情，行内「录入质检」直接打开这一批次的质检表单。</p>
      <DataTable columns={pendingColumns} data={pendingSubmissions} onRowDoubleClick={(row) => void loadOrder(row.orderNo)} rowTitle="双击查看该订单的质检详情" empty={<EmptyState title="暂无待质检的成品送检单" description="成品入库通知送检后，要在送检记录里点「提交送检」才会进入这里；草稿送检单在下方按订单号查询的订单详情里编辑提交。" />} />
    </div>
    <div className="panel-body"><h3>按订单号查询</h3><div className="page-actions"><Input value={query} placeholder="输入订单号搜索" onChange={(event) => setQuery(event.target.value)} /><Button onClick={() => visibleOrders[0] && void loadOrder(visibleOrders[0])}>查询</Button></div><div className="action-row" style={{ marginTop: 12 }}>{visibleOrders.map((orderNo) => <Button key={orderNo} variant={selectedOrderNo === orderNo ? "default" : "secondary"} onClick={() => void loadOrder(orderNo)}>{orderNo}</Button>)}</div></div>
    {selectedOrderNo && <div className="panel-body" data-testid="finished-goods-qc-order-detail"><div className="panel-heading"><h3>订单详情：{selectedOrderNo}</h3><Button variant="secondary" onClick={() => openQc(selectedOrderNo)}>为此订单录入质检</Button></div>{detailLoading ? <p>正在加载订单质检详情…</p> : <><h4>成品来源</h4><DataTable columns={sourceColumns} data={detailSources} empty={<EmptyState title="暂无成品来源" />} /><h4>送检记录</h4><DataTable columns={submissionColumns} data={detailSubmissions} empty={<EmptyState title="暂无送检记录" />} /><h4>质检记录</h4><DataTable columns={qcColumns} data={detailQc} empty={<EmptyState title="暂无质检记录" />} /></>}</div>}
  </section>;
}
