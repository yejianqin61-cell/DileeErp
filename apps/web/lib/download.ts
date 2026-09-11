// 文件下载：与 payroll-export-panel 一致走 fetch + blob（带鉴权 cookie），
// 额外处理两件事：请求超时（否则界面会一直卡在"导出中"）与后端 UTF-8 文件名。

/** 从 Content-Disposition 解析文件名，支持 filename*=UTF-8'' 与普通 filename="..."。 */
export function filenameFromDisposition(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const utf8 = /filename\*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (utf8) {
    try { return decodeURIComponent(utf8[1].trim()); } catch { return fallback; }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : fallback;
}

/** 触发浏览器下载；失败时抛出可读错误（含超时与后端错误信息）。 */
export async function downloadFile(url: string, fallbackName: string, timeoutMs = 120000): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) throw new Error("导出超时，请缩小筛选范围后重试");
    throw new Error("无法连接服务，导出失败");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `导出失败（HTTP ${response.status}）`);
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filenameFromDisposition(response.headers.get("content-disposition"), fallbackName);
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}
