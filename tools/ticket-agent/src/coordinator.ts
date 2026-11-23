/**
 * Coordinator：飞书消息与 DSH 之间的唯一编排者。
 *
 * 它做四件事，每件都尽量薄：
 *   1. 把「这条消息要做什么」交给**调度器**（模型 + 工具），不再用正则猜（2026-11-20 改）；
 *   2. 用**结构判定**决定「追加到已有工单」还是「新单」——这条永远不由模型决定；
 *   3. 把口语需求交给 prompt-builder 转成专业 prompt，起一次 harness run；
 *   4. 把结果写回飞书卡片，成功则排队部署。
 *
 * 为什么换成 LLM 调度（2026-11-19 用户要求「不要再用正则去匹配用户说的话，自由度太低」）：
 * 关键词表覆盖不了人的说话方式。「再次尝试部署」被判成需求、回了一句「你希望它变成什么样」
 * 只是最近一次；每补一个词就多一份误判面，而且永远补不完没见过的说法。
 *
 * 为什么「追加还是新单」仍由代码判定（用户 2026-11-14 拍板，2026-11-19 再次确认）：
 * 语义相似度会误归单，而误归单比漏归单代价高得多 —— 一条需求被塞进错误的工单，
 * Agent 会拿着不相关上下文改代码。所以模型说「建新单」也不算，Coordinator 强制纠偏。
 *
 * 为什么单车道：Phase 1 实测构建期可用内存最低 152 MB，并行必然打满 swap。
 * 所以这里用一条串行队列，后来的工单排队而不是抢资源。
 * 非改代码的动作（回复、查进度）走另一条队列，不占改代码的位置。
 */

