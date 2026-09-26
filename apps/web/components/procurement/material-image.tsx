"use client";

// 物料图片的展示与上传（用户 2026-09-24：「物料清单，要给物料配上图片。图片上传之后要压缩成
// webp 再存进数据库里。所以要允许用户对对应的物料进行图片的上传」）。
//
// 两件事分开成两个组件，是因为它们出现在**不同的页面**上：
//   - `MaterialThumb`（只读缩略图）：物料清单页、销售单编辑器的材料明细（「每个部件……同时要体现
//     对应的物料的图片」）；
//   - `MaterialImageUploader`（上传 / 换图 / 删除）：只在物料清单页。
//
// 上传的压缩与网络请求都在 `lib/material-image.ts`（纯逻辑，有 node:test 覆盖），这里只负责
// 「按钮、进行中、失败原因」这三件界面上的事 —— 压缩那段的错误是给人看的话（「换 Chrome 或 Edge」），
// 所以必须原样显示在页面上，不能只丢一个 toast 就没了。
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { notifyError, notifySuccess } from "../ui/toaster";
import {
  MATERIAL_IMAGE_ACCEPT,
  deleteMaterialImage,
  materialImageProblem,
  materialImageUrl,
  uploadMaterialImage,
} from "../../lib/material-image";

/** 只读缩略图。加载不出来时给一个占位（表格里空一格会让人以为「坏了」而不是「还没传」）。 */
export function MaterialThumb({ materialId, version, alt, size = 40 }: { materialId: string; version?: string | number | null; alt?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  // 图换过之后地址里的 `?v=` 会变，所以「加载失败」这个状态要跟着地址**重置** ——
  // 不重置的话，一次网络抖动会让这一格在此后一直显示占位符，即使图其实好好的。
  useEffect(() => { setFailed(false); }, [version]);
  if (failed) return <span className="material-thumb material-thumb-empty" data-testid={`material-image-thumb-${materialId}`} style={{ width: size, height: size }}>—</span>;
  return (
    <img
      className="material-thumb"
      data-testid={`material-image-thumb-${materialId}`}
      src={materialImageUrl(materialId, version)}
      alt={alt ?? "物料图片"}
      width={size}
      height={size}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * 上传 / 换图 / 删除。
 *
 * 失败原因同时进 toast 与行内（`role="alert"`）：toast 会自己消失，而「这个浏览器不支持压 WebP」
 * 这种话必须留在页面上让用户看得见。
 */
export function MaterialImageUploader({ materialId, hasImage, version, onChanged }: {
  materialId: string;
  hasImage: boolean;
  version?: string | number | null;
  /** 上传/删除成功后通知父组件重新取列表（图片的存在与否在列表行上）。 */
  onChanged: () => void | Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function pick(file: File | undefined) {
    if (!file || busy) return;
    // 选之前先看能不能用：不是图片的话，连压缩都不用跑（更不用发请求）。
    const problem = materialImageProblem(file);
    if (problem) { setError(problem); notifyError(problem); return; }
    setBusy(true);
    setError("");
    try {
      await uploadMaterialImage(materialId, file);
      notifySuccess(hasImage ? "物料图片已替换" : "物料图片已上传");
      await onChanged();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "图片上传失败";
      setError(message);
      notifyError(message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await deleteMaterialImage(materialId);
      notifySuccess("物料图片已删除");
      await onChanged();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "删除图片失败";
      setError(message);
      notifyError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="material-image-cell">
      <div className="action-row">
        {hasImage && <MaterialThumb materialId={materialId} version={version} size={40} />}
        {/* 原生 input 藏起来（`.material-image-input`），用一个按钮去点它：
            `<input type=file>` 在各浏览器里的长相与文案都不一样，直接露出来会跟右边的按钮撞脸。
            这里不套 `FileInput` 是因为要拿 ref —— 那个组件不转发 ref。 */}
        <input
          ref={input}
          type="file"
          accept={MATERIAL_IMAGE_ACCEPT}
          className="material-image-input"
          data-testid={`material-image-input-${materialId}`}
          disabled={busy}
          onChange={(event) => { void pick(event.target.files?.[0]); event.currentTarget.value = ""; }}
        />
        <Button size="sm" variant="secondary" data-testid={`material-image-pick-${materialId}`} disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "处理中…" : hasImage ? "换图" : "上传图片"}
        </Button>
        {hasImage && <Button size="sm" variant="ghost" data-testid={`material-image-delete-${materialId}`} disabled={busy} onClick={() => void remove()}>删除图片</Button>}
      </div>
      {error && <p className="status-error" role="alert" data-testid={`material-image-error-${materialId}`}>{error}</p>}
    </div>
  );
}
