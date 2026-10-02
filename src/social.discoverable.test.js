import assert from 'node:assert/strict';
import test from 'node:test';

import { createSocialApi } from './social.js';

const USER_A = '20d6c915-84a0-4e6c-bc89-f637ef765fba';
const USER_B = '11111111-1111-4111-8111-111111111111';

// A tiny in-memory stand-in for the `profiles` table that applies the same filters a PostgREST request would.
function fakeSupabase({ rows = [], failWith = null, insertError = null } = {}) {
  const profiles = rows.map((row) => ({ ...row }));
  const calls = [];
  return {
    profiles,
    calls,
    from(table) {
      assert.equal(table, 'profiles');
      const call = { steps: [] };
      calls.push(call);
      const filters = [];
      let mode = 'select';
      let payload = null;
      const run = (single) => {
        if (failWith) return { data: null, error: failWith };
        const matching = profiles.filter((row) => filters.every(([column, value]) => row[column] === value));
        if (mode === 'insert') {
          if (insertError) return { data: null, error: insertError };
          profiles.push({ ...payload });
          return { data: { ...payload }, error: null };
        }
        if (mode === 'update') matching.forEach((row) => Object.assign(row, payload));
        const row = matching[0];
        return { data: row ? { ...row } : null, error: null };
      };
      const builder = {
        select(...args) { call.steps.push(['select', ...args]); return builder; },
        update(value) { mode = 'update'; payload = value; call.steps.push(['update', value]); return builder; },
        insert(value) { mode = 'insert'; payload = value; call.steps.push(['insert', value]); return builder; },
        eq(column, value) { filters.push([column, value]); call.steps.push(['eq', column, value]); return builder; },
        maybeSingle() { return Promise.resolve(run(true)); },
        single() { return Promise.resolve(run(true)); }
      };
      return builder;
    }
  };
}

const session = (id = USER_A) => ({ user: { id, email: 'yigit.onen@example.com', user_metadata: {} } });

test('loadDiscoverable reads the signed-in user\'s own row', async () => {
  const client = fakeSupabase({ rows: [{ user_id: USER_A, discoverable: false }, { user_id: USER_B, discoverable: true }] });
  const api = createSocialApi(client);
  assert.equal(await api.loadDiscoverable(session()), false);
  assert.deepEqual(client.calls[0].steps.filter(([name]) => name === 'eq'), [['eq', 'user_id', USER_A]]);
});

test('loadDiscoverable defaults to true until a profile exists', async () => {
  const api = createSocialApi(fakeSupabase());
  assert.equal(await api.loadDiscoverable(session()), true);
});

test('setDiscoverable updates only the caller\'s row and returns the stored value', async () => {
  const client = fakeSupabase({ rows: [{ user_id: USER_A, discoverable: true }, { user_id: USER_B, discoverable: true }] });
  const api = createSocialApi(client);

  assert.equal(await api.setDiscoverable(false, session()), false);
  assert.deepEqual(client.profiles.map((row) => row.discoverable), [false, true]);
  const steps = client.calls[0].steps;
  assert.deepEqual(steps.find(([name]) => name === 'update'), ['update', { discoverable: false }]);
  assert.deepEqual(steps.filter(([name]) => name === 'eq'), [['eq', 'user_id', USER_A]]);

  assert.equal(await api.setDiscoverable(true, session()), true);
  assert.equal(client.profiles[0].discoverable, true);
});

test('setDiscoverable creates the missing profile with the chosen visibility', async () => {
  const client = fakeSupabase();
  const api = createSocialApi(client);

  assert.equal(await api.setDiscoverable(false, session()), false);
  assert.equal(client.profiles.length, 1);
  assert.equal(client.profiles[0].user_id, USER_A);
  assert.equal(client.profiles[0].discoverable, false);
  assert.equal(client.profiles[0].display_name, 'yigit.onen');
});

test('setDiscoverable retries the update when the profile appears between the update and the insert', async () => {
  const client = fakeSupabase({ insertError: { code: '23505', message: 'duplicate key' } });
  const api = createSocialApi(client);
  const original = client.from.bind(client);
  let calls = 0;
  client.from = (table) => {
    calls += 1;
    if (calls === 3) client.profiles.push({ user_id: USER_A, discoverable: true });
    return original(table);
  };
  assert.equal(await api.setDiscoverable(false, session()), false);
  assert.equal(client.profiles[0].discoverable, false);
});

test('setDiscoverable rejects non-boolean values and guests without touching the database', async () => {
  const client = fakeSupabase();
  const api = createSocialApi(client);
  await assert.rejects(api.setDiscoverable('false', session()), /true or false/);
  await assert.rejects(api.setDiscoverable(false, null), (error) => error.code === 'AUTH_REQUIRED');
  await assert.rejects(api.loadDiscoverable(null), (error) => error.code === 'AUTH_REQUIRED');
  assert.equal(client.calls.length, 0);
});

test('setDiscoverable surfaces permission and network errors', async () => {
  const denied = createSocialApi(fakeSupabase({ failWith: { code: '42501', message: 'denied' } }));
  await assert.rejects(denied.setDiscoverable(false, session()), (error) => error.code === 'AUTH_REQUIRED');
  const broken = createSocialApi(fakeSupabase({ failWith: { message: 'Failed to fetch' } }));
  await assert.rejects(broken.setDiscoverable(false, session()), /Failed to fetch/);
  await assert.rejects(broken.loadDiscoverable(session()), /Failed to fetch/);
});
