export type ApiSuccess<T> = { data: T; meta: Record<string, unknown> };
export type ApiFailure = { error: { code: string; message: string; details: unknown[] }; meta?: Record<string, unknown> };

export class ApiClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: unknown[] = []) { super(message); }
}

export async function apiGet<T>(path: string): Promise<ApiSuccess<T>> {
  const response = await fetch(`/api/v1${path}`, { credentials: "include", signal: AbortSignal.timeout(10000) });
  const body = await response.json() as ApiSuccess<T> | ApiFailure;
  if (!response.ok || "error" in body) { const failure = body as ApiFailure; throw new ApiClientError(failure.error.code, failure.error.message, failure.error.details); }
  return body as ApiSuccess<T>;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<ApiSuccess<T>> {
  const response = await fetch(`/api/v1${path}`, { ...options, credentials: "include", headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
  const body = await response.json().catch(() => ({})) as ApiSuccess<T> | ApiFailure;
  if (!response.ok || "error" in body) { const failure = body as ApiFailure; throw new ApiClientError(failure.error?.code ?? "REQUEST_ERROR", failure.error?.message ?? "请求失败", failure.error?.details ?? []); }
  return body as ApiSuccess<T>;
}
export const apiPost = <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPatch = <T>(path: string, body: unknown) => apiRequest<T>(path, { method: "PATCH", body: JSON.stringify(body) });
