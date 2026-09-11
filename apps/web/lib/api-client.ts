export type ApiSuccess<T> = { data: T; meta: Record<string, unknown> };
export type ApiFailure = { error: { code: string; message: string; details: unknown[] }; meta?: Record<string, unknown> };

export class ApiClientError extends Error {
  // 不用构造函数参数属性（constructor(public readonly code...)）：那种写法无法被 Node 的
  // strip-only 类型擦除解析，会导致 lib/**/*.test.mjs 无法直接 import 本模块做单测。
  readonly code: string;
  readonly details: unknown[];
  constructor(code: string, message: string, details: unknown[] = []) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export async function apiGet<T>(path: string): Promise<ApiSuccess<T>> {
  const response = await fetch(`/api/v1${path}`, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(10000) });
  const body = await response.json().catch(() => null) as ApiSuccess<T> | ApiFailure | null;
  if (!body) throw new ApiClientError(response.status === 401 ? "UNAUTHENTICATED" : "REQUEST_ERROR", `请求失败（HTTP ${response.status}）`);
  if (!response.ok || "error" in body) { const failure = body as ApiFailure; throw new ApiClientError(failure.error.code, failure.error.message, failure.error.details); }
  return body as ApiSuccess<T>;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<ApiSuccess<T>> {
  // 变更类请求必须有超时：一旦请求悬挂，ActionDialog 的 submitting 会永远为真，
  // 关闭按钮（X、遮罩、Esc）都被 onOpenChange 的 submitting 门禁挡住，弹窗再也关不掉。
  // 导出等长任务不走这里（各自用 fetch），所以 60 秒对提交类操作足够宽裕。
  const method = (options.method ?? "GET").toUpperCase();
  const signal = options.signal ?? (method === "GET" ? undefined : AbortSignal.timeout(60000));
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { ...options, signal, credentials: "include", cache: "no-store", headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
  } catch (cause) {
    if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) throw new ApiClientError("REQUEST_TIMEOUT", "请求超时，请重试");
    throw cause;
  }
  const body = await response.json().catch(() => ({})) as ApiSuccess<T> | ApiFailure;
  if (!response.ok || "error" in body) { const failure = body as ApiFailure; throw new ApiClientError(failure.error?.code ?? "REQUEST_ERROR", failure.error?.message ?? "请求失败", failure.error?.details ?? []); }
  return body as ApiSuccess<T>;
}
export const apiPost = <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPatch = <T>(path: string, body: unknown) => apiRequest<T>(path, { method: "PATCH", body: JSON.stringify(body) });
