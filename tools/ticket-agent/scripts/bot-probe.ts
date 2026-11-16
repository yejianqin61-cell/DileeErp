/**
 * 飞书连通性探针：验证凭据可用、机器人身份可读、长连接能建立、消息能发出去。
 *
 * 为什么单独做探针而不是直接跑主服务：
 * 主服务一旦启动就会订阅事件、回卡片，在群里造成可见效果。
 * 探针只做「只读 + 一条自检消息」，出问题时能立刻定位是凭据、网络还是权限。
 *
 * 用法：
 *   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx \
 *   FEISHU_TEST_CHAT_ID=oc_xxx \
 *   node --import tsx scripts/bot-probe.ts
 *
 * 不带 FEISHU_TEST_CHAT_ID 时只验证前四步，不发消息。
 */

import * as lark from '@larksuiteoapi/node-sdk'

interface StepResult {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

const results: StepResult[] = []

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  const mark = ok ? 'OK  ' : 'FAIL'
  console.log(`  ${mark} ${name}: ${detail}`)
}

async function main(): Promise<void> {
  const appId = process.env.FEISHU_APP_ID?.trim()
  const appSecret = process.env.FEISHU_APP_SECRET?.trim()
  const testChatId = process.env.FEISHU_TEST_CHAT_ID?.trim()

  console.log('=== 飞书连通性探针 ===')
  console.log(`  app_id: ${appId ? `${appId.slice(0, 10)}…（长度 ${appId.length}）` : '(未设置)'}`)
  console.log(`  app_secret: ${appSecret ? `已设置（长度 ${appSecret.length}）` : '(未设置)'}`)
  console.log()

  if (!appId || !appSecret) {
    record('凭据', false, '缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET')
    finish()
    return
  }

  const baseUrl = process.env.FEISHU_BASE_URL?.trim() || 'https://open.feishu.cn'

  // 1. 取 tenant_access_token —— 这一步同时验证 app_id/app_secret 与出站连通。
  let token = ''
  try {
    const response = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const body = (await response.json()) as {
      code?: number
      msg?: string
      tenant_access_token?: string
      expire?: number
    }
    if (body.code === 0 && body.tenant_access_token) {
      token = body.tenant_access_token
      record('tenant_access_token', true, `已取得，有效期 ${body.expire ?? '?'} 秒`)
    } else {
      record('tenant_access_token', false, `code=${body.code} msg=${body.msg ?? '?'}`)
    }
  } catch (error) {
    record('tenant_access_token', false, `网络失败：${error instanceof Error ? error.message : String(error)}`)
  }

  if (!token) {
    finish()
    return
  }

  // 2. 读机器人自身信息 —— 拿 open_id，这是判断「@ 的是不是我」的唯一依据。
  let botOpenId = ''
  try {
    const response = await fetch(`${baseUrl}/open-apis/bot/v3/info`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = (await response.json()) as {
      code?: number
      msg?: string
      bot?: { open_id?: string; app_name?: string; activate_status?: number }
    }
    if (body.code === 0 && body.bot?.open_id) {
      botOpenId = body.bot.open_id
      record(
        'bot/v3/info',
        true,
        `app_name=${body.bot.app_name ?? '?'} open_id=${botOpenId} activate_status=${body.bot.activate_status ?? '?'}`,
      )
    } else {
      record('bot/v3/info', false, `code=${body.code} msg=${body.msg ?? '?'}`)
    }
  } catch (error) {
    record('bot/v3/info', false, `网络失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 3. 长连接能否建立 —— 保存事件订阅时飞书要求「已有在线长连接」，所以这一步是前提。
  try {
    const ready = await probeLongConnection(appId, appSecret)
    record('长连接', ready, ready ? '已建立并收到 ready 信号' : '15 秒内未就绪')
  } catch (error) {
    record('长连接', false, error instanceof Error ? error.message : String(error))
  }

  // 4. 发一条自检消息（可选）。这是唯一会在群里留下痕迹的步骤，所以必须显式给 chat_id。
  if (testChatId) {
    try {
      const response = await fetch(
        `${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            receive_id: testChatId,
            msg_type: 'text',
            content: JSON.stringify({ text: '工单机器人自检：连接正常。' }),
          }),
        },
      )
      const body = (await response.json()) as {
        code?: number
        msg?: string
        data?: { message_id?: string }
      }
      if (body.code === 0) {
        record('发消息', true, `message_id=${body.data?.message_id ?? '?'}`)
      } else {
        record('发消息', false, `code=${body.code} msg=${body.msg ?? '?'}`)
      }
    } catch (error) {
      record('发消息', false, `网络失败：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    record('发消息', true, '已跳过（未设置 FEISHU_TEST_CHAT_ID）')
  }

  finish(botOpenId)
}

/** 起一个长连接，等 ready 信号，然后立刻关掉。 */
async function probeLongConnection(appId: string, appSecret: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    })
    const dispatcher = new lark.EventDispatcher({}).register({})
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        wsClient.close()
      } catch {
        // 关闭失败不影响判定
      }
      resolve(false)
    }, 15_000)

    void wsClient
      .start({ eventDispatcher: dispatcher })
      .then(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          wsClient.close()
        } catch {
          // 忽略
        }
        resolve(true)
      })
      .catch((error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
  })
}

function finish(botOpenId?: string): void {
  const failed = results.filter((result) => !result.ok)
  console.log()
  if (failed.length === 0) {
    console.log('PROBE_OK')
    if (botOpenId) console.log(`把下面这行写进服务器 .env：FEISHU_BOT_OPEN_ID=${botOpenId}`)
    process.exitCode = 0
  } else {
    console.log(`PROBE_FAIL ${failed.length}/${results.length} 步失败`)
    process.exitCode = 1
  }
}

void main()
