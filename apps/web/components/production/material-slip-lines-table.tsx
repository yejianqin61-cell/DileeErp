"use client";

// 单据详情弹窗里的「领用物料」表。
//
// 数据来自 `GET /production/material-movements/:id/slip-document`：那是**导出服务的组装结果**
// （与领料单/补料单打印件同一口径），配料 / 已领 / 本次 / 余下四个数量由后端算好，页面只显示。
// 为什么单独成组件：领料单列表页与生产单面板都要这张表，列名、列宽、数量口径只能有一份 ——
// 2026-10-29 之前页面自己有「生产领用数量/生产未领用数量」一套算法，与纸面差一个本次领料量，
// 车间拿打印件核对系统就对不上。要再算一遍数量，请回后端加字段，不要在这里补公式。
import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../data/data-table";
import { EmptyState } from "../feedback/states";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
// 搜索语义全站统一（空格分词的 AND、忽略大小写与空白、空查询不过滤），见 lib/fuzzy-search.ts。
import { fuzzyMatch } from "../../lib/fuzzy-search";

/** 单据明细行：字段名与 `MaterialSlipExportService` 的组装结果一一对应。 */
export type SlipDocumentLine = {
  sequence: number;
  materialName: string;
  materialCode: string;
  specificationModel: string;
  color: string;
  unit: string;
  /** 行备注（打印件不印，详情要看）。 */
  remark?: string | null;
  /** 领料单：配料数量（BOM 核定用量；非 BOM 物料留空）。 */
  bomQuantity?: number | null;
  /** 领料单：已领数量（本单之前，**不含本次**）。 */
  issuedQuantity?: number;
  /** 领料单：本次领料量。 */
  currentQuantity?: number;
  /** 领料单：余下数量（配料 − 已领 − 本次，可为负 = 超领）。 */
  remainingQuantity?: number | null;
  /** 补料单：补领数量（补料单纸面只有这一个数量）。 */
  replenishQuantity?: number;
  /** 供应商（空串表示「未指定」）。同一物料同供应商只能一行，这里展示该行所属供应商。 */
  supplierName?: string | null;
};

export type SlipDocument = { document_type: "issue" | "replenishment"; document: { lines: SlipDocumentLine[] } };

const text = (value: string | null | undefined) => (value && String(value).trim() ? String(value) : "-");
const amount = (value: number | null | undefined) => (value === null || value === undefined ? "-" : String(value));

/**
 * 两张表的列宽，各自合计**恰好 100%**：这张表没有审计列，缺的百分比会被浏览器摊给别的列，
 * 于是「本来只想收窄一列」会变成整张表都变。数字取舍见 docs/design/material-slip-form-quantities-2026-10-29.md。
 */
const ISSUE_WIDTH = { materialCode: "12%", materialName: "17%", specification: "13%", color: "7%", unit: "5%", supplier: "8%", bomQuantity: "10%", issuedQuantity: "9%", currentQuantity: "10%", remainingQuantity: "9%", remark: "7%" } as const;
const REPLENISHMENT_WIDTH = { materialCode: "16%", materialName: "24%", specification: "20%", color: "10%", unit: "8%", supplier: "10%", replenishQuantity: "12%", remark: "10%" } as const;

/** 两张表共用的前 5 列（物料资料）：两张表列宽不同，所以宽度由各自传入。 */
const baseColumns = (widths: { materialCode: string; materialName: string; specification: string; color: string; unit: string; supplier: string }): ColumnDef<SlipDocumentLine>[] => [
  { id: "materialCode", header: "物料编码", meta: { width: widths.materialCode }, accessorFn: (line) => text(line.materialCode) },
  { id: "materialName", header: "物料名称", meta: { width: widths.materialName }, accessorFn: (line) => text(line.materialName) },
  { id: "specification", header: "规格型号", meta: { width: widths.specification }, accessorFn: (line) => text(line.specificationModel) },
  { id: "color", header: "颜色", meta: { width: widths.color }, accessorFn: (line) => text(line.color) },
  { id: "unit", header: "单位", meta: { width: widths.unit }, accessorFn: (line) => text(line.unit) },
  { id: "supplier", header: "供应商", meta: { width: widths.supplier }, accessorFn: (line) => text(line.supplierName ?? null) },
];

