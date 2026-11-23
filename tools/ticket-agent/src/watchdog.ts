/**
 * 看门狗：纯判定「这个 run 是卡住了，还是只是慢」。
 *
 * 权威规格：docs/design/ticket-branch-isolation-and-watchdog-2026-11-23.md §3。
 * 用户 2026-11-23 的原话：「有的任务 45 分钟无法完工并不是死锁而是复杂度过高，这个时候
 * 不应该强制截断。应当由一个心跳 agent standby，定期查看进程进度，如果疑似死锁，
 * 向用户报告，申请截断。」所以这一层只回答一个问题：**该不该叫人来看**。
 *
 * 三条「不做什么」，都是为了能被固定数组回归：
 *   1. 不采样：进程/CPU 的观测在调用方（`/proc` 扫描 + `harness-runner` 的 onEvent 计数），
 *      这里只吃采样点、吐判定。
 *   2. 不读时钟：`nowMs` / `runStartedAtMs` 一律由调用方传入。`Date.now()` 一进来，
 *      「正好 6 小时」「正好 5 小时 30 分」这些边界就只能靠 sleep 去撞。
 *   3. 不杀进程：`suspect` 只是「请人看一眼」，真正会截断的只有 `ceiling`（§3.4 资源底线），
 *      因为看门狗看得到「没动静」，看不到「它是不是正在算一个很难的东西」（§3.5）。
 *
 * 判据（§3.2）：疑似死锁 = 下面三条**同时**成立，且连续 `suspectStreak` 个采样点都成立：
 *   - 距最后一个有意义的 Agent 事件 ≥ `idleThresholdMs`（默认 10 分钟）；
 *   - 进程存活但本采样窗口 CPU < `cpuFloorPercent`（默认 1%）；
 *   - 进程树里没有 CPU > `childCpuFloorPercent`（默认 5%）的子孙。
 * 缺任何一条都是「慢但活着」：在编译（CPU 高）、在跑 tsc/vitest（子进程 CPU 高）、
 * 刚开始读一个大文件（事件刚动过）都不该报。用固定时限切掉复杂度高的任务，
 * 等于系统性地只允许做简单需求 —— 2026-11-21 的 T-0024/25/26 就是这么被误杀的（§3.1）。
 *
 * 采样点约定：调用方按时间升序追加，每 `sampleIntervalMs`（默认 60 秒）一个。
 * `judge` 只看末尾 `suspectStreak` 个，不检查间隔是否均匀 —— 别在这里补业务假设。
 * 字段 `at` 与 `toolCalls` 只供调用方记录/播报，判定不读它们。
 */

export type WatchVerdict = 'alive' | 'suspect' | 'ceiling'

/** 一个采样点。全部字段由调用方测出来，这里只读不测。 */
export interface ProgressSample {
  /** 采样时刻（ms epoch）。仅用于记录/排序。 */
  at: number
  /** 距上一次有意义的 Agent 事件过去了多久。 */
  lastEventAgeMs: number
  /** 该进程树本采样窗口内的 CPU 占用百分比。 */
  cpuPercent: number
  /** 子进程里最高的 CPU 百分比（无子进程给 0）。 */
  maxChildCpuPercent: number
  /** 累计工具调用数。仅用于播报。 */
  toolCalls: number
}

export interface WatchdogOptions {
  /** 采样间隔。判定不用它，调用方用它排定时器。默认 60 秒。 */
  sampleIntervalMs?: number
  /** 「多久没事件算没进展」。默认 10 分钟。 */
  idleThresholdMs?: number
  /** 进程 CPU 低于这个数才算「没在干活」。默认 1%。 */
  cpuFloorPercent?: number
  /** 子进程 CPU 低于这个数才算「子孙也没在干活」。默认 5%。 */
  childCpuFloorPercent?: number
  /** 连续几个采样点都成立才报疑似死锁。默认 2。 */
  suspectStreak?: number
  /** 绝对上限：到点强制收口，唯一会截断的条件。默认 6 小时。 */
  hardCeilingMs?: number
  /** 提前多久预告「快到绝对上限了」。默认 30 分钟。 */
  ceilingWarnMs?: number
}

