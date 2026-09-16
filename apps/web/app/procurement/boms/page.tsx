"use client";

import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { Button } from "../../../components/ui/button";
import { DataTable } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPost } from "../../../lib/api-client";
import { BomWorkbench, type BomMaterialRef } from "../../../components/bom/bom-workbench";
import { MaterialCreateDialog } from "../../../components/bom/material-create-dialog";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type Reference = { id: string; orderNo?: string; status?: string; salesOrderId?: string; name?: string; materialCode?: string; supplierCode?: string; code?: string; isActive?: boolean; defaultUnitId?: string };
// 物料池：规格型号与颜色要一起带上 —— BOM 行选择/新建物料时会引用它们做初始值。
type Material = { id: string; materialCode?: string; code?: string; name?: string; specificationModel?: string | null; color?: string | null; materialType?: string; defaultUnitId?: string; isActive?: boolean };
type Unit = { id: string; name?: string; isActive?: boolean };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function BomsPage() {
  const [boms, setBoms] = useState<Reference[]>([]);
  const [salesOrders, setSalesOrders] = useState<Reference[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bomWorkbench, setBomWorkbench] = useState<{ id: string; label?: string } | null>(null);
  // BOM 工作区请求开的「新建物料」弹窗：存下它给的回填函数，物料建好就填回当前行。
  // （2026-09-16 之前这里是空函数：按钮在，点了没反应 —— 用户反馈「新建物料按钮怎么不见了」。）
  const [materialApply, setMaterialApply] = useState<((material: BomMaterialRef) => void) | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [bs, so, ms, us] = await Promise.all([
        apiGet<Reference[]>("/boms"),
        apiGet<Reference[]>("/sales-orders"),
        apiGet<Material[]>("/materials"),
        apiGet<Unit[]>("/units"),
      ]);
      setBoms(bs.data);
      setSalesOrders(so.data);
      setMaterials(ms.data);
      setUnits(us.data);
    } catch (cause) {
      setError(messageOf(cause, "BOM数据加载失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function openBom(id: string, label?: string) {
    setError("");
    setBomWorkbench({ id, label });
  }

  async function createOrOpenBom(order: Reference) {
    const existing = boms.find((b) => b.salesOrderId === order.id);
    if (existing) {
      openBom(existing.id, order.orderNo);
      return;
    }
    setError("");
    try {
      const result = await apiPost<Reference>(`/boms/from-sales-order/${order.id}`, { extension_data: {} });
      setBoms((items) => [...items, result.data]);
      notifySuccess("BOM表已创建");
      openBom(result.data.id, order.orderNo);
    } catch (cause) {
      notifyError(messageOf(cause, "BOM表创建失败"));
    }
  }

  const confirmedSalesOrders = salesOrders.filter((item) => item.status === "confirmed");
  const draftSalesOrders = salesOrders.filter((item) => item.status !== "confirmed");
  const bomEmptyHint = draftSalesOrders.length
    ? `有 ${draftSalesOrders.length} 张销售单尚未确认（${draftSalesOrders.slice(0, 5).map((item) => `${item.orderNo}（${item.status}）`).join("、")}${draftSalesOrders.length > 5 ? " 等" : ""}）：请先在【销售】确认销售单，再回此处建立 BOM。`
    : "建立并确认销售单后，即可在这里为其建立 BOM 表。";

  const columns: ColumnDef<Reference>[] = [
    { accessorKey: "orderNo", header: "订单号" },
    { accessorKey: "status", header: "BOM状态" },
    {
      id: "bom", header: "BOM表",
      cell: ({ row }) => {
        const bom = boms.find((b) => b.salesOrderId === row.original.id);
        return <Button size="sm" variant="secondary" onClick={() => void createOrOpenBom(row.original)}>{bom ? "编辑BOM表" : "新建BOM表"}</Button>;
      },
    },
  ];

  if (loading) return <><PageHeader title="BOM表" breadcrumb={["采购", "BOM表"]} /><LoadingState /></>;
  if (bomWorkbench) {
    return (
      <div className="page-root" data-testid="page-procurement-boms">
        <PageHeader title="BOM表" breadcrumb={["采购", "BOM表"]} />
        <BomWorkbench
          bomId={bomWorkbench.id}
          title={bomWorkbench.label}
          materials={materials}
          units={units}
          onCreateMaterial={(apply) => setMaterialApply(() => apply)}
          onClose={() => setBomWorkbench(null)}
          onSaved={() => void load()}
        />
        <MaterialCreateDialog
          open={Boolean(materialApply)}
          units={units}
          onOpenChange={(open) => { if (!open) setMaterialApply(null); }}
          onUnitCreated={(unit) => setUnits((items) => [...items, unit])}
          onCreated={(material) => {
            // 新物料必须先进物料池：BOM 行里的物料下拉是靠 options 渲染出名字的，
            // 只把 id 填进行里会让那一格变成空白。
            setMaterials((items) => [...items.filter((item) => item.id !== material.id), material]);
            materialApply?.(material);
            setMaterialApply(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="page-root" data-testid="page-procurement-boms">
      <PageHeader title="BOM表" breadcrumb={["采购", "BOM表"]}>
        <div className="page-actions">
          <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        </div>
      </PageHeader>
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <section className="panel">
        <div className="panel-body">
          <DataTable columns={columns} data={confirmedSalesOrders} empty={<EmptyState title="暂无已确认销售单" description={bomEmptyHint} />} />
        </div>
      </section>
    </div>
  );
}