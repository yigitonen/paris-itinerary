import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { bearerToken, CONFIRMATION, handleDeleteAccount } from './handler.js';

const USER = { id: '11111111-1111-4111-8111-111111111111' };
const silent = { error() {} };

function harness(overrides = {}) {
  const calls = [];
  const input = {
    authHeader: 'Bearer valid-token',
    readBody: async () => ({ confirm: 'DELETE' }),
    authenticate: async (token) => { calls.push(['authenticate', token]); return { user: USER, error: null }; },
    cleanup: async (id) => { calls.push(['cleanup', id]); return { error: null }; },
    deleteUser: async (id) => { calls.push(['deleteUser', id]); return { error: null }; },
    log: silent,
    ...overrides
  };
  return { calls, run: () => handleDeleteAccount(input) };
}

test('bearerToken extracts the token and rejects other schemes', () => {
  assert.equal(bearerToken('Bearer abc.def'), 'abc.def');
  assert.equal(bearerToken('bearer abc'), 'abc');
  for (const value of [null, undefined, '', 'abc', 'Basic abc', 'Bearer ', 'Bearer a b']) assert.equal(bearerToken(value), '');
});

test('missing or malformed Authorization header -> 401 without touching anything', async () => {
  for (const authHeader of [null, '', 'Token abc', 'Bearer ']) {
    const { calls, run } = harness({ authHeader });
    const { status, body } = await run();
    assert.equal(status, 401);
    assert.equal(body.code, 'unauthorized');
    assert.deepEqual(calls, []);
  }
});

test('invalid or unknown token -> 401 and no deletion', async () => {
  for (const result of [{ user: null, error: { status: 401 } }, { user: null, error: { status: 403 } }, { user: null, error: null }]) {
    const { calls, run } = harness({ authenticate: async () => result });
    const { status, body } = await run();
    assert.equal(status, 401);
    assert.equal(body.code, 'unauthorized');
    assert.deepEqual(calls, []);
  }
});

test('auth outage -> 503, never 401 and never a deletion', async () => {
  for (const authenticate of [
    async () => ({ user: null, error: { status: 500 } }),
    async () => ({ user: null, error: { status: 0 } }),
    async () => ({ user: null, error: new Error('network') }),
    async () => { throw new Error('boom'); }
  ]) {
    const { calls, run } = harness({ authenticate });
    const { status, body } = await run();
    assert.equal(status, 503);
    assert.equal(body.code, 'auth_unavailable');
    assert.deepEqual(calls, []);
  }
});

test('missing or wrong confirmation -> 400 and no deletion', async () => {
  const bodies = [async () => ({}), async () => ({ confirm: 'delete' }), async () => ({ confirm: 'SİL' }), async () => ({ confirm: true }), async () => null, async () => 'DELETE', async () => { throw new SyntaxError('bad json'); }];
  for (const readBody of bodies) {
    const { calls, run } = harness({ readBody });
    const { status, body } = await run();
    assert.equal(status, 400);
    assert.equal(body.code, 'confirmation_required');
    assert.deepEqual(calls.map(([name]) => name), ['authenticate']);
  }
});

test('authentication is checked before the body (unauthenticated callers learn nothing)', async () => {
  const { run } = harness({ authenticate: async () => ({ user: null, error: { status: 401 } }), readBody: async () => ({}) });
  assert.equal((await run()).status, 401);
});

test('happy path runs cleanup, then deleteUser, for the authenticated user only', async () => {
  const { calls, run } = harness();
  const result = await run();
  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.deepEqual(calls, [['authenticate', 'valid-token'], ['cleanup', USER.id], ['deleteUser', USER.id]]);
  assert.equal(CONFIRMATION, 'DELETE');
});

test('cleanup error -> 500 and the auth user is NOT deleted', async () => {
  for (const cleanup of [async () => ({ error: { message: 'db down' } }), async () => { throw new Error('rpc exploded'); }]) {
    const { calls, run } = harness({ cleanup });
    const { status, body } = await run();
    assert.equal(status, 500);
    assert.equal(body.code, 'cleanup_failed');
    assert.ok(!calls.some(([name]) => name === 'deleteUser'));
  }
});

test('deleteUser failure -> 500', async () => {
  for (const deleteUser of [async () => ({ error: { status: 500, message: 'nope' } }), async () => { throw new Error('boom'); }]) {
    const { run } = harness({ deleteUser });
    const { status, body } = await run();
    assert.equal(status, 500);
    assert.equal(body.code, 'delete_failed');
  }
});

test('user already deleted by a concurrent request still counts as success', async () => {
  for (const error of [{ status: 404, message: 'User not found' }, { code: 'user_not_found' }]) {
    const { run } = harness({ deleteUser: async () => ({ error }) });
    assert.deepEqual(await run(), { status: 200, body: { ok: true } });
  }
});

test('a second call after deletion fails cleanly with 401 (the JWT no longer resolves to a user)', async () => {
  let deleted = false;
  const calls = [];
  const input = {
    authHeader: 'Bearer valid-token',
    readBody: async () => ({ confirm: 'DELETE' }),
    authenticate: async () => (deleted ? { user: null, error: { status: 401 } } : { user: USER, error: null }),
    cleanup: async (id) => { calls.push(['cleanup', id]); return { error: null }; },
    deleteUser: async (id) => { calls.push(['deleteUser', id]); deleted = true; return { error: null }; },
    log: silent
  };
  assert.equal((await handleDeleteAccount(input)).status, 200);
  const second = await handleDeleteAccount(input);
  assert.equal(second.status, 401);
  assert.equal(calls.length, 2);
});

test('error responses carry Turkish messages and never leak internals', async () => {
  const { run } = harness({ cleanup: async () => ({ error: { message: 'relation "secret" does not exist' } }) });
  const { body } = await run();
  assert.ok(!JSON.stringify(body).includes('secret'));
  assert.match(body.error, /silinemedi/);
});

// index.ts uses the same CORS builder as plan-trip and places; run the real code.
test('index.ts CORS allows the app origins and no others', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const allowedOrigins'), source.indexOf('function json'));
  const headersFor = runInNewContext(`${stripTypeScriptTypes(code)}; corsHeaders`, { Deno: { env: { get: () => '' } } });
  for (const origin of ['roamly://localhost', 'https://localhost', 'https://roamly-travel.yigitonen.chatgpt.site']) {
    assert.equal(headersFor(new Request('https://api.example.com', { headers: { Origin: origin } }))['Access-Control-Allow-Origin'], origin);
  }
  assert.equal(headersFor(new Request('https://api.example.com', { headers: { Origin: 'https://evil.example' } }))['Access-Control-Allow-Origin'], undefined);
});
