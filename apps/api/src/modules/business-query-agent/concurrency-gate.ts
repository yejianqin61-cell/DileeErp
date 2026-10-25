/**
 * 进程内并发许可闸（R-8）：全进程同时最多 4 个活动 run，无空位即 Busy，不排队。
 *
 * 分工（模块设计「并发控制」）：**每用户一个活动 run** 由数据库部分唯一索引兜底，
 * 这个闸门只管全进程总负载。当前部署是单 API 进程——若未来增加副本，必须先替换成
 * 共享许可与任务领取机制，不能把每个进程的「4」误当成全局「4」。
 */

export const AGENT_MAX_ACTIVE_RUNS = 4;

export type AgentRunPermit = { release(): void };

export class ConcurrencyGate {
  private active = 0;

  /** 取得许可；无空位返回 null（调用方转 429 AGENT_BUSY），不缓存问题、不建等待队列。 */
  tryAcquire(_userId: string): AgentRunPermit | null {
    if (this.active >= AGENT_MAX_ACTIVE_RUNS) return null;
    this.active += 1;
    let released = false;
    return {
      release: () => {
        // release 可能被「编排器 finally」与「创建失败的 catch」双双调用：只减一次。
        if (released) return;
        released = true;
        this.active -= 1;
      },
    };
  }

  /** 观测口径之一（R-11：同时活动 run 数）。 */
  get activeCount(): number {
    return this.active;
  }
}
