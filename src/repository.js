import { Capacitor } from '@capacitor/core';
import { createClient } from '@supabase/supabase-js';
import { GUEST_STORAGE_KEY, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config.js';
import { createDemoTrip } from './data.js';
import { classifySyncError, clearFailedSyncForTrip, enqueueSync, isNetworkError, isOffline, MAX_SYNC_ATTEMPTS, moveSyncEntriesToFailed, readCloudCache, readFailedSync, readSyncQueue, recordSyncAttempt, removeSyncEntries, syncEntryKey, writeCloudCache } from './offline.js';

const NATIVE_AUTH_REDIRECT = 'roamly://localhost/';
const NATIVE_AUTH_PROTOCOLS = new Set(['roamly:', 'capacitor:', 'ionic:']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function currentUrl(value) {
  const candidate = value || globalThis.location?.href;
  if (!candidate) throw new Error('An auth callback URL is required');
  return new URL(candidate);
}

function isNativeAuthRuntime(value) {
  return Capacitor.isNativePlatform() || NATIVE_AUTH_PROTOCOLS.has(currentUrl(value).protocol);
}

export function getAuthRedirectUrl(value) {
  const url = currentUrl(value);
  return isNativeAuthRuntime(url.href) ? NATIVE_AUTH_REDIRECT : `${url.origin}${url.pathname}`;
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce'
  }
});

export function startGoogleOAuth(value) {
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: getAuthRedirectUrl(value),
      skipBrowserRedirect: isNativeAuthRuntime(value)
    }
  });
}

export function sendEmailSignInLink(email, value) {
  return supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: getAuthRedirectUrl(value) }
  });
}

export async function completePkceCallback(callbackUrl) {
  const url = currentUrl(callbackUrl);
  const providerError = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (providerError) throw new Error(providerError);

  const code = url.searchParams.get('code');
  if (!code) throw new Error('Auth callback code is missing');
  const result = await supabase.auth.exchangeCodeForSession(code);

  if (globalThis.location?.href === url.href && globalThis.history?.replaceState) {
    url.searchParams.delete('code');
    url.searchParams.delete('sb_flow_id');
    globalThis.history.replaceState(globalThis.history.state, '', url.toString());
  }
  return result;
}

const readGuestTrips = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(GUEST_STORAGE_KEY) || 'null');
    // A stored list is the user's data, including an edited example or an empty list.
    if (Array.isArray(parsed)) return parsed;
  } catch (error) {
    console.warn('Guest trips could not be read', error);
  }
  const demo = [createDemoTrip()];
  localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(demo));
  return demo;
};

const writeGuestTrips = (trips) => localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(trips));

const replaceTrip = (trips, trip) => trips.some((item) => item.id === trip.id)
  ? trips.map((item) => item.id === trip.id ? trip : item)
  : [trip, ...trips];

const toRow = (trip, userId) => ({
  id: trip.id.startsWith('demo-') ? crypto.randomUUID() : trip.id,
  owner_id: userId,
  title: trip.title || trip.destination,
  destination: trip.destination,
  country: trip.country || '',
  start_date: trip.startDate,
  end_date: trip.endDate,
  status: trip.status || 'planning',
  style: trip.style || 'Dengeli',
  pace: trip.pace || 'Rahat',
  cover_key: trip.coverKey || 'default',
  budget_total: Number(trip.budgetTotal) || 0,
  currency: trip.currency || 'EUR',
  plan: {
    source: trip.source || 'manual',
    note: trip.note || '',
    summary: trip.summary || '',
    researchSummary: trip.researchSummary || '',
    researchSources: trip.researchSources || [],
    plannerMeta: trip.plannerMeta || null,
    savedPlaces: trip.savedPlaces || [],
    days: trip.days || [],
    expenses: trip.expenses || [],
    journals: trip.journals || []
  }
});

