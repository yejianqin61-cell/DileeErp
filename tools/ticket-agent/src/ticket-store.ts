/**
 * 工单持久化。
 *
 * 为什么不用生产数据库：用户 2026-11-13 定的唯一硬黑名单是「不准动生产库」。
 * 工单是 Agent 自己的运行状态，跟 ERP 业务数据无关，放文件系统最干净。
 *
 * 为什么不用 SQLite：这里的数据量是个位数到几十张工单，
 * 一次读写一个 JSON 文件足够；引入 SQLite 只是多一个需要备份的东西。
 *
 * 原子性：所有写入都是「写临时文件 → rename」。
 * rename 在同一文件系统内是原子的，所以进程被杀时不会留下半个 JSON。
 * 这是本模块唯一真正需要小心的部分 —— 工单半损会导致重启后无法判定追加关系。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { RequestHint } from './prompt-builder.ts'

export interface StoredTicket {
  /** 内部 uuid，文件名用。 */
  readonly id: string
  /** 对外短号，形如 T-0001。 */
  readonly no: string
  readonly chatId: string
  /** 该工单主卡片的 message_id。「回复卡片 = 追加」靠它反查。 */
  cardMessageId: string | null
  /** DSH 会话 id。首轮跑完才有值。 */
  sessionId: string | null
  /** 九态之一。字符串而非枚举：状态标签只在 progress.ts 一处维护。 */
  state: string
  /** 用户原话，按轮次累积。每轮一条，不覆盖。 */
  readonly turns: Array<{
    /** 触发这一轮的飞书 message_id。 */
    messageId: string
    text: string
    at: string
    /** 这一轮是新建还是追加。 */
    kind: 'create' | 'append'
    /**
     * 调度模型从这一轮原话里推断的结构化提示。
     *
     * 挂在**轮次**上而不是工单上：追加轮的提示只对那一轮有效，
     * 挂工单会把上一轮的期望带到下一轮的 prompt 里。为空表示模型没抽到。
     */
    hint?: RequestHint | null
  }>
  /** 施工进度。run 期间覆盖更新；旧工单没有这个字段。 */
  progress?: TicketProgress | null
  /** 最近一次 run 的结论。状态回答与卡片用。 */
  result?: TicketResult | null
  /** 本单的工单分支（`ticket/T-00XX`）。2026-11-23 起每单一条。 */
  branch?: string | null
  /** 开工瞬间的主干 HEAD，用于追溯「这单从哪开始改的」。 */
  baseSha?: string | null
  /** 收尾时未提交残留的 stash ref（取证材料，不是候选代码）。 */
  stashRef?: string | null
  readonly createdAt: string
  updatedAt: string
}

/**
 * 施工进度的持久化形状。
 *
 * 为什么要落盘：一次 run 5–15 分钟，用户随时可能问进度；
 * 机器人进程若在中途重启，内存里的计数就没了，得能凭文件继续答。
 * 字段全部可选地冗余（filesChanged 只存数字），体积可控。
 */
export interface TicketProgress {
  /** 阶段字符串（progress.ts 的 RunPhase）。这里用 string 避免循环依赖。 */
  phase: string
  startedAt: string
  updatedAt: string
  toolCalls: number
  subagentCalls: number
  filesChanged: number
  lastAction: string | null
  lastText: string | null
}

/** 一次 run 的结果摘要。 */
export interface TicketResult {
  outcome: 'completed' | 'failed' | 'timeout'
  summary: string
  durationMs: number
  at: string
}


export interface StoreIndex {
  nextNo: number
}

export type StoreErrorCode = 'ticket-not-found' | 'corrupt-index' | 'no-number'

export class TicketStoreError extends Error {
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'TicketStoreError'
    this.code = code
  }
}

/** 原子写：同目录临时文件 + rename。 */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** 短号格式化：1 → T-0001。补到四位，够用到 9999 张。 */
export function formatTicketNo(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new TicketStoreError('no-number', `invalid ticket number: ${n}`)
  }
  return `T-${String(n).padStart(4, '0')}`
}

/** 从短号反解数字，用于排序。解析不出来返回 0。 */
export function parseTicketNo(no: string): number {
  const match = /^T-(\d+)$/.exec(no)
  return match ? Number(match[1]) : 0
}

export class TicketStore {
  private readonly dir: string
  private readonly indexPath: string
  private readonly byCardPath: string

  constructor(dir: string) {
    this.dir = dir
    this.indexPath = join(dir, 'index.json')
    this.byCardPath = join(dir, 'by-card.json')
    mkdirSync(dir, { recursive: true })
  }

