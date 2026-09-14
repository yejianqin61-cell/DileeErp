"use client";

// 质检大模块（/qc）：全站与质检有关的过程都收在这里，业务页面只保留跳转入口。
//   * 来料质检：到货批次送检 → 判定 → 通知入库 → 退货（原「采购 → 来料质检」）
//   * 成品质检：成品送检、质检记录与订单号下的质检详情（原「仓库 → 成品送检与质检」）
//   * 质检合格待入库 / 次品登记（原「仓库 → 成品仓储情况」的两个区块）
// 深链：/qc?receipt_id=<到货批次> 直接打开该批次的送检登记；/qc?order_no=<订单号> 直接展开成品质检详情。
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "../../components/layout/app-shell";
import { LoadingState } from "../../components/feedback/states";
import { IncomingInspectionsPanel } from "../../components/qc/incoming-inspections-panel";
import { FinishedGoodsQcPanel } from "../../components/qc/finished-goods-qc-panel";
import { QcInboundPanel } from "../../components/qc/qc-inbound-panel";

function QcPageContent() {
  const searchParams = useSearchParams();
  // 空串（/qc?receipt_id=）等同于没有传，否则面板会把它当成一个「不存在的批次」去报错。
  const receiptId = searchParams.get("receipt_id")?.trim() || undefined;
  const orderNo = searchParams.get("order_no")?.trim() || undefined;
  return <div className="page-root" data-testid="page-qc">
    <PageHeader title="质检" description="来料质检、成品质检、质检合格待入库与次品登记集中在这里；原料/成品的实际出入库与财务收付款仍回到对应模块。" />
    <IncomingInspectionsPanel receiptId={receiptId} />
    <FinishedGoodsQcPanel initialOrderNo={orderNo} />
    <QcInboundPanel />
  </div>;
}

export default function QcPage() {
  return <Suspense fallback={<div className="page-root" data-testid="page-qc"><PageHeader title="质检" /><LoadingState /></div>}><QcPageContent /></Suspense>;
}
