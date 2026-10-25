import type { AgentAccessLevel } from "./access-level";
import type { AgentLlmMessage } from "./llm-provider";
import { AgentStateManager } from "./state-manager";

/**
 * 上下文管理器（R-6）：只取本人该会话**最近 8 个已完成**轮次，映射为 user/assistant 问答对。
 *
 * 三条边界（工程布局「会话、成本」）：
 *   - 当前档位读不到的旧 full 轮次**不进入**上下文（降权后旧财务轮次不得再喂给模型）；
 *   - 旧工具原始结果不进入 —— 只带最终答案文本；
 *   - 应用层**不按输入 token 裁剪**：8 轮上限是轮数，不是配额；DeepSeek 窗口超限由
 *     provider 报 `AGENT_MODEL_CONTEXT_EXCEEDED`，不静默删改。
 */

export const AGENT_HISTORY_TURNS = 8;

export class AgentContextManager {
  constructor(private readonly state: AgentStateManager) {}

  async history(userId: string, sessionId: string, accessLevel: AgentAccessLevel): Promise<AgentLlmMessage[]> {
    // listRuns 按 createdAt 升序返回本人该会话的 run；轮次去尾取 8。
    const runs = await this.state.listRuns(sessionId, userId);
    const completed = runs
      .filter((run) => run.state === "completed" && (accessLevel === "full" || run.accessLevel !== "full"))
      .slice(-AGENT_HISTORY_TURNS);
    return completed.flatMap((run) => [
      { role: "user", content: run.question } as AgentLlmMessage,
      { role: "assistant", content: run.answer ?? "" } as AgentLlmMessage,
    ]);
  }
}
