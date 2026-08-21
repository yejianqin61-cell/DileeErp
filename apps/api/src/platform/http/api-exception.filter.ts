import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Request, Response } from "express";

type ExceptionPayload = { code?: string; message?: string | string[]; details?: unknown[] };

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const error = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`${request.method} ${request.url}`, error.stack);
    }
    const payload = exception instanceof HttpException ? exception.getResponse() : undefined;
    const normalized = this.normalizePayload(payload, status);
    response.status(status).json({
      error: normalized,
      meta: { path: request.url, request_id: request.header("x-request-id") },
    });
  }

  private normalizePayload(payload: unknown, status: number) {
    if (typeof payload === "string") return { code: this.errorCode(status), message: payload, details: [] };

    const candidate = payload && typeof payload === "object" ? payload as ExceptionPayload : {};
    const message = Array.isArray(candidate.message) ? "请求参数校验失败" : candidate.message ?? (status === 500 ? "服务器内部错误" : "请求处理失败");
    const details = candidate.details ?? (Array.isArray(candidate.message) ? candidate.message.map((item) => ({ message: item })) : []);
    return { code: candidate.code ?? this.errorCode(status), message, details };
  }

  private errorCode(status: number) {
    if (status === 400) return "VALIDATION_ERROR";
    if (status === 401) return "UNAUTHENTICATED";
    if (status === 403) return "FORBIDDEN";
    if (status === 404) return "NOT_FOUND";
    if (status === 409) return "CONFLICT";
    if (status === 422) return "BUSINESS_RULE_VIOLATION";
    return "REQUEST_ERROR";
  }
}
