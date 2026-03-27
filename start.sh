#!/bin/sh
export PATH="/opt/homebrew/opt/node@22/bin:/bin:/usr/bin:/usr/local/bin:/opt/homebrew/bin"
export QOOPIA_PUBLIC_URL="${QOOPIA_PUBLIC_URL:-https://mcp.qoopia.ai}"
export PORT="${PORT:-3737}"
cd /Users/askhatsoltanov/.openclaw/qoopia
exec npx tsx src/index.ts
