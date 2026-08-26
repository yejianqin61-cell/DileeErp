#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV=production
export PORT=3000
export HOSTNAME=0.0.0.0
export API_INTERNAL_URL=http://127.0.0.1:3001
exec node apps/web/.next/standalone/apps/web/server.js
