/**
 * 进程树 CPU 采样：把 `/proc` 里的**累计 tick 差**换算成「这个 run 现在有多忙」的百分比。
 *
 * 为什么单独一层：`watchdog.ts` 只做判定，它吃的是 `ProgressSample`（纯数据），
 * 不读时钟、不碰 `/proc` —— 因为「12 分钟没事件但 CPU 85%」这种边界只能靠固定数组回归。
 * 于是「把 /proc 观测变成 cpuPercent / maxChildCpuPercent」这件事落在这一层：
 * 这里只碰文件与时钟，不做任何「该不该截断」的判断。
 *
 * 观测谁：靠子进程环境里的 `DILEE_RUN_ID` 标记找（`run-janitor.ts` 的 `readProcTable` /
 * `findTagged`）。环境在 fork 时被所有子孙复制，所以被 setsid 掉的孙进程也能覆盖，
 * 不依赖进程组、也不依赖父子关系 —— 这正是线上 `bash` 工具另开会话后仍能看见它们的原因。
 *
 * 平台边界（很重要，上层接入必须读这一段）：
 * `/proc` 只有 Linux 有。macOS/Windows 上所有读操作返回 `null` / `0`，`sample()` 返回全 0，
 * **绝不抛异常**（看门狗自己崩掉比漏报更难查）。
 * 因此上层**不能**把 `totalPercent === 0` 直接当成「进程没在干活」：
 * 「读不到 CPU」和「真的 0% 占用」在这个接口上长得一模一样。
 * 区分办法是 `processCount === 0` —— 一个活着的 run 至少有主进程，所以
 * `processCount === 0` 说明这一轮根本没读到进程，而不是「读到了、它很闲」。
 * 按设计文档 §3.2 的判据，「CPU 低」只是三条之一；拿不到这条证据时就**不做死锁判定**
 * （宁可晚一轮叫人，也不要因为采集不到就把一个正在编译的 run 报成卡死）。
 *
 * 数值口径：
 * - tick 是 Linux 的累计 CPU 时间单位，`USER_HZ`（默认 100）个 tick = 1 CPU·秒。
 * - 单个进程用满一个核是 100%，多线程进程在 `utime/stime` 里含全部线程，所以**能超过 100%**。
 * - 进程树的总百分比同样是几十个进程相加，超过 100% 是正常的，别当异常去截。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { findTagged, readProcTable } from './run-janitor.ts'

/** 默认 procfs 挂载点。测试指向假目录。 */
const DEFAULT_PROC_ROOT = '/proc'

/**
 * Linux `USER_HZ`。x86/arm 上都是 100，即 1 tick = 10ms。
 * 真在别的 HZ 上跑就传 `clockSeconds`，别改这个常量。
 */
const DEFAULT_CLOCK_SECONDS = 100

/**
 * 百分比上限。**不是** 100：进程树可能有几十个进程，各自都能吃满一个核。
 * 但也不能放任意值 —— 计数器回绕、时钟跳变、基线丢失都可能算出天文数字，
 * 让 `Infinity` 流进判定层是最糟的结果（`Infinity < cpuFloorPercent` 恒 false，
 * 会静默把「卡死」判成「活着」）。所以夹到 `[0, 100 * 100]`。
 */
const MAX_PERCENT = 100 * 100

/** 一次采样：把 /proc 里的 CPU 计数差换算成百分比。 */
export interface CpuSnapshot {
  readonly atMs: number
  /** 该 run 的进程树（含主进程与所有子孙）本窗口的总 CPU 百分比。 */
  readonly totalPercent: number
  /** 单个进程里的最高百分比（排除 run 的主进程本身；没有别的进程给 0）。 */
  readonly busiestChildPercent: number
  /** 本窗口观测到的进程数（主进程 + 子孙）。 */
  readonly processCount: number
}

/** 合法的 tick 频率：非数字、0、负数都退回默认值，否则公式会算出 Infinity 或负百分比。 */
function resolveClockSeconds(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : DEFAULT_CLOCK_SECONDS
}

/**
 * 纯函数：两份 tick 快照 → 百分比。抽出来单独测，不依赖真 /proc。
 *
 * 公式：`deltaTicks / (deltaMs/1000 * clockSeconds) * 100`。
 * 直觉：`deltaMs/1000 * clockSeconds` 是「这段墙钟里一个 CPU 核能产出多少 tick」，
 * 拿实际 delta 去除，再乘 100 就是「用了几个核」的百分比。
 *
 * 三个边界都会把结果压成 0，而不是让异常值往上流：
 * - `deltaMs <= 0`：两帧同一时刻或时钟倒退（NTP 校正、注入的假时钟），除零会得 Infinity。
 * - `deltaTicks <= 0`：计数器回绕，或者这批 pid 换了人（旧进程退出、pid 被复用）。
 *   「本窗口没有可解释的增长」比「随便给个数」更接近事实。
 * - 结果非有限数：`NaN` 同理，宁可报 0。
 */
