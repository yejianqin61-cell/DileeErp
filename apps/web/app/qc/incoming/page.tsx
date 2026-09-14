"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "../../../components/layout/app-shell";
import { LoadingState } from "../../../components/feedback/states";
import { IncomingInspectionsPanel } from "../../../components/qc/incoming-inspections-panel";

function IncomingPageContent() {
  const searchParams = useSearchParams();
  const receiptId = searchParams.get("receipt_id")?.trim() || undefined;
  return (
    <div className="page-root" data-testid="page-qc-incoming">
      <PageHeader title="来料质检" breadcrumb={["质检", "来料质检"]} />
      <IncomingInspectionsPanel receiptId={receiptId} />
    </div>
  );
}

export default function IncomingPage() {
  return (
    <Suspense fallback={<div className="page-root" data-testid="page-qc-incoming"><PageHeader title="来料质检" breadcrumb={["质检", "来料质检"]} /><LoadingState /></div>}>
      <IncomingPageContent />
    </Suspense>
  );
}