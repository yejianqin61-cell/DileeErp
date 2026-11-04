"use client";

// 原料入库单的「双击看详情」弹窗（2026-11-04）。
//
// 用户要求：「原料入库单模块，双击单据条目也要支持查看详情。居中悬浮窗口，复用就行」。
// 「复用」在这里有两层：
//   ① 版式复用 `RecordDetailDialog`（全站双击详情只有这一套：居中弹窗 + 字段栅格 + 明细分区 + 底部动作）；
//   ② 本组件本身被**两个**列着同一批入库单的页面共用 —— 仓库「原料仓储情况」与采购「原料入库」。
//      两张表列的东西不同（仓库看数量/状态，采购看应付/财务通知），但双击出来必须是同一张单的样子，
//      否则同一条入库单在两个页面上字段名、数量口径、应付状态会因为「各写一个弹窗」而分叉。
//
// 字段数据全部来自列表行：`GET /raw-material-inbounds` 已经把物料/单位/供应商/质检单/应付来源/
// 库存流水一起带回来了（见 `raw-material-inbounds.service.ts` 的 `list()`），所以双击**不再发请求**。
import type { ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../data/data-table";
import { EmptyState } from "../feedback/states";
import { RecordDetailDialog, money, type DetailField } from "../finance/record-detail-dialog";
import { auditDetailFields, type AuditRow } from "../data/audit-columns";
import { formatBeijingShort } from "../../lib/audit-time";

/** 入库单过账留下的库存流水（`inventory_facts`，后端整行透传）。 */
export type RawMaterialInboundFact = { id: string; quantityDelta: string; sourceType: string; createdAt?: string | null };
/**
 * 入库单生成的应付来源（`payable_sources`）。仓库不收钱，但入库单是应付的**唯一来源** ——
 * 详情要能说清「这张单的应付走到哪了」，否则用户点开看到的是一张和财务断开的单。
 */
export type RawMaterialInboundPayableSource = {
  id: string; status: string; amount: string; currency: string;
  supplierPayableEntry?: { id: string; payableNo: string; status: string } | null;
};

/**
 * 详情弹窗认识的入库单形状 = `GET /raw-material-inbounds` 的一行。
 *
 * 扁平字段（`material_code` / `unit_name` / `supplier_name` / `inspection_no` / `inspected_quantity`）
 * 由接口下发，与已有的 `purchase_order_no` / `receipt_no` 同风格；调用方页面**不需要**再自己 join。
 */
export type RawMaterialInboundRow = AuditRow & {
  id: string;
  inboundNo: string;
  orderNo: string;
  quantity: string;
  status: string;
  /** 库存分类（raw_material / …）。 */
  inventoryCategory?: string | null;
  remark?: string | null;
  purchase_order_no?: string | null;
  receipt_no?: string | null;
  batch_sequence?: number | null;
  inspection_status?: string | null;
  material_code?: string | null;
  material_name?: string | null;
  material_specification?: string | null;
  material_color?: string | null;
  unit_name?: string | null;
  supplier_name?: string | null;
  inspection_no?: string | null;
  inspected_quantity?: string | null;
  /** 采购维护的结算口径（仓库不填，但详情要看得到）。 */
  settlementUnitPrice?: string | null;
  settlementTotalAmount?: string | null;
  settlementAmountReason?: string | null;
  inventoryFacts?: RawMaterialInboundFact[];
  payableSources?: RawMaterialInboundPayableSource[];
};

const INBOUND_STATUS_LABELS: Record<string, string> = { draft: "待入库登记", posted: "入库成功", reversed: "已冲销" };
/** 库存流水的来源类型（后端 `inventory_facts.source_type`）；未知值原样显示，不吞成 "-"。 */
const FACT_SOURCE_LABELS: Record<string, string> = {
  raw_material_inbound: "原料入库过账",
  raw_material_inbound_reversal: "原料入库冲销"
};
const PAYABLE_SOURCE_STATUS_LABELS: Record<string, string> = {
  pending_finance: "待财务接收",
  received: "已接收",
  voided: "已作废"
};
const PAYABLE_ENTRY_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  confirmed: "已确认",
  partially_paid: "部分付款",
  paid: "已付款",
  reversed: "已冲回",
  voided: "已作废"
};

/**
 * 弹窗里两张小表的列宽（各自合计 100%）。
 *
 * 弹窗宽 1080px，两张表一般只有 1~2 行；仍然逐列写宽度：`DataTable` 一律 `table-layout: fixed`，
 * 不写宽度就是各列均分 ——「应付金额」会和「已生成的应付单」一样宽，长文本再把窄列挤爆。
 */
const DETAIL_WIDTH = {
  payableAmount: "24%", payableCurrency: "12%", payableStatus: "24%", payableEntry: "40%",
  factDelta: "24%", factSource: "36%", factTime: "40%"
} as const;

const text = (value: string | null | undefined) => (value && String(value).trim() ? value : null);

