import assert from 'node:assert/strict'
import test from 'node:test'

import { extractText, parseIncoming, type RawFeishuEvent } from '../src/feishu-event.ts'

const BOT = 'ou_bot_self'

function event(overrides: {
  messageId?: string
  text?: string
  chatType?: string
  messageType?: string
  senderType?: string
  mentions?: Array<{ key?: string; id?: { open_id?: string }; mentioned_type?: string }>
  eventType?: string
} = {}): RawFeishuEvent {
  return {
    schema: '2.0',
    header: {
      event_id: 'ev_1',
      event_type: overrides.eventType ?? 'im.message.receive_v1',
      create_time: '1762500000000',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_user_1' },
        sender_type: overrides.senderType ?? 'user',
      },
      message: {
        message_id: overrides.messageId ?? 'om_1',
        chat_id: 'oc_chat_1',
        chat_type: overrides.chatType ?? 'group',
        message_type: overrides.messageType ?? 'text',
        content: JSON.stringify({ text: overrides.text ?? '采购单列表页报错，应该能显示' }),
        mentions: overrides.mentions ?? [
          { key: '@_user_1', id: { open_id: BOT }, mentioned_type: 'bot' },
        ],
        create_time: '1762500000000',
      },
    },
  }
}

test('正常 @机器人 的文本消息被解析出来', () => {
  const outcome = parseIncoming(
    event({ text: '@_user_1 采购单列表页的搜索框，希望能按供应商搜' }),
    { botOpenId: BOT },
  )
  assert.equal(outcome.kind, 'message')
  if (outcome.kind !== 'message') return
  assert.equal(outcome.message.messageId, 'om_1')
  assert.equal(outcome.message.chatId, 'oc_chat_1')
  assert.equal(outcome.message.chatType, 'group')
  assert.equal(outcome.message.mentionsBot, true)
  assert.equal(outcome.message.text, '采购单列表页的搜索框，希望能按供应商搜')
})

test('没有 @机器人 的群消息被忽略', () => {
  const outcome = parseIncoming(
    event({ mentions: [{ key: '@_user_1', id: { open_id: 'ou_someone_else' } }] }),
    { botOpenId: BOT },
  )
  assert.equal(outcome.kind, 'ignored')
  if (outcome.kind === 'ignored') assert.equal(outcome.reason, 'bot-not-mentioned')
})

test('机器人自己发的消息被忽略，即使 @ 了自己', () => {
  const outcome = parseIncoming(event({ senderType: 'bot' }), { botOpenId: BOT })
  assert.equal(outcome.kind, 'ignored')
  if (outcome.kind === 'ignored') assert.equal(outcome.reason, 'from-bot')
})

test('非文本消息被忽略', () => {
  const outcome = parseIncoming(event({ messageType: 'image' }), { botOpenId: BOT })
  assert.equal(outcome.kind, 'ignored')
  if (outcome.kind === 'ignored') assert.equal(outcome.reason, 'unsupported-message-type')
})

test('单聊默认忽略，显式允许后才处理', () => {
  const raw = event({ chatType: 'p2p', mentions: [] })
  const ignored = parseIncoming(raw, { botOpenId: BOT })
  assert.equal(ignored.kind, 'ignored')
  const allowed = parseIncoming(raw, { botOpenId: BOT, allowP2p: true })
  assert.equal(allowed.kind, 'message')
})

test('事件类型不符直接忽略', () => {
  const outcome = parseIncoming(event({ eventType: 'im.chat.updated_v1' }), { botOpenId: BOT })
  assert.equal(outcome.kind, 'ignored')
  if (outcome.kind === 'ignored') assert.equal(outcome.reason, 'not-a-message-event')
})

test('空正文被忽略', () => {
  const outcome = parseIncoming(event({ text: '   ' }), { botOpenId: BOT })
  assert.equal(outcome.kind, 'ignored')
  if (outcome.kind === 'ignored') assert.equal(outcome.reason, 'empty-text')
})

test('content 是畸形 JSON 时不抛错，按空正文忽略', () => {
  const raw = event()
  if (raw.event?.message) raw.event.message.content = '{not json'
  const outcome = parseIncoming(raw, { botOpenId: BOT })
  assert.equal(outcome.kind, 'ignored')
  if (outcome.kind === 'ignored') assert.equal(outcome.reason, 'empty-text')
})

test('extractText 只删 mentions 里真实存在的占位符，不误删真 @', () => {
  const text = extractText(
    JSON.stringify({ text: '@_user_1 请发到 a@b.com' }),
    [{ key: '@_user_1' }],
  )
  assert.equal(text, '请发到 a@b.com')
})

test('mentioned_type=bot 但 open_id 不匹配时仍算 @ 了机器人', () => {
  const outcome = parseIncoming(
    event({ mentions: [{ key: '@_user_1', id: { open_id: 'ou_other' }, mentioned_type: 'bot' }] }),
    { botOpenId: BOT },
  )
  assert.equal(outcome.kind, 'message')
  if (outcome.kind === 'message') assert.equal(outcome.message.mentionsBot, true)
})
