/**
 * 飞书 REST 传输实现。只用 Node 内置 fetch，不引入官方 SDK。
 *
 * 为什么不装 @larksuiteoapi/node-sdk：
 * ticket-agent 放在 tools/ 而不是 apps/，就是为了不成为 workspace 成员，
 * 从而不改 package-lock.json。生产部署走 `npm ci`，lockfile 一变，
 * 生产构建就要重新解析全部依赖 —— 为了两个 HTTP 调用付这个代价不值得。
 * 官方 SDK 的价值主要在长连接的 wss 管理，那部分由 ws 包承担，见 feishu-ws.ts。
 *
 * 这里的接口口径来自 docs/design/feishu-bot-integration-facts-2026-11-13.md：
 *   - tenant_access_token: POST /open-apis/auth/v3/tenant_access_token/internal
 *   - 发消息:              POST /open-apis/im/v1/messages?receive_id_type=chat_id
 *   - 回复消息:            POST /open-apis/im/v1/messages/:message_id/reply
 *   - 更新卡片:            PATCH /open-apis/im/v1/messages/:message_id
 */

import type { FeishuCard, FeishuMessageRef, FeishuTransport } from './feishu-transport.ts'
import { toCardJson } from './feishu-transport.ts'

export interface FeishuRestOptions {
  appId: string
  appSecret: string
  /** 国内版 open.feishu.cn；国际版 open.larksuite.com。 */
  baseUrl?: string
  /** 注入用，测试时替换。 */
  fetchImpl?: typeof fetch
  /** 注入用，避免测试等待真实时间。 */
  now?: () => number
}

interface TokenState {
  token: string
  /** 过期时刻（毫秒）。飞书给 7200 秒，这里提前 5 分钟换。 */
  expiresAt: number
}

const DEFAULT_BASE = 'https://open.feishu.cn'
/** 提前换新的余量：飞书在剩余 30 分钟内会返回新 token，这里取 5 分钟更保守。 */
const REFRESH_AHEAD_MS = 5 * 60 * 1000

export class FeishuApiError extends Error {
  readonly code: number
  readonly path: string

  constructor(path: string, code: number, message: string) {
    super(`feishu ${path} failed: code=${code} ${message}`)
    this.name = 'FeishuApiError'
    this.code = code
    this.path = path
  }
}

export class FeishuRestTransport implements FeishuTransport {
  private readonly opts: Required<Pick<FeishuRestOptions, 'appId' | 'appSecret' | 'baseUrl'>>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private tokenState: TokenState | null = null

  constructor(options: FeishuRestOptions) {
    this.opts = {
      appId: options.appId,
      appSecret: options.appSecret,
      baseUrl: options.baseUrl ?? DEFAULT_BASE,
    }
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  /** 取 tenant_access_token，带缓存。 */
  async tenantToken(): Promise<string> {
    const current = this.tokenState
    if (current !== null && this.now() < current.expiresAt - REFRESH_AHEAD_MS) {
      return current.token
    }

    const response = await this.fetchImpl(
      `${this.opts.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }),
      },
    )
    const body = (await response.json()) as {
      code?: number
      msg?: string
      tenant_access_token?: string
      expire?: number
    }
    if (body.code !== 0 || typeof body.tenant_access_token !== 'string') {
      throw new FeishuApiError('/auth/v3/tenant_access_token/internal', body.code ?? -1, body.msg ?? 'no token')
    }

    const ttlMs = (body.expire ?? 7200) * 1000
    this.tokenState = { token: body.tenant_access_token, expiresAt: this.now() + ttlMs }
    return body.tenant_access_token
  }

  private async authorized(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const token = await this.tenantToken()
    const response = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    })
    const body = (await response.json()) as { code?: number; msg?: string; data?: unknown }
    if (body.code !== 0) {
      throw new FeishuApiError(path, body.code ?? -1, body.msg ?? 'unknown')
    }
    return body as Record<string, unknown>
  }

  async sendText(chatId: string, text: string): Promise<FeishuMessageRef> {
    const body = await this.authorized('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    })
    return { messageId: extractMessageId(body) }
  }

  async sendCard(chatId: string, card: FeishuCard): Promise<FeishuMessageRef> {
    const body = await this.authorized('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(toCardJson(card)),
      }),
    })
    return { messageId: extractMessageId(body) }
  }

  async updateCard(messageId: string, card: FeishuCard): Promise<void> {
    await this.authorized(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ content: JSON.stringify(toCardJson(card)) }),
    })
  }

  async replyText(messageId: string, text: string): Promise<FeishuMessageRef> {
    const body = await this.authorized(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: 'POST',
        body: JSON.stringify({
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      },
    )
    return { messageId: extractMessageId(body) }
  }
}

function extractMessageId(body: Record<string, unknown>): string {
  const data = body.data as { message_id?: unknown } | undefined
  const id = data?.message_id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('feishu response missing data.message_id')
  }
  return id
}
