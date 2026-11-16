/**
 * 工单流程：把「收到消息」串到「回一张卡片」。
 *
 * 这一层的职责边界很窄，因为它是唯一同时碰「状态」和「网络」的地方：
 *   - 状态迁移全部委托给 TicketRegistry；
 *   - 分诊委托给 triage；
 *   - 网络委托给 FeishuTransport。
 * 它自己只做顺序编排和话术，这样任何一段逻辑出错都能在单测里定位到具体一层。
 */

import type { FeishuTransport, FeishuCard } from './feishu-transport.ts'
import { parseIncoming, type RawFeishuEvent } from './feishu-event.ts'
import { askForMissing, triage } from './triage.ts'
import {
  TicketError,
  TicketRegistry,
  isTerminal,
  type Ticket,
  type TicketState,
} from './ticket-state.ts'

export interface FlowOptions {
  botOpenId: string
  /** 记录事件。默认 console，测试时替换。 */
  log?: (line: string) => void
  /** 取当前时间。测试时固定，避免断言里出现真实时间。 */
  now?: () => Date
}

/** 停止口令。单独一行、无其他内容才算，避免「停止按钮做不了」误触发。 */
const STOP_COMMANDS = new Set(['停止', 'stop', '/stop', '暂停'])

export interface HandlerResult {
  /** 处理结果，用于日志与测试断言。 */
  readonly outcome:
    | 'ignored'
    | 'created'
    | 'duplicate'
    | 'needs-info'
    | 'queued'
    | 'stopped'
    | 'error'
  readonly reason?: string
  readonly ticketId?: string
  readonly state?: TicketState
}

/**
 * 事件处理器。
 *
 * 每次调用处理**一条**飞书事件。长连接会并发回调，所以这里不做全局锁：
 * 幂等靠 message_id，最终一致性靠状态机拒绝非法迁移。
 * 真正的串行在调度器那一层（同一批次只跑一个工单），不在这里。
 */
export class TicketFlow {
  private readonly transport: FeishuTransport
  private readonly registry: TicketRegistry
  private readonly botOpenId: string
  private readonly logSink: (line: string) => void
  private readonly nowFn: () => Date
  private stopped = false

  constructor(transport: FeishuTransport, registry: TicketRegistry, options: FlowOptions) {
    this.transport = transport
    this.registry = registry
    this.botOpenId = options.botOpenId
    this.logSink = options.log ?? ((line) => console.log(line))
    this.nowFn = options.now ?? (() => new Date())
  }

  private log(line: string): void {
    this.logSink(`[ticket] ${line}`)
  }

  private timestamp(): string {
    return this.nowFn().toISOString()
  }

  /** 停止：清空后续入队。已上线的版本不回退（那是回滚的事，不是停止的事）。 */
  requestStop(): void {
    this.stopped = true
  }

  isStopped(): boolean {
    return this.stopped
  }

  async handleRaw(raw: RawFeishuEvent): Promise<HandlerResult> {
    // 先解析，再判重：解析失败的消息不该进幂等表，否则一条畸形消息会永久占住一个 message_id。
    const parsed = parseIncoming(raw, { botOpenId: this.botOpenId })
    if (parsed.kind === 'ignored') {
      this.log(`ignored reason=${parsed.reason}`)
      return { outcome: 'ignored', reason: parsed.reason }
    }

    const { message } = parsed

    // 停止口令最先处理，且不受幂等影响：重投一次停止指令仍然应该停。
    if (this.isStopCommand(message.text)) {
      this.requestStop()
      this.log(`stopped by ${message.senderOpenId}`)
      await this.transport.sendText(message.chatId, '已停止：队列已清空，后续工单不再开工。')
      return { outcome: 'stopped' }
    }

    const { ticket, created } = this.registry.receive({
      messageId: message.messageId,
      chatId: message.chatId,
      senderOpenId: message.senderOpenId,
      text: message.text,
      at: this.timestamp(),
    })

    if (!created) {
      // 重投：静默丢弃。不发卡、不回话，避免群里出现重复气泡。
      this.log(`duplicate message_id=${message.messageId} state=${ticket.state}`)
      return { outcome: 'duplicate', ticketId: ticket.id, state: ticket.state }
    }

    this.log(`created ${ticket.id} text=${JSON.stringify(ticket.text.slice(0, 60))}`)

    try {
      return await this.triageAndReply(ticket)
    } catch (error) {
      // 未知错误不能让长连接崩掉：落 failed 并回一张卡片，然后正常返回。
      const detail = error instanceof Error ? error.message : String(error)
      this.log(`error ${ticket.id}: ${detail}`)
      try {
        this.registry.transition(ticket.id, 'failed', this.timestamp(), detail)
        await this.transport.sendCard(ticket.chatId, this.cardFor(ticket, detail))
      } catch (secondary) {
        this.log(`error while reporting failure: ${String(secondary)}`)
      }
      return { outcome: 'error', reason: detail, ticketId: ticket.id, state: ticket.state }
    }
  }

