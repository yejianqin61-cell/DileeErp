#!/usr/bin/env bash
# 从 Agent 工作区打发布包，产物结构与 scripts/create-release-archive.ps1 一致。
#
# 为什么不直接跑 create-release-archive.ps1：那是 Windows/PowerShell 脚本，
# 服务器上没有 PowerShell 5.1。这里按它的判据在 Linux 上重做一遍：
#   1) 只打已提交内容（git archive）
#   2) RELEASE_VERSION 写提交号，UTF-8 无 BOM、无换行
#   3) 顶层必须是仓库内容，禁止夹带本机目录
#
# 用法：bash agent-pack.sh <repo> <commit> <输出包>
set -euo pipefail

REPO="${1:?repo}"
COMMIT="${2:?commit}"
OUT="${3:?output tarball}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

cd "$REPO" || { echo "进不去 $REPO" >&2; exit 1; }

FULL="$(git rev-parse "$COMMIT")"
log "打包提交 $FULL"

STAGE="$(mktemp -d /tmp/agent-pack-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

git archive --format=tar --output="$STAGE/source.tar" "$FULL"
tar -xf "$STAGE/source.tar" -C "$STAGE"
rm -f "$STAGE/source.tar"

# 无 BOM、无换行：服务器用 tr -d '\r\n' 读取，带 BOM 会让 health 比对失败
printf '%s' "$FULL" > "$STAGE/RELEASE_VERSION"

# 结构自检：与部署标准 §本地打包与上传 同一判据
for expected in package.json package-lock.json apps ecosystem.config.cjs scripts RELEASE_VERSION; do
  [ -e "$STAGE/$expected" ] || { echo "发布包缺少顶层条目：$expected" >&2; exit 1; }
done
for forbidden in .android .claude AppData Users .pnpm-store .dsh-meow node_modules; do
  [ -e "$STAGE/$forbidden" ] && { echo "发布包出现禁止目录：$forbidden" >&2; exit 1; }
done

mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" -C "$STAGE" .
log "已生成 $OUT ($(du -h "$OUT" | cut -f1))"

# 复核顶层条目。
# 注意：**不能**写成 `tar -tzf "$OUT" | grep -qx './RELEASE_VERSION'`。
# 在 `set -o pipefail` 下，grep -q 命中即退出并关闭管道，tar 收到 SIGPIPE 以 141 退出，
# 整条管线被判失败 —— 包其实是好的。这与 scripts/deploy/common.sh 里记录的坑同源：
# 先把清单落盘，再过滤。
LIST="$STAGE/.listing.txt"
tar -tzf "$OUT" > "$LIST"
if ! grep -qx './RELEASE_VERSION' "$LIST"; then
  echo "复核失败：包内没有 RELEASE_VERSION" >&2
  exit 1
fi
for expected in ./package.json ./package-lock.json ./apps/ ./ecosystem.config.cjs ./scripts/; do
  grep -qx -- "$expected" "$LIST" || { echo "复核失败：包内缺少 $expected" >&2; exit 1; }
done
rm -f "$LIST"
cat "$STAGE/RELEASE_VERSION"; echo
log "PACK_OK release=$(cat "$STAGE/RELEASE_VERSION")"
