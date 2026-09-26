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

/** 把一次导出请求的失败翻译成能给用户看的错误（超时 / 连不上 / 后端的 error.message）。 */
async function failureOf(cause: unknown, response?: Response): Promise<Error> {
  if (cause) {
    if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) return new Error("导出超时，请缩小筛选范围后重试");
    return new Error("无法连接服务，导出失败");
  }
  const body = await response!.json().catch(() => null) as { error?: { message?: string } } | null;
  return new Error(body?.error?.message ?? `导出失败（HTTP ${response!.status}）`);
}

/** 响应体 → 浏览器下载（文件名优先取后端给的那个，缺失时才用兜底名）。 */
async function saveAs(response: Response, fallbackName: string): Promise<void> {
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filenameFromDisposition(response.headers.get("content-disposition"), fallbackName);
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

/** 触发浏览器下载；失败时抛出可读错误（含超时与后端错误信息）。 */
export async function downloadFile(url: string, fallbackName: string, timeoutMs = 120000): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw await failureOf(cause);
  }
  if (!response.ok) throw await failureOf(null, response);
  await saveAs(response, fallbackName);
}

/**
 * 带 JSON body 的下载（POST 导出）。
 *
 * 为什么付款单要走 POST 而不是像台账那样拼查询串：付款单是**服务端渲染**的一份文件，
 * 而它上面每一个字段（金额、分录行、付款备注）都是财务在界面上现改的 ——
 * 那些内容塞不进 URL，也必须有请求体长度上限（见 finance-slip.controller.ts 的 DTO）。
 *
 * 超时与错误翻译与 `downloadFile` 共用一处：两条路必须给出同样的「导出超时 / 无法连接服务」
 * 提示，否则用户分不清是网络问题还是这张单子有问题。
 */
export async function downloadPost(url: string, body: unknown, fallbackName: string, timeoutMs = 120000): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw await failureOf(cause);
  }
  if (!response.ok) throw await failureOf(null, response);
  await saveAs(response, fallbackName);
}

/**
 * 带 **multipart** body 的下载（POST 导出，请求里带文件）。
 *
 * 为什么需要它（而不是复用 `downloadPost`）：工艺单要一并导出用户勾选的物料图片，
 * 而图片是二进制 —— 塞进 JSON 会撞上后端 Express 默认 100KB 的 body 上限，放开那个上限是
 * 拿整站攻击面换一个导出接口。multipart 本来就是为字节准备的。
 *
 * ⚠️ **不要**自己写 `Content-Type`：multipart 的 boundary 由浏览器生成，
 * 手写一个 `multipart/form-data` 会缺少 boundary，后端解析不出任何字段（表现为「一张图都没有」）。
 * 超时给 5 分钟：十几张图要先在浏览器里转码再上传。
 */
export async function downloadFormPost(url: string, form: FormData, fallbackName: string, timeoutMs = 300000): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw await failureOf(cause);
  }
  if (!response.ok) throw await failureOf(null, response);
  await saveAs(response, fallbackName);
}
