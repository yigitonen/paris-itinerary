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
