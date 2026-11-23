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
 *   - 失败单**已提交**的改动 → 删分支，丢弃。主干绝不被污染。
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
  /** 是否已合入主干。 */
  readonly merged: boolean
  readonly mergedSha: string | null
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
   * 成功收尾：stash 未提交残留 → 切主干 → `merge --no-ff`。
   *
   * 用 `--no-ff` 是为了让「这一批改动来自哪张工单」在 `git log --graph` 里看得见，
   * 而不是一堆平铺提交。冲突不自动解：冲突意味着两个工单动了同一处语义，
   * 机器替人裁决生产代码的代价远高于让人看一次。
   */
  async finishSuccess(ticketNo: string): Promise<WorkspaceFinish> {
    const branch = branchFor(ticketNo)

    // 成功但有未提交改动：收进 stash 取证，**不合入**。
    // 合入未提交的东西等于绕过「提交 → 审查 → 门禁」这条链，宁可让它停在 gated。
    const stashed = await this.stashResidue(`${ticketNo}-uncommitted-on-success`)

    const back = await this.git(['checkout', this.mainBranch])
    if (back.code !== 0) {
      return {
        merged: false,
        mergedSha: null,
        stashed,
        conflict: false,
        detail: `切回 ${this.mainBranch} 失败：${back.stderr.trim().slice(0, 200)}`,
      }
    }

    if (!(await this.branchExists(branch))) {
      return {
        merged: false,
        mergedSha: null,
        stashed,
        conflict: false,
        detail: `分支 ${branch} 不存在（Agent 可能直接提交到了主干）`,
      }
    }

    const merge = await this.git(['merge', '--no-ff', '-m', `merge(${ticketNo}): 工单收尾合入`, branch])
    if (merge.code !== 0) {
      await this.git(['merge', '--abort'])
      this.log(`[ws] ${ticketNo} 合入冲突，分支保留待人工处理`)
      return {
        merged: false,
        mergedSha: null,
        stashed,
        conflict: true,
        detail: `与 ${this.mainBranch} 冲突，已中止合入，分支 ${branch} 保留：${merge.stderr.trim().slice(0, 200)}`,
      }
    }

    const head = await this.headSha()
    await this.git(['branch', '-d', branch])
    this.log(`[ws] ${ticketNo} 已合入 ${this.mainBranch}（${head === null ? '?' : shortSha(head)}）`)
    return {
      merged: true,
      mergedSha: head,
      stashed,
      conflict: false,
      detail: `已合入 ${this.mainBranch}`,
    }
  }

  /**
   * 失败收尾：stash 残留 → 切主干 → 删分支。
   *
   * 顺序不能反：必须先 stash，再切分支 —— 切分支会把未跟踪文件带到主干上去。
   */
  async finishFailure(ticketNo: string): Promise<WorkspaceFinish> {
    const branch = branchFor(ticketNo)
    const stashed = await this.stashResidue(`${ticketNo}-failed-residue`)

    const current = await this.currentBranch()
    if (current !== this.mainBranch) {
      const back = await this.git(['checkout', this.mainBranch])
      if (back.code !== 0) {
        return {
          merged: false,
          mergedSha: null,
          stashed,
          conflict: false,
          detail: `切回 ${this.mainBranch} 失败，分支 ${branch} 保留：${back.stderr.trim().slice(0, 200)}`,
        }
      }
    }

    if (await this.branchExists(branch)) {
      const del = await this.git(['branch', '-D', branch])
      const detail = `已丢弃分支 ${branch}（改动不进主干）${del.code === 0 ? '' : `；删除失败：${del.stderr.trim().slice(0, 120)}`}`
      this.log(`[ws] ${ticketNo} 失败收尾：${detail}`)
      return { merged: false, mergedSha: null, stashed, conflict: false, detail }
    }
    return {
      merged: false,
      mergedSha: null,
      stashed,
      conflict: false,
      detail: `分支 ${branch} 不存在（无可丢弃的提交）`,
    }
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
