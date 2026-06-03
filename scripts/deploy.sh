#!/bin/bash
# MyLLM deploy: local working copy -> server, rebuild, restart.
# Usage (from project root, git-bash): bash scripts/deploy.sh
#
# Credentials are NOT embedded. Provide one of:
#   MYLLM_SSH_PASS env var, OR
#   a password in $HOME/.myllm-deploy.secret (chmod 600, gitignored).
# Optional overrides: MYLLM_SSH (default root@YOUR_SERVER_IP),
#                     MYLLM_REMOTE (default /opt/freellmapi).
set -e

SRV="${MYLLM_SSH:-root@YOUR_SERVER_IP}"
REMOTE="${MYLLM_REMOTE:-/opt/freellmapi}"
PW_FILE="${MYLLM_PW_FILE:-$HOME/.myllm-deploy.secret}"

if [ -z "${MYLLM_SSH_PASS:-}" ] && [ -f "$PW_FILE" ]; then
  MYLLM_SSH_PASS="$(cat "$PW_FILE")"
fi
if [ -z "${MYLLM_SSH_PASS:-}" ]; then
  echo "ERROR: SSH password not set." >&2
  echo "  Set MYLLM_SSH_PASS env, or write password to: $PW_FILE" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo ">> packing local source"
tar --force-local -czf /tmp/myllm-deploy.tgz \
  --exclude=node_modules --exclude=.git --exclude=dist \
  --exclude=server/data --exclude='*.tgz' --exclude='*.bak*' \
  -C "$HERE" .

echo ">> uploading"
pscp -pw "$MYLLM_SSH_PASS" -batch /tmp/myllm-deploy.tgz "$SRV:/tmp/myllm-deploy.tgz"

echo ">> deploying on server (extract, build, restart)"
plink -ssh -pw "$MYLLM_SSH_PASS" -batch "$SRV" "
  set -e
  cd $REMOTE
  tar xzf /tmp/myllm-deploy.tgz -C $REMOTE
  npm install --silent 2>&1 | tail -1
  npm run build 2>&1 | tail -2
  pm2 restart myllm >/dev/null 2>&1
  sleep 4
  curl -s -m 5 -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:18789/v1/models
  rm -f /tmp/myllm-deploy.tgz
"
rm -f /tmp/myllm-deploy.tgz
echo ">> deploy done"
