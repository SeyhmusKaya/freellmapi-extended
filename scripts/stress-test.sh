#!/bin/bash
# 30 ardisik HTTPS proxy cagrisi, per-call ms + via, p50/p95/max ozet
set -u
KEY=$(curl -s http://127.0.0.1:18789/api/settings/api-key | python3 -c 'import sys,json;print(json.load(sys.stdin)["apiKey"])')
URL='https://myapi.example.com/v1/chat/completions'
WORDS=(house water tree book sun moon dog cat car road river mountain sea sky star cloud rain wind fire earth door window table chair bread milk coffee tea sugar salt)

printf '%3s %-10s %7s %5s  %s\n' '#' 'word' 'ms' 'http' 'via'
declare -a OK_MS=()
ERR=0
T0=$(date +%s%N)
for i in "${!WORDS[@]}"; do
  w=${WORDS[$i]}
  body=$(printf '{"messages":[{"role":"user","content":"Translate to Turkish, output only the Turkish word: %s"}],"max_tokens":40}' "$w")
  out=$(curl -sS -m 30 -o /tmp/_b -D /tmp/_h -w '%{http_code}|%{time_total}' "$URL" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$body")
  code=${out%%|*}
  t=${out##*|}
  via=$(grep -i '^x-routed-via:' /tmp/_h | tr -d '\r' | head -1 | sed 's/^[Xx]-[Rr]outed-[Vv]ia: //')
  ms=$(awk -v t="$t" 'BEGIN{printf "%.0f", t*1000}')
  printf '%3d %-10s %7sms %5s  %s\n' "$((i+1))" "$w" "$ms" "$code" "$via"
  if [ "$code" = '200' ]; then OK_MS+=("$ms"); else ERR=$((ERR+1)); fi
done
WALL_MS=$(( ( $(date +%s%N) - T0 ) / 1000000 ))
N=${#OK_MS[@]}
if [ "$N" -gt 0 ]; then
  IFS=$'\n' sorted=($(printf '%s\n' "${OK_MS[@]}" | sort -n))
  unset IFS
  sum=0; for v in "${OK_MS[@]}"; do sum=$((sum+v)); done
  avg=$((sum/N))
  min=${sorted[0]}
  p50=${sorted[$((N*50/100))]}
  p95=${sorted[$((N*95/100))]}
  max=${sorted[$((N-1))]}
  echo '---'
  echo "N=$N err=$ERR avg=${avg}ms min=${min}ms p50=${p50}ms p95=${p95}ms max=${max}ms wall=${WALL_MS}ms"
else
  echo "all failed (err=$ERR)"
fi
rm -f /tmp/_b /tmp/_h
