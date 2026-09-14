// 前端组件测试的 API 桩工具。
//
// 约定：被测组件的数据访问一律经由 lib/api-client.ts 的 fetch 调用，
// 因此在这一层替换 globalThis.fetch 就能同时覆盖 apiGet / apiRequest / apiPost / apiPatch，
// 不需要 mock 模块（避免 vi.mock 与真实模块形状漂移）。
//
// 用法：
//   const calls = stubApi((url) => url.endsWith("/customers") ? apiOk([{ id: "1" }]) : apiErr(404, "NOT_FOUND"));
//   render(<CustomersPage />);
//   expect(calls.map((c) => c.url)).toEqual(["/api/v1/customers"]);
import { vi } from "vitest";

export type StubbedCall = { url: string; method: string; body: unknown };

/** 成功信封，形状与后端 response-envelope.interceptor.ts 一致。 */
export function apiOk<T>(data: T, meta: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ data, meta }), { status: 200, headers: { "content-type": "application/json" } });
}

/** 失败信封，形状与后端 api-exception.filter.ts 一致。 */
export function apiErr(status: number, code: string, message = "请求失败") {
  return new Response(JSON.stringify({ error: { code, message, details: [] }, meta: {} }), { status, headers: { "content-type": "application/json" } });
}

/** 204 空体（POST /auth/logout 是唯一返回 204 的端点）。 */
export function apiNoContent() {
  return new Response(null, { status: 204 });
}

/**
 * 替换 globalThis.fetch。handler 按调用顺序被询问，返回的 Response 即当次响应。
 * setup.ts 的 afterEach 会自动还原，无需手动 un-stub。
 */
export function stubApi(handler: (url: string, call: StubbedCall) => Response | Promise<Response>): StubbedCall[] {
  const calls: StubbedCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: StubbedCall = { url, method: (init?.method ?? "GET").toUpperCase(), body: init?.body ?? null };
    calls.push(call);
    return handler(url, call);
  });
  return calls;
}

/** 只关心路径尾段的常用断言辅助：返回所有调用中匹配该后缀的调用。 */
export function callsTo(calls: StubbedCall[], suffix: string) {
  return calls.filter((call) => call.url.endsWith(suffix));
}
