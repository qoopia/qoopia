#!/bin/sh
REQUIRED_NODE="/Users/askhatsoltanov/.nvm/versions/node/v24.14.0/bin/node"
if [ ! -x "$REQUIRED_NODE" ]; then
  echo "FATAL: Required Node not found at $REQUIRED_NODE" >&2
  exit 1
fi
export PATH="$(dirname $REQUIRED_NODE):$PATH"
ACTUAL_VERSION=$($REQUIRED_NODE -v)
echo "Qoopia starting with Node $ACTUAL_VERSION (required: v24.14.0)"
export QOOPIA_PUBLIC_URL="${QOOPIA_PUBLIC_URL:-https://mcp.qoopia.ai}"
export PORT="${PORT:-3737}"
cd /Users/askhatsoltanov/.openclaw/qoopia
exec $REQUIRED_NODE node_modules/.bin/tsx src/index.ts
