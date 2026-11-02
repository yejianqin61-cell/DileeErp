export const MODEL_RELAY_PATH = '/v1/chat/completions'
const MAX_BODY_BYTES = 256 * 1024

export interface ModelRelayConfig {
  upstreamKey: string
  relayToken: string
}

export function readModelRelayConfig(environment: NodeJS.ProcessEnv): ModelRelayConfig {
  const upstreamKey = environment.DEEPSEEK_API_KEY ?? environment.DEEPSEEK_KEY
  const relayToken = environment.DILEE_MODEL_RELAY_TOKEN
  if (!upstreamKey) throw new Error('MODEL_RELAY_UPSTREAM_KEY_REQUIRED')
  if (!relayToken) throw new Error('MODEL_RELAY_TOKEN_REQUIRED')
  return { upstreamKey, relayToken }
}

export async function handleModelRelayRequest(input: {
  method: string
  path: string
  authorization?: string
  apiKey?: string
  body: Uint8Array
  config: ModelRelayConfig
  forward(request: { body: Uint8Array; upstreamAuthorization: string }): Promise<Response>
}): Promise<Response> {
  if (input.method !== 'POST') return new Response(null, { status: 405 })
  if (input.path !== MODEL_RELAY_PATH) return new Response(null, { status: 404 })
  if (input.authorization !== `Bearer ${input.config.relayToken}` && input.apiKey !== input.config.relayToken) {
    return new Response(null, { status: 401 })
  }
  if (input.body.byteLength > MAX_BODY_BYTES) return new Response(null, { status: 413 })
  return input.forward({ body: input.body, upstreamAuthorization: `Bearer ${input.config.upstreamKey}` })
}
import { createServer } from 'node:http'


export async function startModelRelay(config: ModelRelayConfig): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const result = await handleModelRelayRequest({
      method: request.method ?? '', path: request.url ?? '', authorization: request.headers.authorization,
      apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined,
      body: Buffer.concat(chunks), config,
      forward: ({ body, upstreamAuthorization }) => fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', headers: { authorization: upstreamAuthorization, 'content-type': 'application/json' }, body,
      }),
    })
    const headers = Object.fromEntries([...result.headers.entries()].filter(([name]) =>
      name !== 'content-encoding' && name !== 'content-length'))
    response.writeHead(result.status, headers)
    response.end(Buffer.from(await result.arrayBuffer()))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('MODEL_RELAY_LISTEN_FAILED')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}
