// 模型错误映射的单元测试（不连真实 DeepSeek）。
//
// 契约（R-11）：模型错误只以稳定码离开 provider 文件，message 用固定文案 ——
// DeepSeek 的 4xx 报文可能夹带请求片段（业务值可能藏在其中），绝不外传原文。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { APICallError } = require("ai");
const { mapModelError } = require("../../dist/modules/business-query-agent/model-errors.js");

const apiError = (statusCode, message, responseBody) => new APICallError({ message, url: "https://api.deepseek.com/chat/completions", requestBodyValues: { model: "deepseek-chat", messages: "省略" }, statusCode, responseBody, isRetryable: false });

const codeOf = (error) => error.getResponse().code;

test("400 + context_length_exceeded → AGENT_MODEL_CONTEXT_EXCEEDED，响应原文不进 message", () => {
  const mapped = mapModelError(apiError(400, "Invalid request", JSON.stringify({ error: { code: "context_length_exceeded", secret_order: "SO-SECRET-001" } })));
  assert.equal(codeOf(mapped), "AGENT_MODEL_CONTEXT_EXCEEDED");
  assert.ok(!mapped.getResponse().message.includes("SO-SECRET-001"), "业务值不得随错误文案外泄");
});

test("401 / 403 → AGENT_MODEL_AUTH；429 / 5xx → AGENT_MODEL_UNAVAILABLE", () => {
  assert.equal(codeOf(mapModelError(apiError(401, "auth failed"))), "AGENT_MODEL_AUTH");
  assert.equal(codeOf(mapModelError(apiError(403, "forbidden"))), "AGENT_MODEL_AUTH");
  assert.equal(codeOf(mapModelError(apiError(429, "rate limited"))), "AGENT_MODEL_UNAVAILABLE");
  assert.equal(codeOf(mapModelError(apiError(503, "upstream down"))), "AGENT_MODEL_UNAVAILABLE");
});

test("400 无上下文字样 → AGENT_MODEL_ERROR（不冒充超窗）", () => {
  assert.equal(codeOf(mapModelError(apiError(400, "bad parameter"))), "AGENT_MODEL_ERROR");
});

test("中止 / 超时 → AGENT_MODEL_TIMEOUT", () => {
  assert.equal(codeOf(mapModelError(Object.assign(new Error("aborted"), { name: "TimeoutError" }))), "AGENT_MODEL_TIMEOUT");
  assert.equal(codeOf(mapModelError(Object.assign(new Error("aborted"), { name: "AbortError" }))), "AGENT_MODEL_TIMEOUT");
});

test("业务 HttpException 原样放行（编排器已按 code 收口），未知错误透传", () => {
  const { HttpException } = require("@nestjs/common");
  const business = new HttpException({ code: "X", message: "y", details: [] }, 400);
  assert.equal(mapModelError(business), business);
  const unknown = new Error("plain");
  assert.equal(mapModelError(unknown), unknown);
});