const fromRow = (row) => ({
  id: row.id,
  title: row.title,
  destination: row.destination,
  country: row.country || '',
  startDate: row.start_date,
  endDate: row.end_date,
  durationDays: Math.max(1, Math.round((new Date(`${row.end_date}T12:00:00`) - new Date(`${row.start_date}T12:00:00`)) / 86400000) + 1),
  status: row.status,
  style: row.style,
  pace: row.pace,
  coverKey: row.cover_key,
  budgetTotal: Number(row.budget_total) || 0,
  currency: row.currency || 'EUR',
  source: row.plan?.source || 'manual',
  note: row.plan?.note || '',
  summary: row.plan?.summary || '',
  researchSummary: row.plan?.researchSummary || '',
  researchSources: row.plan?.researchSources || [],
  plannerMeta: row.plan?.plannerMeta || null,
  savedPlaces: row.plan?.savedPlaces || [],
  days: row.plan?.days || [],
  expenses: row.plan?.expenses || [],
  journals: row.plan?.journals || [],
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

// Queued offline changes stay visible over cloud data until they reach the cloud.
const withPendingChanges = (trips, queue, cached) => queue.reduce((list, mutation) => {
  if (mutation.type === 'delete') return list.filter((trip) => trip.id !== mutation.tripId);
  const previous = list.find((trip) => trip.id === mutation.tripId) || cached.find((trip) => trip.id === mutation.tripId);
  return replaceTrip(list, fromRow({ created_at: previous?.createdAt, updated_at: mutation.queuedAt, ...mutation.row }));
}, trips);

let cloudWork = Promise.resolve();

// Cloud reads and writes run one at a time, so an older request can never land after a newer one.
function inCloudOrder(task) {
  const run = cloudWork.then(task);
  cloudWork = run.catch(() => {});
  return run;
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function loadTrips(session) {
  if (!session) return readGuestTrips();
  const userId = session.user.id;
  const cached = readCloudCache(userId);
  if (isOffline()) {
    if (cached.length) return cached;
    throw new Error('Bu hesaptaki seyahatler henüz bu cihaza indirilmedi. İnternete bağlanıp bir kez açman gerekiyor.');
  }
  try {
    return await inCloudOrder(async () => {
      const { data, error } = await supabase.from('trips').select('*').order('start_date', { ascending: true });
      if (error) throw error;
      // A rejected change stays visible locally (before newer queued ones); a rejected delete is not applied, since the server still has the trip.
      const failedUpserts = readFailedSync(userId).filter((entry) => entry.type === 'upsert');
      const trips = withPendingChanges(data.map(fromRow), [...failedUpserts, ...readSyncQueue(userId)], cached);
      writeCloudCache(userId, trips);
      return trips;
    });
  } catch (error) {
    if (cached.length && isNetworkError(error)) return cached;
    throw error;
  }
}

// Conflicts between devices: last write to reach the server wins, per trip (whole-row upsert, no field merge).
// Other trips are unaffected. Rejected writes move to the failed list, stay visible locally, and clear when the
// trip is saved or deleted successfully.
export async function saveTrip(trip, session, currentTrips) {
  const nextTrip = { ...trip, updatedAt: new Date().toISOString() };
  if (trip.source === 'demo') nextTrip.demoEdited = true;
  if (!session) {
    const next = replaceTrip(currentTrips, nextTrip);
    writeGuestTrips(next);
    return { trip: nextTrip, trips: next };
  }
  const userId = session.user.id;
  const row = toRow(nextTrip, userId);
  const localTrips = replaceTrip(currentTrips, nextTrip);
  if (isOffline()) {
    writeCloudCache(userId, localTrips);
    enqueueSync(userId, { type: 'upsert', tripId: row.id, row });
    return { trip: nextTrip, trips: localTrips, pendingSync: true };
  }
  // Changes queued before this save are older than it; anything queued while it waits is kept.
  const superseded = readSyncQueue(userId).filter((entry) => entry.tripId === row.id);
  return inCloudOrder(async () => {
    try {
      const { data, error } = await supabase.from('trips').upsert(row).select().single();
      if (error) throw error;
      removeSyncEntries(userId, superseded);
      clearFailedSyncForTrip(userId, row.id);
      const saved = fromRow(data);
      const next = replaceTrip(currentTrips, saved);
      writeCloudCache(userId, next);
      return { trip: saved, trips: next, pendingSync: false };
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      writeCloudCache(userId, localTrips);
      enqueueSync(userId, { type: 'upsert', tripId: row.id, row });
      return { trip: nextTrip, trips: localTrips, pendingSync: true };
    }
  });
}

export async function deleteTrip(tripId, session, currentTrips) {
  const next = currentTrips.filter((trip) => trip.id !== tripId);
  if (!session) {
    writeGuestTrips(next);
    return next;
  }
  const userId = session.user.id;
  if (isOffline()) {
    writeCloudCache(userId, next);
    enqueueSync(userId, { type: 'delete', tripId });
    return next;
  }
  const superseded = readSyncQueue(userId).filter((entry) => entry.tripId === tripId);
  return inCloudOrder(async () => {
    try {
      const { error } = await supabase.from('trips').delete().eq('id', tripId);
      if (error) throw error;
      removeSyncEntries(userId, superseded);
      clearFailedSyncForTrip(userId, tripId);
      writeCloudCache(userId, next);
      return next;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      writeCloudCache(userId, next);
      enqueueSync(userId, { type: 'delete', tripId });
      return next;
    }
  });
}

export function pendingTripSyncCount(session) {
  return session ? readSyncQueue(session.user.id).length : 0;
}

export function failedTripSyncCount(session) {
  return session ? readFailedSync(session.user.id).length : 0;
}

export async function flushPendingTripChanges(session) {
  if (!session || isOffline()) return 0;
  const userId = session.user.id;
  // Only changes queued before this flush was requested; later ones go after any save already waiting in line.
  const batch = new Set(readSyncQueue(userId).map(syncEntryKey));
  const nextMutation = () => readSyncQueue(userId).find((entry) => batch.has(syncEntryKey(entry)));
  return inCloudOrder(async () => {
    let completed = 0;
    for (let mutation = nextMutation(); mutation && !isOffline(); mutation = nextMutation()) {
      const request = mutation.type === 'delete'
        ? supabase.from('trips').delete().eq('id', mutation.tripId)
        : supabase.from('trips').upsert(mutation.row);
      const { error, status } = await request;
      if (!error) {
        removeSyncEntries(userId, [mutation]);
        clearFailedSyncForTrip(userId, mutation.tripId);
        completed += 1;
        continue;
      }
      // A change the server will never accept must not block the ones behind it; network and transient errors stay queued.
      const rejected = classifySyncError(error, status) === 'reject' || (!isNetworkError(error) && recordSyncAttempt(userId, mutation) >= MAX_SYNC_ATTEMPTS);
      if (!rejected) throw error;
      moveSyncEntriesToFailed(userId, [mutation], { error, status });
    }
    return completed;
  });
}

export function isEditedDemoTrip(trip) {
  if (trip?.source !== 'demo') return false;
  if (trip.demoEdited === true) return true;
  // Examples edited before the marker existed: createManualTrip stamps both times within microseconds.
  return Date.parse(trip.updatedAt) - Date.parse(trip.createdAt) > 2000;
}

export async function migrateGuestTrips(session) {
  if (!session) return [];
  return inCloudOrder(async () => {
    const guestTrips = readGuestTrips();
    const uploads = new Set(guestTrips.filter((trip) => trip.source !== 'demo' || isEditedDemoTrip(trip)));
    if (!uploads.size) return [];
    // Fix ids and store them before uploading, so a retry reuses the same ids instead of duplicating trips.
    const prepared = guestTrips.map((trip) => {
      if (!uploads.has(trip)) return trip;
      const { demoEdited, ...rest } = trip;
      return { ...rest, id: UUID_PATTERN.test(trip.id) ? trip.id : crypto.randomUUID(), ...(trip.source === 'demo' && { source: 'manual' }) };
    });
    writeGuestTrips(prepared);
    const rows = prepared.filter((_trip, index) => uploads.has(guestTrips[index])).map((trip) => toRow(trip, session.user.id));
    const { data, error } = await supabase.from('trips').upsert(rows).select();
    if (error) throw error;
    localStorage.removeItem(GUEST_STORAGE_KEY);
    return data.map(fromRow);
  });
}

export async function joinLocalsWaitlist({ email, city, note }, session) {
  const { error } = await supabase.from('locals_waitlist').insert({
    user_id: session?.user?.id || null,
    email,
    city,
    note
  });
  if (error) throw error;
}
