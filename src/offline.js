const CACHE_PREFIX = 'roamly-cloud-cache-v1:';
const QUEUE_PREFIX = 'roamly-cloud-queue-v1:';

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export function readCloudCache(userId) {
  const trips = readJson(`${CACHE_PREFIX}${userId}`, []);
  return Array.isArray(trips) ? trips : [];
}

export function writeCloudCache(userId, trips) {
  localStorage.setItem(`${CACHE_PREFIX}${userId}`, JSON.stringify(trips));
}

export function readSyncQueue(userId) {
  const entries = readJson(`${QUEUE_PREFIX}${userId}`, []);
  return Array.isArray(entries) ? entries : [];
}

export function writeSyncQueue(userId, entries) {
  if (entries.length) localStorage.setItem(`${QUEUE_PREFIX}${userId}`, JSON.stringify(entries));
  else localStorage.removeItem(`${QUEUE_PREFIX}${userId}`);
}

export function enqueueSync(userId, mutation) {
  const queue = readSyncQueue(userId);
  const key = `${mutation.type}:${mutation.tripId}`;
  const compacted = queue.filter((entry) => `${entry.type}:${entry.tripId}` !== key && entry.tripId !== mutation.tripId);
  compacted.push({ ...mutation, queuedAt: new Date().toISOString() });
  writeSyncQueue(userId, compacted);
  return compacted.length;
}

export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function isNetworkError(error) {
  const message = String(error?.message || error || '');
  return isOffline() || /fetch|network|connection|load failed|failed to fetch/i.test(message);
}
