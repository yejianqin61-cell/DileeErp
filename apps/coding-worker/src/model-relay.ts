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
  body: Uint8Array
  config: ModelRelayConfig
  forward(request: { body: Uint8Array; upstreamAuthorization: string }): Promise<Response>
}): Promise<Response> {
  if (input.method !== 'POST') return new Response(null, { status: 405 })
  if (input.path !== MODEL_RELAY_PATH) return new Response(null, { status: 404 })
  if (input.authorization !== `Bearer ${input.config.relayToken}`) return new Response(null, { status: 401 })
  if (input.body.byteLength > MAX_BODY_BYTES) return new Response(null, { status: 413 })
  return input.forward({ body: input.body, upstreamAuthorization: `Bearer ${input.config.upstreamKey}` })
}
