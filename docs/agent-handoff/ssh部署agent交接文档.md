# SSH 部署 Agent 交接文档

- 交接时间：2026-09-14
- 仓库：`C:\Users\USER\Desktop\Dilee`（Windows / PowerShell；`apps/api` = NestJS + Prisma + PostgreSQL，`apps/web` = Next.js 15 + React 19，npm workspaces）
- 代码基线：本地与线上**代码一致**，线上版本 `d6574d7`；数据库迁移 **65/65**；交接时工作区干净（本文档自身为 docs-only 提交，不影响发布）
- 一句话状态：**线上与本地一致且全绿**；本文只讲“怎么安全地 SSH 部署 / 迁移”，业务内容见 §6 与既有文档。

> 规范与其它交接文档见 `docs/agent-handoff/README.md`、`docs/agent-handoff/2026-09-14-batch3-qc-module-and-outbound.md`（后者是业务批次交接，本文是**部署运维交接**，两者互补）。

---

## 1. 部署环境与拓扑

| 项 | 值 |
|---|---|
| 主机 | `ubuntu@159.75.219.30`（SSH；凭据在运维方环境，**不在仓库内**，不要写入任何文档/提交） |
| 线上运行目录 | `/opt/dilee/app`（PM2 `cwd`，内含 `.env`、`RELEASE_VERSION`） |
| 构建暂存目录 | `/opt/dilee/app.next`（每次全新构建，成功后整体替换 `/opt/dilee/app`） |
| 备份 | `/opt/dilee/app.backup-<YYYYmmdd-HHMMSS>`，**自动只保留最近 3 份**（切换脚本内 `head -n -3`） |
| 进程 | PM2：`dilee-api`（端口 3001）、`dilee-web`（端口 3000），`ecosystem.config.cjs`；启动脚本 `scripts/pm2-api-start.sh` / `pm2-web-start.sh`（解释器 `/bin/bash`） |
| 数据库 | Docker 容器 `app-postgres-1`，库 `dilee_erp`，用户 `dilee`，宿主端口 15432；访问方式：`sudo docker exec app-postgres-1 psql -U dilee -d dilee_erp` |
| 健康检查 | `curl -fsS http://127.0.0.1:3001/api/v1/health`（返回 `build` 字段 = 当前版本） |
| 磁盘 | 50G，当前用 39%（每次部署新增一份 ~1GB 构建产物，靠 3 份备份上限兜底） |

---

## 2. 标准部署流程（六步，勿跳步）

代码事实以 git 历史为准；每次都**固定一个 SHA** 再打包，避免与并发写者抢跑。

> **权威标准**：`.agent/deployment/server-incremental-deployment-standard.md`（`docs/deployment/server-incremental-deployment-standard.md` 只是指向它的指针）。
> **推荐入口**：`npm run deploy`（= `scripts/deploy-incremental.ps1`），把下列步骤固化，并加了三道闸门：
> ① 工作区必须干净 ② 服务器构建必须 `BUILD_OK` 才迁移/切换 ③ 迁移数 ≥ 仓库迁移目录数且失败残留为 0。
> 服务器端脚本：`scripts/deploy/{common,remote-build,remote-migrate,remote-switch,remote-rollback,remote-verify}.sh`；守卫测试 `scripts/deploy-scripts.test.mjs`（已接入 `npm run test:unit`）。

1. **对齐基线与范围**
   ```powershell
   ssh ubuntu@159.75.219.30 "cat /opt/dilee/app/RELEASE_VERSION"   # 线上版本
   git log --oneline <线上版本>..HEAD                               # 待上线提交
   git diff --name-only <线上版本>..HEAD -- apps/api/prisma/migrations   # 待执行迁移
   git status --short                                               # 是否有人在途改动
   ```
2. **本地校验**：`typecheck`(api/web) → `build api`（api 测试 require `dist`）→ api 单测/根测试 → web lib + 组件测试 → `npm run test:deploy`。
3. **打包**：`npm run release:pack`（= `scripts/create-release-archive.ps1`）。
   已加固：显式用 `%SystemRoot%\System32\tar.exe`、`RELEASE_VERSION` 写 **UTF-8 无 BOM**、包结构自检（缺顶层条目或含 `AppData/Users/.claude` 等直接失败）、拒绝脏工作区。