/** 缺省值补齐后的选项。判定内部只看这个形状，避免每处都写一遍 `?? 默认值`。 */
export interface ResolvedWatchdogOptions {
  readonly sampleIntervalMs: number
  readonly idleThresholdMs: number
  readonly cpuFloorPercent: number
  readonly childCpuFloorPercent: number
  readonly suspectStreak: number
  readonly hardCeilingMs: number
  readonly ceilingWarnMs: number
}

/**
 * 默认值就是设计文档 §3.2 与 §3.4 里那七个数。
 * 导出的理由：`sampleIntervalMs` 是调用方排定时器用的，不该在两处各写一遍 60_000。
 */
export const DEFAULT_WATCHDOG_OPTIONS: ResolvedWatchdogOptions = {
  sampleIntervalMs: 60_000,
  idleThresholdMs: 10 * 60_000,
  /**
   * 3% 而不是 1%：2026-11-23 真机探针实测，一个**完全空转**的 node 进程在 2 vCPU
   * 服务器上就能吃到约 1.6%（`scripts/probe-sampler.ts`）。用 1% 当门槛的话，
   * 「父子都闲」的死锁现场会被判成「还在干活」，看门狗永远不报 —— 漏报等于没上线。
   * 3% 留了余量，同时远低于真干活的量级（编译/测试动辄 80%+）。
   */
  cpuFloorPercent: 3,
  childCpuFloorPercent: 5,
  suspectStreak: 2,
  hardCeilingMs: 6 * 3600_000,
  ceilingWarnMs: 30 * 60_000,
}

/** 取一个有限数，否则退回默认值。挡住 NaN/Infinity，别让它们静默把判据变成恒 false。 */
function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

/**
 * 补齐选项。
 * `suspectStreak` 额外夹到 >= 1：0 会让 `slice(-0)` 取到整个数组，
 * 判定变成「历史上任意两个点达标就报」，与「最近连续 N 个」相反。
 */
export function resolveWatchdogOptions(opts?: WatchdogOptions): ResolvedWatchdogOptions {
  return {
    sampleIntervalMs: finiteOr(opts?.sampleIntervalMs, DEFAULT_WATCHDOG_OPTIONS.sampleIntervalMs),
    idleThresholdMs: finiteOr(opts?.idleThresholdMs, DEFAULT_WATCHDOG_OPTIONS.idleThresholdMs),
    cpuFloorPercent: finiteOr(opts?.cpuFloorPercent, DEFAULT_WATCHDOG_OPTIONS.cpuFloorPercent),
    childCpuFloorPercent: finiteOr(opts?.childCpuFloorPercent, DEFAULT_WATCHDOG_OPTIONS.childCpuFloorPercent),
    suspectStreak: Math.max(1, Math.trunc(finiteOr(opts?.suspectStreak, DEFAULT_WATCHDOG_OPTIONS.suspectStreak))),
    hardCeilingMs: finiteOr(opts?.hardCeilingMs, DEFAULT_WATCHDOG_OPTIONS.hardCeilingMs),
    ceilingWarnMs: finiteOr(opts?.ceilingWarnMs, DEFAULT_WATCHDOG_OPTIONS.ceilingWarnMs),
  }
}

/** 单个采样点是否「三条同时成立」。缺一条都可能只是慢，所以三个 `&&` 缺一不可。 */
function looksStuck(sample: ProgressSample, options: ResolvedWatchdogOptions): boolean {
  return (
    sample.lastEventAgeMs >= options.idleThresholdMs &&
    sample.cpuPercent < options.cpuFloorPercent &&
    sample.maxChildCpuPercent < options.childCpuFloorPercent
  )
}

/**
 * 判一次。
 *
 * 优先级：`ceiling` > `suspect` > `alive`。两者同时成立时报 `ceiling`，理由见函数内注释。
 * 采样点不足 `suspectStreak` 个（含空数组）一律 `alive`：没攒够证据不叫人。
 */
