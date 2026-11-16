/**
 * 飞书传输层契约。
 *
 * 为什么要有接口而不是直接调 fetch：
 * 生产环境是长连接 + 真 API，测试环境必须能在**没有网络、没有凭据**的机器上跑。
 * 如果 ticket-agent 直接持有 fetch，分诊和状态机的测试就会变成「需要飞书账号才能跑」，
 * 那样的测试最终一定会被跳过 —— 而跳过的测试等于没有。
 *
 * 所以这里把「发消息」和「更新卡片」抽成最窄的两个方法。
 * 真实实现见 feishu-rest.ts，测试实现见 feishu-fake.ts。
 */

export interface FeishuMessageRef {
  /** 发送成功后飞书返回的 message_id，更新卡片时要用它。 */
  readonly messageId: string
}

export interface FeishuTransport {
  /** 发一条文本消息到群。 */
  sendText(chatId: string, text: string): Promise<FeishuMessageRef>
  /** 发一张卡片到群。 */
  sendCard(chatId: string, card: FeishuCard): Promise<FeishuMessageRef>
  /** 原地更新一张已发出的卡片。 */
  updateCard(messageId: string, card: FeishuCard): Promise<void>
  /** 回复某条消息（引用原文），用于让对话有上下文。 */
  replyText(messageId: string, text: string): Promise<FeishuMessageRef>
}

/**
 * 卡片的最小结构。
 *
 * 只支持「标题 + 若干行文本 + 颜色」，不追求富交互。
 * 理由：卡片 JSON 的完整 schema 很大，但工单场景真正需要的只是「一眼看出状态」。
 * 按钮回调需要单独的 card.action.trigger 订阅，属于后续阶段。
 */
export interface FeishuCard {
  /** 卡片标题。 */
  readonly title: string
  /** 标题左侧色条：决定一眼看出来的状态。 */
  readonly template: CardTemplate
  /** 正文行。每行一条事实。 */
  readonly lines: readonly string[]
  /** 可选脚注，放工单号与时间这类审计信息。 */
  readonly footer?: string
}

/**
 * 飞书卡片模板色。只保留工单真正用到的六种，避免调用方随手选一个没含义的颜色。
 * 语义固定：蓝=进行中、绿=成功、橙=等待人、红=失败、灰=已结束、紫=需人工。
 */
export type CardTemplate = 'blue' | 'green' | 'orange' | 'red' | 'grey' | 'purple'

/** 卡片 JSON 的构造。纯函数，可单测，不依赖传输层。 */
export function toCardJson(card: FeishuCard): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = card.lines.map((line) => ({
    tag: 'div',
    text: { tag: 'lark_md', content: line },
  }))
  if (card.footer !== undefined) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: card.footer }],
    })
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      template: card.template,
      title: { tag: 'plain_text', content: card.title },
    },
    elements,
  }
}
