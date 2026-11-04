"use client";

// 采购与仓储报表（2026-11-04）：`/reports/procurement-warehouse`。
//
// 设计：`docs/design/procurement-warehouse-report-2026-11-04.md`。这张表回答的是
// 「一张订单上的一个物料：买了多少、回来多少、用了多少、还有多少」，入口挂在 `/reports` 页头
// （报表是一级导航下的第二层，与采购/仓库下的子页一致），不新开一级导航。
//
// 三条数据纪律（页面所有状态都围着它们转）：
//   1. **一次请求**：屏幕、导出、打印都用这一次 `GET .../procurement-warehouse` 的返回，不各自再拉，
//      也不分页拉取 —— 屏幕 200 行、导出 5000 行这种不一致无法解释；
//   2. **打印不额外请求**：纸面数据就是屏幕上这份（设计 §3.3），所以打印弹窗只做渲染；
//   3. **导出带的是"已应用到屏幕上"的筛选条件**，不是输入框里正在编辑的那两个值 ——
//      否则用户改了筛选没点查询就导出，导出的文件与屏幕对不上。
import { useEffect, useState } from "react";
import { Download, Printer } from "lucide-react";
import { PageHeader } from "../../../components/layout/app-shell";
import { ProcurementWarehousePrintSheet } from "../../../components/reports/procurement-warehouse-print-sheet";
import { ProcurementWarehouseReport } from "../../../components/reports/procurement-warehouse-report";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";
import { apiErrorText } from "../../../lib/api-error-text";
import { apiGet } from "../../../lib/api-client";
import { formatBeijing } from "../../../lib/audit-time";
import { downloadFile } from "../../../lib/download";
import {
  REPORT_EXPORT_FILE_NAME, REPORT_TITLE, reportDataUrl, reportExportUrl,
  type ProcurementWarehouseFilters, type ProcurementWarehouseMeta, type ProcurementWarehouseRow,
} from "../../../lib/procurement-warehouse-report";

const EMPTY_FILTERS: ProcurementWarehouseFilters = { order_no: "", material: "" };

export default function ProcurementWarehouseReportPage() {
  // 输入框里的值（可能已改但还没点「查询」）与真正生效的筛选分开：导出/打印/表格只能看生效的那份。
  const [filters, setFilters] = useState<ProcurementWarehouseFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<ProcurementWarehouseFilters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<ProcurementWarehouseRow[]>([]);
  const [meta, setMeta] = useState<ProcurementWarehouseMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [printedAt, setPrintedAt] = useState("");

  async function load(next: ProcurementWarehouseFilters = applied) {
    setLoading(true);
    setError("");
    try {
      const result = await apiGet<ProcurementWarehouseRow[]>(reportDataUrl(next));
      setRows(result.data ?? []);
      setMeta((result.meta ?? null) as ProcurementWarehouseMeta | null);
    } catch (cause) {
      // 后端 message 原样展示：4000+ 行时它是「结果过多，请按订单号或物料缩小范围」这类可操作的话，
      // 前端再包一层「数据加载失败」会把这句话吞掉，用户剩下的动作只有刷新。
      setError(apiErrorText(cause, "数据加载失败"));
      setRows([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(EMPTY_FILTERS); }, []);

  function search() {
    const next = { order_no: filters.order_no.trim(), material: filters.material.trim() };
    setApplied(next);
    void load(next);
  }

  function reset() {
    setFilters(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    void load(EMPTY_FILTERS);
  }

  async function exportExcel() {
    if (!rows.length) { notifyError("当前筛选条件下没有可导出的数据", "无法导出"); return; }
    setExporting(true);
    try {
      await downloadFile(reportExportUrl(applied), REPORT_EXPORT_FILE_NAME);
      notifySuccess(`已导出 ${typeof meta?.row_count === "number" ? meta.row_count : rows.length} 行${REPORT_TITLE}`);
    } catch (cause) {
      // downloadFile 已经把超时/连不上/后端 message 翻成人话，这里不再拼一层前缀。
      notifyError(cause instanceof Error ? cause.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  function openPrint() {
    // 空数据不弹射一个空气泡：A4 纸上只有表头会让拿到纸的人以为"这张单没有量"（设计 §3.3）。
    if (!rows.length) { notifyError("当前筛选条件下没有可打印的数据", "无法打印"); return; }
    // 打印时间按**按下去的那一刻**算，不是接口 generated_at：用户可能开着页面改了很久才打印。
    setPrintedAt(formatBeijing(new Date(), { seconds: true }));
    setPrintOpen(true);
  }

  return <div className="page-root" data-testid="page-reports-procurement-warehouse">
    <PageHeader title={REPORT_TITLE} description="按订单 × 物料对照采购、入库、生产领用与当前库存；一张订单上的一个物料一行。打印为 A4 横向纸面，导出为 Excel（与屏幕同一份数据）。">
      <Button data-testid="report-export" variant="secondary" disabled={exporting || loading} onClick={() => void exportExcel()}>{exporting ? "导出中..." : <><Download size={15} /> 导出 Excel</>}</Button>
      <Button data-testid="report-print" onClick={openPrint}><Printer size={15} /> 打印</Button>
    </PageHeader>

    <ProcurementWarehouseReport
      rows={rows}
      meta={meta}
      loading={loading}
      error={error}
      filters={filters}
      onFiltersChange={setFilters}
      onSearch={search}
      onReset={reset}
      onRetry={() => void load(applied)}
    />

    {/* 打印预览：纸上只留 `.procurement-warehouse-sheet`（globals.css 的 @media print 可见清单），
        再按浏览器打印/另存 PDF —— 与出库单、领料单、凭证纸同一做法。 */}
    <Dialog open={printOpen} onOpenChange={setPrintOpen}>
      <DialogContent className="procurement-warehouse-dialog" data-testid="report-print-dialog">
        <DialogHeader><DialogTitle>{REPORT_TITLE}打印</DialogTitle></DialogHeader>
        <DialogBody>
          <ProcurementWarehousePrintSheet rows={rows} filters={applied} printedAt={printedAt} />
        </DialogBody>
        <DialogFooter>
          <div className="action-row">
            <Button variant="secondary" onClick={() => setPrintOpen(false)}>关闭</Button>
            <Button data-testid="report-print-confirm" onClick={() => window.print()}>打印 / 另存 PDF</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
