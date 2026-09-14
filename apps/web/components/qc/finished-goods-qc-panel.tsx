"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { apiGet, apiPatch, apiPost, ApiClientError } from "../../lib/api-client";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DataTable } from "../data/data-table";
import { EmptyState } from "../feedback/states";
import { notifyError, notifySuccess } from "../ui/toaster";

type Source = { source_id: string; source_type: string; order_no: string; production_order_no: string; production_order_id: string; unit: string; available_quantity: string; source_status: string; product_name?: string; product_specification?: string; notice_id?: string; notice_no?: string; batch_no?: string | null; packaging_operation_name?: string };
type QcRecord = { qc_id: string; qc_no: string; order_no: string; submission_id: string; status?: string; source_type: string; source_id: string; unit?: string; qualified_quantity: string; conditional_accept_quantity: string; available_for_inbound_quantity: string; conditionally_accepted: boolean };
type SubmissionQcRecord = { id: string; conclusion: string; inspectedQuantity: string };
type Submission = { id: string; submissionNo: string; orderNo: string; productionOrderId?: string; productionOrderNoSnapshot?: string; sourceType: string; sourceId: string; submittedQuantity: string; submissionDate?: string; remark?: string | null; version?: number; status: string; unitNameSnapshot: string; productNameSnapshot?: string; productSpecificationSnapshot?: string | null; qcRecords: SubmissionQcRecord[] };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void };
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
// 厂内成品送检来源已改为「成品入库通知」（按包装工序累计报工量分批通知）；历史 in_house_completion 单据仍按厂内完工显示。
const sourceLabel = (value: string) => value === "finished_goods_inbound_notice" ? "成品入库通知" : value === "in_house_completion" ? "厂内完工（历史）" : "外加工回厂";

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
    try { await action(); notifySuccess(success); await load(); if (selectedOrderNo) await loadOrder(selectedOrderNo); }
    catch (cause) { notifyError(messageOf(cause, "操作失败")); }
  }
  async function createSubmission(source: Source) {
    try {
      await apiPost<Submission>("/finished-goods/inspection-submissions", { production_order_id: source.production_order_id, source_type: source.source_type, source_id: source.source_id, submitted_quantity: source.available_quantity, submission_date: new Date().toISOString().slice(0, 10) });
      setMessage("成品送检单已创建"); await load(); await loadOrder(source.order_no);
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
      const invalid = qcBalanceError(v);
      if (invalid) { setError(invalid); notifyError(invalid); return; }
      void run(() => apiPost("/finished-goods/qc-records", v), "成品质检已保存");
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
  const sourceColumns: ColumnDef<Source>[] = [{ accessorKey: "production_order_no", header: "生产单" }, { id: "source", header: "来源", cell: ({ row }) => sourceLabel(row.original.source_type) }, { id: "notice", header: "入库通知/批次", cell: ({ row }) => row.original.notice_no ? `${row.original.notice_no}${row.original.batch_no ? ` / ${row.original.batch_no}` : ""}` : "-" }, { id: "packaging", header: "包装工序", cell: ({ row }) => row.original.packaging_operation_name ?? "-" }, { accessorKey: "available_quantity", header: "可送检数量" }, { accessorKey: "unit", header: "单位" }, { accessorKey: "source_status", header: "状态" }, { id: "actions", header: "操作", cell: ({ row }) => <Button size="sm" onClick={() => void createSubmission(row.original)}>创建送检</Button> }];
  const submissionColumns: ColumnDef<Submission>[] = [{ accessorKey: "submissionNo", header: "送检单" }, { id: "source", header: "来源", cell: ({ row }) => `${sourceLabel(row.original.sourceType)} / ${row.original.sourceId}` }, { id: "product", header: "成品", cell: ({ row }) => `${row.original.productNameSnapshot ?? "-"} / ${row.original.productSpecificationSnapshot ?? "-"}` }, { id: "quantity", header: "送检数量", cell: ({ row }) => `${row.original.submittedQuantity} ${row.original.unitNameSnapshot}` }, { accessorKey: "status", header: "状态" }, { id: "actions", header: "操作", cell: ({ row }) => row.original.status === "draft" ? <div className="action-row"><Button size="sm" variant="secondary" onClick={() => editSubmission(row.original)}>编辑</Button><Button size="sm" variant="secondary" onClick={() => submit(row.original.id)}>提交送检</Button></div> : null }];
  const qcColumns: ColumnDef<QcRecord>[] = [{ accessorKey: "qc_no", header: "质检单" }, { accessorKey: "order_no", header: "订单号" }, { accessorKey: "submission_id", header: "送检记录" }, { accessorKey: "source_type", header: "来源类型", cell: ({ row }) => sourceLabel(row.original.source_type) }, { accessorKey: "qualified_quantity", header: "合格数量" }, { accessorKey: "conditional_accept_quantity", header: "条件接收" }, { accessorKey: "available_for_inbound_quantity", header: "可入库数量（净值）" }, { id: "unit", header: "单位", cell: ({ row }) => row.original.unit ?? "-" }];

  return <section className="panel" style={{ gridColumn: "1 / -1" }}>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onAddCategory={(field, values) => field.name === "submission_id" ? openSubmission(values) : setError(`${field.label}为业务记录，请在对应模块建立`)} onSubmit={(values) => { const current = dialog; setDialog(null); void current?.submit(values); }} />
    <ActionDialog open={Boolean(categoryDialog)} onOpenChange={(open) => { if (!open) setCategoryDialog(null); }} title={categoryDialog?.title ?? "新建类目"} fields={categoryDialog?.fields ?? []} onSubmit={(values) => { const current = categoryDialog; void current?.submit(values); }} />
    <div className="panel-heading"><h2>成品质检</h2><div className="page-actions"><Button variant="secondary" onClick={chooseQcOrder}>录入质检</Button><Button variant="ghost" onClick={() => void load()}>刷新</Button></div></div>
    {message && <p className="status-success panel-body" role="status">{message}</p>}{error && <p className="status-error panel-body" role="alert">{error}</p>}
    <div className="panel-body"><h3>按订单号查询</h3><div className="page-actions"><Input value={query} placeholder="输入订单号搜索" onChange={(event) => setQuery(event.target.value)} /><Button onClick={() => visibleOrders[0] && void loadOrder(visibleOrders[0])}>查询</Button></div><div className="action-row" style={{ marginTop: 12 }}>{visibleOrders.map((orderNo) => <Button key={orderNo} variant={selectedOrderNo === orderNo ? "default" : "secondary"} onClick={() => void loadOrder(orderNo)}>{orderNo}</Button>)}</div></div>
    {selectedOrderNo && <div className="panel-body"><div className="panel-heading"><h3>订单详情：{selectedOrderNo}</h3><Button variant="secondary" onClick={() => openQc(selectedOrderNo)}>为此订单录入质检</Button></div>{detailLoading ? <p>正在加载订单质检详情…</p> : <><h4>成品来源</h4><DataTable columns={sourceColumns} data={detailSources} empty={<EmptyState title="暂无成品来源" />} /><h4>送检记录</h4><DataTable columns={submissionColumns} data={detailSubmissions} empty={<EmptyState title="暂无送检记录" />} /><h4>质检记录</h4><DataTable columns={qcColumns} data={detailQc} empty={<EmptyState title="暂无质检记录" />} /></>}</div>}
    <div className="panel-body"><h3>全部订单概览</h3><p>请选择订单号进入二级详情；录入质检时先按订单号选择，再选择该订单内送检批次。</p></div>
  </section>;
}