export function percentBetween(
  previous: { atMs: number; ticks: number },
  current: { atMs: number; ticks: number },
  clockSeconds?: number,
): number {
  const deltaMs = current.atMs - previous.atMs
  if (!(deltaMs > 0)) return 0

  const deltaTicks = current.ticks - previous.ticks
  if (!(deltaTicks > 0)) return 0

  const elapsedTicks = (deltaMs / 1000) * resolveClockSeconds(clockSeconds)
  if (!(elapsedTicks > 0)) return 0

  const percent = (deltaTicks / elapsedTicks) * 100
  if (!Number.isFinite(percent)) return 0
  return Math.min(Math.max(percent, 0), MAX_PERCENT)
}

/**
 * 解析 `/proc/<pid>/stat`，返回 utime+stime+cutime+cstime；读不懂给 null。
 *
 * **不能按空格切整行**：第 2 字段 `comm` 形如 `(node /opt/erp worker)`，
 * 进程名本身就允许空格，甚至允许 `)`（comm 是从命令行前 15 个字节抄来的，什么字符都可能有）。
 * 所以从**最后一个** `)` 之后才开始切：从那往后的每个字段都是空格分隔的纯数字或单字母，
 * 再不会有「字段内部含空格」的歧义。
 * 切完后下标 0 是第 3 字段 `state`，于是 14/15/16/17 字段（utime/stime/cutime/cstime）
 * 分别落在下标 11/12/13/14。
 *
 * 四个字段缺一不可：半份数据会被算成一个偏小的 tick，进而在判定层伪装成「CPU 很低」。
 */
function parseStatTicks(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null

  const fields = stat.slice(close + 1).trim().split(/\s+/)
  const at = (index: number): number | null => {
    const raw = fields[index]
    if (raw === undefined || raw === '') return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }

  const utime = at(11)
  const stime = at(12)
  const cutime = at(13)
  const cstime = at(14)
  if (utime === null || stime === null || cutime === null || cstime === null) return null
  return utime + stime + cutime + cstime
}

/** 累计 CPU tick（utime+stime+cutime+cstime），读不到给 null。 */
export function readCpuTicks(pid: number, procRoot = DEFAULT_PROC_ROOT): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null

  let stat: string
  try {
    stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
  } catch {
    // 三种情况都走这里，且都不该是错误：进程已退出、无权读取（别的用户的进程）、
    // 或者这台机器压根没有 /proc（macOS/Windows）。
    return null
  }
  return parseStatTicks(stat)
}

/**
 * 对一组 pid 求和，用于「进程总数」与「还是那批人在干活吗」。
 *
 * 读不到的 pid **跳过、不补 0、不报错**：`readProcTable` 列出进程之后到读 stat 之间
 * 它完全可能已经退出（一次 run 里 npm/tsc/vitest 频繁启停）。少加一个已退出的进程，
 * 得到的是「实际还在跑的那批人」的 tick，比整批作废更有用。
 */
export function sumCpuTicks(pids: readonly number[], procRoot = DEFAULT_PROC_ROOT): number {
  let total = 0
  for (const pid of pids) {
    const ticks = readCpuTicks(pid, procRoot)
    if (ticks !== null) total += ticks
  }
  return total
}

export interface SamplerState {
  readonly atMs: number
  readonly ticks: number
  readonly pids: readonly number[]
}

export interface RunSamplerOptions {
  readonly runId: string
  readonly mainPid: number
  readonly procRoot?: string // 默认 '/proc'，测试注假目录
  readonly clockSeconds?: number // 每秒 tick 数，默认 100（Linux USER_HZ）
  readonly now?: () => number // 注入时间，默认 Date.now
}

/**
 * 内部基线：`SamplerState` 再加上「每个 pid 各自的 tick」。
 *
 * 对外只需要聚合值，但 `busiestChildPercent` 必须按**单个进程**的 delta 算 ——
 * 树里一个 60% 的 tsc 和十个各 6% 的进程，聚合值一样，判定含义完全不同
 * （前者说明在编译，不该截断；所以这里的最高值要保留「单个进程」的粒度）。
 */
interface Baseline extends SamplerState {
  readonly ticksByPid: ReadonlyMap<number, number>
}

/**
 * 按固定间隔采样的采样器。
 *
 * 用法：`sample()` 每次调用算一个窗口的百分比，**第一次调用只建立基线、返回 0**
 * （没有上一次的 tick 就没有 delta；硬拿绝对 tick 当增量会算出一个巨大的假值）。
 * 上层拿到 `CpuSnapshot` 后自己填 `ProgressSample.lastEventAgeMs` / `toolCalls`，
 * 再喂给 `judge()` —— 采样与判定之间只传数据，方便两边各自用固定输入回归。
 */
