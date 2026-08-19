"use client";

import { useEffect, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { PageHeader } from "../components/layout/app-shell";
import { DemoNotice, EmptyState, ErrorState } from "../components/feedback/states";
import { DataTable } from "../components/data/data-table";
import { StatusBadge } from "../components/data/status-badge";
import { getWorkbenchData } from "../lib/adapters/workbench-adapter";
import type { OrderProgressRow, ProductionProgressRow, ReceivablePayableRow } from "../lib/demo-data";

const orderColumns = createColumnHelper<OrderProgressRow>();
const productionColumns = createColumnHelper<ProductionProgressRow>();
const financeColumns = createColumnHelper<ReceivablePayableRow>();

export default function WorkbenchPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof getWorkbenchData>> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { getWorkbenchData().then(setData).catch(() => setError(true)); }, []);
  return <><PageHeader title="工作台" description="订单、生产和往来款项的管理视角" /><DemoNotice />{error ? <section className="panel"><ErrorState /></section> : <div className="workbench-grid">
    <section className="panel table-panel"><div className="panel-heading"><h2>订单推进状态</h2><span className="panel-note">演示数据</span></div><div className="panel-body">{data ? <DataTable columns={[orderColumns.accessor("order_no", { header: "订单号" }), orderColumns.accessor("customer", { header: "客户" }), orderColumns.accessor("status", { header: "当前状态", cell: info => <StatusBadge label={info.getValue()} tone={info.getValue() === "生产中" ? "info" : "warning"} /> }), orderColumns.accessor("delivery_date", { header: "交期" })]} data={data.orderProgress} /> : <EmptyState title="正在准备工作台" description="演示数据加载中" />}</div></section>
    <section className="panel table-panel"><div className="panel-heading"><h2>生产工序进度</h2><span className="panel-note">工序待确认</span></div><div className="panel-body">{data ? <DataTable columns={[productionColumns.accessor("production_no", { header: "生产单" }), productionColumns.accessor("operation", { header: "工序" }), productionColumns.accessor("planned_quantity", { header: "计划数量" }), productionColumns.accessor("completed_quantity", { header: "完成数量" })]} data={data.productionProgress} /> : <EmptyState />}</div></section>
    <section className="panel table-panel"><div className="panel-heading"><h2>应收应付</h2><span className="panel-note">原币展示</span></div><div className="panel-body">{data ? <DataTable columns={[financeColumns.accessor("direction", { header: "方向", cell: info => <StatusBadge label={info.getValue()} tone={info.getValue() === "应收" ? "success" : "warning"} /> }), financeColumns.accessor("order_no", { header: "订单号" }), financeColumns.accessor("currency", { header: "币种" }), financeColumns.accessor("balance", { header: "余额" })]} data={data.receivablesPayables} /> : <EmptyState />}</div></section>
  </div>}</>;
}
