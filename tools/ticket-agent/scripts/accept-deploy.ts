/**
 * 一次性验收脚本：用**真实飞书 + 真实部署**走一遍 Coordinator 的部署路径。
 *
 * 机器人自己收不到「自己发的消息」，所以群里那条「部署」没法自动重放；
 * 这个脚本用同一个 Coordinator、同一套 TicketStore/Transport/DeployConfig，
 * 只把「消息来源」换成本地构造的一条命令 —— 走的仍是线上那条代码路径。
 *
 * 用法（服务器上，先 source .env 或用 ENV_FILE 指向它）：
 *   /opt/node24/bin/node --import tsx scripts/accept-deploy.ts
 *
 * 触发对象：最近一张 `gated` 工单（部署一次带上 HEAD 上的全部改动）。
 */

import { readFileSync } from 'node:fs'

import { Coordinator } from '../src/coordinator.ts'
import { deployConfigFromEnv } from '../src/deploy.ts'
import { FeishuRestTransport } from '../src/feishu-rest.ts'
import { TicketStore } from '../src/ticket-store.ts'

const ENV_FILE = process.env.ENV_FILE ?? '/opt/dilee/agent/ticket-agent/.env'

/** 极简 .env 解析：不覆盖已有环境变量，去掉行内引号。 */
function loadEnvFile(path: string): void {
  let content = ''
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    console.log(`（读不到 ${path}，使用当前环境变量）`)
    return
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#') || !line.includes('=')) continue
    const at = line.indexOf('=')
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, '')
    if (key.length > 0 && process.env[key] === undefined) process.env[key] = value
  }
}

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`)
}

async function main(): Promise<void> {
  loadEnvFile(ENV_FILE)
  const appId = process.env.FEISHU_APP_ID?.trim()
  const appSecret = process.env.FEISHU_APP_SECRET?.trim()
  if (!appId || !appSecret) {
    console.error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET')
    process.exit(2)
  }

  const repoPath = process.env.DSH_REPO?.trim() || '/opt/dilee/agent/repo'
  const rootDir = process.env.DILEE_ROOT?.trim() || '/opt/dilee'
  const ticketsDir = process.env.TICKETS_DIR?.trim() || '/opt/dilee/agent/tickets'

  const store = new TicketStore(ticketsDir)
  const transport = new FeishuRestTransport({
    appId,
    appSecret,
    baseUrl: process.env.FEISHU_BASE_URL?.trim() || 'https://open.feishu.cn',
  })

  const gated = store.all().filter((ticket) => ticket.state === 'gated')
  if (gated.length === 0) {
    log('没有 gated 工单，不需要部署')
    process.exit(3)
  }
  const target = gated[gated.length - 1]
  log(`待部署工单：${gated.map((ticket) => ticket.no).join('、')}；触发消息挂在 ${target.no} 的原始消息上`)

  const coordinator = new Coordinator({
    store,
    transport,
    dshBin: process.env.DSH_BIN?.trim() || '/opt/dilee/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
    nodePath: process.env.DSH_NODE?.trim() || '/opt/node24/bin/node',
    repoPath,
    timeoutMs: 45 * 60 * 1000,
    childEnv: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? '' },
    dispatchKey: process.env.DEEPSEEK_API_KEY ?? '',
    progressNoticeMs: 0,
    cardUpdateMs: 20 * 1000,
    deployConfig: deployConfigFromEnv({ env: process.env, repoPath, rootDir, log }),
    autoDeploy: false,
    log,
  })

  const outcome = await coordinator.handle({
    messageId: target.turns[0]?.messageId ?? target.cardMessageId ?? '',
    chatId: target.chatId,
    chatType: 'group',
    senderOpenId: 'ou_accept_deploy_script',
    senderType: 'user',
    text: '部署',
    mentionsBot: true,
    eventId: null,
    createTime: String(Date.now()),
    threadId: null,
    parentId: null,
    rootId: null,
  })
  log(`handle outcome=${outcome.outcome} note=${outcome.note ?? ''}`)

  await coordinator.drain()

  const finalStates = store.all().filter((ticket) => gated.some((g) => g.id === ticket.id))
  for (const ticket of finalStates) {
    log(`${ticket.no} state=${ticket.state}`)
  }
  const allDone = finalStates.length > 0 && finalStates.every((ticket) => ticket.state === 'done')
  process.exit(allDone ? 0 : 1)
}

void main()
