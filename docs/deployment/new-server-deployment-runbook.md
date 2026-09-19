# 新服务器部署 Runbook（118.178.95.156）

- 编写时间：2026-09-17
- 适用：从零把迪礼 ERP 部署到一台全新 Ubuntu 服务器，并从旧机迁移生产数据
- 本次结果：**新机 = 旧机 = 本地 HEAD = `a1ab8e6`，数据 85 表 / 3626 行一致，全站 200**
- 目标架构与旧机一致：`nginx:80 → (PM2) web:3000 / api:3001`，PostgreSQL 跑在 Docker 容器里

> 本 runbook 与 `.agent/deployment/server-incremental-deployment-standard.md`（增量部署唯一标准）互补：
> 那份讲**已有环境下的日常发布**，本文讲**全新服务器从零初始化 + 数据迁移**。

---

## 0. 目标拓扑

```
浏览器 ──80──> nginx ─┬─ /api/ ──> 127.0.0.1:3001  PM2 dilee-api (NestJS)
                      └─ /     ──> 127.0.0.1:3000  PM2 dilee-web (Next.js standalone)
                                     │
                                     └─ Prisma ──> 127.0.0.1:15432
                                                   Docker 容器 app-postgres-1 (postgres:16-alpine)
```

| 组件 | 值 | 备注 |
|---|---|---|
| SSH | `ubuntu@118.178.95.156`，密钥 `D:\edgedownload\dilee.pem` | 见 `~/.ssh/config` |
| 运行目录 | `/opt/dilee/app`（属主 ubuntu） | PM2 的 cwd，内含 `.env`、`RELEASE_VERSION` |
| 备份 | `/opt/dilee/app.backup-<时间戳>` | 由 `remote-switch.sh` 生成 |
| 数据快照 | `/opt/dilee/db-snapshots/` | 迁移前 dump，含 `SHA256SUMS` |
| 数据库 | 容器 `app-postgres-1`，库/用户 `dilee_erp`/`dilee`，宿主 **127.0.0.1:15432** | 只绑 127.0.0.1，不对公网暴露 |
| PM2 日志 | `/home/ubuntu/.pm2/logs/dilee-api-error.log` | **脚本硬编码此路径**，故必须用 ubuntu 用户部署 |

---

## 1. 为什么必须用 `ubuntu` 用户（而不是 root）

`scripts/deploy/common.sh:15` 与 `scripts/deploy-incremental.ps1:112` 把 PM2 错误日志路径
**硬编码**为 `/home/ubuntu/.pm2/logs/dilee-api-error.log`。用 root 部署时该文件不存在
→ `wc -l` 返回非 0 → `Die` → `exit 1`。这个 `exit` 在 `try/catch` 里**拦不住**，
脚本会在第 2 步直接中止。建一个 ubuntu 用户即可 100% 复用现有标准与脚本，零代码改动。

---

## 2. 阶段 0：本地准备

```powershell
cd C:\Users\USER\Desktop\Dilee

# 2.1 工作区必须"已跟踪文件无改动"，否则打包闸门会拒绝
git status --short                    # 期望：只有 ?? 未跟踪文件
git checkout -- .                     # 若有无意删除/改动的已跟踪文件

# 2.2 配置 SSH（避免每次 -i；ssh 与 scp 都会读它）
#     ~/.ssh/config 追加：
#     Host 118.178.95.156
#       User ubuntu
#       IdentityFile D:/edgedownload/dilee.pem
#       IdentitiesOnly yes
#       StrictHostKeyChecking accept-new
ssh 118.178.95.156 "echo ok"          # 验证免密
```

> **编码坑**：`~/.ssh/config` **不能带 UTF-8 BOM**，否则 ssh 报
> `Bad configuration option: \357\273\277#`。PowerShell 5.1 的 `Set-Content -Encoding utf8`
> **会写 BOM**，必须用
> `[System.IO.File]::WriteAllText($p,$c,(New-Object System.Text.UTF8Encoding($false)))`。

---

## 3. 阶段 1：新机基础环境

以 root 执行（脚本见 `.deploy-run-118/01-base-env.sh`）：

