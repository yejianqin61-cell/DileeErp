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
import type { ColumnDef } from "@tanstack/react-table";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";
import { latestBom, productionCandidateHint, productionCandidates, resolveProductionUnit } from "../../lib/production-candidates";
import { BomWorkbench, type BomMaterialRef } from "../../components/bom/bom-workbench";
import { PayrollExportPanel } from "../../components/production/payroll-export-panel";
import { notifyError, notifySuccess } from "../../components/ui/toaster";

type Unit = { id: string; name: string; isActive: boolean };
type Location = { id: string; name: string; locationType: "workshop" | "outsource_site"; isActive: boolean };
type Operation = { id: string; operationName: string; defaultUnitId?: string | null; isActive: boolean };
type Order = { id?: string; orderNo: string; quantity: string; unit?: string; status: string; boms: Array<{ id: string; version: number; status: string }> };
type ProductionOrder = { id: string; productionOrderNo: string; orderNo: string; executionMode: "in_house" | "outsourced"; status: string; plannedQuantity: string; executionLocation: Location; operations: Array<{ id: string; operationCatalogId?: string; sequenceNo?: number; operationNameSnapshot: string; targetQuantity: string; status: string }> };

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
    { accessorKey: "productionOrderNo", header: "生产单号", cell: ({ row }) => <Button variant="link" onClick={() => router.push(`/production/orders/${row.original.id}`)}>{row.original.productionOrderNo}</Button> },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "mode", header: "执行方式", cell: ({ row }) => row.original.executionMode === "in_house" ? "厂内" : "外加工" },
    { id: "location", header: "地点", cell: ({ row }) => row.original.executionLocation?.name ?? "-" },
    { accessorKey: "plannedQuantity", header: "计划数" },
    { id: "operations", header: "工序", cell: ({ row }) => row.original.operations.map((item) => item.operationNameSnapshot).join("、") || "未配置" },
    { accessorKey: "status", header: "状态", cell: statusCell<ProductionOrder>() },
    { id: "actions", header: "操作", cell: ({ row }) => row.original.status === "draft" ? <Button size="sm" variant="secondary" onClick={() => void run(`/production/orders/${row.original.id}/transition`, { target: "in_progress", reason: "开始生产" }, "生产单已启动")}>启动</Button> : null },
  ];

  // 基础资料加载完成前禁止打开建单对话框：openProductionOrder() 用当时的 activeLocations 构造选项，
  // 数据到达后 dialog.fields 不会重建，会留下**永久为空**的「执行地点」下拉
  // （见 docs/test/results/2026-09-13-e2e-rewrite-and-platform-unit-expansion.md §7.3）。
  return <div className="page-root" data-testid="page-production">
    <PageHeader title="生产"><Button onClick={() => void openProductionOrder()} disabled={loading} data-testid="production-create-order">新建生产单</Button></PageHeader>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { dialog?.submit(values); setDialog(null); }} />
    {/* BOM 工作区放在加载分支之外：保存后刷新列表时它不会被卸载，用户的编辑不会被吞掉。 */}
    {bomWorkbench && <BomWorkbench bomId={bomWorkbench.id} title={bomWorkbench.label} materials={materials} units={units} onClose={() => setBomWorkbench(null)} onSaved={() => void load()} />}
    {message && <section className="panel panel-body status-success">{message}</section>}
    {!loading && candidateHint && <section className="panel panel-body panel-note" role="status">{candidateHint}</section>}
    {error ? <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section> : loading ? <LoadingState /> : <>
      <section className="panel" data-testid="production-bom-panel"><div className="panel-heading"><h2>BOM表</h2></div><div className="panel-body">
        <p className="panel-note">BOM 由采购与生产共同维护，两个入口改的是同一张表。保存时会校验版本：若采购已先改过，会提示你重新加载，而不是把对方的修改覆盖掉。</p>
        {!orders.length ? <EmptyState title="暂无已确认销售单" description="建立并确认销售单后，即可在这里为其建立 BOM 表。" /> : <div className="table-wrap"><table className="data-table"><thead><tr><th>订单号</th><th>数量</th><th>BOM表</th></tr></thead><tbody>{orders.map((order) => { const bom = latestBom(order.boms); return <tr key={order.orderNo}><td>{order.orderNo}</td><td>{order.quantity}{order.unit ? ` ${order.unit}` : ""}</td><td><Button size="sm" variant="secondary" data-testid={`production-bom-${order.orderNo}`} onClick={() => void createOrOpenBom(order)}>{bom ? "编辑BOM表" : "新建BOM表"}</Button></td></tr>; })}</tbody></table></div>}
      </div></section>
      <section className="panel"><div className="panel-heading"><h2>生产单查找</h2></div><div className="panel-body"><div className="filter-bar"><label>搜索生产单、订单号或状态<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词" /></label></div><div data-testid="production-order-table"><DataTable columns={columns} data={visible} empty={<EmptyState title="暂无生产单" />} /></div></div></section>
      <section className="panel"><div className="panel-heading"><h2>生产基础资料</h2></div><div className="panel-body"><div className="page-actions"><Button asChild variant="secondary"><Link href="/production/operations" data-testid="production-add-operation">工序池（{operations.filter((item) => item.isActive).length} 个启用）</Link></Button><Button asChild variant="secondary"><Link href="/production/locations" data-testid="production-add-location">加工地点池（{activeLocations.length} 个启用）</Link></Button><Button asChild variant="secondary"><Link href="/production/units">单位池（{units.length} 个启用）</Link></Button><Button asChild variant="secondary"><Link href="/production/material-issues">领料/补料单（按工序）</Link></Button></div></div></section>
      <PayrollExportPanel orders={records} operations={operations} />
    </>}
  </div>;
}