  private ticketPath(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  /** 读或初始化索引。 */
  private index(): StoreIndex {
    const existing = readJson<StoreIndex>(this.indexPath)
    if (existing === null) {
      const fresh: StoreIndex = { nextNo: 1 }
      writeJsonAtomic(this.indexPath, fresh)
      return fresh
    }
    if (!Number.isSafeInteger(existing.nextNo) || existing.nextNo < 1) {
      // 索引损坏时不能静默从 1 重来：那会让新工单占用已存在的短号。
      throw new TicketStoreError('corrupt-index', `index.json nextNo invalid: ${String(existing.nextNo)}`)
    }
    return existing
  }

  /** 分配下一个短号并持久化。 */
  private allocateNo(): string {
    const index = this.index()
    const no = formatTicketNo(index.nextNo)
    writeJsonAtomic(this.indexPath, { nextNo: index.nextNo + 1 })
    return no
  }

  /**
   * 新建工单。
   *
   * `id` 由 message_id 派生而不是纯随机 uuid：这样同一条飞书消息即使 handler 被并发调用两次，
   * 落盘的也是同一个文件，不会产生两张工单。
   */
  create(input: {
    messageId: string
    chatId: string
    text: string
    at: string
    state: string
    hint?: RequestHint | null
  }): StoredTicket {
    const id = `tk_${createHash('sha256').update(input.messageId).digest('hex').slice(0, 24)}`
    const existing = this.get(id)
    if (existing !== null) return existing

    const ticket: StoredTicket = {
      id,
      no: this.allocateNo(),
      chatId: input.chatId,
      cardMessageId: null,
      sessionId: null,
      state: input.state,
      turns: [
        {
          messageId: input.messageId,
          text: input.text,
          at: input.at,
          kind: 'create',
          hint: input.hint ?? null,
        },
      ],
      createdAt: input.at,
      updatedAt: input.at,
    }
    writeJsonAtomic(this.ticketPath(id), ticket)
    return ticket
  }

  get(id: string): StoredTicket | null {
    return readJson<StoredTicket>(this.ticketPath(id))
  }

  getByNo(no: string): StoredTicket | null {
    return this.all().find((ticket) => ticket.no === no) ?? null
  }

  all(): StoredTicket[] {
    return readdirSync(this.dir)
      .filter((name) => name.startsWith('tk_') && name.endsWith('.json'))
      .map((name) => readJson<StoredTicket>(join(this.dir, name)))
      .filter((ticket): ticket is StoredTicket => ticket !== null)
      .sort((left, right) => parseTicketNo(left.no) - parseTicketNo(right.no))
  }

  /** 按卡片 message_id 反查工单。「回复卡片 = 追加」只用这个入口。 */
  findByCard(cardMessageId: string): StoredTicket | null {
    const map = readJson<Record<string, string>>(this.byCardPath) ?? {}
    const id = map[cardMessageId]
    return id === undefined ? null : this.get(id)
  }

  /** 记录主卡片的 message_id，建立反查关系。 */
  bindCard(id: string, cardMessageId: string, at: string): StoredTicket {
    const ticket = this.get(id)
    if (ticket === null) throw new TicketStoreError('ticket-not-found', id)

    const map = readJson<Record<string, string>>(this.byCardPath) ?? {}
    map[cardMessageId] = id
    writeJsonAtomic(this.byCardPath, map)

    const next: StoredTicket = { ...ticket, cardMessageId, updatedAt: at }
    writeJsonAtomic(this.ticketPath(id), next)
    return next
  }

  /** 记录 DSH 会话 id。只在首轮跑完时写一次。 */
  bindSession(id: string, sessionId: string, at: string): StoredTicket {
    const ticket = this.get(id)
    if (ticket === null) throw new TicketStoreError('ticket-not-found', id)
    const next: StoredTicket = { ...ticket, sessionId, updatedAt: at }
    writeJsonAtomic(this.ticketPath(id), next)
    return next
  }

  /** 记录或更新施工进度。run 期间按节流频率调用。 */
  setProgress(id: string, progress: TicketProgress, at: string): StoredTicket {
    const ticket = this.get(id)
    if (ticket === null) throw new TicketStoreError('ticket-not-found', id)
    const next: StoredTicket = { ...ticket, progress, updatedAt: at }
    writeJsonAtomic(this.ticketPath(id), next)
    return next
  }

  /** 记录最近一次 run 的结论。 */
  setResult(id: string, result: TicketResult, at: string): StoredTicket {
    const ticket = this.get(id)
    if (ticket === null) throw new TicketStoreError('ticket-not-found', id)
    const next: StoredTicket = { ...ticket, result, updatedAt: at }
    writeJsonAtomic(this.ticketPath(id), next)
    return next
  }

  /**
   * 追加一轮。用于「回复卡片提出改进」。
   * 不改 state，由调用方决定推进到哪一态。
   */
  appendTurn(
    id: string,
    input: { messageId: string; text: string; at: string; hint?: RequestHint | null },
  ): StoredTicket {
    const ticket = this.get(id)
    if (ticket === null) throw new TicketStoreError('ticket-not-found', id)
    const next: StoredTicket = {
      ...ticket,
      turns: [
        ...ticket.turns,
        {
          messageId: input.messageId,
          text: input.text,
          at: input.at,
          kind: 'append',
          hint: input.hint ?? null,
        },
      ],
      updatedAt: input.at,
    }
    writeJsonAtomic(this.ticketPath(id), next)
    return next
  }

  /** 记录本单的工单分支与基线。开工时写一次。 */
  setBranch(id: string, branch: string, baseSha: string, at: string): StoredTicket {
    const ticket = this.get(id)
    if (ticket === null) throw new TicketStoreError('ticket-not-found', id)
    const next: StoredTicket = { ...ticket, branch, baseSha, updatedAt: at }
    writeJsonAtomic(this.ticketPath(id), next)
    return next
  }

  /** 记录收尾 stash 的 ref。没有残留时不调用。 */
  setStash(id: string, stashRef: string, at: string): StoredTicket {
    const ticket = this.get(id)
    if (ticket === null) throw new TicketStoreError('ticket-not-found', id)
    const next: StoredTicket = { ...ticket, stashRef, updatedAt: at }
    writeJsonAtomic(this.ticketPath(id), next)
    return next
  }

  setState(id: string, state: string, at: string): StoredTicket {
    const ticket = this.get(id)
    if (ticket === null) throw new TicketStoreError('ticket-not-found', id)
    const next: StoredTicket = { ...ticket, state, updatedAt: at }
    writeJsonAtomic(this.ticketPath(id), next)
    return next
  }
}

/** 生成新工单的 uuid（当前 create 用 message_id 派生，此函数留给需要纯随机 id 的场景）。 */
export function newTicketUuid(): string {
  return randomUUID()
}
