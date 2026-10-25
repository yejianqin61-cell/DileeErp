import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Request, Response } from "express";
import { map, Observable } from "rxjs";

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const requestId = request.header("x-request-id");
    return next.handle().pipe(map((data: unknown) => {
      // SSE（business-query-agent）自己写 text/event-stream 响应：响应已提交就原样放行，
      // 否则下面的 res.json 会在流中途再写头，直接报「Cannot set headers after they are sent」。
      if (response.headersSent) return data;
      if (data && typeof data === "object" && "data" in data) {
        const envelope = data as { data: unknown; meta?: Record<string, unknown> };
        return { data: envelope.data, meta: { ...envelope.meta, request_id: requestId } };
      }
      return { data: data ?? null, meta: { request_id: requestId } };
    }));
  }
}
