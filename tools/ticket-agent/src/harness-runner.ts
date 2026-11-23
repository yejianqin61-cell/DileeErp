/**
 * DSH headless 运行器：起一个子进程跑一次 harness run，把 --json 事件流解析出来。
 *
 * 三条实测事实决定了这里的写法（见 docs/design/agent-application-layer-architecture-2026-11-14.md §2）：
 *   1. 首轮不能带 --session-id（会报 session does not exist），必须从首行 session 事件里取 id；
 *   2. 次轮必须带 --session-id 才能续接上下文；
 *   3. --json 是 NDJSON，首行是 session，末行是 final，中间是 status/text/thinking/tool_call/tool_result。
 *
 * 超时必须在**进程外**做（这里用 kill 进程组），不能依赖 Agent 自己退出：
 * 跑飞正是它退不出的情形。
 *
 * ## 2026-11-23：硬截断退场，看门狗入场
 *
 * 用户原话：「有的任务 45 分钟无法完工并不是死锁而是复杂度过高，这个时候不应该强制截断。
 * 应当由一个心跳 agent standby，定期查看进程进度，如果疑似死锁，向用户报告，申请截断。」
 *
 * 所以这里不再有「45 分钟到点就切」：
 *   - `timeoutMs` 的语义变成**绝对资源上限**（默认 6 小时），它不是进度判定，是兜底；
 *   - 真正的「卡住了吗」交给 `watchdog.ts` 的判定，发现疑似死锁只**报告**，杀不杀由用户回话决定；
 *   - 用户说截断时走 `abortSignal`，与到顶走同一套两段式收口（先 SIGTERM 让它写交接，再 SIGKILL 兜底）。
 *
 * 被切断的 run 一律**不算完成**（`truncated` / `timeout`）。早期的实现把「收到 SIGTERM 后
 * 退出码 0」当成 `completed`，于是 T-0027 那张只干了 40% 的单被标成 success 推进了 `gated`
 * —— 这是语义篡改，也是这一版必须修掉的东西。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { RUN_TAG_ENV, sweepRun } from './run-janitor.ts'
import {
  describeVerdict,
  judge,
  needCeilingWarning,
  resolveWatchdogOptions,
  type ProgressSample,
  type WatchdogOptions,
} from './watchdog.ts'

export interface HarnessRunOptions {
  /** DSH CLI 的绝对路径。 */
  dshBin: string
  /** Node 24 绝对路径。DSH 要求 >= 24.9，系统 node 是 22。 */
  nodePath: string
  /** 工作目录（git 仓库）。 */
  cwd: string
  /** prompt 正文。 */
  prompt: string
  /** 续接的会话 id。首轮必须不传。 */
  sessionId?: string
  /**
   * **绝对资源上限**（不是超时判定）。到点强制收口，默认 6 小时。
   *
   * 2026-11-23 起它不再是 45 分钟：复杂度高的需求跑两三个小时是正常的，
   * 用固定时限切掉，等于系统性地只允许做简单需求。
   */
  timeoutMs?: number
  /**
   * 收口提前量：在上限前这么多毫秒先发 SIGTERM，给 Agent 一个写出交接的机会。
   * 默认 60 秒。设为 0 则完全不打招呼、到点直接 SIGKILL。
   */
  graceMs?: number
  /**
   * 外部叫停（用户在群里回「截断」）。abort 后按 `graceMs` 走同一套两段式收口。
   *
   * 用 AbortSignal 而不是回调，是为了让「谁有权杀」「什么时候杀」留在 coordinator 一侧，
   * 这里只负责「收到信号就体面收口」。
   */
  abortSignal?: AbortSignal
  /**
   * 看门狗：定期采样进程 CPU，判定「疑似死锁」并**只报告**（杀不杀由用户决定）。
   * 为 `null`/不传则关闭（测试里默认关掉，避免留下定时器）。
   */
  watchdog?: HarnessWatchdog | null
  /** 额外环境变量（例如 DEEPSEEK_API_KEY）。会合并进 process.env。 */
  env?: NodeJS.ProcessEnv
  /** 每收到一个事件回调一次，用于实时推进卡片。 */
  onEvent?: (event: HarnessEvent) => void
  /**
   * 清理用标记。默认自动生成唯一值。
   * 覆盖它主要为测试注入确定性。
   */
  runId?: string
}

/** --json 事件的最小形状。故意用宽松类型：新增事件类型不该让解析器崩。 */
export interface HarnessEvent {
  readonly type: string
  readonly sessionId?: string
  readonly text?: string
  readonly status?: string
  readonly [key: string]: unknown
}

