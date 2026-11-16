#!/usr/bin/env bash
# 端到端验证：从「一句口语需求」到「Harness 真改代码」。
#
# 不经过飞书：直接调用 Coordinator 处理一条构造好的消息。
# 这样能把「飞书传输」和「编排+Harness」分开验证 ——
# 飞书那层已经有 Phase 2 的 54 条测试覆盖，这里要验的是后半段。
#
# 判定标准（三条都要满足）：
#   1. Harness 真的起了会话，并捕获到 session id；
#   2. 工作区真的多了提交（说明它改了代码）；
#   3. 卡片内容是 green 且带结论。
set -uo pipefail

cd /opt/dilee/agent/ticket-agent
export PATH="/opt/node24/bin:$PATH"
set -a; . ./.env; set +a

echo "=== 测试前工作区状态 ==="
cd /opt/dilee/agent/repo
BEFORE_COMMITS="$(git rev-list --count HEAD)"
BEFORE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "  分支=$BEFORE_BRANCH 提交数=$BEFORE_COMMITS"
git log --oneline -1
echo

cd /opt/dilee/agent/ticket-agent

cat > /tmp/e2e-run.ts <<'TS'
import { Coordinator } from './src/coordinator.ts'
import { FakeFeishuTransport } from './src/feishu-fake.ts'
import { TicketStore } from './src/ticket-store.ts'
import type { IncomingMessage } from './src/feishu-event.ts'

const transport = new FakeFeishuTransport()
const store = new TicketStore('/opt/dilee/agent/tickets')
const coordinator = new Coordinator({
  store,
  transport,
  dshBin: '/opt/dilee/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
  nodePath: '/opt/node24/bin/node',
  repoPath: '/opt/dilee/agent/repo',
  timeoutMs: 20 * 60 * 1000,
  log: (line) => console.log(line),
})

const message: IncomingMessage = {
  messageId: `om_e2e_${Date.now()}`,
  chatId: 'oc_e2e_test',
  chatType: 'group',
  senderOpenId: 'ou_e2e_user',
  senderType: 'user',
  text: '在仓库根目录新建一个文件 AGENT_SMOKE.md，内容只写一行：agent e2e ok。然后 git add 并 commit，提交信息写 "test(agent): e2e smoke"。不要改其他任何文件。',
  mentionsBot: true,
  eventId: 'ev_e2e',
  createTime: String(Date.now()),
  threadId: null,
  parentId: null,
  rootId: null,
}

console.log('=== 提交给 Coordinator ===')
console.log(message.text)
console.log()

const outcome = await coordinator.handle(message)
console.log('handle outcome=', JSON.stringify(outcome))

console.log('=== 等待串行队列跑完 ===')
await coordinator.drain()
console.log('队列已排空')

const tickets = store.all().filter((t) => t.chatId === 'oc_e2e_test')
const latest = tickets[tickets.length - 1]
console.log('工单：', latest?.no, '状态：', latest?.state, '会话：', latest?.sessionId)

console.log('=== 发出的卡片 ===')
for (const record of transport.sent) {
  console.log(`  [${record.kind}] ${record.payload.slice(0, 120)}`)
  if (record.card) {
    console.log(`    template=${record.card.template}`)
    for (const line of record.card.lines) console.log(`    | ${line.slice(0, 200)}`)
  }
}

process.exit(0)
TS

echo "=== 开始端到端 run（最多 20 分钟） ==="
node --import tsx /tmp/e2e-run.ts 2>&1 | tail -60

echo
echo "=== 测试后工作区状态 ==="
cd /opt/dilee/agent/repo
AFTER_COMMITS="$(git rev-list --count HEAD)"
echo "  提交数 $BEFORE_COMMITS → $AFTER_COMMITS"
git log --oneline -3
echo "--- 新文件？ ---"
ls -la AGENT_SMOKE.md 2>/dev/null && cat AGENT_SMOKE.md 2>/dev/null || echo "  (没有 AGENT_SMOKE.md)"
echo "--- git status ---"
git status --short | head -10

echo
if [ "$AFTER_COMMITS" -gt "$BEFORE_COMMITS" ]; then
  echo "E2E_CODE_CHANGED commits_delta=$((AFTER_COMMITS - BEFORE_COMMITS))"
else
  echo "E2E_NO_CODE_CHANGE"
fi
