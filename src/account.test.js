import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AccountDeletionError,
  accountDeletionError,
  canSubmitAccountDeletion,
  clearLocalAccountData,
  DELETE_ACCOUNT_CONFIRMATION,
  DELETE_ACCOUNT_FUNCTION,
  deleteAccount,
  isDeleteConfirmation,
  USER_STORAGE_PREFIXES
} from './account.js';
import { GUEST_STORAGE_KEY } from './config.js';
import { PENDING_PLAN_KEY } from './lifecycle.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key)
  };
}

function fakeSupabase({ session = { user: { id: USER_ID } }, invoke, signOut } = {}) {
  const calls = [];
  return {
    calls,
    auth: {
      getSession: async () => ({ data: { session } }),
      signOut: signOut || (async (options) => { calls.push(['signOut', options]); return { error: null }; })
    },
    functions: {
      invoke: invoke || (async (name, options) => { calls.push(['invoke', name, options]); return { data: { ok: true }, error: null }; })
    }
  };
}

const httpError = (status, payload) => ({
  name: 'FunctionsHttpError',
  message: 'Edge Function returned a non-2xx status code',
  context: new Response(payload === undefined ? 'not json' : JSON.stringify(payload), { status })
});

test('offline.js keeps the per-user storage prefixes this module clears', () => {
  const source = readFileSync(new URL('./offline.js', import.meta.url), 'utf8');
  for (const prefix of USER_STORAGE_PREFIXES) assert.ok(source.includes(`'${prefix}'`), `${prefix} is no longer used by offline.js`);
  assert.equal(USER_STORAGE_PREFIXES.length, (source.match(/_PREFIX = '/g) || []).length);
});

test('deleteAccount calls the function with the confirmation, signs out locally and clears device data', async () => {
  const supabase = fakeSupabase();
  const storage = fakeStorage({
    [`roamly-cloud-cache-v1:${USER_ID}`]: '[]',
    [`roamly-cloud-queue-v1:${USER_ID}`]: '[]',
    [`roamly-cloud-failed-v1:${USER_ID}`]: '[]',
    'roamly-cloud-cache-v1:someone-else': '[1]',
    [GUEST_STORAGE_KEY]: '[]'
  });
  const session = fakeStorage({ [PENDING_PLAN_KEY]: '{}' });
  assert.deepEqual(await deleteAccount(supabase, { storage, session }), { ok: true });
  assert.deepEqual(supabase.calls, [
    ['invoke', DELETE_ACCOUNT_FUNCTION, { body: { confirm: 'DELETE' } }],
    ['signOut', { scope: 'local' }]
  ]);
  assert.equal(DELETE_ACCOUNT_CONFIRMATION, 'DELETE');
  assert.deepEqual([...storage.data.keys()].sort(), [GUEST_STORAGE_KEY, 'roamly-cloud-cache-v1:someone-else'].sort());
  assert.equal(session.data.size, 0);
});

test('deleteAccount refuses without a session and never calls the server', async () => {
  const supabase = fakeSupabase({ session: null });
  await assert.rejects(deleteAccount(supabase), (error) => error instanceof AccountDeletionError && error.code === 'signed_out' && /giriş/.test(error.message));
  assert.deepEqual(supabase.calls, []);
});

test('server error codes map to Turkish messages and keep the device signed in', async () => {
  const cases = [
    [httpError(401, { error: 'x', code: 'unauthorized' }), 'unauthorized'],
    [httpError(400, { code: 'confirmation_required' }), 'confirmation_required'],
    [httpError(500, { code: 'cleanup_failed' }), 'cleanup_failed'],
    [httpError(500, { code: 'delete_failed' }), 'delete_failed'],
    [httpError(503, { code: 'auth_unavailable' }), 'auth_unavailable'],
    [httpError(503, { code: 'not_configured' }), 'not_configured'],
    [httpError(401), 'unauthorized'],
    [httpError(503), 'auth_unavailable'],
    [httpError(500, { code: 'something_new' }), 'unknown'],
    [{ name: 'FunctionsFetchError', message: 'Failed to send a request' }, 'offline'],
    [{ name: 'FunctionsRelayError', message: 'relay' }, 'offline'],
    [new Error('???'), 'unknown']
  ];
  for (const [error, code] of cases) {
    const supabase = fakeSupabase({ invoke: async () => ({ data: null, error }) });
    const storage = fakeStorage({ [`roamly-cloud-cache-v1:${USER_ID}`]: '[]' });
    await assert.rejects(deleteAccount(supabase, { storage, session: fakeStorage() }), (thrown) => {
      assert.ok(thrown instanceof AccountDeletionError);
      assert.equal(thrown.code, code);
      assert.match(thrown.message, /[ğüşıöçĞÜŞİÖÇ]|Hesab|Oturum|İnternet/);
      return true;
    });
    assert.ok(!supabase.calls.some(([name]) => name === 'signOut'), `${code}: must not sign out`);
    assert.equal(storage.data.size, 1, `${code}: must not clear local data`);
  }
});

test('a thrown invoke (offline) is mapped, not leaked', async () => {
  const supabase = fakeSupabase({ invoke: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(deleteAccount(supabase), (error) => error.code === 'offline');
});

test('an unexpected 2xx body is not treated as success', async () => {
  const supabase = fakeSupabase({ invoke: async () => ({ data: { ok: false }, error: null }) });
  await assert.rejects(deleteAccount(supabase, { storage: fakeStorage(), session: fakeStorage() }), (error) => error.code === 'unknown');
  assert.ok(!supabase.calls.some(([name]) => name === 'signOut'));
});

test('a failing local sign-out does not turn a completed deletion into an error', async () => {
  const supabase = fakeSupabase({ signOut: async () => { throw new Error('storage blocked'); } });
  const storage = fakeStorage({ [`roamly-cloud-cache-v1:${USER_ID}`]: '[]' });
  assert.deepEqual(await deleteAccount(supabase, { storage, session: fakeStorage() }), { ok: true });
  assert.equal(storage.data.size, 0);
});

test('accountDeletionError passes AccountDeletionError through', async () => {
  const original = new AccountDeletionError('delete_failed');
  assert.equal(await accountDeletionError(original), original);
});

test('clearLocalAccountData removes only this user plus the pending plan, guest data on request', () => {
  const make = () => fakeStorage({
    [`roamly-cloud-cache-v1:${USER_ID}`]: '1',
    [`roamly-cloud-queue-v1:${USER_ID}`]: '1',
    [`roamly-cloud-failed-v1:${USER_ID}`]: '1',
    'roamly-cloud-cache-v1:other': '1',
    [GUEST_STORAGE_KEY]: '1',
    unrelated: '1'
  });
  const storage = make();
  const session = fakeStorage({ [PENDING_PLAN_KEY]: '1', other: '1' });
  clearLocalAccountData(USER_ID, { storage, session });
  assert.deepEqual([...storage.data.keys()].sort(), ['roamly-cloud-cache-v1:other', GUEST_STORAGE_KEY, 'unrelated'].sort());
  assert.deepEqual([...session.data.keys()], ['other']);

  const withGuest = make();
  clearLocalAccountData(USER_ID, { storage: withGuest, session: fakeStorage(), includeGuest: true });
  assert.ok(!withGuest.data.has(GUEST_STORAGE_KEY));
  assert.ok(withGuest.data.has('unrelated'));
});

test('clearLocalAccountData never throws, even with blocked or missing storage', () => {
  const blocked = { removeItem() { throw new Error('SecurityError'); } };
  assert.doesNotThrow(() => clearLocalAccountData(USER_ID, { storage: blocked, session: blocked }));
  assert.doesNotThrow(() => clearLocalAccountData(USER_ID, { storage: null, session: null }));
  assert.doesNotThrow(() => clearLocalAccountData(undefined, { storage: fakeStorage(), session: fakeStorage() }));
});

test('isDeleteConfirmation accepts SİL and DELETE in any case and nothing else', () => {
  for (const value of ['SİL', 'sil', 'Sil', 'SIL', ' sil ', 'DELETE', 'delete', 'Delete']) assert.equal(isDeleteConfirmation(value), true, value);
  for (const value of ['', 'sı', 'si', 'sill', 'deletee', 'evet', null, undefined, 0]) assert.equal(isDeleteConfirmation(value), false, String(value));
});

test('the confirm button needs the typed word and no request in flight', () => {
  assert.equal(canSubmitAccountDeletion({ text: 'SİL' }), true);
  assert.equal(canSubmitAccountDeletion({ text: ' sil ', busy: false }), true);
  assert.equal(canSubmitAccountDeletion({ text: '' }), false);
  assert.equal(canSubmitAccountDeletion({ text: 'sill' }), false);
  assert.equal(canSubmitAccountDeletion({ text: 'SİL', busy: true }), false);
  assert.equal(canSubmitAccountDeletion(), false);
});
