#!/usr/bin/env bash
set -euo pipefail

cd /opt/dilee
pm2 stop dilee-api dilee-web 2>/dev/null || true
backup="/opt/dilee/app.backup-$(date +%Y%m%d-%H%M%S)"
mv /opt/dilee/app "$backup"
mkdir /opt/dilee/app
tar -xzf /tmp/DileeErp-latest.tar.gz -C /opt/dilee/app
find /opt/dilee/app/scripts -type f -name '*.sh' -exec sed -i 's/\r$//' {} +
test -f /opt/dilee/app/RELEASE_VERSION
export APP_VERSION="$(tr -d '\r\n' < /opt/dilee/app/RELEASE_VERSION)"
test "${APP_VERSION}" != "development"
cp "$backup/.env" /opt/dilee/app/.env
cd /opt/dilee/app

# --- Postgres readiness ----------------------------------------------
# The ERP database runs in the standalone docker container
# "app-postgres-1" (host port 15432 -> 5432). Do NOT `docker compose up -d
# postgres` here: docker-compose.yml maps host port 5432, which collides
# with the native postgres listening on 127.0.0.1:5432 and aborts the
# deploy. Instead make sure the existing container keeps running, or fall
# through on hosts where postgres runs natively.
container="app-postgres-1"
if sudo docker inspect -f '{{.State.Running}}' "$container" >/dev/null 2>&1; then
  if [ "$(sudo docker inspect -f '{{.State.Running}}' "$container")" != "true" ]; then
    echo ">> starting postgres container $container"
    sudo docker start "$container" >/dev/null
  fi
  ready=false
  for _ in $(seq 1 30); do
    if sudo docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 2
  done
  if [ "$ready" != "true" ]; then
    echo ">> ERROR: postgres container $container not ready after 60s" >&2
    exit 1
  fi
  echo ">> postgres container $container is ready"
else
  echo ">> container $container not found; assuming postgres runs natively"
fi

npm ci --include=dev
npx prisma generate --schema apps/api/prisma/schema.prisma

# --- Migrations must hit the SAME database the app uses --------------
# .env carries the authoritative DATABASE_URL (e.g.
# postgresql://dilee:...@127.0.0.1:15432/dilee_erp). Never rebuild it from
# POSTGRES_USER/POSTGRES_PASSWORD plus a hardcoded 5432 port: those
# variables are not guaranteed to match the encoded URL in .env.
set -a
. ./.env
set +a
: "${DATABASE_URL:?DATABASE_URL must be set in .env}"
printf '>> migrate target: %s\n' "$(printf '%s' "$DATABASE_URL" | sed -E 's#(postgresql://[^:]+:)[^@]+@#\1****@#')"
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
