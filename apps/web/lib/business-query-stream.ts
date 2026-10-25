/**
 * SSE 读取器：fetch 流式解析（不用 EventSource —— 要自带 Last-Event-ID 头与统一错误处理）。
 *
 * 契约（模块设计「SSE 与前后端状态机怎样恢复」）：
 *   - `data:` 行是版本化 JSON `{v,run_id,seq,type,at,data}`；`id:` 行是 `<runId>:<seq>`；
 *   - `:` 开头是心跳注释；
 *   - 断线自动续接（带 Last-Event-ID），**不重新 POST 提问**；收到 completed/error/cancelled 即止。
 *   - 401/403/404 不是断线：直接抛给页面（未登录跳转 / 无权读取）。
 */

export type SseEvent = { seq: number; type: string; data: Record<string, unknown> };

export type FollowRunOptions = {
  runId: string;
  lastSeq: number;
  signal: AbortSignal;
  onEvent: (event: SseEvent) => void;
  onOpen?: () => void;
  /** 每次准备重试（断线后续接）前回调，页面据此把状态切到 disconnected。 */
  onRetry?: () => void;
  maxRetries?: number;
  retryDelayMs?: number;
};

const TERMINAL_EVENT_TYPES = new Set(["completed", "error", "cancelled"]);

export async function followRunStream(options: FollowRunOptions): Promise<void> {
  const maxRetries = options.maxRetries ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 1500;
  let lastSeq = options.lastSeq;
  let retries = 0;

  while (!options.signal.aborted) {
    let sawTerminal = false;
    try {
      const response = await fetch(`/api/v1/business-query/runs/${encodeURIComponent(options.runId)}/events`, {
        headers: {
          accept: "text/event-stream",
          ...(lastSeq > 0 ? { "last-event-id": `${options.runId}:${lastSeq}` } : {}),
        },
        signal: options.signal,
      });
      if ([401, 403, 404].includes(response.status)) throw new Error(`SSE_REFUSED_${response.status}`);
      if (!response.ok || !response.body) throw new Error(`SSE_HTTP_${response.status}`);
      options.onOpen?.();
      retries = 0;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          for (const line of frame.split("\n")) {
            if (line.startsWith(":") || !line.startsWith("data:")) continue;
            try {
              const payload = JSON.parse(line.slice(5).trim()) as { seq?: number; type?: string; data?: Record<string, unknown> };
              if (typeof payload.seq === "number" && typeof payload.type === "string") {
                lastSeq = Math.max(lastSeq, payload.seq);
                options.onEvent({ seq: payload.seq, type: payload.type, data: payload.data ?? {} });
                if (TERMINAL_EVENT_TYPES.has(payload.type)) sawTerminal = true;
              }
            } catch {
              // 单帧损坏：丢弃这一帧，连接继续（事件表是权威，重连可补）。
            }
          }
        }
      }
      if (options.signal.aborted) return;
    } catch (error) {
      if (options.signal.aborted) return;
      const message = String((error as Error)?.message ?? error);
      if (message.startsWith("SSE_REFUSED_")) throw new Error(message === "SSE_REFUSED_401" ? "登录状态已失效，请重新登录" : "当前档位无法读取该回答");
    }
    if (sawTerminal) return;

    retries += 1;
    if (retries > maxRetries) throw new Error("与服务的连接中断，请刷新页面重试");
    options.onRetry?.();
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}
