#!/usr/bin/env bash
# Phase 1 一次跑完：打包 → 起采样 → 构建 → 停采样 → 出摘要。
# 全程不碰 /opt/dilee/app，不碰生产库。
set -uo pipefail

BIN=/opt/dilee/agent/bin
WORK=/opt/dilee/agent
PHASE1=$WORK/phase1
REPO=$WORK/repo
ARCHIVE=$PHASE1/candidate.tar.gz
STAGE=$WORK/build
SAMPLES=$PHASE1/samples.tsv

mkdir -p "$PHASE1"
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

log "=== 0. 跑前快照 ==="
bash "$BIN/phase1-snapshot.sh" before-build >/dev/null 2>&1
echo "  可用内存: $(free -m | awk '/^Mem:/{print $7}') MB"
echo "  swap 已用: $(free -m | awk '/^Swap:/{print $3}') MB"
echo "  根盘可用: $(df -h / | awk 'NR==2{print $4}')"
echo "  负载: $(cut -d' ' -f1-3 /proc/loadavg)"

log "=== 1. 打包（HEAD 1607b9c） ==="
START_PACK=$(date +%s)
if ! bash "$BIN/agent-pack.sh" "$REPO" 1607b9c "$ARCHIVE" 2>&1 | sed 's/^/  /'; then
  log "打包失败"; exit 1
fi
log "打包耗时 $(( $(date +%s) - START_PACK ))s"

log "=== 2. 起采样（每 5 秒一行） ==="
rm -f "$SAMPLES"
nohup bash "$BIN/phase1-sample.sh" 5 "$SAMPLES" >/dev/null 2>&1 &
SAMPLE_PID=$!
sleep 2
log "采样 PID=$SAMPLE_PID"

log "=== 3. 构建（与生产同一组命令） ==="
BUILD_START=$(date +%s)
bash "$BIN/phase1-build.sh" "$ARCHIVE" "$STAGE" "$PHASE1/build.log" 2>&1 | sed 's/^/  /'
BUILD_RC=${PIPESTATUS[0]}
BUILD_SECS=$(( $(date +%s) - BUILD_START ))
log "构建退出码=$BUILD_RC 耗时=${BUILD_SECS}s"

log "=== 4. 停采样 ==="
kill -TERM "$SAMPLE_PID" 2>/dev/null
wait "$SAMPLE_PID" 2>/dev/null
ROWS=$(( $(wc -l < "$SAMPLES") - 1 ))
log "采样行数=$ROWS"

log "=== 5. 跑后快照 ==="
bash "$BIN/phase1-snapshot.sh" after-build >/dev/null 2>&1

log "=== 6. 摘要 ==="
/opt/node24/bin/node -e '
const fs = require("fs");
const path = process.argv[1];
const lines = fs.readFileSync(path, "utf8").trim().split("\n").slice(1);
if (!lines.length) { console.log("  没有采样数据"); process.exit(0); }
const rows = lines.map((l) => {
  const c = l.split("\t");
  return { t: c[0], load: +c[1], avail: +c[2], swap: +c[3], disk: +c[4], ms: +c[5], code: +c[6] };
});
const max = (k) => Math.max(...rows.map((r) => r[k]));
const min = (k) => Math.min(...rows.map((r) => r[k]));
const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
const pct = (vals, p) => {
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const ms = rows.map((r) => r.ms).filter((n) => n > 0);
console.log("  采样点        " + rows.length);
console.log("  时间窗         " + rows[0].t + " → " + rows[rows.length - 1].t);
console.log("  负载 1min     max=" + max("load").toFixed(2) + " avg=" + avg("load").toFixed(2));
console.log("  可用内存 MB   min=" + min("avail") + " avg=" + avg("avail").toFixed(0));
console.log("  swap 已用 MB  max=" + max("swap") + " avg=" + avg("swap").toFixed(0));
console.log("  根盘已用 %    max=" + max("disk"));
console.log("  health ms     p50=" + pct(ms, 0.5) + " p95=" + pct(ms, 0.95) + " max=" + Math.max(...ms));
const bad = rows.filter((r) => r.code !== 200);
console.log("  非 200 次数    " + bad.length);
' "$SAMPLES"

echo
echo "--- 构建日志尾部 ---"
tail -6 "$PHASE1/build.log" 2>/dev/null
echo
echo "--- 磁盘与体积 ---"
echo "  候选目录: $(du -sh "$STAGE" 2>/dev/null | cut -f1)"
echo "  发布包  : $(du -sh "$ARCHIVE" 2>/dev/null | cut -f1)"
echo "  agent 总量: $(du -sh "$WORK" 2>/dev/null | cut -f1)"
echo "  根盘可用: $(df -h / | awk 'NR==2{print $4}')"
echo
log "PHASE1_RUN_DONE rc=$BUILD_RC"
exit "$BUILD_RC"
