import { createManualTrip, destinationKey } from './data.js';
import { supabase } from './repository.js';

const validTrip = (trip) => trip && Array.isArray(trip.days) && trip.days.length > 0 && trip.days.every((day) => Array.isArray(day.stops));

export async function generateTrip(input) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('AI planlama internet bağlantısı gerektiriyor. Bağlandığında yeniden deneyebilirsin.');
  }
  const { data, error } = await supabase.functions.invoke('plan-trip', { body: input });
  if (error) {
    let message = error.message || 'Plan oluşturulamadı.';
    const status = error.context?.status;
    try {
      const response = error.context;
      if (response?.clone) {
        const body = await response.clone().json();
        if (body?.error) message = String(body.error);
      }
    } catch {
      // Keep the transport error when the response body is unavailable.
    }
    if (!status && /fetch|network|connection|load failed/i.test(message)) {
      message = 'AI servisine ulaşılamadı. İnternet bağlantını kontrol edip yeniden dene.';
    } else if (status === 401) {
      message = 'Oturumun doğrulanamadı. Yeniden giriş yapıp tekrar dene.';
    } else if (status === 429) {
      message = 'Ücretsiz AI planı sınırına ulaştın. Bir süre sonra yeniden deneyebilirsin.';
    } else if (status >= 500 && /not configured|configuration/i.test(message)) {
      message = 'AI planlama şu anda kullanıma hazır değil. Biraz sonra yeniden dene.';
    }
    throw new Error(message);
  }
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
