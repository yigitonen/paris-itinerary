# Roamly operations runbook

How to deploy the Supabase backend and web app, check that a deploy is healthy, undo it, and
keep the database tidy. This repository is public: **do not write project refs, hostnames,
keys or tokens in this file**. Commands below use placeholders (`$SUPABASE_URL`,
`$ANON_KEY`, `$USER_JWT`) that you set in your own shell from the Supabase dashboard.

## Components

| Part | Where | Deployed with |
| --- | --- | --- |
| Database schema | `supabase/migrations/*.sql` | `supabase db push` (or the SQL editor, file by file, in filename order) |
| Edge Functions | `supabase/functions/{plan-trip,places,delete-account}` (+ `_shared`) | `supabase functions deploy <name>` |
| Web app / PWA | repository root, `npm run build` | your static host (see `README.md`) |

Migrations that are live are never edited; every change is a new migration with a later
timestamp, written to be idempotent so a half-applied run can be repeated.

## Before you deploy

```bash
npm ci
npm test
npm run test:db                    # throwaway local Postgres, no Docker
TEST_ROLLBACK=1 npm run test:db    # also runs supabase/rollback/*.down.sql, newest first
npm run test:functions             # deno check + Deno tests with a fake fetch
npm run build
```

Then take a backup point (see [Backups and restore](#backups-and-restore)).

## Deploy order

Always **migrations, then functions, then web**.

1. **Migrations** (`supabase db push`). The Edge Functions and the web client call database
   objects (`reserve_provider_usage`, `finish_provider_usage`, `delete_account_data`,
   `join_locals_waitlist`), so those must exist first.
2. **Functions**, only the ones that changed:
   `supabase functions deploy plan-trip`, `places`, `delete-account`.
   Deploy from a clean checkout of the revision you tested.
3. **Web**: build and publish. Clients that still run the old bundle (cached PWA) keep working
   except the locals waitlist form, which posts directly to the table and fails until the app
   reloads, because direct inserts were closed (`20261002120000_waitlist_join_rpc.sql`).

## Verify after deploy

Run these in the SQL editor (or `psql`) as the project owner.

### 1. The server-only functions are not callable by clients

```sql
select p.oid::regprocedure as function,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('reserve_provider_usage', 'finish_provider_usage', 'delete_account_data')
order by 1;
```

Expected: three rows, `anon = false`, `authenticated = false`, `service_role = true`.

Also check that nothing is granted to `PUBLIC` (a role created later would inherit it):

```sql
select p.oid::regprocedure as function
from pg_proc p
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
where p.pronamespace = 'public'::regnamespace and a.privilege_type = 'EXECUTE' and a.grantee = 0;
```

Expected: no rows.

### 2. The usage ledger has no client grants

```sql
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'provider_usage'
  and grantee in ('anon', 'authenticated', 'PUBLIC');
```

Expected: no rows. Row level security must also be on:

```sql
select relrowsecurity from pg_class where oid = 'public.provider_usage'::regclass;  -- true
```

### 3. The only client-callable function is the waitlist RPC

```sql
select p.oid::regprocedure as function, r.rolname
from pg_proc p
join pg_roles r on r.rolname in ('anon', 'authenticated')
where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
  and has_function_privilege(r.rolname, p.oid, 'EXECUTE');
```

Expected: only `join_locals_waitlist(text,text,text)` for `anon` and `authenticated`.
(Extension functions installed in `public` would also show up; ignore those.)

```sql
select has_table_privilege('anon', 'public.locals_waitlist', 'INSERT')          as anon_insert,
       has_table_privilege('authenticated', 'public.locals_waitlist', 'INSERT') as auth_insert;
-- both false
```

### 4. Table rules

```sql
select conname, convalidated from pg_constraint where conname = 'trips_plan_size_check';
-- one row; convalidated = false until you validate it (see "Validating the plan size cap")

select policyname, qual from pg_policies
where tablename = 'connections' and cmd = 'DELETE';
-- "participants remove connections", requester may delete only while status <> 'declined'
```

### 5. Smoke calls

Set `SUPABASE_URL`, `ANON_KEY` (the public anon key) and `USER_JWT` (the access token of a test
account) in your shell. None of the calls below spends paid quota except where noted.

```bash
# places: no token -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$SUPABASE_URL/functions/v1/places" \
  -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' -d '{"action":"autocomplete","query":"louvre"}'

# places: signed in -> 200 with suggestions (uses one Google Places reservation)
curl -s -X POST "$SUPABASE_URL/functions/v1/places" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_JWT" -H 'Content-Type: application/json' \
  -d '{"action":"autocomplete","query":"louvre"}'

# plan-trip: signed in, empty body -> 400 (validated before any quota or Gemini call)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$SUPABASE_URL/functions/v1/plan-trip" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_JWT" -H 'Content-Type: application/json' -d '{}'

# delete-account: signed in, no confirmation -> 400 confirmation_required (deletes nothing)
curl -s -X POST "$SUPABASE_URL/functions/v1/delete-account" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_JWT" -H 'Content-Type: application/json' -d '{}'

# waitlist RPC: the same answer twice, new or existing
for i in 1 2; do
  curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/join_locals_waitlist" \
    -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
    -d '{"p_email":"smoke-test@example.invalid","p_city":"Smoke","p_note":""}'; echo
done   # {"ok": true} both times
```

Remove the smoke entry afterwards:

```sql
delete from public.locals_waitlist where lower(email) = 'smoke-test@example.invalid';
```

Check the reservation settled and recent errors in the function logs:

```sql
select provider, action, status, failure_reason, created_at
from public.provider_usage order by created_at desc limit 10;
```

A `reserved` row older than the stale window (60 s for places, 180 s for plan-trip) is
turned into `failed / expired` by the next reservation; many of them mean a function is
crashing before it settles.

Error codes the `places` function can return to clients: `401` signed out; `429` with
`in_progress`, `cooldown`, `daily_limit`, `attempt_limit`, `global_budget` (the user's or the
global quota); `503` `places_not_configured`, `quota_unavailable`, `provider_rate_limited`,
`provider_unavailable`; `504` `provider_timeout`; `502` `provider_error`.

## Roll back

Roll back **functions and web first, database last**, so nothing calls an object that is
about to disappear. Database changes are only rolled back if they themselves are the problem;
most of them are additive and safe to leave in place.

### Edge Functions

Redeploy the previous git revision of that function from a checkout of it:

```bash
git checkout <previous-revision>      # a known-good commit or tag
supabase functions deploy places      # repeat for plan-trip / delete-account as needed
git checkout -                        # back to where you were
```

Check `supabase functions list` (or the dashboard) shows a new version afterwards, and repeat
the smoke calls.

Pairings to respect: the `plan-trip` and `places` of
`20261001090000_atomic_provider_usage.sql` need that migration; the revisions before it need
the legacy tables `ai_plan_requests` / `place_search_requests`, which the migration leaves in
place. `delete-account` needs `delete_account_data` (`20261002090000_account_deletion.sql`).

### Web

Redeploy the previous build with your host's rollback, or rebuild from the previous revision.
After a web rollback the waitlist form posts directly to the table again, which only works if
the waitlist rollback script below has been run.

### Database

Each not-yet-deployed migration has a rollback in `supabase/rollback/`
(`<migration name>.down.sql`). They are **not** in `supabase/migrations/`, so `supabase db push`
never runs them. Run the ones you need in the SQL editor or with `psql`, **newest first**:

| Order | File | Undoes | Read first |
| --- | --- | --- | --- |
| 1 | `20261002122000_connections_declined_delete.down.sql` | requesters can delete declined connections again | re-opens repeat requests after a decline |
| 2 | `20261002121000_trips_plan_size_cap.down.sql` | drops `trips_plan_size_check` | none |
| 3 | `20261002120000_waitlist_join_rpc.down.sql` | drops `join_locals_waitlist`, restores direct INSERT | re-opens e-mail enumeration; roll the web app back first |
| 4 | `20261002090000_account_deletion.down.sql` | drops `delete_account_data`, waitlist FK back to `ON DELETE SET NULL` | e-mails stay on the waitlist after account deletion; redeploy `delete-account` without the RPC |
| 5 | `20261001090000_atomic_provider_usage.down.sql` | drops the two quota functions and `provider_usage` | **loses the usage ledger**; redeploy the old `plan-trip` and `places` first |

Example:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/rollback/20261002122000_connections_declined_delete.down.sql
```

Every rollback is idempotent and runs in one transaction. After a rollback, a later
`supabase db push` would apply the migration again (the CLI's history still lists it as
applied, so repair it first with `supabase migration repair --status reverted <version>`).
`TEST_ROLLBACK=1 npm run test:db` proves on a scratch database that running all five in order
returns the schema, grants and comments to exactly what was live before them, and that the
migrations can be applied again afterwards.

### Validating the plan size cap

`trips_plan_size_check` was added `NOT VALID` so existing rows could not block the migration.
It is enforced for every insert and update already (an update of a row whose plan is over the
cap is rejected until the plan shrinks). Once this returns no rows:

```sql
select id, owner_id, octet_length(plan::text) as bytes
from public.trips where octet_length(plan::text) > 2000000;
```

validate it (takes only a `SHARE UPDATE EXCLUSIVE` lock; reads and writes continue):

```sql
alter table public.trips validate constraint trips_plan_size_check;
```

## Backups and restore

Backups are a Supabase platform feature and what you get depends on the plan: daily backups,
point-in-time recovery (PITR), and how long they are kept all differ per plan and add-on.
**Check the Database > Backups page of the dashboard** for what is enabled, the retention
window and the restore steps for your project, and write that down for the team outside this
public repository.

Practical rules:

- Before a deploy that includes migrations, make sure a recent backup exists. If your plan
  has no suitable backup, take a dump yourself with `supabase db dump` (needs the database
  connection string; keep the file out of git).
- A restore replaces the database state, including `auth.users`. Anything written since the
  restore point is lost; plan for that (and for account deletions requested since: the
  deletion endpoint's promise to users is that their data is gone, so re-run deletions that
  were requested after the restore point).
- Edge Function code and secrets are not part of a database backup. Functions come from this
  repository (`supabase functions deploy`); secrets (`GEMINI_API_KEY`, `GOOGLE_PLACES_API_KEY`,
  optional `ALLOWED_ORIGINS`, quota overrides) must be kept in your password manager and
  re-set with `supabase secrets set` on a fresh project.
- After any restore, run the verification queries above again: grants and policies come back
  with the data, but confirm.

## Retention: `provider_usage`

`public.provider_usage` gets one row per paid provider call (Gemini plan or Google Places
search) and is never pruned, so it grows without bound. The quota logic only reads the last
24 hours (per user) and the current UTC day (global), so old rows are only useful for
debugging and abuse analysis.

Keep what you need (30 days below; adjust) and delete the rest. Run it manually, or on a
schedule:

```sql
delete from public.provider_usage
where created_at < now() - interval '30 days';
```

For a large table, delete in batches to keep each transaction short; repeat until it reports
`DELETE 0`:

```sql
delete from public.provider_usage
where id in (
  select id from public.provider_usage
  where created_at < now() - interval '30 days'
  limit 10000
);
```

To see how big it is:

```sql
select count(*) as rows, min(created_at) as oldest,
       pg_size_pretty(pg_total_relation_size('public.provider_usage')) as size
from public.provider_usage;
```

### Optional: schedule with pg_cron

Not enabled by any migration, on purpose: extensions are a per-project decision. If you want a
nightly cleanup, enable `pg_cron` in the dashboard (Database > Extensions), then run once:

```sql
select cron.schedule(
  'provider-usage-retention',
  '17 3 * * *',   -- every day at 03:17 UTC
  $$delete from public.provider_usage where created_at < now() - interval '30 days'$$
);
```

Inspect and remove it with:

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'provider-usage-retention';
select * from cron.job_run_details order by start_time desc limit 5;
select cron.unschedule('provider-usage-retention');
```