  private isStopCommand(text: string): boolean {
    return STOP_COMMANDS.has(text.trim().toLowerCase())
  }

  private async triageAndReply(ticket: Ticket): Promise<HandlerResult> {
    // 停止判定必须在分诊之前。
    // 否则「已停止」之后收到的新消息还会先被追问一句 —— 用户会觉得机器人没听懂「停止」。
    // 停止是运维动作，优先级高于任何业务判断。
    if (this.stopped) {
      this.registry.transition(ticket.id, 'failed', this.timestamp(), 'stopped')
      await this.transport.sendCard(ticket.chatId, this.cardFor(ticket, '已停止，未开工。'))
      return { outcome: 'stopped', ticketId: ticket.id, state: ticket.state }
    }

    const result = triage(ticket.text)
    this.registry.applyTriage(ticket.id, result, this.timestamp())

    if (result.missing.length > 0) {
      // 追问：用文本回复，且引用原消息，让用户知道说的是哪一条。
      await this.transport.replyText(ticket.messageId, askForMissing(result.missing))
      this.log(`${ticket.id} needs_info missing=${result.missing.join(',')}`)
      return { outcome: 'needs-info', ticketId: ticket.id, state: ticket.state }
    }

    // 分诊通过 → 入队。真正的入队动作交给调度器（Phase 3），这里只把状态推进到位并回卡。
    const queued = this.registry.transition(ticket.id, 'queued', this.timestamp(), 'triage ok')
    await this.transport.sendCard(ticket.chatId, this.cardFor(queued))
    this.log(`${ticket.id} queued module=${result.module}`)
    return { outcome: 'queued', ticketId: ticket.id, state: queued.state }
  }

  /** 按状态生成卡片。纯函数式：给定工单和附加说明，返回卡片。 */
  cardFor(ticket: Ticket, note?: string): FeishuCard {
    const lines: string[] = []
    if (ticket.triage) {
      lines.push(`**模块**：${ticket.triage.module ?? '未识别'}`)
      if (ticket.triage.expected) lines.push(`**期望**：${ticket.triage.expected}`)
      if (ticket.triage.entry) lines.push(`**入口**：${ticket.triage.entry}`)
    }
    lines.push(`**原话**：${ticket.text}`)
    if (note !== undefined) lines.push(`**说明**：${note}`)

    const { title, template } = cardHeadline(ticket)
    const footer = `${ticket.id}｜${ticket.state}｜${this.timestamp()}`
    return { title, template, lines, footer }
  }

  registrySnapshot(): readonly Ticket[] {
    return this.registry.all()
  }
}

/** 状态 → 卡片标题与色。集中在这里，避免各处硬编码颜色。 */
export function cardHeadline(ticket: Ticket): { title: string; template: FeishuCard['template'] } {
  const kind = ticket.triage?.summary.startsWith('缺陷') ? '缺陷' : '需求'
  switch (ticket.state) {
    case 'needs_info':
      return { title: `待补充信息｜${kind}`, template: 'orange' }
    case 'queued':
      return { title: `已受理，排队中｜${kind}`, template: 'blue' }
    case 'building':
      return { title: `正在改｜${kind}`, template: 'blue' }
    case 'gated':
      return { title: `测试中｜${kind}`, template: 'blue' }
    case 'deploying':
      return { title: `正在上线｜${kind}`, template: 'blue' }
    case 'done':
      return { title: `已上线｜${kind}`, template: 'green' }
    case 'rolled_back':
      return { title: `已回滚｜${kind}`, template: 'purple' }
    case 'failed':
      return { title: `未完成｜${kind}`, template: 'red' }
    case 'triaged':
    case 'received':
      return { title: `已收到｜${kind}`, template: 'grey' }
    default:
      return { title: `未知状态｜${kind}`, template: 'grey' }
  }
}

export { TicketError, isTerminal, type Ticket, type TicketState }
