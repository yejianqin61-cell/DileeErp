"use client";

import Link from "next/link";
import { PageHeader } from "../../components/layout/app-shell";

const links = [
  { href: "/procurement/materials", label: "物料清单", description: "统一维护物料主数据，BOM、采购和库存会共用这里的物料。" },
  { href: "/procurement/suppliers", label: "供应商池", description: "统一维护供应商主数据，采购单每行明细通过供应商列引用此处的供应商。" },
  { href: "/procurement/boms", label: "BOM表", description: "在已确认销售单上建立物料 BOM 表，采购与生产共用。" },
  { href: "/procurement/orders", label: "采购单", description: "选定销售单后按供应商拆分下单；登记到货、记录批次流转至质检。" },
  { href: "/procurement/incoming-qc", label: "来料质检", description: "到货批次的送检登记、判定、入库通知与退货，集成质检模块。" },
  { href: "/procurement/inbounds", label: "原料入库", description: "查看跨模块的入库状态与财务付款通知，入库过账在仓库模块执行。" },
];

export default function ProcurementHub() {
  return (
    <div className="page-root" data-testid="page-procurement">
      <PageHeader title="采购" description="物料主数据、BOM 表、采购单、来料质检与原料入库。" />
      <section className="board-grid">
        {links.map((link) => (
          <Link key={link.href} href={link.href} className="board-card" data-testid={`procurement-link-${link.href.split("/").pop()}`}>
            <h2>{link.label}</h2>
            <p>{link.description}</p>
            <span className="board-enter">进入 &rarr;</span>
          </Link>
        ))}
      </section>
    </div>
  );
}