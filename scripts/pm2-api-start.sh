#!/usr/bin/env bash
set -euo pipefail

set -a
. ./.env
set +a

db_user=$(node -p 'encodeURIComponent(process.env.POSTGRES_USER)')
db_password=$(node -p 'encodeURIComponent(process.env.POSTGRES_PASSWORD)')
export NODE_ENV=production
export PORT=3001
export COOKIE_SECURE=false
export APP_VERSION="${APP_VERSION:-$(test -f RELEASE_VERSION && tr -d '\r\n' < RELEASE_VERSION || printf development)}"
export ATTACHMENT_STORAGE_PATH="${ATTACHMENT_STORAGE_PATH:-$PWD/var/attachments}"
export DATABASE_URL="${DATABASE_URL:-postgresql://${db_user}:${db_password}@127.0.0.1:5432/${POSTGRES_DB}?schema=public}"
mkdir -p "$ATTACHMENT_STORAGE_PATH"
exec node apps/api/dist/main.js