export function judge(
  samples: readonly ProgressSample[],
  nowMs: number,
  runStartedAtMs: number,
  opts?: WatchdogOptions,
): WatchVerdict {
  const options = resolveWatchdogOptions(opts)

  // ceiling 先判，且一旦成立不再往下看：
  // 6 小时已到就没有「再跑一会儿」的余地了，报 suspect 只会让群里多一轮「继续还是截断」的问答，
  // 而答案不由用户决定 —— §3.4 说得很清楚，这是资源底线，不是超时判定。
  if (nowMs - runStartedAtMs >= options.hardCeilingMs) return 'ceiling'

  if (samples.length < options.suspectStreak) return 'alive'

  // 只看末尾 streak 个：早期卡过、后来动了，就是活着。
  const recent = samples.slice(samples.length - options.suspectStreak)
  return recent.every((sample) => looksStuck(sample, options)) ? 'suspect' : 'alive'
}

/**
 * 是否该发「快到绝对上限了」的预告（§8 风险表：到点前 30 分钟在群里预告，
 * 给用户提前叫停的机会）。
 *
 * 区间是左闭右开 `[hardCeilingMs - ceilingWarnMs, hardCeilingMs)`：
 * 进入就报，到顶后不再预告（那一刻 `judge` 已经改判 `ceiling`，不必两条消息说同一件事）。
 */
export function needCeilingWarning(nowMs: number, runStartedAtMs: number, opts?: WatchdogOptions): boolean {
  const options = resolveWatchdogOptions(opts)
  const elapsed = nowMs - runStartedAtMs
  return elapsed >= options.hardCeilingMs - options.ceilingWarnMs && elapsed < options.hardCeilingMs
}

/** 时长人话：45 分钟 / 6 小时 / 6 小时 3 分钟。看门狗的尺度是分钟级，不必精确到秒。 */
function formatSpan(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}

/** 百分比人话：85% / 0.5% / 12.3%（一位小数，整数不拖 `.0`）。 */
function formatPercent(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, '')}%`
}

/** 子进程那一段：「无子进程活动」比「子进程 0%」更像人话。 */
function childText(sample: ProgressSample): string {
  return sample.maxChildCpuPercent > 0 ? `子进程峰值 ${formatPercent(sample.maxChildCpuPercent)}` : '无子进程活动'
}

/**
 * 一句中文说明，给群里播报用（不含 markdown 表格，卡片只贴一行）。
 *
 * 各判定说各判定该说的话：`alive` 说「还在推进、多久前动过」，`suspect` 说「哪三条同时没动、
 * 等你决定」，`ceiling` 说「到绝对上限了、按资源底线收口」。数字保留一位小数，
 * 因为死锁现场的关键信息恰恰是「0.3% 而不是 0%」这种量级。
 */
export function describeVerdict(
  verdict: WatchVerdict,
  samples: readonly ProgressSample[],
  nowMs: number,
  runStartedAtMs: number,
  opts?: WatchdogOptions,
): string {
  const options = resolveWatchdogOptions(opts)
  const elapsed = Math.max(0, nowMs - runStartedAtMs)
  const latest = samples.length === 0 ? null : samples[samples.length - 1]

  if (verdict === 'ceiling') {
    const tail = latest === null ? '' : `；最后采样距上次事件 ${formatSpan(latest.lastEventAgeMs)}`
    return `已到绝对上限 ${formatSpan(options.hardCeilingMs)}（已跑 ${formatSpan(elapsed)}），按资源底线强制收口${tail}。`
  }

  if (verdict === 'suspect') {
    if (latest === null) return '疑似死锁：暂无采样数据，请你决定继续还是截断。'
    const frozen = `已 ${formatSpan(latest.lastEventAgeMs)}无事件进展、CPU ${formatPercent(latest.cpuPercent)}%、${childText(latest)}`
    return `疑似死锁：${frozen}，连续 ${options.suspectStreak} 个采样点如此，请你决定继续还是截断。`
  }

  const progress =
    latest === null
      ? '还没有采样数据'
      : `距上次事件 ${formatSpan(latest.lastEventAgeMs)}、CPU ${formatPercent(latest.cpuPercent)}%、${childText(latest)}`
  return `仍在推进：${progress}，已跑 ${formatSpan(elapsed)}（上限 ${formatSpan(options.hardCeilingMs)}）。`
}
