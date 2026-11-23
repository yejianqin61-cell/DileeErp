/**
 * 工单工作区：每张工单一条分支，成功才合入主干，失败一律丢弃。
 *
 * 为什么需要这一层（2026-11-23 用户决定）：串行执行保证了 git 不冲突，但没保证**工作区干净**。
 * 2026-11-21 的真实事故：三张失败单（T-0024/25/26）留下 11 个文件、676 行未提交改动，
 * 一直躺在树里 —— 后果是部署预检（要求工作区干净）把自己锁住，且下一张单会继承这批半成品
 * （T-0019 的残留就这样传染给了 T-0020）。
 *
 * 为什么不并发：2 vCPU / 1.7 GB，一次构建就打满内存；更要紧的是语义篡改 ——
 * 两个 Agent 同时改同一批文件，git 不冲突，但可能互相推翻对方的意图，且难以审。
 * 所以受理可以并行排队，执行永远串行。用户 2026-11-23 再次确认这条。
 *
 * 为什么用分支而不是 worktree：已经决定不并发，worktree 唯一的优势（天然隔离目录）
 * 可以用「开工前清洁 + 收尾 stash」零成本换到；而每单多 2–3 分钟 `npm ci` 与上 GB 磁盘
 * 是实付成本。将来真要并行，把这个模块内部换成 worktree 即可，接口不变。
 *
 * 两条不能混淆的处置（用户同一条消息里都提了，容易读成矛盾）：
 *   - 成功单**工作区里未提交**的改动 → 提交到**工单分支**，再 `--no-ff` 合入主干。
 *     （2026-11-23 T-0027 事故后改成这样：旧顺序是「先 stash 残留 → 再 merge」，
 *     等于把 43 分钟的产出整个扔掉，还回一句「已合入主干」。详见 `finishSuccess`。）
 *   - 失败单**已提交**的改动 → 打 `abandoned/<票号>-<时间戳>` tag 留证后删分支。主干绝不被污染。
 *   - 收尾时**未提交**的残留 → `git stash push -u` 收进 stash，ref 写进工单结论。现场绝不销毁。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import type { CommandResult, CommandRunner } from './deploy.ts'

export interface WorkspaceBegin {
  readonly branch: string
  readonly baseSha: string
  /** 开工前若有脏文件，已被 stash 到这里。 */
  readonly stashedBefore: string | null
}

export interface WorkspaceFinish {
  /**
   * 是否**真的**把提交合进了主干。
   *
   * 硬约束：主干 sha 没变就必须是 false，`detail` 必须说清真相。
   * 2026-11-23 T-0027 事故就是这里撒谎 —— 分支停在基线，`merge` 只回了句
   * `Already up to date`，一个字节没进主干，却返回 `merged: true` / 「已合入主干」。
   */
  readonly merged: boolean
  /** 合并后的主干 HEAD sha；未合入时为 null。 */
  readonly mergedSha: string | null
  /** 这次合并真正带进主干的提交数；未合入时为 0。 */
  readonly mergedCommits: number
  /** 成功收尾时自动提交到工单分支的 sha（工作区本来就干净时为 null）。 */
  readonly autoCommitted: string | null
  /** 失败收尾时为留证打的 tag 名（分支上本来就没有提交时为 null）。 */
  readonly abandonedTag: string | null
  /** 收尾时把未提交残留收进的 stash ref。 */
  readonly stashed: string | null
  /** merge 冲突：未合入、分支保留，需人工决定。 */
  readonly conflict: boolean
  readonly detail: string
}

export interface RecoverResult {
  /** 被恢复掉的分支（说明上次进程没正常收尾）。 */
  readonly recoveredBranch: string | null
  readonly stashed: string | null
  /** 仍在的其它工单分支，只报告不删除（可能是等人工处理冲突的）。 */
  readonly leftoverBranches: readonly string[]
}

