#!/usr/bin/env bash
# 一次性：给服务器配 GitHub 推送凭据（SSH deploy key），并设置 agent 仓库的 remote。
#
# 为什么用 deploy key 而不是把 PAT 放进 .env：
#   - deploy key 只对这一个仓库有效、可随时在 GitHub 侧吊销；
#   - PAT 是账号级凭据，落到服务器文件里影响面大得多。
#
# 唯一的人工步骤：把脚本最后打印的公钥加到
#   GitHub 仓库 → Settings → Deploy keys → Add deploy key，勾选 Allow write access。
#
# 重复执行是安全的：已有 key 就复用，ssh 配置已有就跳过。
set -euo pipefail

KEY="$HOME/.ssh/dilee_github"
REPO="${REPO:-/opt/dilee/agent/repo}"
FETCH_URL="${FETCH_URL:-https://github.com/yejianqin61-cell/DileeErp.git}"
PUSH_URL="${PUSH_URL:-git@github.com:yejianqin61-cell/DileeErp.git}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

if [ ! -f "$KEY" ]; then
  log "生成 SSH deploy key：$KEY"
  ssh-keygen -t ed25519 -N "" -C "dilee-agent@$(hostname)" -f "$KEY" >/dev/null
else
  log "已存在 key，复用：$KEY"
fi
chmod 600 "$KEY"
chmod 644 "$KEY.pub"

# ssh config：只对 github.com 用这把 key，不动其它 Host。
if ! grep -q "IdentityFile $KEY" "$HOME/.ssh/config" 2>/dev/null; then
  log "写入 ~/.ssh/config（Host github.com 段）"
  cat >> "$HOME/.ssh/config" <<EOF

Host github.com
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
  chmod 600 "$HOME/.ssh/config"
else
  log "~/.ssh/config 已配置，跳过"
fi

if [ -d "$REPO/.git" ]; then
  log "设置仓库 remote（fetch 用 HTTPS，push 用 SSH）"
  cd "$REPO"
  git remote set-url origin "$FETCH_URL"
  git remote set-url --push origin "$PUSH_URL"
  git remote -v
else
  echo "警告：$REPO 不是 git 仓库，跳过 remote 设置" >&2
fi

echo
echo "==================== 需要你做的事（一次） ===================="
echo "把下面这行公钥加到 GitHub 仓库的 Deploy keys，勾选 Allow write access："
echo
cat "$KEY.pub"
echo
echo "加完后在服务器上验证："
echo "  ssh -T git@github.com          # 应显示 successfully authenticated"
echo "============================================================="