4. **远端构建（真正的发布门禁）**：`scripts/deploy/remote-build.sh` → 解到 `app.release-<ts>` → 结构/`.env`/`DATABASE_URL` 校验 → `npm ci --include=dev` → `prisma generate` → 构建 API+Web → 输出 `BUILD_OK RELEASE=<sha>`。
   门禁未过 → **不迁移、不切换**，线上继续跑旧版本。
5. **迁移（有待执行迁移时）**：`scripts/deploy/remote-migrate.sh`；规范与失败恢复见 §3。
6. **切换 + 核验 + 清理**：`scripts/deploy/remote-switch.sh`（`pm2 delete` → 备份改名 → 提升候选目录 → 启动 → health `build` 必须等于 `RELEASE_VERSION`，manifest 与 `/login` 必须 200 → 比对错误日志增量）→ `remote-verify.sh` → 清理 `/tmp`。
   回滚：`scripts/deploy/remote-rollback.sh [备份目录]`（失败目录留 `app.failed-*`）。

与标准的两处**有意差异**：迁移改到“构建成功之后、切换之前”（编译不过不先动生产库）；备份保留由 `-KeepBackups` 控制（默认 3，`0` = 全保留即严格遵循标准），`app.failed-*` 永不自动清理。

---

## 3. 迁移处理规范（本会话踩过坑，务必按此执行）

**执行前必做预检**（对生产库只读查询）：

- 加唯一索引的迁移：先查是否已有重复组合，**守卫型迁移会直接中止**（例：`20260912160000_material_composite_unique` 内置 `RAISE EXCEPTION`）。
- 加列/删列/回填：确认目标列**尚不存在**、历史关联行数（例：`20260912200000_outbound_notice_partial_outbound` 预检出“3 张通知中 1 张有待回填出库单”）。
- 删唯一索引：确认索引存在、且**代码不再依赖该唯一键做 upsert**、旧唯一约束相关的数据现状。
- 数据回填类：先看它扫描哪些表（`20260913100000_currency_dictionary` 会动态扫描所有带 `currency` 列的表）。

**执行**：
```bash
cd /opt/dilee/app.next
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
sudo docker exec app-postgres-1 psql -U dilee -d dilee_erp -tAc \
  "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null"
```

**执行后逐项核验**（不要只看“All migrations applied”）：列/表是否存在、旧列是否已删、回填是否命中预期行、**业务数据总量与迁移前一致**（本会话用“总行数不变 + NULL 归零”证明无数据丢失）。

**失败恢复（P3018）**——本会话真实案例：

1. 先确认**副作用为零**：Prisma 每个迁移在事务内执行，失败即整块回滚；用 SQL 核对目标数据未写入、`_prisma_migrations` 出现 `finished_at IS NULL` 的失败行、已应用计数未变。
2. 修复 SQL 后**用事务干跑验证**（不落库）：
   `{ BEGIN; <迁移内容>; <校验 SELECT>; ROLLBACK; } | ssh ... "sudo docker exec -i app-postgres-1 psql ..."`
3. 清理失败记录并重放：
   `npx prisma migrate resolve --rolled-back <migration_name> --schema apps/api/prisma/schema.prisma`
   注意：**`migrate resolve` 也必须带 `--schema`**，否则报 `Could not find Prisma Schema`。
4. 重新 `migrate deploy`，再走一次执行后核验。
5. 若修复只改了迁移 SQL（不影响编译产物），可只把修好的迁移文件与 `RELEASE_VERSION` 同步进 `app.next` 并**核对 sha256 一致**，无需整包重建；否则重新打包重建。

---

## 4. 本会话修复的线上事故（根因与位置，避免重复踩）

