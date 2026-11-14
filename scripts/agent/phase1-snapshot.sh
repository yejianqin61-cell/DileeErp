#!/usr/bin/env bash
# Phase 1 åŸºçº¿é‡‡æ ·ï¼šè®°å½•æž„å»ºå‰åŽçš„ç”Ÿäº§çŠ¶æ€ã€‚
# åªè¯»ï¼šhealth / pm2 / free / df / docker psã€‚ä¸å†™ç”Ÿäº§åº“ã€ä¸é‡å¯æœåŠ¡ã€‚
set -u
STAMP="${1:-baseline}"
OUT="/opt/dilee/agent/phase1/${STAMP}.txt"
mkdir -p "$(dirname "$OUT")"

{
  echo "=== stamp: $STAMP  time: $(date -Is) ==="
  echo "--- health ---"
  curl -fsS http://127.0.0.1:3001/api/v1/health || echo "(health-failed)"
  echo
  echo "--- pm2 ---"
  pm2 jlist 2>/dev/null > /tmp/_p.json
  /opt/node24/bin/node -e '
    const a = require("/tmp/_p.json");
    for (const x of a) {
      const m = x.monit || {};
      console.log(x.name, x.pm2_env.status,
        "mem=" + Math.round((m.memory || 0) / 1048576) + "MB",
        "cpu=" + (m.cpu || 0),
        "restarts=" + (x.pm2_env.restart_time || 0));
    }
  ' 2>/dev/null || pm2 list
  echo "--- memory ---"
  free -m
  echo "--- swap ---"
  swapon --show
  echo "--- disk ---"
  df -h / /tmp
  echo "--- load ---"
  uptime
  echo "--- postgres ---"
  sudo docker stats --no-stream --format '{{.Name}} mem={{.MemUsage}} cpu={{.CPUPerc}}' 2>/dev/null || echo "(docker stats failed)"
  echo "--- agent dir size ---"
  du -sh /opt/dilee/agent 2>/dev/null || echo "(no agent dir)"
  echo
} | tee "$OUT"

echo "written: $OUT"
