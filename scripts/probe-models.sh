#!/bin/bash
# Daily model health probe. Forces each enabled TEXT model through the local
# proxy and records OK/FAIL. Writes JSON consumed by /api/model-status.
#
# Only text-modality models are probed: the probe sends a chat-completion
# request, which embedding/rerank/audio/image models cannot answer — probing
# them would produce permanent false failures. Non-text health is not covered
# by this script.
#
# Each result is serialised by python (json.dumps) as one NDJSON line, so an
# error message containing quotes/newlines/control chars can never corrupt the
# output file. The final step reads the NDJSON and emits the status JSON.
set -u
DB=/opt/freellmapi/server/data/freeapi.db
OUT=/opt/freellmapi/server/data/model-status.json
BASE="http://127.0.0.1:18789"

# Fetch unified API key dynamically from local app (no hardcoded secret in repo).
KEY=$(curl -s -m 5 "$BASE/api/settings/api-key" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("apiKey",""))' 2>/dev/null)
if [ -z "$KEY" ]; then
  echo "probe: failed to fetch unified API key from $BASE/api/settings/api-key" >&2
  exit 1
fi

tmp=$(mktemp)
while IFS='|' read -r platform model; do
  [ -z "$platform" ] && continue
  # no_cascade=true → the proxy surfaces THIS model's real error instead of
  # cascading to another model and reporting that one's status.
  # probe=true → the proxy does NOT write this diagnostic call to the `requests`
  # analytics table, so synthetic failures on known-dead models never pollute
  # real consumer success rates (cooldown/routing logic still runs).
  code=$(curl -s -m 30 -o /tmp/_mb -w "%{http_code}" "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":3,\"no_cascade\":true,\"probe\":true}")
  if [ "$code" = "200" ]; then
    status="ok"; err=""
  else
    status="fail"
    err=$(head -c 200 /tmp/_mb)
  fi
  # Serialise this single result with python — env vars carry the raw values
  # so no shell quoting can break the JSON.
  P="$platform" M="$model" S="$status" C="$code" E="$err" python3 -c '
import os, sys, json
raw = os.environ.get("E", "")
msg = ""
try:
    d = json.loads(raw)
    msg = (d.get("error", {}).get("message", "") or "")[:160]
except Exception:
    msg = ""
code = os.environ.get("C", "0")
try:
    code = int(code)
except Exception:
    code = 0
sys.stdout.write(json.dumps({
    "platform": os.environ.get("P", ""),
    "model": os.environ.get("M", ""),
    "status": os.environ.get("S", "fail"),
    "httpCode": code,
    "error": msg,
}) + "\n")
' >> "$tmp"
done < <(sqlite3 "$DB" "SELECT platform||'|'||model_id FROM models WHERE enabled=1 AND platform!='ollama' AND (modality='text' OR modality IS NULL) ORDER BY platform, model_id;")

gen=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 - "$tmp" "$OUT" "$gen" <<'PYEOF'
import sys, json
tmp, out, gen = sys.argv[1:4]
results = []
with open(tmp, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line:
            results.append(json.loads(line))
ok = sum(1 for r in results if r["status"] == "ok")
fail = len(results) - ok
json.dump({"generatedAt": gen, "ok": ok, "fail": fail, "total": len(results), "results": results},
          open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("probe done:", ok, "ok", fail, "fail", len(results), "total")
PYEOF
rm -f "$tmp" /tmp/_mb