| 现象 | 根因 | 落点 |
|---|---|---|
| 领料/补料过账、编辑页“保存并出库” **必 500** | `tx.$queryRaw` 取 `pg_advisory_xact_lock(...)` 的 **void** 返回值，Prisma 无法反序列化（`Failed to deserialize column of type 'void'`） | `apps/api/src/modules/production/raw-material-movements.service.ts` 两处改 `$executeRaw`；回归测试 `apps/api/test/raw-material-movement-post-lock.test.cjs` |
| 成品 QC 数量不平衡时报 500（应 422） | 普通 `Error` 逃逸到异常过滤器 | `apps/api/src/modules/warehouse/finished-goods-qc.domain.ts` 的 `ruleError` → `UnprocessableEntityException` |
| 币种迁移 `20260913100000` 报 42702 中止 | PL/pgSQL 变量 `type_id` 与 `dictionary_items.type_id` 列同名 | 迁移内变量改名 `currency_type_id`（提交 `b743bc1`） |
| API 错误日志被 22 万行噪声淹没 | `scripts/pm2-api-start.sh` 早期为 CRLF 被 `sh` 执行，`set -euo pipefail` 报 `invalid option name` | 现为 LF + `/bin/bash` 正常；历史日志已清空留档 `/tmp/dilee-api-error.log.bak` |

**日志核验约定**：`/home/ubuntu/.pm2/logs/dilee-api-error.log` 的行数与最后写入时间要记下来；部署后应**无新增**（若有新增，先读栈再判断是否本次发布引入）。噪声日志会破坏这个判据，发现即清理。

---

## 5. 环境硬约束与坑（按被坑频率排序）

1. **`tar` 必须用原生 `C:\Windows\System32\tar.exe`**：若解析到 Git 自带 MSYS tar，会把 `C:\...` 当远程主机，报 `Cannot connect to C: resolve failed`，打包静默失败。
2. **只发布已提交内容**：`git archive <sha>` 天然排除工作区改动与未跟踪文件。**同一工作区常有另一位 agent 在途**（本会话多次出现 50~170 个未提交文件）；默认只发布已提交内容，并在汇报里说明“哪些在途改动未上线”。若用户要求“全部提交并部署”，先校验再 `git add -A`，并排除垃圾（见第 5 条）。
3. **测试针对 `dist`，不是源码**：`apps/api/test/**` 大量 `require("../dist/...")`。改完 API 必须 `npm run build --workspace=@dilee/api` 再跑测试，否则跑的是旧产物（曾出现“15 个失败全是陈旧 dist”）。同理，`tsc` 报 `payrollPayableEntry does not exist` 之类，多为 **Prisma client 未 `generate`**，不是代码错。
4. **并行写者会改坏工作区**：遇到过 `purchase-orders.service.ts`、`raw-material-inbounds-service.test.cjs` 处于“编辑中途”的语法损坏状态（注释与代码被并到一行、新用例被粘进上一个对象的字面量中间）。**不要急着替对方改**；先确认是否仍在变化，必要时定位并只做最小修复，且在汇报里说明。
5. **`.gitignore` 必须挡住这些**（已配置，勿删）：`DileeErp*.tar.gz`（发布包）、`dilee-images.tar`（289MB 镜像）、`.pnpm-store/`（377MB）、`.logs/`、`.tmp-*.txt`、`apps/*/pnpm-*.yaml`、`vitest-out.txt`、`.deploy-run*/`、`.dsh-meow/`（本机 DSH 运行时状态，含 `memory.db` 与会话 json）。
6. **PowerShell 调 SSH 的引号地狱**：内联 `ssh host "curl -s -m 10 ..."` 会被 PowerShell 抢先解析（`-m` 被当成 `Invoke-WebRequest` 参数）、多行 SQL 与中文易挂。**正确做法：把命令写成 `.sh`/`.sql` 文件 `scp` 上去，再 `ssh bash /tmp/x.sh`**；SQL 用管道 `Get-Content x.sql | ssh ... "sudo docker exec -i app-postgres-1 psql ..."`。
7. **中文与编码**：仓库文件为 UTF-8；控制台里中文显示为乱码是终端编码问题，不代表文件坏。写文件务必指定 UTF-8（无 BOM）。曾因 PowerShell 写 `.gitignore` 时 `\r` 后漏 `\n`，导致忽略规则被拼进注释行而失效。
8. **服务端构建已包含 devDependencies**（`npm ci --include=dev`）：前端新增 vitest/testing-library/jsdom 等不会漏装，但会拉长构建时间（当前 ~4–6 分钟），`poll.sh` 的超时上限设为 200×20s。
9. **本地跑不动 `next build`**：Windows 上写 `.next/standalone` 需要符号链接权限，会 `EPERM`。判断方式看是否已打印 `✓ Compiled successfully`——编译过了就只是环境限制，**真正的构建门禁在服务器**。

