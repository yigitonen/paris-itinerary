// Native reminders are keyed by a stable 31-bit id derived from the stop id.
export const reminderIdFor = (value) => [...String(value)].reduce((hash, char) => Math.imul(31, hash) + char.charCodeAt(0) | 0, 7) >>> 1 || 1;

const hasReminder = (stop) => Boolean(stop?.id && stop.reminderAt);
const tripStops = (trip) => (trip?.days || []).flatMap((day) => day?.stops || []);

export const reminderIdsForStops = (stops = []) => stops.filter(hasReminder).map((stop) => reminderIdFor(stop.id));
export const reminderIdsForTrip = (trip) => reminderIdsForStops(tripStops(trip));

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
