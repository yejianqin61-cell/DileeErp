# 自主部署与 GitHub 推送

日期：2026-11-16｜版本：1.0｜状态：**实施中**｜类型：设计

上游：[Agent 应用层架构](agent-application-layer-architecture-2026-11-14.md)、
[生产常驻 Agent 自动修 ERP](production-resident-agent-erp-maintenance-2026-11-13.md)。

## 0. 要求

2026-11-16 14:47，用户 @ 机器人：

> 部署，并把最新代码推送到github，能做到吗

机器人回「部署做不到 / 推 GitHub 也做不到」——它没装这条腿。
用户随后明确：**这一步，我需要 Agent 能自主实现。**

## 1. 现状

- 生产部署标准已经存在：`.agent/deployment/server-incremental-deployment-standard.md`，
  流程固化为 `scripts/deploy/remote-{build,migrate,switch,verify,rollback,nginx}.sh`，
  由 Windows 侧 `scripts/deploy-incremental.ps1` 驱动（`npm run deploy`）。
- 机器人跑在服务器上，**就在部署目标的同一台机器**，不需要再经过 Windows/scp。
- agent 工作区 `/opt/dilee/agent/repo` 的 origin 是 Phase 1 的离线 bundle，
  没有 GitHub 地址也没有凭据 → 推不了。

## 2. 设计

### 2.1 复用既有脚本，不重写部署流程

`deploy.ts` 只做编排：按标准顺序调用 `scripts/deploy/*.sh`，解析退出码与
`BUILD_OK / MIGRATE_OK / SWITCH_OK / ROLLBACK_OK` 标记。部署细节（npm ci、构建、
PM2 切换、健康判定）仍然只有一份实现，漂移风险最小。

### 2.2 顺序：先推 GitHub，再构建部署

```
预检 → 推送 GitHub → 打包 → 服务器构建 → 测试门禁 → 迁移检查 → 切换 → 核验 → 边缘探针 → 完成
                                                                         ↘ 失败：自动回滚
```

推送失败即中止：**线上跑的代码必须能在 GitHub 上找到对应提交**，否则回滚和追责都失去锚点。

### 2.3 硬门禁（任一不过即中止，生产完全不受影响）

| 门禁 | 判据 | 理由 |
|---|---|---|
| 工作区干净 | `git status --porcelain` 为空 | 发布包只含已提交内容 |
| 基线不倒挂 | 线上 `RELEASE_VERSION` 是 HEAD 的祖先 | 防把旧代码推上线 |
| 不自动迁移 | 仓库迁移目录数 ≤ 已应用迁移数，且失败残留 = 0 | 用户 2026-11-13 唯一硬黑名单：不准动生产库 |
| 磁盘充足 | `/` 可用 ≥ 5 GB | 一次构建 + 备份约 1.5–2 GB |
| 单车道 | 与工单 run 共用一条串行队列 | 2 核机器，构建期内存最低 152 MB |
| 不 force push | `origin/main` 必须是 HEAD 祖先 | 拒写别人的提交 |

有未应用迁移时**停下并如实告知**「需要人工执行迁移」，而不是悄悄跑 migrate。

### 2.4 测试门禁：切换前在候选目录跑

构建成功后、切换之前，在候选目录（`app.release-<ts>`）跑仓库自带门禁 `npm test`
（typecheck + 部署脚本守卫 + API 单测 + Web 单测）。失败则保持旧版本运行，
工单回到 `gated`。切换后再做健康/页面/边缘实测。

### 2.5 失败自动回滚

| 失败位置 | 处理 |
|---|---|
| 预检 / 推送 / 打包 / 构建 / 测试 / 迁移 | 不切换，旧版本继续跑；工单回 `gated` |
| 切换中或切换后核验失败 | 自动 `remote-rollback.sh`，恢复到最近 `app.backup-*`；工单 `rolled_back` |
| 边缘探针失败 | 应用已上线，不自动回滚（回滚也修不了 nginx）；标为警告并如实上报 |

回滚会失败吗？会（磁盘/权限/备份缺失）。那就把失败事实和当前线上版本一起报出来，
不假装成功。

### 2.6 GitHub 凭证

服务器生成专用 SSH deploy key（只给这一个仓库、写权限），
`origin` 的 fetch 用 HTTPS（公开仓库，无需凭据），push 用 SSH。
用户只需在 GitHub 仓库 Settings → Deploy keys 里加一次公钥 —— 这是唯一的人工步骤。

### 2.7 触发方式

| 触发 | 行为 |
|---|---|
| 群消息「部署 / 上线 / 发布」 | 立即部署当前 HEAD（覆盖所有 `gated` 工单） |
| 工单 run 成功（`gated`） | 若 `AUTO_DEPLOY=1`（默认），自动排队部署；用户 2026-11-13 拍板「全自动上线」 |

自动部署失败不会回滚已成功的 run：代码仍在工作区，工单卡片写明失败阶段。

### 2.8 工单状态

`gated → deploying → done`（成功）/ `rolled_back`（回滚）/ `gated`（切换前失败，可重试）。
卡片颜色：蓝=部署中、绿=已上线、紫=已回滚、红=失败。

## 3. 接口

```ts
export interface DeployConfig {
  repoPath; rootDir; appDir; workDir; archivePath; recordsDir
  gitRemote; gitBranch; keepBackups; requirePush; skipTests; minFreeGb
  timeouts: { gitMs; packMs; buildMs; testMs; migrateMs; switchMs; verifyMs; edgeMs; rollbackMs }
}

export interface DeployResult {
  ok: boolean; pushed: boolean; rolledBack: boolean
  release: string; previousVersion: string; backupDir: string | null
  phase: DeployPhase; failure: string | null; warning: string | null
  startedAt: string; finishedAt: string; durationMs: number
}

export async function runDeploy(input: {
  config: DeployConfig
  hooks?: DeployHooks
}): Promise<DeployResult>
```

`DeployHooks.onPhase(phase, message)` 用于飞书进度；`DeployHooks.onLine(line)` 用于日志。

## 4. 不做什么

| 不做 | 理由 |
|---|---|
| 不自动执行数据库迁移 | 唯一硬黑名单；有未应用迁移就停 |
| 不强推 / 不 force push | 会覆盖别人的提交 |
| 不清理 `app.failed-*` | 排障证据 |
| 不跳过测试门禁（默认） | 用户要求「基线冒烟测试、通过后上线」 |

## 5. 验收

| # | 判定 |
|---|---|
| 1 | 工作区脏 / 基线倒挂 / 有未应用迁移时，部署被拒且不推送不构建 |
| 2 | 推送失败时中止，不构建不切换 |
| 3 | 构建或测试失败时线上版本不变 |
| 4 | 切换后核验失败会自动回滚，线上恢复旧版本 |
| 5 | 成功路径：GitHub 有提交、线上 `RELEASE_VERSION` = 部署提交、健康与页面正常 |
| 6 | 飞书群里能看到每个阶段与最终结果 |

## 变更记录

- 2026-11-16：建立。依据用户要求与现有部署标准；机器人将具备推送 GitHub 与部署上线能力。
