"use client";

// 新建销售单（整页）。2026-09-16 起细化口径后字段太多，弹窗放不下，所以从 /sales 跳到这里。
import { Suspense } from "react";
import { LoadingState } from "../../../../components/feedback/states";
import { SalesOrderEditor } from "../../../../components/sales/sales-order-editor";

export default function NewSalesOrderPage() {
  return <div className="page-root" data-testid="page-sales-orders-new"><Suspense fallback={<LoadingState label="正在加载销售单编辑页" />}><SalesOrderEditor /></Suspense></div>;
}
