"use client";

// 工艺单「带图片导出」的勾选弹窗（用户 2026-09-24；2026-11-04 扩到行级图片）。
//
// 用户原话：「导出销售单的时候，每个有图片的物料允许用户勾选是否 excel 中一并导出这个图片。
// excel 中图片我们就单独排成一排放在底下的一个图片区。然后让用户自行拖拽就好了」。
// 2026-11-04 的补充（docs/design/sales-order-row-images-2026-11-04.md §4.3）：候选项里现在
// 除了「引用物料的图」，还有**材料行自己的图**、「再加一款 / 其它」行的图、**细分明细行的图**。
// 它们各自的 `image_url` 由后端给（行图走销售单图片接口、物料图走物料图片接口），
// 所以缩略图直接 `<img src={candidate.image_url}>`，**不再**用 `MaterialThumb` 拼物料接口
// —— 行图根本没有物料 id，硬拼出来只会是破图。
//
// 三条界面上的决定：
//   1. **只在「这一单真的有可导出的图片」时才弹这个窗**（由父组件决定，见 sales-orders-list.tsx）：
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

/**
 * 候选缩略图：地址直接用后端给的 `image_url`（材料行图 / 明细行图是销售单图片接口，
 * 物料图是物料接口 —— 前端不需要认识这两种地址的区别，见 lib/production-sheet-image.ts 文件头）。
 * 加载不出来时给一个占位（表格里空一格会让人以为「坏了」而不是「还没传」），
 * 与物料清单的 `MaterialThumb` 同一条纪律。
 */
function CandidateThumb({ candidate }: { candidate: ExportImageCandidate }) {
  const [failed, setFailed] = useState(false);
  // 图换过之后 `?v=` 会变，所以「加载失败」要跟着地址重置（一次网络抖动不该让这一格此后一直是占位符）。
  useEffect(() => { setFailed(false); }, [candidate.image_url]);
  if (failed) return <span className="material-thumb material-thumb-empty" data-testid={`production-sheet-image-thumb-${candidate.spec_key}`} style={{ width: 56, height: 56 }}>—</span>;
  return <img
    className="material-thumb"
    data-testid={`production-sheet-image-thumb-${candidate.spec_key}`}
    src={candidate.image_url}
    alt={candidateLabel(candidate)}
    width={56}
    height={56}
    loading="lazy"
    onError={() => setFailed(true)}
  />;
}

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
   * 两条路在后端渲染的是同一份版式 —— 带图只是多出材料行图片区与明细行的图片列。
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
          这一单有 {selectable.length} 处<strong>可导出的图片</strong>：材料行的图排在表尾的<strong>图片区</strong>
          （一排几张，导出后可在 Excel 里自行拖拽到材料行旁边），细分明细行的图印在它那一行的<strong>「图片」列</strong>。
          不勾任何一张就是普通工艺单。
        </p>
        {/*
          行数多时列表自己滚（材料行 + 几十行明细行），底部的「导出」按钮始终露在外面；
          弹窗本身也有 80vh 上限，两层滚动有界，不会把整页顶开。
        */}
        <div className="table-wrap" style={{ maxHeight: "min(52vh, 560px)", overflow: "auto" }}>
          {/*
            手写表：`.table-bounded` 拿到固定布局，列宽总和 100%：导出图片 14% / 图片位置·物料 66% / 预览 20%。
            「图片位置 / 物料」是唯一的长文本列（`candidateLabel` 把栏位名 / 明细行名与物料信息拼起来），
            给它大头；预览列放 56px 缩略图，20% 在 1366 屏约 200px，绰绰有余；勾选列只要放得下
            「导出」两个字 + 复选框。表头/单元格的 `ui-table-head` / `ui-table-cell` 是补的 ——
            原来一个类都没有，`.table-bounded` 的省略规则挂在这两个类上（见 globals.css）。
          */}
          <table className="ui-table table-bounded">
            <thead><tr>
              <th className="ui-table-head cell-ellipsis" style={{ width: "14%" }} title="导出图片">导出图片</th>
              <th className="ui-table-head cell-ellipsis" style={{ width: "66%" }} title="图片位置 / 物料">图片位置 / 物料</th>
              <th className="ui-table-head cell-ellipsis" style={{ width: "20%" }} title="预览">预览</th>
            </tr></thead>
            <tbody>
              {selectable.map((candidate) => <tr key={candidate.spec_key} data-testid={`production-sheet-image-row-${candidate.spec_key}`}>
                <td className="ui-table-cell">
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
                <td className="ui-table-cell cell-ellipsis" title={candidateLabel(candidate)}>{candidateLabel(candidate)}</td>
                <td className="ui-table-cell"><CandidateThumb candidate={candidate} /></td>
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
