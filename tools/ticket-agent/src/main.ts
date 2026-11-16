/**
 * 工单机器人主进程（Coordinator 版）。
 *
 * 启动顺序刻意如此：先验证配置，再建存储与传输，最后才连长连接。
 * 如果在凭据缺失时就建长连接，SDK 会反复重试并刷日志，
 * 让人误以为是网络问题而不是配置问题。
 *
 * 退出约定：
 *   - 配置缺失 → 退出码 2，不重试（重试不会让凭据出现）；
 *   - 运行期异常 → 记录并继续（长连接自己会重连），不自杀；
 *   - SIGTERM/SIGINT → 停止接新消息，等当前 run 结束再退出。
 */

import { FeishuRestTransport } from './feishu-rest.ts'
import { startLongConnection, type LongConnectionHandle } from './feishu-ws.ts'
import { parseIncoming, type RawFeishuEvent } from './feishu-event.ts'
import { Coordinator } from './coordinator.ts'
import { sweepStaleRuns } from './run-janitor.ts'
import { TicketStore } from './ticket-store.ts'

interface Config {
  appId: string
  appSecret: string
  botOpenId: string
  baseUrl: string
  dshBin: string
  nodePath: string
  repoPath: string
  ticketsDir: string
  timeoutMs: number
  deepseekKey: string
  answererBaseUrl: string
  answererModel: string
  /** 群内进度播报间隔。0 表示不播报。 */
  progressNoticeMs: number
  /** 卡片原地更新间隔。 */
  cardUpdateMs: number
}

const DEFAULTS = {
  dshBin: '/opt/dilee/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
  nodePath: '/opt/node24/bin/node',
  repoPath: '/opt/dilee/agent/repo',
  ticketsDir: '/opt/dilee/agent/tickets',
  baseUrl: 'https://open.feishu.cn',
  timeoutMs: 45 * 60 * 1000,
  answererBaseUrl: 'https://api.deepseek.com',
  answererModel: 'deepseek-chat',
  progressNoticeMs: 5 * 60 * 1000,
  cardUpdateMs: 20 * 1000,
}

function positiveInteger(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value)
}

