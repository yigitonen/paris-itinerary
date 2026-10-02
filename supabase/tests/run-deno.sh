#!/usr/bin/env bash
# Type-checks the Supabase Edge Functions and runs their Deno tests.
#
# Usage:
#   supabase/tests/run-deno.sh              # or: npm run test:functions
#   DENO=/path/to/deno supabase/tests/run-deno.sh
#
# Finds Deno via $DENO, then `deno` on PATH, then falls back to `npx --yes deno`
# (the npm package ships the real binary). Needs network access to jsr.io and
# registry.npmjs.org the first time, to fetch @supabase/supabase-js and
# @std/assert; later runs use Deno's cache. The tests themselves make no network
# calls: fetch is replaced with a fake Supabase + Gemini/Google backend.
#
# --node-modules-dir=none is required because the repo root has a package.json,
# which otherwise puts Deno in "manual node_modules" mode and breaks the npm:
# imports the functions use. (The Supabase runtime does not read that file.)
#
# This is deliberately NOT part of `npm test`, so CI without Deno keeps working.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

if [ -n "${DENO:-}" ]; then
  deno_cmd=("$DENO")
elif command -v deno >/dev/null 2>&1; then
  deno_cmd=(deno)
elif command -v npx >/dev/null 2>&1; then
  deno_cmd=(npx --yes deno)
else
  echo "error: Deno not found. Install it (https://deno.com) or set DENO=/path/to/deno." >&2
  exit 2
fi

flags=(--node-modules-dir=none --no-lock)

echo "== deno check (Edge Functions)"
"${deno_cmd[@]}" check "${flags[@]}" \
  supabase/functions/plan-trip/index.ts \
  supabase/functions/places/index.ts \
  supabase/functions/_shared/quota.js \
  supabase/functions/plan-trip/gemini.js \
  supabase/functions/plan-trip/plan-validation.js \
  supabase/functions/plan-trip/route.js

echo "== deno test"
"${deno_cmd[@]}" test "${flags[@]}" --allow-read --allow-env supabase/tests/functions/
