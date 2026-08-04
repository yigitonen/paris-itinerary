import assert from 'node:assert/strict';
import test from 'node:test';

import { createSocialApi } from './social.js';

const USER_A = '20d6c915-84a0-4e6c-bc89-f637ef765fba';
const USER_B = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';

function mockClient(responses) {
  const queue = [...responses];
  const calls = [];

  return {
    calls,
    from(table) {
      const call = { table, steps: [] };
      const response = queue.shift();
      calls.push(call);

      const builder = {
        select(...args) { call.steps.push(['select', ...args]); return builder; },
        insert(...args) { call.steps.push(['insert', ...args]); return builder; },
        update(...args) { call.steps.push(['update', ...args]); return builder; },
        delete(...args) { call.steps.push(['delete', ...args]); return builder; },
        eq(...args) { call.steps.push(['eq', ...args]); return builder; },
        neq(...args) { call.steps.push(['neq', ...args]); return builder; },
        or(...args) { call.steps.push(['or', ...args]); return builder; },
        order(...args) { call.steps.push(['order', ...args]); return builder; },
        limit(...args) { call.steps.push(['limit', ...args]); return builder; },
        maybeSingle() { call.steps.push(['maybeSingle']); return Promise.resolve(response); },
        single() { call.steps.push(['single']); return Promise.resolve(response); },
        then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); }
      };

      return builder;
    }
  };
}

function session(id = USER_A, overrides = {}) {
  return {
    user: {
      id,
      email: 'yigit.onen@example.com',
      user_metadata: {},
      ...overrides
    }
  };
}

test('Friends operations require an authenticated session', async () => {
  const client = mockClient([]);
  const api = createSocialApi(client);

  await assert.rejects(
    api.searchProfiles('yi', null),
    (error) => error.code === 'AUTH_REQUIRED' && error.message === 'Sign in to use Friends.'
  );
  assert.equal(client.calls.length, 0);
});

test('ensureProfile returns an existing profile without rewriting it', async () => {
  const existing = { user_id: USER_A, handle: 'yigit', display_name: 'Yigit' };
  const client = mockClient([{ data: existing, error: null }]);
  const api = createSocialApi(client);

  assert.equal(await api.ensureProfile(session()), existing);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].steps[1], ['eq', 'user_id', USER_A]);
});

test('ensureProfile creates a safe deterministic profile from auth metadata', async () => {
  const created = { user_id: USER_A, handle: 'yigit-onen-765fba', display_name: 'Yiğit Önen' };
  const client = mockClient([
    { data: null, error: null },
    { data: created, error: null }
  ]);
  const api = createSocialApi(client);

  const result = await api.ensureProfile(session(USER_A, {
    email: 'fallback@example.com',
    user_metadata: {
      full_name: 'Yiğit Önen',
      preferred_username: 'Yiğit Önen',
      avatar_url: 'http://insecure.example/avatar.png'
    }
  }));

  assert.equal(result, created);
  const insertStep = client.calls[1].steps.find(([name]) => name === 'insert');
  assert.deepEqual(insertStep[1], {
    user_id: USER_A,
    handle: 'yigit-onen-765fba',
    display_name: 'Yiğit Önen',
    avatar_url: null,
    discoverable: true
  });
});

test('searchProfiles sanitizes PostgREST filter syntax and limits discovery', async () => {
  const profiles = [{ user_id: USER_B, handle: 'yigit-travels' }];
  const client = mockClient([{ data: profiles, error: null }]);
  const api = createSocialApi(client);

  assert.deepEqual(await api.searchProfiles('yi),status.eq.accepted', session()), profiles);
  const steps = client.calls[0].steps;
  assert.deepEqual(steps.find(([name]) => name === 'eq'), ['eq', 'discoverable', true]);
  assert.deepEqual(steps.find(([name]) => name === 'neq'), ['neq', 'user_id', USER_A]);
  assert.deepEqual(steps.find(([name]) => name === 'limit'), ['limit', 20]);
  const filter = steps.find(([name]) => name === 'or')[1];
  assert.equal(filter, 'handle.ilike.%yistatuseqaccepted%,display_name.ilike.%yistatuseqaccepted%');
});

test('loadConnections only asks for connections involving the signed-in user', async () => {
  const connections = [{ id: CONNECTION_ID, requester_id: USER_A, addressee_id: USER_B }];
  const client = mockClient([{ data: connections, error: null }]);
  const api = createSocialApi(client);

  assert.deepEqual(await api.loadConnections(session()), connections);
  assert.deepEqual(
    client.calls[0].steps.find(([name]) => name === 'or'),
    ['or', `requester_id.eq.${USER_A},addressee_id.eq.${USER_A}`]
  );
});

test('requestConnection creates only a pending request and explains duplicates', async () => {
  const connection = { id: CONNECTION_ID, requester_id: USER_A, addressee_id: USER_B, status: 'pending' };
  const client = mockClient([
    { data: connection, error: null },
    { data: null, error: { code: '23505', message: 'duplicate key' } }
  ]);
  const api = createSocialApi(client);

  assert.equal(await api.requestConnection(USER_B, session()), connection);
  assert.deepEqual(
    client.calls[0].steps.find(([name]) => name === 'insert')[1],
    { requester_id: USER_A, addressee_id: USER_B, status: 'pending' }
  );
  await assert.rejects(
    api.requestConnection(USER_B, session()),
    /A connection request already exists\./
  );
  await assert.rejects(
    api.requestConnection(USER_A, session()),
    /You cannot connect with yourself\./
  );
});

test('respondToConnection is scoped to an addressee pending request', async () => {
  const accepted = { id: CONNECTION_ID, status: 'accepted' };
  const client = mockClient([{ data: accepted, error: null }]);
  const api = createSocialApi(client);

  assert.equal(await api.respondToConnection(CONNECTION_ID, 'accepted', session()), accepted);
  assert.deepEqual(
    client.calls[0].steps.filter(([name]) => name === 'eq'),
    [
      ['eq', 'id', CONNECTION_ID],
      ['eq', 'addressee_id', USER_A],
      ['eq', 'status', 'pending']
    ]
  );
  await assert.rejects(
    api.respondToConnection(CONNECTION_ID, 'pending', session()),
    /Response must be accepted or declined\./
  );
});

test('removeConnection deletes by immutable connection ID', async () => {
  const client = mockClient([{ data: { id: CONNECTION_ID }, error: null }]);
  const api = createSocialApi(client);

  assert.equal(await api.removeConnection(CONNECTION_ID, session()), CONNECTION_ID);
  assert.deepEqual(client.calls[0].steps, [
    ['delete'],
    ['eq', 'id', CONNECTION_ID],
    ['select', 'id'],
    ['maybeSingle']
  ]);
});
