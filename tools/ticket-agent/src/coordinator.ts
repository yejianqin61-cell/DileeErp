/**
 * Coordinator：飞书消息与 DSH 之间的唯一编排者。
 *
 * 它做五件事，每件都尽量薄：
 *   1. 判定这条消息的**意图**（需求 / 问进度 / 提问 / 闲聊 / 操作指令）；
 *   2. 需求判定**新工单**还是**追加到已有工单**；
 *   3. 把口语需求交给 prompt-builder 转成专业 prompt；
 *   4. 起一次 harness run（首轮取会话 id，后续续接），并在跑的过程中主动同步进度；
 *   5. 把结果写回飞书卡片。
 *
 * 为什么要有意图层（2026-11-16 加）：用户问「汇报T-0007进度」时，旧实现把它当需求，
 * 分诊只能回「这条我还不够开工」。用户等了 14 分钟，问了两次，两次都被挡回来，
 * 最后骂了一句。缺的不是话术，是「这条消息是不是需求」这个判断。
 *
 * 为什么判定只认「回复卡片」为追加：
 * 用户 2026-11-14 拍板。语义相似度会误归单，而误归单比漏归单代价高得多 ——
 * 一条需求被塞进错误的工单，Agent 会拿着不相关上下文改代码。
 *
 * 为什么单车道：Phase 1 实测构建期可用内存最低 152 MB，并行必然打满 swap。
 * 所以这里用一条串行队列，后来的工单排队而不是抢资源。
 * 问答不走这条车道：它不改代码，走它会白白占住改代码的位置。
 */

import type { FeishuCard, FeishuTransport } from './feishu-transport.ts'
import type { IncomingMessage } from './feishu-event.ts'
import { triage } from './triage.ts'
import {
  DEFAULT_TIMEOUT_MS,
  runHarness,
  type HarnessEvent,
  type HarnessResult,
} from './harness-runner.ts'
import {
  DEFAULT_ENVIRONMENT,
  buildAppendPrompt,
  buildCreatePrompt,
  type PromptEnvironment,
} from './prompt-builder.ts'
import { TicketStore, parseTicketNo, type StoredTicket, type TicketResult } from './ticket-store.ts'
import { classifyIntent, normalizeText, type IntentResult } from './intent.ts'
import {
  INITIAL_PROGRESS,
  applyEvent,
  formatDuration,
  heartbeatLine,
  overviewText,
  progressCard,
  stateLabel,
  statusText,
  toStoredProgress,
  toView,
  type ProgressState,
  type ProgressView,
} from './progress.ts'
import { answerQuestion } from './answerer.ts'
import {
  runDeploy,
  type DeployConfig,
  type DeployPhase,
  type DeployResult,
} from './deploy.ts'

/** 分诊不通过时的追问话术（沿用 Phase 2 的口径）。 */
import { askForMissing } from './triage.ts'

export interface CoordinatorOptions {
  store: TicketStore
  transport: FeishuTransport
  dshBin: string
  nodePath: string
  repoPath: string
  /** 子进程环境，通常含 DEEPSEEK_API_KEY。 */
  childEnv?: NodeJS.ProcessEnv
  timeoutMs?: number
  log?: (line: string) => void
  now?: () => Date
  /** 注入用：测试时替换真实 harness。 */
  runHarnessImpl?: typeof runHarness
  /** 问答模型密钥（DEEPSEEK_API_KEY）。空字符串时问答走兜底话术。 */
  answererKey?: string
  answererBaseUrl?: string
  answererModel?: string
  /** 注入用：测试时替换真实模型调用。 */
  answererImpl?: typeof answerQuestion
  /** 群内进度播报间隔，默认 5 分钟；0 表示不播报（测试用）。 */
  progressNoticeMs?: number
  /** 卡片原地更新间隔，默认 20 秒；负数表示不更新（测试用）。 */
  cardUpdateMs?: number
  /** 部署配置。为空表示这台机器没配部署能力（只提示，不执行）。 */
  deployConfig?: DeployConfig | null
  /** 注入用：测试时替换真实部署执行。 */
  deployImpl?: typeof runDeploy
  /** run 成功后是否自动部署（用户 2026-11-13 拍板「全自动上线」）。 */
  autoDeploy?: boolean
}

export type RouteDecision =
  | { kind: 'append'; ticket: StoredTicket; reason: string }
  | { kind: 'create'; reason: string }

export interface HandleOutcome {
  readonly outcome:
    | 'created'
    | 'appended'
    | 'needs-info'
    | 'ran'
    | 'failed'
    | 'duplicate'
    | 'answered'
  readonly ticketNo?: string
  readonly state?: string
  readonly note?: string
}

/** 部署触发方式：群里说「部署」，或 run 成功后自动部署。 */
type DeployTrigger =
  | { kind: 'command'; messageId: string }
  | { kind: 'auto'; chatId: string; ticketNo: string; messageId: string | null }

