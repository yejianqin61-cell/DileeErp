import type { Response } from "express";
import { lowerAccessLevel, resolveAccessLevel, type AgentAccessLevel } from "./access-level";
import type { AgentRoleReader } from "./query-permission.guard";
import { AgentStateManager, type AgentRunRow } from "./state-manager";

/**
 * SSE 传输：先重放数据库事件，再短间隔轮询新事件（V0 不引入 Redis/消息总线）。
 *
 * 契约（模块设计「SSE 与前后端状态机怎样恢复」）：
 *   - 每条 `data` 是版本化 JSON `{v,run_id,seq,type,at,data}`；`id: <runId>:<seq>` 供断线续接；
 *   - 心跳是 SSE 注释，不写事件表；
 *   - 归属与档位已由控制器在进入本方法前校验；发送/重放每个批次前重查档位，
 *     降权者连旧 full run 的重放都收不到，只收到 ACCESS_REVOKED 后关闭。
 */

const POLL_INTERVAL_MS = 200;
const HEARTBEAT_MS = 15_000;
const TERMINAL_EVENT_TYPES = new Set(["completed", "error", "cancelled"]);

export class StreamTransport {
  constructor(private readonly state: AgentStateManager, private readonly roleReader: AgentRoleReader) {}

  async follow(response: Response, run: AgentRunRow, afterSeq: number): Promise<void> {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();

    const controller = new AbortController();
    response.on("close", () => controller.abort());
    const write = (chunk: string) => { if (!response.writableEnded) response.write(chunk); };

    let lastSeq = afterSeq;
    let lastSentAt = Date.now();

    // 先重放：Last-Event-ID 之后的事件按序补发；重放里就含终态事件则发完即关。
    const replayed = await this.state.eventsAfter(run.id, afterSeq);
    if (!(await this.assertCanReceive(run, write))) return close(response);
    for (const event of replayed) {
      writeEvent(write, run.id, event.seq, event.type, event.createdAt.toISOString(), event.payload);
      lastSeq = event.seq;
      lastSentAt = Date.now();
      if (TERMINAL_EVENT_TYPES.has(event.type)) return close(response);
    }

    while (!controller.signal.aborted && !response.writableEnded) {
      await sleep(POLL_INTERVAL_MS, controller.signal);
      if (controller.signal.aborted || response.writableEnded) break;
      const events = await this.state.eventsAfter(run.id, lastSeq).catch(() => []);
      if (events.length === 0) {
        if (Date.now() - lastSentAt >= HEARTBEAT_MS) { write(": ping\n\n"); lastSentAt = Date.now(); }
        continue;
      }
      if (!(await this.assertCanReceive(run, write))) return close(response);
      for (const event of events) {
        writeEvent(write, run.id, event.seq, event.type, event.createdAt.toISOString(), event.payload);
        lastSeq = event.seq;
        lastSentAt = Date.now();
        if (TERMINAL_EVENT_TYPES.has(event.type)) return close(response);
      }
    }
    close(response);
  }

  /** 发送前重查档位：denied 或低于 run 创建档位 → 只发不含业务内容的 ACCESS_REVOKED 后关闭。 */
  private async assertCanReceive(run: AgentRunRow, write: (chunk: string) => void): Promise<boolean> {
    const roleKeys = await this.roleReader.readActiveRoleKeys(run.userId).catch(() => [] as string[]);
    const current = resolveAccessLevel(roleKeys);
    const level = run.accessLevel as AgentAccessLevel;
    const revoked = current === "denied" || lowerAccessLevel(current as AgentAccessLevel, level) !== level;
    if (revoked) {
      write(`data: ${JSON.stringify({ v: 1, run_id: run.id, seq: 0, type: "error", at: new Date().toISOString(), data: { code: "ACCESS_REVOKED", message: "当前档位已无法读取该回答" } })}\n\n`);
      return false;
    }
    return true;
  }
}

function writeEvent(write: (chunk: string) => void, runId: string, seq: number, type: string, at: string, payload: unknown): void {
  write(`id: ${runId}:${seq}\n`);
  write(`data: ${JSON.stringify({ v: 1, run_id: runId, seq, type, at, data: payload })}\n\n`);
}

function close(response: Response): void {
  if (!response.writableEnded) response.end();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish() { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(); }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
