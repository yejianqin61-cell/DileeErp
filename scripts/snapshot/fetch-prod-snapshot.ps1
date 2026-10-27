<#
.SYNOPSIS
  从生产库取一份只读快照到本地，并脱敏，用于报表/对账口径验证。

.DESCRIPTION
  四步：远端 pg_dump → scp 回本地 → 灌进本地容器的新库 → 跑 scripts/snapshot/desensitize.sql。
  只读：远端只执行 pg_dump，不写生产库。

  为什么要有这个脚本：口径改动（例如把 join 从 order_no 换成 sales_order_id）必须
  在真实数据上做前后对照，mock 数据证不了「数字没变」。快照是那类验证的前置条件。

.EXAMPLE
  pwsh scripts/snapshot/fetch-prod-snapshot.ps1
  pwsh scripts/snapshot/fetch-prod-snapshot.ps1 -LocalDb dilee_snapshot_2 -SkipDump
#>
param(
  [string]$SshHost = "ubuntu@118.178.95.156",
  [string]$Container = "app-postgres-1",
  [string]$RemoteDb = "dilee_erp",
  [string]$LocalContainer = "dilee-postgres-1",
  [string]$LocalDb = "dilee_snapshot",
  [string]$LocalUser = "dilee",
  [string]$DumpPath = (Join-Path $env:TEMP "dilee_prod.dump"),
  [switch]$SkipDump
)

$ErrorActionPreference = "Stop"

if (-not $SkipDump) {
  $remote = @"
set -e
sudo docker exec $Container pg_dump -U $LocalUser -d $RemoteDb -Fc -f /tmp/dilee_prod.dump
sudo docker cp ${Container}:/tmp/dilee_prod.dump /tmp/dilee_prod.dump
sudo chown ubuntu:ubuntu /tmp/dilee_prod.dump
"@
  $remoteFile = Join-Path $env:TEMP "dilee-snapshot-dump.sh"
  [System.IO.File]::WriteAllText($remoteFile, ($remote -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
  scp -q $remoteFile "${SshHost}:/tmp/dilee-snapshot-dump.sh"
  ssh $SshHost "bash /tmp/dilee-snapshot-dump.sh"
  scp -q "${SshHost}:/tmp/dilee_prod.dump" $DumpPath
  Write-Host "已取回快照：$DumpPath"
}

docker cp $DumpPath "${LocalContainer}:/tmp/dilee_prod.dump"
docker exec $LocalContainer psql -U $LocalUser -d postgres -c "DROP DATABASE IF EXISTS $LocalDb"
docker exec $LocalContainer psql -U $LocalUser -d postgres -c "CREATE DATABASE $LocalDb"
docker exec $LocalContainer pg_restore -U $LocalUser -d $LocalDb --no-owner --no-privileges /tmp/dilee_prod.dump
Write-Host "已还原到本地库：$LocalDb"

docker cp (Join-Path $PSScriptRoot "desensitize.sql") "${LocalContainer}:/tmp/desensitize.sql"
docker exec $LocalContainer psql -U $LocalUser -d $LocalDb -v ON_ERROR_STOP=1 -f /tmp/desensitize.sql | Out-Null
Write-Host "脱敏完成：$LocalDb"

$check = docker exec $LocalContainer psql -U $LocalUser -d $LocalDb -tAc "select (select count(*) from sales_orders)||' 张销售单 / '||(select count(*) from purchase_orders)||' 张采购单 / '||(select count(*) from users)||' 个账号（口令已作废）'"
Write-Host $check
Write-Host "连接串：postgresql://${LocalUser}:<密码>@127.0.0.1:5432/$LocalDb?schema=public"