/** 领料单：列名与打印件一致，四个数量连续排在一起。 */
const ISSUE_COLUMNS: ColumnDef<SlipDocumentLine>[] = [
  ...baseColumns(ISSUE_WIDTH),
  { id: "bomQuantity", header: "配料数量", meta: { width: ISSUE_WIDTH.bomQuantity }, accessorFn: (line) => amount(line.bomQuantity) },
  { id: "issuedQuantity", header: "已领数量", meta: { width: ISSUE_WIDTH.issuedQuantity }, accessorFn: (line) => amount(line.issuedQuantity) },
  { id: "currentQuantity", header: "本次领料量", meta: { width: ISSUE_WIDTH.currentQuantity }, accessorFn: (line) => amount(line.currentQuantity) },
  {
    id: "remainingQuantity", header: "余下数量", meta: { width: ISSUE_WIDTH.remainingQuantity },
    // 超领时与打印件一样是负数：标红提示，但数字本身照实显示（不抹成 0）。
    cell: ({ getValue }) => { const value = getValue<number | null>(); return value === null ? "-" : <span className={value < 0 ? "status-danger" : undefined}>{value}</span>; },
    accessorFn: (line) => line.remainingQuantity ?? null,
  },
  { id: "remark", header: "备注", meta: { width: ISSUE_WIDTH.remark }, accessorFn: (line) => text(line.remark) },
];

/** 补料单：纸面只有「补领数量」，没有四个数量列。 */
const REPLENISHMENT_COLUMNS: ColumnDef<SlipDocumentLine>[] = [
  ...baseColumns(REPLENISHMENT_WIDTH),
  { id: "replenishQuantity", header: "补领数量", meta: { width: REPLENISHMENT_WIDTH.replenishQuantity }, accessorFn: (line) => amount(line.replenishQuantity) },
  { id: "remark", header: "备注", meta: { width: REPLENISHMENT_WIDTH.remark }, accessorFn: (line) => text(line.remark) },
];

/**
 * 详情弹窗的明细表：按单据类型自动选领料/补料版式（列名与打印件一致）。
 *
 * 关键字搜索（2026-11-13，用户：「通览整个项目，统计所有下拉列表，所有表单是否都有搜索功能搜索框，
 * 如果没有，都需要加上搜索功能。因为现在单子多了，查找比较麻烦」）：一张领料单领十几种料时，
 * 核对「这批到底领没领伞骨」同样是肉眼在一串名字里找。
 *
 * 这张表**只读**（没有行内编辑，也没有按行下标绑定的 testid / onChange），所以过滤后的行可以直接
 * 交给 DataTable —— 与 BOM 那种可编辑表不同：那里必须带着**原始 index** 一起渲染（见
 * components/bom/bom-workbench.tsx 的 `visibleRows`），否则「改第 3 行」会改到别的行上。
 * 另一条不能忘的：`sequence`（打印件的行号）是**数据里带的**值，不是渲染下标，过滤不会让它错位。
 */
export function MaterialSlipLinesTable({ slip }: { slip: SlipDocument | null }) {
  const lines = slip?.document.lines ?? [];
  const columns = (slip?.document_type ?? "issue") === "replenishment" ? REPLENISHMENT_COLUMNS : ISSUE_COLUMNS;
  const [keyword, setKeyword] = useState("");
  /**
   * 过滤后的明细行：只匹配**文字**列（物料编码 / 名称 / 规格型号 / 颜色 / 单位 / 备注）。
   *
   * 刻意不把数量拼进可搜索文本：配料 5、已领 5、余下 5 会让「5」命中几乎每一行，
   * 「搜什么都能搜到」比搜不到更让人不信任这个框。要按数量核对，看的是这几个数字列本身。
   */
  const visibleLines = useMemo(() => (slip?.document.lines ?? []).filter((line) => fuzzyMatch(keyword, [
    line.materialCode, line.materialName, line.specificationModel, line.color, line.unit, line.supplierName, line.remark,
  ])), [slip, keyword]);
  return <>
    {/* 版式与其它列表页一致：filter-bar + 「筛选后 N / M」+ 清除搜索（用户在这种框里学到的操作要一致）。 */}
    <div className="filter-bar">
      <label>搜索物料编码、名称、规格型号、颜色或备注
        <Input data-testid="material-slip-lines-search" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入关键词，空格分隔多个词" />
      </label>
      {keyword.trim() ? <span className="panel-note" data-testid="material-slip-lines-count">筛选后 {visibleLines.length} / {lines.length} 行</span> : null}
      {keyword.trim() ? <Button variant="secondary" size="sm" onClick={() => setKeyword("")}>清除搜索</Button> : null}
    </div>
    <DataTable pageSize={50} columns={columns} data={visibleLines} empty={keyword.trim()
      // 「搜不到」与「本来就没有」分开说：前者是关键词打偏了（给总行数），后者是这张单真的没明细。
      ? <EmptyState title={`没有匹配“${keyword.trim()}”的物料行`} description={`本单共 ${lines.length} 行明细，换个关键词或清空搜索框。`} />
      : <EmptyState title="该单据没有物料明细" />} />
  </>;
}
