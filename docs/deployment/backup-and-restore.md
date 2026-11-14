# 数据库备份与恢复

> 现役生产机：`ubuntu@118.178.95.156`（见 `new-server-deployment-runbook.md`）。
> 旧机 `159.75.219.30` 已退服，不要再指向它。

## 现状（2026-11-14 起）

| 项 | 值 |
|---|---|
| 备份脚本 | `/usr/local/bin/dilee-backup`（root 拥有、755） |
| 执行时间 | 每日 **03:30**（服务器时区 `Asia/Shanghai`） |
| 调度 | root crontab：`30 3 * * * /usr/local/bin/dilee-backup >/dev/null 2>&1` |
| 存放 | `/opt/dilee/db-backups/dilee_erp-<YYYYmmdd-HHMMSS>.dump` |
| 保留 | **7 天**（`KEEP_DAYS=7`，按文件 mtime 清理） |
| 日志 | `/var/log/dilee-backup.log`（logrotate 每周轮转、保留 8 份、压缩） |
| 校验和 | 每次备份追加到 `/opt/dilee/db-backups/SHA256SUMS` |
| 格式 | `pg_dump -Fc`（自定义格式，支持 `pg_restore` 选择性恢复） |

备份不清空、不覆盖：文件名带时间戳，永不重名。

## 脚本做了什么

1. `docker exec app-postgres-1 pg_dump -U dilee -d dilee_erp -Fc` 写入目标文件。
2. **三道自检**，任一不过就删掉这次产物并以非 0 退出：
   - 文件大小 < 10,000 字节；
   - `pg_restore --list` 读不出目录结构；
   - `pg_dump` 本身非 0 退出。
3. 追加 sha256 到 `SHA256SUMS`。
4. 清理 `mtime > 7 天` 的备份。
5. 磁盘使用率 > 85% 时在日志里写 WARNING（不中断）。

> **日志函数永不失败**。2026-11-14 实测踩过一个坑：最初版本用 `tee -a` 写 `/var/log`，
> 非 root 运行时权限被拒，配合 `set -e` + `pipefail` **直接把整次备份终止了**，
> 而且文件已经建了一半。现在 `log()` 内部 `|| true`，写不进日志只影响日志，不影响备份。

## 手工运行

```bash
# root（与 cron 同身份，推荐）
sudo /usr/local/bin/dilee-backup

# 看结果
sudo tail -5 /var/log/dilee-backup.log
ls -lh /opt/dilee/db-backups/
```

以 `ubuntu` 身份直接跑会失败（`/opt/dilee/db-backups` 与 `/var/log` 都属 root）——
这是预期的，用它来验证「不因日志失败而半途而废」。

## 恢复演练（已验证）

2026-11-14 用 `pre-supplier-stock-20261114-112518.dump` 做过完整演练，
**结论：21 张关键表行数与生产库逐一相同，147 张销售单图片的字节总量与逐张 sha256 全部一致，恢复 0 错误、耗时 6 秒。**

复现步骤：

```bash
SNAP=/opt/dilee/db-backups/dilee_erp-<时间戳>.dump
TMP=dilee_restore_drill

# 1. 建临时库（不要用 dilee_erp！）
sudo docker exec app-postgres-1 psql -U dilee -d postgres -c "DROP DATABASE IF EXISTS $TMP"
sudo docker exec app-postgres-1 psql -U dilee -d postgres -c "CREATE DATABASE $TMP"

# 2. 恢复
sudo docker exec -i app-postgres-1 pg_restore -U dilee -d $TMP --no-owner --no-privileges < "$SNAP"

# 3. 比对关键表行数
for t in users sales_orders sales_order_images inventory_facts vouchers employee_daily_reports; do
  printf '%-28s prod=%s restore=%s\n' "$t" \
    "$(sudo docker exec app-postgres-1 psql -U dilee -d dilee_erp -X -A -t -c "select count(*) from $t")" \
    "$(sudo docker exec app-postgres-1 psql -U dilee -d $TMP -X -A -t -c "select count(*) from $t")"
done

# 4. 图片字节一致性（这条最能证明"备份是完整的"）
for db in dilee_erp $TMP; do
  sudo docker exec app-postgres-1 psql -U dilee -d $db -X -A -t \
    -c "select count(*) || ' 张 / ' || coalesce(sum(byte_size),0) || ' 字节 / 校验和 ' || md5(string_agg(sha256, ',' order by id)) from sales_order_images"
done

# 5. 清理
sudo docker exec app-postgres-1 psql -U dilee -d postgres -c "DROP DATABASE $TMP"
```

