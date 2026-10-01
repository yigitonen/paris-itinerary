import assert from 'node:assert/strict';
import test from 'node:test';

import { createPostSignInGuard, createUserTracker, PENDING_PLAN_KEY, registerServiceWorker, takePendingPlan } from './lifecycle.js';

function fakeWindow() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, callback, options) { listeners.push({ type, callback, options }); },
    fire(type) { listeners.filter((item) => item.type === type).forEach((item) => item.callback()); }
  };
}

function fakeNav() {
  const calls = [];
  return { calls, serviceWorker: { register(url) { calls.push(url); return Promise.resolve(); } } };
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    removeItem: (key) => { map.delete(key); },
    has: (key) => map.has(key)
  };
}

test('registers the service worker immediately when the page already loaded', () => {
  const nav = fakeNav();
  const win = fakeWindow();
  registerServiceWorker({ nav, doc: { readyState: 'complete' }, win, location: { protocol: 'https:' } });
  assert.deepEqual(nav.calls, ['./sw.js']);
  assert.equal(win.listeners.length, 0);
});

test('waits for load while the page is still loading', () => {
  const nav = fakeNav();
  const win = fakeWindow();
  registerServiceWorker({ nav, doc: { readyState: 'loading' }, win, location: { protocol: 'http:' } });
  assert.equal(nav.calls.length, 0);
  assert.equal(win.listeners[0].type, 'load');
  assert.equal(win.listeners[0].options.once, true);
  win.fire('load');
  assert.equal(nav.calls.length, 1);
});

test('skips registration without service worker support or on a custom scheme', () => {
  const nav = fakeNav();
  registerServiceWorker({ nav, doc: { readyState: 'complete' }, win: fakeWindow(), location: { protocol: 'roamly:' } });
  registerServiceWorker({ nav: {}, doc: { readyState: 'complete' }, win: fakeWindow(), location: { protocol: 'https:' } });
  assert.equal(nav.calls.length, 0);
});

test('swallows registration failures', async () => {
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on('unhandledRejection', onRejection);
  const nav = { serviceWorker: { register: () => Promise.reject(new Error('nope')) } };
  registerServiceWorker({ nav, doc: { readyState: 'complete' }, win: fakeWindow(), location: { protocol: 'https:' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off('unhandledRejection', onRejection);
  assert.equal(rejections.length, 0);
});

test('takePendingPlan returns and clears a stored plan', () => {
  const storage = fakeStorage({ [PENDING_PLAN_KEY]: JSON.stringify({ destination: 'Roma', days: 3 }) });
  assert.deepEqual(takePendingPlan(storage), { destination: 'Roma', days: 3 });
  assert.equal(storage.has(PENDING_PLAN_KEY), false);

  const broken = fakeStorage({ [PENDING_PLAN_KEY]: '{not json' });
  assert.equal(takePendingPlan(broken), null);
  assert.equal(broken.has(PENDING_PLAN_KEY), false);

  assert.equal(takePendingPlan(fakeStorage()), null);

  const shapeless = fakeStorage({ [PENDING_PLAN_KEY]: JSON.stringify({ days: 3 }) });
  assert.equal(takePendingPlan(shapeless), null);
  assert.equal(shapeless.has(PENDING_PLAN_KEY), false);

  const array = fakeStorage({ [PENDING_PLAN_KEY]: '[1]' });
  assert.equal(takePendingPlan(array), null);
  assert.equal(takePendingPlan(null), null);
});

test('post-sign-in work runs once per user even when triggered twice', async () => {
  const guard = createPostSignInGuard();
  let runs = 0;
  const task = async () => { runs += 1; return 'done'; };
  const first = guard.run('a', task);
  const second = guard.run('a', task);
  assert.equal(first, second);
  assert.equal(await first, 'done');
  assert.equal(guard.run('a', task), first);
  assert.equal(runs, 1);
});

test('post-sign-in work runs again for another user', async () => {
  const guard = createPostSignInGuard();
  let runs = 0;
  const task = async () => { runs += 1; };
  await guard.run('a', task);
  await guard.run('b', task);
  assert.equal(runs, 2);
});

test('post-sign-in work runs again after sign-out', async () => {
  const guard = createPostSignInGuard();
  let runs = 0;
  const task = async () => { runs += 1; };
  await guard.run('a', task);
  guard.reset();
  await guard.run('a', task);
  assert.equal(runs, 2);
});

test('a failed post-sign-in run can be retried', async () => {
  const guard = createPostSignInGuard();
  let runs = 0;
  await assert.rejects(guard.run('a', async () => { runs += 1; throw new Error('boom'); }), /boom/);
  await guard.run('a', async () => { runs += 1; });
  assert.equal(runs, 2);
});

test('user tracker ignores token refreshes and detects switches', () => {
  const tracker = createUserTracker();
  const as = (id) => ({ user: { id } });
  assert.deepEqual(tracker.change(null), { changed: true, previousUserId: undefined, userId: null });
  assert.deepEqual(tracker.change(as('A')), { changed: true, previousUserId: null, userId: 'A' });
  assert.deepEqual(tracker.change(as('A')), { changed: false, previousUserId: 'A', userId: 'A' });
  assert.deepEqual(tracker.change(as('B')), { changed: true, previousUserId: 'A', userId: 'B' });
  assert.deepEqual(tracker.change(null), { changed: true, previousUserId: 'B', userId: null });
});
