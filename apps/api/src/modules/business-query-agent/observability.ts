import { Injectable, Logger } from "@nestjs/common";

/**
 * 业务查询 Agent 的结构化观测（R-11）。
 *
 * 脱敏靠**形状**而不是自觉：事件的类型里就没有 prompt、答案、工具参数原文、查询结果内容
 * 这些字段 —— 想记录业务值必须先改这里的类型，改动的 review 自然会撞上模块设计的红线。
 * 每轮先观察三项（模块设计）：活动 run 数（gate.activeCount 由调用方带上）、
 * 成功/失败/取消比例、单轮模型用量与耗时；不引监控平台。
 */

export type AgentObservabilityEvent =
  | { kind: "run_created"; user_id: string; access_level: string }
  | { kind: "run_replayed"; user_id: string }
  | { kind: "gate_denied"; user_id: string; active_runs: number }
  | { kind: "model_step"; user_id: string; access_level: string; model: string; step: number; duration_ms: number; tool_calls: number }
  | { kind: "tool_executed"; user_id: string; access_level: string; operation: string; status: "completed" | "failed"; result_rows: number; duration_ms: number; error_code?: string }
  | { kind: "run_completed"; user_id: string; access_level: string; model: string; duration_ms: number; usage: { input_tokens?: number; output_tokens?: number; tool_calls: number; answer_chunks: number } }
  | { kind: "run_failed"; user_id: string; access_level: string; error_code: string; duration_ms: number }
  | { kind: "run_cancelled"; user_id: string; access_level: string };

export type AgentLogSink = Pick<Logger, "log" | "warn" | "error">;

@Injectable()
export class AgentObservability {
  private readonly logger: AgentLogSink;

  constructor(logger?: AgentLogSink) {
    this.logger = logger ?? new Logger("business-query-agent");
  }

  /** 一条事件一行 JSON：run_id 关联（R-11「每个 run 可按 ID 追踪」）。 */
  record(runId: string, event: AgentObservabilityEvent): void {
    this.logger.log(JSON.stringify({ run_id: runId, ...event }));
  }
}
