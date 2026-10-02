#!/usr/bin/env bash
# Rollback test (optional step of run.sh: TEST_ROLLBACK=1 npm run test:db).
#
# Expects the database in $DATABASE_URL to be fully migrated (run.sh has just done that).
# Then:
#   1. seeds a little data in every table the rollbacks touch,
#   2. runs every supabase/rollback/*.down.sql in reverse filename order,
#   3. runs them all a second time (they must be idempotent),
#   4. compares the resulting schema, including grants and comments, with a reference
#      database that only has the migrations WITHOUT a rollback file (i.e. what is live),
#   5. re-applies the rolled-back migrations (rolling forward again must work).
# Step 4 needs the throwaway-cluster mode of run.sh (it creates the reference database)
# and pg_dump; with a plain DATABASE_URL it is skipped with a notice.
#
# Rollback files are matched to migrations by name: <migration-basename>.down.sql.

set -uo pipefail
HERE="${HERE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
MIGRATIONS="$HERE/../migrations"
ROLLBACKS="$HERE/../rollback"
: "${DATABASE_URL:?DATABASE_URL must be set (run through run.sh)}"

run_psql() { psql -X -q -v ON_ERROR_STOP=1 "$DATABASE_URL" "$@"; }
fail() { echo "  FAIL  $*" >&2; exit 1; }

mapfile -t down_files < <(find "$ROLLBACKS" -maxdepth 1 -name '*.down.sql' | LC_ALL=C sort -r)
[ "${#down_files[@]}" -gt 0 ] || fail "no rollback files in $ROLLBACKS"

for down in "${down_files[@]}"; do
  base="$(basename "$down" .down.sql)"
  [ -f "$MIGRATIONS/$base.sql" ] || fail "$(basename "$down") has no matching migration $base.sql"
done

# 1. Seed (as superuser, bypassing RLS) so the rollbacks run against real rows.
run_psql <<'SQL' || fail "seed"
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'rb-a@example.test'),
  ('aaaaaaaa-0000-4000-8000-0000000000b1', 'rb-b@example.test');
insert into public.profiles (user_id, handle, display_name) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'rb-alice', 'A'),
  ('aaaaaaaa-0000-4000-8000-0000000000b1', 'rb-bobby', 'B');
insert into public.connections (requester_id, addressee_id, status)
  values ('aaaaaaaa-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000b1', 'declined');
insert into public.locals_waitlist (user_id, email, city) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'rb-a@example.test', 'Nice'), (null, 'rb-visitor@example.test', 'Nice');
insert into public.trips (owner_id, title, destination, start_date, end_date)
  values ('aaaaaaaa-0000-4000-8000-0000000000a1', 't', 'Paris', '2026-01-01', '2026-01-02');
insert into public.provider_usage (user_id, provider, status)
  values ('aaaaaaaa-0000-4000-8000-0000000000a1', 'google_places', 'succeeded');
SQL

# 2 + 3. Roll back newest first, twice.
for pass in 1 2; do
  for down in "${down_files[@]}"; do
    out="$(run_psql -f "$down" 2>&1)" || { printf '%s\n' "$out" >&2; fail "rollback pass $pass: $(basename "$down")"; }
    [ "$pass" = 1 ] && printf '  rolled back  %s\n' "$(basename "$down" .down.sql)"
  done
done
echo "  second pass (idempotency): ok"

# 4. Compare with the schema that is live today.
# Statements in dump order, then the GRANT/REVOKE lines sorted (their order depends on the
# order privileges were granted in, which a rollback legitimately changes).
dump_schema() {
  local dump
  dump="$("$PG_DUMP" -s --no-owner "$1" 2>/dev/null | grep -v -E '^(--|SET |SELECT pg_catalog.set_config|\\restrict|\\unrestrict)' | sed '/^$/N;/^\n$/D')"
  printf '%s\n' "$dump" | grep -v -E '^(GRANT|REVOKE) '
  echo '-- privileges (sorted)'
  printf '%s\n' "$dump" | grep -E '^(GRANT|REVOKE) ' | LC_ALL=C sort
}
PG_DUMP="${PG_BIN:+$PG_BIN/}pg_dump"
command -v "$PG_DUMP" >/dev/null 2>&1 || PG_DUMP=""
case "$DATABASE_URL" in
  */roamly_test\?*) REF_URL="${DATABASE_URL/\/roamly_test\?/\/roamly_rollback_ref?}"; ADMIN_URL="${DATABASE_URL/\/roamly_test\?/\/postgres?}" ;;
  *) REF_URL="" ;;
esac
if [ -z "$PG_DUMP" ] || [ -z "$REF_URL" ]; then
  echo "  schema comparison skipped (needs run.sh's throwaway cluster and pg_dump)"
else
  psql -X -q -v ON_ERROR_STOP=1 "$ADMIN_URL" -c 'drop database if exists roamly_rollback_ref' -c 'create database roamly_rollback_ref' || fail "create reference database"
  psql -X -q -v ON_ERROR_STOP=1 "$REF_URL" -f "$HERE/bootstrap.sql" || fail "reference bootstrap"
  while IFS= read -r file; do
    base="$(basename "$file" .sql)"
    [ -f "$ROLLBACKS/$base.down.sql" ] && continue
    psql -X -q -v ON_ERROR_STOP=1 "$REF_URL" -f "$file" || fail "reference migration $base"
  done < <(find "$MIGRATIONS" -maxdepth 1 -name '*.sql' | LC_ALL=C sort)
  dump_schema "$REF_URL" > "$HERE/.ref.schema.tmp"
  dump_schema "$DATABASE_URL" > "$HERE/.rolledback.schema.tmp"
  if diff -u "$HERE/.ref.schema.tmp" "$HERE/.rolledback.schema.tmp" > "$HERE/.schema.diff.tmp"; then
    echo "  schema after rollback matches the live schema (tables, constraints, policies, grants, functions, comments)"
  else
    cat "$HERE/.schema.diff.tmp" >&2
    rm -f "$HERE"/.*.tmp
    fail "schema after rollback differs from the live schema"
  fi
  rm -f "$HERE"/.*.tmp
  psql -X -q "$ADMIN_URL" -c 'drop database if exists roamly_rollback_ref' >/dev/null 2>&1
fi

# 5. Roll forward again.
while IFS= read -r file; do
  base="$(basename "$file" .sql)"
  [ -f "$ROLLBACKS/$base.down.sql" ] || continue
  run_psql -f "$file" || fail "re-applying $base after rollback"
  printf '  re-applied   %s\n' "$base"
done < <(find "$MIGRATIONS" -maxdepth 1 -name '*.sql' | LC_ALL=C sort)

echo "  rollback test ok"
