/**
 * 工单状态机。
 *
 * 为什么要有独立的状态机，而不是散落在事件处理里：
 * 飞书事件会重投（15 秒 / 5 分钟 / 1 小时 / 6 小时，最多 4 次），
 * 长连接也可能重连时补发。状态如果只靠「谁先到谁执行」，同一句话会开工两次。
 * 这里把「同一 message_id 只能产生一张工单」做成类型层面的约束，
 * 而不是靠调用方记得去查重。
 *
 * 九个状态是固定的，不新增。新增状态意味着有新分支没人测过。
 */

export type TicketState =
  | 'received'
  | 'needs_info'
  | 'triaged'
  | 'queued'
  | 'building'
  | 'gated'
  | 'deploying'
  | 'done'
  | 'failed'
  | 'rolled_back'

/** 终态：不再接受任何迁移。重投事件遇到终态必须被静默丢弃。 */
const TERMINAL = new Set<TicketState>(['done', 'failed', 'rolled_back'])

/**
 * 允许的迁移。
 *
 * 注意 `needs_info → triaged` 是合法的：追问之后用户补充了信息，
 * 同一张工单继续往前走，而不是另开一张。
 * 反过来说，`done → anything` 一律拒绝 —— 已完成的工作不允许被一条重投事件改写。
 */
const TRANSITIONS: Readonly<Record<TicketState, readonly TicketState[]>> = {
  received: ['needs_info', 'triaged', 'failed'],
  needs_info: ['triaged', 'failed'],
  triaged: ['queued', 'failed'],
  queued: ['building', 'failed'],
  building: ['gated', 'failed'],
  gated: ['deploying', 'failed'],
  deploying: ['done', 'failed', 'rolled_back'],
  done: [],
  failed: [],
  rolled_back: [],
}

export type TicketErrorCode =
  | 'invalid-transition'
  | 'ticket-not-found'
  | 'duplicate-message'
  | 'ticket-already-terminal'
  | 'missing-field'

export class TicketError extends Error {
  readonly code: TicketErrorCode

  constructor(code: TicketErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'TicketError'
    this.code = code
  }
}

export interface Ticket {
  /** 工单号。用 message_id 派生，天然唯一。 */
  readonly id: string
  /** 飞书 message_id，是幂等键。 */
  readonly messageId: string
  readonly chatId: string
  /** 发起人 open_id。 */
  readonly senderOpenId: string
  /** 原话。不做任何改写，出问题时这是唯一可信的输入。 */
  readonly text: string
  state: TicketState
  /** 分诊结论。needs_info 时用 missing 告诉用户还缺什么。 */
  triage?: TriageResult
  /** 状态迁移历史，用于证据目录。 */
  readonly history: Array<{ at: string; from: TicketState; to: TicketState; note?: string }>
}

export interface TriageResult {
  /** 要改哪个模块。空表示没识别出来。 */
  readonly module: string | null
  /** 期望行为。空表示用户只说了「坏了」。 */
  readonly expected: string | null
  /** 复现入口，例如页面路径。 */
  readonly entry: string | null
  /** 缺哪些必填项。空数组表示可以开工。 */
  readonly missing: readonly TriageMissingField[]
  /** 一句话摘要，写进卡片标题。 */
  readonly summary: string
}

export type TriageMissingField = 'module' | 'expected' | 'entry'

const REQUIRED_FIELDS: readonly TriageMissingField[] = ['module', 'expected', 'entry']

/**
 * 幂等表：message_id → 工单。
 *
 * 单独成类而不是塞进 TicketStore，是因为「去重」和「迁移」是两件独立的事：
 * 一个是接收侧，一个是执行侧。混在一起之后，想给执行侧加并发控制就会踩到去重逻辑。
 */
export class TicketRegistry {
  private readonly byMessageId = new Map<string, Ticket>()
  private readonly byId = new Map<string, Ticket>()

  /**
   * 收到一条消息。返回 `{ ticket, created }`。
   *
   * `created === false` 表示这条 message_id 已经见过 —— 调用方必须**不要**再发卡片、
   * 也不要再入队。这是重投去重的唯一入口。
   */
  receive(input: {
    messageId: string
    chatId: string
    senderOpenId: string
    text: string
    at: string
  }): { ticket: Ticket; created: boolean } {
    if (!input.messageId) throw new TicketError('missing-field', 'messageId is required')
    if (!input.chatId) throw new TicketError('missing-field', 'chatId is required')

    const existing = this.byMessageId.get(input.messageId)
    if (existing) return { ticket: existing, created: false }

    const ticket: Ticket = {
      id: `T-${input.messageId}`,
      messageId: input.messageId,
      chatId: input.chatId,
      senderOpenId: input.senderOpenId,
      text: input.text,
      state: 'received',
      history: [{ at: input.at, from: 'received', to: 'received', note: 'created' }],
    }
    this.byMessageId.set(ticket.messageId, ticket)
    this.byId.set(ticket.id, ticket)
    return { ticket, created: true }
  }

  get(id: string): Ticket {
    const ticket = this.byId.get(id)
    if (!ticket) throw new TicketError('ticket-not-found', id)
    return ticket
  }

  getByMessageId(messageId: string): Ticket | undefined {
    return this.byMessageId.get(messageId)
  }

  all(): readonly Ticket[] {
    return Array.from(this.byId.values())
  }

  /** 迁移状态。非法迁移抛错，不静默忽略。 */
  transition(id: string, to: TicketState, at: string, note?: string): Ticket {
    const ticket = this.get(id)
    if (TERMINAL.has(ticket.state)) {
      throw new TicketError(
        'ticket-already-terminal',
        `${ticket.id} is ${ticket.state}; ${to} is not reachable`,
      )
    }
    const allowed = TRANSITIONS[ticket.state]
    if (!allowed.includes(to)) {
      throw new TicketError('invalid-transition', `${ticket.state} → ${to} is not allowed`)
    }
    ticket.history.push({ at, from: ticket.state, to, ...(note === undefined ? {} : { note }) })
    ticket.state = to
    return ticket
  }

  /** 记录分诊结论，并按结论决定下一个状态。 */
  applyTriage(id: string, triage: TriageResult, at: string): Ticket {
    const ticket = this.get(id)
    ticket.triage = triage
    const next: TicketState = triage.missing.length === 0 ? 'triaged' : 'needs_info'
    return this.transition(id, next, at, `missing=${triage.missing.join(',') || 'none'}`)
  }
}

export function isTerminal(state: TicketState): boolean {
  return TERMINAL.has(state)
}

export function allowedTransitions(state: TicketState): readonly TicketState[] {
  return TRANSITIONS[state]
}

export function requiredTriageFields(): readonly TriageMissingField[] {
  return REQUIRED_FIELDS
}
