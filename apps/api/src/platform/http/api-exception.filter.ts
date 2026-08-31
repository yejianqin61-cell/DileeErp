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
    const isUniqueViolation = exception && typeof exception === "object" && "code" in exception && exception.code === "P2002";
    const status = isUniqueViolation ? HttpStatus.CONFLICT : exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const error = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`${request.method} ${request.url}`, error.stack);
    }
    const payload = isUniqueViolation ? this.uniquePayload(exception) : exception instanceof HttpException ? exception.getResponse() : undefined;
    const normalized = this.normalizePayload(payload, status);
    response.status(status).json({
      error: normalized,
      meta: { path: request.url, request_id: request.header("x-request-id") },
    });
  }

  private uniquePayload(exception: unknown) {
    const target = exception && typeof exception === "object" && "meta" in exception && Array.isArray((exception as { meta?: { target?: unknown } }).meta?.target)
      ? (exception as { meta: { target: string[] } }).meta.target
      : [];
    const labels: Record<string, string> = { idempotency_key: "幂等键", employee_no: "员工编号", operation_code: "工序编码", production_order_no: "生产单号", purchase_order_no: "采购单号", receipt_no: "到货单号", inbound_no: "入库单号", material_code: "物料编码", production_order_operation_id: "工序与日期组合" };
    const field = target[0];
    const label = field ? labels[field] ?? field : "业务唯一字段";
    const objectType = field === "idempotency_key" ? "工序员工日报" : "业务记录";
    return { code: "UNIQUE_VALUE_CONFLICT", message: `${objectType}的${label}已存在，请检查后重试`, details: [{ object: objectType, field: field ?? null, field_label: label, target }] };
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
