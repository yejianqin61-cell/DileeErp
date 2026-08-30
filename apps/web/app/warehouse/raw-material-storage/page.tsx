"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { DataTable } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../../lib/api-client";

type Material = { id: string; materialCode: string; name: string; defaultUnitId: string };
type Unit = { id: string; name: string };
type Inspection = { id: string; orderNo: string; inspectedQuantity: string; status: string };
type Inbound = { id: string; inboundNo: string; orderNo: string; quantity: string; status: string; remark?: string; incomingInspectionId?: string; inventoryCategory?: string };
type Balance = { material_id: string; unit_id: string; unit_name: string; order_no: string | null; quantity: string; material?: Material };
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

  async function load() {
    setLoading(true);
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
      const balanceMap = new Map<string, number>();
      for (const item of balanceResult.data) balanceMap.set(item.material_id, (balanceMap.get(item.material_id) ?? 0) + Number(item.quantity));
      setBalances(m.data.map((item) => ({ material_id: item.id, unit_id: item.defaultUnitId, unit_name: "", order_no: null, quantity: String(balanceMap.get(item.id) ?? 0), material: item })));
    } catch (cause) {
      setError(messageOf(cause, "原料仓储情况加载失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

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
    setDialog({
      title: "编辑原料入库单",
      fields: [
        { name: "quantity", label: "入库数量", type: "number", required: true, defaultValue: item.quantity },
        { name: "remark", label: "备注", type: "textarea", defaultValue: item.remark ?? "" }
      ],
      submit: (values) => void run(apiPatch("/raw-material-inbounds/" + item.id, { quantity: values.quantity, remark: values.remark || undefined }), "原料入库单已更新")
    });
  }

  const balanceColumns: ColumnDef<Balance>[] = [
    { id: "material", header: "物料", cell: ({ row }) => row.original.material?.materialCode + " / " + row.original.material?.name },
    { accessorKey: "quantity", header: "当前库存" }
  ];

  const inboundColumns: ColumnDef<Inbound>[] = [
    { accessorKey: "inboundNo", header: "入库单号" },
    { accessorKey: "orderNo", header: "订单号" },
    { accessorKey: "quantity", header: "数量" },
    { accessorKey: "status", header: "状态" },
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
        {row.original.status === "posted" && <Button size="sm" variant="destructive" onClick={() => void run(apiPost("/raw-material-inbounds/" + row.original.id + "/reverse", { reason: "人工冲销" }), "原料入库已冲销")}>冲销</Button>}
      </div>
    }
  ];

  const unitMap = useMemo(() => new Map(units.map((unit) => [unit.id, unit.name])), [units]);

  if (loading) return <><PageHeader title="原料仓储情况"><Button asChild variant="secondary"><Link href="/warehouse">返回仓库</Link></Button></PageHeader><LoadingState /></>;

  return (
    <>
      <PageHeader title="原料仓储情况">
        <Button asChild variant="secondary"><Link href="/warehouse">返回仓库</Link></Button>
        <Button onClick={createInbound}>新建入库单</Button>
      </PageHeader>
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { dialog?.submit(values); setDialog(null); }} />
      {message && <section className="panel panel-body status-success" role="status">{message}</section>}
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <section className="panel">
        <div className="panel-heading"><h2>库存汇总</h2></div>
        <div className="panel-body"><DataTable columns={balanceColumns} data={balances} empty={<EmptyState title="暂无原料库存" />} /></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>原料入库单</h2></div>
        <div className="panel-body">
          <DataTable
            columns={inboundColumns}
            data={inbounds}
            empty={<EmptyState title="暂无原料入库单" />}
          />
          <p className="panel-note">单位：{units.length ? units.map((unit) => unit.name).join("、") : "暂无"}</p>
          <p className="panel-note">质检记录：{inspections.length}</p>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>入库单与库存关系</h2></div>
        <div className="panel-body">
          <p className="panel-note">库存以物料为唯一口径，入库单过账后会同步到汇总库存。</p>
          <p className="panel-note">当前原料汇总条目：{balances.length}</p>
          <p className="panel-note">当前可用入库单：{inbounds.filter((item) => item.status === "draft").length}</p>
          <p className="panel-note">当前已过账入库单：{inbounds.filter((item) => item.status === "posted").length}</p>
          <p className="panel-note">当前已冲销入库单：{inbounds.filter((item) => item.status === "reversed").length}</p>
          <p className="panel-note">单位映射：{unitMap.size}</p>
        </div>
      </section>
    </>
  );
}