import type { FeishuCard, FeishuTransport } from './feishu-transport.ts'
import type { IncomingMessage } from './feishu-event.ts'
import {
  DEFAULT_GRACE_MS,
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
import {
  dispatch,
  summarizeTickets,
  type DispatchAction,
  type DispatchInput,
} from './dispatcher.ts'
import {
  INITIAL_PROGRESS,
  applyEvent,
  formatDuration,
  overviewText,
  progressCard,
  stateLabel,
  statusText,
  toStoredProgress,
  toView,
  type ProgressState,
  type ProgressView,
} from './progress.ts'
import {
  runDeploy,
  type DeployConfig,
  type DeployPhase,
  type DeployResult,
} from './deploy.ts'
import type { GitWorkspace, WorkspaceBegin } from './git-workspace.ts'

export interface CoordinatorOptions {
  store: TicketStore
  transport: FeishuTransport
  dshBin: string
  nodePath: string
  repoPath: string
  /** 子进程环境，通常含 DEEPSEEK_API_KEY。 */
  childEnv?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** 软截止提前量（毫秒）。到 timeoutMs - graceMs 时先发 SIGTERM 让 Agent 收口。 */
  graceMs?: number
  log?: (line: string) => void
  now?: () => Date
  /** 注入用：测试时替换真实 harness。 */
  runHarnessImpl?: typeof runHarness
  /** 注入用：测试时替换真实调度器，不真调模型。 */
  dispatchImpl?: typeof dispatch
  /** 调度模型密钥。空字符串时所有消息走兜底话术。 */
  dispatchKey?: string
  dispatchBaseUrl?: string
  dispatchModel?: string
  /** 注入用：替换模型请求。 */
  dispatchFetchImpl?: typeof fetch
  /**
   * 群内进度播报间隔，默认 0（关闭）。
   *
   * 2026-11-20 用户要求「播报太多啰嗦，信息刷屏，要精简」：群里只留开工、收尾、结束三条，
   * 周期心跳默认关掉。需要时用环境变量重开。
   */
  progressNoticeMs?: number
  /** 卡片原地更新间隔，默认 20 秒；负数表示不更新（测试用）。 */
  cardUpdateMs?: number
  /** 部署配置。为空表示这台机器没配部署能力（只提示，不执行）。 */
  deployConfig?: DeployConfig | null
  /** 注入用：测试时替换真实部署执行。 */
  deployImpl?: typeof runDeploy
  /** run 成功后是否自动部署（用户 2026-11-13 拍板「全自动上线」）。 */
  autoDeploy?: boolean
  /**
   * 工单工作区（2026-11-23 用户决定：每会话一条分支，成功才合入，失败丢弃）。
   * 为 null 时退回旧行为（所有单都在主干上改），测试里可显式关掉。
   */
  workspace?: GitWorkspace | null
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

/** 可以重跑的工单状态。done / deploying 重跑没有意义。 */
const RERUNNABLE_STATES = new Set(['needs_info', 'failed'])

/**
 * 判定路由。纯函数，可单测。
 *
 * 判定顺序固定，只有一条规则：
 *   消息的 parentId 或 rootId 命中某工单的 cardMessageId → 追加。
 * 其余一律新单。
 *
 * 这条规则**不看用户说了什么**，只看消息挂在谁下面 —— 这正是它不会被模型误判的原因。
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
  /** 分支收尾结论（合入 / 丢弃 / stash ref）。 */
  workspaceNote?: string
}): FeishuCard {
  const { result } = input
  const lines: string[] = []

  if (result.outcome === 'completed') {
    lines.push(`**结果**：已完成，改动在工作区等待部署`)
  } else if (result.outcome === 'timeout') {
    // 2026-11-22：不再只写「超时终止」。用户的原话是「45 分钟没收口强制截断」——
    // 现在先发 SIGTERM 让 Agent 收口，并把「做到哪了」写进卡片，
    // 否则群里只看到一个 timeout，等于这 45 分钟的信息全丢。
    const closed = result.error?.includes('SIGTERM') === true
    lines.push(`**结果**：${closed ? '已尽量收口后超时终止' : '超时终止（强制截断）'}（${Math.round(result.durationMs / 1000)} 秒）`)
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
  if (input.workspaceNote !== undefined && input.workspaceNote.length > 0) {
    lines.push(`**工作区**：${input.workspaceNote}`)
  }
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
  graceMs: number
  log: (line: string) => void
  runHarnessImpl: typeof runHarness
  dispatchImpl: typeof dispatch
  dispatchKey: string
  dispatchBaseUrl: string
  dispatchModel: string
  dispatchFetchImpl: typeof fetch | undefined
  progressNoticeMs: number
  cardUpdateMs: number
  deployConfig: DeployConfig | null
  deployImpl: typeof runDeploy
  autoDeploy: boolean
  workspace: GitWorkspace | null
}

export class Coordinator {
  private readonly opts: ResolvedOptions
  /** 串行队列：单车道，防止两单同时吃满 2 核。 */
  private queue: Promise<unknown> = Promise.resolve()
  /** 轻活队列：回复、查进度。不占改代码的车道，但 drain 时要等到。 */
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
      graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
      log: options.log ?? ((line) => console.log(line)),
      runHarnessImpl: options.runHarnessImpl ?? runHarness,
      dispatchImpl: options.dispatchImpl ?? dispatch,
      dispatchKey: options.dispatchKey ?? '',
      dispatchBaseUrl: options.dispatchBaseUrl ?? 'https://api.deepseek.com',
      dispatchModel: options.dispatchModel ?? 'deepseek-chat',
      dispatchFetchImpl: options.dispatchFetchImpl,
      progressNoticeMs: options.progressNoticeMs ?? 0,
      cardUpdateMs: options.cardUpdateMs ?? 20 * 1000,
      deployConfig: options.deployConfig ?? null,
      deployImpl: options.deployImpl ?? runDeploy,
      autoDeploy: options.autoDeploy ?? false,
      workspace: options.workspace ?? null,
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
   */
  async handle(message: IncomingMessage): Promise<HandleOutcome> {
    const at = this.stamp()
    const route = decideRoute(this.opts.store, message)
    const tickets = this.opts.store.all()

    const input: DispatchInput = {
      text: message.text,
      tickets: summarizeTickets(tickets, this.nowMs()),
      activeCount: tickets.filter(
        (ticket) => ticket.state === 'queued' || ticket.state === 'building',
      ).length,
      gated: tickets.filter((ticket) => ticket.state === 'gated').map((ticket) => ticket.no),
      deployEnabled: this.opts.deployConfig !== null,
      replyingToTicketNo: route.kind === 'append' ? route.ticket.no : null,
    }

    const dispatched = await this.opts.dispatchImpl(input, {
      apiKey: this.opts.dispatchKey,
      baseUrl: this.opts.dispatchBaseUrl,
      model: this.opts.dispatchModel,
      log: this.opts.log,
      ...(this.opts.dispatchFetchImpl === undefined ? {} : { fetchImpl: this.opts.dispatchFetchImpl }),
    })
    this.opts.log(
      `[coord] dispatch=${dispatched.action.kind} source=${dispatched.source}` +
        (dispatched.error === undefined ? '' : ` error=${dispatched.error}`),
    )

    const action = this.coerceAction(route, dispatched.action)
    return await this.execute(action, message, route, at)
  }

  /**
   * 硬规则纠偏。模型只负责「想做什么」，能不能这么做由这里定。
   *
   * 1. 回复工单卡片 → 一律追加。模型说建新单也不算。
   * 2. 追加但没给票号（模型对卡片回复用了 ask_more_info）→ 补上结构判定给的票号。
   */
  private coerceAction(route: RouteDecision, action: DispatchAction): DispatchAction {
    if (route.kind !== 'append') return action

    if (action.kind === 'create_ticket') {
      this.opts.log(
        `[coord] 纠偏：模型要给卡片回复建新单，按结构判定改成追加 ${route.ticket.no}`,
      )
      return {
        kind: 'append_ticket',
        ticketNo: route.ticket.no,
        ...(action.title === undefined ? {} : { title: action.title }),
        ...(action.hint === undefined ? {} : { hint: action.hint }),
      }
    }
    if (action.kind === 'ask_more_info' && action.ticketNo === null) {
      return { ...action, ticketNo: route.ticket.no }
    }
    return action
  }

  private async execute(
    action: DispatchAction,
    message: IncomingMessage,
    route: RouteDecision,
    at: string,
  ): Promise<HandleOutcome> {
    if (action.kind === 'deploy') {
      this.enqueueDeploy({ kind: 'command', messageId: message.messageId })
      return { outcome: 'answered', note: 'deploy:command' }
    }
    if (action.kind === 'status') {
      const answer = this.statusAnswer(action.ticketNo)
      this.enqueueAnswer(() => this.reply(message.messageId, answer))
      return {
        outcome: 'answered',
        note: 'status',
        ...(action.ticketNo === null ? {} : { ticketNo: action.ticketNo }),
      }
    }
    if (action.kind === 'reply') {
      this.enqueueAnswer(() => this.reply(message.messageId, action.text))
      return { outcome: 'answered', note: 'reply' }
    }
    if (action.kind === 'ask_more_info') {
      // 追问不该占用改代码车道：它不跑 run，只回一句话。
      return await this.askMoreInfo(action.question, action.ticketNo, message, at)
    }
    if (action.kind === 'start_run') {
      return await this.startRun(action.ticketNo, message, at)
    }
    if (action.kind === 'append_ticket') {
      return await this.appendTicket(action, message, route, at)
    }
    return await this.createTicket(action, message, at)
  }

  // ───────────────────────────── 轻活：回复与追问 ─────────────────────────────

  /**
   * 回一条消息。失败只记日志：回话失败不该影响别的动作。
   * 群里最怕的是 @ 了机器人却没有任何反应，所以失败时尽力再补一句。
   */
  private async reply(messageId: string, text: string): Promise<void> {
    try {
      await this.opts.transport.replyText(messageId, text)
    } catch (error) {
      this.opts.log(`[coord] reply failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 需求不够时追问。带票号的只回话，不建新单、不追加轮次。 */
  private async askMoreInfo(
    question: string,
    ticketNo: string | null,
    message: IncomingMessage,
    at: string,
  ): Promise<HandleOutcome> {
    if (ticketNo !== null) {
      const existing = this.opts.store.getByNo(ticketNo)
      if (existing !== null) {
        await this.reply(message.messageId, question)
        this.opts.log(`[coord] ask-more-info ${existing.no}`)
        return { outcome: 'answered', ticketNo: existing.no, note: 'ask-more-info', state: existing.state }
      }
    }
    // 留一张 needs_info 的工单：用户补充的消息要能接回去，也得能追溯「他到底说过什么」。
    const ticket = this.opts.store.create({
      messageId: message.messageId,
      chatId: message.chatId,
      text: message.text,
      at,
      state: 'needs_info',
    })
    await this.reply(message.messageId, question)
    this.opts.log(`[coord] needs-info ${ticket.no}`)
    return { outcome: 'needs-info', ticketNo: ticket.no, state: ticket.state }
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

  // ───────────────────────────── 改代码路径 ─────────────────────────────

  private async createTicket(
    action: Extract<DispatchAction, { kind: 'create_ticket' }>,
    message: IncomingMessage,
    at: string,
  ): Promise<HandleOutcome> {
    const ticket = this.opts.store.create({
      messageId: message.messageId,
      chatId: message.chatId,
      text: message.text,
      at,
      state: 'received',
      hint: action.hint ?? null,
    })
    const ahead = this.pendingAhead()
    const lines: string[] = []
    if (ahead > 0) lines.push(`**排队**：前面还有 ${ahead} 张单`)
    if (action.title !== undefined) lines.push(`**摘要**：${truncate(action.title, 60)}`)
    lines.push(`**原话**：${truncate(message.text, 200)}`)

    // 主卡片的 message_id 是「回复卡片 = 追加」的锚点，必须先发再入队。
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

  private async appendTicket(
    action: Extract<DispatchAction, { kind: 'append_ticket' }>,
    message: IncomingMessage,
    route: RouteDecision,
    at: string,
  ): Promise<HandleOutcome> {
    const target = route.kind === 'append' ? route.ticket : this.opts.store.getByNo(action.ticketNo)
    if (target === null) {
      await this.reply(
        message.messageId,
        `没找到 ${action.ticketNo}。如果这是新需求，直接说要改哪里就行，我另开一张单。`,
      )
      return { outcome: 'answered', note: 'append-missing' }
    }

    const ticket = this.opts.store.appendTurn(target.id, {
      messageId: message.messageId,
      text: message.text,
      at,
      hint: action.hint ?? null,
    })
    this.opts.log(`[coord] append ${ticket.no} reason=${route.kind === 'append' ? route.reason : '模型指名'}`)
    await this.reply(ticket.cardMessageId ?? message.messageId, `已收到 ${ticket.no} 的追加需求，排队中。`)
    this.enqueue(ticket)
    return { outcome: 'appended', ticketNo: ticket.no, state: ticket.state }
  }

  /**
   * 让已有工单重跑一轮。
   *
   * 只有 `needs_info`（用户补了信息）与 `failed`（重试）有意义：
   * `done` 的成果已经上线，重跑会拿旧需求再改一遍；`deploying` 正在切生产。
   */
  private async startRun(ticketNo: string, message: IncomingMessage, at: string): Promise<HandleOutcome> {
    const ticket = this.opts.store.getByNo(ticketNo)
    if (ticket === null) {
      await this.reply(message.messageId, `没找到 ${ticketNo}。`)
      return { outcome: 'answered', note: 'start-run-missing' }
    }
    if (!RERUNNABLE_STATES.has(ticket.state)) {
      await this.reply(
        message.messageId,
        `${ticket.no} 现在是「${stateLabel(ticket.state)}」，重跑不会带来新结果。要有新改动，直接说改哪里。`,
      )
      return { outcome: 'answered', ticketNo: ticket.no, state: ticket.state, note: 'start-run-skip' }
    }
    const queued = this.opts.store.setState(ticket.id, 'queued', at)
    await this.reply(ticket.cardMessageId ?? message.messageId, `${ticket.no} 重新排队开工。`)
    this.enqueue(queued)
    return { outcome: 'ran', ticketNo: ticket.no, state: 'queued' }
  }

  /** 入队。同一时刻只跑一个 run。 */
  private enqueue(ticket: StoredTicket): void {
    this.queue = this.queue
      .then(() => this.runTicket(ticket))
      .catch((error: unknown) => {
        this.opts.log(`[coord] queue error ${ticket.no}: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** 轻活入队。与改代码车道分开，避免一句提问等 15 分钟。 */
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
   * 群里只留三条播报（2026-11-20 用户要求精简）：开工、收尾、结果。
   * 卡片原地更新不新增消息，所以保留，但只写三行。
   * 进度落盘与播报解耦：重启后仍答得出「T-0007 进度」。
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
    const firstMessageId = latest.turns[0]?.messageId

    this.scheduleCardUpdate(latest.id, view, startedAtMs, startedAtMs)
    await this.notify(firstMessageId, `${latest.no} 已开工，预计 10–20 分钟。`)

    let lastCardAt = startedAtMs
    let lastPersistAt = startedAtMs
    let lastPhase = progress.phase
    /** 收尾播报只发一次：阶段可能来回跳，播报不能跟着来回。 */
    let closingNotified = false

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

      if (phaseChanged && progress.phase === 'finishing' && !closingNotified) {
        closingNotified = true
        void this.notify(firstMessageId, `${latest.no} 在收尾，马上出结果。`)
      }
    }

    let result: HarnessResult
    /**
     * 工单工作区（2026-11-23）：每单一条分支，成功才合入主干，失败一律丢弃。
     * begin 失败不阻断 run —— 宁可跑在主干上（旧行为），也不能因为分支拉不出来就完全不干活；
     * 但会写进结论，让人知道这单没有隔离保护。
     */
    let workspaceBegun: WorkspaceBegin | null = null
    if (this.opts.workspace !== null) {
      try {
        workspaceBegun = await this.opts.workspace.begin(latest.no)
        this.opts.store.setBranch(latest.id, workspaceBegun.branch, workspaceBegun.baseSha, this.stamp())
      } catch (error) {
        this.opts.log(
          `[coord] workspace begin failed ${latest.no}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    try {
      const isAppend = latest.turns.length > 1
      const currentTurn = latest.turns[latest.turns.length - 1]
      const hint = currentTurn?.hint ?? undefined
      const env = this.envFor(latest.no)
      const prompt = isAppend
        ? buildAppendPrompt({
            env,
            userText: currentTurn.text,
            ...(hint === undefined || hint === null ? {} : { hint }),
            previousTurns: latest.turns.length - 1,
          })
        : buildCreatePrompt({
            env,
            userText: currentTurn.text,
            ...(hint === undefined || hint === null ? {} : { hint }),
          })

      this.opts.log(`[coord] run ${latest.no} append=${String(isAppend)} session=${latest.sessionId ?? '(new)'}`)
      result = await this.opts.runHarnessImpl({
        dshBin: this.opts.dshBin,
        nodePath: this.opts.nodePath,
        cwd: this.opts.repoPath,
        prompt,
        ...(latest.sessionId === null ? {} : { sessionId: latest.sessionId }),
        timeoutMs: this.opts.timeoutMs,
        graceMs: this.opts.graceMs,
        ...(this.opts.childEnv === undefined ? {} : { env: this.opts.childEnv }),
        onEvent,
      })
    } finally {
      // 没有周期心跳，所以这里没有定时器要清。
    }

    // 首轮把会话 id 落库；续接轮若返回同一个就不用重复写。
    if (result.sessionId !== null && result.sessionId !== latest.sessionId) {
      this.opts.store.bindSession(latest.id, result.sessionId, this.stamp())
    }

    // ── 工作区收尾（2026-11-23）：成功才合入主干，失败一律丢弃 ──
    //
    // 失败单已提交的改动 → 删分支（主干绝不被污染）；
    // 未提交的残留 → stash（现场绝不销毁，ref 写进结论）。
    let workspaceNote = ''
    if (this.opts.workspace !== null && workspaceBegun !== null) {
      try {
        const finish =
          result.outcome === 'completed'
            ? await this.opts.workspace.finishSuccess(latest.no)
            : await this.opts.workspace.finishFailure(latest.no)
        if (finish.stashed !== null) {
          this.opts.store.setStash(latest.id, finish.stashed, this.stamp())
        }
        const parts: string[] = []
        if (finish.merged) parts.push(`已合入主干 ${finish.mergedSha === null ? '' : finish.mergedSha.slice(0, 8)}`)
        else if (finish.conflict) parts.push('与主干冲突，未合入（分支已保留，需人工决定）')
        else parts.push('未合入主干')
        if (finish.stashed !== null) parts.push(`残留已暂存为 ${finish.stashed}`)
        workspaceNote = `分支 ${workspaceBegun.branch}：${parts.join('；')}`
        this.opts.log(`[coord] workspace ${latest.no} ${workspaceNote}`)
      } catch (error) {
        workspaceNote = `分支收尾失败：${error instanceof Error ? error.message : String(error)}`
        this.opts.log(`[coord] workspace finish failed ${latest.no}: ${workspaceNote}`)
      }
    }

    // 状态映射：run 成功 → gated（有产出待部署）；失败/超时 → failed。
    const nextState = result.outcome === 'completed' ? 'gated' : 'failed'
    const summaryBase = summarize(result, 400) || (result.error ?? '')
    const summary = workspaceNote.length === 0 ? summaryBase : `${summaryBase}\n${workspaceNote}`
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
    await this.transportSendResult(
      refreshed,
      result,
      latest.turns[latest.turns.length - 1].text,
      workspaceNote,
    )

    // 全自动上线：run 成功且有产出 → 排队部署（与 run 共用串行队列，不会并发）。
    if (this.opts.autoDeploy && result.outcome === 'completed') {
      this.enqueueDeploy({
        kind: 'auto',
        chatId: latest.chatId,
        ticketNo: latest.no,
        messageId: firstMessageId ?? null,
      })
    }

    this.opts.log(
      `[coord] done ${latest.no} outcome=${result.outcome} state=${nextState} duration=${result.durationMs}ms tools=${result.counts.toolCalls} subagents=${result.counts.subagentCalls}`,
    )
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

    // 部署不发周期心跳：开始一条、结束一条，中间靠卡片原地更新。
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
    } catch (error) {
      // 部署器本身抛异常（不该发生，但发生了不能让工单永远卡在 deploying）。
      const reason = error instanceof Error ? error.message : String(error)
      this.opts.log(`[coord] deployImpl threw: ${reason}`)
      result = {
        ok: false,
        pushed: false,
        rolledBack: false,
        release: '(unknown)',
        previousVersion: '(unknown)',
        backupDir: null,
        phase: 'failed',
        failure: `部署器异常：${reason}`,
        warning: null,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: this.stamp(),
        durationMs: Math.max(0, this.nowMs() - startedAt),
      }
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
      '预计 20–35 分钟（这台机器 2 核），完成后我回一条结果。',
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
      footer: `${ticket.no}｜部署记录：/opt/dilee/deploys/`,
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

  // ───────────────────────────── 卡片 ─────────────────────────────

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
    await this.reply(messageId, text)
  }

  private async transportSendResult(
    ticket: StoredTicket,
    result: HarnessResult,
    userText: string,
    workspaceNote = '',
  ): Promise<void> {
    const card = resultCard({
      ticketNo: ticket.no,
      state: ticket.state,
      result,
      userText,
      ...(workspaceNote.length === 0 ? {} : { workspaceNote }),
    })
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
