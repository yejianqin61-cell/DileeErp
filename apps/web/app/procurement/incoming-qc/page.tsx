"use client";

import Link from "next/link";
import { PageHeader } from "../../../components/layout/app-shell";
import { Button } from "../../../components/ui/button";

export default function IncomingQcPage() {
  return (
    <div className="page-root" data-testid="page-procurement-incoming-qc">
      <PageHeader title="来料质检" breadcrumb={["采购", "来料质检"]} description="到货批次的送检登记、判定、入库通知与退货。" />
      <section className="panel">
        <div className="panel-body">
          <p className="panel-note">
            来料质检（送检登记 / 判定 / 通知入库 / 退货）已整体迁到【质检】模块。
            到货批次在下方采购单详情中点击「登记质检」按钮，会带着批次直接打开质检表单。
          </p>
          <div className="action-row" style={{ marginTop: "1rem" }}>
            <Button asChild>
              <Link href="/qc/incoming">进入来料质检模块</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/procurement/orders">回到采购单列表</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}