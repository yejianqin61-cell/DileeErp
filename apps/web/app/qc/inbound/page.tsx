"use client";

import { PageHeader } from "../../../components/layout/app-shell";
import { QcInboundPanel } from "../../../components/qc/qc-inbound-panel";

export default function InboundPage() {
  return (
    <div className="page-root" data-testid="page-qc-inbound">
      <PageHeader title="质检合格待入库 / 次品登记" breadcrumb={["质检", "待入库与次品"]} />
      <QcInboundPanel />
    </div>
  );
}