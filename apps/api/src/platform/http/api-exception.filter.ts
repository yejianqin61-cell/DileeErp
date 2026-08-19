import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : undefined;
    const message = typeof payload === "string" ? payload : payload && typeof payload === "object" && "message" in payload ? payload.message : "服务器内部错误";
    const details = payload && typeof payload === "object" && "message" in payload && Array.isArray(payload.message) ? payload.message : [];
    response.status(status).json({
      error: { code: status === 500 ? "INTERNAL_ERROR" : this.errorCode(status), message: Array.isArray(message) ? "请求参数校验失败" : message, details },
      meta: { path: request.url, request_id: request.header("x-request-id") },
    });
  }

  private errorCode(status: number) {
    if (status === 400) return "VALIDATION_ERROR";
    if (status === 401) return "UNAUTHENTICATED";
    if (status === 403) return "FORBIDDEN";
    if (status === 404) return "NOT_FOUND";
    return "REQUEST_ERROR";
  }
}
