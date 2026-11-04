"use client";

// 销售单**行图片**控件（2026-11-04「每种一张图」）。
//
// 用户原话：「销售订单要支持每个物料插入图片……一个生产单里有 5 种伞布，11 种伞头，能在每种里插入图片」。
// 这个组件同时用在四处：材料明细 18 格、各固定类目的「再加一款」行、末尾的「其它」行、细分明细每行。
//
// ## 三件事，各归各处
//   1. **显示**：行自己的图优先；没有才回退「引用了的那个物料」的图（`fallbackMaterial`）。
//      物料图的路由在 `MaterialThumb` 里（物料图接口），行图走 `salesOrderImageUrl`（销售单图片接口）。
//   2. **上传 / 换图**：压缩与请求都在 `lib/material-image.ts`（`uploadSalesOrderImage`，纯逻辑有 node:test），
//      这里只负责「按钮、进行中、失败原因」这三件界面上的事。
//   3. **删除**：只清客户端状态（父组件把这一行的 `image` 置空）。后端**没有 DELETE 端点**：
//      保存时服务端把「本单没有任何活行引用的图片」软删（设计文档 §2.1），所以这里不必发请求。
//
// ## 为什么上传按钮会禁用
// 图片按销售单隔离：新建单还没有 id，就没有归属（设计文档 §7.1，有意的最小实现）。
// 禁用时 `title` 里写明原因；页面上另有一处统一的说明（编辑器在材料明细 / 细分明细各放一条），
// 避免 18 格 × 每行都重复一段灰字。
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { notifyError } from "../ui/toaster";
import { MaterialThumb } from "../procurement/material-image";
import { MATERIAL_IMAGE_ACCEPT, materialImageProblem, salesOrderImageUrl, uploadSalesOrderImage, type MaterialImageSummary } from "../../lib/material-image";
import type { RowImageMeta } from "../../lib/sales-order-spec";

/** 兜底缩略图要的最少信息：引用了哪个物料、那张图换过没有（`sha256` 破缓存）。 */
type FallbackMaterial = { id: string; image?: { sha256?: string | null } | null };

export function SalesOrderRowImage({
  testId,
  orderId,
  canUpload,
  image,
  fallbackMaterial,
  alt,
  size = 36,
  onUploaded,
  onRemove,
}: {
  /** 定位钩子：根元素用它，子元素拼 `-thumb` / `-pick` / `-input` / `-remove` / `-error`。 */
  testId: string;
  /**
   * 图片**归属**的销售单 id：编辑态 = 本单；返单/复制 = 来源单（缩略图要能从来源单读出来）。
   * `null` = 既没有本单也没有来源（Excel 补录的空白表单）。
   */
  orderId: string | null;
  /** 能不能**上传**：只有编辑既有单时才有归属，新建/返单/复制都先禁用（先保存，再补图）。 */
  canUpload: boolean;
  /** 这一行自己的图（优先）。 */
  image: RowImageMeta | null;
  /** 引用了物料时的兜底图；没有引用就传 null。 */
  fallbackMaterial?: FallbackMaterial | null;
  alt?: string;
  size?: number;
  /** 上传成功：父组件负责把摘要挂到行上，并决定要不要问「是否同时写入物料清单」。 */
  onUploaded: (image: MaterialImageSummary, file: File) => void;
  /** 删掉这一行自己的图（只清状态；保存时服务端清理无引用图片）。 */
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);

  // 行图地址（只有「有归属单 + 这一行有图」才存在）：`?v=sha256` 破缓存。
  const ownUrl = image && orderId ? salesOrderImageUrl(orderId, image.id, image.sha256) : null;
  // 图换过之后地址里的 `?v=` 会变，所以「加载失败」要跟着地址**重置**（与 MaterialThumb 同一条理由）。
  useEffect(() => { setFailed(false); }, [ownUrl]);

  const hasOwnImage = Boolean(ownUrl);
  // 行图优先：这一行自己已经挂了图，就不再显示物料图（两个都显示会让人以为存了两张）。
  const fallback = hasOwnImage ? null : (fallbackMaterial ?? null);

  async function pick(file: File | undefined) {
    if (!file || busy || !canUpload || !orderId) return;
    // 选之前先看能不能用（不是图片的话连压缩都不用跑，更不用发请求）。
    const problem = materialImageProblem(file);
    if (problem) { setError(problem); notifyError(problem); return; }
    setBusy(true);
    setError("");
    try {
      const summary = await uploadSalesOrderImage(orderId, file);
      onUploaded(summary, file);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "图片上传失败";
      setError(message);
      notifyError(message);
    } finally {
      setBusy(false);
    }
  }

  const pickLabel = hasOwnImage ? "换图" : "上传图片";
  // 行图删掉之后还能退回**物料图**时才说「恢复用物料图」——物料本身也没图的话，删就是删。
  const hasFallbackImage = Boolean(fallbackMaterial?.image);
  const removeLabel = hasFallbackImage ? "恢复用物料图" : "删除图片";

  return (
    <div className="material-image-cell" data-testid={testId}>
      <div className="action-row">
        {hasOwnImage && !failed ? (
          <img
            className="material-thumb"
            data-testid={`${testId}-thumb`}
            src={ownUrl!}
            alt={alt ?? "行图片"}
            width={size}
            height={size}
            onError={() => setFailed(true)}
          />
        ) : null}
        {hasOwnImage && failed ? (
          <span className="material-thumb material-thumb-empty" data-testid={`${testId}-thumb`} style={{ width: size, height: size }}>—</span>
        ) : null}
        {fallback ? <MaterialThumb materialId={fallback.id} version={fallback.image?.sha256} alt={alt} size={size} /> : null}
        {/* 原生 input 藏起来（`.material-image-input`），用按钮去点它 —— 与物料清单页的做法一致。 */}
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
          disabled={busy || !canUpload}
          title={canUpload ? pickLabel : "先保存销售单，再上传图片"}
          onClick={() => input.current?.click()}
        >
          {busy ? "处理中…" : pickLabel}
        </Button>
        {hasOwnImage ? (
          <Button size="sm" variant="ghost" data-testid={`${testId}-remove`} title={removeLabel} onClick={onRemove}>
            {removeLabel}
          </Button>
        ) : null}
      </div>
      {error ? <p className="status-error" role="alert" data-testid={`${testId}-error`}>{error}</p> : null}
    </div>
  );
}
