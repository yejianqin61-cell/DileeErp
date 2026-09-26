"use client";

// 工艺单「带图片导出」的勾选弹窗（用户 2026-09-24）。
//
// 用户原话：「导出销售单的时候，每个有图片的物料允许用户勾选是否 excel 中一并导出这个图片。
// excel 中图片我们就单独排成一排放在底下的一个图片区。然后让用户自行拖拽就好了」。
//
// 三条界面上的决定：
//   1. **只在「这一单真的引用了有图的物料」时才弹这个窗**（由父组件决定，见 app/sales/page.tsx）：
//      没图的时候多一步勾选纯属添乱，直接出单；
//   2. 默认**全勾**：点「工艺单」多半就是想要全带上，取消比一个个勾省事；
//   3. 每一行都带缩略图 —— 「每个有图片的物料允许用户勾选」这句话要成立，用户得先看见是哪张图
//      （只有文字的话，他没法判断该不该带上）。
//
// 转换与上传都在 `lib/production-sheet-image.ts`（纯逻辑，有 node:test 覆盖）：
// 这里只负责「勾了哪些」「导出中」「失败原因」这三件界面上的事。
import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { MaterialThumb } from "../procurement/material-image";
import { downloadFile, downloadFormPost } from "../../lib/download";
import { notifyError, notifySuccess } from "../ui/toaster";
import {
  browserSheetImageDeps,
  buildProductionSheetForm,
  candidateLabel,
  productionSheetExportPath,
  productionSheetFileName,
  selectableImages,
  type ExportImageCandidate,
} from "../../lib/production-sheet-image";

export default function ProductionSheetExportDialog({ orderId, orderNo, candidates, open, onOpenChange }: {
  orderId: string;
  orderNo: string;
  /** 已经取好的候选项（父组件为了决定「要不要弹窗」本来就要取一次，不再重复请求）。 */
  candidates: readonly ExportImageCandidate[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const selectable = useMemo(() => selectableImages(candidates), [candidates]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 每次打开都重置成「全勾」：上一次取消掉的那几张不该被记住 —— 财务/销售下次打开多半还是想全要。
  useEffect(() => {
    if (!open) return;
    setSelected(selectable.map((item) => item.spec_key));
    setError("");
  }, [open, selectable]);

  const toggle = (specKey: string) => setSelected((current) => current.includes(specKey) ? current.filter((key) => key !== specKey) : [...current, specKey]);

  /**
   * 导出。
   *
   * `withImages=false` 走 **GET**（普通工艺单，与列表页一键导出同一个入口）；
   * 带图走 **POST + multipart**（图片是二进制，塞不进 URL 也塞不进 JSON 的体积上限）。
   * 两条路在后端渲染的是同一份版式 —— 带图只是多一个表尾图片区。
   */
  async function run(withImages: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const fileName = productionSheetFileName(orderNo);
      if (!withImages) {
        await downloadFile(productionSheetExportPath(orderId), fileName);
        notifySuccess(`已导出 ${orderNo} 的工艺单（不含图片）`);
      } else {
        const chosen = selectable.filter((item) => selected.includes(item.spec_key));
        const form = await buildProductionSheetForm(chosen, browserSheetImageDeps());
        await downloadFormPost(productionSheetExportPath(orderId), form, fileName);
        notifySuccess(`已导出 ${orderNo} 的工艺单（含 ${chosen.length} 张图片）`);
      }
      onOpenChange(false);
    } catch (cause) {
      const message = cause instanceof Error && cause.message ? cause.message : "导出失败";
      setError(message);
      notifyError(message);
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <DialogContent className="production-sheet-image-dialog" data-testid="production-sheet-image-dialog">
      <DialogHeader>
        <DialogTitle>导出工艺单 {orderNo}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="panel-note" data-testid="production-sheet-image-hint">
          这一单的材料明细引用了 {selectable.length} 个<strong>有图片</strong>的物料。勾选的图片会排在本表<strong>底部的图片区</strong>
          （一排几张，每张下面写着它属于哪一格），导出后可在 Excel 里自行拖拽到材料行旁边。不勾任何一张就是普通工艺单。
        </p>
        <div className="table-wrap">
          <table className="ui-table">
            <thead><tr><th>导出图片</th><th>材料栏位 / 物料</th><th>预览</th></tr></thead>
            <tbody>
              {selectable.map((candidate) => <tr key={candidate.spec_key} data-testid={`production-sheet-image-row-${candidate.spec_key}`}>
                <td>
                  <label>
                    <input
                      type="checkbox"
                      data-testid={`production-sheet-image-check-${candidate.spec_key}`}
                      checked={selected.includes(candidate.spec_key)}
                      disabled={busy}
                      onChange={() => toggle(candidate.spec_key)}
                    />{" "}导出
                  </label>
                </td>
                <td>{candidateLabel(candidate)}</td>
                <td><MaterialThumb materialId={candidate.material_id} version={candidate.image_version} alt={candidateLabel(candidate)} size={56} /></td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {/* 不能导出时把原因写在界面上（按钮可能只是暂时禁用），与付款单弹窗同一条纪律。 */}
        {error && <p className="status-error" role="alert" data-testid="production-sheet-image-error">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" data-testid="production-sheet-image-cancel" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
        <Button variant="secondary" data-testid="production-sheet-image-without" disabled={busy} onClick={() => void run(false)}>{busy ? "导出中…" : "不带图片导出"}</Button>
        <Button data-testid="production-sheet-image-export" disabled={busy} onClick={() => void run(true)}>{busy ? "导出中…" : `导出（含 ${selected.length} 张图片）`}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
