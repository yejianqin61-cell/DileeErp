import assert from 'node:assert/strict'
import test from 'node:test'

import { handleModelRelayRequest, readModelRelayConfig } from '../src/model-relay.ts'

test('maps the local DeepSeek key alias without exposing it', () => {
  assert.deepEqual(readModelRelayConfig({ DEEPSEEK_KEY: 'upstream', DILEE_MODEL_RELAY_TOKEN: 'relay' }), {
    upstreamKey: 'upstream', relayToken: 'relay',
  })
  assert.throws(() => readModelRelayConfig({ DILEE_MODEL_RELAY_TOKEN: 'relay' }), /UPSTREAM_KEY_REQUIRED/)
})

test('forwards only the authorized fixed model path', async () => {
  let forwarded = false
  const result = await handleModelRelayRequest({
    method: 'POST', path: '/v1/chat/completions', apiKey: 'relay', body: new TextEncoder().encode('{}'),
    config: { upstreamKey: 'upstream', relayToken: 'relay' },
    forward: async request => { forwarded = request.upstreamAuthorization === 'Bearer upstream'; return new Response('{}') },
  })
  assert.equal(result.status, 200); assert.equal(forwarded, true)
})

test('rejects wrong token, path, method, and oversized bodies before forwarding', async () => {
  const request = { config: { upstreamKey: 'upstream', relayToken: 'relay' }, forward: async () => new Response('{}') }
  assert.equal((await handleModelRelayRequest({ ...request, method: 'GET', path: '/v1/chat/completions', body: new Uint8Array(), authorization: 'Bearer relay' })).status, 405)
  assert.equal((await handleModelRelayRequest({ ...request, method: 'POST', path: '/anything', body: new Uint8Array(), authorization: 'Bearer relay' })).status, 404)
  assert.equal((await handleModelRelayRequest({ ...request, method: 'POST', path: '/v1/chat/completions', body: new Uint8Array(), authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await handleModelRelayRequest({ ...request, method: 'POST', path: '/v1/chat/completions', body: new Uint8Array(256 * 1024 + 1), authorization: 'Bearer relay' })).status, 413)
})

test('serves only the fixed model catalog to an authorized SDK client', async () => {
  const response = await handleModelRelayRequest({
    method: 'GET', path: '/v1/models', apiKey: 'relay', body: new Uint8Array(),
    config: { upstreamKey: 'upstream', relayToken: 'relay' }, forward: async () => new Response('{}'),
  })
  assert.deepEqual(await response.json(), { object: 'list', data: [{ id: 'deepseek-chat', object: 'model' }] })
})
