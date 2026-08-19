export type ApiSuccess<T> = { data: T; meta: Record<string, unknown> };
export type ApiFailure = { error: { code: string; message: string; details: unknown[] }; meta?: Record<string, unknown> };

export class ApiClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: unknown[] = []) { super(message); }
}

export async function apiGet<T>(path: string): Promise<ApiSuccess<T>> {
  const response = await fetch(`/api/v1${path}`, { credentials: "include" });
  const body = await response.json() as ApiSuccess<T> | ApiFailure;
  if (!response.ok || "error" in body) { const failure = body as ApiFailure; throw new ApiClientError(failure.error.code, failure.error.message, failure.error.details); }
  return body as ApiSuccess<T>;
}
