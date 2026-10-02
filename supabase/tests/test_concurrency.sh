#!/usr/bin/env bash
# Concurrency test for public.reserve_provider_usage: many real database
# sessions race for the same allowance and the number of successful
# reservations must never exceed the limit.
#
# Needs $DATABASE_URL (run.sh exports it) pointing at a database with the
# migrations applied. Each racing session holds its transaction open for a short
# while after reserving (pg_sleep), which is the worst case for count-then-insert
# style checks: every session would pass the limit check if reservations were
# not serialized. Test users and their ledger rows are removed at the end.

set -uo pipefail
: "${DATABASE_URL:?DATABASE_URL must be set (run via supabase/tests/run.sh)}"

LIMIT=10
EXTRA=5
RACERS=$((LIMIT + EXTRA))
WORK="$(mktemp -d)"
trap 'cleanup' EXIT
FAILED=0

sql() { psql -X -q -At -v ON_ERROR_STOP=1 "$DATABASE_URL" "$@"; }

cleanup() {
  sql -c "delete from auth.users where email like 'concurrency-%@example.test'" >/dev/null 2>&1
  rm -rf "$WORK"
}

fail() { echo "  FAIL: $*" >&2; FAILED=1; }

# user ids: concurrency-1 .. concurrency-RACERS
sql -c "delete from auth.users where email like 'concurrency-%@example.test'"
sql -c "insert into auth.users (id, email)
        select ('c0c0c0c0-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'concurrency-' || n || '@example.test'
        from generate_series(1, $RACERS) n"

user_id() { printf 'c0c0c0c0-0000-4000-8000-%012d' "$1"; }

# race <label> <provider> <expected_allowed> <same_user:1|0> <success> <attempt> <cooldown> <inflight> <global> [hold_seconds]
race() {
  local label="$1" provider="$2" expected="$3" same_user="$4" success="$5" attempt="$6" cooldown="$7" inflight="$8" global="$9" hold="${10:-0.15}"
  local dir="$WORK/$label"; mkdir -p "$dir"
  sql -c "delete from public.provider_usage where user_id in (select id from auth.users where email like 'concurrency-%@example.test')"
  local i uid pids=()
  for i in $(seq 1 "$RACERS"); do
    if [ "$same_user" = 1 ]; then uid="$(user_id 1)"; else uid="$(user_id "$i")"; fi
    (
      psql -X -q -At -v ON_ERROR_STOP=1 "$DATABASE_URL" >"$dir/$i.out" 2>"$dir/$i.err" <<SQL
begin;
set local role service_role;
select (public.reserve_provider_usage('$uid', '$provider', 'race', $success, $attempt, $cooldown, $inflight, $global, 180)) ->> 'allowed';
select pg_sleep($hold);
commit;
SQL
    ) &
    pids+=($!)
  done
  wait "${pids[@]}"

  local allowed denied errors
  allowed=$(cat "$dir"/*.out | grep -c '^true$' || true)
  denied=$(cat "$dir"/*.out | grep -c '^false$' || true)
  errors=$(cat "$dir"/*.err | grep -c . || true)
  local rows
  rows=$(sql -c "select count(*) from public.provider_usage where user_id in (select id from auth.users where email like 'concurrency-%@example.test') and provider = '$provider'")
  if [ "$errors" != 0 ]; then fail "$label: sessions reported errors: $(head -c 300 "$dir"/*.err)"; fi
  if [ "$allowed" != "$expected" ]; then
    fail "$label: $allowed of $RACERS racing reservations were allowed, expected exactly $expected"
  elif [ "$rows" != "$expected" ]; then
    fail "$label: $allowed allowed but $rows ledger rows exist (expected $expected)"
  elif [ "$((allowed + denied))" != "$RACERS" ]; then
    fail "$label: only $((allowed + denied)) of $RACERS sessions answered"
  else
    echo "  ok    $label: $allowed allowed, $denied denied"
  fi
}

# Per-user success limit: RACERS sessions of ONE user, LIMIT allowed.
race per-user-success-limit gemini_plan "$LIMIT" 1 "$LIMIT" 1000 0 1000 1000000

# Per-user attempt limit (no success limit in the way).
race per-user-attempt-limit google_places 6 1 1000 6 0 1000 1000000

# In-flight cap of 1: exactly one of the racers gets the slot while the others hold theirs open.
race single-in-flight gemini_plan 1 1 1000 1000 0 1 1000000

# Cooldown: simultaneous requests from one user, only the first may pass.
race cooldown gemini_plan 1 1 1000 1000 60 1000 1000000

# Global budget: RACERS different users, global limit LIMIT (counted on top of whatever
# the ledger already holds for today, so the test also works on a non-empty database).
baseline=$(sql -c "select count(*) from public.provider_usage where provider = 'google_places' and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'")
race global-budget google_places "$LIMIT" 0 1000 1000 0 1000 "$((baseline + LIMIT))"

# The two providers must not block each other's accounting: race both at once for one user.
dir="$WORK/mixed"; mkdir -p "$dir"
sql -c "delete from public.provider_usage where user_id = '$(user_id 1)'"
pids=()
for i in $(seq 1 "$RACERS"); do
  if [ $((i % 2)) = 0 ]; then provider=gemini_plan; else provider=google_places; fi
  (
    psql -X -q -At -v ON_ERROR_STOP=1 "$DATABASE_URL" >"$dir/$i.out" 2>"$dir/$i.err" <<SQL
begin;
set local role service_role;
select '$provider' || ':' || ((public.reserve_provider_usage('$(user_id 1)', '$provider', 'race', 3, 1000, 0, 1000, 1000000, 180)) ->> 'allowed');
select pg_sleep(0.1);
commit;
SQL
  ) &
  pids+=($!)
done
wait "${pids[@]}"
g=$(cat "$dir"/*.out | grep -c '^gemini_plan:true$' || true)
p=$(cat "$dir"/*.out | grep -c '^google_places:true$' || true)
if [ "$g" = 3 ] && [ "$p" = 3 ]; then echo "  ok    per-provider limits under mixed load: gemini $g, places $p"; else fail "mixed load: gemini $g, places $p (expected 3 and 3)"; fi

exit "$FAILED"
