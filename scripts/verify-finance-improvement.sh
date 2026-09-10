#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== Finance improvement verification =="
echo "Workspace: $(pwd)"

echo
echo "== 1. Generate Prisma Client =="
npm run db:generate --workspace=@dilee/api

echo
echo "== 2. Typecheck =="
npm run typecheck

echo
echo "== 3. Build =="
npm run build

echo
echo "== 4. Unit tests =="
npm run test:unit

if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  echo
  echo "== 5. PostgreSQL integration tests =="
  npm run db:test:prepare
  npm run test:integration
else
  echo
  echo "SKIP integration: TEST_DATABASE_URL is not set"
fi

if [[ -n "${API_BASE_URL:-}" ]]; then
  echo
  echo "== 6. HTTP API tests =="
  npm run test:api
else
  echo
  echo "SKIP API tests: API_BASE_URL is not set"
fi

if [[ -n "${PLAYWRIGHT_BASE_URL:-}" ]]; then
  echo
  echo "== 7. Playwright tests =="
  npm run test:e2e
else
  echo
  echo "SKIP E2E tests: PLAYWRIGHT_BASE_URL is not set"
fi

echo
echo "== 8. Release archive verification =="
npm run release:verify

echo
echo "== Finance improvement verification finished =="