export class RunSampler {
  private readonly runId: string
  private readonly mainPid: number
  private readonly procRoot: string
  private readonly clockSeconds: number
  private readonly now: () => number
  private baseline: Baseline | null = null

  constructor(options: RunSamplerOptions) {
    this.runId = options.runId
    this.mainPid = options.mainPid
    this.procRoot = options.procRoot ?? DEFAULT_PROC_ROOT
    this.clockSeconds = resolveClockSeconds(options.clockSeconds)
    this.now = options.now ?? Date.now
  }

  /** 采一次。第一次调用没有基线，返回的 totalPercent / busiestChildPercent 都是 0。 */
  sample(): CpuSnapshot {
    const atMs = this.now()
    try {
      return this.sampleAt(atMs)
    } catch {
      // 兜底：本函数里所有读操作都已各自 try/catch，理论上到不了这里。
      // 但 `sample()` 会被定时器反复调用，一次未预料的异常就能把整个机器人打挂，
      // 而它看的只是一个「要不要叫人」的信号 —— 丢掉这一轮、下轮重建基线，代价最小。
      this.baseline = null
      return { atMs, totalPercent: 0, busiestChildPercent: 0, processCount: 0 }
    }
  }

  /** 重置基线（用户回「继续」之后重新计时，不把之前的空转算进来）。 */
  reset(): void {
    this.baseline = null
  }

  private sampleAt(atMs: number): CpuSnapshot {
    const pids = this.discoverPids()
    const ticksByPid = this.readTicks(pids)

    let totalTicks = 0
    for (const ticks of ticksByPid.values()) totalTicks += ticks
    const processCount = ticksByPid.size

    const previous = this.baseline
    // 基线无条件前移，包括「这一轮什么都没读到」的情况（比如 Windows 上没有 /proc）：
    // 若把空窗口的基线留着不动，等下次能读到时整段盲区会并进一个新的 delta，更难解释。
    // 代价是：跨过盲区的那个窗口报的是**整段时间的平均值**，偏低偏高都可能，
    // 但方向是「算作在忙」，不会凭空打出「CPU 为 0」这种假死锁证据。
    this.baseline = { atMs, ticks: totalTicks, pids, ticksByPid }

    if (previous === null) {
      return { atMs, totalPercent: 0, busiestChildPercent: 0, processCount }
    }

    const totalPercent = percentBetween(
      { atMs: previous.atMs, ticks: previous.ticks },
      { atMs, ticks: totalTicks },
      this.clockSeconds,
    )

    let busiestChildPercent = 0
    for (const [pid, ticks] of ticksByPid) {
      // 排除主进程：它是 spawn 出来的 dsh 本身，多半在阻塞等待子进程。
      // 判定层的 maxChildCpuPercent 要回答的是「有没有子孙在真干活」，
      // 把主进程算进来，等于让「一个闲着的 dsh」永远给不出这个问题的答案。
      if (pid === this.mainPid) continue

      const previousTicks = previous.ticksByPid.get(pid)
      // 本窗口才出现的进程没有基线：先记下，下一个窗口它才有百分比。
      // 不能拿 0 当基线 —— 那样会把它的**累计** tick 全算成本窗口的增量，造出假高值。
      if (previousTicks === undefined) continue

      const percent = percentBetween(
        { atMs: previous.atMs, ticks: previousTicks },
        { atMs, ticks },
        this.clockSeconds,
      )
      if (percent > busiestChildPercent) busiestChildPercent = percent
    }

    return { atMs, totalPercent, busiestChildPercent, processCount }
  }

  /**
   * 进程树 = 主进程 + 所有带本次 run 标记的进程（按 pid 去重）。
   *
   * `mainPid` 无条件带上，哪怕 `findTagged` 没命中它：
   * 它是 spawn 出来的 dsh，正常情况下带着标记，但「刚 spawn 还没 exec」「外层 wrapper 换了环境」
   * 时会命中不了 —— 而它是这条树里最该被盯住的进程，不能因为一次没命中就从分母里消失。
   *
   * 不给 `findTagged` 传 `excludePid`：机器人自己身上没有 per-run 的标记
   * （`DILEE_RUN_ID` 是 spawn 时只注入给子进程的），所以没有要排除的自己。
   */
  private discoverPids(): number[] {
    const table = readProcTable(this.procRoot)
    const pids = [this.mainPid]
    for (const pid of findTagged(table, this.runId)) {
      if (!pids.includes(pid)) pids.push(pid)
    }
    return pids
  }

  /** 只保留读得到 stat 的进程：`readProcTable` 列出它还活着的瞬间，读 stat 时可能已经没了。 */
  private readTicks(pids: readonly number[]): Map<number, number> {
    const ticksByPid = new Map<number, number>()
    for (const pid of pids) {
      const ticks = readCpuTicks(pid, this.procRoot)
      if (ticks !== null) ticksByPid.set(pid, ticks)
    }
    return ticksByPid
  }
}