```bash
# 3.1 建 ubuntu 用户 + 免密 sudo（脚本里的 `sudo docker` 在非交互 SSH 下必须免密）
useradd -m -s /bin/bash -G sudo ubuntu
echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-ubuntu-nopasswd
chmod 0440 /etc/sudoers.d/90-ubuntu-nopasswd
install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
cp /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys
chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys

# 3.2 基础包
apt-get update && apt-get install -y ca-certificates curl gnupg jq xz-utils rsync \
  nginx docker.io docker-compose-v2

# 3.3 Node 22（走 npmmirror 的二进制镜像，比 nodejs.org 快）
curl -fsSL https://cdn.npmmirror.com/binaries/node/v22.23.2/node-v22.23.2-linux-x64.tar.xz \
  -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1

# 3.4 npm 源 & PM2
npm config set registry https://registry.npmmirror.com --global
npm install -g pm2

# 3.5 docker 组 + 服务
usermod -aG docker ubuntu
systemctl enable --now docker nginx

# 3.6 PM2 开机自启（旧机从未配，建议补上）
env PATH="/usr/local/bin:$PATH" pm2 startup systemd -u ubuntu --hp /home/ubuntu
systemctl enable pm2-ubuntu
```

**为何 npm 源要换**：旧机 `.npmrc` 用的是 `mirrors.tencentyun.com`（腾讯云内网，阿里云不可达）。
新机实测 `registry.npmjs.org` 虽可达（0.68s），但 `registry.npmmirror.com` 更快（0.13s）。

**无需配 Prisma 镜像**：实测 `binaries.prisma.sh` 从阿里云可达（7.7MB / 2.5s）。

### 3.7 构建期内存（1.7GB 小内存机必做）

`/etc/environment` 对**非交互 SSH 会话有效**（已实测），用它注入构建期堆上限：

```bash
printf '%s\n' 'NODE_OPTIONS=--max-old-space-size=2048' >> /etc/environment
```

设备只有 1740MB 内存，`next build` 默认堆上限偏小会 OOM；放开到 2048MB 以利用 4GB swap
（swap 装机自带）。实测构建峰值未触发 OOM。

### 3.8 Docker Hub 不可达 → 配镜像加速器

阿里云**直连 `registry-1.docker.io` 超时**。写 `/etc/docker/daemon.json`：

```json
{ "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://docker.nju.edu.cn",
    "https://docker.1panel.live" ] }
```

→ `systemctl restart docker` → `docker pull postgres:16-alpine`。
实测拉到 `postgres@sha256:cf78e766...`，**与旧机镜像 digest 完全一致**。

---

## 4. 阶段 2：目录、`.env` 与数据库容器

```bash
# 4.1 目录
mkdir -p /opt/dilee/app && chown ubuntu:ubuntu /opt/dilee /opt/dilee/app

# 4.2 .env：从旧机 /opt/dilee/app/.env 逐字节复制（生产唯一真源）
#     用 base64 传输并比对 sha256，避免编码/换行被改动
install -m 600 -o ubuntu -g ubuntu /tmp/dilee.env /opt/dilee/app/.env

# 4.3 RELEASE_VERSION 必须"先存在"，见阶段 5 的说明
```

### 4.4 ⚠️ 最大的坑：`.env` 里两个密码并不一致

实测（旧机与新机的 `.env` 内容完全相同，sha256 `4c275e10...`）：

| 来源 | 末尾 3 位 | 认证结果 |
|---|---|---|
| `.env` 的 `POSTGRES_PASSWORD` | `456` | **失败**（过期错值） |
| `.env` 的 `DATABASE_URL` 内编码密码 | `123` | **成功** |
| 旧机容器 env 的 `POSTGRES_PASSWORD` | `123` | 成功 |

**结论：`DATABASE_URL` 里的密码才是真的。** 用 `.env` 的 `POSTGRES_PASSWORD` 建容器，
库内角色密码会与 `DATABASE_URL` 不符 → `prisma migrate deploy` 报
**`P1000: Authentication failed`**（API 也起不来）。

正确处理 —— 容器与库都用 `DATABASE_URL` 的密码（复刻旧机真实状态）：

