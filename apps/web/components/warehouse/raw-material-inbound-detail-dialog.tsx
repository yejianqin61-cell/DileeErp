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
import { useEffect, useState, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../data/data-table";
import { EmptyState } from "../feedback/states";
import { RecordDetailDialog, money, type DetailField } from "../finance/record-detail-dialog";
import { auditDetailFields, type AuditRow } from "../data/audit-columns";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { formatBeijingShort } from "../../lib/audit-time";
// 搜索语义全站统一（空格分词的 AND、忽略大小写与空白、空查询不过滤），见 lib/fuzzy-search.ts。
import { fuzzyMatch } from "../../lib/fuzzy-search";

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

/**
 * 「屏幕上那一格的字」与「搜索匹配的字」必须是同一份（与 finished-goods-storage 页同一口径）。
 *
 * 这两张小表有四格是**拼出来**的：金额 + 币种、应付单号 + （状态）、来源类型中文化、
 * 时间格式化。拼法原先只写在 `accessorFn` 里；搜索若照抄一遍，改了一边忘了另一边就会变成
 * 「屏幕上写着 1250.0000 CNY，搜 1250 搜不到」—— 没有任何报错，只有用户会撞上。
 * 抽成函数后 `accessorFn` 与过滤集调同一份拼法。
 */
const payableAmountText = (row: RawMaterialInboundPayableSource) => money(row.amount, row.currency);
const payableStatusText = (row: RawMaterialInboundPayableSource) => PAYABLE_SOURCE_STATUS_LABELS[row.status] ?? row.status;
const payableEntryText = (row: RawMaterialInboundPayableSource) => row.supplierPayableEntry
  ? `${row.supplierPayableEntry.payableNo}（${PAYABLE_ENTRY_STATUS_LABELS[row.supplierPayableEntry.status] ?? row.supplierPayableEntry.status}）`
  : "尚未接收";
const factSourceText = (row: RawMaterialInboundFact) => FACT_SOURCE_LABELS[row.sourceType] ?? row.sourceType;
const factTimeText = (row: RawMaterialInboundFact) => formatBeijingShort(row.createdAt) || "-";

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
 *
 * `query` 是弹窗里那一个小搜索框的关键词（已 trim）：它**同时**过滤这两张表、
 * 且只匹配屏幕上看得见的列（金额 / 币种 / 来源状态 / 已生成的应付单；数量变动 / 来源类型 / 发生时间）。
 * 两张表的空态因此有两种说法：
 *   - 本来就没有（未过账的草稿）：一句解释原因的 `panel-note`，**不**说「没有匹配」；
 *   - 有数据但被关键词筛掉了：`DataTable` 的 `empty` 说「没有匹配“xx”」并给出总数。
 * 两种混用的话，草稿单会显示「没有匹配」——用户会以为是自己搜错了。
 */
function detailSections(inbound: RawMaterialInboundRow, query: string) {
  const payables = inbound.payableSources ?? [];
  const facts = inbound.inventoryFacts ?? [];
  const visiblePayables = query ? payables.filter((row) => fuzzyMatch(query, [
    payableAmountText(row), row.currency, payableStatusText(row), payableEntryText(row),
  ])) : payables;
  const visibleFacts = query ? facts.filter((row) => fuzzyMatch(query, [
    row.quantityDelta, factSourceText(row), factTimeText(row),
  ])) : facts;
  return [
    {
      // 标题里的条数跟着筛选走：否则「应付来源（3 条）」下面只显示 1 行，看起来像丢数据。
      title: query ? `应付来源（筛选后 ${visiblePayables.length} / ${payables.length} 条）` : `应付来源（${payables.length} 条）`,
      note: "入库过账时自动生成，是财务「应付账款」的来源；仓库不参与结算，接收/付款在财务模块。",
      content: payables.length
        ? <DataTable pageSize={10} columns={[
            { id: "amount", header: "应付金额", meta: { width: DETAIL_WIDTH.payableAmount }, accessorFn: payableAmountText },
            { id: "currency", header: "币种", meta: { width: DETAIL_WIDTH.payableCurrency }, accessorFn: (row: RawMaterialInboundPayableSource) => row.currency },
            { id: "status", header: "来源状态", meta: { width: DETAIL_WIDTH.payableStatus }, accessorFn: payableStatusText },
            { id: "entry", header: "已生成的应付单", meta: { width: DETAIL_WIDTH.payableEntry }, accessorFn: payableEntryText }
          ] as ColumnDef<RawMaterialInboundPayableSource>[]} data={visiblePayables} empty={<EmptyState title={`没有匹配“${query}”的应付来源`} description={`这张入库单共 ${payables.length} 条，换个关键词或清除搜索。`} />} />
        : <p className="panel-note">{inbound.status === "draft" ? "草稿入库单还没过账，过账后才会生成应付来源。" : "这张入库单没有关联的应付来源。"}</p>
    },
    {
      title: query ? `库存流水（筛选后 ${visibleFacts.length} / ${facts.length} 条）` : `库存流水（${facts.length} 条）`,
      note: "过账 +数量、冲销 −数量；库存汇总的「已过账库存」就是这些流水按物料累加的结果。",
      content: facts.length
        ? <DataTable pageSize={10} columns={[
            { id: "quantityDelta", header: "数量变动", meta: { width: DETAIL_WIDTH.factDelta }, accessorFn: (row: RawMaterialInboundFact) => row.quantityDelta },
            { id: "sourceType", header: "来源类型", meta: { width: DETAIL_WIDTH.factSource }, accessorFn: factSourceText },
            { id: "createdAt", header: "发生时间", meta: { width: DETAIL_WIDTH.factTime }, accessorFn: factTimeText }
          ] as ColumnDef<RawMaterialInboundFact>[]} data={visibleFacts} empty={<EmptyState title={`没有匹配“${query}”的库存流水`} description={`这张入库单共 ${facts.length} 条，换个关键词或清除搜索。`} />} />
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
  /**
   * 弹窗内的明细搜索（2026-11-13，用户：「所有表单是否都有搜索功能搜索框……因为现在单子多了，查找比较麻烦」）。
   *
   * 一张入库单通常只带 1 条应付来源 + 1 条流水，看起来没什么可搜 —— 但这个弹窗被**两个**列表页共用
   * （仓库「原料仓储情况」/ 采购「原料入库」），列表一长，用户是连着点开好几张单核对
   * 「哪张单的流水不对、哪笔应付还没接收」的，每次都得用眼睛在两张小表里扫。
   * 一个词同时过滤两张表就够了：他要找的是「这张单的应付和流水」，不该分两个框搜两遍。
   */
  const [query, setQuery] = useState("");
  /**
   * 换一张单必须清空搜索词。
   *
   * 不清的后果：上一张单的关键词（比如「冲销」）带到下一张单，而下一张单没有被冲销的流水，
   * 两张表就都显示「没有匹配“冲销”」—— 看起来像这张单根本没有应付来源、没有库存流水，
   * 比没有搜索框更误导。依赖写 `inbound?.id` 而不是 `inbound` 对象：列表刷新（焦点 / 可见性）
   * 会换一个新的行对象引用，按引用重置会在用户正打字时把关键词清掉。
   */
  useEffect(() => { setQuery(""); }, [inbound?.id]);
  const keyword = query.trim();
  const sections = inbound ? [
    {
      // 搜索框单独占一节：两张表的 content 在「本来就没有数据」时是一句 panel-note，
      // 搜索框若挂在某一节的 content 里，那张表一空输入框就跟着消失（正在打字时会丢焦点）。
      title: "明细搜索",
      note: "一个关键词同时过滤下面「应付来源」与「库存流水」两张表，只匹配这两张表显示出来的列；空格分隔多个词，所有词都要命中。",
      content: <div className="filter-bar">
        <label>搜索金额、币种、状态、来源类型或时间
          <Input data-testid="raw-material-inbound-detail-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词，空格分隔多个词" />
        </label>
        {keyword ? <Button size="sm" variant="secondary" onClick={() => setQuery("")}>清除搜索</Button> : null}
      </div>
    },
    ...detailSections(inbound, keyword)
  ] : [];
  return <RecordDetailDialog
    open={Boolean(inbound)}
    onOpenChange={onOpenChange}
    title={`原料入库单详情：${inbound?.inboundNo ?? ""}`}
    description="双击单据行打开的详情：登记信息、结算金额、应付来源与库存流水都在这里。"
    fields={inbound ? detailFields(inbound) : []}
    sections={sections}
    actions={actions}
    testId={testId}
  />;
}
