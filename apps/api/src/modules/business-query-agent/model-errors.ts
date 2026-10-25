import { HttpException, HttpStatus } from "@nestjs/common";
import { APICallError, AISDKError } from "ai";

/**
 * 模型提供商错误 → 稳定 API 错误码（R-11：模型错误只映射为稳定码，**原始响应体不外传**）。
 * DeepSeek 的 4xx 报文里可能带请求片段（业务值可能藏在其中），所以 message 一律用固定文案。
 */

export type AgentModelErrorCode =
  | "AGENT_MODEL_CONTEXT_EXCEEDED"
  | "AGENT_MODEL_AUTH"
  | "AGENT_MODEL_UNAVAILABLE"
  | "AGENT_MODEL_TIMEOUT"
  | "AGENT_MODEL_ERROR";

const CONTEXT_PATTERN = /context[_\s-]?length|maximum[_\s-]?context|too many tokens|token limit|context window/i;

/** 编排器的统一 failed 收口消费这个异常的 code；非模型异常原样放行。 */
export function mapModelError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  const name = typeof error === "object" && error !== null ? (error as { name?: string }).name : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return new HttpException({ code: "AGENT_MODEL_TIMEOUT", message: "模型响应超时，请重试", details: [] }, HttpStatus.GATEWAY_TIMEOUT);
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? 0;
    const body = typeof error.responseBody === "string" ? error.responseBody : "";
    if (status === 400 && CONTEXT_PATTERN.test(`${error.message ?? ""} ${body}`)) {
      return new HttpException({ code: "AGENT_MODEL_CONTEXT_EXCEEDED", message: "本次问题或历史超出模型上下文窗口，请换个更短的问法", details: [] }, HttpStatus.BAD_GATEWAY);
    }
    if (status === 401 || status === 403) {
      return new HttpException({ code: "AGENT_MODEL_AUTH", message: "模型服务鉴权失败，请联系管理员检查配置", details: [] }, HttpStatus.BAD_GATEWAY);
    }
    if (status === 429 || status >= 500) {
      return new HttpException({ code: "AGENT_MODEL_UNAVAILABLE", message: "模型服务暂时不可用，请稍后重试", details: [] }, HttpStatus.BAD_GATEWAY);
    }
    return new HttpException({ code: "AGENT_MODEL_ERROR", message: "模型调用失败，请稍后重试", details: [] }, HttpStatus.BAD_GATEWAY);
  }
  if (AISDKError.isInstance(error)) {
    return new HttpException({ code: "AGENT_MODEL_ERROR", message: "模型调用失败，请稍后重试", details: [] }, HttpStatus.BAD_GATEWAY);
  }
  return error;
}
