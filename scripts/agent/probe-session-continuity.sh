#!/usr/bin/env bash
# 验证「每个工单一个会话」的正确用法。
#
# 关键事实（本次实测得到，与 --help 的字面意思不同）：
#   --session-id 只能**续接已存在的会话**，不能用来命名新会话。
#   直接给一个新 id 会报：session "<id>" does not exist; omit --session-id to start a new Session
#
# 所以正确流程是：
#   1) 第一次不带 --session-id，加 --json，从首行 session 事件里读出系统分配的 id；
#   2) 把这个 id 存进工单；
#   3) 之后所有调用都带 --session-id <id>。
#
# 这个探测就是在验证上面三步真的能跑通，而不是照着 --help 猜。
set -uo pipefail

DSH=/opt/dilee/app/node_modules/@deepseek-ai/dsh/lib/bin.js
NODE=/opt/node24/bin/node
WORK=/opt/dilee/agent/session-probe
mkdir -p "$WORK"
cd "$WORK"
export PATH="/opt/node24/bin:$PATH"

KEY="$(set -a; . /opt/dilee/app/.env; set +a; printf '%s' "${DEEPSEEK_API_KEY:-}")"
[ -n "$KEY" ] || { echo "读不到 DEEPSEEK_API_KEY" >&2; exit 1; }

run() {
  # run <输出文件> <是否带 session-id> [session-id] <prompt>
  local out="$1"; shift
  DEEPSEEK_API_KEY="$KEY" timeout 180 "$NODE" "$DSH" \
    --profile headless \
    --approval-policy never \
    --permission-mode workspace-write \
    --json \
    "$@" > "$out" 2>/dev/null
  echo $?
}

echo "=== 第一次：新建会话，从 --json 首行取 session id ==="
RC1=$(run first.jsonl "记住这个数字：42。只回复 OK")
echo "rc1=$RC1"
SID="$(/opt/node24/bin/node -e '
  const fs=require("fs");
  for (const line of fs.readFileSync(process.argv[1],"utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const e=JSON.parse(line); if (e.type==="session" && e.sessionId) { console.log(e.sessionId); break; } } catch {}
  }
' "$WORK/first.jsonl")"
echo "captured session id = ${SID:-（未取到）}"

if [ -z "$SID" ]; then
  echo "首行 session 事件里没有 sessionId，看一下原始输出："
  head -3 "$WORK/first.jsonl"
  echo "SESSION_CONTINUITY_FAIL"
  exit 1
fi

echo
echo "=== 第二次：用捕获到的 id 续接，问它记住的数字 ==="
RC2=$(run second.jsonl --session-id "$SID" "我刚才让你记住的数字是多少？只回复数字。")
echo "rc2=$RC2"
ANSWER="$(/opt/node24/bin/node -e '
  const fs=require("fs");
  const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
  let text="";
  for (const line of lines) { try { const e=JSON.parse(line); if (e.type==="final" && e.text) text=e.text; if (e.type==="text" && e.text) text=e.text; } catch {} }
  console.log(text.trim());
' "$WORK/second.jsonl")"
echo "answer=[$ANSWER]"

echo
echo "=== 第三次：错误的做法，确认它会明确报错（而不是静默新建） ==="
BAD="$(/opt/node24/bin/node "$DSH" --profile headless --approval-policy never \
  --session-id "ticket-nonexistent-$RANDOM" "hi" 2>&1 | tail -2)"
echo "  $BAD"

echo
if [ "$RC1" -eq 0 ] && [ "$RC2" -eq 0 ] && printf '%s' "$ANSWER" | grep -q '42'; then
  echo "SESSION_CONTINUITY_OK session_id=$SID"
  exit 0
fi
echo "SESSION_CONTINUITY_FAIL"
exit 1
