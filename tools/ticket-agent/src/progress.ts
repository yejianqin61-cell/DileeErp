/**
 * 施工进度：把 DSH 的事件流与工单状态，变成群里能一眼看懂的话。
 *
 * 为什么不用模型来写进度：进度是可枚举的事实（状态、时长、阶段、工具调用数、子 Agent 数、
 * 改了哪些文件），模型只会重述，还可能编造「已完成 70%」这种没有依据的话。
 * 这里全部是纯函数，可以用固定事件流回归。
 *
 * 为什么事件要落库：用户在 15 分钟的 run 里随时可能问一句「T-0007 进度」；
 * 机器人进程若在中途重启，内存里的计数就没了。落库后重启仍答得出。
 */

import type { HarnessEvent } from './harness-runner.ts'
import type { FeishuCard } from './feishu-transport.ts'
import type { StoredTicket, TicketProgress, TicketResult } from './ticket-store.ts'

export type RunPhase = 'starting' | 'reading' | 'editing' | 'verifying' | 'delegating' | 'finishing'

const PHASES: readonly RunPhase[] = ['starting', 'reading', 'editing', 'verifying', 'delegating', 'finishing']

const PHASE_LABELS: Record<RunPhase, string> = {
  starting: '已开工',
  reading: '在读代码',
  editing: '在改代码',
  verifying: '在跑命令/验证',
  delegating: '在派发子 Agent',
  finishing: '在收尾',
}

export function phaseLabel(phase: RunPhase): string {
  return PHASE_LABELS[phase]
}

/** 落库的字符串 phase 转回枚举。旧数据或未知值一律当「已开工」。 */
export function phaseFromString(value: string | undefined): RunPhase {
  if (value !== undefined && (PHASES as readonly string[]).includes(value)) return value as RunPhase
  return 'starting'
}

export interface ProgressState {
  readonly phase: RunPhase
  readonly toolCalls: number
  readonly subagentCalls: number
  /** 触及过的文件（去重），只用于计数与展示最近动作。 */
  readonly files: readonly string[]
  readonly lastAction: string | null
  readonly lastText: string | null
}

export const INITIAL_PROGRESS: ProgressState = {
  phase: 'starting',
  toolCalls: 0,
  subagentCalls: 0,
  files: [],
  lastAction: null,
  lastText: null,
}

function oneLine(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * 从 tool_call 事件里尽量取一点人话细节（改了哪个文件、跑了什么命令）。
 *
 * 字段名按 DSH 几种可能形状逐一尝试，取不到就只显示工具名 ——
 * 事件 schema 是外部契约，这里不能假设它一定长什么样。
 */
export function toolDetail(event: HarnessEvent): string | null {
  for (const key of ['input', 'args', 'arguments', 'parameters']) {
    const value = event[key]
    if (typeof value === 'string' && value.trim().length > 0) return oneLine(value, 80)
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      for (const field of ['path', 'file', 'file_path', 'filename', 'command', 'cmd', 'query', 'pattern', 'description']) {
        const hit = stringField(record[field])
        if (hit !== null) return oneLine(hit, 80)
      }
      for (const candidate of Object.values(record)) {
        const hit = stringField(candidate)
        if (hit !== null) return oneLine(hit, 80)
      }
    }
  }
  return null
}

