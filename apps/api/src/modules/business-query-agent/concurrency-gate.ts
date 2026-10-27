/**
 * 进程内并发许可闸（R-8）：全进程同时最多 4 个活动 run，无空位即 Busy，不排队。
 *
 * 分工（模块设计「并发控制」）：**每用户一个活动 run** 由数据库部分唯一索引兜底，
 * 这个闸门只管全进程总负载。当前部署是单 API 进程——若未来增加副本，必须先替换成
 * 共享许可与任务领取机制，不能把每个进程的「4」误当成全局「4」。
 */

export const AGENT_MAX_ACTIVE_RUNS = 4;// 进程内同时活动 run 数上限，超过即 Busy。

export type AgentRunPermit = { release(): void };//导出进程内并发许可闸的许可对象，包含一个 release 方法，用于释放许可。
//进程中，每个 run 都需要一个许可，才能执行。每次结束 run 后，必须调用 release 方法释放许可，以便其他 run 可以获取许可继续执行。
//通过闭包的方式，确保 release 方法只能被调用一次，防止重复释放许可导致 active 计数错误。

export class ConcurrencyGate {
  //创建一个 ConcurrencyGate 类，用于管理进程内的并发许可。该类包含一个私有属性 active，用于记录当前活动 run 的数量。
  private active = 0;

  /** 取得许可；无空位返回 null（调用方转 429 AGENT_BUSY），不缓存问题、不建等待队列。 */
  //定义一个方法 tryAcquire，用于尝试获取一个许可。如果当前活动 run 的数量已经达到最大值 AGENT_MAX_ACTIVE_RUNS，则返回 null，表示没有空位。如果有空位，则增加 active 计数，并返回一个 AgentRunPermit 对象，调用方必须在 finally 块中调用 release 方法释放许可。
  tryAcquire(_userId: string): AgentRunPermit | null {// 目前不按用户区分，未来可按 userId 分配不同的并发额度。要么直接返回 null，要么返回一个对象，调用方必须在 finally 里 release。
    
    
    if (this.active >= AGENT_MAX_ACTIVE_RUNS) return null;// 许可已满，拒绝。

    // 许可已发放，调用方必须在 finally 里 release。
    //给予AgentRunPermit 对象
    //
    this.active += 1;//active++. 许可已发放，调用方必须在 finally 里 release。
    let released = false;//为啥啊？
    //run结束后，return 的对象的 release 方法会被调用，释放许可。
    //为了防止重复释放许可，使用一个 released 变量来标记是否已经释放过许可。如果已经释放过，则忽略后续的 release 调用。
    return {
      release: () => {//这一行的语法要点是：箭头函数，this 绑定在 ConcurrencyGate 实例上。，release 方法被调用时，this.active 减 1，表示释放一个许可。
        // release 可能被「编排器 finally」与「创建失败的 catch」双双调用：只减一次。
        if (released) return;// 为啥还需要这个判断？因为 release 方法可能被多次调用，如果已经释放过许可，则不再执行 active -= 1，避免 active 计数错误。
        released = true;//
        this.active -= 1;//
      },
    };
  }

  /** 观测口径之一（R-11：同时活动 run 数）。 */
  get activeCount(): number {
    return this.active;// 返回当前活动 run 的数量，用于观测和调试。
    //为啥能访问到？因为 active 是 ConcurrencyGate 类的私有属性，activeCount 是该类的公共方法，可以访问私有属性 active。
  }
}