```bash
set -a; . /opt/dilee/app/.env; set +a
URL_PASS=$(node -e 'process.stdout.write(decodeURIComponent(new URL(process.argv[1]).password))' "$DATABASE_URL")

docker run -d --name app-postgres-1 --restart unless-stopped \
  -e POSTGRES_DB="$POSTGRES_DB" -e POSTGRES_USER="$POSTGRES_USER" -e POSTGRES_PASSWORD="$URL_PASS" \
  -p 127.0.0.1:15432:5432 -v dilee-pgdata:/var/lib/postgresql/data postgres:16-alpine
```

> `deploy-remote.sh:50-54` 的注释早就警告过这一点
> （"those variables are not guaranteed to match the encoded URL in .env"），
> 但 `docker-compose.yml` 与手工建容器都很容易踩进去。

### 4.5 就绪判定不能只用 `pg_isready`

Postgres 官方入口脚本会先起**临时实例**做 initdb，再关掉它、启动**正式实例**。
窗口期内 `pg_isready` 会误报就绪，紧接着查询报 `the database system is shutting down`。
可靠判据：**连续两次（间隔 3s）`psql -tAc 'select 1'` 都返回 1**。

---

## 5. 阶段 3：数据迁移

```bash
# 5.1 旧机导出（只读：pg_dump 只取 ACCESS SHARE 锁，不阻塞线上写入）
sudo docker exec app-postgres-1 pg_dump -U dilee -d dilee_erp \
  --no-owner --no-acl -Fc > /tmp/dilee_erp.dump
sudo docker exec app-postgres-1 pg_dump -U dilee -d dilee_erp \
  --no-owner --no-acl | gzip -9 > /tmp/dilee_erp.sql.gz   # 兜底 + 人工可读
sha256sum /tmp/dilee_erp.dump

# 5.2 传输：旧机 → 本地 → 新机（两台机器之间没有互信）
#     全程用 scp（二进制安全），每到一站比对一次 sha256
scp 159.75.219.30:/tmp/dilee_erp.dump ./
scp ./dilee_erp.dump root@118.178.95.156:/tmp/

# 5.3 新机恢复
docker exec -i app-postgres-1 pg_restore -U dilee -d dilee_erp \
  --no-owner --no-acl --single-transaction --exit-on-error < /tmp/dilee_erp.dump
```

`--single-transaction --exit-on-error`：**要么全成功、要么整块回滚**，绝不留下半截库。
dump 里含 `_prisma_migrations`，因此恢复后 `migrate deploy` 自动变成 no-op（迁移数即为 76）。

### 5.4 校验（这一步不能省）

- `public` 表数 = **85**
- `_prisma_migrations`：applied = **76**，failed = **0**
- **逐表行数比对**：对全部 85 张表精确 `count(*)`，旧机/新机输出 `diff` 必须为空
  （只读技巧 `query_to_xml`，不在生产库建任何对象；见 `.deploy-run-118/12-count-all.sh`）
- 实测：**85 张表逐一相同，总计 3626 行**
- 另需确认**数据库之外的**文件数据：检查 `/opt/dilee/app/var/attachments`
  与 `attachments` 表行数（本次均为 0，故无文件需迁移）

---

## 6. 阶段 4：正式部署

### 6.1 两个会导致"首次部署必失败"的坑

**坑 1 —— `RELEASE_VERSION` 占位值必须是合法 git 版本号。**
`deploy-incremental.ps1:86` 执行 `git log --oneline "$liveVersion..HEAD"`。
若占位值不是 revision（例如 `bootstrap`），git 报 `fatal: ambiguous argument`，
而脚本处于 `$ErrorActionPreference="Stop"`，native 命令的 stderr 会变成**终止性错误**，
`2>$null` 拦不住 → 脚本中止。

→ 首次部署前把占位值写成 **`HEAD~1` 的真实 SHA**：

```bash
printf '%s' "$(git -C <repo> rev-parse HEAD~1)" > /opt/dilee/app/RELEASE_VERSION
```

这样 `git log HEAD~1..HEAD` 合法（显示 1 个待上线提交），且不需要 `-Force`。
部署完成后该文件会被包内的真值（= HEAD）覆盖。

**坑 2 —— PM2 错误日志文件必须先存在。** 见 §1，预建即可：

```bash
install -d -m 755 -o ubuntu -g ubuntu /home/ubuntu/.pm2/logs
install -m 644 -o ubuntu -g ubuntu /dev/null /home/ubuntu/.pm2/logs/dilee-api-error.log
```

### 6.2 执行

