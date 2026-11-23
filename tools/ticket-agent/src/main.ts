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
import { GitWorkspace } from './git-workspace.ts'
import { TicketStore } from './ticket-store.ts'
import { deployConfigFromEnv } from './deploy.ts'
import { DEFAULT_WATCHDOG_OPTIONS } from './watchdog.ts'

interface Config {
  appId: string
  appSecret: string
  botOpenId: string
  baseUrl: string
  dshBin: string
  nodePath: string
  repoPath: string
  /** 生产根目录（/opt/dilee）。 */
  rootDir: string
  ticketsDir: string
  timeoutMs: number
  /** 收口提前量：到 timeoutMs - graceMs 时先发 SIGTERM 让 Agent 收口。0 = 不打招呼直接杀。 */
  graceMs: number
  deepseekKey: string
  /** 调度模型（判断「这条消息要做什么」）。 */
  dispatchBaseUrl: string
  dispatchModel: string
  /** 群内进度播报间隔。0 表示不播报。 */
  progressNoticeMs: number
  /** 卡片原地更新间隔。 */
  cardUpdateMs: number
  /** run 成功后自动部署（用户 2026-11-13 拍板「全自动上线」）。 */
  autoDeploy: boolean
  /** 是否启用部署能力。 */
  deployEnabled: boolean
  /**
   * 本地主干分支名。**不是 GitHub 上的 `main`**：部署仓本地分支是 `agent/main`，
   * 部署时推的是 `HEAD:refs/heads/main`。工单分支从这个分支拉出、成功后合回它。
   */
  mainBranch: string
  /** 是否启用每单一条工单分支（2026-11-23 用户决定）。 */
  branchIsolation: boolean
  /** 是否启用看门狗（2026-11-23 用户决定）。 */
  watchdogEnabled: boolean
  /** 「多久没事件算没进展」。默认 10 分钟，真机验收时可调小。 */
  watchdogIdleMs: number
}

const DEFAULTS = {
  dshBin: '/opt/dilee/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
  nodePath: '/opt/node24/bin/node',
  repoPath: '/opt/dilee/agent/repo',
  rootDir: '/opt/dilee',
  ticketsDir: '/opt/dilee/agent/tickets',
  baseUrl: 'https://open.feishu.cn',
  timeoutMs: 6 * 60 * 60 * 1000,
  graceMs: 60 * 1000,
  dispatchBaseUrl: 'https://api.deepseek.com',
  dispatchModel: 'deepseek-chat',
  /**
   * 部署仓的本地主干分支。服务器上是 `agent/main`（部署时推 `HEAD:refs/heads/main`）；
   * 开发机克隆默认是 `main`，用 WORKSPACE_MAIN_BRANCH 覆盖。
   */
  mainBranch: 'agent/main',
  /**
   * 默认关闭周期播报（2026-11-20 用户要求「播报太多啰嗦，要精简」）。
   *
   * 群里只留开工、收尾、结束三条；卡片原地更新不新增消息，仍然保留。
   * 想临时看心跳就设 PROGRESS_NOTICE_MS=900000（15 分钟）—— 但不建议常态化开。
   */
  progressNoticeMs: 0,
  cardUpdateMs: 20 * 1000,
}

function positiveInteger(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value)
}

function envFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase())
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
  const graceRaw = env.HARNESS_GRACE_MS?.trim()
  const graceMs = graceRaw === undefined || graceRaw === '' ? DEFAULTS.graceMs : Number(graceRaw)
  if (!Number.isFinite(graceMs) || graceMs < 0) return { missing: ['HARNESS_GRACE_MS（必须是非负数，0 = 不设收口时间）'] }
  // 收口时间必须早于绝对上限，否则等于没设：这里直接夹到「不超过上限的一半」。
  const effectiveGraceMs = Math.min(graceMs, Math.floor(timeoutMs / 2))

  // 看门狗：多久没事件开始怀疑。默认 10 分钟（设计文档 §3.2）。
  // 允许调小是为了在真机上验流程（WATCHDOG_IDLE_MS=60000 就能一分钟内看到一次问答）。
  const watchdogIdleMs = positiveInteger(env.WATCHDOG_IDLE_MS, DEFAULT_WATCHDOG_OPTIONS.idleThresholdMs)
  if (watchdogIdleMs === null || watchdogIdleMs <= 0) {
    return { missing: ['WATCHDOG_IDLE_MS（必须是正整数）'] }
  }

  return {
    appId: appId!,
    appSecret: appSecret!,
    botOpenId: botOpenId!,
    deepseekKey: deepseekKey!,
    baseUrl: env.FEISHU_BASE_URL?.trim() || DEFAULTS.baseUrl,
    dshBin: env.DSH_BIN?.trim() || DEFAULTS.dshBin,
    nodePath: env.DSH_NODE?.trim() || DEFAULTS.nodePath,
    repoPath: env.DSH_REPO?.trim() || DEFAULTS.repoPath,
    rootDir: env.DILEE_ROOT?.trim() || DEFAULTS.rootDir,
    ticketsDir: env.TICKETS_DIR?.trim() || DEFAULTS.ticketsDir,
    timeoutMs,
    graceMs: effectiveGraceMs,
    watchdogEnabled: envFlag(env.WATCHDOG, true),
    watchdogIdleMs: watchdogIdleMs ?? DEFAULT_WATCHDOG_OPTIONS.idleThresholdMs,
    dispatchBaseUrl: env.DEEPSEEK_BASE_URL?.trim() || DEFAULTS.dispatchBaseUrl,
    dispatchModel: env.DEEPSEEK_MODEL?.trim() || DEFAULTS.dispatchModel,
    progressNoticeMs,
    cardUpdateMs,
    autoDeploy: envFlag(env.AUTO_DEPLOY, true),
    deployEnabled: envFlag(env.DEPLOY_ENABLED, true),
    mainBranch: env.WORKSPACE_MAIN_BRANCH?.trim() || DEFAULTS.mainBranch,
    branchIsolation: envFlag(env.BRANCH_ISOLATION, true),
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
  log(`[main] 单次 run 绝对上限：${Math.round(config.timeoutMs / 60000)} 分钟（到点前 ${Math.round(config.graceMs / 1000)} 秒发 SIGTERM 收口；不再是 45 分钟硬截断）`)
  log(
    `[main] 看门狗：${config.watchdogEnabled ? `启用（${Math.round(config.watchdogIdleMs / 60000)} 分钟无进展 + CPU 空闲 → 群里申请截断，不自动杀）` : '关闭'}`,
  )
  log(`[main] 问答模型：${config.dispatchModel} @ ${config.dispatchBaseUrl}`)
  log(`[main] 调度：模型 + 工具（create_ticket / append_ticket / start_run / status / reply / deploy / kill_run / continue_run）`)
  log(`[main] 进度播报：${config.progressNoticeMs === 0 ? '关闭（只发开工/收尾/结束三条）' : `${Math.round(config.progressNoticeMs / 1000)} 秒`}；卡片更新：${Math.round(config.cardUpdateMs / 1000)} 秒`)
  log(
    `[main] 工作区分支：${config.branchIsolation ? `启用（每单 ticket/<票号>，成功后 --no-ff 合入 ${config.mainBranch}，失败丢弃）` : '关闭（所有单直接在主干上改）'}`,
  )
  log(
    `[main] 部署：${
      config.deployEnabled
        ? config.autoDeploy
          ? '启用（run 成功后自动推送 GitHub 并上线，失败自动回滚）'
          : '启用（需在群里说「部署」）'
        : '关闭'
    }`,
  )

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

  /**
   * 工单工作区（2026-11-23）：每单一条分支，成功才合入主干，失败丢弃。
   *
   * 启动时先做一次恢复：若上次进程被强杀、工作区停在工单分支上，这里会 stash 残留、
   * 切回主干、删掉那条中断的分支 —— 否则残留会污染下一单（2026-11-21 真实事故）。
   */
  let workspace: GitWorkspace | null = null
  if (config.branchIsolation) {
    workspace = new GitWorkspace({
      repoPath: config.repoPath,
      mainBranch: config.mainBranch,
      log,
    })
    try {
      const recovered = await workspace.recover()
      if (recovered.recoveredBranch !== null) {
        log(`[main] 恢复中断的工单分支：${recovered.recoveredBranch}（残留已 ${recovered.stashed ?? '无残留'}）`)
      }
      if (recovered.leftoverBranches.length > 0) {
        log(`[main] 仍有未合并的工单分支（待人工）：${recovered.leftoverBranches.join('、')}`)
      }
    } catch (error) {
      log(`[main] 工作区恢复失败（继续启动）：${error instanceof Error ? error.message : String(error)}`)
      workspace = null
    }
  }

  const coordinator = new Coordinator({
    store,
    transport,
    dshBin: config.dshBin,
    nodePath: config.nodePath,
    repoPath: config.repoPath,
    timeoutMs: config.timeoutMs,
    graceMs: config.graceMs,
    childEnv: { DEEPSEEK_API_KEY: config.deepseekKey },
    dispatchKey: config.deepseekKey,
    dispatchBaseUrl: config.dispatchBaseUrl,
    dispatchModel: config.dispatchModel,
    progressNoticeMs: config.progressNoticeMs,
    cardUpdateMs: config.cardUpdateMs,
    deployConfig: config.deployEnabled
      ? deployConfigFromEnv({
          env: process.env,
          repoPath: config.repoPath,
          rootDir: config.rootDir,
          log,
        })
      : null,
    autoDeploy: config.autoDeploy,
    workspace,
    watchdog: config.watchdogEnabled ? { options: { idleThresholdMs: config.watchdogIdleMs } } : null,
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