export type HarnessOutcome =
  | 'completed'
  | 'failed'
  /** 被我们切断（到绝对上限，或用户选择截断）。**不是** completed。 */
  | 'truncated'
  | 'timeout'
  | 'spawn-error'

/**
 * 看门狗接线：采样拿 CPU，判定拿事件间隔，报告交回给 coordinator。
 *
 * 分工是这样切的：
 *   - `readCpu`：进程树 CPU 百分比。跑 `/proc` 的实现放在 `run-sampler.ts`，
 *     这里只认这个形状 —— 测试就不必造一个假 `/proc`。
 *   - `onSuspect` / `onCeilingWarning`：**只报告**。这里没有任何「判定完就杀」的路径，
 *     唯一会截断的是绝对上限（`timeoutMs`）与外部 `abortSignal`。
 *   - `onSample`：每个采样的原始读数，写日志用（线上排查「到底卡在几分几秒」）。
 */
export interface HarnessWatchdog {
  readonly options?: WatchdogOptions
  /**
   * 读一次进程树 CPU。**返回 null 表示这一次读不到**（没有 /proc、采样器还没就绪）。
   *
   * 为什么不用 -1 表示未知：判据是 `cpuPercent < cpuFloorPercent`，
   * `-1 < 1` 成立，等于「读不到」会被判成「CPU 空闲」，再凑上「事件静止」就成了
   * 一次误报的疑似死锁。未知必须是未知，不能伪装成一个很小的数。
   * 返回 null 时这一轮直接跳过：不追加采样点、不判定（也就不会把 suspect streak 攒起来）。
   */
  readonly readCpu: (
    childPid: number,
  ) => { readonly cpuPercent: number; readonly maxChildCpuPercent: number } | null
  readonly onSuspect?: (info: WatchdogNotice) => void
  readonly onCeilingWarning?: (info: WatchdogNotice) => void
  readonly onSample?: (info: WatchdogNotice) => void
}

export interface WatchdogNotice {
  readonly sample: ProgressSample
  /** 一句中文说明，可直接进群聊。 */
  readonly description: string
  readonly elapsedMs: number
  readonly runStartedAtMs: number
}

export interface HarnessResult {
  readonly outcome: HarnessOutcome
  /** 首轮捕获到的会话 id；续接轮原样回填。 */
  readonly sessionId: string | null
  /** final 事件的正文；没有则为空串。 */
  readonly finalText: string
  /** 全部事件，按到达顺序。 */
  readonly events: readonly HarnessEvent[]
  /** 事件计数，写卡片用。 */
  readonly counts: {
    readonly toolCalls: number
    readonly subagentCalls: number
    readonly textEvents: number
  }
  readonly exitCode: number | null
  readonly durationMs: number
  /** 失败原因。completed 时为空。 */
  readonly error?: string
}

/**
 * 绝对资源上限：6 小时（设计文档 §3.4）。
 *
 * 为什么不是 45 分钟：2026-11-21 的 T-0024/25/26 三张单都在 45 分钟被切掉，
 * 其中 T-0027 更明确 —— 它跑到 43 分钟时已经在 `verifying` 阶段，只差最后一步。
 * 用时限判断「卡死」是最省事的错法：它把「复杂度高」和「死锁」当成同一件事。
 * 6 小时是资源底线（2 vCPU 的机器上一个 run 占着跑一夜没有意义），不是进度判定。
 */
export const DEFAULT_CEILING_MS = 6 * 3600 * 1000

/**
 * 默认收口提前量：60 秒（设计文档 §3.4）。
 *
 * 收到 SIGTERM 后 Agent 至少要来得及补一句「我做到哪了」。
 * 60 秒是实测尺度：写一段交接文本 + 正常退出的开销远小于这个数，
 * 而真的挂死的进程多给 60 秒也不会自己活过来。
 */
export const DEFAULT_GRACE_MS = 60 * 1000

/** 旧名保留：外部还有按 45 分钟理解的引用时，读到这里能看见结论怎么变的。 */
export const DEFAULT_TIMEOUT_MS = DEFAULT_CEILING_MS

/**
 * 从一堆事件里尽力拼一份「截止时做到了哪」的交接摘要。
 *
 * 超时时这条摘要会写进卡片和失败原因里 —— 否则运维只看到一个 `timeout`，
 * 无法判断「Agent 是卡在第一步、还是快要完成了」。取最后几段 text 事件，
 * 没有 text 就退回工具调用统计（至少能看出它跑到哪一步）。
 */
