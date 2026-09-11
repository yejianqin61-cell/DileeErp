"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../components/ui/action-dialog";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback/states";
import { DataTable } from "../../components/data/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";
import { latestBom, productionCandidateHint, productionCandidates, resolveProductionUnit } from "../../lib/production-candidates";
import { PayrollExportPanel } from "../../components/production/payroll-export-panel";
import { notifyError, notifySuccess } from "../../components/ui/toaster";

type Unit = { id: string; name: string; isActive: boolean };
type Location = { id: string; name: string; locationType: "workshop" | "outsource_site"; isActive: boolean };
type Operation = { id: string; operationName: string; defaultUnitId?: string | null; isActive: boolean };
type Order = { orderNo: string; quantity: string; unit?: string; status: string; boms: Array<{ id: string; version: number; status: string }> };
type ProductionOrder = { id: string; productionOrderNo: string; orderNo: string; executionMode: "in_house" | "outsourced"; status: string; plannedQuantity: string; executionLocation: Location; operations: Array<{ id: string; operationCatalogId?: string; sequenceNo?: number; operationNameSnapshot: string; targetQuantity: string; status: string }> };

export default function ProductionPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [orders, setOrders] = useState<Order[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [records, setRecords] = useState<ProductionOrder[]>([]);
  const [query, setQuery] = useState(searchParams.get("order_no") ?? "");
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
      const [sales, sites, process, production, unitData] = await Promise.all([
        apiGet<Order[]>("/sales-orders?status=confirmed&page=1&page_size=200"),
        apiGet<Location[]>("/production/locations"),
        apiGet<Operation[]>("/production/operations"),
        apiGet<ProductionOrder[]>("/production/orders"),
        apiGet<Unit[]>("/units"),
      ]);
      const nextOrders = sales.data;
      ordersRef.current = nextOrders;
      setOrders(nextOrders);
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
  const visible = useMemo(() => records.filter((item) => !query || `${item.productionOrderNo} ${item.orderNo} ${item.status}`.toLowerCase().includes(query.toLowerCase())), [records, query]);
  const activeLocations = locations.filter((item) => item.isActive);
  // 候选与提示都从“全部销售单”推导：缺 BOM 的已确认订单必须被解释，而不是从下拉框静默消失。
  const candidates = useMemo(() => productionCandidates(orders), [orders]);
  const candidateHint = useMemo(() => productionCandidateHint(orders), [orders]);
  const orderOptions = candidates.map((item) => ({ value: item.orderNo, label: `${item.orderNo} / ${item.quantity}${item.unit ? ` ${item.unit}` : ""}` }));

  function searchSalesOrders(search: string) {
    if (orderSearchTimer.current) clearTimeout(orderSearchTimer.current);
    const requestId = ++orderSearchRequest.current;
    orderSearchTimer.current = setTimeout(() => {
      void apiGet<Order[]>(`/sales-orders?status=confirmed&page=1&page_size=200&search=${encodeURIComponent(search)}`).then((result) => {
        if (requestId === orderSearchRequest.current) {
          ordersRef.current = result.data;
          setOrders(result.data);
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
      setOrders(candidateOrders);
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
      if (!source || !bom) { setError("请选择已确认且已建 BOM 的销售单；缺少 BOM 的订单请先在【采购 → BOM表】建立 BOM。"); return; }
      const unitId = resolveProductionUnit(source.unit, units, operations);
      if (!unitId) { setError(`无法确定订单 ${source.orderNo} 的生产单位：请先在【采购】物料清单的单位中选择「打 / 个 / 码」等单位，或为工序设置默认单位。`); return; }
      void run("/production/orders", { order_no: source.orderNo, bom_id: bom.id, bom_version: bom.version, execution_mode: values.execution_mode, execution_location_id: values.execution_location_id, planned_quantity: source.quantity, unit_id: unitId }, "生产单草稿已创建");
    },
    });
  }

  const columns: ColumnDef<ProductionOrder>[] = [
    { accessorKey: "productionOrderNo", header: "生产单号", cell: ({ row }) => <Button variant="link" onClick={() => router.push(`/production/orders/${row.original.id}`)}>{row.original.productionOrderNo}</Button> },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "mode", header: "执行方式", cell: ({ row }) => row.original.executionMode === "in_house" ? "厂内" : "外加工" },
    { id: "location", header: "地点", cell: ({ row }) => row.original.executionLocation?.name ?? "-" },
    { accessorKey: "plannedQuantity", header: "计划数" },
    { id: "operations", header: "工序", cell: ({ row }) => row.original.operations.map((item) => item.operationNameSnapshot).join("、") || "未配置" },
    { accessorKey: "status", header: "状态" },
    { id: "actions", header: "操作", cell: ({ row }) => row.original.status === "draft" ? <Button size="sm" variant="secondary" onClick={() => void run(`/production/orders/${row.original.id}/transition`, { target: "in_progress", reason: "开始生产" }, "生产单已启动")}>启动</Button> : null },
  ];

  return <>
    <PageHeader title="生产"><Button onClick={() => void openProductionOrder()}>新建生产单</Button></PageHeader>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { dialog?.submit(values); setDialog(null); }} />
    {message && <section className="panel panel-body status-success">{message}</section>}
    {!loading && candidateHint && <section className="panel panel-body panel-note" role="status">{candidateHint}</section>}
    {error ? <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section> : loading ? <LoadingState /> : <>
      <section className="panel"><div className="panel-heading"><h2>生产单查找</h2></div><div className="panel-body"><div className="filter-bar"><label>搜索生产单、订单号或状态<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词" /></label></div><DataTable columns={columns} data={visible} empty={<EmptyState title="暂无生产单" />} /></div></section>
      <section className="panel"><div className="panel-heading"><h2>生产基础资料</h2></div><div className="panel-body"><div className="page-actions"><Button asChild variant="secondary"><Link href="/production/operations">工序池（{operations.filter((item) => item.isActive).length} 个启用）</Link></Button><Button asChild variant="secondary"><Link href="/production/locations">加工地点池（{activeLocations.length} 个启用）</Link></Button><Button asChild variant="secondary"><Link href="/production/units">单位池（{units.length} 个启用）</Link></Button><Button asChild variant="secondary"><Link href="/production/material-issues">领料/补料单（按工序）</Link></Button></div></div></section>
      <PayrollExportPanel orders={records} operations={operations} />
    </>}
  </>;
}