/** tool_call 的工具名。DSH 的 `name` 已由 countEvents 使用，这里再兜两个别名。 */
export function toolName(event: HarnessEvent): string {
  for (const key of ['name', 'tool', 'toolName']) {
    const value = event[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

/** 工具名 → 阶段。顺序即优先级：派发 > 改代码 > 跑命令 > 读代码。 */
export function phaseForTool(name: string): RunPhase | null {
  const lower = name.toLowerCase()
  if (lower.includes('subagent') || lower.includes('workflow')) return 'delegating'
  if (lower.includes('edit') || lower.includes('write') || lower.includes('patch') || lower.includes('apply')) return 'editing'
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('exec') || lower.includes('terminal') || lower.includes('command')) {
    return 'verifying'
  }
  if (
    lower.includes('read') ||
    lower.includes('grep') ||
    lower.includes('glob') ||
    lower.includes('list') ||
    lower.includes('search') ||
    lower.includes('ls') ||
    lower.includes('stat')
  ) {
    return 'reading'
  }
  return null
}

/**
 * 消化一个事件。返回新对象，不修改入参：同一份事件流在任何顺序下都不该被副作用污染。
 */
export function applyEvent(state: ProgressState, event: HarnessEvent): ProgressState {
  if (event.type === 'tool_call') {
    const name = toolName(event)
    const detail = toolDetail(event)
    const phase = phaseForTool(name) ?? state.phase
    const lookedLikePath = detail !== null && /[/\\]|\.\w{1,5}$/.test(detail)
    const files =
      lookedLikePath && (phase === 'editing' || phase === 'reading') && !state.files.includes(detail)
        ? [...state.files, detail]
        : state.files
    return {
      ...state,
      phase,
      toolCalls: state.toolCalls + 1,
      subagentCalls: state.subagentCalls + (/subagent|workflow/i.test(name) ? 1 : 0),
      files,
      lastAction: name.length > 0 ? (detail === null ? name : `${name} ${detail}`) : state.lastAction,
    }
  }

  if (event.type === 'text') {
    const text = stringField(event.text)
    return text === null ? state : { ...state, lastText: oneLine(text, 120) }
  }

  if (event.type === 'final') {
    return { ...state, phase: 'finishing' }
  }

  if (event.type === 'session' && state.phase === 'starting') {
    return state
  }

  return state
}

/** 运行期进度 → 卡片/文本用的视图（不依赖内存对象）。 */
export interface ProgressView {
  readonly phase: RunPhase
  readonly startedAtMs: number
  readonly toolCalls: number
  readonly subagentCalls: number
  readonly filesChanged: number
  readonly lastAction: string | null
  readonly lastText: string | null
}

export function toView(progress: ProgressState, startedAtMs: number): ProgressView {
  return {
    phase: progress.phase,
    startedAtMs,
    toolCalls: progress.toolCalls,
    subagentCalls: progress.subagentCalls,
    filesChanged: progress.files.length,
    lastAction: progress.lastAction,
    lastText: progress.lastText,
  }
}

/** 落库的进度 → 视图。没有进度则返回 null（例如旧数据、还没开跑）。 */
export function fromStored(progress: TicketProgress | undefined | null): ProgressView | null {
  if (progress === undefined || progress === null) return null
  const startedAtMs = Date.parse(progress.startedAt)
  return {
    phase: phaseFromString(progress.phase),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
    toolCalls: progress.toolCalls,
    subagentCalls: progress.subagentCalls,
    filesChanged: progress.filesChanged,
    lastAction: progress.lastAction,
    lastText: progress.lastText,
  }
}

export function toStoredProgress(input: {
  view: ProgressView
  startedAt: string
  updatedAt: string
}): TicketProgress {
  return {
    phase: input.view.phase,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    toolCalls: input.view.toolCalls,
    subagentCalls: input.view.subagentCalls,
    filesChanged: input.view.filesChanged,
    lastAction: input.view.lastAction,
    lastText: input.view.lastText,
  }
}

/** 时长人话：43 秒 / 6 分 32 秒 / 1 小时 2 分。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`
}

/** 九态 → 中文标签。与 ticket-state 的九态一一对应。 */
export function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    received: '已受理',
    needs_info: '等补充信息',
    triaged: '已分诊',
    queued: '排队中',
    building: '施工中',
    gated: '已完成，待部署',
    deploying: '部署中',
    done: '已上线',
    failed: '未完成',
    rolled_back: '已回滚',
  }
  return labels[state] ?? state
}

function progressLines(view: ProgressView, nowMs: number): string[] {
  const lines: string[] = []
  lines.push(`**已用**：${formatDuration(Math.max(0, nowMs - view.startedAtMs))}`)
  const action = view.lastAction === null ? '' : `（${view.lastAction}）`
  lines.push(`**当前**：${phaseLabel(view.phase)}${action}`)
  const subagent = view.subagentCalls > 0 ? `，其中派发子 Agent ${view.subagentCalls} 次` : ''
  lines.push(`**过程**：工具调用 ${view.toolCalls} 次${subagent}`)
  if (view.filesChanged > 0) lines.push(`**改动**：已触及 ${view.filesChanged} 个文件`)
  if (view.lastText !== null) lines.push(`**最新**：${view.lastText}`)
  return lines
}

/** 施工中的主卡片（原地更新）。 */
export function progressCard(input: {
  ticketNo: string
  view: ProgressView
  nowMs: number
  queueAhead: number
}): FeishuCard {
  return {
    title: `施工中｜${input.ticketNo}`,
    template: 'blue',
    lines: progressLines(input.view, input.nowMs),
    footer: `${input.ticketNo}｜回复这张卡片可追加需求`,
  }
}

/** 群内进度播报的一行。刻意短：群里刷屏比没进度更烦。 */
export function heartbeatLine(input: { ticketNo: string; view: ProgressView; nowMs: number }): string {
  const elapsed = formatDuration(Math.max(0, input.nowMs - input.view.startedAtMs))
  const subagent = input.view.subagentCalls > 0 ? `，子 Agent ${input.view.subagentCalls} 次` : ''
  const files = input.view.filesChanged > 0 ? `，已触及 ${input.view.filesChanged} 个文件` : ''
  return `${input.ticketNo} ${phaseLabel(input.view.phase)} ${elapsed}：工具调用 ${input.view.toolCalls} 次${files}${subagent}`
}

function firstLine(text: string, limit: number): string {
  return oneLine(text, limit)
}

/**
 * 回答「T-0007 进度」。
 *
 * 不同状态答不同的事：排队中给位次，施工中给细节，已完成给结论。
 * 用户问进度时真正想知道的是「还要等多久 / 结果怎么样」。
 */
