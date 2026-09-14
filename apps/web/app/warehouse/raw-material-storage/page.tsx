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
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../../lib/api-client";
import { mergeMaterialBalances } from "../../../lib/wms-balances";
import { shouldAutoOpenDraft } from "../../../lib/auto-open";
import { shouldRefreshOnVisibility } from "../../../lib/refresh-policy";
import { fuzzyMatch } from "../../../lib/material-search";

// specificationModel / color 由 GET /materials 返回（listMaterials 返回物料全字段），
// 库存汇总的「规格型号」列与搜索都依赖它们。
type Material = { id: string; materialCode: string; name: string; defaultUnitId: string; specificationModel?: string | null; color?: string | null };
type Unit = { id: string; name: string };
type Inspection = { id: string; orderNo: string; inspectedQuantity: string; status: string };
type Inbound = { id: string; inboundNo: string; inboundNoticeId?: string | null; materialId: string; unitId: string; orderNo: string; quantity: string; status: string; remark?: string; incomingInspectionId?: string; inventoryCategory?: string; purchase_order_no?: string | null; receipt_no?: string | null; batch_sequence?: number | null; inspection_status?: string | null };
type Balance = { material_id: string; unit_id: string | null; unit_name: string; order_no: string | null; quantity: string; material?: Material };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function RawMaterialStoragePage() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [inbounds, setInbounds] = useState<Inbound[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
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
      const balanceResult = await apiGet<Balance[]>("/inventory/raw-material-balances?material_ids=" + m.data.map((item) => item.id).join(","));
      // 单位名必须用本次请求返回的 u.data 解析：渲染期派生的 unitMap 在首次加载时还是空的。
      setBalances(mergeMaterialBalances(m.data, u.data, balanceResult.data, (row, material) => ({ ...row, material })));
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
    { id: "material", header: "物料", cell: ({ row }) => row.original.material?.materialCode + " / " + row.original.material?.name },
    // 规格型号是原料的关键区分项（同名不同规格是常态），只给物料名无法确认是哪一种。
    { id: "specification", header: "规格型号", cell: ({ row }) => row.original.material?.specificationModel || "-" },
    { accessorKey: "unit_name", header: "单位" },
    // 接收通知后生成的是草稿，库存要过账才会变动；这里把「待入库」单独列出，
    // 否则接收完这个页面看起来“什么都没更新”。
    { id: "pending", header: "待入库（未过账）", cell: ({ row }) => { const quantity = pendingByKey.get(`${row.original.material_id}|${row.original.unit_id}`) ?? 0; return quantity ? <span className="status-warning">{quantity}</span> : "0"; } },
    { accessorKey: "quantity", header: "已过账库存" },
    { id: "total", header: "合计", cell: ({ row }) => { const pending = pendingByKey.get(`${row.original.material_id}|${row.original.unit_id}`) ?? 0; return (Number(row.original.quantity) + pending).toString(); } }
  ];

  const inboundColumns: ColumnDef<Inbound>[] = [
    { accessorKey: "inboundNo", header: "入库单号" },
    { accessorKey: "orderNo", header: "订单号" },
    { accessorKey: "purchase_order_no", header: "采购单号" },
    { id: "batch", header: "到货批次", cell: ({ row }) => `第 ${row.original.batch_sequence ?? "-"} 批` },
    { accessorKey: "receipt_no", header: "到货记录" },
    { accessorKey: "quantity", header: "数量" },
    { accessorKey: "inspection_status", header: "质检状态" },
    { accessorKey: "status", header: "入库状态", cell: ({ row }) => <span className={row.original.status === "posted" ? "status-success" : row.original.status === "reversed" ? "status-warning" : undefined}>{inboundStatusLabels[row.original.status] ?? row.original.status}</span> },
    { accessorKey: "remark", header: "备注" },
    {
      id: "actions",
      header: "操作",
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

  if (loading) return <><PageHeader title="原料仓储情况"><Button asChild variant="secondary"><Link href="/warehouse">返回仓库</Link></Button></PageHeader><LoadingState /></>;

  return (
    <div className="page-root" data-testid="page-warehouse-raw-material-storage">
      <PageHeader title="原料仓储情况">
        <Button asChild variant="secondary"><Link href="/warehouse">返回仓库</Link></Button>
        <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        <Button onClick={createInbound}>新建入库单</Button>
      </PageHeader>
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { dialog?.submit(values); setDialog(null); }} />
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
          <p className="panel-note">「待入库（未过账）」是已接收通知生成的草稿数量，登记实际数量并过账后才会计入「已过账库存」。</p>
          <DataTable columns={balanceColumns} data={filteredBalances} empty={<EmptyState title={query ? "没有匹配的原料库存" : "暂无原料库存"} description={query ? "换个关键词，或点「清除搜索」看全部。" : undefined} />} />
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>原料入库单</h2>{query ? <span className="panel-note">筛选后 {filteredInbounds.length} / {inbounds.length} 条</span> : null}</div>
        <div className="panel-body">
          <DataTable
            columns={inboundColumns}
            data={filteredInbounds}
            empty={query
              ? <EmptyState title="没有匹配的原料入库单" description="换个关键词，或点「清除搜索」看全部。" />
              : <EmptyState title="暂无原料入库单" description="在【仓库 → 待入库通知】接收入库通知后，这里会出现对应的草稿入库单；登记实际数量并过账后计入库存。" />}
          />
          <p className="panel-note">单位：{units.length ? units.map((unit) => unit.name).join("、") : "暂无"}</p>
          <p className="panel-note">质检记录：{inspections.length}</p>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>入库单与库存关系</h2></div>
        <div className="panel-body">
          <p className="panel-note">库存以物料为唯一口径，入库单过账后会同步到汇总库存。</p>
          <p className="panel-note">当前原料汇总条目：{balances.length}{query ? `（筛选后 ${filteredBalances.length}）` : ""}</p>
          <p className="panel-note">当前可用入库单：{inbounds.filter((item) => item.status === "draft").length}</p>
          <p className="panel-note">当前已过账入库单：{inbounds.filter((item) => item.status === "posted").length}</p>
          <p className="panel-note">当前已冲销入库单：{inbounds.filter((item) => item.status === "reversed").length}</p>
          <p className="panel-note">单位映射：{unitMap.size}</p>
        </div>
      </section>
    </div>
  );
}