### 演练时怎么判断"恢复成功"

- `pg_restore` 退出码 0 **且** 标准错误为空；
- 业务表行数与生产一致（允许**快照时间点之后**新增的行造成差）；
- `_prisma_migrations` 可能比生产**少**——这是正常的，因为它记录的是快照那一刻的迁移数。

## 从备份真正恢复生产（事故场景）

> ⚠️ 会丢掉备份时间点之后的所有写入。先停应用，避免恢复期间被并发写。

```bash
# 1. 停应用
pm2 stop dilee-api dilee-web

# 2. 再拍一份"现状"快照，给自己留退路
TS=$(date +%Y%m%d-%H%M%S)
sudo docker exec app-postgres-1 pg_dump -U dilee -d dilee_erp -Fc \
  > /opt/dilee/db-snapshots/pre-restore-$TS.dump

# 3. 重建库并恢复
sudo docker exec app-postgres-1 psql -U dilee -d postgres -c "DROP DATABASE dilee_erp"
sudo docker exec app-postgres-1 psql -U dilee -d postgres -c "CREATE DATABASE dilee_erp OWNER dilee"
sudo docker exec -i app-postgres-1 pg_restore -U dilee -d dilee_erp --no-owner --no-privileges < "$SNAP"

# 4. 补跑迁移（备份可能早于最新代码）
cd /opt/dilee/app && npx prisma migrate deploy --schema apps/api/prisma/schema.prisma

# 5. 起应用并核验
pm2 start ecosystem.config.cjs && pm2 save
curl -s http://127.0.0.1:3001/api/v1/health
```

## 手工迁移前快照（另一套，别混）

`/opt/dilee/db-snapshots/` 放的是**迁移前的回滚点**，与每日备份分开：

```bash
TS=$(date +%Y%m%d-%H%M%S)
sudo docker exec app-postgres-1 pg_dump -U dilee -d dilee_erp -Fc \
  > /opt/dilee/db-snapshots/pre-<用途>-$TS.dump
```

2026-11-14 清理后只保留三个关键节点：

| 文件 | 为什么留 |
|---|---|
| `migrated-from-159.75.219.30-20261023-113127.dump` (1.2M) | 旧机数据的**唯一来源**（旧机已下线）。本地另有一份副本，sha256 已核对一致 |
| `pre-subject-code-r1-20261112-142203.dump` (23M) | 科目主键化那一批迁移的回滚点 |
| `pre-supplier-stock-20261114-112518.dump` (23M) | 供应商分档迁移的回滚点，也是最近一次完整演练用的那份 |

清理后 `db-snapshots` 从 90M 降到 46M。`SHA256SUMS` 已按现存文件重建，`sha256sum -c` 通过。

## 容量与增长

**图片存在数据库里**（`sales_order_images.data` 为 `bytea`，浏览器压成 WebP，每张 ≤2MB）。
因此：

- 数据库大小 ≈ 业务数据 + 全部图片字节；
- **备份大小跟着图片线性增长**（当前 ~23MB，日均新增约 1MB 量级）；
- 快照里大部分是重复的图片数据，属于正常现象，不是冗余缺陷。

按 7 天保留 + 23MB/份估算，`db-backups` 稳态约 **160MB**。磁盘目前 17G 可用，余量充足。
若将来图片量级上来（比如单表 >1GB），应改为「图片存对象存储、库里只存 key」，
而不是扩大备份保留窗口。

## 需要知道的两个边界

1. **备份在服务器本机**。服务器整体损坏时备份一起没。目前只解决了"误删/误改/迁移失败"，
   没解决"整机丢失"。异地副本仍未实现——若要做，最简单的做法是定期把最新一份
   `scp` 到本地或对象存储。
2. **没有告警**。备份失败只写日志，没人会被通知。建议后续加一条：日志出现 `ERROR`
   就发通知（飞书机器人等）。目前靠人工看一眼日志。
