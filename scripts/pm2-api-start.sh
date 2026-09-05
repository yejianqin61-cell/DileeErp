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
mkdir -p "$ATTACHMENT_STORAGE_PATH"
exec node apps/api/dist/main.js