export interface GitWorkspaceOptions {
  /** git 仓库绝对路径。 */
  readonly repoPath: string
  /**
   * 本地主干分支名。**注意不是 GitHub 上的 `main`**：
   * 部署仓本地分支是 `agent/main`，部署时推的是 `HEAD:refs/heads/main`。
   */
  readonly mainBranch: string
  /** 注入用，测试可替换。 */
  readonly runner?: CommandRunner
  readonly log?: (line: string) => void
  readonly now?: () => Date
}

/** 默认 git 执行器：短命令，不需要 run 标记与进程组清理。 */
export function createGitRunner(): CommandRunner {
  return async (input) => {
    return await new Promise<CommandResult>((resolve) => {
      const child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      const timer =
        input.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              child.kill('SIGKILL')
            }, input.timeoutMs)
      child.on('error', (error) => {
        if (timer !== null) clearTimeout(timer)
        resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` })
      })
      child.on('close', (code) => {
        if (timer !== null) clearTimeout(timer)
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  }
}

/** 分支名：`T-0027` → `ticket/T-0027`。非字母数字一律折成 `-`，避免非法分支名。 */
export function branchFor(ticketNo: string): string {
  const safe = ticketNo.replace(/[^A-Za-z0-9._-]/g, '-')
  return `ticket/${safe}`
}

function shortSha(value: string): string {
  return value.trim().slice(0, 8)
}

/** 票号 → 可安全放进分支名 / tag 名的片段。 */
function safeRefPart(ticketNo: string): string {
  return ticketNo.replace(/[^A-Za-z0-9._-]/g, '-')
}

/**
 * 留证 tag 的时间戳：`2026-11-23T09:30:36.000Z` → `20261123T093036Z`。
 *
 * 用紧凑格式是为了让 tag 名可以直接当文件名 / 逗号分隔贴进卡片，
 * 且不带 `:`（Windows 上某些工具链拿到带冒号的 ref 名会出问题）。
 */
function compactTimestamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

export class GitWorkspace {
  private readonly repoPath: string
  private readonly mainBranch: string
  private readonly runner: CommandRunner
  private readonly log: (line: string) => void
  private readonly now: () => Date

  constructor(options: GitWorkspaceOptions) {
    this.repoPath = options.repoPath
    this.mainBranch = options.mainBranch
    this.runner = options.runner ?? createGitRunner()
    this.log = options.log ?? (() => {})
    this.now = options.now ?? (() => new Date())
  }

  private git(args: readonly string[]): Promise<CommandResult> {
    return this.runner({
      command: 'git',
      args: [...args],
      // 历史上漏过一次 cwd，导致 `merge-base ... HEAD` 跑在进程目录里误判基线。
      cwd: this.repoPath,
      timeoutMs: 120_000,
    })
  }

  async currentBranch(): Promise<string> {
    const result = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])
    return result.code === 0 ? result.stdout.trim() : '(unknown)'
  }

  async isDirty(): Promise<boolean> {
    const result = await this.git(['status', '--porcelain'])
    return result.code === 0 && result.stdout.trim().length > 0
  }

  async branchExists(branch: string): Promise<boolean> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return result.code === 0
  }

  async headSha(): Promise<string | null> {
    const result = await this.git(['rev-parse', 'HEAD'])
    return result.code === 0 ? result.stdout.trim() : null
  }

  /**
   * 把工作区残留收进 stash，返回 ref。工作区本来就干净时返回 null。
   *
   * `-u` 必须带：未跟踪文件（新写的组件、新测试）正是最容易污染下一单、
   * 又最容易被 `git checkout` 直接带过去的东西。
   */
  async stashResidue(label: string): Promise<string | null> {
    if (!(await this.isDirty())) return null
    const message = `${label}-${this.now().toISOString().replace(/[:.]/g, '')}`
    const stash = await this.git(['stash', 'push', '-u', '-m', message])
    if (stash.code !== 0) {
      this.log(`[ws] stash 失败：${stash.stderr.trim().slice(0, 200)}`)
      return null
    }
    const verify = await this.git(['rev-parse', 'stash@{0}'])
    const sha = verify.code === 0 ? shortSha(verify.stdout) : ''
    const ref = sha.length > 0 ? `stash@{0}（${sha}）` : 'stash@{0}'
    this.log(`[ws] 残留已暂存：${ref} label=${message}`)
    return ref
  }

  /**
   * 开工：确保干净 → 切回主干 → 从主干拉一条工单分支。
   *
   * 若当前停在别的工单分支上（上次进程被强杀），先按恢复流程收走，
   * 否则 `checkout -b` 会在旧分支上叠分支，改动来源就说不清了。
   */
  async begin(ticketNo: string): Promise<WorkspaceBegin> {
    const recovered = await this.leaveTicketBranch('stale-on-begin')
    const stashedBefore = recovered.stashed ?? (await this.stashResidue(`residue-before-${ticketNo}`))

    const base = await this.git(['rev-parse', this.mainBranch])
    const baseSha = base.code === 0 ? base.stdout.trim() : ''
    if (baseSha.length === 0) {
      throw new Error(`读不到主干 ${this.mainBranch} 的 sha：${base.stderr.trim().slice(0, 200)}`)
    }

    const branch = branchFor(ticketNo)
    // 同名残留分支先删掉：它属于上一次没正常收尾的同号工单，内容不可信。
    if (await this.branchExists(branch)) {
      this.log(`[ws] 删除同名残留分支 ${branch}`)
      await this.git(['branch', '-D', branch])
    }

    const create = await this.git(['checkout', '-b', branch, this.mainBranch])
    if (create.code !== 0) {
      throw new Error(`创建分支 ${branch} 失败：${create.stderr.trim().slice(0, 200)}`)
    }
    this.log(`[ws] 开工 ${ticketNo} → ${branch}（基线 ${shortSha(baseSha)}）`)
    return { branch, baseSha, stashedBefore }
  }

  /**
   * 成功收尾：先在**工单分支上提交**工作区改动 → 切主干 → `merge --no-ff` → 删分支。
   *
   * 为什么必须先提交再合并（2026-11-23 T-0027 事故）：旧顺序是「先 `stashResidue` 残留 →
   * 再 merge」。T-0027 跑满 43 分钟、4 个文件改好了但一个 commit 都没做（它打算验证完再提交，
   * 没走到那步），旧顺序把 4 个文件的全部改动推进 stash，分支还停在基线上，
   * `merge` 只回了句 `Already up to date`，**主干一个字节都没变**，
   * 函数却返回 `merged: true` / 「已合入主干」→ 工单被推进 gated，卡片骗了用户。
   *
   * 工单成功的定义是「需求已实现」，此时工作区里的改动**就是**产出。
   * 把它 stash 掉、再合一个空分支，是自欺。而提交到工单分支再 `--no-ff` 合入，
   * `git log --graph` 里仍然能看清每一笔改动来自哪张工单，「提交 → 审阅 → 门禁」这条链一点没绕过。
   *
   * 报告口径（同一条铁律）：主干 sha 没变，就绝不写「已合入」。
   *   - 分支相对主干零提交 → 不调用 merge（否则 git 只回 `Already up to date`，假装成功）。
   *   - merge 成功但 HEAD 没动 → 同样 `merged: false`。
   *
   * 用 `--no-ff` 是为了让「这一批改动来自哪张工单」在 `git log --graph` 里看得见，
   * 而不是一堆平铺提交。冲突不自动解：冲突意味着两个工单动了同一处语义，
   * 机器替人裁决生产代码的代价远高于让人看一次。
   */
  async finishSuccess(ticketNo: string): Promise<WorkspaceFinish> {
    const branch = branchFor(ticketNo)

    // ① 工作区脏 → 在工单分支上提交（这就是产出）。提交失败才退回 stash。
    let stashed: string | null = null
    let autoCommitted: string | null = null
    if (await this.isDirty()) {
      if ((await this.currentBranch()) === branch) {
        try {
          autoCommitted = await this.commitResidue(`ticket(${ticketNo}): 工单产出（收尾自动提交）`)
        } catch (error) {
          this.log(`[ws] 自动提交失败，退回 stash：${error instanceof Error ? error.message : String(error)}`)
          stashed = await this.stashResidue(`${ticketNo}-uncommitted-on-success`)
        }
      } else {
        // 不在工单分支上：这些改动归属说不清，绝不能提交到主干，退回 stash 取证。
        stashed = await this.stashResidue(`${ticketNo}-uncommitted-on-success`)
      }
    }

    // ② 切回主干。
    const back = await this.git(['checkout', this.mainBranch])
    if (back.code !== 0) {
      return this.finishResult({
        stashed,
        autoCommitted,
        detail: `切回 ${this.mainBranch} 失败：${back.stderr.trim().slice(0, 200)}`,
      })
    }
    const mainBefore = await this.headSha()

    if (!(await this.branchExists(branch))) {
      return this.finishResult({
        stashed,
        autoCommitted,
        detail: `分支 ${branch} 不存在（Agent 可能直接提交到了主干）`,
      })
    }

    // ③ 先数提交：零提交就根本不该调 merge。
    const commits = await this.countCommits(this.mainBranch, branch)
    if (commits === null) {
      return this.finishResult({
        stashed,
        autoCommitted,
        detail: `读不到分支 ${branch} 的提交数，未合入（请人工确认）`,
      })
    }
    if (commits === 0) {
      // 零提交：分支只是个指向基线的空壳，删掉它，但绝不谎报合入。
      const del = await this.git(['branch', '-d', branch])
      this.log(`[ws] ${ticketNo} 没有任何提交产出，主干未变${del.code === 0 ? '（空分支已删）' : ''}`)
      return this.finishResult({
        stashed,
        autoCommitted,
        detail: `本单没有任何提交产出，主干未变`,
      })
    }

    // ④ 真合入。
    const merge = await this.git(['merge', '--no-ff', '-m', `merge(${ticketNo}): 工单收尾合入`, branch])
    if (merge.code !== 0) {
      await this.git(['merge', '--abort'])
      this.log(`[ws] ${ticketNo} 合入冲突，分支保留待人工处理`)
      return this.finishResult({
        stashed,
        autoCommitted,
        conflict: true,
        detail: `与 ${this.mainBranch} 冲突，已中止合入，分支 ${branch} 保留：${merge.stderr.trim().slice(0, 200)}`,
      })
    }

    const head = await this.headSha()
    if (head === null || head === mainBefore) {
      // merge 说成功，但 HEAD 没动（`Already up to date`）。主干没变，就不能说合入。
      // 分支保留：它上面还有未进主干的提交，删了就没了。
      this.log(`[ws] ${ticketNo} merge 未产生新提交（HEAD 未变），按未合入报告，分支 ${branch} 保留`)
      return this.finishResult({
        stashed,
        autoCommitted,
        detail: `主干未变（Already up to date），分支 ${branch} 保留`,
      })
    }

    const del = await this.git(['branch', '-d', branch])
    if (del.code !== 0) this.log(`[ws] 删除分支 ${branch} 失败：${del.stderr.trim().slice(0, 120)}`)
    this.log(`[ws] ${ticketNo} 已合入 ${this.mainBranch}（${commits} 个提交，至 ${shortSha(head)}）`)

    const extra: string[] = []
    if (autoCommitted !== null) extra.push(`收尾自动提交 ${shortSha(autoCommitted)}`)
    if (stashed !== null) extra.push(`未提交残留已暂存为 ${stashed}`)
    if (del.code !== 0) extra.push(`分支 ${branch} 删除失败`)
    const suffix = extra.length === 0 ? '' : `；${extra.join('；')}`
    return {
      merged: true,
      mergedSha: head,
      mergedCommits: commits,
      autoCommitted,
      abandonedTag: null,
      stashed,
      conflict: false,
      detail: `已合入 ${this.mainBranch}（${commits} 个提交，至 ${shortSha(head)}）${suffix}`,
    }
  }

  /** 未合入时的统一形状：`merged` 恒为 false，`mergedCommits` 恒为 0。 */
  private finishResult(input: {
    readonly detail: string
    readonly stashed: string | null
    readonly autoCommitted?: string | null
    readonly abandonedTag?: string | null
    readonly conflict?: boolean
  }): WorkspaceFinish {
    return {
      merged: false,
      mergedSha: null,
      mergedCommits: 0,
      autoCommitted: input.autoCommitted ?? null,
      abandonedTag: input.abandonedTag ?? null,
      stashed: input.stashed,
      conflict: input.conflict ?? false,
      detail: input.detail,
    }
  }

  /**
   * 把工作区里未提交的改动提交到**当前分支**，返回提交后的 HEAD sha。
   *
   * 只在确定当前就在工单分支上时调用 —— 这个函数会真的落一个 commit，
   * 在主干上调用就等于把未审的改动直接塞进主干。
   *
   * 提交失败就抛错，由调用方退回 `stashResidue`：现场绝不销毁。
   */
  private async commitResidue(message: string): Promise<string | null> {
    if (!(await this.isDirty())) return null
    const add = await this.git(['add', '-A'])
    if (add.code !== 0) {
      throw new Error(`git add -A 失败：${add.stderr.trim().slice(0, 200)}`)
    }
    const commit = await this.git(['commit', '-m', message])
    if (commit.code !== 0) {
      throw new Error(`git commit 失败：${commit.stderr.trim().slice(0, 200)}`)
    }
    const sha = await this.headSha()
    this.log(`[ws] 工单产出已提交到当前分支：${sha === null ? '?' : shortSha(sha)}（${message}）`)
    return sha
  }

  /**
   * 数 `base..tip` 上的提交数（= 一次 `--no-ff` 合并会带进主干的提交数）。
   *
   * 读不到时返回 null 而不是 0：这时候必须停下报告，不能凭空断言「合入了 0 个」或「已合入」。
   */
  private async countCommits(base: string, tip: string): Promise<number | null> {
    const result = await this.git(['rev-list', '--count', `${base}..${tip}`])
    if (result.code !== 0) {
      this.log(`[ws] 读不到 ${base}..${tip} 的提交数：${result.stderr.trim().slice(0, 200)}`)
      return null
    }
    const parsed = Number.parseInt(result.stdout.trim(), 10)
    return Number.isFinite(parsed) ? parsed : null
  }

  /**
   * 给即将丢弃的分支打一个轻量 tag 留证，返回 tag 名；失败返回 null。
   *
   * 打 tag 而不是保留分支：分支留在仓库里会和「开工时删同名残留分支」的流程打架
   * （下一次同号工单开工要删它），而 tag 不占分支命名空间、`git log --graph` 之外
   * 还能直接 `git show <tag>` 找回原始产出。
   */
  private async tagAbandoned(ticketNo: string, branch: string): Promise<string | null> {
    const tag = `abandoned/${safeRefPart(ticketNo)}-${compactTimestamp(this.now())}`
    const created = await this.git(['tag', tag, `refs/heads/${branch}`])
    if (created.code !== 0) {
      this.log(`[ws] 打 tag ${tag} 失败：${created.stderr.trim().slice(0, 200)}`)
      return null
    }
    this.log(`[ws] 丢弃前留证：${tag}`)
    return tag
  }

  /**
   * 失败收尾：stash 残留 → 切主干 → 给已提交的改动打 tag 留证 → 删分支。
   *
   * 顺序不能反：必须先 stash，再切分支 —— 切分支会把未跟踪文件带到主干上去。
   *
   * 为什么删分支前要打 tag（2026-11-23 用户原则「不合并 ≠ 销毁现场」）：
   * 旧实现直接 `branch -D`，失败单里已经提交的调试过程就随分支一起没了，
   * 事后想看一眼「它到底改到哪一步」都做不到。tag 指在分支 tip 上，
   * 不动主干、不占分支名，`git show abandoned/<票号>-<时间戳>` 就能把现场捞回来。
   * **没有提交就不打 tag**：空分支没有现场可留，多一个 tag 只会让人以为有东西可看。
   *
   * 未提交的残留照旧走 `stashResidue`，那是用户明确要求的「残留已暂存为 stash@{n}」。
   */
  async finishFailure(ticketNo: string): Promise<WorkspaceFinish> {
    const branch = branchFor(ticketNo)
    const stashed = await this.stashResidue(`${ticketNo}-failed-residue`)

    const current = await this.currentBranch()
    if (current !== this.mainBranch) {
      const back = await this.git(['checkout', this.mainBranch])
      if (back.code !== 0) {
        return this.finishResult({
          stashed,
          detail: `切回 ${this.mainBranch} 失败，分支 ${branch} 保留：${back.stderr.trim().slice(0, 200)}`,
        })
      }
    }

    if (!(await this.branchExists(branch))) {
      return this.finishResult({
        stashed,
        detail: `分支 ${branch} 不存在（无可丢弃的提交）`,
      })
    }

    const commits = await this.countCommits(this.mainBranch, branch)
    if (commits === null) {
      // 数不清有多少提交就不敢删：删错了就再也找不回来。
      return this.finishResult({
        stashed,
        detail: `读不到分支 ${branch} 的提交数，未删除分支（请人工确认）`,
      })
    }

    let tag: string | null = null
    if (commits > 0) {
      tag = await this.tagAbandoned(ticketNo, branch)
      if (tag === null) {
        // tag 打不上就不删分支：宁可留一条待人工处理的分支，也不能悄悄销毁产出。
        return this.finishResult({
          stashed,
          detail: `打 tag 留证失败，分支 ${branch}（${commits} 个提交）保留未删（请人工确认）`,
        })
      }
    }

    const del = await this.git(['branch', '-D', branch])
    const removed = del.code === 0
    const detail =
      tag === null
        ? `已丢弃分支 ${branch}（无提交产出，未打 tag）`
        : `已丢弃分支 ${branch}（${commits} 个提交已打 tag ${tag} 留证，不进主干）`
    const finalDetail = removed ? detail : `${detail}；删除失败：${del.stderr.trim().slice(0, 120)}`
    this.log(`[ws] ${ticketNo} 失败收尾：${finalDetail}`)
    return this.finishResult({ stashed, abandonedTag: tag, detail: finalDetail })
  }

  /**
   * 启动恢复：把停在工单分支上的中间态收走。
   *
   * 对应 2026-11-21 的事故：进程被强杀后工作区停在工单分支上，残留一直没人管。
   * 只处理「当前所在」的工单分支；其它工单分支只报告不删 —— 那可能是等人工处理冲突的。
   */
  async recover(): Promise<RecoverResult> {
    const left = await this.leaveTicketBranch('stale-on-startup')
    const leftover = await this.git(['branch', '--list', 'ticket/*', '--format=%(refname:short)'])
    const leftoverBranches =
      leftover.code === 0
        ? leftover.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
        : []
    if (leftoverBranches.length > 0) {
      this.log(`[ws] 仍有工单分支：${leftoverBranches.join('、')}（只报告，不删除）`)
    }
    return { recoveredBranch: left.recovered, stashed: left.stashed, leftoverBranches }
  }

  /**
   * 若当前不在主干上：stash 残留 → 切回主干 → 删除该分支。
   * 返回被处理的分支名；本来就在主干上则返回 null。
   */
  private async leaveTicketBranch(label: string): Promise<{ recovered: string | null; stashed: string | null }> {
    const current = await this.currentBranch()
    if (current === this.mainBranch) return { recovered: null, stashed: null }
    this.log(`[ws] 当前在 ${current}（非主干），执行恢复：${label}`)

    const stashed = await this.stashResidue(`${label}-${current.replace(/[^A-Za-z0-9._-]/g, '-')}`)
    const back = await this.git(['checkout', this.mainBranch])
    if (back.code !== 0) {
      this.log(`[ws] 切回 ${this.mainBranch} 失败：${back.stderr.trim().slice(0, 200)}`)
      return { recovered: null, stashed }
    }
    if (current.startsWith('ticket/')) {
      await this.git(['branch', '-D', current])
      this.log(`[ws] 已删除中断的工单分支 ${current}`)
    }
    return { recovered: current, stashed }
  }
}

/** 便于测试与日志：一次性的随机标签。 */
export function workspaceRunTag(): string {
  return `ws-${randomUUID().slice(0, 8)}`
}