/** 部署阶段的中文标签。 */
const DEPLOY_PHASE_LABELS: Record<DeployPhase, string> = {
  preflight: '预检',
  push: '推送 GitHub',
  pack: '打包',
  build: '构建',
  test: '测试门禁',
  migrate: '迁移检查',
  switch: '切换',
  verify: '核验',
  edge: '边缘探针',
  done: '完成',
  rollback: '回滚',
  'rolled-back': '已回滚',
  failed: '失败',
}

/** 进度落盘间隔：比卡片更新慢，减少文件写；阶段变化时立即写。 */
const PROGRESS_PERSIST_MS = 5_000

/** 卡片更新间隔下限：防止事件流很密时把飞书打爆。 */
const MIN_CARD_UPDATE_MS = 5_000

/**
 * 判定路由。纯函数，可单测。
 *
 * 判定顺序固定，只有一条规则：
 *   消息的 parentId 或 rootId 命中某工单的 cardMessageId → 追加。
 * 其余一律新单。
 */
export function decideRoute(
  store: TicketStore,
  message: IncomingMessage,
): RouteDecision {
  const candidates = [message.parentId, message.rootId].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  for (const candidate of candidates) {
    const ticket = store.findByCard(candidate)
    if (ticket !== null) {
      return { kind: 'append', ticket, reason: `回复卡片 ${candidate}` }
    }
  }
  return {
    kind: 'create',
    reason: candidates.length > 0 ? '回复的是普通消息，不是工单卡片' : '不是回复',
  }
}

/** 卡片内容：把一次 run 的结果写给群里看。 */
export function resultCard(input: {
  ticketNo: string
  state: string
  result: HarnessResult
  userText: string
}): FeishuCard {
  const { result } = input
  const lines: string[] = []

  if (result.outcome === 'completed') {
    lines.push(`**结果**：已完成，改动在工作区等待部署`)
  } else if (result.outcome === 'timeout') {
    lines.push(`**结果**：超时终止（${Math.round(result.durationMs / 1000)} 秒）`)
  } else {
    lines.push(`**结果**：失败`)
  }

  lines.push(`**耗时**：${formatDuration(result.durationMs)}`)
  lines.push(
    `**过程**：工具调用 ${result.counts.toolCalls} 次，其中派发子 Agent ${result.counts.subagentCalls} 次`,
  )
  if (result.sessionId !== null) lines.push(`**会话**：${result.sessionId}`)

  const summary = summarize(result)
  if (summary.length > 0) lines.push(`**结论**：${summary}`)
  if (result.error !== undefined) lines.push(`**错误**：${result.error}`)

  const template: FeishuCard['template'] =
    result.outcome === 'completed' ? 'green' : result.outcome === 'timeout' ? 'purple' : 'red'

  return {
    title:
      result.outcome === 'completed'
        ? `有产出待部署｜${input.ticketNo}`
        : result.outcome === 'timeout'
          ? `超时终止｜${input.ticketNo}`
          : `未完成｜${input.ticketNo}`,
    template,
    lines,
    footer: `${input.ticketNo}｜${input.state}｜原话：${truncate(input.userText, 60)}`,
  }
}

/**
 * 结论摘要。卡片塞不下整段 final 文本，所以截断并指向证据目录。
 * 不截断到看不见的程度：至少要能看出「改了什么」。
 */
export function summarize(result: HarnessResult, limit = 600): string {
  const text = result.finalText.trim()
  if (text.length === 0) return ''
  return text.length <= limit ? text : `${text.slice(0, limit)}…（已截断）`
}

