#!/usr/bin/env bash
# Roamly database integration tests.
#
# Applies supabase/tests/bootstrap.sql (a minimal Supabase compatibility layer)
# and every file in supabase/migrations/ in filename order to a PostgreSQL 16
# database, then runs the SQL tests (supabase/tests/test_*.sql) and the
# concurrency test (supabase/tests/test_concurrency.sh). Exits non-zero if
# anything fails.
#
# Usage:
#   supabase/tests/run.sh                    # throwaway local cluster (default)
#   DATABASE_URL=postgresql://postgres@host/scratch supabase/tests/run.sh
#   KEEP_CLUSTER=1 supabase/tests/run.sh     # leave the cluster running; prints how to connect
#   PG_BIN=/usr/lib/postgresql/16/bin supabase/tests/run.sh
#
# Local cluster mode: initdb + pg_ctl under a temp dir, listening on a unix
# socket only (no TCP port is opened, so nothing can collide). When run as root
# (containers) the cluster is owned by and started as the "postgres" OS user,
# because initdb refuses to run as root. Needs: PostgreSQL 16 server binaries
# (auto-detected in $PG_BIN, /usr/lib/postgresql/*/bin or PATH) and psql.
#
# DATABASE_URL mode: the URL must point to an EMPTY, throwaway database and a
# superuser. The bootstrap creates roles (anon, authenticated, service_role,
# authenticator) and the auth schema, so never point it at a real Supabase
# project. The script refuses to run when public.trips already exists.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$HERE/../migrations"
export HERE

log() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 2; }

find_pg_bin() {
  if [ -n "${PG_BIN:-}" ]; then echo "$PG_BIN"; return; fi
  local dir
  for dir in /usr/lib/postgresql/16/bin /usr/lib/postgresql/*/bin; do
    if [ -x "$dir/initdb" ]; then echo "$dir"; return; fi
  done
  if command -v initdb >/dev/null 2>&1; then dirname "$(command -v initdb)"; return; fi
  return 1
}

command -v psql >/dev/null 2>&1 || die "psql not found on PATH"

CLUSTER_DIR=""
PG_RUNAS=()
cleanup() {
  if [ -n "$CLUSTER_DIR" ]; then
    if [ "${KEEP_CLUSTER:-0}" = 1 ]; then
      echo "Cluster left running in $CLUSTER_DIR"
      echo "Connect:  psql '$DATABASE_URL'"
      echo "Stop:     ${PG_RUNAS[*]} $PG_BIN/pg_ctl -D $CLUSTER_DIR/data stop -m immediate"
    else
      "${PG_RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$CLUSTER_DIR/data" stop -m immediate >/dev/null 2>&1
      rm -rf "$CLUSTER_DIR"
    fi
  fi
}
trap cleanup EXIT

if [ -z "${DATABASE_URL:-}" ]; then
  PG_BIN="$(find_pg_bin)" || die "PostgreSQL server binaries not found; set PG_BIN or DATABASE_URL"
  CLUSTER_DIR="$(mktemp -d /tmp/roamly-pg.XXXXXX)"
  if [ "$(id -u)" = 0 ]; then
    id postgres >/dev/null 2>&1 || die "running as root and there is no 'postgres' OS user to run initdb as"
    chown postgres "$CLUSTER_DIR"
    if command -v runuser >/dev/null 2>&1; then PG_RUNAS=(runuser -u postgres --); else PG_RUNAS=(su postgres -s /bin/sh -c); fi
  fi
  log "Starting throwaway PostgreSQL cluster in $CLUSTER_DIR"
  "${PG_RUNAS[@]}" "$PG_BIN/initdb" -D "$CLUSTER_DIR/data" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >"$CLUSTER_DIR/initdb.log" 2>&1 \
    || { cat "$CLUSTER_DIR/initdb.log"; die "initdb failed"; }
  "${PG_RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$CLUSTER_DIR/data" -w -l "$CLUSTER_DIR/postgres.log" \
    -o "-c listen_addresses= -c unix_socket_directories=$CLUSTER_DIR -p 54329 -c fsync=off -c max_connections=100" start >/dev/null \
    || { cat "$CLUSTER_DIR/postgres.log"; die "pg_ctl start failed"; }
  psql -X -q -h "$CLUSTER_DIR" -p 54329 -U postgres -d postgres -c 'create database roamly_test' || die "create database failed"
  export DATABASE_URL="postgresql://postgres@/roamly_test?host=$CLUSTER_DIR&port=54329"
fi

run_psql() { psql -X -q -v ON_ERROR_STOP=1 "$DATABASE_URL" "$@"; }

if [ "$(psql -X -At "$DATABASE_URL" -c "select to_regclass('public.trips') is not null")" = t ]; then
  die "DATABASE_URL points to a database that already has public.trips; use an empty throwaway database"
fi

log "Bootstrap (Supabase compatibility layer)"
run_psql -f "$HERE/bootstrap.sql" || die "bootstrap.sql failed"

log "Migrations"
FAILED=0
# Same ordering the Supabase CLI uses: lexical by filename.
while IFS= read -r file; do
  printf '  %s\n' "$(basename "$file")"
  if ! run_psql -f "$file"; then
    echo "MIGRATION FAILED: $file" >&2
    exit 1
  fi
done < <(find "$MIGRATIONS" -maxdepth 1 -name '*.sql' | LC_ALL=C sort)

# The newest migration must be safe to re-run (e.g. after a half-applied manual
# attempt against the live project).
newest="$(find "$MIGRATIONS" -maxdepth 1 -name '*.sql' | LC_ALL=C sort | tail -n 1)"
printf '  %s (second run, idempotency)\n' "$(basename "$newest")"
run_psql -f "$newest" || { echo "newest migration is not idempotent: $newest" >&2; exit 1; }

log "SQL tests"
for test in "$HERE"/test_*.sql; do
  [ -e "$test" ] || continue
  if out="$(run_psql -f "$test" 2>&1)"; then
    printf '  PASS  %s\n' "$(basename "$test")"
  else
    printf '  FAIL  %s\n%s\n' "$(basename "$test")" "$out" >&2
    FAILED=1
  fi
done

log "Concurrency test"
if bash "$HERE/test_concurrency.sh"; then
  echo "  PASS  test_concurrency.sh"
else
  echo "  FAIL  test_concurrency.sh" >&2
  FAILED=1
fi

echo
if [ "$FAILED" = 0 ]; then echo "All database tests passed."; else echo "Database tests FAILED." >&2; fi
exit "$FAILED"
