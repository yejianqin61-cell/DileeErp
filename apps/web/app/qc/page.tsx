"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { PageHeader } from "../../components/layout/app-shell";
import { Button } from "../../components/ui/button";
import { LoadingState } from "../../components/feedback/states";

function QcHubContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const receiptId = searchParams.get("receipt_id")?.trim();
    const orderNo = searchParams.get("order_no")?.trim();
    if (receiptId) {
      router.replace(`/qc/incoming?receipt_id=${encodeURIComponent(receiptId)}`);
    } else if (orderNo) {
      router.replace(`/qc/finished-goods?order_no=${encodeURIComponent(orderNo)}`);
    }
  }, [searchParams, router]);

  return (
    <div className="page-root" data-testid="page-qc">
      <PageHeader title="质检" description="来料质检、成品质检、质检合格待入库与次品登记" />

      <section className="panel">
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 480 }}>
          <Button asChild size="lg" className="w-full">
            <Link href="/qc/incoming">来料质检</Link>
          </Button>
          <p className="panel-note">到货批次送检 → 判定（全部入库 / 部分入库 / 拒收）→ 通知仓库入库。支持深链跳转：<code>/qc/incoming?receipt_id=到货批次ID</code></p>

          <Button asChild variant="secondary" size="lg" className="w-full">
            <Link href="/qc/finished-goods">成品质检</Link>
          </Button>
          <p className="panel-note">成品送检、质检记录与订单号下的质检详情。支持深链跳转：<code>/qc/finished-goods?order_no=订单号</code></p>

          <Button asChild variant="secondary" size="lg" className="w-full">
            <Link href="/qc/inbound">质检合格待入库 / 次品登记</Link>
          </Button>
          <p className="panel-note">按 QC 合格量分批登记成品入库、按不合格量登记次品；过账计入库存。</p>
        </div>
      </section>
    </div>
  );
}

export default function QcPage() {
  return (
    <Suspense fallback={<div className="page-root" data-testid="page-qc"><PageHeader title="质检" /><LoadingState /></div>}>
      <QcHubContent />
    </Suspense>
  );
}