```powershell
cd C:\Users\USER\Desktop\Dilee
npm run deploy -- -DeployHost ubuntu@118.178.95.156 -SkipTests
```

`-SkipTests` 的原因见 §7.2（仓库里一个日期写死的断言会挡住门禁）。

脚本会依次完成：基线核对 → 本地 typecheck/构建 → 打包上传 → **服务器构建（门禁）**
→ 迁移（门禁：迁移数 ≥ 仓库目录数、失败残留 = 0）→ 切换 PM2（成功判定）→ 核验。

本次实测耗时：`npm ci` 48s + `prisma generate` 8s + API 构建 51s + Web 构建 143s ≈ **4.5 分钟**。

---

## 7. 阶段 5：nginx 与收尾

```bash
# 7.1 站点配置（严格复刻旧机，仅改 server_name），并停用 default
cat > /etc/nginx/sites-available/dilee <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name 118.178.95.156;
    location /api/ { proxy_pass http://127.0.0.1:3001; proxy_http_version 1.1;
        proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme; }
    location / { proxy_pass http://127.0.0.1:3000; proxy_http_version 1.1;
        proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme; }
}
EOF
ln -sfn /etc/nginx/sites-available/dilee /etc/nginx/sites-enabled/dilee
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

> `reload` 后**旧的 worker 还在优雅退出**，此刻立即 curl 可能仍命中旧配置
> （表现为 `/` 200 而 `/login` 返回 nginx 自己的 404）。等几秒再测即可。

### 7.2 仓库里两个待修的缺陷（会挡住后续部署）

| 文件 | 问题 | 影响 |
|---|---|---|
| `apps/api/test/unit/other-payable-import.test.cjs:316-317` | 供应商编码断言**写死日期** `SUP-20260916-0002`，而代码按"当天日期"生成（同文件 299 行的写法才是对的：`new Date().toISOString().slice(0,10)`） | 该测试**只在 2026-09-16 当天能过**；此后 `npm run deploy` 的单测门禁必然失败，只能用 `-SkipTests` |
| `scripts/deploy-incremental.ps1:69,86,112` | ① `git log` 在 `RELEASE_VERSION` 非合法 revision 时终止脚本 ② ERRLOG 路径硬编码 `/home/ubuntu`，root 部署时 `exit 1`（`try/catch` 拦不住 `exit`） | **首次部署到新服务器必然失败**，需依赖本文 §6.1 的两个绕行手段 |

### 7.3 安全清理

```bash
rm -f /tmp/dilee.env                  # 生产密钥副本落在全局可读的 /tmp，必须删
mkdir -p /opt/dilee/db-snapshots && chmod 700 /opt/dilee/db-snapshots
mv /tmp/dilee_erp.dump    /opt/dilee/db-snapshots/pre-migration-<日期>.dump
mv /tmp/dilee_erp.sql.gz  /opt/dilee/db-snapshots/pre-migration-<日期>.sql.gz
(cd /opt/dilee/db-snapshots && sha256sum ./* > SHA256SUMS)
rm -rf /opt/dilee/app.release-*       # 失败部署留下的候选目录（本次释放 1.3G）
```

---

## 8. 验收清单

```bash
# 服务器本机
curl -fsS http://127.0.0.1:3001/api/v1/health     # database:ok 且 build == RELEASE_VERSION
sudo -u ubuntu pm2 list                            # dilee-api / dilee-web 均 online
wc -l < /home/ubuntu/.pm2/logs/dilee-api-error.log # 部署后应无新增

# 公网（同时验证云安全组已放行 80）
curl -s -o /dev/null -w '%{http_code}\n' http://118.178.95.156/login          # 200
curl -s http://118.178.95.156/api/v1/health                                   # build 一致
curl -s -o /dev/null -w '%{http_code}\n' http://118.178.95.156/api/v1/customers  # 401（鉴权生效）
```

**开机自启必须实测**，不要只看 `enabled`：

```bash
sudo -u ubuntu pm2 kill                  # 模拟宕机
systemctl start pm2-ubuntu               # 模拟开机
sleep 10 && sudo -u ubuntu pm2 list      # 两个应用应自动回到 online
```

本次实测：杀掉后 health 不可达；触发 systemd 后两个应用自动恢复 online，health/页面全部正常。

---

## 9. 回滚

```bash
ssh ubuntu@118.178.95.156
bash /tmp/dilee-deploy/remote-rollback.sh          # 若临时目录已被清理，用下面的手工方式
# 手工：
cd /opt/dilee
sudo -u ubuntu pm2 delete dilee-api dilee-web
mv app app.failed-$(date +%Y%m%d-%H%M%S)
mv app.backup-<时间戳> app
cd app && pm2 start ecosystem.config.cjs && pm2 save
curl -fsS http://127.0.0.1:3001/api/v1/health
```

失败目录 `app.failed-*` **永不自动清理**，保留用于排查；数据库卷与容器不要删。
数据回退：用 `/opt/dilee/db-snapshots/pre-migration-*.dump` 恢复。

---

## 10. 本次部署踩到的环境坑速查

| 现象 | 根因 | 处理 |
|---|---|---|
| `Permission denied (publickey)` | 私钥不匹配 | 确认 `dilee.pem`（RSA），配到 `~/.ssh/config` |
| `Bad configuration option: \357\273\277#` | ssh config 带 UTF-8 BOM | 用 `UTF8Encoding($false)` 写文件 |
| bash `No such file or directory` 指向存在的文件 | PowerShell 5.1 通过 stdin 喂脚本带 **CRLF**，`\r` 被并入文件名/路径 | **写成 `.sh` 文件再 scp**，或 `sed -i 's/\r$//'`（文档 §5.6 的老坑） |
| `The '<' operator is reserved for future use` | PS 字符串里的 `$(...<...)` 被 PowerShell 抢先解析 | 别在双引号里写远程 `<` 重定向 |
| `error response from daemon: dial tcp ... registry-1.docker.io i/o timeout` | 阿里云直连 Docker Hub 超时 | 配 `registry-mirrors`（§3.8） |
| `P1000 Authentication failed` | `.env` 的 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 内密码不同 | 用 `DATABASE_URL` 的密码建容器（§4.4） |
| `the database system is shutting down` | `pg_isready` 在 initdb 临时实例窗口误报 | 连续两次 `select 1` 成功才算就绪（§4.5） |
| 部署脚本第 1 步中止（`fatal: ambiguous argument`） | `RELEASE_VERSION` 占位值不是合法 revision | 占位值用 `HEAD~1` 的 SHA（§6.1） |
| 部署脚本第 2 步中止（无输出） | ERRLOG 路径硬编码 `/home/ubuntu`，root 部署时 `wc -l` 非 0 → `Die` → `exit 1` | 建 ubuntu 用户或用 `HEAD~1`/预建日志文件（§1、§6.1） |
| `spawn /usr/local/bin/node EACCES`（PM2） | 从 ubuntu 无权限的 cwd（如 `/root`）启动 PM2 | 从属主为 ubuntu 的目录启动（部署脚本本就这么做） |
| scp 偶发 `Connection timed out` | 到阿里云链路抖动（本次出现 2 次） | 重试即可；`npm run deploy` 依赖 scp，失败可安全重跑 |

---

## 附：本次使用的脚本

均在 `.deploy-run-118/`（gitignore 命中 `.deploy-run*/`，不入库）：

| 文件 | 作用 |
|---|---|
| `01-base-env.sh` / `01b-verify.sh` / `01c-verify-ubuntu.sh` / `01d-pm2-smoke.sh` | 阶段 1 环境安装与验证（含 PM2 冒烟测试） |
| `02-dirs-db.sh` | 阶段 2 目录 / `.env` / 容器 |
| `03-old-dump.sh` | 旧机只读导出 |
| `04-restore.sh` | 新机恢复与校验 |
| `06-docker-mirror.sh` | Docker 镜像加速器 |
| `09-env-inject.sh` | 注入 `NODE_OPTIONS` |
| `12-count-all.sh` | **全表行数比对**（旧机/新机各跑一次后 `diff`） |
| `13-diag-p1000.sh` / `14-which-password.sh` | P1000 根因定位 |
| `15-fix-p1000.sh` | 用 `DATABASE_URL` 密码重建容器并恢复数据 |
| `16-nginx.sh` | nginx 反代 |
| `17-finalize.sh` | 清理 / 快照 / 自启核验 |
| `18-dbcheck.sh` | 数据库状态复核 |
