#!/usr/bin/env bash
# Phase 1 æž„å»ºæœŸé‡‡æ ·ï¼šæ¯ 5 ç§’è®°ä¸€è¡Œï¼Œç›´åˆ°è¢« SIGTERMã€‚
# è®°å½•ï¼šæ—¶é—´ã€1 åˆ†é’Ÿè´Ÿè½½ã€å¯ç”¨å†…å­˜ã€swap å·²ç”¨ã€æ ¹ç›˜å·²ç”¨ã€health å»¶è¿Ÿä¸ŽçŠ¶æ€ç ã€‚
# åªè¯»ï¼šåªå‘ GET /api/v1/healthã€‚
set -u
INTERVAL="${1:-5}"
OUT="${2:-/opt/dilee/agent/phase1/samples.tsv}"
mkdir -p "$(dirname "$OUT")"
printf 'iso_time\tload1\tmem_avail_mb\tswap_used_mb\troot_used_pct\thealth_ms\thealth_code\n' > "$OUT"

STOP=0
trap 'STOP=1' TERM INT

while [ "$STOP" -eq 0 ]; do
  iso="$(date -Is)"
  load1="$(cut -d' ' -f1 /proc/loadavg)"
  mem_avail="$(free -m | awk '/^Mem:/{print $7}')"
  swap_used="$(free -m | awk '/^Swap:/{print $3}')"
  root_pct="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
  # health å»¶è¿Ÿï¼šå•æ¬¡ GETï¼Œè¶…æ—¶ 5 ç§’
  code_ms="$(curl -s -o /dev/null -m 5 -w '%{http_code} %{time_total}' http://127.0.0.1:3001/api/v1/health 2>/dev/null || echo '000 5.000')"
  code="${code_ms% *}"
  secs="${code_ms#* }"
  ms="$(awk -v s="$secs" 'BEGIN{printf "%d", s*1000}')"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$iso" "$load1" "$mem_avail" "$swap_used" "$root_pct" "$ms" "$code" >> "$OUT"
  sleep "$INTERVAL"
done
echo "stopped; rows=$(($(wc -l < "$OUT") - 1))"