function readConfig(env: NodeJS.ProcessEnv): Config | { missing: string[] } {
  const appId = env.FEISHU_APP_ID?.trim()
  const appSecret = env.FEISHU_APP_SECRET?.trim()
  const botOpenId = env.FEISHU_BOT_OPEN_ID?.trim()
  const deepseekKey = env.DEEPSEEK_API_KEY?.trim()

  const missing: string[] = []
  if (!appId) missing.push('FEISHU_APP_ID')
  if (!appSecret) missing.push('FEISHU_APP_SECRET')
  if (!botOpenId) missing.push('FEISHU_BOT_OPEN_ID')
  if (!deepseekKey) missing.push('DEEPSEEK_API_KEY')
  if (missing.length > 0) return { missing }

  const timeoutRaw = env.HARNESS_TIMEOUT_MS?.trim()
  const timeoutMs = timeoutRaw === undefined || timeoutRaw === '' ? DEFAULTS.timeoutMs : Number(timeoutRaw)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { missing: ['HARNESS_TIMEOUT_MS（必须是正数）'] }
  }

  const progressNoticeMs = positiveInteger(env.PROGRESS_NOTICE_MS, DEFAULTS.progressNoticeMs)
  if (progressNoticeMs === null) return { missing: ['PROGRESS_NOTICE_MS（必须是非负数）'] }
  const cardUpdateMs = positiveInteger(env.PROGRESS_CARD_UPDATE_MS, DEFAULTS.cardUpdateMs)
  if (cardUpdateMs === null) return { missing: ['PROGRESS_CARD_UPDATE_MS（必须是非负数）'] }

  return {
    appId: appId!,
    appSecret: appSecret!,
    botOpenId: botOpenId!,
    deepseekKey: deepseekKey!,
    baseUrl: env.FEISHU_BASE_URL?.trim() || DEFAULTS.baseUrl,
    dshBin: env.DSH_BIN?.trim() || DEFAULTS.dshBin,
    nodePath: env.DSH_NODE?.trim() || DEFAULTS.nodePath,
    repoPath: env.DSH_REPO?.trim() || DEFAULTS.repoPath,
    ticketsDir: env.TICKETS_DIR?.trim() || DEFAULTS.ticketsDir,
    timeoutMs,
    answererBaseUrl: env.DEEPSEEK_BASE_URL?.trim() || DEFAULTS.answererBaseUrl,
    answererModel: env.DEEPSEEK_MODEL?.trim() || DEFAULTS.answererModel,
    progressNoticeMs,
    cardUpdateMs,
  }
}

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`)
}

async function main(): Promise<void> {
  log('[main] 启动工单机器人（Coordinator）')

  const config = readConfig(process.env)
  if ('missing' in config) {
    log(`[main] 配置缺失：${config.missing.join(', ')}`)
    process.exit(2)
  }

  log(`[main] 仓库：${config.repoPath}`)
  log(`[main] Node：${config.nodePath}`)
  log(`[main] DSH：${config.dshBin}`)
  log(`[main] 工单目录：${config.ticketsDir}`)
  log(`[main] 单次 run 超时：${Math.round(config.timeoutMs / 60000)} 分钟`)
  log(`[main] 问答模型：${config.answererModel} @ ${config.answererBaseUrl}`)
  log(`[main] 进度播报：${config.progressNoticeMs === 0 ? '关闭' : `${Math.round(config.progressNoticeMs / 1000)} 秒`}；卡片更新：${Math.round(config.cardUpdateMs / 1000)} 秒`)

  const store = new TicketStore(config.ticketsDir)

  // 启动清场：上一个进程若被强杀，它派生的 npm/tsc 会带着 DILEE_RUN_ID 标记残留，
  // 继续吃 CPU 把后续每次 run 拖慢。实测残留过 36 分钟，所以这一步不能省。
  try {
    const swept = sweepStaleRuns()
    if (swept.killed.length > 0) {
      log(`[main] 清理残留 run 进程 ${swept.killed.length} 个：${swept.killed.join(',')}`)
    }
    if (swept.failed.length > 0) {
      log(`[main] 有 ${swept.failed.length} 个残留进程清理失败：${swept.failed.join(',')}`)
    }
  } catch (error) {
    log(`[main] 清场失败（继续启动）：${error instanceof Error ? error.message : String(error)}`)
  }
  const transport = new FeishuRestTransport({
    appId: config.appId,
    appSecret: config.appSecret,
    baseUrl: config.baseUrl,
  })

  const coordinator = new Coordinator({
    store,
    transport,
    dshBin: config.dshBin,
    nodePath: config.nodePath,
    repoPath: config.repoPath,
    timeoutMs: config.timeoutMs,
    childEnv: { DEEPSEEK_API_KEY: config.deepseekKey },
    answererKey: config.deepseekKey,
    answererBaseUrl: config.answererBaseUrl,
    answererModel: config.answererModel,
    progressNoticeMs: config.progressNoticeMs,
    cardUpdateMs: config.cardUpdateMs,
    log,
  })

  let handle: LongConnectionHandle
  let shuttingDown = false

  try {
    handle = startLongConnection({
      appId: config.appId,
      appSecret: config.appSecret,
      log,
      onEvent: async (raw: RawFeishuEvent) => {
        if (shuttingDown) {
          log('[main] 正在关闭，丢弃新消息')
          return
        }
        const parsed = parseIncoming(raw, { botOpenId: config.botOpenId })
        if (parsed.kind === 'ignored') {
          return
        }
        // 这里必须快速返回：飞书要求 3 秒内处理完，长连接才不会重推。
        // handle() 只做「建单 + 入队」，真正的 harness run 在串行队列里跑。
        const outcome = await coordinator.handle(parsed.message)
        log(
          `[main] outcome=${outcome.outcome}` +
            (outcome.ticketNo === undefined ? '' : ` ticket=${outcome.ticketNo}`) +
            (outcome.state === undefined ? '' : ` state=${outcome.state}`),
        )
      },
    })
  } catch (error) {
    log(`[main] 长连接启动失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  log('[main] 已订阅 im.message.receive_v1，等待群消息')

  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    log(`[main] 收到 ${signal}，停止接新消息，等待当前 run 结束`)
    handle.stop()
    void coordinator
      .drain()
      .then(() => {
        log('[main] 队列已排空，退出')
        process.exit(0)
      })
      .catch(() => process.exit(1))
    // 兜底：60 秒还没排空就强制退出（run 本身有自己的硬超时）
    setTimeout(() => process.exit(0), 60_000)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

void main()
