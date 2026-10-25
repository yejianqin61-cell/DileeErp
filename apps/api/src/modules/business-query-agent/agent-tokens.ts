/**
 * Agent 模块的注入 token。单独成文件：guard/controller 都要引 token，
 * 放在 module 文件里会形成 module → controller → guard → module 的循环引用。
 */
export const AGENT_STATE_CLIENT = "AGENT_STATE_CLIENT";
export const AGENT_READ_CLIENT = "AGENT_READ_CLIENT";
export const AGENT_ROLE_READER = "AGENT_ROLE_READER";
export const AGENT_LLM_PROVIDER = "AGENT_LLM_PROVIDER";
