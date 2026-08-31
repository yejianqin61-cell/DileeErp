#!/usr/bin/env bash
set -euo pipefail

cd /opt/dilee
pm2 stop dilee-api dilee-web 2>/dev/null || true
backup="/opt/dilee/app.backup-$(date +%Y%m%d-%H%M%S)"
mv /opt/dilee/app "$backup"
mkdir /opt/dilee/app
tar -xzf /tmp/DileeErp-latest.tar.gz -C /opt/dilee/app
test -f /opt/dilee/app/RELEASE_VERSION
export APP_VERSION="$(tr -d '\r\n' < /opt/dilee/app/RELEASE_VERSION)"
test "${APP_VERSION}" != "development"
cp "$backup/.env" /opt/dilee/app/.env
cd /opt/dilee/app
sudo docker compose up -d postgres
npm ci --include=dev
npx prisma generate --schema apps/api/prisma/schema.prisma
set -a
. ./.env
set +a
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}?schema=public"
export NODE_ENV=production
export COOKIE_SECURE=false
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
npm run build --workspace=@dilee/api
npm run build --workspace=@dilee/web
mkdir -p apps/web/.next/standalone/apps/web/.next
cp -a apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
if [ -d apps/web/public ]; then cp -a apps/web/public apps/web/.next/standalone/apps/web/; fi
pm2 delete dilee-api 2>/dev/null || true
pm2 delete dilee-web 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
curl -fsS http://127.0.0.1:3001/api/v1/health
