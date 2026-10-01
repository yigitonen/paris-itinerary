export const PENDING_PLAN_KEY = 'roamly-pending-plan';

export function whenDocumentLoaded(doc, win, callback) {
  if (doc.readyState === 'complete') callback();
  else win.addEventListener('load', callback, { once: true });
}

export function registerServiceWorker({ nav, doc, win, location, url = './sw.js' }) {
  if (!nav || !('serviceWorker' in nav) || !['http:', 'https:'].includes(location?.protocol)) return;
  whenDocumentLoaded(doc, win, () => {
    try { Promise.resolve(nav.serviceWorker.register(url)).catch(() => {}); } catch { /* registration is optional */ }
  });
}

export function takePendingPlan(storage) {
  let raw = null;
  try {
    raw = storage?.getItem(PENDING_PLAN_KEY) ?? null;
    storage?.removeItem(PENDING_PLAN_KEY);
  } catch { return null; }
  if (!raw) return null;
  try {
    const plan = JSON.parse(raw);
    return plan && typeof plan === 'object' && !Array.isArray(plan) && typeof plan.destination === 'string' ? plan : null;
  } catch { return null; }
}

export function createUserTracker() {
  let current;
  return {
    change(session) {
      const userId = session?.user?.id ?? null;
      const previousUserId = current;
      current = userId;
      return { changed: userId !== previousUserId, previousUserId, userId };
    }
  };
}

export function createPostSignInGuard() {
  let entry = null;
  return {
    run(userId, task) {
      if (entry && entry.userId === userId) return entry.promise;
      const next = { userId, promise: null };
      next.promise = Promise.resolve().then(task);
      entry = next;
      next.promise.catch(() => { if (entry === next) entry = null; });
      return next.promise;
    },
    reset() { entry = null; }
  };
}
