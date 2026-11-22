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
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { RUN_TAG_ENV, sweepRun } from './run-janitor.ts'

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
  /** 硬超时，默认 45 分钟。到点 SIGKILL。 */
  timeoutMs?: number
  /**
   * 「软截止」提前量：在硬超时前这么多毫秒先发 SIGTERM，给 Agent 一个收口的机会。
   * 默认 2 分钟。设为 0 则完全不打招呼、到点直接 SIGKILL（旧行为）。
   */
  graceMs?: number
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
  | 'timeout'
  | 'spawn-error'

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

export const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000

/**
 * 默认「软截止」提前量：硬超时前 2 分钟先发 SIGTERM。
 *
 * 用户 2026-11-22 的原话：「3的那个tickbot现在是45分钟没收口强制截断」——
 * 意思是到 45 分钟**直接 SIGKILL**，Agent 连一句「我做到哪了」都来不及说，
 * 卡片上只有 `outcome=timeout`，等于白跑 45 分钟且没有任何可交接的信息。
 *
 * 现在的两段式：
 *   1. 第 43 分钟：SIGTERM —— Agent 可以收口、写出当前结论/半成品；
 *   2. 第 45 分钟：若仍未退出，SIGKILL（保留硬上限，防止真的挂死）。
 *
 * 为什么不是「只延长超时」：那是把 45 分钟的浪费变成 60 分钟的浪费，
 * 没有解决「超时就什么都拿不到」这个根本问题。
 */
export const DEFAULT_GRACE_MS = 2 * 60 * 1000

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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const startedAt = Date.now()
  // 唯一标记：注入子进程环境，所有子孙都会继承（环境是 fork 时复制的）。
  // 超时时按这个标记扫 /proc 清理，不依赖进程组 —— 实测进程组杀不到被 setsid 的孙进程。
  const runId = options.runId ?? `run-${randomUUID()}`

  return await new Promise<HarnessResult>((resolve) => {
    const events: HarnessEvent[] = []
    let settled = false
    let timedOut = false
    let softStopped = false
    let buffer = ''
    let stderrTail = ''

    const finish = (result: Omit<HarnessResult, 'durationMs' | 'events' | 'counts' | 'finalText' | 'sessionId'> & {
      sessionIdOverride?: string | null
    }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
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

    /**
     * 软截止：先 SIGTERM 让 Agent 收口（写出它当前做到哪），
     * 真正的硬超时再用 SIGKILL 兜底。graceMs<=0 时跳过这一级（=旧行为：到点直接杀）。
     */
    const graceTimer: ReturnType<typeof setTimeout> | undefined =
      graceMs > 0 && timeoutMs > graceMs
        ? setTimeout(() => {
            if (settled) return
            softStopped = true
            try {
              if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
            } catch {
              try {
                child.kill('SIGTERM')
              } catch {
                // 进程可能已经退出
              }
            }
          }, timeoutMs - graceMs)
        : undefined
    if (graceTimer !== undefined && typeof graceTimer.unref === 'function') graceTimer.unref()

    const timer = setTimeout(() => {
      timedOut = true
      // 两级清理：
      //   1) 先杀进程组（常规情况足够，且最快）；
      //   2) 再按 DILEE_RUN_ID 标记扫 /proc，捡回被 setsid 掉的孙进程。
      // 第二级是必需的：实测只做第一级时，npm/tsc 残留了 36 分钟。
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
    }, timeoutMs)

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
        // 到了软截止/硬超时。**必须先判「是否真的收口成功」**：
        // 软截止发出的 SIGTERM 会让子进程在硬超时之前就退出，此时 timedOut 仍是 false。
        // 早期版本只判 timedOut，导致「已收口退出」被误判成 failed（测试抓到的真实缺陷）。
        //
        // 三种收尾：
        //   · 退出码 0 → Agent 收到 SIGTERM 后写出了结论并正常退出 = **收口成功**，算 completed；
        //   · 退出码非 0 → 被切断，算 timeout，并把「做到哪了」带进 error（用户要的就是这个）。
        if (code === 0) {
          finish({
            outcome: 'completed',
            exitCode: code,
            error: `已到截止时间（${Math.round(timeoutMs / 1000)} 秒），Agent 收口后正常退出；${buildTimeoutHandover(events)}`,
          })
          return
        }
        const handover = buildTimeoutHandover(events)
        const how = softStopped ? '已先送 SIGTERM 请它收口，仍未正常退出后强制终止' : '强制终止（未设软截止）'
        finish({ outcome: 'timeout', exitCode: code, error: `超过 ${timeoutMs}ms 未结束（${how}）；${handover}` })
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
