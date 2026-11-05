"use client";

// 销售单**行图片**控件（2026-11-04「每种一张图」→ 2026-11-05「一条物料最多 3 张」）。
//
// 用户原话（2026-11-05）：「一条物料支持导入 3 张图片，现在只有 1 张」。
// 这个组件同时用在四处：材料明细 18 格、各固定类目的「再加一款」行、末尾的「其它」行、细分明细每行。
//
// ## 交互（设计文档 §4）
//   - 最多 `ROW_IMAGE_LIMIT`(3) 个 36px 缩略图并排；顺序 = 上传顺序；
//   - **点某张缩略图 = 换这一张**（同一个隐藏 input，`replaceIndex` 记住换第几张）；
//   - 每张缩略图旁边一个「删」：**只清客户端状态**（父组件把数组里那一项去掉）。后端没有 DELETE 端点，
//     保存时服务端把「本单没有任何活行引用的图片」软删（设计文档 §6 / 上一轮 §2.1），所以这里不发请求；
//   - 未满 3 张显示「上传图片 / 再加一张」；满 3 张禁用并提示「已满 3 张」；
//   - 没有归属单（新建/返单/复制还没保存）时整体禁用，`title` 写明「先保存销售单，再上传图片」
//     （页面上另有一处统一说明，编辑器在材料明细 / 细分明细各放一条，避免 18 格各重复一段灰字）。
//
// ## 行图优先 / 物料图兜底
// 这一行**一张行图都没有**时才显示引用了的那个物料的图（`MaterialThumb`，物料图接口）；
// 有任意一张行图就不显示物料图 —— 两张并排会让人以为这个位置存了两张。
//
// ## 「是否同时写入物料清单」只在第 1 张时问
// 组件只负责算准「这次上传是不是这一行的第 1 张」（`onUploaded` 的 `first`）；要不要弹确认由父组件决定
// （物料清单本身只有一张图，3 张都问会变成打扰）。
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { notifyError } from "../ui/toaster";
import { MaterialThumb } from "../procurement/material-image";
import { MATERIAL_IMAGE_ACCEPT, materialImageProblem, salesOrderImageUrl, uploadSalesOrderImage, type MaterialImageSummary } from "../../lib/material-image";
import { ROW_IMAGE_LIMIT, type RowImages } from "../../lib/sales-order-spec";

/** 兜底缩略图要的最少信息：引用了哪个物料、那张图换过没有（`sha256` 破缓存）。 */
type FallbackMaterial = { id: string; image?: { sha256?: string | null } | null };

