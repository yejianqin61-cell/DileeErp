"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "../../../components/layout/app-shell";
import { LoadingState } from "../../../components/feedback/states";
import { FinishedGoodsQcPanel } from "../../../components/qc/finished-goods-qc-panel";

function FinishedGoodsPageContent() {
  const searchParams = useSearchParams();
  const orderNo = searchParams.get("order_no")?.trim() || undefined;
  return (
    <div className="page-root" data-testid="page-qc-finished-goods">
      <PageHeader title="成品质检" breadcrumb={["质检", "成品质检"]} />
      <FinishedGoodsQcPanel initialOrderNo={orderNo} />
    </div>
  );
}

export default function FinishedGoodsPage() {
  return (
    <Suspense fallback={<div className="page-root" data-testid="page-qc-finished-goods"><PageHeader title="成品质检" breadcrumb={["质检", "成品质检"]} /><LoadingState /></div>}>
      <FinishedGoodsPageContent />
    </Suspense>
  );
}