import { createManualTrip, destinationKey } from './data.js';
import { supabase } from './repository.js';

const validTrip = (trip) => trip && Array.isArray(trip.days) && trip.days.length > 0 && trip.days.every((day) => Array.isArray(day.stops));

export async function generateTrip(input) {
  const { data, error } = await supabase.functions.invoke('plan-trip', { body: input });
  if (error) throw new Error(error.message || 'Plan oluşturulamadı.');
  if (!data?.trip || !validTrip(data.trip)) throw new Error(data?.error || 'Plan yanıtı doğrulanamadı.');
  const manual = createManualTrip(input);
  return {
    ...manual,
    ...data.trip,
    id: crypto.randomUUID(),
    destination: input.destination,
    title: data.trip.title || input.destination,
    startDate: input.startDate,
    endDate: manual.endDate,
    durationDays: manual.durationDays,
    style: input.style,
    pace: input.pace,
    note: input.note,
    coverKey: destinationKey(input.destination),
    source: 'gemini',
    status: 'planning',
    expenses: [],
    journals: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