export function SalesOrderRowImage({
  testId,
  orderId,
  canUpload,
  images,
  fallbackMaterial,
  alt,
  size = 36,
  onUploaded,
  onReplaced,
  onRemove,
}: {
  /** 定位钩子：根元素用它，子元素拼 `-pick` / `-input` / `-thumb-${i}` / `-remove-${i}` / `-error`。 */
  testId: string;
  /**
   * 图片**归属**的销售单 id：编辑态 = 本单；返单/复制 = 来源单（缩略图要能从来源单读出来）。
   * `null` = 既没有本单也没有来源（Excel 补录的空白表单）。
   */
  orderId: string | null;
  /** 能不能**上传**：只有编辑既有单时才有归属，新建/返单/复制都先禁用（先保存，再补图）。 */
  canUpload: boolean;
  /** 这一行自己的图（0–3 张，顺序 = 用户看到的顺序）。 */
  images: RowImages;
  /** 引用了物料时的兜底图；这一行一张行图都没有时才显示。 */
  fallbackMaterial?: FallbackMaterial | null;
  alt?: string;
  size?: number;
  /** 追加一张（`first` = 上传前这一行是空的，父组件据此决定要不要问「同时写入物料清单」）。 */
  onUploaded: (image: MaterialImageSummary, file: File, info: { first: boolean }) => void;
  /** 换掉第 `index` 张（位置不变）。 */
  onReplaced: (index: number, image: MaterialImageSummary) => void;
  /** 删掉第 `index` 张（只清客户端状态）。 */
  onRemove: (index: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  /** `null` = 追加（「上传图片 / 再加一张」）；数字 = 换第 index 张。 */
  const replaceIndex = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [failedIndex, setFailedIndex] = useState<number | null>(null);

  // 行图地址（只有「有归属单」才拼得出来）：`?v=sha256` 破缓存。
  const urls = images.map((image) => (orderId ? salesOrderImageUrl(orderId, image.id, image.sha256) : null));
  // 图换过之后地址里的 `?v=` 会变，所以「加载失败」要跟着地址**重置** ——
  // 不重置的话，一次网络抖动会让那一格在此后一直显示占位符，即使图其实好好的。
  const urlSignature = urls.join("|");
  useEffect(() => { setFailedIndex(null); }, [urlSignature]);

  const full = images.length >= ROW_IMAGE_LIMIT;
  // 行图优先：有任意一张行图就不显示物料兜底图（两个都显示会让人以为存了两张）。
  const fallback = images.length > 0 ? null : (fallbackMaterial ?? null);

  function openPicker(index: number | null) {
    if (busy || !canUpload) return;
    replaceIndex.current = index;
    input.current?.click();
  }

  async function pick(file: File | undefined) {
    if (!file || busy || !canUpload || !orderId) return;
    // 选之前先看能不能用（不是图片的话连压缩都不用跑，更不用发请求）。
    const problem = materialImageProblem(file);
    if (problem) { setError(problem); notifyError(problem); return; }
    const index = replaceIndex.current;
    replaceIndex.current = null;
    const first = index === null && images.length === 0;
    setBusy(true);
    setError("");
    try {
      const summary = await uploadSalesOrderImage(orderId, file);
      if (index === null) onUploaded(summary, file, { first });
      else onReplaced(index, summary);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "图片上传失败";
      setError(message);
      notifyError(message);
    } finally {
      setBusy(false);
    }
  }

  const addLabel = images.length === 0 ? "上传图片" : "再加一张";
  const addDisabled = busy || !canUpload || full;
  const addTitle = !canUpload ? "先保存销售单，再上传图片" : full ? `已满 ${ROW_IMAGE_LIMIT} 张` : addLabel;

  return (
    <div className="material-image-cell" data-testid={testId}>
      <div className="action-row">
        {images.map((image, index) => {
          const url = urls[index];
          const failed = failedIndex === index;
          return (
            // 一张图 = 「缩略图（点它换图）」+「删」两个动作竖排；用内联样式而不是新 CSS 类，
            // 因为这次改动的写作用域不含 globals.css（复用既有 .material-thumb 的观感）。
            <span key={`${image.id}-${index}`} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2 }} data-testid={`${testId}-slot-${index}`}>
              {url && !failed ? (
                <button
                  type="button"
                  data-testid={`${testId}-replace-${index}`}
                  title={canUpload ? `点这张图换第 ${index + 1} 张` : `第 ${index + 1} 张`}
                  aria-label={`${alt ?? "行图片"}第 ${index + 1} 张${canUpload ? "（点击换图）" : ""}`}
                  disabled={busy || !canUpload}
                  onClick={() => openPicker(index)}
                  style={{ border: 0, padding: 0, background: "transparent", lineHeight: 0, cursor: canUpload ? "pointer" : "default" }}
                >
                  <img className="material-thumb" data-testid={`${testId}-thumb-${index}`} src={url} alt={`${alt ?? "行图片"}第 ${index + 1} 张`} width={size} height={size} onError={() => setFailedIndex(index)} />
                </button>
              ) : (
                <span className="material-thumb material-thumb-empty" data-testid={`${testId}-thumb-${index}`} style={{ width: size, height: size }}>—</span>
              )}
              <Button
                size="sm"
                variant="ghost"
                data-testid={`${testId}-remove-${index}`}
                title={`删除第 ${index + 1} 张（保存后生效）`}
                aria-label={`删除第 ${index + 1} 张`}
                disabled={busy}
                onClick={() => onRemove(index)}
              >删</Button>
            </span>
          );
        })}
        {fallback ? <MaterialThumb materialId={fallback.id} version={fallback.image?.sha256} alt={alt} size={size} /> : null}
        {/* 原生 input 藏起来（`.material-image-input`），用按钮/缩略图去点它 —— 与物料清单页的做法一致。 */}
        <input
          ref={input}
          type="file"
          accept={MATERIAL_IMAGE_ACCEPT}
          className="material-image-input"
          data-testid={`${testId}-input`}
          disabled={busy || !canUpload}
          onChange={(event) => { void pick(event.target.files?.[0]); event.currentTarget.value = ""; }}
        />
        <Button
          size="sm"
          variant="secondary"
          data-testid={`${testId}-pick`}
          disabled={addDisabled}
          title={addTitle}
          onClick={() => openPicker(null)}
        >
          {busy ? "处理中…" : addLabel}
        </Button>
      </div>
      {full ? <span className="panel-note" data-testid={`${testId}-full`}>已满 {ROW_IMAGE_LIMIT} 张</span> : null}
      {error ? <p className="status-error" role="alert" data-testid={`${testId}-error`}>{error}</p> : null}
    </div>
  );
}