/** 字段：列表十列里看不到的那些（结算金额、供应商、质检单号/数量、备注、操作人）都在这里补齐。 */
function detailFields(inbound: RawMaterialInboundRow): DetailField[] {
  const material = text(inbound.material_code) && text(inbound.material_name)
    ? `${inbound.material_code} / ${inbound.material_name}`
    : text(inbound.material_name) ?? text(inbound.material_code);
  const fields: DetailField[] = [
    { label: "入库单号", value: inbound.inboundNo },
    { label: "入库状态", value: INBOUND_STATUS_LABELS[inbound.status] ?? inbound.status },
    { label: "质检状态", value: inbound.inspection_status },
    { label: "物料", value: material },
    { label: "规格型号", value: inbound.material_specification },
    { label: "颜色", value: inbound.material_color },
    { label: "单位", value: inbound.unit_name },
    { label: "入库数量", value: inbound.quantity },
    { label: "库存分类", value: inbound.inventoryCategory },
    { label: "订单号", value: inbound.orderNo },
    { label: "采购单号", value: inbound.purchase_order_no },
    { label: "到货记录", value: inbound.receipt_no },
    { label: "到货批次", value: `第 ${inbound.batch_sequence ?? "-"} 批` },
    { label: "供应商", value: inbound.supplier_name },
    { label: "质检记录", value: inbound.inspection_no },
    { label: "质检数量", value: inbound.inspected_quantity },
    { label: "结算单价", value: inbound.settlementUnitPrice },
    { label: "结算总价", value: inbound.settlementTotalAmount },
    { label: "备注", value: inbound.remark, wide: true }
  ];
  // 结算差异原因只在填过时出现：空字段占一整行只会把有用信息挤下去。
  if (inbound.settlementAmountReason) fields.push({ label: "结算差异原因", value: inbound.settlementAmountReason, wide: true });
  return [...fields, ...auditDetailFields(inbound)];
}

/**
 * 下游事实两张表：应付来源 + 库存流水。
 *
 * 入库过账会同时生成「应付来源」（财务的应付由此而来）与「库存流水」，
 * 而用户点开一张入库单最常问的就是「钱进应付了吗」「库存到底加了没有」——这两件事都不在列表的十列里。
 */
function detailSections(inbound: RawMaterialInboundRow) {
  const payables = inbound.payableSources ?? [];
  const facts = inbound.inventoryFacts ?? [];
  return [
    {
      title: `应付来源（${payables.length} 条）`,
      note: "入库过账时自动生成，是财务「应付账款」的来源；仓库不参与结算，接收/付款在财务模块。",
      content: payables.length
        ? <DataTable pageSize={10} columns={[
            { id: "amount", header: "应付金额", meta: { width: DETAIL_WIDTH.payableAmount }, accessorFn: (row: RawMaterialInboundPayableSource) => money(row.amount, row.currency) },
            { id: "currency", header: "币种", meta: { width: DETAIL_WIDTH.payableCurrency }, accessorFn: (row: RawMaterialInboundPayableSource) => row.currency },
            { id: "status", header: "来源状态", meta: { width: DETAIL_WIDTH.payableStatus }, accessorFn: (row: RawMaterialInboundPayableSource) => PAYABLE_SOURCE_STATUS_LABELS[row.status] ?? row.status },
            { id: "entry", header: "已生成的应付单", meta: { width: DETAIL_WIDTH.payableEntry }, accessorFn: (row: RawMaterialInboundPayableSource) => row.supplierPayableEntry ? `${row.supplierPayableEntry.payableNo}（${PAYABLE_ENTRY_STATUS_LABELS[row.supplierPayableEntry.status] ?? row.supplierPayableEntry.status}）` : "尚未接收" }
          ] as ColumnDef<RawMaterialInboundPayableSource>[]} data={payables} empty={<EmptyState title="暂无应付来源" />} />
        : <p className="panel-note">{inbound.status === "draft" ? "草稿入库单还没过账，过账后才会生成应付来源。" : "这张入库单没有关联的应付来源。"}</p>
    },
    {
      title: `库存流水（${facts.length} 条）`,
      note: "过账 +数量、冲销 −数量；库存汇总的「已过账库存」就是这些流水按物料累加的结果。",
      content: facts.length
        ? <DataTable pageSize={10} columns={[
            { id: "quantityDelta", header: "数量变动", meta: { width: DETAIL_WIDTH.factDelta }, accessorFn: (row: RawMaterialInboundFact) => row.quantityDelta },
            { id: "sourceType", header: "来源类型", meta: { width: DETAIL_WIDTH.factSource }, accessorFn: (row: RawMaterialInboundFact) => FACT_SOURCE_LABELS[row.sourceType] ?? row.sourceType },
            { id: "createdAt", header: "发生时间", meta: { width: DETAIL_WIDTH.factTime }, accessorFn: (row: RawMaterialInboundFact) => formatBeijingShort(row.createdAt) || "-" }
          ] as ColumnDef<RawMaterialInboundFact>[]} data={facts} empty={<EmptyState title="暂无库存流水" />} />
        : <p className="panel-note">这张入库单还没有库存流水（未过账，或已过账但流水缺失）。</p>
    }
  ];
}

export function RawMaterialInboundDetailDialog({ inbound, onOpenChange, actions, testId = "raw-material-inbound-detail" }: {
  inbound: RawMaterialInboundRow | null;
  onOpenChange: (open: boolean) => void;
  /** 底部动作：由调用页面给（仓库是 编辑/过账/删除/冲销，采购是 编辑/冲销/通知财务付款）。 */
  actions?: ReactNode;
  testId?: string;
}) {
  return <RecordDetailDialog
    open={Boolean(inbound)}
    onOpenChange={onOpenChange}
    title={`原料入库单详情：${inbound?.inboundNo ?? ""}`}
    description="双击单据行打开的详情：登记信息、结算金额、应付来源与库存流水都在这里。"
    fields={inbound ? detailFields(inbound) : []}
    sections={inbound ? detailSections(inbound) : []}
    actions={actions}
    testId={testId}
  />;
}
