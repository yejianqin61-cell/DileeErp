#!/usr/bin/env bash
set -euo pipefail

set -a
. ./.env
set +a

export NODE_ENV=production
export PORT=3001
export COOKIE_SECURE=false
export APP_VERSION="${APP_VERSION:-$(test -f RELEASE_VERSION && tr -d '\r\n' < RELEASE_VERSION || printf development)}"
export ATTACHMENT_STORAGE_PATH="${ATTACHMENT_STORAGE_PATH:-$PWD/var/attachments}"
: "${DATABASE_URL:?DATABASE_URL must be set in .env for PM2 production startup}"
: "${AGENT_READ_DATABASE_URL:?AGENT_READ_DATABASE_URL must be set in .env for PM2 production startup}"
: "${AGENT_STATE_DATABASE_URL:?AGENT_STATE_DATABASE_URL must be set in .env for PM2 production startup}"
: "${AGENT_LLM_PROVIDER:?AGENT_LLM_PROVIDER must be set in .env for PM2 production startup}"
: "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be set in .env for PM2 production startup}"
[ "$AGENT_LLM_PROVIDER" = "deepseek" ] || { echo "AGENT_LLM_PROVIDER must be deepseek in production" >&2; exit 1; }
mkdir -p "$ATTACHMENT_STORAGE_PATH"
exec node apps/api/dist/main.js
