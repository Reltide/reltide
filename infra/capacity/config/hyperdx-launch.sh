#!/bin/sh
# Experiment launcher compared against HyperDX 2.39.1 entry.prod.sh (R5).
# Alert delivery/dashboard provisioning are outside this isolated experiment.
set -eu
export FRONTEND_URL="${FRONTEND_URL:-${HYPERDX_APP_URL:-http://localhost}:${HYPERDX_APP_PORT:-8080}}"
export OPAMP_PORT="${HYPERDX_OPAMP_PORT:-4320}"
export HYPERDX_IMAGE=hyperdx
export IS_LOCAL_APP_MODE=REQUIRED_AUTH
node /etc/local/refresh-env.js
PORT="${HYPERDX_API_PORT:-8000}" HYPERDX_APP_PORT="${HYPERDX_APP_PORT:-8080}" ./packages/api/bin/hyperdx api &
api=$!
(cd ./packages/app/packages/app && HOSTNAME="${HYPERDX_APP_LISTEN_HOSTNAME:-0.0.0.0}" HYPERDX_API_PORT="${HYPERDX_API_PORT:-8000}" PORT="${HYPERDX_APP_PORT:-8080}" exec node server.js) &
app=$!
terminate() {
  kill -TERM "$api" "$app" 2>/dev/null || true
  wait "$api" 2>/dev/null || true
  wait "$app" 2>/dev/null || true
}
trap 'terminate; exit 143' TERM INT
while kill -0 "$api" 2>/dev/null && kill -0 "$app" 2>/dev/null; do sleep 1; done
terminate
exit 1