export function buildTimeoutHandover(events: readonly HarnessEvent[], limit = 400): string {
  const texts: string[] = []
  for (const event of events) {
    if (event.type === 'text' && typeof event.text === 'string' && event.text.trim().length > 0) {
      texts.push(event.text.trim())
    }
  }
  const counts = countEvents(events)
  const progress = `已调用工具 ${counts.toolCalls} 次（含子 Agent ${counts.subagentCalls} 次）`
  if (texts.length === 0) return progress
  // 取最后 2 段，足够看出「在做什么/做到哪」，又不至于把卡片刷爆
  const tail = texts.slice(-2).join(' ')
  const text = tail.length <= limit ? tail : `…${tail.slice(-limit)}`
  return `${progress}；最后进展：${text}`
}

/** 上限的人话。测试里会把上限设成 1.2 秒，所以小于一分钟的也要能说清楚。 */
function formatCeiling(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} 小时`
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`
  return `${Math.round(ms)} 毫秒`
}

/**
 * 被切断之后，这次 run 到底算什么。
 *
 * 唯一的规则：**退出码 0 也只算 `truncated`，绝不算 `completed`**。
 * 退出得干净说明它来得及写交接，不说明任务做完了 —— 2026-11-23 T-0027 就是在这里被误判的。
 *
 * 抽成纯函数是为了能在任何平台上断言：给进程发信号的行为各平台不一致
 * （Windows 上 SIGTERM 会变成强制终止），但「怎么判」必须处处一致。
 */
export function outcomeForStop(stop: {
  readonly stopCause: 'ceiling' | 'abort' | null
  readonly softStopped: boolean
  readonly code: number | null
}): 'truncated' | 'timeout' {
  return stop.code === 0 ? 'truncated' : 'timeout'
}

/**
 * 解析一行 NDJSON。解析失败返回 null 而不是抛错：
 * 日志行、进度条等非事件输出会混进来，不该让整个 run 失败。
 */
export function parseEventLine(line: string): HarnessEvent | null {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed[0] !== '{') return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const type = (parsed as { type?: unknown }).type
    if (typeof type !== 'string' || type.length === 0) return null
    return parsed as HarnessEvent
  } catch {
    return null
  }
}

/** 从一堆事件里抽会话 id：只看 session 事件。 */
export function extractSessionId(events: readonly HarnessEvent[]): string | null {
  for (const event of events) {
    if (event.type === 'session' && typeof event.sessionId === 'string' && event.sessionId.length > 0) {
      return event.sessionId
    }
  }
  return null
}

/** 从一堆事件里抽 final 正文。取最后一个 final 事件。 */
export function extractFinalText(events: readonly HarnessEvent[]): string {
  let text = ''
  for (const event of events) {
    if (event.type === 'final' && typeof event.text === 'string') text = event.text
  }
  return text
}

/** 统计工具调用，其中 subagent 单独计，用于卡片汇报「派发了几个子 Agent」。 */
export function countEvents(events: readonly HarnessEvent[]): HarnessResult['counts'] {
  let toolCalls = 0
  let subagentCalls = 0
  let textEvents = 0
  for (const event of events) {
    if (event.type === 'tool_call') {
      toolCalls += 1
      const name = typeof event.name === 'string' ? event.name : ''
      if (name.includes('subagent')) subagentCalls += 1
    } else if (event.type === 'text') {
      textEvents += 1
    }
  }
  return { toolCalls, subagentCalls, textEvents }
}

/** 组装命令行参数。抽成纯函数便于断言，不用真的起进程。 */
export function buildArgs(options: Pick<HarnessRunOptions, 'prompt' | 'sessionId'>): string[] {
  const args = [
    '--profile',
    'headless',
    '--json',
    '--approval-policy',
    'never',
    '--permission-mode',
    'workspace-write',
  ]
  if (options.sessionId !== undefined && options.sessionId.length > 0) {
    args.push('--session-id', options.sessionId)
  }
  // prompt 走 stdin 而不是参数：参数长度有上限，且 prompt 里可能有特殊字符。
  args.push('-')
  return args
}

