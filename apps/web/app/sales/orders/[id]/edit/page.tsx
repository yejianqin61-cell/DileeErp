"use client";

// 编辑销售单（整页）：/sales/orders/<id>/edit
import { Suspense, use } from "react";
import { LoadingState } from "../../../../../components/feedback/states";
import { SalesOrderEditor } from "../../../../../components/sales/sales-order-editor";

function EditorForOrder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <SalesOrderEditor orderId={id} />;
}

export default function EditSalesOrderPage({ params }: { params: Promise<{ id: string }> }) {
  return <div className="page-root" data-testid="page-sales-orders-edit"><Suspense fallback={<LoadingState label="正在加载销售单编辑页" />}><EditorForOrder params={params} /></Suspense></div>;
}
