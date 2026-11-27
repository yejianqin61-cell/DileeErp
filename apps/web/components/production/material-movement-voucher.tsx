"use client";

// 原料流转单据的凭证上传：先传附件，再关联到单据。
// 后端没有「按单据列附件」的接口，所以这里只能列出本次弹窗里传过的文件名。
import { useState } from "react";
import { FileInput } from "../ui/file-input";
import { notifyError, notifySuccess } from "../ui/toaster";
import { ApiClientError, apiPost, apiRequest } from "../../lib/api-client";

// 与后端附件接口一致：文件需小于 20MB（multer 对正好达到上限的文件也会拒绝）。
const MAX_VOUCHER_BYTES = 20 * 1024 * 1024;
const VOUCHER_ACCEPT = "application/pdf,image/jpeg,image/png,.xls,.xlsx";

async function uploadFile(file: File): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  // 不走 apiRequest：它固定发 JSON 的 content-type，multipart 的边界要由浏览器自己写。
  const response = await fetch("/api/v1/attachments", { method: "POST", body, credentials: "include", signal: AbortSignal.timeout(120000) });
  // 网关拦下的请求（如 413）返回的不是 JSON。
  const result = await response.json().catch(() => null) as { data?: { id: string }; error?: { code?: string; message?: string } } | null;
  if (!response.ok || !result?.data) throw new ApiClientError(result?.error?.code ?? "REQUEST_ERROR", result?.error?.message ?? `附件上传失败（HTTP ${response.status}）`);
  return result.data.id;
}

async function attachVoucher(movementId: string, file: File) {
  const attachmentId = await uploadFile(file);
  try {
    await apiPost(`/attachments/${attachmentId}/links`, { entity_type: "raw_material_movement", entity_id: movementId, remark: "原料流转附件" });
  } catch (cause) {
    // 只有服务端明确拒绝时才删掉刚传的附件；超时或网关错误时关联可能已经成功，不能删。
    if (cause instanceof ApiClientError && !["REQUEST_TIMEOUT", "REQUEST_ERROR"].includes(cause.code)) {
      await apiRequest(`/attachments/${attachmentId}`, { method: "DELETE" }).catch(() => undefined);
    }
    throw cause;
  }
}

export function MovementVoucherUpload({ movementId }: { movementId: string }) {
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<string[]>([]);

  async function upload(file: File) {
    if (file.size >= MAX_VOUCHER_BYTES) { notifyError("文件需小于 20MB"); return; }
    setUploading(true);
    try {
      await attachVoucher(movementId, file);
      setUploaded((names) => [...names, file.name]);
      notifySuccess("附件已关联");
    } catch (cause) {
      notifyError(cause instanceof ApiClientError ? cause.message : "附件上传失败");
    } finally {
      setUploading(false);
    }
  }

  return <div data-testid="material-movement-voucher">
    <label>上传凭证
      <FileInput accept={VOUCHER_ACCEPT} data-testid="material-voucher-file" disabled={uploading} onChange={(event) => {
        const file = event.target.files?.[0];
        // 清空选择，同一个文件失败后可以直接再选一次。
        event.target.value = "";
        if (file) void upload(file);
      }} />
    </label>
    {uploading ? <p className="panel-note" role="status">上传中…</p> : null}
    {uploaded.length ? <p className="panel-note">本次已上传：{uploaded.join("、")}</p> : null}
  </div>;
}