---

## 6. 业务侧当前状态与待办

- **已全部上线（本地=线上 `d6574d7`）**，用户最近三条需求均已交付：
  1. 币种改为可配置字典（下拉可选，15 个内置 + 历史值自动补齐）：迁移 `20260913100000_currency_dictionary`、`apps/api/src/platform/currency/*`、`apps/web/lib/currency-{options,catalogue}.ts`，下拉数据源 `GET /dictionaries/currency/items`。
  2. 采购单导入 BOM 后**逐行复选框 + 批量剔除**（只作用于草稿，BOM 不变）：`apps/web/app/procurement/page.tsx`（`selectedDraftRows` / `toggleDraftRow` / `toggleAllDraftRows`）。
  3. **一个订单可开多张采购单**（按供应商分组下单）：`POST /purchase-orders/split` → `PurchaseOrdersService.createSplit`（`apps/api/src/modules/procurement/purchase-orders.{controller,service}.ts`）。
     设计说明见 `docs/design/currency-dictionary-and-purchase-order-split-2026-09-14.md`。
- **唯一未完成的交办**：用户要的**「全站需要币种/支付的位置统计表」**尚未产出。做法：以 `information_schema.columns` 中 `column_name='currency'` 的 **18 张表**为起点（customer_payments、customers、outsource_payable_sources、payable_sources、payroll_ledgers、payroll_payable_entries、purchase_orders、receivable_adjustments/allocations/reconciliations/sources、salary_payment_allocations、salary_payments、sales_orders、supplier_payable_entries、supplier_payable_reconciliations、supplier_payment_allocations/supplier_payments），逐项标注：是否已接币种下拉、是否仍写死 `CNY`/`USD`、是否有校验、对应页面入口。产出后可作为下一批整改依据。
- 建议的下一步顺序：①出上面这份统计表 → ②按表补齐仍写死币种的入口 → ③若需要，把 §2 的部署脚本固化进 `scripts/` 并接入 CI（仓库已有 `.github/workflows/{deploy,test}.yml`，当前未用于本机部署流程）。

---

## 7. 建议技能（Suggested skills）

- **`diagnosing-bugs`**：线上 500/迁移失败这类“有明确报错但根因不在报错行”的问题（本次 void 反序列化、42702 变量歧义都属此类），按它的诊断循环走能少走弯路。
- **`code-review`**：并发写者频繁提交（本会话 40+ 提交），批量上线前用它对 `<线上版本>..HEAD` 做一次 Standards/Spec 双轴评审，比逐条读 diff 更省上下文。
- **`tdd`**：给“回归守卫”写用例（本次给 advisory lock 写的测试，把 `$queryRaw` 改回即失败）比事后回归更可靠。
- **`research`**：遇到 Prisma/Next/Vitest 版本行为差异（如 `$executeRaw` vs `$queryRaw`、Next standalone 符号链接），先查一手文档再动手。

---

## 8. 快速自检清单（接手后跑一遍即可确认基线）

```powershell
git log --oneline -1                                          # 应为 d6574d7
git status --short                                            # 应为空
ssh ubuntu@159.75.219.30 "cat /opt/dilee/app/RELEASE_VERSION"  # 应与本地 HEAD 相同
ssh ubuntu@159.75.219.30 "curl -fsS http://127.0.0.1:3001/api/v1/health"
# 迁移数（应为 65）、失败残留（应为 0）、备份数（应为 3）
```
