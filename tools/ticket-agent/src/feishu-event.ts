/**
 * 飞书消息事件解析。
 *
 * 只做一件事：把 `im.message.receive_v1` 的事件体变成本系统关心的最小结构。
 * 不在这里判断「要不要开工」，那是 ticket-flow 的事。
 *
 * 口径来源：docs/design/feishu-bot-integration-facts-2026-11-13.md §3。
 * 关键事实：
 *   - `event.message.content` 是 **JSON 序列化后的字符串**，不是对象；
 *   - 文本消息的形状是 `{"text":"..."}`；
 *   - 群聊里 @机器人 会在 text 里留下 `@_user_1` 占位符，靠 `mentions[].key` 对应；
 *   - `mentions[].id.open_id` 与机器人自身 open_id 相同即表示 @ 了机器人；
 *   - 机器人自己发的消息不会推给自己，但仍然显式过滤 `sender_type === 'bot'` 兜底。
 */

export interface IncomingMessage {
  /** 幂等键。官方要求用 message_id 去重，不要依赖 event_id。 */
  readonly messageId: string
  readonly chatId: string
  /** 群聊或单聊。当前只处理群聊。 */
  readonly chatType: 'group' | 'p2p'
  readonly senderOpenId: string
  readonly senderType: string
  /** 去掉 @占位符之后的正文字。 */
  readonly text: string
  /** 是否 @ 了本机器人。仅凭 mentions 判定。 */
  readonly mentionsBot: boolean
  /** 飞书给的事件 id，只用于投递计数，不做幂等。 */
  readonly eventId: string | null
  /** 毫秒时间戳字符串。 */
  readonly createTime: string | null
  /** 原消息是否为话题回复。 */
  readonly threadId: string | null
  /**
   * 被回复消息的 id。仅在「回复某条消息」时有值。
   * 这是「追加到已有工单」的唯一判定依据：它等于某工单的 cardMessageId。
   */
  readonly parentId: string | null
  /** 话题根消息 id。话题回复时也有值。 */
  readonly rootId: string | null
}

export type ParseOutcome =
  | { kind: 'message'; message: IncomingMessage }
  | { kind: 'ignored'; reason: IgnoreReason }

export type IgnoreReason =
  | 'not-a-message-event'
  | 'unsupported-message-type'
  | 'from-bot'
  | 'not-a-group'
  | 'bot-not-mentioned'
  | 'empty-text'

export interface RawFeishuEvent {
  schema?: string
  header?: {
    event_id?: string
    event_type?: string
    create_time?: string
    app_id?: string
  }
  event?: {
    sender?: {
      sender_id?: { open_id?: string }
      sender_type?: string
    }
    message?: {
      message_id?: string
      chat_id?: string
      chat_type?: string
      message_type?: string
      content?: string
      mentions?: Array<{
        key?: string
        id?: { open_id?: string }
        name?: string
        mentioned_type?: string
      }>
      thread_id?: string
      /** 被回复消息的 id（回复场景）。 */
      parent_id?: string
      /** 话题根消息 id。 */
      root_id?: string
      create_time?: string
    }
  }
}

export interface ParseOptions {
  /** 本机器人的 open_id，用来判断 mentions 里有没有自己。 */
  botOpenId: string
  /** 允许单聊。默认 false：群机器人只处理群消息。 */
  allowP2p?: boolean
}

/**
 * 解析事件。返回 `ignored` 是常态，不是错误 ——
 * 大部分群消息都不是给机器人的，把它们当失败会让日志淹掉。
 */
export function parseIncoming(raw: RawFeishuEvent, options: ParseOptions): ParseOutcome {
  if (raw.header?.event_type !== 'im.message.receive_v1') {
    return { kind: 'ignored', reason: 'not-a-message-event' }
  }

  const message = raw.event?.message
  if (!message?.message_id || !message.chat_id) {
    return { kind: 'ignored', reason: 'not-a-message-event' }
  }

  if (message.message_type !== 'text') {
    return { kind: 'ignored', reason: 'unsupported-message-type' }
  }

  const senderType = raw.event?.sender?.sender_type ?? 'unknown'
  if (senderType === 'bot') {
    return { kind: 'ignored', reason: 'from-bot' }
  }

  const chatType = message.chat_type === 'p2p' ? 'p2p' : 'group'
  if (chatType === 'p2p' && options.allowP2p !== true) {
    return { kind: 'ignored', reason: 'not-a-group' }
  }

  const mentions = message.mentions ?? []
  const mentionsBot = mentions.some(
    (mention) => mention.id?.open_id === options.botOpenId || mention.mentioned_type === 'bot',
  )
  // 群聊里没 @ 机器人就不处理：只有 @ 的消息才是给它的。
  if (chatType === 'group' && !mentionsBot) {
    return { kind: 'ignored', reason: 'bot-not-mentioned' }
  }

  const text = extractText(message.content, mentions)
  if (text.trim().length === 0) {
    return { kind: 'ignored', reason: 'empty-text' }
  }

  return {
    kind: 'message',
    message: {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType,
      senderOpenId: raw.event?.sender?.sender_id?.open_id ?? '',
      senderType,
      text,
      mentionsBot,
      eventId: raw.header?.event_id ?? null,
      createTime: message.create_time ?? null,
      threadId: message.thread_id ?? null,
      parentId: message.parent_id ?? null,
      rootId: message.root_id ?? null,
    },
  }
}

/**
 * 从 content 里取正文。
 *
 * content 是字符串化的 JSON。解析失败不抛错，返回空串让上层按 `empty-text` 忽略 ——
 * 一条畸形消息不该让整个长连接崩掉。
 *
 * @占位符处理：把 `@_user_1` 这类 key 从正文里去掉，避免模块识别被噪声干扰。
 * 注意只删 mentions 里真实存在的 key，不盲删所有 `@`，因为用户可能真的在说邮箱。
 */
export function extractText(
  content: string | undefined,
  mentions: ReadonlyArray<{ key?: string }> = [],
): string {
  if (!content) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return ''
  }
  if (typeof parsed !== 'object' || parsed === null) return ''
  const text = (parsed as { text?: unknown }).text
  if (typeof text !== 'string') return ''

  let clean = text
  for (const mention of mentions) {
    if (typeof mention.key === 'string' && mention.key.length > 0) {
      clean = clean.split(mention.key).join(' ')
    }
  }
  return clean.replace(/[ \t]+/g, ' ').trim()
}
