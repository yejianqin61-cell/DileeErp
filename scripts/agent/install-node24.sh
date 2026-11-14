#!/usr/bin/env bash
# Phase 1：把 Node 24 装到独立前缀 /opt/node24，与线上 Node 22 并存。
#
# 安全约束：
#   - 不做任何全局替换：不碰 /usr/local/bin/node、不碰 /usr/local/lib/node_modules、不改 PATH。
#   - 装完必须证明线上仍是 22，且 production health 仍然 ok。
#   - 幂等：已装同版本则跳过下载。
#
# 用法：bash install-node24.sh [版本，默认 v24.22.3]
set -euo pipefail

VERSION="${1:-v24.22.3}"
PREFIX="/opt/node24"
ARCH="linux-x64"
TARBALL="node-${VERSION}-${ARCH}.tar.xz"
URL="https://nodejs.org/dist/${VERSION}/${TARBALL}"
TMP="/tmp/${TARBALL}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [ -x "$PREFIX/bin/node" ] && "$PREFIX/bin/node" -v 2>/dev/null | grep -qx "$VERSION"; then
  log "已安装 $VERSION，跳过"
  "$PREFIX/bin/node" -v
  exit 0
fi

log "取校验和"
EXPECTED="$(curl -fsSL -m 30 "https://nodejs.org/dist/${VERSION}/SHASUMS256.txt" \
  | awk -v f="$TARBALL" '$2 == f { print $1 }')"
[ -n "$EXPECTED" ] || { echo "找不到 $TARBALL 的校验和" >&2; exit 1; }
log "expected sha256 = $EXPECTED"

if [ ! -f "$TMP" ]; then
  log "下载 $URL"
  curl -fsSL -m 300 -o "$TMP" "$URL"
fi

ACTUAL="$(sha256sum "$TMP" | awk '{print $1}')"
log "actual   sha256 = $ACTUAL"
[ "$ACTUAL" = "$EXPECTED" ] || { echo "校验和不匹配，拒绝安装" >&2; exit 1; }
log "校验通过"

log "解压到 $PREFIX"
# /opt 属于 root，需要 sudo 建目录；建完 chown 给当前用户，后续操作不再提权。
sudo rm -rf "${PREFIX}.new" "${PREFIX}.old"
sudo mkdir -p "${PREFIX}.new"
sudo chown "$(id -u):$(id -g)" "${PREFIX}.new"
tar -xJf "$TMP" -C "${PREFIX}.new" --strip-components=1
"${PREFIX}.new/bin/node" -v

# 原子替换：先换到 .new，再改名为正式目录
if [ -d "$PREFIX" ]; then
  sudo mv "$PREFIX" "${PREFIX}.old"
fi
sudo mv "${PREFIX}.new" "$PREFIX"
sudo rm -rf "${PREFIX}.old"

log "已安装到 $PREFIX"
"$PREFIX/bin/node" -v
"$PREFIX/bin/npm" -v

log "确认线上 Node 未被改动"
echo "  which node : $(command -v node)"
echo "  node -v    : $(node -v)"
echo "  npm -v     : $(npm -v)"

log "确认生产仍健康"
curl -fsS http://127.0.0.1:3001/api/v1/health || { echo "生产 health 异常" >&2; exit 1; }
echo
log "NODE24_OK"