export async function runHarness(options: HarnessRunOptions): Promise<HarnessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CEILING_MS
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const startedAt = Date.now()
  // 唯一标记：注入子进程环境，所有子孙都会继承（环境是 fork 时复制的）。
  // 超时时按这个标记扫 /proc 清理，不依赖进程组 —— 实测进程组杀不到被 setsid 的孙进程。
  const runId = options.runId ?? `run-${randomUUID()}`
  const watchdog = options.watchdog ?? null
  const watchdogOptions = resolveWatchdogOptions(watchdog?.options)

  return await new Promise<HarnessResult>((resolve) => {
    const events: HarnessEvent[] = []
    // 最近一次**有意义**的事件时刻：看门狗判「还有没有进展」就看它。
    // 用 startedAt 起步，否则刚开跑的那几分钟会因为「还没有事件」被误算成静默。
    let lastEventAtMs = startedAt
    let settled = false
    let timedOut = false
    let softStopped = false
    /** 谁把我们叫停的。`ceiling`=绝对上限，`abort`=用户选择截断。 */
    let stopCause: 'ceiling' | 'abort' | null = null
    let buffer = ''
    let stderrTail = ''
    const watchdogSamples: ProgressSample[] = []

    const finish = (result: Omit<HarnessResult, 'durationMs' | 'events' | 'counts' | 'finalText' | 'sessionId'> & {
      sessionIdOverride?: string | null
    }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      if (abortKillTimer !== undefined) clearTimeout(abortKillTimer)
      if (watchdogTimer !== undefined) clearInterval(watchdogTimer)
      try {
        options.abortSignal?.removeEventListener('abort', onAbort)
      } catch {
        // 忽略：AbortSignal 可能来自别的 realm
      }
      resolve({
        outcome: result.outcome,
        sessionId: result.sessionIdOverride ?? extractSessionId(events),
        finalText: extractFinalText(events),
        events,
        counts: countEvents(events),
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
        ...(result.error === undefined ? {} : { error: result.error }),
      })
    }

    const child = spawn(options.nodePath, [options.dshBin, ...buildArgs(options)], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, [RUN_TAG_ENV]: runId },
      stdio: ['pipe', 'pipe', 'pipe'],
      // 独立进程组：先试进程组杀，覆盖常规情况
      detached: true,
    })

    /** 第一级收口：SIGTERM 让 Agent 写出交接后自己退。 */
    const sendTerm = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
      } catch {
        try {
          child.kill('SIGTERM')
        } catch {
          // 进程可能已经退出
        }
      }
    }

    /**
     * 第二级收口：SIGKILL + 按标记扫 /proc 捡回被 setsid 掉的孙进程。
     * 第二级是必需的：实测只做第一级时，npm/tsc 残留了 36 分钟。
     */
    const sendKill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // 进程可能已经退出
        }
      }
      try {
        const swept = sweepRun(runId)
        if (swept.killed.length > 0) {
          stderrTail = `${stderrTail}\n[janitor] killed ${swept.killed.length} leftover process(es): ${swept.killed.join(',')}`.slice(-4096)
        }
      } catch {
        // 清理失败不应影响结果判定；残留会由下次运行前的 sweep 兜住
      }
    }

    /**
     * 软截止：先 SIGTERM 让 Agent 收口（写出它当前做到哪），
     * 真正的硬上限再用 SIGKILL 兜底。graceMs<=0 时跳过这一级（=旧行为：到点直接杀）。
     */
    const graceTimer: ReturnType<typeof setTimeout> | undefined =
      graceMs > 0 && timeoutMs > graceMs
        ? setTimeout(() => {
            if (settled) return
            softStopped = true
            stopCause = 'ceiling'
            sendTerm()
          }, timeoutMs - graceMs)
        : undefined
    if (graceTimer !== undefined && typeof graceTimer.unref === 'function') graceTimer.unref()

    const timer = setTimeout(() => {
      timedOut = true
      if (stopCause === null) stopCause = 'ceiling'
      sendKill()
    }, timeoutMs)

    // ── 外部叫停（用户回「截断」）───────────────────────────────────────
    // 与到顶走同一套两段式：先 SIGTERM 收口，`graceMs` 后再 SIGKILL。
    // 理由：用户叫停往往是因为「看起来卡住了」，但卡住的进程也可能刚好在写最后一段交接文本。
    let abortKillTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      if (settled || softStopped) return
      softStopped = true
      stopCause = 'abort'
      sendTerm()
      abortKillTimer = setTimeout(() => {
        if (settled) return
        timedOut = true
        sendKill()
      }, Math.max(0, graceMs))
      if (typeof abortKillTimer.unref === 'function') abortKillTimer.unref()
    }
    if (options.abortSignal !== undefined) {
      if (options.abortSignal.aborted) onAbort()
      else options.abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    // ── 看门狗：只报告，不杀 ────────────────────────────────────────────
    let watchdogTimer: ReturnType<typeof setInterval> | undefined
    let ceilingWarned = false
    if (watchdog !== null) {
      const tick = (): void => {
        if (settled) return
        const nowMs = Date.now()
        let cpu: { cpuPercent: number; maxChildCpuPercent: number } | null
        try {
          cpu = watchdog.readCpu(child.pid ?? -1)
        } catch {
          // 采样失败不能让 run 挂掉，但也不能伪装成「CPU 0%」——见 HarnessWatchdog.readCpu 的说明。
          cpu = null
        }
        if (cpu === null) return
        const sample: ProgressSample = {
          at: nowMs,
          lastEventAgeMs: nowMs - lastEventAtMs,
          cpuPercent: cpu.cpuPercent,
          maxChildCpuPercent: cpu.maxChildCpuPercent,
          toolCalls: countEvents(events).toolCalls,
        }
        watchdogSamples.push(sample)
        // judge 只吃末尾 suspectStreak 个，多留一些是为了日志和排障；
        // 上限按 6 小时 / 60 秒 的 2 倍算，防止长 run 把内存吃满。
        if (watchdogSamples.length > 720) watchdogSamples.shift()

        const verdict = judge(watchdogSamples, nowMs, startedAt, watchdogOptions)
        const description = describeVerdict(verdict, watchdogSamples, nowMs, startedAt, watchdogOptions)
        const elapsedMs = nowMs - startedAt
        const notice: WatchdogNotice = { sample, description, elapsedMs, runStartedAtMs: startedAt }
        try {
          watchdog.onSample?.(notice)
          if (!ceilingWarned && needCeilingWarning(nowMs, startedAt, watchdogOptions)) {
            ceilingWarned = true
            watchdog.onCeilingWarning?.(notice)
          }
          if (verdict === 'suspect') watchdog.onSuspect?.(notice)
        } catch {
          // 播报失败不能中断 run
        }
      }
      watchdogTimer = setInterval(tick, watchdogOptions.sampleIntervalMs)
      if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const event = parseEventLine(line)
        if (event !== null) {
          events.push(event)
          lastEventAtMs = Date.now()
          try {
            options.onEvent?.(event)
          } catch {
            // 回调失败不能中断 run
          }
        }
        newline = buffer.indexOf('\n')
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // 只留最后 4KB，避免长 run 把内存吃满
      stderrTail = (stderrTail + chunk).slice(-4096)
    })

    child.on('error', (error) => {
      finish({ outcome: 'spawn-error', exitCode: null, error: error.message })
    })

    child.on('close', (code) => {
      // 处理最后一行没有换行符的情况
      const tail = parseEventLine(buffer)
      if (tail !== null) {
        events.push(tail)
        try {
          options.onEvent?.(tail)
        } catch {
          // 忽略
        }
      }

      if (timedOut || softStopped) {
        // 被切断。**这里绝不能返回 completed** —— 2026-11-23 的真实事故：
        // T-0027 收到 SIGTERM 后正常退出（退出码 0），旧实现据此判 `completed`，
        // 于是只完成 40% 的改动被推进 `gated`（可部署），卡片告诉用户「已完成」。
        // 「进程退得干净」和「任务做完了」是两件不同的事，被切断的 run 两者都只满足前者。
        //
        // 两种收尾：
        //   · 退出码 0 → 它收口了，能拿到交接信息 → `truncated`（被我们截断）；
        //   · 退出码非 0 → 只能强杀 → `timeout`。
        const handover = buildTimeoutHandover(events)
        const why =
          stopCause === 'abort'
            ? `用户选择截断（已跑 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`
            : softStopped
              ? `已到绝对上限 ${formatCeiling(timeoutMs)}，先送 SIGTERM 请它收口`
              : `已到绝对上限 ${formatCeiling(timeoutMs)}，强制终止（未设收口时间）`
        if (code === 0) {
          finish({
            outcome: outcomeForStop({ stopCause, softStopped, code }),
            exitCode: code,
            error: `${why}，Agent 收口后正常退出（**未完成**）；${handover}`,
          })
          return
        }
        finish({
          outcome: outcomeForStop({ stopCause, softStopped, code }),
          exitCode: code,
          error: `${why}，仍未正常退出后强制终止；${handover}`,
        })
        return
      }
      if (code === 0) {
        finish({ outcome: 'completed', exitCode: code })
        return
      }
      finish({
        outcome: 'failed',
        exitCode: code,
        error: stderrTail.trim().split('\n').slice(-3).join(' | ') || `退出码 ${code}`,
      })
    })

    // prompt 从 stdin 送进去
    child.stdin.on('error', () => {
      // 子进程可能提前退出导致 EPIPE，这里忽略，由 close 事件统一判定
    })
    child.stdin.end(options.prompt, 'utf8')
  })
}
