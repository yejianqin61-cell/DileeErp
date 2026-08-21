import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import { map, Observable } from "rxjs";

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const requestId = request.header("x-request-id");
    return next.handle().pipe(map((data: unknown) => {
      if (data && typeof data === "object" && "data" in data) {
        const envelope = data as { data: unknown; meta?: Record<string, unknown> };
        return { data: envelope.data, meta: { ...envelope.meta, request_id: requestId } };
      }
      return { data: data ?? null, meta: { request_id: requestId } };
    }));
  }
}
