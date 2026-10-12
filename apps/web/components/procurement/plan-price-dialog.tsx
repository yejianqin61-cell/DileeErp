"use client";

// 「填单价」浮层（2026-10-09）。
//
// 用户原话：「我还是希望在采购计划中前端也能允许填写价格。也可以选择导入BOM的对应的物料的价格。」
// 追问为什么手填不着时的回答：「我真没看到哪里可以手填单价的。可以重新设计这一块」。
//
// 原来单价只是第 8 列里一个 6% 宽的输入框：表有 14 列、行又多，它混在中间确实看不出来。
// 所以这一轮把"填价"单独做成一个入口：
//   · 计划面板顶部一条**状态条**写着「还有 N 行没填单价」+ 一个按钮进到这里（见 plan-detail-sheet.tsx）；
//   · 浮层里**一行一行大字填**：左边是物料与数量（知道自己在给什么定价），右边是单价与行总价；
//   · 顶部一个「导入 BOM 参考单价」——只填空的未下单行（口径与用例见 lib/purchase-plan-price-entry.ts）；
//   · 这里改的就是计划草稿的**同一份状态**：关掉浮层，表里那一格也变了；**点「保存计划」才落库**。
//
// 已下单的行分两种：单价 > 0 的只读（要改先退回计划）；单价还是 0 的**可以补价**
// （保存时同步到那张采购单的明细与单头合计）。
//
// ⚠️ 2026-10-11 起：**新单不会再出现「已下单但单价是 0」这一档**（用户口径「没确定单价的先不下单」，
// 0 价的行留在计划里等补价）。但这一档必须继续支持 —— 10-09 ~ 10-11 之间按「价格待定」下过的单
// 还在库里，它们的补价入口就是这里；删掉它等于让那些行永远卡在没价、无法到货。
//
// 用 `DataTable` 而不是手写 `<table>`：它已经是全站表格的唯一入口（默认带固定布局 + 超长省略 + 悬停看全文），
// 手写一张等于自己再维护一套列宽规则，而 `lib/table-width-coverage.test.mjs` 也会要求它单独归一次类。
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "../ui/button";
import { DataTable } from "../data/data-table";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { DEFAULT_PLAN_CURRENCY, lineAmountText } from "../../lib/purchase-plan-amount";
import { priceImportSummary, type PriceImportOutcome } from "../../lib/purchase-plan-price-entry";
import type { PlanDraftRow } from "./plan-order-preview";

/** 一行 = 草稿行 + 它在计划里的序号（序号要显示出来，也要给输入框做 testid）。 */
type PriceDialogRow = { index: number; row: PlanDraftRow };

/** 单价格式：`3.5` + 币种。已下单且已有价的行只读显示，用这个拼一句话。 */
const priceText = (row: PlanDraftRow) => `${row.unitPrice} ${row.currency ?? DEFAULT_PLAN_CURRENCY}`;
const unfilled = (row: PlanDraftRow) => !(Number(row.unitPrice) > 0);
/** 已下单 + 已有价 = 锁死；已下单 + 还是 0 = 历史「价格待定」单，仍需补价。 */
const locked = (row: PlanDraftRow) => row.ordered === true && !unfilled(row);

function statusOf(row: PlanDraftRow): string {
  if (locked(row)) return "已下单 · 单价已锁（要改先「退回采购计划」）";
  if (row.ordered) return "已下单 · 单价还是 0：补价后保存，会同步到那张采购单";
  if (row.priceFromBom) return "来自 BOM 参考单价（可改）";
  if (unfilled(row)) return "还没填（0 价的行不会下单，会留在计划里）";
  return "—";
}

export function PlanPriceDialog({ planNo, rows, importOutcome, importing = false, onImportBom, onChange, onClose }: {
  planNo?: string;
  rows: PlanDraftRow[];
  /** 上一次「导入 BOM 参考单价」的结果（没导过就是 null）。 */
  importOutcome: PriceImportOutcome | null;
  /** 导入中：按钮变文案并禁用（它会先重新取一次详情拿最新的参考价）。 */
  importing?: boolean;
  onImportBom: () => void;
  /** 改的就是计划草稿那一行（与表里那一格同一份状态）。 */
  onChange: (index: number, patch: Partial<PlanDraftRow>) => void;
  onClose: () => void;
}) {
  const data: PriceDialogRow[] = rows.map((row, index) => ({ index, row }));
  const pending = rows.filter(unfilled).length;
  const columns: ColumnDef<PriceDialogRow>[] = [
    { id: "no", header: "行", meta: { width: "5%" }, cell: ({ row }) => String(row.original.index + 1) },
    {
      id: "material", header: "物料", meta: { width: "28%", ellipsis: true },
      // 字符串返回 → DataTable 自动带 `title`（超长省略时鼠标悬停看全文）。
      cell: ({ row }) => [row.original.row.materialCode, row.original.row.materialName, row.original.row.model ? `（${row.original.row.model}）` : ""].filter(Boolean).join(" "),
    },
    { id: "quantity", header: "数量", meta: { width: "12%" }, cell: ({ row }) => `${row.original.row.quantity}${row.original.row.unitName ? ` ${row.original.row.unitName}` : ""}` },
    {
      id: "price", header: "单价（可填）", meta: { width: "19%" },
      cell: ({ row }) => {
        const { index, row: draft } = row.original;
        if (locked(draft)) return <span className="panel-note" title="已下单且已有单价：要改先「退回采购计划」">{priceText(draft)}</span>;
        return (
          <Input
            type="number" min="0" step="0.0001" value={draft.unitPrice}
            data-testid={`plan-price-input-${index}`}
            aria-label={`第 ${index + 1} 行单价`}
            placeholder="手填单价"
            onChange={(event) => onChange(index, { unitPrice: event.target.value, priceFromBom: false })}
          />
        );
      },
    },
    { id: "amount", header: "行总价", meta: { width: "14%" }, cell: ({ row }) => `${row.original.row.currency ?? DEFAULT_PLAN_CURRENCY} ${lineAmountText(row.original.row.quantity, row.original.row.unitPrice)}` },
    { id: "status", header: "状态", meta: { width: "22%", ellipsis: true }, cell: ({ row }) => statusOf(row.original.row) },
  ];
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-testid="plan-price-dialog">
        <DialogHeader>
          <DialogTitle>填单价{planNo ? `：${planNo}` : ""}</DialogTitle>
          <p className="ui-dialog-description">
            这里填的就是计划里那一格（第 8 列「单价」）：<strong>改完还要点「保存计划」</strong>才写进计划，
            关掉本窗口不会丢。单价 0 的行**不会下单**（收束下单时会被留在计划里），要下单就先在这里填上。
          </p>
        </DialogHeader>
        <DialogBody>
          <div className="page-actions">
            <Button size="sm" variant="secondary" data-testid="plan-price-import-bom" disabled={importing} onClick={onImportBom}>{importing ? "导入中…" : "导入 BOM 参考单价"}</Button>
            <span className="panel-note" data-testid="plan-price-import-result">
              {importOutcome ? priceImportSummary(importOutcome) : `只填空的未下单行（还有 ${pending} 行没填）；手填过的价与已下单的行一律不动`}
            </span>
          </div>
          {/* 行数多的计划一屏放不下：`pageSize` 给大值，宁可滚动也不要在浮层里分页
              （分页会把"还有几行没填"藏到下一页）。 */}
          <DataTable columns={columns} data={data} pageSize={500} tableClassName="plan-price-table" />
        </DialogBody>
        <DialogFooter>
          <Button size="sm" data-testid="plan-price-dialog-done" onClick={onClose}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
