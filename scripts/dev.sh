#!/usr/bin/env bash
# Starts OpsPilot locally: the database (if needed) and the web app. Ctrl+C stops the app.
# The database keeps running in the background; stop it with ./scripts/db.sh stop
# First time: create a company and its admin with  cd apps/automation-console && npm run setup
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

"$ROOT/scripts/db.sh" status >/dev/null 2>&1 || "$ROOT/scripts/db.sh" start

echo ""
echo "  Application    http://localhost:4000"
echo ""
cd "$ROOT/apps/automation-console" && exec node server.mjs
