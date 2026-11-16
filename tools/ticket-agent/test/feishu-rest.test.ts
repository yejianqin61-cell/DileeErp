import assert from 'node:assert/strict'
import test from 'node:test'

import { FeishuApiError, FeishuRestTransport } from '../src/feishu-rest.ts'
import { toCardJson } from '../src/feishu-transport.ts'

/**
 * REST 层的测试用假 fetch：断言请求形状，不碰网络。
 * 真连飞书只验证凭据可用，不该是唯一验证协议口径的方式。
 */

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function makeTransport(responder: (call: Call) => unknown, nowMs = 1_000_000) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const call: Call = { url, method: init?.method ?? 'GET', headers, body }
    calls.push(call)
    const payload = responder(call)
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as unknown as Response
  }) as unknown as typeof fetch

  const transport = new FeishuRestTransport({
    appId: 'cli_test',
    appSecret: 'secret_test',
    fetchImpl,
    now: () => nowMs,
  })
  return { transport, calls }
}

const tokenOk = { code: 0, tenant_access_token: 't-abc', expire: 7200 }

test('取 token 走具名接口，且用 app_id/app_secret 作 body', async () => {
  const { transport, calls } = makeTransport(() => tokenOk)
  const token = await transport.tenantToken()

  assert.equal(token, 't-abc')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.endsWith('/open-apis/auth/v3/tenant_access_token/internal'))
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].body, { app_id: 'cli_test', app_secret: 'secret_test' })
})

test('token 被缓存，第二次调用不再请求', async () => {
  const { transport, calls } = makeTransport(() => tokenOk)
  await transport.tenantToken()
  await transport.tenantToken()
  assert.equal(calls.length, 1)
})

test('发文本消息：路径带 receive_id_type=chat_id，content 是字符串化 JSON', async () => {
  const { transport, calls } = makeTransport((call) => {
    if (call.url.includes('tenant_access_token')) return tokenOk
    return { code: 0, data: { message_id: 'om_sent_1' } }
  })

  const ref = await transport.sendText('oc_chat', '你好')
  assert.equal(ref.messageId, 'om_sent_1')

  const send = calls.find((call) => call.url.includes('/im/v1/messages?'))
  assert.ok(send)
  assert.ok(send.url.includes('receive_id_type=chat_id'))
  assert.equal(send.method, 'POST')
  assert.equal(send.headers.authorization, 'Bearer t-abc')
  const body = send.body as { receive_id: string; msg_type: string; content: string }
  assert.equal(body.receive_id, 'oc_chat')
  assert.equal(body.msg_type, 'text')
  // 飞书要求 content 是字符串，不是对象
  assert.equal(typeof body.content, 'string')
  assert.deepEqual(JSON.parse(body.content), { text: '你好' })
})

test('发卡片：msg_type=interactive，content 为卡片 JSON 字符串', async () => {
  const { transport, calls } = makeTransport((call) => {
    if (call.url.includes('tenant_access_token')) return tokenOk
    return { code: 0, data: { message_id: 'om_card_1' } }
  })

  await transport.sendCard('oc_chat', {
    title: '已受理',
    template: 'blue',
    lines: ['**模块**：采购'],
    footer: 'T-1',
  })

  const send = calls.find((call) => call.url.includes('/im/v1/messages?'))
  const body = send!.body as { msg_type: string; content: string }
  assert.equal(body.msg_type, 'interactive')
  const card = JSON.parse(body.content) as {
    header: { template: string; title: { content: string } }
    elements: Array<{ tag: string }>
  }
  assert.equal(card.header.template, 'blue')
  assert.equal(card.header.title.content, '已受理')
  assert.ok(card.elements.some((element) => element.tag === 'div'))
  assert.ok(card.elements.some((element) => element.tag === 'note'))
})

test('回复消息走 /messages/:id/reply，不是发新消息', async () => {
  const { transport, calls } = makeTransport((call) => {
    if (call.url.includes('tenant_access_token')) return tokenOk
    return { code: 0, data: { message_id: 'om_reply_1' } }
  })

  await transport.replyText('om_orig', '请补充模块')
  const reply = calls.find((call) => call.url.includes('/reply'))
  assert.ok(reply)
  assert.ok(reply.url.includes('/im/v1/messages/om_orig/reply'))
  assert.equal(reply.method, 'POST')
})

test('更新卡片用 PATCH 打到消息本身', async () => {
  const { transport, calls } = makeTransport((call) => {
    if (call.url.includes('tenant_access_token')) return tokenOk
    return { code: 0, data: {} }
  })

  await transport.updateCard('om_card_1', {
    title: '已上线', template: 'green', lines: ['完成'],
  })
  const patch = calls.find((call) => call.method === 'PATCH')
  assert.ok(patch)
  assert.ok(patch.url.includes('/im/v1/messages/om_card_1'))
})

test('飞书返回非 0 code 时抛 FeishuApiError，带上 code 与路径', async () => {
  const { transport } = makeTransport((call) => {
    if (call.url.includes('tenant_access_token')) return tokenOk
    return { code: 230002, msg: 'bot not in chat' }
  })

  await assert.rejects(
    () => transport.sendText('oc_chat', 'x'),
    (error: unknown) =>
      error instanceof FeishuApiError && error.code === 230002 && error.path.includes('/im/v1/messages'),
  )
})

test('token 接口失败时抛错而不是返回空串', async () => {
  const { transport } = makeTransport(() => ({ code: 99991401, msg: 'ip not allowed' }))
  await assert.rejects(
    () => transport.tenantToken(),
    (error: unknown) => error instanceof FeishuApiError && error.code === 99991401,
  )
})

test('响应里没有 data.message_id 时报错，不返回 undefined', async () => {
  const { transport } = makeTransport((call) => {
    if (call.url.includes('tenant_access_token')) return tokenOk
    return { code: 0, data: {} }
  })
  await assert.rejects(() => transport.sendText('oc_chat', 'x'), /message_id/)
})

test('toCardJson 是纯函数：同样输入同样输出', () => {
  const card = { title: 'T', template: 'red' as const, lines: ['a', 'b'], footer: 'f' }
  assert.deepEqual(toCardJson(card), toCardJson(card))
})
