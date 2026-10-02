// Native reminders are keyed by a stable 31-bit positive id derived from the stop id (FNV-1a over UTF-16 code units).
export const reminderIdFor = (value) => {
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    for (let index = 0; index < char.length; index += 1) hash = Math.imul(hash ^ char.charCodeAt(index), 0x01000193);
  }
  return (hash & 0x7fffffff) || 1;
};

// The id scheme before FNV-1a. It dropped the low bit, so distinct stops could share an id. Reminders scheduled by older
// app versions still carry it, so every cancellation also covers it; scheduling never uses it.
export const legacyReminderIdFor = (value) => [...String(value)].reduce((hash, char) => Math.imul(31, hash) + char.charCodeAt(0) | 0, 7) >>> 1 || 1;

// Every native id a stop's reminder may be registered under (current first), each once.
export const reminderIdsFor = (stopId) => [...new Set([reminderIdFor(stopId), legacyReminderIdFor(stopId)])];

const hasReminder = (stop) => Boolean(stop?.id && stop.reminderAt);
const tripStops = (trip) => (trip?.days || []).flatMap((day) => day?.stops || []);

export const reminderIdsForStops = (stops = []) => [...new Set(stops.filter(hasReminder).flatMap((stop) => reminderIdsFor(stop.id)))];
export const reminderIdsForTrip = (trip) => reminderIdsForStops(tripStops(trip));
// Every reminder of every trip, each id once (account deletion cancels all of them).
export const reminderIdsForTrips = (trips = []) => [...new Set(trips.flatMap(reminderIdsForTrip))];

// Reminder ids that were scheduled by `previousTrips` but are no longer wanted by `nextTrips`:
// the stop (or its whole trip) is gone, or its reminder was cleared elsewhere, for example on another device.
export function orphanedReminderIds(previousTrips = [], nextTrips = []) {
  const wanted = new Set(nextTrips.flatMap(reminderIdsForTrip));
  return [...new Set(previousTrips.flatMap(reminderIdsForTrip))].filter((id) => !wanted.has(id));
}

// Reminder ids to cancel when the signed-in user changes (sign-out, or a different account signs in).
// `previousTrips` are the trips the previous account was showing; `shownTrips` are the trips visible now
// (the guest trips left on this device after a sign-out, none yet when another account signs in).
// Nothing is cancelled when the previous user was a guest (their trips either move into the new account with the same
// stop ids or stay on the device) or when the user did not actually change.
export function reminderIdsOnUserChange({ previousUserId, userId, previousTrips = [], shownTrips = [] } = {}) {
  if (!previousUserId || previousUserId === userId) return [];
  return orphanedReminderIds(previousTrips, shownTrips);
}
