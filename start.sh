#!/bin/sh
export PATH="/opt/homebrew/opt/node@22/bin:/bin:/usr/bin:/usr/local/bin:/opt/homebrew/bin"
cd /Users/askhatsoltanov/.openclaw/qoopia
exec npx tsx src/index.ts
