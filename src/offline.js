const CACHE_PREFIX = 'roamly-cloud-cache-v1:';
const QUEUE_PREFIX = 'roamly-cloud-queue-v1:';
const FAILED_PREFIX = 'roamly-cloud-failed-v1:';
export const MAX_SYNC_ATTEMPTS = 5;

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
  compacted.push({ ...mutation, id: crypto.randomUUID(), queuedAt: new Date().toISOString() });
  writeSyncQueue(userId, compacted);
  return compacted.length;
}

export const syncEntryKey = (entry) => entry.id || `${entry.type}:${entry.tripId}:${entry.queuedAt}`;

// Removes only these entries from the latest stored queue, keeping anything queued since they were read.
export function removeSyncEntries(userId, entries) {
  const done = new Set(entries.map(syncEntryKey));
  writeSyncQueue(userId, readSyncQueue(userId).filter((entry) => !done.has(syncEntryKey(entry))));
}

export function readFailedSync(userId) {
  const entries = readJson(`${FAILED_PREFIX}${userId}`, []);
  return Array.isArray(entries) ? entries : [];
}

export function writeFailedSync(userId, entries) {
  if (entries.length) localStorage.setItem(`${FAILED_PREFIX}${userId}`, JSON.stringify(entries));
  else localStorage.removeItem(`${FAILED_PREFIX}${userId}`);
}

// Rejected changes leave the queue so they cannot block later ones; only the newest failure per trip is kept.
export function moveSyncEntriesToFailed(userId, entries, { error, status } = {}) {
  removeSyncEntries(userId, entries);
  const failedAt = new Date().toISOString();
  const detail = { message: String(error?.message || error || '').slice(0, 200), code: error?.code || '', status: status ?? null };
  const latest = new Map(entries.map((entry) => [entry.tripId, { ...entry, failedAt, error: detail }]));
  writeFailedSync(userId, [...readFailedSync(userId).filter((entry) => !latest.has(entry.tripId)), ...latest.values()]);
}

export function clearFailedSyncForTrip(userId, tripId) {
  const failed = readFailedSync(userId);
  const remaining = failed.filter((entry) => entry.tripId !== tripId);
  if (remaining.length !== failed.length) writeFailedSync(userId, remaining);
}

export function recordSyncAttempt(userId, entry) {
  const key = syncEntryKey(entry);
  let attempts = (entry.attempts || 0) + 1;
  writeSyncQueue(userId, readSyncQueue(userId).map((queued) => {
    if (syncEntryKey(queued) !== key) return queued;
    attempts = (queued.attempts || 0) + 1;
    return { ...queued, attempts };
  }));
  return attempts;
}

export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function isNetworkError(error) {
  const message = String(error?.message || error || '');
  return isOffline() || /fetch|network|connection|load failed|failed to fetch/i.test(message);
}

// 'reject': the server will never accept this change as sent. 'retry': keep it queued.
export function classifySyncError(error, status) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');
  if (isNetworkError(error)) return 'retry';
  if (status === 401 || status === 408 || status === 429 || status >= 500) return 'retry';
  if (code === 'PGRST301' || code === 'PGRST302' || /jwt|token.*expired|not authenticated/i.test(message)) return 'retry';
  if (status >= 400 && status <= 499) return 'reject';
  if (/^(22|23|42)[0-9A-Z]{3}$/.test(code) || /^PGRST[12]\d\d$/.test(code)) return 'reject';
  return 'retry';
}
