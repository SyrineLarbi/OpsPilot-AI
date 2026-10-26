#!/usr/bin/env bash
# Project-local PostgreSQL server (no sudo needed). Data lives in .pgdata/.
# Usage: ./scripts/db.sh start | stop | status | psql [db]
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$ROOT/.env"; set +a
PGBIN=/usr/lib/postgresql/16/bin
DATA="$ROOT/.pgdata"

init() {
  echo "Creating local PostgreSQL cluster in .pgdata ..."
  PWFILE=$(mktemp); echo "$DB_PASSWORD" > "$PWFILE"
  "$PGBIN/initdb" -D "$DATA" -U "$DB_USER" --pwfile="$PWFILE" -A scram-sha-256 -E UTF8 --locale=C.UTF-8 >/dev/null
  rm -f "$PWFILE"
  cat >> "$DATA/postgresql.conf" <<EOF
port = $DB_PORT
listen_addresses = 'localhost'
unix_socket_directories = '$DATA'
EOF
  "$PGBIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w start >/dev/null
  export PGPASSWORD="$DB_PASSWORD"
  "$PGBIN/createdb" -h localhost -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"
  echo "Database $DB_NAME created."
}

case "${1:-status}" in
  start)
    if [ ! -d "$DATA" ]; then init; else "$PGBIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w start; fi ;;
  stop)   "$PGBIN/pg_ctl" -D "$DATA" -w stop ;;
  status) "$PGBIN/pg_ctl" -D "$DATA" status ;;
  psql)   PGPASSWORD="$DB_PASSWORD" psql -h localhost -p "$DB_PORT" -U "$DB_USER" "${2:-$DB_NAME}" ;;
  *) echo "usage: $0 start|stop|status|psql [db]"; exit 1 ;;
esac
