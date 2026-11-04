import type { ModelMessage } from "ai";

type AgentLlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; id: string; tool: string; args: Record<string, unknown>; content: string };

// 修复后（去掉 JSON.stringify）
function fixed(messages: AgentLlmMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      result.push({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: message.id, toolName: message.tool, input: message.args ?? {} }],
      } as ModelMessage);
      let parsed: unknown = message.content;
      try { parsed = JSON.parse(message.content); } catch {}
      result.push({ role: "tool", content: [{ type: "tool-result", toolCallId: message.id, toolName: message.tool, output: { type: "json", value: parsed } }] } as ModelMessage);
      continue;
    }
    result.push({ role: message.role, content: message.content });
  }
  return result;
}
export { fixed };
