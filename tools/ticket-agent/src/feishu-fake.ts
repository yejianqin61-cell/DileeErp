/**
 * 假传输：在没有任何飞书凭据的情况下跑完整流程测试。
 *
 * 它的价值不是「代替真环境」，而是让**去重、分诊、状态迁移、卡片内容**
 * 这四件事可以在 CI 和没有网络的机器上被断言。
 * 真连飞书只验证「网络与凭据」，不该是唯一验证业务逻辑的方式。
 */

import type {
  FeishuCard,
  FeishuMessageRef,
  FeishuTransport,
} from './feishu-transport.ts'

export interface SentRecord {
  readonly kind: 'text' | 'card' | 'reply' | 'update'
  readonly target: string
  readonly payload: string
  readonly card?: FeishuCard
}

export class FakeFeishuTransport implements FeishuTransport {
  readonly sent: SentRecord[] = []
  private counter = 0
  /** 注入失败：设为 true 时下一次 send 抛错，用于测错误路径。 */
  failNext = false

  private nextId(prefix: string): string {
    this.counter += 1
    return `om_fake_${prefix}_${this.counter}`
  }

  private guard(): void {
    if (this.failNext) {
      this.failNext = false
      throw new Error('fake transport failure (injected)')
    }
  }

  async sendText(chatId: string, text: string): Promise<FeishuMessageRef> {
    this.guard()
    this.sent.push({ kind: 'text', target: chatId, payload: text })
    return { messageId: this.nextId('text') }
  }

  async sendCard(chatId: string, card: FeishuCard): Promise<FeishuMessageRef> {
    this.guard()
    this.sent.push({ kind: 'card', target: chatId, payload: card.title, card })
    return { messageId: this.nextId('card') }
  }

  async updateCard(messageId: string, card: FeishuCard): Promise<void> {
    this.guard()
    this.sent.push({ kind: 'update', target: messageId, payload: card.title, card })
  }

  async replyText(messageId: string, text: string): Promise<FeishuMessageRef> {
    this.guard()
    this.sent.push({ kind: 'reply', target: messageId, payload: text })
    return { messageId: this.nextId('reply') }
  }

  /** 最近一条发出的记录，测试断言用。 */
  last(): SentRecord | undefined {
    return this.sent[this.sent.length - 1]
  }

  ofKind(kind: SentRecord['kind']): readonly SentRecord[] {
    return this.sent.filter((record) => record.kind === kind)
  }
}