export function statusText(input: { ticket: StoredTicket; nowMs: number; queueAhead: number }): string {
  const { ticket, nowMs, queueAhead } = input
  const lines: string[] = []
  const userText = firstLine(ticket.turns[0]?.text ?? '', 60)

  if (ticket.state === 'queued') {
    lines.push(`${ticket.no}｜排队中`)
    if (queueAhead > 0) lines.push(`前面还有 ${queueAhead} 张单在跑`)
    lines.push(`原话：${userText}`)
    lines.push('轮到你时会自动开工，过程中我会同步进度。')
    return lines.join('\n')
  }

  if (ticket.state === 'building') {
    const view = fromStored(ticket.progress)
    if (view === null) {
      lines.push(`${ticket.no}｜刚开工`)
      lines.push(`原话：${userText}`)
      lines.push('还没产出进度细节，稍等我再更新。')
    } else {
      lines.push(`${ticket.no}｜施工中，已用 ${formatDuration(Math.max(0, nowMs - view.startedAtMs))}`)
      lines.push(`当前：${phaseLabel(view.phase)}${view.lastAction === null ? '' : `（${view.lastAction}）`}`)
      const subagent = view.subagentCalls > 0 ? `，其中派发子 Agent ${view.subagentCalls} 次` : ''
      lines.push(`过程：工具调用 ${view.toolCalls} 次${subagent}`)
      if (view.filesChanged > 0) lines.push(`改动：已触及 ${view.filesChanged} 个文件`)
      lines.push(`原话：${userText}`)
    }
    return lines.join('\n')
  }

  if (ticket.state === 'gated') {
    lines.push(`${ticket.no}｜已完成，产出待部署`)
    const result = ticket.result
    if (result !== null && result !== undefined) {
      if (result.summary.length > 0) lines.push(`结论：${firstLine(result.summary, 300)}`)
      lines.push(`用时：${formatDuration(result.durationMs)}`)
    }
    lines.push('回复这张卡片可以直接提改进需求。')
    return lines.join('\n')
  }

  if (ticket.state === 'failed') {
    lines.push(`${ticket.no}｜未完成`)
    const result = ticket.result
    if (result !== null && result !== undefined && result.summary.length > 0) {
      lines.push(`原因：${firstLine(result.summary, 200)}`)
    }
    lines.push('回复这张卡片补充一下，我会重新跑一轮。')
    return lines.join('\n')
  }

  if (ticket.state === 'needs_info') {
    lines.push(`${ticket.no}｜还缺信息，没开工`)
    lines.push('需要补：你希望它变成什么样（例如：应该按单号倒序）')
    lines.push(`原话：${userText}`)
    lines.push('直接再发一条消息补充就行。')
    return lines.join('\n')
  }

  lines.push(`${ticket.no}｜${stateLabel(ticket.state)}`)
  lines.push(`原话：${userText}`)
  return lines.join('\n')
}

/**
 * 没给票号时的总览：正在跑的、最近完成的。
 *
 * 用户问「进度」时若没带票号，最有用的答案是「现在有几张、分别到哪了」。
 */
export function overviewText(input: { tickets: readonly StoredTicket[]; nowMs: number }): string {
  const active = input.tickets.filter((ticket) => ticket.state === 'queued' || ticket.state === 'building')
  const done = input.tickets
    .filter((ticket) => !['queued', 'building'].includes(ticket.state))
    .slice(-3)
    .reverse()

  const lines: string[] = []
  if (active.length === 0) {
    lines.push('现在没有在跑的单。')
  } else {
    lines.push(`当前在用 ${active.length} 张单：`)
    for (const ticket of active) {
      const head = ticket.turns[0]?.text ?? ''
      if (ticket.state === 'building') {
        const view = fromStored(ticket.progress)
        const elapsed = view === null ? '' : `，已用 ${formatDuration(Math.max(0, input.nowMs - view.startedAtMs))}`
        lines.push(`- ${ticket.no} 施工中${elapsed}（原话：${firstLine(head, 40)}）`)
      } else {
        lines.push(`- ${ticket.no} 排队中（原话：${firstLine(head, 40)}）`)
      }
    }
  }

  if (done.length > 0) {
    lines.push('最近处理过的：')
    for (const ticket of done) {
      const summary = ticket.result?.summary ?? ''
      const tail = summary.length > 0 ? `（结论：${firstLine(summary, 60)}）` : ''
      lines.push(`- ${ticket.no} ${stateLabel(ticket.state)}${tail}`)
    }
  }

  lines.push('要问某一张的细节，@我说「T-0007 进度」。')
  return lines.join('\n')
}

/**
 * 结果卡里的进度补充行，用于 run 结束后的卡片。
 * 放在这里而不是 coordinator：耗时/工具数/子 Agent 的措辞只有一份。
 */
export function resultProgressLines(result: TicketResult, view: ProgressView | null): string[] {
  const lines = [`**用时**：${formatDuration(result.durationMs)}`]
  if (view !== null) {
    const subagent = view.subagentCalls > 0 ? `，其中派发子 Agent ${view.subagentCalls} 次` : ''
    lines.push(`**过程**：工具调用 ${view.toolCalls} 次${subagent}`)
  }
  return lines
}