function truncate(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`
}

interface ResolvedOptions {
  store: TicketStore
  transport: FeishuTransport
  dshBin: string
  nodePath: string
  repoPath: string
  now: () => Date
  childEnv: NodeJS.ProcessEnv | undefined
  timeoutMs: number
  log: (line: string) => void
  runHarnessImpl: typeof runHarness
  answererKey: string
  answererBaseUrl: string
  answererModel: string
  answererImpl: typeof answerQuestion
  progressNoticeMs: number
  cardUpdateMs: number
  deployConfig: DeployConfig | null
  deployImpl: typeof runDeploy
  autoDeploy: boolean
}

export class Coordinator {
  private readonly opts: ResolvedOptions
  /** 串行队列：单车道，防止两单同时吃满 2 核。 */
  private queue: Promise<unknown> = Promise.resolve()
  /** 问答队列：轻活，不占改代码的车道，但 drain 时要等到。 */
  private answerQueue: Promise<unknown> = Promise.resolve()
  /** 卡片更新串行化，避免乱序覆盖。 */
  private cardChain: Promise<void> = Promise.resolve()

  constructor(options: CoordinatorOptions) {
    this.opts = {
      store: options.store,
      transport: options.transport,
      dshBin: options.dshBin,
      nodePath: options.nodePath,
      repoPath: options.repoPath,
      now: options.now ?? (() => new Date()),
      childEnv: options.childEnv,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      log: options.log ?? ((line) => console.log(line)),
      runHarnessImpl: options.runHarnessImpl ?? runHarness,
      answererKey: options.answererKey ?? '',
      answererBaseUrl: options.answererBaseUrl ?? 'https://api.deepseek.com',
      answererModel: options.answererModel ?? 'deepseek-chat',
      answererImpl: options.answererImpl ?? answerQuestion,
      progressNoticeMs: options.progressNoticeMs ?? 5 * 60 * 1000,
      cardUpdateMs: options.cardUpdateMs ?? 20 * 1000,
      deployConfig: options.deployConfig ?? null,
      deployImpl: options.deployImpl ?? runDeploy,
      autoDeploy: options.autoDeploy ?? false,
    }
  }

  private stamp(): string {
    return this.opts.now().toISOString()
  }

  private nowMs(): number {
    return this.opts.now().getTime()
  }

  /** 环境事实里只有工单号是每单不同的。 */
  private envFor(ticketNo: string): PromptEnvironment {
    return {
      ...DEFAULT_ENVIRONMENT,
      repoPath: this.opts.repoPath,
      nodePath: this.opts.nodePath,
      ticketNo,
    }
  }

  /**
   * 处理一条已解析的飞书消息。
   *
   * 注意：需求入队本身就意味着「稍后执行」。这里返回的是**入队完成**，
   * 真正的执行结果通过卡片反馈，不会在这个函数的返回值里。
   * 非需求问答在后台队列里回，返回的是「已受理这个意图」。
   */
  async handle(message: IncomingMessage): Promise<HandleOutcome> {
    const at = this.stamp()
    const intent = classifyIntent(message.text)

    if (intent.intent === 'command' && this.isDeployCommand(message.text)) {
      this.enqueueDeploy({ kind: 'command', messageId: message.messageId })
      this.opts.log('[coord] intent=command deploy')
      return { outcome: 'answered', note: 'deploy:command' }
    }

    if (intent.intent !== 'requirement') {
      this.enqueueAnswer(() => this.replyIntent(message, intent))
      this.opts.log(`[coord] intent=${intent.intent} reason=${intent.reason}`)
      return {
        outcome: 'answered',
        note: `${intent.intent}:${intent.reason}`,
        ...(intent.ticketNo === null ? {} : { ticketNo: intent.ticketNo }),
      }
    }

    return this.handleRequirement(message, at)
  }

  private isDeployCommand(text: string): boolean {
    return /部署|上线|发布/.test(normalizeText(text))
  }

  // ───────────────────────────── 非需求路径 ─────────────────────────────

  /**
   * 答非需求消息。任何分支都不建单、不占用改代码车道。
   *
   * 问答失败也必须回一句人话：群里最怕的是 @ 了机器人却没有任何反应。
   */
  private async replyIntent(message: IncomingMessage, intent: IntentResult): Promise<void> {
    try {
      if (intent.intent === 'status') {
        await this.opts.transport.replyText(message.messageId, this.statusAnswer(intent.ticketNo))
        return
      }
      if (intent.intent === 'command') {
        await this.opts.transport.replyText(message.messageId, this.commandAnswer())
        return
      }
      if (intent.intent === 'chitchat') {
        await this.opts.transport.replyText(message.messageId, this.chitchatAnswer(message.text))
        return
      }
      // question
      const answer = await this.opts.answererImpl({
        question: message.text,
        context: this.qaContext(),
        apiKey: this.opts.answererKey,
        baseUrl: this.opts.answererBaseUrl,
        model: this.opts.answererModel,
      })
      this.opts.log(
        `[coord] answer source=${answer.source}${answer.error === undefined ? '' : ` error=${answer.error}`}`,
      )
      await this.opts.transport.replyText(message.messageId, answer.text)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.opts.log(`[coord] replyIntent failed intent=${intent.intent}: ${reason}`)
      try {
        await this.opts.transport.replyText(message.messageId, '我这边处理出错了一下，麻烦再发一次。')
      } catch {
        // 连错误提示都发不出去时，只能留日志
      }
    }
  }

  /** 问答用的上下文：全部来自本地工单文件，不碰生产库。 */
  private qaContext(): { tickets: readonly StoredTicket[]; activeCount: number } {
    const tickets = this.opts.store.all()
    const activeCount = tickets.filter(
      (ticket) => ticket.state === 'queued' || ticket.state === 'building',
    ).length
    return { tickets, activeCount }
  }

  /** 「T-0007 进度」的答案。全部是本地事实，不调模型。 */
  private statusAnswer(ticketNo: string | null): string {
    const nowMs = this.nowMs()
    const tickets = this.opts.store.all()
    if (ticketNo === null) return overviewText({ tickets, nowMs })

    const ticket = tickets.find((candidate) => candidate.no === ticketNo) ?? null
    if (ticket === null) {
      const recent = tickets.slice(-3).map((candidate) => `${candidate.no}（${stateLabel(candidate.state)}）`)
      const tail = recent.length > 0 ? `最近的工单：${recent.join('、')}。` : '目前还没有工单。'
      return `没找到 ${ticketNo}。${tail}`
    }
    return statusText({ ticket, nowMs, queueAhead: this.queueAhead(ticket) })
  }

  /** 某张排队工单前面还有几张。施工中与其余状态都是 0。 */
  private queueAhead(ticket: StoredTicket): number {
    if (ticket.state !== 'queued') return 0
    const mine = parseTicketNo(ticket.no)
    const tickets = this.opts.store.all()
    const building = tickets.some((candidate) => candidate.state === 'building') ? 1 : 0
    const queuedBefore = tickets.filter(
      (candidate) => candidate.state === 'queued' && parseTicketNo(candidate.no) < mine,
    ).length
    return building + queuedBefore
  }

  /** 新建工单前的排队长度。 */
  private pendingAhead(): number {
    return this.opts.store.all().filter(
      (ticket) => ticket.state === 'queued' || ticket.state === 'building',
    ).length
  }

  /**
   * 「回滚 / 重启」这类非部署操作指令的回答。
   *
   * 部署指令在 handle() 里已经被拦截并执行，这里只处理还没接通的其它操作。
   * 不装：如实说没接通，并告诉用户部署该怎么说。
   */
  private commandAnswer(): string {
    const gated = this.opts.store.all().filter((ticket) => ticket.state === 'gated')
    if (gated.length === 0) {
      return '回滚/重启这类操作还没接通；要部署的话直接发「部署」就行。'
    }
    return [
      '回滚/重启这类操作还没接通。',
      `要部署直接发「部署」：我会先推 GitHub，再构建、测试、切换，失败自动回滚。`,
      `当前待部署：${gated.map((ticket) => ticket.no).join('、')}。`,
    ].join('\n')
  }

  private chitchatAnswer(text: string): string {
    const normalized = normalizeText(text)
    if (/傻逼|傻比|废物|垃圾|滚|操你|草你|卧槽|他妈的|妈的|气死|烦死|无语|坑爹|什么玩意|没用|有病/.test(normalized)) {
      return [
        '收到。如果是系统哪里让你火大，把页面和现象发我，我直接查、直接改。',
        '骂我没关系，我更想帮你把问题解决掉。问某张单的进度就 @我 说「T-0007 进度」。',
      ].join('\n')
    }
    if (/谢谢|多谢|感谢|辛苦/.test(normalized)) {
      return '不客气。还有要改的随时 @我，说清页面和期望就行。'
    }
    return [
      '我是迪礼顾问，迪礼 ERP 的维护助手。你可以：',
      '1. 提需求 —— 说清哪个页面、哪里不对、希望变成什么样，我建单改代码，通常 5–20 分钟；',
      '2. 问进度 —— @我说「T-0007 进度」；',
      '3. 问使用 —— 直接问这个系统怎么用。',
    ].join('\n')
  }

  // ───────────────────────────── 部署路径 ─────────────────────────────

  /** 部署入队。与工单 run 共用一条串行队列：构建期不能有 run 同时改工作区。 */
  private enqueueDeploy(trigger: DeployTrigger): void {
    this.queue = this.queue
      .then(() => this.deployAll(trigger))
      .catch((error: unknown) => {
        this.opts.log(`[coord] deploy error: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /**
   * 部署一次。
   *
   * 覆盖所有 `gated` 工单：一次部署带上去的是 HEAD 上的全部改动，
   * 逐张单部署既慢又没有意义。失败时按结果把工单放回 `gated`（未切换）、
   * 标 `rolled_back`（已回滚）或 `failed`。
   */
  private async deployAll(trigger: DeployTrigger): Promise<void> {
    const config = this.opts.deployConfig
    if (config === null) {
      await this.deployNotice(trigger, '这台机器没有配置部署能力（缺 deployConfig），部署没有执行。')
      return
    }
    const gated = this.opts.store.all().filter((ticket) => ticket.state === 'gated')
    if (gated.length === 0) {
      await this.deployNotice(trigger, '现在没有待部署的改动：要么已经上线，要么工单还没跑完。')
      return
    }

    const at = this.stamp()
    for (const ticket of gated) this.opts.store.setState(ticket.id, 'deploying', at)
    this.opts.log(
      `[coord] deploy start tickets=${gated.map((ticket) => ticket.no).join(',')} trigger=${trigger.kind}`,
    )
    await this.deployNotice(trigger, this.deployStartText(gated))

    let phase: DeployPhase = 'preflight'
    let phaseMessage = '预检'
    const startedAt = this.nowMs()
    const paint = (): void => {
      const nowMs = this.nowMs()
      for (const ticket of gated) {
        this.scheduleCard(ticket.id, (current) => ({
          title: `部署中｜${current.no}`,
          template: 'blue',
          lines: [
            `**阶段**：${DEPLOY_PHASE_LABELS[phase]}（${phaseMessage}）`,
            `**已用**：${formatDuration(Math.max(0, nowMs - startedAt))}`,
          ],
          footer: `${current.no}｜正在部署，失败会自动回滚`,
        }))
      }
    }
    paint()

    const heartbeat =
      this.opts.progressNoticeMs > 0
        ? setInterval(() => {
            paint()
            void this.deployNotice(
              trigger,
              `部署进行中（${formatDuration(Math.max(0, this.nowMs() - startedAt))}）：${DEPLOY_PHASE_LABELS[phase]} — ${phaseMessage}`,
            )
          }, this.opts.progressNoticeMs)
        : null
    heartbeat?.unref()

    let result: DeployResult
    try {
      result = await this.opts.deployImpl({
        config,
        hooks: {
          onPhase: (nextPhase, message) => {
            phase = nextPhase
            phaseMessage = message
            paint()
            this.opts.log(`[coord] deploy phase=${nextPhase} ${message}`)
          },
        },
      })
    } finally {
      if (heartbeat !== null) clearInterval(heartbeat)
    }

    const outcomeState = result.ok ? 'done' : result.rolledBack ? 'rolled_back' : 'gated'
    const finishedAt = this.stamp()
    for (const ticket of gated) {
      this.opts.store.setState(ticket.id, outcomeState, finishedAt)
      this.scheduleCard(ticket.id, (current) => this.deployResultCard(current, result))
    }
    await this.cardChain
    await this.deployNotice(trigger, this.deployResultText(gated, result, config))
    this.opts.log(
      `[coord] deploy done ok=${String(result.ok)} rolledBack=${String(result.rolledBack)} phase=${result.phase} release=${result.release.slice(0, 8)}`,
    )
  }

  private deployStartText(gated: readonly StoredTicket[]): string {
    return [
      '开始部署：推送 GitHub → 构建 → 测试门禁 → 迁移检查 → 切换 → 核验，失败自动回滚。',
      `涉及工单：${gated.map((ticket) => ticket.no).join('、')}。`,
      '预计 20–35 分钟（这台机器 2 核），过程中我会同步进度。',
    ].join('\n')
  }

  private deployResultCard(ticket: StoredTicket, result: DeployResult): FeishuCard {
    if (result.ok) {
      const lines = [
        `**版本**：${result.release.slice(0, 8)}（上一版 ${result.previousVersion.slice(0, 8)}）`,
        `**用时**：${formatDuration(result.durationMs)}`,
        `**GitHub**：${result.pushed ? '已推送' : '未推送（配置关闭）'}`,
      ]
      if (result.backupDir !== null) lines.push(`**备份**：${result.backupDir}`)
      if (result.warning !== null) lines.push(`**注意**：${result.warning}`)
      return {
        title: `已上线｜${ticket.no}`,
        template: 'green',
        lines,
        footer: `${ticket.no}｜已上线，回复这张卡片可继续提改进`,
      }
    }
    const lines = [
      `**版本**：${result.release.slice(0, 8)}（线上仍是 ${result.previousVersion.slice(0, 8)}）`,
      `**阶段**：${DEPLOY_PHASE_LABELS[result.phase]}`,
    ]
    if (result.failure !== null) lines.push(`**原因**：${truncate(result.failure, 240)}`)
    lines.push(`**线上**：${result.rolledBack ? '已回滚到上一版' : '未切换，保持旧版本'}`)
    return {
      title: result.rolledBack ? `已回滚｜${ticket.no}` : `部署失败｜${ticket.no}`,
      template: result.rolledBack ? 'purple' : 'red',
      lines,
      footer: `${ticket.no}｜部署记录：/opt/dilee/agent/deploys/`,
    }
  }

  private deployResultText(
    gated: readonly StoredTicket[],
    result: DeployResult,
    config: DeployConfig,
  ): string {
    const tickets = gated.map((ticket) => ticket.no).join('、')
    if (result.ok) {
      const lines = [
        `${tickets} 已上线：${result.release.slice(0, 8)}（上一版 ${result.previousVersion.slice(0, 8)}）`,
        `用时 ${formatDuration(result.durationMs)}；GitHub ${result.pushed ? '已推送' : '未推送'}` +
          (result.backupDir === null ? '' : `；备份 ${result.backupDir}`) +
          '。',
      ]
      if (result.warning !== null) lines.push(`注意：${result.warning}`)
      return lines.join('\n')
    }
    if (result.rolledBack) {
      return [
        `部署失败，已自动回滚（阶段：${DEPLOY_PHASE_LABELS[result.phase]}）。`,
        `线上已恢复 ${result.previousVersion.slice(0, 8)}。`,
        ...(result.failure === null ? [] : [`原因：${truncate(result.failure, 300)}`]),
        `部署记录：${config.recordsDir}`,
      ].join('\n')
    }
    return [
      `部署失败（阶段：${DEPLOY_PHASE_LABELS[result.phase]}），线上未切换，仍是 ${result.previousVersion.slice(0, 8)}。`,
      ...(result.failure === null ? [] : [`原因：${truncate(result.failure, 300)}`]),
      '修好后再发「部署」即可重试。',
    ].join('\n')
  }

  /** 部署进度/结果发到群里：命令触发回原消息；自动部署回到工单原消息。 */
  private async deployNotice(trigger: DeployTrigger, text: string): Promise<void> {
    try {
      if (trigger.kind === 'command') {
        await this.opts.transport.replyText(trigger.messageId, text)
        return
      }
      if (trigger.messageId !== null) {
        await this.opts.transport.replyText(trigger.messageId, text)
        return
      }
      await this.opts.transport.sendText(trigger.chatId, text)
    } catch (error) {
      this.opts.log(
        `[coord] deployNotice failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // ───────────────────────────── 需求路径 ─────────────────────────────

  private async handleRequirement(message: IncomingMessage, at: string): Promise<HandleOutcome> {
    const route = decideRoute(this.opts.store, message)

    if (route.kind === 'append') {
      const ticket = this.opts.store.appendTurn(route.ticket.id, {
        messageId: message.messageId,
        text: message.text,
        at,
      })
      this.opts.log(`[coord] append ${ticket.no} reason=${route.reason}`)
      await this.opts.transport.replyText(
        ticket.cardMessageId ?? message.messageId,
        `已收到 ${ticket.no} 的追加需求，排队中。`,
      )
      this.enqueue(ticket)
      return { outcome: 'appended', ticketNo: ticket.no, state: ticket.state }
    }

    // 新单：先分诊。分诊不过就追问，不进队列。
    const triageResult = triage(message.text)
    const ticket = this.opts.store.create({
      messageId: message.messageId,
      chatId: message.chatId,
      text: message.text,
      at,
      state: triageResult.missing.length > 0 ? 'needs_info' : 'received',
    })

    if (triageResult.missing.length > 0) {
      this.opts.log(`[coord] needs-info ${ticket.no} missing=${triageResult.missing.join(',')}`)
      await this.opts.transport.replyText(message.messageId, askForMissing(triageResult.missing))
      return { outcome: 'needs-info', ticketNo: ticket.no, state: ticket.state }
    }

    // 发主卡片，并把它的 message_id 绑进工单 —— 这是「回复卡片 = 追加」的锚点。
    const ahead = this.pendingAhead()
    const lines: string[] = []
    if (ahead > 0) lines.push(`**排队**：前面还有 ${ahead} 张单`)
    lines.push(`**原话**：${truncate(ticket.turns[0].text, 200)}`)
    const sent = await this.opts.transport.sendCard(ticket.chatId, {
      title: `已受理，排队中｜${ticket.no}`,
      template: 'blue',
      lines,
      footer: `${ticket.no}｜回复这张卡片可追加需求`,
    })
    this.opts.store.bindCard(ticket.id, sent.messageId, at)
    this.opts.store.setState(ticket.id, 'queued', at)

    this.opts.log(`[coord] created ${ticket.no} card=${sent.messageId} ahead=${ahead}`)
    this.enqueue({ ...ticket, cardMessageId: sent.messageId, state: 'queued' })
    return { outcome: 'created', ticketNo: ticket.no, state: 'queued' }
  }

  /** 入队。同一时刻只跑一个 run。 */
  private enqueue(ticket: StoredTicket): void {
    this.queue = this.queue
      .then(() => this.runTicket(ticket))
      .catch((error: unknown) => {
        this.opts.log(`[coord] queue error ${ticket.no}: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** 问答入队。与改代码车道分开，避免一句提问等 15 分钟。 */
  private enqueueAnswer(task: () => Promise<void>): void {
    this.answerQueue = this.answerQueue.then(task).catch((error: unknown) => {
      this.opts.log(`[coord] answer error: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * 等所有队列排空。测试与优雅关闭用。
   *
   * 必须循环到队列不再变化：run 成功会自动部署，部署是在 run 执行过程中
   * **追加**到队尾的。只 await 一次会在「run 刚结束、部署刚入队」的瞬间返回。
   */
  async drain(): Promise<void> {
    for (;;) {
      const runQueue = this.queue
      const answers = this.answerQueue
      await runQueue
      await answers
      await this.cardChain
      if (runQueue === this.queue && answers === this.answerQueue) return
    }
  }

  /**
   * 跑一张工单。
   *
   * 进度同步有三条频率不同的通道（设计文档 §3.4）：
   *   - 卡片：阶段变化立即更新，其余按 cardUpdateMs 节流；
   *   - 群内播报：开工一次 + 进入验证/收尾各一次 + 每 progressNoticeMs 一次心跳；
   *   - 进度落盘：阶段变化立即写，其余按 PROGRESS_PERSIST_MS 节流（重启后可答进度）。
   */
  private async runTicket(ticket: StoredTicket): Promise<void> {
    const latest = this.opts.store.get(ticket.id)
    if (latest === null) return

    const startedAtMs = this.nowMs()
    const startedAt = new Date(startedAtMs).toISOString()
    const at = this.stamp()
    this.opts.store.setState(latest.id, 'building', at)

    let progress: ProgressState = INITIAL_PROGRESS
    let view: ProgressView = toView(progress, startedAtMs)

    // 先把卡片转「施工中」，再播报开工：用户刷新时先看到卡片，再看到消息。
    this.scheduleCardUpdate(latest.id, view, startedAtMs, startedAtMs)
    await this.notify(
      latest.turns[0]?.messageId,
      `${latest.no} 已开工，预计 10–20 分钟。过程中我会主动同步进度；你也可以随时 @我 问「${latest.no} 进度」。`,
    )

    let lastCardAt = startedAtMs
    let lastPersistAt = startedAtMs
    let lastNoticeAt = startedAtMs
    let lastPhase = progress.phase

    const persist = (force: boolean): void => {
      const nowMs = this.nowMs()
      if (!force && nowMs - lastPersistAt < PROGRESS_PERSIST_MS) return
      lastPersistAt = nowMs
      const updatedAt = new Date(nowMs).toISOString()
      try {
        this.opts.store.setProgress(latest.id, toStoredProgress({ view, startedAt, updatedAt }), updatedAt)
      } catch (error) {
        this.opts.log(
          `[coord] persist progress failed ${latest.no}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const onEvent = (event: HarnessEvent): void => {
      progress = applyEvent(progress, event)
      view = toView(progress, startedAtMs)
      const nowMs = this.nowMs()
      const phaseChanged = progress.phase !== lastPhase
      if (phaseChanged) lastPhase = progress.phase

      persist(phaseChanged)

      if (phaseChanged || nowMs - lastCardAt >= this.opts.cardUpdateMs) {
        lastCardAt = nowMs
        this.scheduleCardUpdate(latest.id, view, startedAtMs, nowMs)
      }

      // 阶段播报：只在「开始验证」与「收尾」各一次，避免每换个工具就播一条。
      if (phaseChanged && (progress.phase === 'verifying' || progress.phase === 'finishing')) {
        if (nowMs - lastNoticeAt >= MIN_CARD_UPDATE_MS) {
          lastNoticeAt = nowMs
          void this.notify(latest.turns[0]?.messageId, heartbeatLine({ ticketNo: latest.no, view, nowMs }))
        }
      } else if (this.opts.progressNoticeMs > 0 && nowMs - lastNoticeAt >= this.opts.progressNoticeMs) {
        lastNoticeAt = nowMs
        void this.notify(latest.turns[0]?.messageId, heartbeatLine({ ticketNo: latest.no, view, nowMs }))
      }
    }

    // 长时间不产事件（例如一个慢命令）时也要有心跳，否则群里会以为它死了。
    const heartbeat =
      this.opts.progressNoticeMs > 0
        ? setInterval(() => {
            const nowMs = this.nowMs()
            if (nowMs - lastNoticeAt < this.opts.progressNoticeMs) return
            lastNoticeAt = nowMs
            void this.notify(latest.turns[0]?.messageId, heartbeatLine({ ticketNo: latest.no, view, nowMs }))
            this.scheduleCardUpdate(latest.id, view, startedAtMs, nowMs)
          }, Math.min(this.opts.progressNoticeMs, 30_000))
        : null
    heartbeat?.unref()

    let result: HarnessResult
    try {
      const isAppend = latest.turns.length > 1
      const currentText = latest.turns[latest.turns.length - 1].text
      const triageResult = triage(currentText)
      const env = this.envFor(latest.no)
      const prompt = isAppend
        ? buildAppendPrompt({
            env,
            userText: currentText,
            triage: triageResult,
            previousTurns: latest.turns.length - 1,
          })
        : buildCreatePrompt({ env, userText: currentText, triage: triageResult })

      this.opts.log(`[coord] run ${latest.no} append=${String(isAppend)} session=${latest.sessionId ?? '(new)'}`)
      result = await this.opts.runHarnessImpl({
        dshBin: this.opts.dshBin,
        nodePath: this.opts.nodePath,
        cwd: this.opts.repoPath,
        prompt,
        ...(latest.sessionId === null ? {} : { sessionId: latest.sessionId }),
        timeoutMs: this.opts.timeoutMs,
        ...(this.opts.childEnv === undefined ? {} : { env: this.opts.childEnv }),
        onEvent,
      })
    } finally {
      if (heartbeat !== null) clearInterval(heartbeat)
    }

    // 首轮把会话 id 落库；续接轮若返回同一个就不用重复写。
    if (result.sessionId !== null && result.sessionId !== latest.sessionId) {
      this.opts.store.bindSession(latest.id, result.sessionId, this.stamp())
    }

    // 状态映射：run 成功 → gated（有产出待部署）；失败/超时 → failed。
    const nextState = result.outcome === 'completed' ? 'gated' : 'failed'
    const summary = summarize(result, 400) || (result.error ?? '')
    const outcome: TicketResult['outcome'] =
      result.outcome === 'completed' ? 'completed' : result.outcome === 'timeout' ? 'timeout' : 'failed'
    try {
      this.opts.store.setResult(
        latest.id,
        { outcome, summary, durationMs: result.durationMs, at: this.stamp() },
        this.stamp(),
      )
    } catch (error) {
      this.opts.log(`[coord] persist result failed ${latest.no}: ${String(error)}`)
    }
    this.opts.store.setState(latest.id, nextState, this.stamp())

    const refreshed = this.opts.store.get(latest.id)
    if (refreshed === null) return
    // 先冲掉排队中的进度卡片更新，否则最后一张「施工中」蓝卡可能盖掉结果卡。
    await this.cardChain
    await this.transportSendResult(refreshed, result, latest.turns[latest.turns.length - 1].text)

    // 全自动上线：run 成功且有产出 → 排队部署（与 run 共用串行队列，不会并发）。
    if (this.opts.autoDeploy && result.outcome === 'completed') {
      this.enqueueDeploy({
        kind: 'auto',
        chatId: latest.chatId,
        ticketNo: latest.no,
        messageId: latest.turns[0]?.messageId ?? null,
      })
    }

    this.opts.log(
      `[coord] done ${latest.no} outcome=${result.outcome} state=${nextState} duration=${result.durationMs}ms tools=${result.counts.toolCalls} subagents=${result.counts.subagentCalls}`,
    )
  }

  /** 卡片原地更新。串行化，避免多个事件同时更新导致旧内容覆盖新内容。 */
  private scheduleCardUpdate(
    ticketId: string,
    view: ProgressView,
    startedAtMs: number,
    nowMs: number,
  ): void {
    if (this.opts.cardUpdateMs < 0) return
    this.cardChain = this.cardChain
      .then(async () => {
        const ticket = this.opts.store.get(ticketId)
        if (ticket === null || ticket.cardMessageId === null) return
        try {
          await this.opts.transport.updateCard(
            ticket.cardMessageId,
            progressCard({ ticketNo: ticket.no, view, nowMs, queueAhead: 0 }),
          )
        } catch (error) {
          this.opts.log(
            `[coord] updateCard failed ${ticket.no}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
      .catch((error: unknown) => {
        this.opts.log(`[coord] cardChain error: ${String(error)}`)
      })
  }

  /** 通用卡片更新：用当前工单状态构建内容。同样串行化。 */
  private scheduleCard(ticketId: string, build: (ticket: StoredTicket) => FeishuCard): void {
    this.cardChain = this.cardChain
      .then(async () => {
        const ticket = this.opts.store.get(ticketId)
        if (ticket === null || ticket.cardMessageId === null) return
        try {
          await this.opts.transport.updateCard(ticket.cardMessageId, build(ticket))
        } catch (error) {
          this.opts.log(
            `[coord] updateCard failed ${ticket.no}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
      .catch((error: unknown) => {
        this.opts.log(`[coord] cardChain error: ${String(error)}`)
      })
  }

  /** 回复一条消息。失败只记日志：进度播报失败不该影响 run。 */
  private async notify(messageId: string | undefined, text: string): Promise<void> {
    if (messageId === undefined || messageId.length === 0) return
    try {
      await this.opts.transport.replyText(messageId, text)
    } catch (error) {
      this.opts.log(
        `[coord] notify failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async transportSendResult(
    ticket: StoredTicket,
    result: HarnessResult,
    userText: string,
  ): Promise<void> {
    const card = resultCard({ ticketNo: ticket.no, state: ticket.state, result, userText })
    try {
      if (ticket.cardMessageId !== null) {
        await this.opts.transport.updateCard(ticket.cardMessageId, card)
      } else {
        await this.opts.transport.sendCard(ticket.chatId, card)
      }
    } catch (error) {
      this.opts.log(`[coord] sendResult failed ${ticket.no}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
